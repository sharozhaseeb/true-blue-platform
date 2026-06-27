import {
  Pinecone,
  type Index,
  type PineconeRecord,
  type QueryResponse,
  type RecordMetadata,
} from "@pinecone-database/pinecone";
import {
  createVectorMetadata,
  getFirmVectorNamespace,
  validateVectorMetadata,
  type BaseDocumentVectorMetadata,
} from "@/lib/base-document-retrieval";
import type { BaseDocumentRetrievalChunk } from "@/lib/base-document-chunker";
import {
  readM3ProviderConfig,
  requirePineconeConfig,
  type M3ProviderConfig,
} from "@/lib/ai/config";

export interface VectorRecordInput {
  id: string;
  values: number[];
  metadata: BaseDocumentVectorMetadata;
}

export interface VectorQueryInput {
  vector: number[];
  topK?: number;
  filter?: object;
}

export interface VectorQueryMatch {
  id: string;
  score: number;
  metadata?: BaseDocumentVectorMetadata;
}

interface PineconeClientLike {
  index<T extends RecordMetadata = RecordMetadata>(options: {
    name?: string;
    host?: string;
    namespace?: string;
  }): Index<T>;
}

export interface PineconeVectorStoreOptions {
  apiKey: string;
  indexName?: string;
  indexHost?: string;
  namespace: string;
  dimension: number;
  client?: PineconeClientLike;
}

const MAX_PINECONE_UPSERT_BATCH_SIZE = 1000;
const MAX_PINECONE_DELETE_BATCH_SIZE = 1000;

function assertVector(values: number[], dimension: number, label: string) {
  if (values.length !== dimension) {
    throw new Error(
      `${label} dimension mismatch: expected ${dimension}, received ${values.length}`
    );
  }

  if (!values.every((value) => Number.isFinite(value))) {
    throw new Error(`${label} contains a non-finite value`);
  }
}

function toPineconeMetadata(metadata: BaseDocumentVectorMetadata): RecordMetadata {
  const metadataErrors = validateVectorMetadata(metadata);
  if (metadataErrors.length > 0) {
    throw new Error(`Invalid vector metadata: ${metadataErrors.join("; ")}`);
  }

  return { ...metadata };
}

function fromPineconeMetadata(
  metadata: RecordMetadata | undefined
): BaseDocumentVectorMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const candidate = { ...metadata };
  const metadataErrors = validateVectorMetadata(candidate);
  if (metadataErrors.length > 0) {
    return undefined;
  }

  return candidate as unknown as BaseDocumentVectorMetadata;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

export function getPineconeFirmNamespace(
  firmId: string,
  namespacePrefix: string
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(namespacePrefix)) {
    throw new Error("namespacePrefix contains unsupported characters");
  }

  return `${namespacePrefix}_${getFirmVectorNamespace(firmId)}`;
}

export function vectorRecordFromChunk(
  chunk: BaseDocumentRetrievalChunk,
  values: number[]
): VectorRecordInput {
  return {
    id: chunk.chunkId,
    values,
    metadata: createVectorMetadata(chunk),
  };
}

export class PineconeVectorStore {
  private readonly client: PineconeClientLike;
  private readonly indexName?: string;
  private readonly indexHost?: string;
  private readonly namespace: string;
  private readonly dimension: number;

  constructor(options: PineconeVectorStoreOptions) {
    if (!options.indexName && !options.indexHost) {
      throw new Error("Pinecone indexName or indexHost is required");
    }

    this.client =
      options.client ??
      new Pinecone({
        apiKey: options.apiKey,
      });
    this.indexName = options.indexName;
    this.indexHost = options.indexHost;
    this.namespace = options.namespace;
    this.dimension = options.dimension;
  }

  private index(): Index<RecordMetadata> {
    return this.client.index<RecordMetadata>({
      ...(this.indexHost ? { host: this.indexHost } : { name: this.indexName }),
      namespace: this.namespace,
    });
  }

