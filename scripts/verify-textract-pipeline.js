#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require(path.join(repoRoot, "node_modules", "ts-node")).register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

const {
  getTextractFeatureTypes,
  maybeIndexCompletedTextractArtifact,
  parseTextractCompletionMessage,
} = require(path.join(repoRoot, "src/lib/textract-pipeline.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function verifyMessageParsing(failures) {
  const raw = JSON.stringify({
    JobId: "job_123",
    Status: "SUCCEEDED",
    API: "StartDocumentAnalysis",
    JobTag: "artifact_123",
    Timestamp: 123456,
  });
  const parsedRaw = parseTextractCompletionMessage(raw);

  assertCondition(parsedRaw.jobId === "job_123", "raw SQS body JobId was not parsed", failures);
  assertCondition(parsedRaw.status === "SUCCEEDED", "raw SQS body status was not parsed", failures);
  assertCondition(parsedRaw.jobTag === "artifact_123", "raw SQS body JobTag was not parsed", failures);

  const envelope = JSON.stringify({
    Type: "Notification",
    Message: raw,
  });
  const parsedEnvelope = parseTextractCompletionMessage(envelope);
  assertCondition(
    parsedEnvelope.jobId === "job_123",
    "SNS envelope Message JobId was not parsed",
    failures
  );

  assertCondition(
    parseTextractCompletionMessage(JSON.stringify({ Status: "SUCCEEDED" })) === null,
    "invalid completion message should return null",
    failures
  );
}

function verifyFeatureConfig(failures) {
  const original = process.env.TEXTRACT_FEATURE_SET;
  delete process.env.TEXTRACT_FEATURE_SET;

  assertCondition(
    getTextractFeatureTypes().join(",") === "FORMS,TABLES,LAYOUT",
    "default Textract feature set changed",
    failures
  );

  process.env.TEXTRACT_FEATURE_SET = "forms,tables";
  assertCondition(
    getTextractFeatureTypes().join(",") === "FORMS,TABLES",
    "Textract feature set normalization failed",
    failures
  );

  process.env.TEXTRACT_FEATURE_SET = "FORMS,BAD_FEATURE";
  let threw = false;
  try {
    getTextractFeatureTypes();
  } catch {
    threw = true;
  }
  assertCondition(threw, "unsupported Textract feature should throw", failures);

  if (original === undefined) {
    delete process.env.TEXTRACT_FEATURE_SET;
  } else {
    process.env.TEXTRACT_FEATURE_SET = original;
  }
}

function verifyLifecycleSafety(failures) {
  const s3 = read("src/lib/s3.ts");
  assertCondition(
    !s3.includes('ServerSideEncryption: "AES256"'),
    "S3 uploads still force SSE-S3 instead of CMK/default encryption",
    failures
  );
  assertCondition(
    s3.includes('ServerSideEncryption: "aws:kms"'),
    "S3 uploads do not support explicit KMS encryption",
    failures
  );
  assertCondition(
    s3.includes("result.Errors && result.Errors.length > 0") &&
      s3.includes("throw new Error("),
    "S3 prefix deletion does not fail closed on partial DeleteObjects errors",
    failures
  );

  const sweeper = read("src/lib/startup-sweeper.ts");
  assertCondition(
    !sweeper.includes('status: { in: ["UPLOADING", "PROCESSING"] }'),
    "startup sweeper can still fail PROCESSING documents",
    failures
  );
  assertCondition(
    !sweeper.includes("deleteFromS3"),
    "startup sweeper still deletes document storage",
    failures
  );

  const deleteRoute = read("src/app/api/documents/[id]/route.ts");
  assertCondition(
    deleteRoute.includes("baseArtifacts") && deleteRoute.includes("deleteDocumentArtifacts"),
    "document delete does not clean Textract artifacts",
    failures
  );
  assertCondition(
    deleteRoute.includes('document.status === "PROCESSING"') &&
      deleteRoute.includes("hasActiveArtifact"),
    "document delete does not block active processing/artifact races",
    failures
  );
  assertCondition(
    deleteRoute.includes("deleteDocumentArtifacts(artifactKeys, document.firmId, document.id)") &&
      deleteRoute.includes("base-artifacts/") &&
      deleteRoute.includes("key.startsWith(expectedPrefix)"),
    "document delete does not constrain artifact cleanup to the document prefix",
    failures
  );
  assertCondition(
    !deleteRoute.includes("DocumentVectorIndexStatus.DISABLED") &&
      !deleteRoute.includes("documentVectorIndex.updateMany"),
    "document delete mutates vector index DB state before external cleanup",
    failures
  );
  assertCondition(
    deleteRoute.includes("indexName: true") &&
      deleteRoute.includes("namespace: true") &&
      deleteRoute.includes("new PineconeVectorStore") &&
      deleteRoute.includes("indexName: index.indexName") &&
      deleteRoute.includes("namespace: index.namespace"),
    "document delete does not use persisted vector index location for cleanup",
    failures
  );

  const worker = read("scripts/textract-worker.js");
  assertCondition(
    worker.includes("processTextractQueueOnce"),
    "Textract worker entrypoint is missing queue processing",
    failures
  );

  const uploadRoute = read("src/app/api/documents/upload/route.ts");
  assertCondition(
    uploadRoute.includes("deleteFromS3(bucket, s3Key)") &&
      uploadRoute.includes("prisma.document.delete"),
    "failed uploads do not clean source S3 object and DB row",
    failures
  );

  const textractPipeline = read("src/lib/textract-pipeline.ts");
  assertCondition(
    textractPipeline.includes("MESSAGE_VISIBILITY_TIMEOUT_SECONDS = 900") &&
      textractPipeline.includes("withSqsVisibilityHeartbeat"),
    "Textract worker does not extend SQS visibility during processing",
    failures
  );
  assertCondition(
    textractPipeline.includes("NORMALIZING_RETRY_AFTER_MS") &&
      textractPipeline.includes("DocumentBaseArtifactStatus.NORMALIZING"),
    "Textract NORMALIZING retries are not explicitly recoverable",
    failures
  );
  assertCondition(
    textractPipeline.includes("maybeIndexCompletedTextractArtifact") &&
      textractPipeline.includes("indexDocumentVectors") &&
      textractPipeline.includes("vectorIndexingEnabled"),
    "Textract completion is not wired to the flag-gated vector indexing hook",
    failures
  );

  const compose = read("docker-compose.prod.yml");
  assertCondition(
    compose.includes("AWS_S3_KMS_KEY_ID: ${AWS_S3_KMS_KEY_ID}") &&
      compose.includes("textract-worker:") &&
      compose.includes("WORKER_IMAGE"),
    "compose does not inject KMS config or define the Textract worker service",
    failures
  );

  const publishScript = read("scripts/publish-staging-images.sh");
  assertCondition(
    publishScript.includes("WORKER_IMAGE=") &&
      publishScript.includes("--target worker") &&
      publishScript.includes("true-blue-platform-worker"),
    "staging image publish script does not publish a version-locked worker image",
    failures
  );

  const dockerfile = read("Dockerfile");
  assertCondition(
    dockerfile.includes("AS worker") &&
      dockerfile.includes('CMD ["node", "scripts/textract-worker.js", "--watch"]'),
    "Dockerfile does not include a production Textract worker target",
    failures
  );
}

async function verifyVectorIndexHook(failures) {
  const input = {
    artifactId: "artifact_1",
    documentId: "doc_1",
    firmId: "firm_1",
    featureSet: ["FORMS", "TABLES", "LAYOUT"],
  };
  const disabled = await maybeIndexCompletedTextractArtifact(input, {
    config: {
      aiChatEnabled: false,
      vectorIndexingEnabled: false,
      vectorRetrievalEnabled: false,
      aiModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      embeddingDimension: 1536,
      pineconeNamespacePrefix: "trueblue",
      validationErrors: [],
    },
    indexer: async () => {
      failures.push("disabled vector indexing should not call indexer");
    },
  });

  assertCondition(disabled.action === "skipped", "disabled vector hook did not skip", failures);

  const calls = [];
  const indexed = await maybeIndexCompletedTextractArtifact(input, {
    config: {
      aiChatEnabled: false,
      vectorIndexingEnabled: true,
      vectorRetrievalEnabled: false,
      openAiApiKey: "sk-redacted",
      aiModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      embeddingDimension: 1536,
      pineconeApiKey: "pc-redacted",
      pineconeIndexName: "trueblue-m3-staging",
      pineconeNamespacePrefix: "trueblue",
      validationErrors: [],
    },
    indexer: async (indexInput) => {
      calls.push(indexInput);
      return {
        documentId: indexInput.documentId,
        firmId: indexInput.firmId,
        indexName: "trueblue-m3-staging",
        namespace: "trueblue_firm_firm_1",
        generation: 1,
        vectorIndexId: "vector_index_1",
        chunkCount: 2,
        embeddingModel: "text-embedding-3-small",
        embeddingDimension: 1536,
        status: "ACTIVE",
      };
    },
  });

  assertCondition(indexed.action === "indexed", "enabled vector hook did not index", failures);
  assertCondition(calls[0]?.documentId === "doc_1", "vector hook did not pass document id", failures);
  assertCondition(calls[0]?.firmId === "firm_1", "vector hook did not pass firm id", failures);
  assertCondition(
    calls[0]?.featureSet?.join(",") === "FORMS,TABLES,LAYOUT",
    "vector hook did not pass Textract feature set",
    failures
  );

  const originalConsoleError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await maybeIndexCompletedTextractArtifact(input, {
      config: {
        aiChatEnabled: false,
        vectorIndexingEnabled: true,
        vectorRetrievalEnabled: false,
        openAiApiKey: "sk-redacted",
        aiModel: "gpt-4o-mini",
        embeddingModel: "text-embedding-3-small",
        embeddingDimension: 1536,
        pineconeApiKey: "pc-redacted",
        pineconeIndexName: "trueblue-m3-staging",
        pineconeNamespacePrefix: "trueblue",
        validationErrors: [],
      },
      indexer: async () => {
        throw new Error("simulated indexing failure");
      },
    });
  } finally {
    console.error = originalConsoleError;
  }

  assertCondition(
    failed.action === "failed" && failed.errorMessage.includes("simulated indexing failure"),
    "vector hook failure did not fail closed without throwing",
    failures
  );
}

async function main() {
  const failures = [];
  verifyMessageParsing(failures);
  verifyFeatureConfig(failures);
  verifyLifecycleSafety(failures);
  await verifyVectorIndexHook(failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Textract pipeline safety invariants verified.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
