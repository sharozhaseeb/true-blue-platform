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