  async upsertVectors(records: VectorRecordInput[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    for (const record of records) {
      assertVector(record.values, this.dimension, `vector ${record.id}`);
    }

    const pineconeRecords: PineconeRecord<RecordMetadata>[] = records.map((record) => ({
      id: record.id,
      values: record.values,
      metadata: toPineconeMetadata(record.metadata),
    }));

    for (const batch of chunkArray(pineconeRecords, MAX_PINECONE_UPSERT_BATCH_SIZE)) {
      await this.index().upsert({
        records: batch,
      });
    }
  }

  async queryVectors(input: VectorQueryInput): Promise<VectorQueryMatch[]> {
    assertVector(input.vector, this.dimension, "query vector");

    const response: QueryResponse<RecordMetadata> = await this.index().query({
      vector: input.vector,
      topK: Math.min(Math.max(input.topK ?? 8, 1), 30),
      includeMetadata: true,
      includeValues: false,
      ...(input.filter ? { filter: input.filter } : {}),
    });

    return response.matches.map((match) => ({
      id: match.id,
      score: match.score ?? 0,
      metadata: fromPineconeMetadata(match.metadata),
    }));
  }

  async deleteVectorsByIds(vectorIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(vectorIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return;
    }

    for (const batch of chunkArray(uniqueIds, MAX_PINECONE_DELETE_BATCH_SIZE)) {
      await this.index().deleteMany({
        ids: batch,
      });
    }
  }
}

// --- Reranking (Pinecone Inference) -----------------------------------------
//
// Free, single-vendor reranking via `pc.inference.rerank(...)` on the client we
// already import. Confirmed against the installed SDK types
// (@pinecone-database/pinecone v7.2.0, `dist/inference/rerank.d.ts`): the method
// takes a single options object — `{ model, query, documents, topN?,
// returnDocuments?, rankFields?, parameters? }` — and returns
// `{ data: Array<{ index, score }>, ... }` with scores normalized 0..1. The
// `documents` may be `string[]` or `Array<{ [field]: string }>`; we pass the
// chunk text on a `text` field and rank on it.

export const DEFAULT_RERANK_MODEL = "bge-reranker-v2-m3";

export interface RerankDocumentInput {
  /** Stable id used to map the rerank result back to the caller's record. */
  id: string;
  /** The chunk text scored by the cross-encoder against the query. */
  text: string;
}

export interface RerankHit {
  id: string;
  /** Cross-encoder relevance, normalized 0..1 (NOT a cosine score). */
  score: number;
}

/** Minimal slice of the Pinecone client used for reranking (injectable in tests). */
type RerankCapableClient = Pick<Pinecone, "inference">;

/**
 * Rerank `documents` against `query` with a Pinecone-hosted reranking model.
 * Returns hits sorted by descending relevance (already capped to `topN`).
 *
 * Throws if Pinecone Inference is unavailable/errors — callers are expected to
 * catch and fall back to their existing ordering (reranking is best-effort).
 */
export async function rerankDocuments(input: {
  apiKey: string;
  query: string;
  documents: RerankDocumentInput[];
  topN?: number;
  model?: string;
  client?: RerankCapableClient;
}): Promise<RerankHit[]> {
  if (input.documents.length === 0) {
    return [];
  }

  const client: RerankCapableClient =
    input.client ?? new Pinecone({ apiKey: input.apiKey });
  const model = input.model ?? DEFAULT_RERANK_MODEL;
  const topN =
    input.topN !== undefined
      ? Math.min(Math.max(input.topN, 1), input.documents.length)
      : undefined;

  const response = await client.inference.rerank({
    model,
    query: input.query,
    documents: input.documents.map((document) => ({ text: document.text })),
    rankFields: ["text"],
    returnDocuments: false,
    ...(topN !== undefined ? { topN } : {}),
    // bge-reranker-v2-m3 caps each document at ~1,024 tokens; truncate long
    // tax/financial chunks from the END so the call never errors on length.
    parameters: { truncate: "END" },
  });

  return response.data
    .filter(
      (ranked) =>
        Number.isInteger(ranked.index) &&
        ranked.index >= 0 &&
        ranked.index < input.documents.length
    )
    .map((ranked) => ({
      id: input.documents[ranked.index].id,
      score: ranked.score,
    }));
}

export function createPineconeVectorStore(input: {
  firmId: string;
  dimension: number;
  config?: M3ProviderConfig;
}): PineconeVectorStore {
  const config = input.config ?? readM3ProviderConfig();
  const pineconeConfig = requirePineconeConfig(config);

  return new PineconeVectorStore({
    apiKey: pineconeConfig.apiKey,
    indexName: pineconeConfig.indexName,
    indexHost: pineconeConfig.indexHost,
    namespace: getPineconeFirmNamespace(input.firmId, pineconeConfig.namespacePrefix),
    dimension: input.dimension,
  });
}
