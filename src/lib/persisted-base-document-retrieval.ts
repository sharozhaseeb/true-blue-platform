import {
  DocumentBaseArtifactStatus,
  DocumentRetrievalContentType,
} from "@prisma/client";
import {
  createCitation,
  searchLocalRetrievalCorpus,
  type BaseDocumentCitation,
  type LocalRetrievalResult,
} from "@/lib/base-document-retrieval";
import type {
  BaseDocumentChunkContentType,
  BaseDocumentRetrievalChunk,
} from "@/lib/base-document-chunker";
import { DEFAULT_CHUNK_STRATEGY } from "@/lib/base-document-chunker";
import { prisma } from "@/lib/prisma";
import { TEXTRACT_BASE_DOCUMENT_PARSER_VERSION } from "@/lib/textract-normalizer";

export interface RetrievePersistedBaseDocumentChunksInput {
  firmId: string;
  query: string;
  activeGeneration?: number;
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: {
    start: number;
    end: number;
  };
  topK?: number;
  maxCandidateChunks?: number;
  parserVersion?: string;
  featureSet?: string[];
  chunkStrategy?: string;
}

export interface PersistedBaseDocumentRetrievalOutput {
  results: LocalRetrievalResult[];
  citations: BaseDocumentCitation[];
  warnings: string[];
}

type PersistedRetrievalChunkRow = {
  id: string;
  documentId: string;
  firmId: string;
  baseArtifactId: string;
  vectorGeneration: number;
  content: string;
  contentType: DocumentRetrievalContentType;
  pageStart: number;
  pageEnd: number;
  formType: string | null;
  sectionPath: string | null;
  tableId: string | null;
  sourceBlockIds: unknown;
  parserVersion: string;
  chunkStrategy: string;
  baseArtifact: {
    firmId: string;
    generation: number;
    parserVersion: string;
    featureSet: string;
    isCurrent: boolean;
    status: DocumentBaseArtifactStatus;
  };
};

type PersistedBaseDocumentRetrievalDb = {
  documentRetrievalChunk: {
    findMany(args: {
      where: {
        firmId: string;
        documentId?: { in: string[] };
        vectorGeneration?: number;
        formType?: { in: string[] };
        pageStart?: { gte: number };
        pageEnd?: { lte: number };
        baseArtifact: {
          firmId: string;
          isCurrent: true;
          status: DocumentBaseArtifactStatus;
          parserVersion: string;
          featureSet: string;
          generation?: number;
        };
        parserVersion: string;
        chunkStrategy: string;
      };
      select: Omit<Record<keyof PersistedRetrievalChunkRow, true>, "baseArtifact"> & {
        baseArtifact: {
          select: {
            firmId: true;
            generation: true;
            parserVersion: true;
            featureSet: true;
            isCurrent: true;
            status: true;
          };
        };
      };
      take: number;
      orderBy: [{ documentId: "asc" }, { pageStart: "asc" }, { id: "asc" }];
    }): Promise<PersistedRetrievalChunkRow[]>;
  };
};

function toChunkContentType(
  contentType: DocumentRetrievalContentType
): BaseDocumentChunkContentType {
  switch (contentType) {
    case DocumentRetrievalContentType.PROSE:
      return "prose";
    case DocumentRetrievalContentType.FIELD_GROUP:
      return "field_group";
    case DocumentRetrievalContentType.TABLE:
      return "table";
    case DocumentRetrievalContentType.MIXED:
      return "mixed";
  }
}

function parseSourceBlockIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (sourceBlockId): sourceBlockId is string =>
      typeof sourceBlockId === "string" && sourceBlockId.length > 0
  );
}

function validateRawSourceBlockIds(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.every(
      (sourceBlockId) =>
        typeof sourceBlockId === "string" &&
        sourceBlockId.length > 0 &&
        sourceBlockId.length <= 256
    )
  );
}

function featureSetKey(featureSet: string[]): string {
  return [...featureSet].sort().join(",");
}

function toRetrievalChunk(row: PersistedRetrievalChunkRow): BaseDocumentRetrievalChunk {
  return {
    chunkId: row.id,
    documentId: row.documentId,
    firmId: row.firmId,
    baseArtifactId: row.baseArtifactId,
    vectorGeneration: row.vectorGeneration,
    content: row.content,
    contentType: toChunkContentType(row.contentType),
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    formType: row.formType,
    sectionPath: row.sectionPath,
    tableId: row.tableId,
    sourceBlockIds: parseSourceBlockIds(row.sourceBlockIds),
    parserVersion: row.parserVersion,
    chunkStrategy: row.chunkStrategy,
  };
}

