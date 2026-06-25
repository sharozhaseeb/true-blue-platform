import {
  DocumentBaseArtifactStatus,
  DocumentRetrievalContentType,
  DocumentVectorIndexStatus,
  type Prisma,
} from "@prisma/client";
import {
  createCitation,
  createVectorMetadata,
  type BaseDocumentCitation,
  type LocalRetrievalResult,
} from "@/lib/base-document-retrieval";
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
  type PineconeVectorStore,
  type VectorQueryMatch,
} from "@/lib/vector/pinecone";

export interface RetrieveVectorDocumentChunksInput {
  firmId: string;
  query: string;
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: {
    start: number;
    end: number;
  };
  topK?: number;
  parserVersion?: string;
  featureSet?: string[];
  chunkStrategy?: string;
  config?: M3ProviderConfig;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: PineconeVectorStore;
  userId?: string;
}

export interface VectorDocumentRetrievalOutput {
  results: LocalRetrievalResult[];
  citations: BaseDocumentCitation[];
  warnings: string[];
  coverage?: VectorDocumentRetrievalCoverage;
}

export interface VectorDocumentRetrievalDocumentCoverage {
  documentId: string;
  vectorMatchCount: number;
  resultCount: number;
  supportedResultCount: number;
  topScore: number | null;
}

export interface VectorDocumentRetrievalCoverage {
  selectedDocumentIds: string[];
  scoreThreshold: number;
  documents: VectorDocumentRetrievalDocumentCoverage[];
}

type VectorRetrievalDb = typeof prisma;
type VectorMatchWithDocument = VectorQueryMatch & {
  queriedDocumentId?: string;
};

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
      firmId: true,
      generation: true,
      parserVersion: true,
      featureSet: true,
      isCurrent: true,
      status: true,
    },
  },
} satisfies Prisma.DocumentRetrievalChunkSelect;

const VECTOR_INDEX_SELECT = {
  documentId: true,
  firmId: true,
  indexName: true,
  namespace: true,
  generation: true,
  isActive: true,
  status: true,
  vectorIds: true,
  chunkIds: true,
} satisfies Prisma.DocumentVectorIndexSelect;

type VectorRetrievalChunkRow = Prisma.DocumentRetrievalChunkGetPayload<{
  select: typeof RETRIEVAL_CHUNK_SELECT;
}>;
type VectorIndexRow = Prisma.DocumentVectorIndexGetPayload<{
  select: typeof VECTOR_INDEX_SELECT;
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
      typeof sourceBlockId === "string" &&
      sourceBlockId.length > 0 &&
      sourceBlockId.length <= 256
  );
}

