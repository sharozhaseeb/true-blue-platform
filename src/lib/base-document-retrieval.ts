import type { BaseDocumentRetrievalChunk } from "@/lib/base-document-chunker";

export interface BaseDocumentVectorMetadata {
  chunkId: string;
  documentId: string;
  firmId: string;
  pageStart: number;
  pageEnd: number;
  formType?: string;
  parserVersion: string;
  chunkStrategy: string;
  contentType: BaseDocumentRetrievalChunk["contentType"];
}

export interface LocalRetrievalCorpus {
  firmId: string;
  namespace: string;
  generation: number;
  chunksById: Map<string, BaseDocumentRetrievalChunk>;
  metadataById: Map<string, BaseDocumentVectorMetadata>;
}

export interface LocalRetrievalResult {
  chunk: BaseDocumentRetrievalChunk;
  metadata: BaseDocumentVectorMetadata;
  score: number;
  snippet: string;
  snippetFull?: string;
}

export interface BaseDocumentCitation {
  chunkId: string;
  documentId: string;
  pageStart: number;
  pageEnd: number;
  snippet: string;
  snippetFull?: string;
  sourceBlockIds: string[];
}

const PINECONE_METADATA_KEYS = [
  "chunkId",
  "documentId",
  "firmId",
  "pageStart",
  "pageEnd",
  "formType",
  "parserVersion",
  "chunkStrategy",
  "contentType",
] as const;

const TOKEN_RE = /[a-z0-9_]+/gi;

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(TOKEN_RE) ?? []).filter(
    (token) => token.length > 1
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function getFirmVectorNamespace(firmId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(firmId)) {
    throw new Error("firmId contains unsupported namespace characters");
  }

  return `firm_${firmId}`;
}

export function createVectorMetadata(
  chunk: BaseDocumentRetrievalChunk
): BaseDocumentVectorMetadata {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    firmId: chunk.firmId,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    ...(chunk.formType ? { formType: chunk.formType } : {}),
    parserVersion: chunk.parserVersion,
    chunkStrategy: chunk.chunkStrategy,
    contentType: chunk.contentType,
  };
}

export function validateVectorMetadata(metadata: object): string[] {
  const allowedKeys = new Set<string>(PINECONE_METADATA_KEYS);
  const errors: string[] = [];

  for (const key of Object.keys(metadata)) {
    if (!allowedKeys.has(key)) {
      errors.push(`metadata key is not allowlisted: ${key}`);
    }
  }

  for (const [key, value] of Object.entries(metadata)) {
    const valueType = typeof value;
    const validValue =
      valueType === "string" ||
      valueType === "number" ||
      valueType === "boolean" ||
      (Array.isArray(value) &&
        value.every((item) => ["string", "number", "boolean"].includes(typeof item)));

    if (value === null || value === undefined || !validValue) {
      errors.push(`metadata key has unsupported value: ${key}`);
    }
  }

  if ("content" in metadata || "snippet" in metadata || "sourceBlockIds" in metadata) {
    errors.push("metadata contains retrieval text/provenance that must remain in Postgres");
  }

  return errors;
}

export function validateChunksForIndexing(
  chunks: BaseDocumentRetrievalChunk[]
): string[] {
  const errors: string[] = [];
  const chunkIds = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk.chunkId) {
      errors.push("chunk is missing chunkId");
    }

    if (chunkIds.has(chunk.chunkId)) {
      errors.push(`duplicate chunkId: ${chunk.chunkId}`);
    }
    chunkIds.add(chunk.chunkId);

    if (!chunk.documentId) {
      errors.push(`chunk ${chunk.chunkId} is missing documentId`);
    }

    if (!chunk.firmId) {
      errors.push(`chunk ${chunk.chunkId} is missing firmId`);
    }

    if (!chunk.baseArtifactId) {
      errors.push(`chunk ${chunk.chunkId} is missing baseArtifactId`);
    }

    if (chunk.vectorGeneration <= 0) {
      errors.push(`chunk ${chunk.chunkId} has invalid vectorGeneration`);
    }

    if (!chunk.content.trim()) {
      errors.push(`chunk ${chunk.chunkId} has empty content`);
    }

    if (chunk.sourceBlockIds.length === 0) {
      errors.push(`chunk ${chunk.chunkId} is missing sourceBlockIds`);
    }

    if (chunk.pageStart <= 0 || chunk.pageEnd < chunk.pageStart) {
      errors.push(`chunk ${chunk.chunkId} has invalid page span`);
    }

    if (!chunk.parserVersion) {
      errors.push(`chunk ${chunk.chunkId} is missing parserVersion`);
    }

    if (!chunk.chunkStrategy) {
      errors.push(`chunk ${chunk.chunkId} is missing chunkStrategy`);
    }

    errors.push(...validateVectorMetadata(createVectorMetadata(chunk)));
  }

  return errors;
}

