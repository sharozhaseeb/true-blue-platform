import {
  DocumentBaseArtifactStatus,
  DocumentRetrievalContentType,
  DocumentVectorIndexStatus,
  Prisma,
} from "@prisma/client";
import type {
  BaseDocumentChunkContentType,
  BaseDocumentRetrievalChunk,
} from "@/lib/base-document-chunker";
import { DEFAULT_CHUNK_STRATEGY } from "@/lib/base-document-chunker";
import {
  createOpenAIEmbeddingProvider,
  type EmbeddingProvider,
} from "@/lib/ai/embedding-provider";
import {
  readM3ProviderConfig,
  requireOpenAIEmbeddingConfig,
  requirePineconeConfig,
  type M3ProviderConfig,
} from "@/lib/ai/config";
import { prisma } from "@/lib/prisma";
import { TEXTRACT_BASE_DOCUMENT_PARSER_VERSION } from "@/lib/textract-normalizer";
import {
  createPineconeVectorStore,
  getPineconeFirmNamespace,
  vectorRecordFromChunk,
  type PineconeVectorStore,
} from "@/lib/vector/pinecone";

export interface IndexDocumentVectorsInput {
  firmId: string;
  documentId: string;
  parserVersion?: string;
  featureSet?: string[];
  chunkStrategy?: string;
  config?: M3ProviderConfig;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: PineconeVectorStore;
  userId?: string;
}

export interface IndexDocumentVectorsResult {
  documentId: string;
  firmId: string;
  indexName: string;
  namespace: string;
  generation: number;
  vectorIndexId: string;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimension: number;
  status: "ACTIVE";
}

type VectorIndexingDb = typeof prisma;

const RETRIEVAL_CHUNK_SELECT = {
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
      generation: true,
      featureSet: true,
      parserVersion: true,
      status: true,
      isCurrent: true,
    },
  },
} satisfies Prisma.DocumentRetrievalChunkSelect;

type VectorIndexingChunkRow = Prisma.DocumentRetrievalChunkGetPayload<{
  select: typeof RETRIEVAL_CHUNK_SELECT;
}>;

function featureSetKey(featureSet: string[]): string {
  return [...featureSet].sort().join(",");
}

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

function parseSourceBlockIds(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (sourceBlockId): sourceBlockId is string =>
      typeof sourceBlockId === "string" && sourceBlockId.length > 0
  );
}

