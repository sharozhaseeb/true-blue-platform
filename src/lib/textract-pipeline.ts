import {
  GetDocumentAnalysisCommand,
  StartDocumentAnalysisCommand,
  TextractClient,
  type FeatureType,
} from "@aws-sdk/client-textract";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  DocumentArtifactSourceMode,
  DocumentBaseArtifactStatus,
  Prisma,
} from "@prisma/client";
import { liveTextractBaseDocumentSource } from "@/lib/base-document-source";
import {
  buildRetrievalChunkCreateManyInput,
} from "@/lib/base-document-persistence";
import { prisma } from "@/lib/prisma";
import {
  getTextractResultsBucket,
  uploadJsonToS3,
} from "@/lib/s3";
import { TEXTRACT_BASE_DOCUMENT_PARSER_VERSION } from "@/lib/textract-normalizer";
import {
  readM3ProviderConfig,
  type M3ProviderConfig,
} from "@/lib/ai/config";
import {
  indexDocumentVectors,
  type IndexDocumentVectorsResult,
} from "@/lib/vector/vector-indexing";

const DEFAULT_FEATURE_TYPES: FeatureType[] = ["FORMS", "TABLES", "LAYOUT"];
const TEXTRACT_PROVIDER = "aws-textract";
const MESSAGE_VISIBILITY_TIMEOUT_SECONDS = 900;
const MESSAGE_VISIBILITY_HEARTBEAT_MS = 180_000;
const NORMALIZING_RETRY_AFTER_MS = 10 * 60 * 1000;

let textractClient: TextractClient | null = null;
let sqsClient: SQSClient | null = null;

export interface QueueTextractDocumentInput {
  documentId: string;
  firmId: string;
  s3Bucket: string;
  s3Key: string;
  filename: string;
}

export interface QueueTextractDocumentResult {
  artifactId: string;
  providerJobId: string;
}

export interface TextractCompletionNotification {
  jobId: string;
  status: string;
  api: string | null;
  jobTag: string | null;
  timestamp: number | null;
}

export interface ProcessTextractNotificationResult {
  action: "completed" | "failed" | "ignored" | "duplicate";
  artifactId?: string;
  documentId?: string;
  providerJobId?: string;
}

export interface MaybeIndexCompletedTextractArtifactInput {
  artifactId: string;
  documentId: string;
  firmId: string;
  featureSet: string[];
}

export type MaybeIndexCompletedTextractArtifactResult =
  | { action: "skipped" }
  | { action: "indexed"; result: IndexDocumentVectorsResult }
  | { action: "failed"; errorMessage: string };

function getAwsRegion(): string {
  const region = process.env.AWS_TEXTRACT_REGION || process.env.AWS_REGION;
  if (!region) {
    throw new Error("Missing required environment variable: AWS_TEXTRACT_REGION or AWS_REGION");
  }
  return region;
}

function getTextractClient(): TextractClient {
  if (!textractClient) {
    textractClient = new TextractClient({ region: getAwsRegion() });
  }
  return textractClient;
}

function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({ region: getAwsRegion() });
  }
  return sqsClient;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function isTextractPipelineEnabled(): boolean {
  return process.env.ENABLE_TEXTRACT_PIPELINE === "true";
}

export function getTextractFeatureTypes(): FeatureType[] {
  const raw = process.env.TEXTRACT_FEATURE_SET;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_FEATURE_TYPES;
  }

  const values = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  const allowed = new Set(["FORMS", "TABLES", "LAYOUT", "SIGNATURES"]);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`Unsupported Textract feature type: ${value}`);
    }
  }

  return values as FeatureType[];
}

function featureSetKey(featureSet: string[]): string {
  return [...featureSet].sort().join(",");
}

function buildArtifactPrefix(firmId: string, documentId: string, artifactId: string): string {
  return `${firmId}/documents/${documentId}/base-artifacts/${artifactId}`;
}

