import OpenAI from "openai";
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from "openai/resources/embeddings";
import {
  readM3ProviderConfig,
  requireOpenAIEmbeddingConfig,
  type M3ProviderConfig,
} from "@/lib/ai/config";

export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface EmbeddingBatchResult {
  model: string;
  dimensions: number;
  vectors: number[][];
  usage: EmbeddingUsage;
}

export interface EmbeddingProvider {
  embedTexts(texts: string[], userId?: string): Promise<EmbeddingBatchResult>;
}

interface OpenAIEmbeddingsClient {
  embeddings: {
    create(params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse>;
  };
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  dimension: number;
  batchSize?: number;
  client?: OpenAIEmbeddingsClient;
}

const DEFAULT_EMBEDDING_BATCH_SIZE = 96;
const MAX_EMBEDDING_BATCH_SIZE = 256;

function supportsCustomDimensions(model: string): boolean {
  return model.startsWith("text-embedding-3");
}

function normalizeTexts(texts: string[]): string[] {
  if (texts.length === 0) {
    throw new Error("At least one non-empty text is required for embedding");
  }

  return texts.map((text, index) => {
    const normalized = text.trim();
    if (normalized.length === 0) {
      throw new Error(`Embedding text at index ${index} is empty`);
    }

    return normalized;
  });
}

function assertEmbeddingVectors(
  vectors: number[][],
  expectedCount: number,
  expectedDimension: number
) {
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Embedding count mismatch: expected ${expectedCount}, received ${vectors.length}`
    );
  }

  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch at index ${index}: expected ${expectedDimension}, received ${vector.length}`
      );
    }
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAIEmbeddingsClient;
  private readonly model: string;
  private readonly dimension: number;
  private readonly batchSize: number;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        maxRetries: 2,
        timeout: 30_000,
      });
    this.model = options.model;
    this.dimension = options.dimension;
    this.batchSize = Math.min(
      Math.max(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, 1),
      MAX_EMBEDDING_BATCH_SIZE
    );
  }

  async embedTexts(texts: string[], userId?: string): Promise<EmbeddingBatchResult> {
    const cleanedTexts = normalizeTexts(texts);

    const vectors: number[][] = [];
    let promptTokens = 0;
    let totalTokens = 0;
    let responseModel = this.model;

    for (let index = 0; index < cleanedTexts.length; index += this.batchSize) {
      const batch = cleanedTexts.slice(index, index + this.batchSize);
      const response = await this.client.embeddings.create({
        input: batch,
        model: this.model,
        encoding_format: "float",
        ...(supportsCustomDimensions(this.model)
          ? { dimensions: this.dimension }
          : {}),
        ...(userId ? { user: userId } : {}),
      });
      const orderedVectors = [...response.data]
        .sort((left, right) => left.index - right.index)
        .map((embedding) => embedding.embedding);

      vectors.push(...orderedVectors);
      promptTokens += response.usage.prompt_tokens;
      totalTokens += response.usage.total_tokens;
      responseModel = response.model;
    }

    assertEmbeddingVectors(vectors, cleanedTexts.length, this.dimension);

    return {
      model: responseModel,
      dimensions: this.dimension,
      vectors,
      usage: {
        promptTokens,
        totalTokens,
      },
    };
  }
}

export function createOpenAIEmbeddingProvider(
  config: M3ProviderConfig = readM3ProviderConfig()
): OpenAIEmbeddingProvider {
  const embeddingConfig = requireOpenAIEmbeddingConfig(config);

  return new OpenAIEmbeddingProvider({
    apiKey: embeddingConfig.apiKey,
    model: embeddingConfig.model,
    dimension: embeddingConfig.dimension,
  });
}
