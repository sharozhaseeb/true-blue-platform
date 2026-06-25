export interface M3ProviderConfig {
  aiChatEnabled: boolean;
  vectorIndexingEnabled: boolean;
  vectorRetrievalEnabled: boolean;
  vectorMinScore: number;
  openAiApiKey?: string;
  aiModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  pineconeApiKey?: string;
  pineconeIndexName?: string;
  pineconeIndexHost?: string;
  pineconeNamespacePrefix: string;
  validationErrors: string[];
}

const DEFAULT_AI_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const DEFAULT_PINECONE_NAMESPACE_PREFIX = "trueblue";
const DEFAULT_VECTOR_MIN_SCORE = 0.25;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readFlag(value: string | undefined): boolean {
  return clean(value)?.toLowerCase() === "true";
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  key: string,
  errors: string[]
): number {
  const cleaned = clean(value);
  if (!cleaned) {
    return fallback;
  }

  const parsed = Number(cleaned);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${key} must be a positive integer`);
    return fallback;
  }

  return parsed;
}

function readNonNegativeNumber(
  value: string | undefined,
  fallback: number,
  key: string,
  errors: string[]
): number {
  const cleaned = clean(value);
  if (!cleaned) {
    return fallback;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) {
    errors.push(`${key} must be a non-negative number`);
    return fallback;
  }

  return parsed;
}

function validateNamespacePrefix(prefix: string, errors: string[]): string {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
    errors.push("PINECONE_NAMESPACE_PREFIX contains unsupported characters");
    return DEFAULT_PINECONE_NAMESPACE_PREFIX;
  }

  return prefix;
}

export function readM3ProviderConfig(
  env: NodeJS.ProcessEnv = process.env
): M3ProviderConfig {
  const validationErrors: string[] = [];
  const aiChatEnabled = readFlag(env.ENABLE_AI_CHAT);
  const vectorIndexingEnabled = readFlag(env.ENABLE_VECTOR_INDEXING);
  const vectorRetrievalEnabled = readFlag(env.ENABLE_VECTOR_RETRIEVAL);
  const vectorMinScore = readNonNegativeNumber(
    env.VECTOR_MIN_SCORE,
    DEFAULT_VECTOR_MIN_SCORE,
    "VECTOR_MIN_SCORE",
    validationErrors
  );
  const embeddingDimension = readPositiveInteger(
    env.EMBEDDING_DIMENSION,
    DEFAULT_EMBEDDING_DIMENSION,
    "EMBEDDING_DIMENSION",
    validationErrors
  );
  const pineconeNamespacePrefix = validateNamespacePrefix(
    clean(env.PINECONE_NAMESPACE_PREFIX) ?? DEFAULT_PINECONE_NAMESPACE_PREFIX,
    validationErrors
  );
  const config: M3ProviderConfig = {
    aiChatEnabled,
    vectorIndexingEnabled,
    vectorRetrievalEnabled,
    vectorMinScore,
    openAiApiKey: clean(env.OPENAI_API_KEY),
    aiModel: clean(env.AI_MODEL) ?? DEFAULT_AI_MODEL,
    embeddingModel: clean(env.EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimension,
    pineconeApiKey: clean(env.PINECONE_API_KEY),
    pineconeIndexName: clean(env.PINECONE_INDEX_NAME),
    pineconeIndexHost: clean(env.PINECONE_INDEX_HOST),
    pineconeNamespacePrefix,
    validationErrors,
  };

  if (
    (config.aiChatEnabled ||
      config.vectorIndexingEnabled ||
      config.vectorRetrievalEnabled) &&
    !config.openAiApiKey
  ) {
    validationErrors.push(
      "OPENAI_API_KEY is required when AI chat, vector indexing, or vector retrieval is enabled"
    );
  }

  if (config.vectorIndexingEnabled || config.vectorRetrievalEnabled) {
    if (!config.pineconeApiKey) {
      validationErrors.push("PINECONE_API_KEY is required when vector indexing or retrieval is enabled");
    }

    if (!config.pineconeIndexName) {
      validationErrors.push("PINECONE_INDEX_NAME is required when vector indexing or retrieval is enabled");
    }
  }

  return config;
}

export function requireOpenAIEmbeddingConfig(config: M3ProviderConfig): {
  apiKey: string;
  model: string;
  dimension: number;
} {
  if (config.validationErrors.length > 0) {
    throw new Error(`Invalid M3 provider config: ${config.validationErrors.join("; ")}`);
  }

  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for embedding generation");
  }

  return {
    apiKey: config.openAiApiKey,
    model: config.embeddingModel,
    dimension: config.embeddingDimension,
  };
}

export function requirePineconeConfig(config: M3ProviderConfig): {
  apiKey: string;
  indexName: string;
  indexHost?: string;
  namespacePrefix: string;
} {
  if (config.validationErrors.length > 0) {
    throw new Error(`Invalid M3 provider config: ${config.validationErrors.join("; ")}`);
  }

  if (!config.pineconeApiKey) {
    throw new Error("PINECONE_API_KEY is required for vector indexing");
  }

  if (!config.pineconeIndexName) {
    throw new Error("PINECONE_INDEX_NAME is required");
  }

  return {
    apiKey: config.pineconeApiKey,
    indexName: config.pineconeIndexName,
    indexHost: config.pineconeIndexHost,
    namespacePrefix: config.pineconeNamespacePrefix,
  };
}