function buildRawArtifactPrefix(firmId: string, documentId: string, artifactId: string): string {
  return `${buildArtifactPrefix(firmId, documentId, artifactId)}/raw/`;
}

function buildNormalizedArtifactKey(firmId: string, documentId: string, artifactId: string): string {
  return `${buildArtifactPrefix(firmId, documentId, artifactId)}/normalized/base-document.json`;
}

function toPositivePageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

export async function queueTextractDocument(
  input: QueueTextractDocumentInput
): Promise<QueueTextractDocumentResult> {
  const featureTypes = getTextractFeatureTypes();
  const featureSet = featureSetKey(featureTypes);
  const generation = await nextArtifactGeneration(input.documentId, featureSet);

  const artifact = await prisma.documentBaseArtifact.create({
    data: {
      documentId: input.documentId,
      firmId: input.firmId,
      provider: TEXTRACT_PROVIDER,
      sourceMode: DocumentArtifactSourceMode.LIVE_TEXTRACT,
      featureSet,
      parserVersion: TEXTRACT_BASE_DOCUMENT_PARSER_VERSION,
      generation,
      isCurrent: false,
      status: DocumentBaseArtifactStatus.STARTING_PROVIDER_JOB,
      startedAt: new Date(),
    },
    select: {
      id: true,
    },
  });

  const rawArtifactS3Key = buildRawArtifactPrefix(
    input.firmId,
    input.documentId,
    artifact.id
  );
  const normalizedArtifactS3Key = buildNormalizedArtifactKey(
    input.firmId,
    input.documentId,
    artifact.id
  );

  try {
    const startResult = await getTextractClient().send(
      new StartDocumentAnalysisCommand({
        DocumentLocation: {
          S3Object: {
            Bucket: input.s3Bucket,
            Name: input.s3Key,
          },
        },
        FeatureTypes: featureTypes,
        ClientRequestToken: `tb-${artifact.id}`,
        JobTag: artifact.id,
        NotificationChannel: {
          SNSTopicArn: getRequiredEnv("TEXTRACT_SNS_TOPIC_ARN"),
          RoleArn: getRequiredEnv("TEXTRACT_NOTIFICATION_ROLE_ARN"),
        },
      })
    );

    if (!startResult.JobId) {
      throw new Error("Textract did not return a JobId");
    }

    await prisma.$transaction([
      prisma.documentBaseArtifact.update({
        where: { id: artifact.id },
        data: {
          providerJobId: startResult.JobId,
          rawArtifactS3Key,
          normalizedArtifactS3Key,
          status: DocumentBaseArtifactStatus.AWAITING_PROVIDER_RESULT,
        },
      }),
      prisma.document.update({
        where: { id: input.documentId },
        data: {
          status: "PROCESSING",
          errorMessage: null,
        },
      }),
    ]);

    return {
      artifactId: artifact.id,
      providerJobId: startResult.JobId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.$transaction([
      prisma.documentBaseArtifact.update({
        where: { id: artifact.id },
        data: {
          status: DocumentBaseArtifactStatus.FAILED,
          lastErrorCode: "TEXTRACT_START_FAILED",
          lastErrorMessage: message,
        },
      }),
      prisma.document.update({
        where: { id: input.documentId },
        data: {
          status: "FAILED",
          errorMessage: "Textract document analysis could not be started",
        },
      }),
    ]);
    throw error;
  }
}

async function nextArtifactGeneration(
  documentId: string,
  featureSet: string
): Promise<number> {
  const existing = await prisma.documentBaseArtifact.aggregate({
    where: {
      documentId,
      parserVersion: TEXTRACT_BASE_DOCUMENT_PARSER_VERSION,
      featureSet,
    },
    _max: {
      generation: true,
    },
  });

  return (existing._max.generation ?? 0) + 1;
}

export function parseTextractCompletionMessage(
  body: string | undefined
): TextractCompletionNotification | null {
  if (!body) {
    return null;
  }

  const parsed = parseJsonRecord(body);
  if (!parsed) {
    return null;
  }

  const message =
    typeof parsed.Message === "string"
      ? parseJsonRecord(parsed.Message)
      : parsed;

  if (!message) {
    return null;
  }

  const jobId = typeof message.JobId === "string" ? message.JobId : null;
  const status = typeof message.Status === "string" ? message.Status : null;
  if (!jobId || !status) {
    return null;
  }

  return {
    jobId,
    status,
    api: typeof message.API === "string" ? message.API : null,
    jobTag: typeof message.JobTag === "string" ? message.JobTag : null,
    timestamp:
      typeof message.Timestamp === "number" && Number.isFinite(message.Timestamp)
        ? message.Timestamp
        : null,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function processTextractCompletionNotification(
  notification: TextractCompletionNotification
): Promise<ProcessTextractNotificationResult> {
  if (notification.api && notification.api !== "StartDocumentAnalysis") {
    return { action: "ignored", providerJobId: notification.jobId };
  }

  const artifact = await prisma.documentBaseArtifact.findFirst({
    where: {
      id: notification.jobTag ?? undefined,
      providerJobId: notification.jobId,
      sourceMode: DocumentArtifactSourceMode.LIVE_TEXTRACT,
    },
    select: {
      id: true,
      documentId: true,
      firmId: true,
      providerJobId: true,
      featureSet: true,
      status: true,
      generation: true,
      rawArtifactS3Key: true,
      normalizedArtifactS3Key: true,
      document: {
        select: {
          filename: true,
          originalName: true,
        },
      },
    },
  });

  if (!artifact) {
    return { action: "ignored", providerJobId: notification.jobId };
  }

  if (isTerminalArtifactStatus(artifact.status)) {
    return {
      action: "duplicate",
      artifactId: artifact.id,
      documentId: artifact.documentId,
      providerJobId: notification.jobId,
    };
  }

  if (notification.status !== "SUCCEEDED") {
    await markTextractArtifactFailed(
      artifact.id,
      artifact.documentId,
      notification.status,
      `Textract job completed with status ${notification.status}`
    );
    return {
      action: "failed",
      artifactId: artifact.id,
      documentId: artifact.documentId,
      providerJobId: notification.jobId,
    };
  }

  const claim = await prisma.documentBaseArtifact.updateMany({
    where: {
      id: artifact.id,
      OR: [
        {
          status: {
            in: [
              DocumentBaseArtifactStatus.STARTING_PROVIDER_JOB,
              DocumentBaseArtifactStatus.AWAITING_PROVIDER_RESULT,
              DocumentBaseArtifactStatus.PROVIDER_RESULT_READY,
            ],
          },
        },
        {
          status: DocumentBaseArtifactStatus.NORMALIZING,
          updatedAt: { lt: new Date(Date.now() - NORMALIZING_RETRY_AFTER_MS) },
        },
      ],
    },
    data: {
      status: DocumentBaseArtifactStatus.NORMALIZING,
    },
  });
  if (claim.count === 0) {
    return {
      action: "duplicate",
      artifactId: artifact.id,
      documentId: artifact.documentId,
      providerJobId: notification.jobId,
    };
  }

  const responses = await getAllDocumentAnalysisPages(notification.jobId);
  const rawPrefix =
    artifact.rawArtifactS3Key ??
    buildRawArtifactPrefix(artifact.firmId, artifact.documentId, artifact.id);
  const normalizedKey =
    artifact.normalizedArtifactS3Key ??
    buildNormalizedArtifactKey(artifact.firmId, artifact.documentId, artifact.id);
  const resultsBucket = getTextractResultsBucket();

  for (let index = 0; index < responses.length; index++) {
    await uploadJsonToS3(
      resultsBucket,
      `${rawPrefix}chunk-${index + 1}.json`,
      responses[index]
    );
  }

  const baseArtifact = await liveTextractBaseDocumentSource.load({
    artifactId: artifact.id,
    documentId: artifact.documentId,
    firmId: artifact.firmId,
    generation: artifact.generation,
    responses,
    providerJobId: notification.jobId,
    sourceFilename: artifact.document.originalName || artifact.document.filename,
    expectedPageCount: toPositivePageCount(responses[0]?.DocumentMetadata?.Pages),
    featureSet: artifact.featureSet.split(",").filter(Boolean),
  });

  await uploadJsonToS3(resultsBucket, normalizedKey, baseArtifact.baseDocument);
  if (baseArtifact.status !== "READY_FOR_INDEXING") {
    await markTextractArtifactFailed(
      artifact.id,
      artifact.documentId,
      "NORMALIZATION_NOT_READY",
      "Textract output could not be normalized into an index-ready base document"
    );
    return {
      action: "failed",
      artifactId: artifact.id,
      documentId: artifact.documentId,
      providerJobId: notification.jobId,
    };
  }

  await completeLiveTextractArtifact({
    artifact: baseArtifact,
    rawArtifactS3Key: rawPrefix,
    normalizedArtifactS3Key: normalizedKey,
  });
  await maybeIndexCompletedTextractArtifact({
    artifactId: artifact.id,
    documentId: artifact.documentId,
    firmId: artifact.firmId,
    featureSet: baseArtifact.featureSet,
  });

  return {
    action: "completed",
    artifactId: artifact.id,
    documentId: artifact.documentId,
    providerJobId: notification.jobId,
  };
}

export async function maybeIndexCompletedTextractArtifact(
  input: MaybeIndexCompletedTextractArtifactInput,
  options: {
    config?: M3ProviderConfig;
    indexer?: typeof indexDocumentVectors;
  } = {}
): Promise<MaybeIndexCompletedTextractArtifactResult> {
  const config = options.config ?? readM3ProviderConfig();
  if (!config.vectorIndexingEnabled) {
    return { action: "skipped" };
  }

  try {
    const result = await (options.indexer ?? indexDocumentVectors)({
      firmId: input.firmId,
      documentId: input.documentId,
      featureSet: input.featureSet,
      config,
    });

    return {
      action: "indexed",
      result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[textract-pipeline] Vector indexing failed after Textract completion", {
      artifactId: input.artifactId,
      documentId: input.documentId,
      firmId: input.firmId,
      error: errorMessage,
    });

    return {
      action: "failed",
      errorMessage,
    };
  }
}

async function getAllDocumentAnalysisPages(jobId: string) {
  const responses = [];
  let nextToken: string | undefined;

  do {
    const response = await getTextractClient().send(
      new GetDocumentAnalysisCommand({
        JobId: jobId,
        NextToken: nextToken,
      })
    );
    responses.push(response);
    nextToken = response.NextToken;
  } while (nextToken);

  return responses;
}

async function markTextractArtifactFailed(
  artifactId: string,
  documentId: string,
  code: string,
  message: string
): Promise<void> {
  await prisma.$transaction([
    prisma.documentBaseArtifact.update({
      where: { id: artifactId },
      data: {
        status: DocumentBaseArtifactStatus.FAILED,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    }),
    prisma.document.update({
      where: { id: documentId },
      data: {
        status: "FAILED",
        errorMessage: message,
      },
    }),
  ]);
}

async function completeLiveTextractArtifact(input: {
  artifact: Awaited<ReturnType<typeof liveTextractBaseDocumentSource.load>>;
  rawArtifactS3Key: string;
  normalizedArtifactS3Key: string;
}): Promise<void> {
  const retrievalChunks = buildRetrievalChunkCreateManyInput(input.artifact);
  const featureSet = featureSetKey(input.artifact.featureSet);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.documentBaseArtifact.findFirst({
      where: {
        id: input.artifact.id,
        documentId: input.artifact.documentId,
        firmId: input.artifact.firmId ?? undefined,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!existing) {
      throw new Error("Live Textract artifact record was not found");
    }

    if (
      existing.status === DocumentBaseArtifactStatus.READY_FOR_INDEXING ||
      existing.status === DocumentBaseArtifactStatus.INDEXED
    ) {
      return;
    }

    await tx.documentBaseArtifact.updateMany({
      where: {
        documentId: input.artifact.documentId,
        firmId: input.artifact.firmId ?? undefined,
        parserVersion: input.artifact.parserVersion,
        featureSet,
        isCurrent: true,
        id: { not: input.artifact.id },
      },
      data: {
        isCurrent: false,
      },
    });

    await tx.documentRetrievalChunk.deleteMany({
      where: {
        baseArtifactId: input.artifact.id,
      },
    });

    await tx.documentBaseArtifact.update({
      where: { id: input.artifact.id },
      data: {
        provider: TEXTRACT_PROVIDER,
        sourceMode: DocumentArtifactSourceMode.LIVE_TEXTRACT,
        providerJobId: input.artifact.baseDocument.providerJobId,
        featureSet,
        parserVersion: input.artifact.parserVersion,
        generation: input.artifact.generation,
        isCurrent: true,
        status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
        rawArtifactS3Key: input.rawArtifactS3Key,
        normalizedArtifactS3Key: input.normalizedArtifactS3Key,
        summary: input.artifact.baseDocument.summary as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    await tx.documentRetrievalChunk.createMany({
      data: retrievalChunks,
    });

    await tx.document.update({
      where: { id: input.artifact.documentId },
      data: {
        status: "COMPLETED",
        pageCount: input.artifact.baseDocument.summary.pageCount,
        errorMessage: null,
      },
    });
  });
}

export async function processTextractQueueMessage(
  message: Pick<Message, "Body">
): Promise<ProcessTextractNotificationResult> {
  const notification = parseTextractCompletionMessage(message.Body);
  if (!notification) {
    return { action: "ignored" };
  }

  return processTextractCompletionNotification(notification);
}

function isTerminalArtifactStatus(status: DocumentBaseArtifactStatus): boolean {
  switch (status) {
    case DocumentBaseArtifactStatus.READY_FOR_INDEXING:
    case DocumentBaseArtifactStatus.INDEXED:
    case DocumentBaseArtifactStatus.FAILED:
    case DocumentBaseArtifactStatus.CANCELLED:
      return true;
    default:
      return false;
  }
}

async function withSqsVisibilityHeartbeat<T>(
  queueUrl: string,
  receiptHandle: string,
  operation: () => Promise<T>
): Promise<T> {
  const client = getSqsClient();
  let stopped = false;

  const heartbeat = setInterval(() => {
    if (stopped) {
      return;
    }

    client
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: MESSAGE_VISIBILITY_TIMEOUT_SECONDS,
        })
      )
      .catch((error) => {
        console.error("[textract-worker] Failed to extend SQS visibility", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, MESSAGE_VISIBILITY_HEARTBEAT_MS);

  try {
    return await operation();
  } finally {
    stopped = true;
    clearInterval(heartbeat);
  }
}

export async function processTextractQueueOnce(): Promise<number> {
  if (!isTextractPipelineEnabled()) {
    return 0;
  }

  const queueUrl = getRequiredEnv("TEXTRACT_SQS_QUEUE_URL");
  const client = getSqsClient();
  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 20,
      VisibilityTimeout: MESSAGE_VISIBILITY_TIMEOUT_SECONDS,
    })
  );

  const messages = received.Messages ?? [];
  for (const message of messages) {
    if (!message.ReceiptHandle) {
      continue;
    }

    try {
      await withSqsVisibilityHeartbeat(queueUrl, message.ReceiptHandle, () =>
        processTextractQueueMessage(message)
      );
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        })
      );
    } catch (error) {
      console.error("[textract-worker] Message processing failed", {
        messageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return messages.length;
}
