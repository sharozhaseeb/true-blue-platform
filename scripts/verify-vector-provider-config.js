#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(
  request,
  parent,
  isMain,
  options
) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const tsNode = require(path.join(repoRoot, "node_modules", "ts-node"));
tsNode.register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

const {
  readM3ProviderConfig,
  requireOpenAIEmbeddingConfig,
  requirePineconeConfig,
} = require(path.join(repoRoot, "src/lib/ai/config.ts"));
const {
  OpenAIEmbeddingProvider,
} = require(path.join(repoRoot, "src/lib/ai/embedding-provider.ts"));
const {
  PineconeVectorStore,
  getPineconeFirmNamespace,
} = require(path.join(repoRoot, "src/lib/vector/pinecone.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function assertThrows(callback, expectedText, failures) {
  try {
    callback();
    failures.push(`expected error containing: ${expectedText}`);
  } catch (error) {
    assertCondition(
      error instanceof Error && error.message.includes(expectedText),
      `wrong error for ${expectedText}: ${error instanceof Error ? error.message : error}`,
      failures
    );
  }
}

async function assertRejects(callback, expectedText, failures) {
  try {
    await callback();
    failures.push(`expected rejection containing: ${expectedText}`);
  } catch (error) {
    assertCondition(
      error instanceof Error && error.message.includes(expectedText),
      `wrong rejection for ${expectedText}: ${error instanceof Error ? error.message : error}`,
      failures
    );
  }
}

function fakeVector(dimension, seed) {
  return Array.from({ length: dimension }, (_, index) => seed + index / 1000);
}

async function verifyConfig(failures) {
  const disabledConfig = readM3ProviderConfig({});
  assertCondition(
    disabledConfig.validationErrors.length === 0,
    `disabled config should not require provider secrets: ${disabledConfig.validationErrors.join("; ")}`,
    failures
  );
  assertCondition(
    disabledConfig.aiChatEnabled === false &&
      disabledConfig.vectorIndexingEnabled === false &&
      disabledConfig.vectorRetrievalEnabled === false,
    "provider flags should default off",
    failures
  );

  const enabledMissingSecrets = readM3ProviderConfig({
    ENABLE_AI_CHAT: "true",
    ENABLE_VECTOR_INDEXING: "true",
  });
  assertCondition(
    enabledMissingSecrets.validationErrors.some((error) =>
      error.includes("OPENAI_API_KEY")
    ),
    "enabled config did not require OPENAI_API_KEY",
    failures
  );
  assertCondition(
    enabledMissingSecrets.validationErrors.some((error) =>
      error.includes("PINECONE_API_KEY")
    ),
    "enabled config did not require PINECONE_API_KEY",
    failures
  );
  assertCondition(
    enabledMissingSecrets.validationErrors.some((error) =>
      error.includes("PINECONE_INDEX_NAME")
    ),
    "enabled config did not require a Pinecone index target",
    failures
  );

  const readyConfig = readM3ProviderConfig({
    ENABLE_VECTOR_INDEXING: "true",
    ENABLE_VECTOR_RETRIEVAL: "true",
    OPENAI_API_KEY: "sk-redacted",
    PINECONE_API_KEY: "pc-redacted",
    PINECONE_INDEX_NAME: "trueblue-m3-test",
    PINECONE_NAMESPACE_PREFIX: "tb",
    EMBEDDING_DIMENSION: "4",
  });
  assertCondition(
    readyConfig.validationErrors.length === 0,
    `ready config produced errors: ${readyConfig.validationErrors.join("; ")}`,
    failures
  );
  assertCondition(
    requireOpenAIEmbeddingConfig(readyConfig).dimension === 4,
    "embedding config did not preserve dimension",
    failures
  );
  assertCondition(
    requirePineconeConfig(readyConfig).indexName === "trueblue-m3-test",
    "pinecone config did not preserve index name",
    failures
  );

  assertThrows(
    () =>
      requireOpenAIEmbeddingConfig(
        readM3ProviderConfig({
          OPENAI_API_KEY: "",
        })
      ),
    "OPENAI_API_KEY",
    failures
  );
}

async function verifyEmbeddingProvider(failures) {
  const calls = [];
  const fakeClient = {
    embeddings: {
      create: async (params) => {
        calls.push(params);
        const input = Array.isArray(params.input) ? params.input : [params.input];
        return {
          object: "list",
          model: params.model,
          data: input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: fakeVector(params.dimensions ?? 4, index + 1),
          })),
          usage: {
            prompt_tokens: input.length,
            total_tokens: input.length,
          },
        };
      },
    },
  };

  const provider = new OpenAIEmbeddingProvider({
    apiKey: "sk-redacted",
    model: "text-embedding-3-small",
    dimension: 4,
    batchSize: 2,
    client: fakeClient,
  });
  await assertRejects(
    () => provider.embedTexts([" first ", "", "second"], "user_1"),
    "Embedding text at index 1 is empty",
    failures
  );
  assertCondition(
    calls.length === 0,
    "embedding provider called upstream after empty input validation failed",
    failures
  );

  const result = await provider.embedTexts([" first ", "second", "third"], "user_1");

  assertCondition(result.vectors.length === 3, "embedding provider lost valid text positions", failures);
  assertCondition(result.vectors.every((vector) => vector.length === 4), "embedding dimensions mismatch", failures);
  assertCondition(calls.length === 2, "embedding provider did not batch requests", failures);
  assertCondition(calls[0].dimensions === 4, "embedding provider did not pass custom dimensions", failures);
  assertCondition(calls[0].user === "user_1", "embedding provider did not pass user id", failures);

  await provider.embedTexts(["fourth"]);
}

