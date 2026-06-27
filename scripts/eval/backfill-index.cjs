/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * One-time RAG backfill for already-processed documents.
 *
 * WHY THIS EXISTS (root cause, confirmed against the live DB + code):
 *   The chat retrieval paths -- BOTH vector_retrieval (vector-retrieval.ts) and
 *   the local_retrieval_fallback (persisted-base-document-retrieval.ts) -- read
 *   ONLY from `DocumentRetrievalChunk`, gated on a current READY_FOR_INDEXING
 *   `DocumentBaseArtifact` (parserVersion=textract-base-v1,
 *   featureSet=FORMS,LAYOUT,TABLES, chunkStrategy=base-document-structure-v1)
 *   plus an ACTIVE `DocumentVectorIndex`. They NEVER read the legacy
 *   `DocumentChunk` table.
 *
 *   The COMPLETED docs in this dev DB were processed by the synchronous
 *   `processDocument` path (document-pipeline.ts), which writes ONLY
 *   `DocumentChunk` rows + marks COMPLETED. They have NO DocumentRetrievalChunk
 *   rows and NO base artifact at all -- not merely "missing Pinecone vectors".
 *   So calling indexDocumentVectors() directly throws "No current retrieval
 *   chunks are ready for vector indexing", and retrieval returns nothing
 *   (universal insufficient_evidence -> over-refusal).
 *
 * WHAT THIS SCRIPT DOES:
 *   For each COMPLETED document, if the base-document/retrieval-chunk layer is
 *   missing, it MATERIALIZES it from the REAL already-extracted DocumentChunk
 *   text (content + page number are real; structural metadata -- contentType,
 *   single-page spans, synthetic sourceBlockIds -- is scaffolding required by
 *   the schema), then calls the PRODUCTION `indexDocumentVectors(...)` to embed
 *   (OpenAI) + upsert (Pinecone) + record the ACTIVE DocumentVectorIndex in the
 *   SAME index/namespace the chat retrieval reads. Embedding/upsert is NOT
 *   hand-rolled -- it reuses production code verbatim.
 *
 * Idempotent: base artifact is upserted; retrieval chunks use deterministic ids
 * with skipDuplicates; indexDocumentVectors upserts the vector index and
 * replaces vectors. Re-running is safe.
 *
 * Run:  node scripts/eval/backfill-index.cjs
 * Does NOT modify application code. Only reads/writes DB rows + Pinecone.
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");

require("dotenv").config({ path: path.join(ROOT, ".env") });
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    esModuleInterop: true,
    target: "ES2019",
    skipLibCheck: true,
  },
});
require("tsconfig-paths").register({
  baseUrl: ROOT,
  paths: { "@/*": ["src/*"] },
});

// --- production code (reused verbatim) ---
const { prisma } = require(path.join(ROOT, "src/lib/prisma.ts"));
const { indexDocumentVectors } = require(path.join(ROOT, "src/lib/vector/vector-indexing.ts"));
const { readM3ProviderConfig } = require(path.join(ROOT, "src/lib/ai/config.ts"));
const { TEXTRACT_BASE_DOCUMENT_PARSER_VERSION } = require(path.join(ROOT, "src/lib/textract-normalizer.ts"));
const { DEFAULT_CHUNK_STRATEGY } = require(path.join(ROOT, "src/lib/base-document-chunker.ts"));
const {
  DocumentArtifactSourceMode,
  DocumentBaseArtifactStatus,
  DocumentRetrievalContentType,
} = require("@prisma/client");

// Defaults must EXACTLY match what indexDocumentVectors + the retrieval gate use.
const PARSER_VERSION = TEXTRACT_BASE_DOCUMENT_PARSER_VERSION; // "textract-base-v1"
const CHUNK_STRATEGY = DEFAULT_CHUNK_STRATEGY; // "base-document-structure-v1"
const FEATURE_SET = ["FORMS", "TABLES", "LAYOUT"]; // passed to indexer
const FEATURE_SET_KEY = [...FEATURE_SET].sort().join(","); // "FORMS,LAYOUT,TABLES" (stored)
const GENERATION = 1;

