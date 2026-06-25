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
  indexDocumentVectors,
} = require(path.join(repoRoot, "src/lib/vector/vector-indexing.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function fakeVector(dimension, seed) {
  return Array.from({ length: dimension }, (_, index) => seed + index / 1000);
}

function createChunk(id, pageStart) {
  return {
    id,
    documentId: "doc_1",
    firmId: "firm_1",
    baseArtifactId: "artifact_1",
    vectorGeneration: 2,
    content: `Chunk ${id} extracted evidence`,
    contentType: "FIELD_GROUP",
    pageStart,
    pageEnd: pageStart,
    formType: "Form 1040",
    sectionPath: `page/${pageStart}`,
    tableId: null,
    sourceBlockIds: [`block_${id}`],
    parserVersion: "textract-base-v1",
    chunkStrategy: "base-document-structure-v1",
    baseArtifact: {
      generation: 2,
      featureSet: "FORMS,LAYOUT,TABLES",
      parserVersion: "textract-base-v1",
      status: "READY_FOR_INDEXING",
      isCurrent: true,
    },
  };
}

function createFakeDb(chunks) {
  const calls = {
    findMany: [],
    upserts: [],
    updates: [],
    updateMany: [],
    transactions: [],
  };
  const db = {
    calls,
    documentRetrievalChunk: {
      findMany: async (args) => {
        calls.findMany.push(args);
        return chunks;
      },
    },
    documentVectorIndex: {
      upsert: async (args) => {
        calls.upserts.push(args);
        return {
          id: "vector_index_1",
          ...args.create,
        };
      },
      updateMany: (args) => {
        calls.updateMany.push(args);
        return Promise.resolve({ count: 1 });
      },
      update: (args) => {
        calls.updates.push(args);
        return Promise.resolve({
          id: args.where.id,
          ...args.data,
        });
      },
    },
    $transaction: async (actions) => {
      calls.transactions.push(actions);
      return Promise.all(actions);
    },
  };

  return db;
}

async function verifyHappyPath(failures) {
  const db = createFakeDb([createChunk("chunk_1", 1), createChunk("chunk_2", 2)]);
  const embeddingCalls = [];
  const vectorCalls = [];
  const embeddingProvider = {
    embedTexts: async (texts, userId) => {
      embeddingCalls.push({ texts, userId });
      return {
        model: "text-embedding-3-small",
        dimensions: 4,
        vectors: texts.map((_, index) => fakeVector(4, index + 1)),
        usage: {
          promptTokens: texts.length,
          totalTokens: texts.length,
        },
      };
    },
  };
  const vectorStore = {
    upsertVectors: async (records) => {
      vectorCalls.push(records);
    },
  };

  const result = await indexDocumentVectors(
    {
      firmId: "firm_1",
      documentId: "doc_1",
      config: {
        aiChatEnabled: false,
        vectorIndexingEnabled: true,
        vectorRetrievalEnabled: false,
        openAiApiKey: "sk-redacted",
        aiModel: "gpt-4o-mini",
        embeddingModel: "text-embedding-3-small",
        embeddingDimension: 4,
        pineconeApiKey: "pc-redacted",
        pineconeIndexName: "trueblue-m3-test",
        pineconeNamespacePrefix: "tb",
        validationErrors: [],
      },
      embeddingProvider,
      vectorStore,
      userId: "user_1",
    },
    db
  );

  assertCondition(result.status === "ACTIVE", "indexing result was not active", failures);
  assertCondition(result.generation === 2, "indexing did not use chunk generation", failures);
  assertCondition(result.namespace === "tb_firm_firm_1", "indexing namespace mismatch", failures);
  assertCondition(db.calls.findMany[0].where.firmId === "firm_1", "retrieval chunk query was not firm scoped", failures);
  assertCondition(db.calls.findMany[0].where.documentId === "doc_1", "retrieval chunk query was not document scoped", failures);
  assertCondition(db.calls.upserts[0].create.status === "BUILDING", "vector inventory did not start BUILDING", failures);
  assertCondition(db.calls.upserts[0].create.isActive === false, "BUILDING vector inventory should not be active", failures);
  assertCondition(embeddingCalls[0].texts.length === 2, "embedding provider did not receive all chunk content", failures);
  assertCondition(embeddingCalls[0].userId === "user_1", "embedding provider did not receive user id", failures);
  assertCondition(vectorCalls[0].length === 2, "vector store did not receive all records", failures);
  assertCondition(!("content" in vectorCalls[0][0].metadata), "vector metadata leaked chunk content", failures);
  assertCondition(db.calls.updateMany[0].data.status === "RETIRED", "old active generation was not retired", failures);
  assertCondition(db.calls.updates.at(-1).data.status === "ACTIVE", "new vector generation was not activated", failures);
  assertCondition(db.calls.updates.at(-1).data.vectorIds.length === 2, "active inventory did not store vector ids", failures);
}

async function verifyFailurePath(failures) {
  const db = createFakeDb([createChunk("chunk_1", 1)]);
  const embeddingProvider = {
    embedTexts: async () => {
      throw new Error("embedding provider failed");
    },
  };
  const vectorStore = {
    upsertVectors: async () => {
      failures.push("vector store should not be called after embedding failure");
    },
  };

  await indexDocumentVectors(
    {
      firmId: "firm_1",
      documentId: "doc_1",
      config: {
        aiChatEnabled: false,
        vectorIndexingEnabled: true,
        vectorRetrievalEnabled: false,
        openAiApiKey: "sk-redacted",
        aiModel: "gpt-4o-mini",
        embeddingModel: "text-embedding-3-small",
        embeddingDimension: 4,
        pineconeApiKey: "pc-redacted",
        pineconeIndexName: "trueblue-m3-test",
        pineconeNamespacePrefix: "tb",
        validationErrors: [],
      },
      embeddingProvider,
      vectorStore,
    },
    db
  ).then(
    () => failures.push("indexing should fail when embedding fails"),
    (error) =>
      assertCondition(
        error instanceof Error && error.message.includes("embedding provider failed"),
        `wrong indexing failure: ${error instanceof Error ? error.message : error}`,
        failures
      )
  );

  assertCondition(db.calls.updates.at(-1).data.status === "FAILED", "failed indexing was not marked FAILED", failures);
  assertCondition(db.calls.updates.at(-1).data.isActive === false, "failed indexing should not be active", failures);
}

async function verifyDisabledGate(failures) {
  const db = createFakeDb([createChunk("chunk_1", 1)]);

  await indexDocumentVectors(
    {
      firmId: "firm_1",
      documentId: "doc_1",
      config: {
        aiChatEnabled: false,
        vectorIndexingEnabled: false,
        vectorRetrievalEnabled: false,
        aiModel: "gpt-4o-mini",
        embeddingModel: "text-embedding-3-small",
        embeddingDimension: 4,
        pineconeNamespacePrefix: "tb",
        validationErrors: [],
      },
      embeddingProvider: {
        embedTexts: async () => {
          failures.push("embedding provider should not be called when disabled");
          return null;
        },
      },
      vectorStore: {
        upsertVectors: async () => {
          failures.push("vector store should not be called when disabled");
        },
      },
    },
    db
  ).then(
    () => failures.push("indexing should not run when vector indexing is disabled"),
    (error) =>
      assertCondition(
        error instanceof Error && error.message.includes("Vector indexing is disabled"),
        `wrong disabled-gate failure: ${error instanceof Error ? error.message : error}`,
        failures
      )
  );

  assertCondition(db.calls.findMany.length === 0, "disabled indexing should not query chunks", failures);
}

async function main() {
  const failures = [];

  await verifyHappyPath(failures);
  await verifyFailurePath(failures);
  await verifyDisabledGate(failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Vector indexing orchestration verified: flags, inventory, activation, failure handling");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