async function verifyVectorStore(failures) {
  const calls = {
    indexes: [],
    upserts: [],
    queries: [],
    deletes: [],
  };
  const fakeIndex = {
    upsert: async (input) => {
      calls.upserts.push(input);
    },
    query: async (input) => {
      calls.queries.push(input);
      return {
        namespace: "tb_firm_firm_fixture",
        matches: [
          {
            id: "chunk_1",
            score: 0.92,
            metadata: {
              chunkId: "chunk_1",
              documentId: "doc_1",
              firmId: "firm_fixture",
              pageStart: 1,
              pageEnd: 1,
              parserVersion: "parser_v1",
              chunkStrategy: "strategy_v1",
              contentType: "prose",
            },
          },
        ],
      };
    },
    deleteMany: async (input) => {
      calls.deletes.push(input);
    },
  };
  const fakeClient = {
    index: (options) => {
      calls.indexes.push(options);
      return fakeIndex;
    },
  };
  const namespace = getPineconeFirmNamespace("firm_fixture", "tb");
  const store = new PineconeVectorStore({
    apiKey: "pc-redacted",
    indexName: "trueblue-m3-test",
    namespace,
    dimension: 4,
    client: fakeClient,
  });

  await store.upsertVectors([
    {
      id: "chunk_1",
      values: fakeVector(4, 1),
      metadata: {
        chunkId: "chunk_1",
        documentId: "doc_1",
        firmId: "firm_fixture",
        pageStart: 1,
        pageEnd: 1,
        parserVersion: "parser_v1",
        chunkStrategy: "strategy_v1",
        contentType: "prose",
      },
    },
  ]);
  const matches = await store.queryVectors({
    vector: fakeVector(4, 2),
    topK: 3,
    filter: {
      documentId: { $eq: "doc_1" },
    },
  });
  await store.deleteVectorsByIds(["chunk_1", "chunk_1", "chunk_2"]);

  assertCondition(namespace === "tb_firm_firm_fixture", "firm namespace shape changed", failures);
  assertCondition(calls.indexes[0].namespace === namespace, "pinecone namespace was not applied", failures);
  assertCondition(calls.upserts[0].records[0].id === "chunk_1", "upsert lost vector id", failures);
  assertCondition(
    !("content" in calls.upserts[0].records[0].metadata),
    "upsert metadata leaked content",
    failures
  );
  assertCondition(calls.queries[0].includeValues === false, "query should not return vector values", failures);
  assertCondition(calls.queries[0].includeMetadata === true, "query should return metadata", failures);
  assertCondition(matches[0]?.metadata?.chunkId === "chunk_1", "query metadata was not parsed", failures);
  assertCondition(calls.deletes[0].ids.length === 2, "delete should de-duplicate exact vector ids", failures);

  const invalidStore = new PineconeVectorStore({
    apiKey: "pc-redacted",
    indexName: "trueblue-m3-test",
    namespace,
    dimension: 4,
    client: fakeClient,
  });
  await invalidStore
    .upsertVectors([
      {
        id: "bad_chunk",
        values: fakeVector(3, 1),
        metadata: {
          chunkId: "bad_chunk",
          documentId: "doc_1",
          firmId: "firm_fixture",
          pageStart: 1,
          pageEnd: 1,
          parserVersion: "parser_v1",
          chunkStrategy: "strategy_v1",
          contentType: "prose",
        },
      },
    ])
    .then(
      () => failures.push("vector store accepted wrong embedding dimension"),
      (error) =>
        assertCondition(
          error instanceof Error && error.message.includes("dimension mismatch"),
          `wrong dimension error: ${error instanceof Error ? error.message : error}`,
          failures
        )
    );
}

async function main() {
  const failures = [];

  await verifyConfig(failures);
  await verifyEmbeddingProvider(failures);
  await verifyVectorStore(failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Vector provider config verified: env gates, embeddings, Pinecone namespace/upsert/query/delete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