function hasValidRawSourceBlockIds(value: Prisma.JsonValue): boolean {
  return (
    Array.isArray(value) &&
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

function toRetrievalChunk(row: VectorRetrievalChunkRow): BaseDocumentRetrievalChunk {
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

function createSnippet(content: string, maxLength = 220): string {
  const snippet = content.trim().slice(0, maxLength);
  return snippet.length < content.trim().length ? `${snippet}...` : snippet;
}

function metadataFilter(input: {
  firmId: string;
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: { start: number; end: number };
  parserVersion: string;
  chunkStrategy: string;
}): object {
  return {
    firmId: { $eq: input.firmId },
    parserVersion: { $eq: input.parserVersion },
    chunkStrategy: { $eq: input.chunkStrategy },
    ...(input.documentIds && input.documentIds.length > 0
      ? { documentId: { $in: input.documentIds } }
      : {}),
    ...(input.formTypes && input.formTypes.length > 0
      ? { formType: { $in: input.formTypes } }
      : {}),
    ...(input.pageRange
      ? {
          pageStart: { $gte: input.pageRange.start },
          pageEnd: { $lte: input.pageRange.end },
        }
      : {}),
  };
}

function jsonStringSet(value: Prisma.JsonValue): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(value.filter((item): item is string => typeof item === "string"));
}

function activeVectorIndexKey(row: VectorIndexRow): string {
  return `${row.documentId}:${row.generation}`;
}

function isRowBackedByActiveVectorIndex(
  row: VectorRetrievalChunkRow,
  activeIndexes: Map<string, VectorIndexRow>
): boolean {
  const activeIndex = activeIndexes.get(`${row.documentId}:${row.vectorGeneration}`);
  if (!activeIndex) {
    return false;
  }

  return (
    activeIndex.firmId === row.firmId &&
    activeIndex.isActive &&
    activeIndex.status === DocumentVectorIndexStatus.ACTIVE &&
    jsonStringSet(activeIndex.vectorIds).has(row.id) &&
    jsonStringSet(activeIndex.chunkIds).has(row.id)
  );
}

function uniqueNonEmpty(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }

  return [...new Set(values.filter(Boolean))];
}

function documentIdForMatch(match: VectorMatchWithDocument): string | undefined {
  return match.metadata?.documentId ?? match.queriedDocumentId;
}

export function stratifyVectorMatchesByDocument(
  matches: VectorMatchWithDocument[],
  selectedDocumentIds: string[],
  topK: number
): VectorQueryMatch[] {
  if (selectedDocumentIds.length <= 1) {
    return matches.slice(0, topK);
  }

  const selected = new Set(selectedDocumentIds);
  const seen = new Set<string>();
  const byDocument = new Map<string, VectorMatchWithDocument[]>(
    selectedDocumentIds.map((documentId) => [documentId, []])
  );
  const unscopedMatches: VectorMatchWithDocument[] = [];

  for (const match of matches) {
    if (seen.has(match.id)) {
      continue;
    }
    seen.add(match.id);

    const documentId = documentIdForMatch(match);
    if (documentId && selected.has(documentId)) {
      byDocument.get(documentId)?.push(match);
    } else {
      unscopedMatches.push(match);
    }
  }

  const stratified: VectorMatchWithDocument[] = [];
  let added = true;
  while (stratified.length < topK && added) {
    added = false;
    for (const documentId of selectedDocumentIds) {
      const next = byDocument.get(documentId)?.shift();
      if (!next) {
        continue;
      }

      stratified.push(next);
      added = true;
      if (stratified.length >= topK) {
        break;
      }
    }
  }

  for (const match of unscopedMatches) {
    if (stratified.length >= topK) {
      break;
    }
    stratified.push(match);
  }

  return stratified;
}

async function queryVectorMatches(input: {
  vectorStore: PineconeVectorStore;
  queryVector: number[];
  topK: number;
  firmId: string;
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: { start: number; end: number };
  parserVersion: string;
  chunkStrategy: string;
}): Promise<VectorMatchWithDocument[]> {
  if (!input.documentIds || input.documentIds.length <= 1) {
    return input.vectorStore.queryVectors({
      vector: input.queryVector,
      topK: input.topK,
      filter: metadataFilter({
        firmId: input.firmId,
        documentIds: input.documentIds,
        formTypes: input.formTypes,
        pageRange: input.pageRange,
        parserVersion: input.parserVersion,
        chunkStrategy: input.chunkStrategy,
      }),
    });
  }

  const perDocumentMatches = await Promise.all(
    input.documentIds.map(async (documentId) => {
      const matches = await input.vectorStore.queryVectors({
        vector: input.queryVector,
        topK: input.topK,
        filter: metadataFilter({
          firmId: input.firmId,
          documentIds: [documentId],
          formTypes: input.formTypes,
          pageRange: input.pageRange,
          parserVersion: input.parserVersion,
          chunkStrategy: input.chunkStrategy,
        }),
      });

      return matches.map((match) => ({
        ...match,
        queriedDocumentId: documentId,
      }));
    })
  );

  return stratifyVectorMatchesByDocument(
    perDocumentMatches.flat(),
    input.documentIds,
    input.topK
  );
}

function createCoverage(input: {
  selectedDocumentIds?: string[];
  vectorMatches: VectorMatchWithDocument[];
  results: LocalRetrievalResult[];
  scoreThreshold: number;
}): VectorDocumentRetrievalCoverage | undefined {
  const documentIds =
    input.selectedDocumentIds && input.selectedDocumentIds.length > 0
      ? input.selectedDocumentIds
      : [...new Set(input.results.map((result) => result.chunk.documentId))];

  if (documentIds.length === 0) {
    return undefined;
  }

  return {
    selectedDocumentIds: documentIds,
    scoreThreshold: input.scoreThreshold,
    documents: documentIds.map((documentId) => {
      const vectorMatches = input.vectorMatches.filter(
        (match) => documentIdForMatch(match) === documentId
      );
      const results = input.results.filter(
        (result) => result.chunk.documentId === documentId
      );
      const topScore = results.reduce<number | null>(
        (best, result) => (best === null ? result.score : Math.max(best, result.score)),
        null
      );

      return {
        documentId,
        vectorMatchCount: vectorMatches.length,
        resultCount: results.length,
        supportedResultCount: results.filter(
          (result) => result.score >= input.scoreThreshold
        ).length,
        topScore,
      };
    }),
  };
}

export async function retrieveVectorDocumentChunks(
  input: RetrieveVectorDocumentChunksInput,
  db: VectorRetrievalDb = prisma
): Promise<VectorDocumentRetrievalOutput> {
  const config = input.config ?? readM3ProviderConfig();
  if (!config.vectorRetrievalEnabled) {
    throw new Error("Vector retrieval is disabled");
  }

  const embeddingConfig = requireOpenAIEmbeddingConfig(config);
  const pineconeConfig = requirePineconeConfig(config);
  const topK = Math.min(Math.max(input.topK ?? 8, 1), 30);
  const parserVersion =
    input.parserVersion ?? TEXTRACT_BASE_DOCUMENT_PARSER_VERSION;
  const featureSet = featureSetKey(input.featureSet ?? ["FORMS", "TABLES", "LAYOUT"]);
  const chunkStrategy = input.chunkStrategy ?? DEFAULT_CHUNK_STRATEGY;
  const documentFilterProvided = input.documentIds !== undefined;
  const documentIds = uniqueNonEmpty(input.documentIds);
  const formTypes = input.formTypes?.filter(Boolean);
  const namespace = getPineconeFirmNamespace(
    input.firmId,
    pineconeConfig.namespacePrefix
  );

  if (documentFilterProvided && (!documentIds || documentIds.length === 0)) {
    return {
      results: [],
      citations: [],
      warnings: [],
    };
  }

  const embeddingProvider =
    input.embeddingProvider ?? createOpenAIEmbeddingProvider(config);
  const embeddingResult = await embeddingProvider.embedTexts([input.query], input.userId);
  const queryVector = embeddingResult.vectors[0];
  if (!queryVector || queryVector.length !== embeddingConfig.dimension) {
    throw new Error("Query embedding dimension did not match configured dimension");
  }

  const vectorStore =
    input.vectorStore ??
    createPineconeVectorStore({
      firmId: input.firmId,
      dimension: embeddingConfig.dimension,
      config,
    });
  const vectorMatches = await queryVectorMatches({
    vectorStore,
    queryVector,
    topK,
    firmId: input.firmId,
    documentIds,
    formTypes,
    pageRange: input.pageRange,
    parserVersion,
    chunkStrategy,
  });
  const matchedIds = vectorMatches.map((match) => match.id).filter(Boolean);

  if (matchedIds.length === 0) {
    return {
      results: [],
      citations: [],
      warnings: [],
      coverage: createCoverage({
        selectedDocumentIds: documentIds,
        vectorMatches,
        results: [],
        scoreThreshold: config.vectorMinScore,
      }),
    };
  }

  const rows = await db.documentRetrievalChunk.findMany({
    where: {
      id: { in: matchedIds },
      firmId: input.firmId,
      ...(documentIds && documentIds.length > 0
        ? { documentId: { in: documentIds } }
        : {}),
      ...(formTypes && formTypes.length > 0 ? { formType: { in: formTypes } } : {}),
      ...(input.pageRange
        ? {
            pageStart: { gte: input.pageRange.start },
            pageEnd: { lte: input.pageRange.end },
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
      },
    },
    select: RETRIEVAL_CHUNK_SELECT,
  });
  const activeIndexes = await db.documentVectorIndex.findMany({
    where: {
      firmId: input.firmId,
      indexName: pineconeConfig.indexName,
      namespace,
      isActive: true,
      status: DocumentVectorIndexStatus.ACTIVE,
      documentId: {
        in: [...new Set(rows.map((row) => row.documentId))],
      },
    },
    select: VECTOR_INDEX_SELECT,
  });
  const activeIndexByDocumentGeneration = new Map(
    activeIndexes.map((row) => [activeVectorIndexKey(row), row])
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const warnings: string[] = [];
  const resultById = new Map(vectorMatches.map((match) => [match.id, match]));
  const results = vectorMatches.flatMap((match): LocalRetrievalResult[] => {
    const row = rowById.get(match.id);
    if (!row) {
      warnings.push(`vector match ${match.id} did not resolve to a current retrieval chunk`);
      return [];
    }

    if (!hasValidRawSourceBlockIds(row.sourceBlockIds)) {
      warnings.push(`chunk ${row.id} has invalid sourceBlockIds`);
      return [];
    }

    if (!isRowBackedByActiveVectorIndex(row, activeIndexByDocumentGeneration)) {
      warnings.push(`chunk ${row.id} is not backed by an active vector generation`);
      return [];
    }

    const chunk = toRetrievalChunk(row);
    const metadata = match.metadata ?? createVectorMetadata(chunk);

    return [
      {
        chunk,
        metadata,
        score: resultById.get(row.id)?.score ?? 0,
        snippet: createSnippet(row.content),
        snippetFull: row.content,
      },
    ];
  });

  return {
    results,
    citations: results.map(createCitation),
    warnings,
    coverage: createCoverage({
      selectedDocumentIds: documentIds,
      vectorMatches,
      results,
      scoreThreshold: config.vectorMinScore,
    }),
  };
}