function log(...a) {
  console.log(...a);
}

/**
 * Ensure a current READY_FOR_INDEXING base artifact + DocumentRetrievalChunk
 * rows exist for `doc`. Returns { mode, chunksConsidered, chunksCreated,
 * baseArtifactId }. If the layer already exists (e.g. a doc that came through
 * the Textract path), it is reused untouched.
 */
async function ensureRetrievalLayer(doc) {
  const existingArtifact = await prisma.documentBaseArtifact.findFirst({
    where: {
      documentId: doc.id,
      firmId: doc.firmId,
      parserVersion: PARSER_VERSION,
      featureSet: FEATURE_SET_KEY,
      generation: GENERATION,
      isCurrent: true,
      status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
    },
    select: { id: true },
  });
  if (existingArtifact) {
    const rc = await prisma.documentRetrievalChunk.count({
      where: {
        documentId: doc.id,
        baseArtifactId: existingArtifact.id,
        parserVersion: PARSER_VERSION,
        chunkStrategy: CHUNK_STRATEGY,
      },
    });
    if (rc > 0) {
      return {
        mode: "reused-existing-layer",
        chunksConsidered: rc,
        chunksCreated: 0,
        baseArtifactId: existingArtifact.id,
      };
    }
  }

  // Materialize from the real extracted DocumentChunk text.
  const docChunks = await prisma.documentChunk.findMany({
    where: { documentId: doc.id },
    select: { content: true, pageNumber: true, chunkIndex: true },
    orderBy: { chunkIndex: "asc" },
  });
  const usable = docChunks.filter((c) => c.content && c.content.trim().length > 0);
  if (usable.length === 0) {
    throw new Error(
      `no usable DocumentChunk text (docChunks=${docChunks.length}); nothing to index`
    );
  }

  // Upsert the base artifact (idempotent on the composite unique key).
  const artifact = await prisma.documentBaseArtifact.upsert({
    where: {
      documentId_parserVersion_featureSet_generation: {
        documentId: doc.id,
        parserVersion: PARSER_VERSION,
        featureSet: FEATURE_SET_KEY,
        generation: GENERATION,
      },
    },
    create: {
      document: { connect: { id: doc.id } },
      firm: { connect: { id: doc.firmId } },
      provider: "eval-backfill-from-document-chunks",
      sourceMode: DocumentArtifactSourceMode.BASE_DOCUMENT_JSON,
      featureSet: FEATURE_SET_KEY,
      parserVersion: PARSER_VERSION,
      generation: GENERATION,
      isCurrent: true,
      status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
      completedAt: new Date(),
    },
    update: {
      isCurrent: true,
      status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
    },
    select: { id: true },
  });

  const rows = usable.map((c) => {
    const page = Math.max(1, c.pageNumber || 1);
    return {
      id: `${doc.id}_bf_${c.chunkIndex}`,
      documentId: doc.id,
      firmId: doc.firmId,
      baseArtifactId: artifact.id,
      vectorGeneration: GENERATION,
      content: c.content,
      contentType: DocumentRetrievalContentType.PROSE,
      pageStart: page,
      pageEnd: page,
      formType: null,
      sectionPath: null,
      tableId: null,
      sourceBlockIds: [`${doc.id}_blk_${c.chunkIndex}`],
      parserVersion: PARSER_VERSION,
      chunkStrategy: CHUNK_STRATEGY,
    };
  });
  const created = await prisma.documentRetrievalChunk.createMany({
    data: rows,
    skipDuplicates: true,
  });

  return {
    mode: "materialized-from-document-chunks",
    chunksConsidered: docChunks.length,
    chunksCreated: created.count,
    baseArtifactId: artifact.id,
  };
}

