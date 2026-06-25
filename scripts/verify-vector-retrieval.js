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
  DocumentBaseArtifactStatus,
  DocumentRetrievalContentType,
  DocumentVectorIndexStatus,
} = require("@prisma/client");
const {
  retrieveVectorDocumentChunks,
} = require(path.join(repoRoot, "src/lib/vector/vector-retrieval.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function fakeVector(dimension, seed) {
  return Array.from({ length: dimension }, (_, index) => seed + index / 1000);
}

function createRow(overrides = {}) {
  const documentId = overrides.documentId ?? "doc_1";
  const generation = overrides.vectorGeneration ?? 2;

  return {
    id:
      overrides.id ??
      `firm_1:${documentId}:artifact_1:textract-base-v1:base-document-structure-v1:g${generation}:0`,
    documentId,
    firmId: overrides.firmId ?? "firm_1",
    baseArtifactId: overrides.baseArtifactId ?? "artifact_1",
    vectorGeneration: generation,
    content: overrides.content ?? "Filing status: Single",
    contentType: overrides.contentType ?? DocumentRetrievalContentType.FIELD_GROUP,
    pageStart: overrides.pageStart ?? 1,
    pageEnd: overrides.pageEnd ?? 1,
    formType: overrides.formType ?? "Form 1040",
    sectionPath: overrides.sectionPath ?? "page/1/fields",
    tableId: overrides.tableId ?? null,
    sourceBlockIds: overrides.sourceBlockIds ?? ["field_1", "value_1"],
    parserVersion: overrides.parserVersion ?? "textract-base-v1",
    chunkStrategy: overrides.chunkStrategy ?? "base-document-structure-v1",
    baseArtifact: {
      firmId: overrides.firmId ?? "firm_1",
      generation,
      parserVersion: overrides.parserVersion ?? "textract-base-v1",
      featureSet: "FORMS,LAYOUT,TABLES",
      isCurrent: overrides.isCurrent ?? true,
      status:
        overrides.artifactStatus ?? DocumentBaseArtifactStatus.READY_FOR_INDEXING,
    },
  };
}

function createVectorIndex(row, overrides = {}) {
  return {
    documentId: row.documentId,
    firmId: row.firmId,
    indexName: overrides.indexName ?? "trueblue-m3-staging",
    namespace: overrides.namespace ?? "trueblue_firm_firm_1",
    generation: overrides.generation ?? row.vectorGeneration,
    isActive: overrides.isActive ?? true,
    status: overrides.status ?? DocumentVectorIndexStatus.ACTIVE,
    vectorIds: overrides.vectorIds ?? [row.id],
    chunkIds: overrides.chunkIds ?? [row.id],
  };
}

function createFakeDb(rows, vectorIndexes, calls) {
  return {
    documentRetrievalChunk: {
      findMany: async (args) => {
        calls.chunkQueries.push(args);
        const ids = args.where.id?.in ?? null;
        const documentIds = args.where.documentId?.in ?? null;
        const formTypes = args.where.formType?.in ?? null;
        const pageStart = args.where.pageStart?.gte ?? null;
        const pageEnd = args.where.pageEnd?.lte ?? null;
        const artifact = args.where.baseArtifact;

        return rows
          .filter((row) => !ids || ids.includes(row.id))
          .filter((row) => row.firmId === args.where.firmId)
          .filter((row) => !documentIds || documentIds.includes(row.documentId))
          .filter((row) => !formTypes || formTypes.includes(row.formType))
          .filter((row) => pageStart === null || row.pageStart >= pageStart)
          .filter((row) => pageEnd === null || row.pageEnd <= pageEnd)
          .filter((row) => row.parserVersion === args.where.parserVersion)
          .filter((row) => row.chunkStrategy === args.where.chunkStrategy)
          .filter((row) => row.baseArtifact.firmId === artifact.firmId)
          .filter((row) => row.baseArtifact.isCurrent === artifact.isCurrent)
          .filter((row) => row.baseArtifact.status === artifact.status)
          .filter((row) => row.baseArtifact.parserVersion === artifact.parserVersion)
          .filter((row) => row.baseArtifact.featureSet === artifact.featureSet);
      },
    },
    documentVectorIndex: {
      findMany: async (args) => {
        calls.indexQueries.push(args);
        const documentIds = args.where.documentId?.in ?? null;

        return vectorIndexes
          .filter((row) => row.firmId === args.where.firmId)
          .filter((row) => row.indexName === args.where.indexName)
          .filter((row) => row.namespace === args.where.namespace)
          .filter((row) => row.isActive === args.where.isActive)
          .filter((row) => row.status === args.where.status)
          .filter((row) => !documentIds || documentIds.includes(row.documentId));
      },
    },
  };
}

function providerConfig(overrides = {}) {
  return {
    aiChatEnabled: false,
    vectorIndexingEnabled: true,
    vectorRetrievalEnabled: true,
    vectorMinScore: 0.25,
    openAiApiKey: "sk-redacted",
    aiModel: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 4,
    pineconeApiKey: "pc-redacted",
    pineconeIndexName: "trueblue-m3-staging",
    pineconeIndexHost: "host.pinecone.io",
    pineconeNamespacePrefix: "trueblue",
    validationErrors: [],
    ...overrides,
  };
}

function coverageFor(output, documentId) {
  return output.coverage?.documents.find(
    (documentCoverage) => documentCoverage.documentId === documentId
  );
}

async function verifyHappyPath(failures) {
  const row = createRow();
  const calls = {
    embedding: [],
    vector: [],
    chunkQueries: [],
    indexQueries: [],
  };
  const db = createFakeDb([row], [createVectorIndex(row)], calls);
  const embeddingProvider = {
    embedTexts: async (texts, userId) => {
      calls.embedding.push({ texts, userId });
      return {
        model: "text-embedding-3-small",
        dimensions: 4,
        vectors: [fakeVector(4, 1)],
        usage: {
          promptTokens: 1,
          totalTokens: 1,
        },
      };
    },
  };
  const vectorStore = {
    queryVectors: async (input) => {
      calls.vector.push(input);
      return [
        {
          id: row.id,
          score: 0.91,
          metadata: {
            chunkId: row.id,
            documentId: row.documentId,
            firmId: row.firmId,
            pageStart: row.pageStart,
            pageEnd: row.pageEnd,
            formType: row.formType,
            parserVersion: row.parserVersion,
            chunkStrategy: row.chunkStrategy,
            contentType: "field_group",
          },
        },
      ];
    },
  };

  const output = await retrieveVectorDocumentChunks(
    {
      firmId: "firm_1",
      query: "filing status",
      documentIds: ["doc_1"],
      formTypes: ["Form 1040"],
      pageRange: { start: 1, end: 1 },
      topK: 5,
      config: providerConfig(),
      embeddingProvider,
      vectorStore,
      userId: "user_1",
    },
    db
  );

  assertCondition(output.results.length === 1, "vector retrieval returned no result", failures);
  assertCondition(output.results[0].chunk.content === row.content, "retrieval did not use Postgres chunk content", failures);
  assertCondition(output.results[0].score === 0.91, "retrieval lost vector score", failures);
  assertCondition(output.citations[0]?.sourceBlockIds.length === 2, "citation lost source block ids", failures);
  assertCondition(calls.embedding[0].userId === "user_1", "query embedding lost user id", failures);
  assertCondition(calls.vector.length === 1, "single-document retrieval should issue one vector query", failures);
  assertCondition(calls.vector[0].topK === 5, "single-document retrieval changed vector topK", failures);
  assertCondition(calls.vector[0].includeValues !== true, "test vector call shape should not include values", failures);
  assertCondition(calls.vector[0].filter.firmId.$eq === "firm_1", "vector query filter is not firm-scoped", failures);
  assertCondition(calls.vector[0].filter.documentId.$in[0] === "doc_1", "vector query filter is not document-scoped", failures);
  assertCondition(output.coverage?.selectedDocumentIds[0] === "doc_1", "coverage metadata lost single selected document", failures);
  assertCondition(coverageFor(output, "doc_1")?.supportedResultCount === 1, "coverage metadata did not mark supported single-doc result", failures);
  assertCondition(calls.chunkQueries[0].where.firmId === "firm_1", "chunk query is not firm-scoped", failures);
  assertCondition(calls.indexQueries[0].where.namespace === "trueblue_firm_firm_1", "active index query used wrong namespace", failures);
}

async function verifyMultiDocumentStratifiedQueries(failures) {
  const rows = [
    createRow({
      id: "firm_1:doc_a:artifact_1:textract-base-v1:base-document-structure-v1:g2:0",
      documentId: "doc_a",
      content: "Taxpayer name: Alpha Applicant",
    }),
    createRow({
      id: "firm_1:doc_b:artifact_1:textract-base-v1:base-document-structure-v1:g2:0",
      documentId: "doc_b",
      content: "Taxpayer name: Beta Borrower",
    }),
    createRow({
      id: "firm_1:doc_c:artifact_1:textract-base-v1:base-document-structure-v1:g2:0",
      documentId: "doc_c",
      content: "Taxpayer name: Gamma Grantor",
    }),
  ];
  const calls = {
    embedding: [],
    vector: [],
    chunkQueries: [],
    indexQueries: [],
  };
  const db = createFakeDb(
    rows,
    rows.map((row) => createVectorIndex(row)),
    calls
  );
  const embeddingProvider = {
    embedTexts: async () => ({
      model: "text-embedding-3-small",
      dimensions: 4,
      vectors: [fakeVector(4, 4)],
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };
  const vectorStore = {
    queryVectors: async (input) => {
      calls.vector.push(input);
      const documentId = input.filter.documentId.$in[0];
      const row = rows.find((candidate) => candidate.documentId === documentId);
      return row
        ? [
            {
              id: row.id,
              score: documentId === "doc_a" ? 0.95 : documentId === "doc_b" ? 0.72 : 0.51,
            },
          ]
        : [];
    },
  };

  const output = await retrieveVectorDocumentChunks(
    {
      firmId: "firm_1",
      query: "For each selected return, what taxpayer name is shown?",
      documentIds: ["doc_a", "doc_b", "doc_c"],
      topK: 3,
      config: providerConfig(),
      embeddingProvider,
      vectorStore,
    },
    db
  );

  assertCondition(calls.vector.length === 3, "multi-document retrieval should issue one vector query per selected document", failures);
  assertCondition(
    calls.vector.map((call) => call.filter.documentId.$in.join(",")).join("|") === "doc_a|doc_b|doc_c",
    "multi-document vector queries were not individually document-scoped in selection order",
    failures
  );
  assertCondition(
    output.results.map((result) => result.chunk.documentId).join("|") === "doc_a|doc_b|doc_c",
    "stratified retrieval did not preserve one result per selected document",
    failures
  );
  assertCondition(
    output.citations.map((citation) => citation.documentId).join("|") === "doc_a|doc_b|doc_c",
    "stratified retrieval citations did not preserve selected-document coverage",
    failures
  );
}

async function verifyPerDocumentThresholdCoverage(failures) {
  const supportedRow = createRow({
    id: "firm_1:doc_supported:artifact_1:textract-base-v1:base-document-structure-v1:g2:0",
    documentId: "doc_supported",
    content: "Filing status: Single",
  });
  const lowScoreRow = createRow({
    id: "firm_1:doc_low:artifact_1:textract-base-v1:base-document-structure-v1:g2:0",
    documentId: "doc_low",
    content: "Filing status: Married filing jointly",
  });
  const calls = {
    embedding: [],
    vector: [],
    chunkQueries: [],
    indexQueries: [],
  };
  const db = createFakeDb(
    [supportedRow, lowScoreRow],
    [supportedRow, lowScoreRow].map((row) => createVectorIndex(row)),
    calls
  );
  const embeddingProvider = {
    embedTexts: async () => ({
      model: "text-embedding-3-small",
      dimensions: 4,
      vectors: [fakeVector(4, 2)],
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };
  const vectorStore = {
    queryVectors: async (input) => {
      calls.vector.push(input);
      const documentId = input.filter.documentId.$in[0];
      if (documentId === "doc_supported") {
        return [{ id: supportedRow.id, score: 0.89 }];
      }
      if (documentId === "doc_low") {
        return [{ id: lowScoreRow.id, score: 0.12 }];
      }
      return [];
    },
  };

  const output = await retrieveVectorDocumentChunks(
    {
      firmId: "firm_1",
      query: "Compare filing status across selected returns",
      documentIds: ["doc_supported", "doc_low", "doc_missing"],
      topK: 6,
      config: providerConfig({ vectorMinScore: 0.25 }),
      embeddingProvider,
      vectorStore,
    },
    db
  );
  const supportedCoverage = coverageFor(output, "doc_supported");
  const lowScoreCoverage = coverageFor(output, "doc_low");
  const missingCoverage = coverageFor(output, "doc_missing");

  assertCondition(output.results.length === 2, "retrieval should preserve raw low-score results for existing chat-route thresholding", failures);
  assertCondition(output.coverage?.scoreThreshold === 0.25, "coverage metadata lost configured vector score threshold", failures);
  assertCondition(supportedCoverage?.supportedResultCount === 1, "coverage metadata did not count supported per-document result", failures);
  assertCondition(lowScoreCoverage?.resultCount === 1, "coverage metadata lost low-score document result", failures);
  assertCondition(lowScoreCoverage?.supportedResultCount === 0, "coverage metadata should not mark low-score document as supported", failures);
  assertCondition(lowScoreCoverage?.topScore === 0.12, "coverage metadata lost low-score top score", failures);
  assertCondition(missingCoverage?.vectorMatchCount === 0, "coverage metadata did not preserve missing selected document", failures);
  assertCondition(missingCoverage?.resultCount === 0, "coverage metadata should report zero results for missing selected document", failures);
}

async function verifyFailClosedCases(failures) {
  const row = createRow();
  const staleRow = createRow({
    id: "firm_1:doc_1:artifact_1:textract-base-v1:base-document-structure-v1:g1:0",
    vectorGeneration: 1,
  });
  const corruptedRow = createRow({
    id: "firm_1:doc_2:artifact_1:textract-base-v1:base-document-structure-v1:g2:0",
    documentId: "doc_2",
    sourceBlockIds: [],
  });
  const calls = {
    embedding: [],
    vector: [],
    chunkQueries: [],
    indexQueries: [],
  };
  const db = createFakeDb(
    [row, staleRow, corruptedRow],
    [createVectorIndex(row)],
    calls
  );
  const embeddingProvider = {
    embedTexts: async () => ({
      model: "text-embedding-3-small",
      dimensions: 4,
      vectors: [fakeVector(4, 1)],
      usage: { promptTokens: 1, totalTokens: 1 },
    }),
  };
  const vectorStore = {
    queryVectors: async () => [
      { id: row.id, score: 0.9 },
      { id: staleRow.id, score: 0.89 },
      { id: corruptedRow.id, score: 0.88 },
      { id: "missing_chunk", score: 0.87 },
    ],
  };

  const output = await retrieveVectorDocumentChunks(
    {
      firmId: "firm_1",
      query: "filing status",
      config: providerConfig(),
      embeddingProvider,
      vectorStore,
    },
    db
  );

  assertCondition(output.results.length === 1, "retrieval should keep only active valid chunks", failures);
  assertCondition(output.results[0].chunk.chunkId === row.id, "retrieval kept the wrong chunk", failures);
  assertCondition(
    output.warnings.some((warning) => warning.includes("missing_chunk")),
    "missing vector match warning not surfaced",
    failures
  );
  assertCondition(
    output.warnings.some((warning) => warning.includes("not backed by an active vector generation")),
    "stale generation warning not surfaced",
    failures
  );
  assertCondition(
    output.warnings.some((warning) => warning.includes("invalid sourceBlockIds")),
    "invalid sourceBlockIds warning not surfaced",
    failures
  );
}

async function verifyDisabledAndEmptyFilters(failures) {
  const row = createRow();
  const calls = {
    embedding: [],
    vector: [],
    chunkQueries: [],
    indexQueries: [],
  };
  const db = createFakeDb([row], [createVectorIndex(row)], calls);
  const embeddingProvider = {
    embedTexts: async () => {
      calls.embedding.push(true);
      return {
        model: "text-embedding-3-small",
        dimensions: 4,
        vectors: [fakeVector(4, 1)],
        usage: { promptTokens: 1, totalTokens: 1 },
      };
    },
  };
  const vectorStore = {
    queryVectors: async () => {
      calls.vector.push(true);
      return [];
    },
  };

  await retrieveVectorDocumentChunks(
    {
      firmId: "firm_1",
      query: "filing status",
      config: providerConfig({ vectorIndexingEnabled: false, vectorRetrievalEnabled: false }),
      embeddingProvider,
      vectorStore,
    },
    db
  ).then(
    () => failures.push("disabled vector retrieval should fail closed"),
    (error) =>
      assertCondition(
        error instanceof Error && error.message.includes("Vector retrieval is disabled"),
        `wrong disabled error: ${error instanceof Error ? error.message : error}`,
        failures
      )
  );

  const emptyFilterOutput = await retrieveVectorDocumentChunks(
    {
      firmId: "firm_1",
      query: "filing status",
      documentIds: [],
      config: providerConfig(),
      embeddingProvider,
      vectorStore,
    },
    db
  );

  assertCondition(emptyFilterOutput.results.length === 0, "empty document filter should return no results", failures);
  assertCondition(calls.embedding.length === 0, "empty/disabled path should not call embeddings", failures);
  assertCondition(calls.vector.length === 0, "empty/disabled path should not call Pinecone", failures);
}

async function main() {
  const failures = [];

  await verifyHappyPath(failures);
  await verifyMultiDocumentStratifiedQueries(failures);
  await verifyPerDocumentThresholdCoverage(failures);
  await verifyFailClosedCases(failures);
  await verifyDisabledAndEmptyFilters(failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Vector retrieval verified: filters, canonical chunks, active generations, stratified multi-source retrieval, threshold coverage, fail-closed paths");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
