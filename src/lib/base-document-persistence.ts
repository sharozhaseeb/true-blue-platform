import {
  DocumentArtifactSourceMode,
  DocumentBaseArtifactStatus,
  DocumentRetrievalContentType,
  Prisma,
} from "@prisma/client";
import { chunkBaseDocument } from "@/lib/base-document-chunker";
import type { BaseDocumentArtifact } from "@/lib/base-document-source";
import { validateBaseDocumentReadiness } from "@/lib/base-document-source";
import { validateChunksForIndexing } from "@/lib/base-document-retrieval";
import { prisma } from "@/lib/prisma";

export interface PersistBaseDocumentArtifactInput {
  artifact: BaseDocumentArtifact;
  provider: "aws-textract";
  rawArtifactS3Key?: string | null;
  normalizedArtifactS3Key?: string | null;
}

export interface PersistBaseDocumentArtifactResult {
  artifactId: string;
  documentId: string;
  firmId: string;
  generation: number;
  chunkCount: number;
  status: DocumentBaseArtifactStatus;
}

type BaseDocumentPersistenceTransaction = {
  document: {
    findFirst(args: {
      where: { id: string; firmId: string };
      select: { id: true; firmId: true };
    }): Promise<{ id: string; firmId: string } | null>;
  };
  documentBaseArtifact: {
    updateMany(args: {
      where: {
        documentId: string;
        firmId: string;
        parserVersion: string;
        featureSet: string;
        isCurrent: true;
      };
      data: { isCurrent: false };
    }): Promise<unknown>;
    create(args: { data: Prisma.DocumentBaseArtifactCreateInput }): Promise<{
      id: string;
      documentId: string;
      firmId: string;
      generation: number;
      status: DocumentBaseArtifactStatus;
    }>;
  };
  documentRetrievalChunk: {
    createMany(args: {
      data: Prisma.DocumentRetrievalChunkCreateManyInput[];
    }): Promise<{ count: number }>;
  };
};

type BaseDocumentPersistenceDb = {
  $transaction<T>(
    callback: (tx: BaseDocumentPersistenceTransaction) => Promise<T>
  ): Promise<T>;
};

function toArtifactSourceMode(
  sourceMode: BaseDocumentArtifact["sourceMode"]
): DocumentArtifactSourceMode {
  switch (sourceMode) {
    case "base-document-json":
      return DocumentArtifactSourceMode.BASE_DOCUMENT_JSON;
    case "textract-response-fixture":
      return DocumentArtifactSourceMode.TEXTRACT_RESPONSE_FIXTURE;
    case "live-textract":
      return DocumentArtifactSourceMode.LIVE_TEXTRACT;
  }
}

function toContentType(
  contentType: string
): DocumentRetrievalContentType {
  switch (contentType) {
    case "prose":
      return DocumentRetrievalContentType.PROSE;
    case "field_group":
      return DocumentRetrievalContentType.FIELD_GROUP;
    case "table":
      return DocumentRetrievalContentType.TABLE;
    case "mixed":
      return DocumentRetrievalContentType.MIXED;
    default:
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}

function featureSetKey(featureSet: string[]): string {
  return [...featureSet].sort().join(",");
}

export function buildRetrievalChunkCreateManyInput(
  artifact: BaseDocumentArtifact
): Prisma.DocumentRetrievalChunkCreateManyInput[] {
  const firmId = artifact.firmId;
  if (!firmId) {
    throw new Error("BaseDocumentArtifact cannot be persisted without firmId");
  }

  const chunks = chunkBaseDocument(artifact.baseDocument, {
    documentId: artifact.documentId,
    firmId,
    baseArtifactId: artifact.id,
    vectorGeneration: artifact.generation,
  });
  const chunkErrors = validateChunksForIndexing(chunks);
  if (chunkErrors.length > 0) {
    throw new Error(`Invalid retrieval chunks: ${chunkErrors.join("; ")}`);
  }

  return chunks.map((chunk) => ({
    id: chunk.chunkId,
    documentId: chunk.documentId,
    firmId: chunk.firmId,
    baseArtifactId: chunk.baseArtifactId,
    vectorGeneration: chunk.vectorGeneration,
    content: chunk.content,
    contentType: toContentType(chunk.contentType),
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    formType: chunk.formType,
    sectionPath: chunk.sectionPath,
    tableId: chunk.tableId,
    sourceBlockIds: chunk.sourceBlockIds,
    parserVersion: chunk.parserVersion,
    chunkStrategy: chunk.chunkStrategy,
  }));
}

export async function persistBaseDocumentArtifact(
  input: PersistBaseDocumentArtifactInput,
  db: BaseDocumentPersistenceDb = prisma
): Promise<PersistBaseDocumentArtifactResult> {
  const { artifact } = input;
  const firmId = artifact.firmId;

  if (!firmId) {
    throw new Error("BaseDocumentArtifact cannot be persisted without firmId");
  }

  const readinessErrors = validateBaseDocumentReadiness(artifact.baseDocument);
  if (readinessErrors.length > 0 || artifact.status !== "READY_FOR_INDEXING") {
    throw new Error(
      `BaseDocumentArtifact is not ready for persistence: ${readinessErrors.join("; ")}`
    );
  }

  const retrievalChunks = buildRetrievalChunkCreateManyInput(artifact);
  const featureSet = featureSetKey(artifact.featureSet);

  return db.$transaction(async (tx) => {
    const document = await tx.document.findFirst({
      where: {
        id: artifact.documentId,
        firmId,
      },
      select: {
        id: true,
        firmId: true,
      },
    });

    if (!document) {
      throw new Error("Document not found for firm");
    }

    await tx.documentBaseArtifact.updateMany({
      where: {
        documentId: artifact.documentId,
        firmId,
        parserVersion: artifact.parserVersion,
        featureSet,
        isCurrent: true,
      },
      data: {
        isCurrent: false,
      },
    });

    const createdArtifact = await tx.documentBaseArtifact.create({
      data: {
        id: artifact.id,
        document: { connect: { id: artifact.documentId } },
        firm: { connect: { id: firmId } },
        provider: input.provider,
        sourceMode: toArtifactSourceMode(artifact.sourceMode),
        providerJobId: artifact.baseDocument.providerJobId,
        featureSet,
        parserVersion: artifact.parserVersion,
        generation: artifact.generation,
        isCurrent: true,
        status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
        rawArtifactS3Key: input.rawArtifactS3Key ?? null,
        normalizedArtifactS3Key: input.normalizedArtifactS3Key ?? null,
        summary: artifact.baseDocument.summary as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    const chunkResult = await tx.documentRetrievalChunk.createMany({
      data: retrievalChunks,
    });

    return {
      artifactId: createdArtifact.id,
      documentId: createdArtifact.documentId,
      firmId: createdArtifact.firmId,
      generation: createdArtifact.generation,
      chunkCount: chunkResult.count,
      status: createdArtifact.status,
    };
  });
}