async function main() {
  const config = readM3ProviderConfig();
  if (config.validationErrors.length > 0) {
    throw new Error(`Invalid provider config: ${config.validationErrors.join("; ")}`);
  }
  if (!config.vectorIndexingEnabled) {
    throw new Error("ENABLE_VECTOR_INDEXING must be true");
  }
  log(
    `Config OK: model=${config.aiModel} embed=${config.embeddingModel}/${config.embeddingDimension} ` +
      `pineconeIndex=${config.pineconeIndexName} nsPrefix=${config.pineconeNamespacePrefix} ` +
      `parserVersion=${PARSER_VERSION} chunkStrategy=${CHUNK_STRATEGY} featureSet=${FEATURE_SET_KEY}`
  );

  const completed = await prisma.document.findMany({
    where: { status: "COMPLETED" },
    select: { id: true, firmId: true, originalName: true, pageCount: true },
    orderBy: { createdAt: "asc" },
  });
  log(`Found ${completed.length} COMPLETED documents.\n`);

  const report = [];
  let docsIndexed = 0;
  let docsFailed = 0;
  let totalVectors = 0;

  for (const doc of completed) {
    const label = `${doc.id} "${doc.originalName}" (${doc.pageCount}p)`;
    try {
      const layer = await ensureRetrievalLayer(doc);
      const result = await indexDocumentVectors({
        firmId: doc.firmId,
        documentId: doc.id,
        parserVersion: PARSER_VERSION,
        featureSet: FEATURE_SET,
        chunkStrategy: CHUNK_STRATEGY,
        config,
      });
      docsIndexed += 1;
      totalVectors += result.chunkCount;
      log(
        `[OK] ${label}\n` +
          `     layer=${layer.mode} chunksCreated=${layer.chunksCreated} ` +
          `embedded=${result.chunkCount} vectorsUpserted=${result.chunkCount} ` +
          `model=${result.embeddingModel} dim=${result.embeddingDimension}\n` +
          `     namespace=${result.namespace} index=${result.indexName} ` +
          `vectorIndexId=${result.vectorIndexId} gen=${result.generation} status=${result.status}`
      );
      report.push({
        documentId: doc.id,
        originalName: doc.originalName,
        pageCount: doc.pageCount,
        firmId: doc.firmId,
        ok: true,
        layerMode: layer.mode,
        chunksConsidered: layer.chunksConsidered,
        chunksCreated: layer.chunksCreated,
        chunksEmbedded: result.chunkCount,
        vectorsUpserted: result.chunkCount,
        embeddingModel: result.embeddingModel,
        embeddingDimension: result.embeddingDimension,
        indexName: result.indexName,
        namespace: result.namespace,
        vectorIndexId: result.vectorIndexId,
        generation: result.generation,
      });
    } catch (err) {
      docsFailed += 1;
      const msg = err && err.message ? err.message : String(err);
      log(`[FAIL] ${label}\n       ${msg}`);
      report.push({
        documentId: doc.id,
        originalName: doc.originalName,
        firmId: doc.firmId,
        ok: false,
        error: msg,
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    pineconeIndex: config.pineconeIndexName,
    namespacePrefix: config.pineconeNamespacePrefix,
    embeddingModel: config.embeddingModel,
    embeddingDimension: config.embeddingDimension,
    parserVersion: PARSER_VERSION,
    chunkStrategy: CHUNK_STRATEGY,
    featureSet: FEATURE_SET_KEY,
    documentsCompleted: completed.length,
    documentsIndexed: docsIndexed,
    documentsFailed: docsFailed,
    totalVectorsUpserted: totalVectors,
    documents: report,
  };
  const outPath = path.join(__dirname, "backfill-report.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  log("\n================ BACKFILL SUMMARY ================");
  log(`docs COMPLETED=${completed.length} indexed=${docsIndexed} failed=${docsFailed}`);
  log(`total vectors upserted=${totalVectors}`);
  log(`Pinecone index=${config.pineconeIndexName} nsPrefix=${config.pineconeNamespacePrefix}`);
  log(`Wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error("BACKFILL ERROR", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