export function buildLocalRetrievalCorpus(
  chunks: BaseDocumentRetrievalChunk[],
  firmId: string,
  generation: number
): LocalRetrievalCorpus {
  const indexingErrors = validateChunksForIndexing(chunks);
  if (indexingErrors.length > 0) {
    throw new Error(`Invalid retrieval chunks: ${indexingErrors.join("; ")}`);
  }

  const activeChunks = chunks.filter(
    (chunk) => chunk.firmId === firmId && chunk.vectorGeneration === generation
  );

  if (activeChunks.length === 0) {
    throw new Error("No active chunks found for firm/generation");
  }

  return {
    firmId,
    namespace: getFirmVectorNamespace(firmId),
    generation,
    chunksById: new Map(activeChunks.map((chunk) => [chunk.chunkId, chunk])),
    metadataById: new Map(
      activeChunks.map((chunk) => [chunk.chunkId, createVectorMetadata(chunk)])
    ),
  };
}

function scoreChunk(queryTokens: string[], chunk: BaseDocumentRetrievalChunk): number {
  const contentTokens = tokenize(chunk.content);
  if (queryTokens.length === 0 || contentTokens.length === 0) {
    return 0;
  }

  const contentTokenSet = new Set(contentTokens);
  const matches = queryTokens.filter((token) => contentTokenSet.has(token));
  const exactPhraseBonus = chunk.content
    .toLowerCase()
    .includes(queryTokens.join(" "))
    ? 1
    : 0;
  const lexicalCoverage = matches.length / queryTokens.length;
  const hasQueryEvidence =
    exactPhraseBonus > 0 || matches.length >= 2 || lexicalCoverage >= 0.4;
  const typeBoost =
    hasQueryEvidence &&
    (chunk.contentType === "field_group" || chunk.contentType === "table")
      ? 0.25
      : 0;

  return hasQueryEvidence ? lexicalCoverage + exactPhraseBonus + typeBoost : 0;
}

function createSnippet(content: string, queryTokens: string[], maxLength = 220): string {
  const lowerContent = content.toLowerCase();
  const firstMatchIndex = queryTokens
    .map((token) => lowerContent.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max((firstMatchIndex ?? 0) - 60, 0);
  const snippet = content.slice(start, start + maxLength).trim();

  return snippet.length < content.length ? `${snippet}...` : snippet;
}

export function searchLocalRetrievalCorpus(
  corpus: LocalRetrievalCorpus,
  query: string,
  options: { topK?: number; documentIds?: string[] } = {}
): LocalRetrievalResult[] {
  const queryTokens = unique(tokenize(query));
  const documentFilter = options.documentIds ? new Set(options.documentIds) : null;

  return [...corpus.chunksById.values()]
    .filter((chunk) => !documentFilter || documentFilter.has(chunk.documentId))
    .map((chunk) => ({
      chunk,
      metadata: corpus.metadataById.get(chunk.chunkId) ?? createVectorMetadata(chunk),
      score: scoreChunk(queryTokens, chunk),
      snippet: createSnippet(chunk.content, queryTokens),
      snippetFull: chunk.content,
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.chunk.chunkId.localeCompare(right.chunk.chunkId);
    })
    .slice(0, options.topK ?? 8);
}

export function createCitation(result: LocalRetrievalResult): BaseDocumentCitation {
  return {
    chunkId: result.chunk.chunkId,
    documentId: result.chunk.documentId,
    pageStart: result.chunk.pageStart,
    pageEnd: result.chunk.pageEnd,
    snippet: result.snippet,
    snippetFull: result.snippetFull ?? result.chunk.content,
    sourceBlockIds: result.chunk.sourceBlockIds,
  };
}
