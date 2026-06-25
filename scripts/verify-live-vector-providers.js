#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
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

function loadEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    process.env[key] = value;
  }
}

const {
  OpenAIEmbeddingProvider,
} = require(path.join(repoRoot, "src/lib/ai/embedding-provider.ts"));
const {
  PineconeVectorStore,
  getPineconeFirmNamespace,
} = require(path.join(repoRoot, "src/lib/vector/pinecone.ts"));

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function main() {
  loadEnv();

  const apiKey = requireEnv("OPENAI_API_KEY");
  const pineconeApiKey = requireEnv("PINECONE_API_KEY");
  const indexName = requireEnv("PINECONE_INDEX_NAME");
  const indexHost = process.env.PINECONE_INDEX_HOST?.trim() || undefined;
  const embeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const dimension = Number(process.env.EMBEDDING_DIMENSION || "1536");
  const namespacePrefix = process.env.PINECONE_NAMESPACE_PREFIX || "trueblue";
  const namespace = getPineconeFirmNamespace("live_smoke", namespacePrefix);
  const vectorId = `live-smoke-${Date.now()}`;
  const text = "Synthetic live provider smoke for TrueBlue vector retrieval.";
  const embeddingProvider = new OpenAIEmbeddingProvider({
    apiKey,
    model: embeddingModel,
    dimension,
    batchSize: 1,
  });
  const vectorStore = new PineconeVectorStore({
    apiKey: pineconeApiKey,
    indexName,
    indexHost,
    namespace,
    dimension,
  });

  const embedding = await embeddingProvider.embedTexts([text], "live_smoke");
  const vector = embedding.vectors[0];
  await vectorStore.upsertVectors([
    {
      id: vectorId,
      values: vector,
      metadata: {
        chunkId: vectorId,
        documentId: "live_smoke_document",
        firmId: "live_smoke",
        pageStart: 1,
        pageEnd: 1,
        formType: "Smoke Test",
        parserVersion: "live-smoke-v1",
        chunkStrategy: "synthetic-smoke-v1",
        contentType: "prose",
      },
    },
  ]);

  const matches = await vectorStore.queryVectors({
    vector,
    topK: 3,
    filter: {
      firmId: { $eq: "live_smoke" },
      documentId: { $eq: "live_smoke_document" },
      parserVersion: { $eq: "live-smoke-v1" },
    },
  });
  const found = matches.some((match) => match.id === vectorId);

  await vectorStore.deleteVectorsByIds([vectorId]);

  if (!found) {
    throw new Error("Live Pinecone query did not return the synthetic vector");
  }

  console.log(
    JSON.stringify(
      {
        openai: {
          model: embedding.model,
          dimension: embedding.dimensions,
          vectorCount: embedding.vectors.length,
        },
        pinecone: {
          indexName,
          namespace,
          upserted: 1,
          queried: matches.length,
          deleted: 1,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`LIVE_VECTOR_PROVIDER_SMOKE_FAILED ${error?.message || error}`);
  process.exitCode = 1;
});