export async function retrievePersistedBaseDocumentChunks(
  input: RetrievePersistedBaseDocumentChunksInput,
  db: PersistedBaseDocumentRetrievalDb = prisma
): Promise<PersistedBaseDocumentRetrievalOutput> {
  const topK = Math.min(Math.max(input.topK ?? 8, 1), 30);
  const maxCandidateChunks = Math.min(
    Math.max(input.maxCandidateChunks ?? 5000, 1),
    50000
  );
  const parserVersion =
    input.parserVersion ?? TEXTRACT_BASE_DOCUMENT_PARSER_VERSION;
  const featureSet = featureSetKey(
    input.featureSet ?? ["FORMS", "TABLES", "LAYOUT"]
  );
  const chunkStrategy = input.chunkStrategy ?? DEFAULT_CHUNK_STRATEGY;
  const documentFilterProvided = input.documentIds !== undefined;
  const documentIds = input.documentIds?.filter(Boolean);
  const formTypes = input.formTypes?.filter(Boolean);
  const pageRange = input.pageRange;

  if (documentFilterProvided && (!documentIds || documentIds.length === 0)) {
    return {
      results: [],
      citations: [],
      warnings: [],
    };
  }

  const rows = await db.documentRetrievalChunk.findMany({
    where: {
      firmId: input.firmId,
      ...(documentIds && documentIds.length > 0
        ? { documentId: { in: documentIds } }
        : {}),
      ...(input.activeGeneration !== undefined
        ? { vectorGeneration: input.activeGeneration }
        : {}),
      ...(formTypes && formTypes.length > 0 ? { formType: { in: formTypes } } : {}),
      ...(pageRange
        ? {
            pageStart: { gte: pageRange.start },
            pageEnd: { lte: pageRange.end },
          }
        : {}),
      parserVersion,
      chunkStrategy,
      baseArtifact: {
        firmId: input.firmId,
        isCurrent: true,
        status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
        parserVersion,
        featureSet,
        ...(input.activeGeneration !== undefined
          ? { generation: input.activeGeneration }
          : {}),
      },
    },
    select: {
      id: true,
      documentId: true,
      firmId: true,
      baseArtifactId: true,
      vectorGeneration: true,
      content: true,
      contentType: true,
      pageStart: true,
      pageEnd: true,
      formType: true,
      sectionPath: true,
      tableId: true,
      sourceBlockIds: true,
      parserVersion: true,
      chunkStrategy: true,
      baseArtifact: {
        select: {
          firmId: true,
          generation: true,
          parserVersion: true,
          featureSet: true,
          isCurrent: true,
          status: true,
        },
      },
    },
    take: maxCandidateChunks + 1,
    orderBy: [{ documentId: "asc" }, { pageStart: "asc" }, { id: "asc" }],
  });

  if (rows.length > maxCandidateChunks) {
    throw new Error(
      `Persisted local retrieval exceeded ${maxCandidateChunks} candidate chunks; use document filters or vector search`
    );
  }

  const warnings: string[] = [];
  const chunks = rows
    .map(toRetrievalChunk)
    .filter((chunk, index) => {
      const row = rows[index];
      const usesCurrentReadyArtifact =
        row.baseArtifact.firmId === input.firmId &&
        row.baseArtifact.isCurrent &&
        row.baseArtifact.status === DocumentBaseArtifactStatus.READY_FOR_INDEXING &&
        row.baseArtifact.parserVersion === parserVersion &&
        row.baseArtifact.featureSet === featureSet &&
        row.parserVersion === parserVersion &&
        row.chunkStrategy === chunkStrategy &&
        row.vectorGeneration === row.baseArtifact.generation;
      const usesRequestedGeneration =
        input.activeGeneration === undefined ||
        chunk.vectorGeneration === input.activeGeneration;
      const hasValidSourceBlockIds = validateRawSourceBlockIds(row.sourceBlockIds);

      if (!hasValidSourceBlockIds) {
        warnings.push(`chunk ${chunk.chunkId} has invalid sourceBlockIds`);
      }

      return (
        chunk.firmId === input.firmId &&
        usesCurrentReadyArtifact &&
        usesRequestedGeneration &&
        (!formTypes ||
          formTypes.length === 0 ||
          (chunk.formType !== null && formTypes.includes(chunk.formType))) &&
        (!pageRange ||
          (chunk.pageStart >= pageRange.start && chunk.pageEnd <= pageRange.end)) &&
        hasValidSourceBlockIds
      );
    });

  if (chunks.length === 0) {
    return {
      results: [],
      citations: [],
      warnings,
    };
  }

  const corpus = {
    firmId: input.firmId,
    namespace: `local_${input.firmId}`,
    generation: input.activeGeneration ?? 0,
    chunksById: new Map(chunks.map((chunk) => [chunk.chunkId, chunk])),
    metadataById: new Map(),
  };
  const results = searchLocalRetrievalCorpus(corpus, input.query, {
    topK,
    documentIds,
  });

  return {
    results,
    citations: results.map(createCitation),
    warnings,
  };
}