function toBaseDocumentRetrievalChunk(
  row: VectorIndexingChunkRow
): BaseDocumentRetrievalChunk {
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

function assertSingleGeneration(chunks: VectorIndexingChunkRow[]): number {
  const generations = new Set(chunks.map((chunk) => chunk.vectorGeneration));
  if (generations.size !== 1) {
    throw new Error("Cannot index chunks with mixed vector generations");
  }

  const generation = chunks[0]?.vectorGeneration;
  if (!generation || generation <= 0) {
    throw new Error("Cannot index chunks without a valid vector generation");
  }

  return generation;
}

async function loadChunksForIndexing(
  db: VectorIndexingDb,
  input: {
    firmId: string;
    documentId: string;
    parserVersion: string;
    featureSet: string;
    chunkStrategy: string;
  }
): Promise<VectorIndexingChunkRow[]> {
  return db.documentRetrievalChunk.findMany({
    where: {
      firmId: input.firmId,
      documentId: input.documentId,
      parserVersion: input.parserVersion,
      chunkStrategy: input.chunkStrategy,
      baseArtifact: {
        firmId: input.firmId,
        documentId: input.documentId,
        isCurrent: true,
        status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
        parserVersion: input.parserVersion,
        featureSet: input.featureSet,
      },
    },
    select: RETRIEVAL_CHUNK_SELECT,
    orderBy: [{ pageStart: "asc" }, { id: "asc" }],
  });
}

export async function indexDocumentVectors(
  input: IndexDocumentVectorsInput,
  db: VectorIndexingDb = prisma
): Promise<IndexDocumentVectorsResult> {
  const config = input.config ?? readM3ProviderConfig();
  if (!config.vectorIndexingEnabled) {
    throw new Error("Vector indexing is disabled");
  }

  const embeddingConfig = requireOpenAIEmbeddingConfig(config);
  const pineconeConfig = requirePineconeConfig(config);
  const parserVersion =
    input.parserVersion ?? TEXTRACT_BASE_DOCUMENT_PARSER_VERSION;
  const featureSet = featureSetKey(input.featureSet ?? ["FORMS", "TABLES", "LAYOUT"]);
  const chunkStrategy = input.chunkStrategy ?? DEFAULT_CHUNK_STRATEGY;
  const namespace = getPineconeFirmNamespace(
    input.firmId,
    pineconeConfig.namespacePrefix
  );
  const chunks = await loadChunksForIndexing(db, {
    firmId: input.firmId,
    documentId: input.documentId,
    parserVersion,
    featureSet,
    chunkStrategy,
  });

  if (chunks.length === 0) {
    throw new Error("No current retrieval chunks are ready for vector indexing");
  }

  const generation = assertSingleGeneration(chunks);
  const chunkIds = chunks.map((chunk) => chunk.id);
  const vectorIds = [...chunkIds];
  const indexName = pineconeConfig.indexName;
  const vectorIndex = await db.documentVectorIndex.upsert({
    where: {
      documentId_indexName_namespace_generation: {
        documentId: input.documentId,
        indexName,
        namespace,
        generation,
      },
    },
    create: {
      documentId: input.documentId,
      firmId: input.firmId,
      indexName,
      namespace,
      embeddingModel: embeddingConfig.model,
      embeddingDim: embeddingConfig.dimension,
      parserVersion,
      chunkStrategy,
      generation,
      isActive: false,
      status: DocumentVectorIndexStatus.BUILDING,
      vectorIds: [],
      chunkIds: [],
    },
    update: {
      embeddingModel: embeddingConfig.model,
      embeddingDim: embeddingConfig.dimension,
      parserVersion,
      chunkStrategy,
      isActive: false,
      status: DocumentVectorIndexStatus.BUILDING,
      vectorIds: [],
      chunkIds: [],
    },
  });

  try {
    const baseChunks = chunks.map(toBaseDocumentRetrievalChunk);
    const embeddingProvider =
      input.embeddingProvider ?? createOpenAIEmbeddingProvider(config);
    const embeddingResult = await embeddingProvider.embedTexts(
      baseChunks.map((chunk) => chunk.content),
      input.userId
    );
    const vectorStore =
      input.vectorStore ??
      createPineconeVectorStore({
        firmId: input.firmId,
        dimension: embeddingResult.dimensions,
        config,
      });

    await vectorStore.upsertVectors(
      baseChunks.map((chunk, index) =>
        vectorRecordFromChunk(chunk, embeddingResult.vectors[index])
      )
    );

    await db.$transaction([
      db.documentVectorIndex.updateMany({
        where: {
          documentId: input.documentId,
          firmId: input.firmId,
          indexName,
          namespace,
          isActive: true,
          generation: {
            not: generation,
          },
        },
        data: {
          isActive: false,
          status: DocumentVectorIndexStatus.RETIRED,
        },
      }),
      db.documentVectorIndex.update({
        where: {
          id: vectorIndex.id,
        },
        data: {
          embeddingModel: embeddingResult.model,
          embeddingDim: embeddingResult.dimensions,
          vectorIds,
          chunkIds,
          isActive: true,
          status: DocumentVectorIndexStatus.ACTIVE,
        },
      }),
    ]);

    return {
      documentId: input.documentId,
      firmId: input.firmId,
      indexName,
      namespace,
      generation,
      vectorIndexId: vectorIndex.id,
      chunkCount: chunks.length,
      embeddingModel: embeddingResult.model,
      embeddingDimension: embeddingResult.dimensions,
      status: "ACTIVE",
    };
  } catch (error) {
    await db.documentVectorIndex.update({
      where: {
        id: vectorIndex.id,
      },
      data: {
        isActive: false,
        status: DocumentVectorIndexStatus.FAILED,
      },
    });

    throw error;
  }
}
