#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const { spawnSync } = require("child_process");
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
  buildLocalRetrievalCorpus,
  createCitation,
  searchLocalRetrievalCorpus,
} = require(path.join(repoRoot, "src/lib/base-document-retrieval.ts"));
const {
  buildGroundedLocalAnswer,
} = require(path.join(repoRoot, "src/lib/chat-contract.ts"));

const MIN_LOCAL_RETRIEVAL_SCORE = 0.25;

const REGRESSION_COMMANDS = [
  ["node", ["scripts/verify-base-document-normalizer.js"]],
  ["node", ["scripts/verify-base-document-retrieval.js"]],
  ["node", ["scripts/verify-persisted-base-document-retrieval.js"]],
  ["node", ["scripts/verify-textract-pipeline.js"]],
  ["node", ["scripts/verify-chat-persistence.js"]],
  ["node", ["scripts/verify-chat-api-boundary.js"]],
  ["node", ["scripts/verify-chat-streaming-contract.js"]],
  ["node", ["scripts/verify-chat-hardening.js"]],
  ["node", ["scripts/verify-chat-output-schema.js"]],
  ["node", ["scripts/verify-m4-structured-output.js"]],
  ["node", ["scripts/verify-vector-provider-config.js"]],
  ["node", ["scripts/verify-vector-indexing.js"]],
  ["node", ["scripts/verify-vector-retrieval.js"]],
  ["node", ["scripts/verify-tenant-context.js"]],
];

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function runRegressionCommands(failures) {
  const results = [];

  for (const [command, args] of REGRESSION_COMMANDS) {
    const result = spawnSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    const label = [command, ...args].join(" ");
    results.push({
      label,
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });

    if (result.status !== 0) {
      failures.push(`regression command failed: ${label}\n${result.stderr || result.stdout}`);
    }
  }

  return results;
}

function createEvalChunks() {
  const base = {
    firmId: "firm_a",
    baseArtifactId: "artifact_eval",
    vectorGeneration: 1,
    parserVersion: "textract-base-v1",
    chunkStrategy: "base-document-structure-v1",
  };

  return [
    {
      ...base,
      chunkId: "eval:firm_a:doc_1040:filing_status",
      documentId: "doc_1040",
      content: "Filing status: Single. Taxpayer name: REDACTED_NAME.",
      contentType: "field_group",
      pageStart: 1,
      pageEnd: 1,
      formType: "Form 1040",
      sectionPath: "page/1/filing-status",
      tableId: null,
      sourceBlockIds: ["kv_filing_status", "value_single"],
    },
    {
      ...base,
      chunkId: "eval:firm_a:doc_schedule_c:net_profit",
      documentId: "doc_schedule_c",
      content: "Schedule C net profit: REDACTED_AMOUNT. Business income section.",
      contentType: "field_group",
      pageStart: 2,
      pageEnd: 2,
      formType: "Schedule C",
      sectionPath: "page/2/income",
      tableId: null,
      sourceBlockIds: ["kv_net_profit", "value_amount"],
    },
    {
      ...base,
      chunkId: "eval:firm_a:doc_schedule_c:expenses",
      documentId: "doc_schedule_c",
      content: "Schedule C car and truck expenses: REDACTED_AMOUNT.",
      contentType: "table",
      pageStart: 3,
      pageEnd: 3,
      formType: "Schedule C",
      sectionPath: "page/3/expenses",
      tableId: "table_expenses",
      sourceBlockIds: ["table_expenses", "cell_car_truck"],
    },
    {
      ...base,
      chunkId: "eval:firm_a:doc_1040:address",
      documentId: "doc_1040",
      content: "Home address: REDACTED_ADDRESS. Filing year: 2025.",
      contentType: "field_group",
      pageStart: 1,
      pageEnd: 1,
      formType: "Form 1040",
      sectionPath: "page/1/address",
      tableId: null,
      sourceBlockIds: ["kv_address", "value_address"],
    },
    {
      ...base,
      chunkId: "eval:firm_a:doc_schedule_c:business_name",
      documentId: "doc_schedule_c",
      content: "Schedule C business name: REDACTED_BUSINESS.",
      contentType: "field_group",
      pageStart: 2,
      pageEnd: 2,
      formType: "Schedule C",
      sectionPath: "page/2/business",
      tableId: null,
      sourceBlockIds: ["kv_business_name", "value_business"],
    },
  ];
}

function evaluateRetrieval(failures) {
  const corpus = buildLocalRetrievalCorpus(createEvalChunks(), "firm_a", 1);
  const cases = [
    {
      id: "filing-status",
      query: "What filing status appears in the return?",
      expectedChunkIds: ["eval:firm_a:doc_1040:filing_status"],
    },
    {
      id: "schedule-c-profit",
      query: "Which Schedule C chunk contains net profit?",
      expectedChunkIds: ["eval:firm_a:doc_schedule_c:net_profit"],
    },
    {
      id: "schedule-c-expenses",
      query: "Where are car and truck expenses shown?",
      expectedChunkIds: ["eval:firm_a:doc_schedule_c:expenses"],
    },
  ];
  const evaluated = [];

  for (const testCase of cases) {
    const results = searchLocalRetrievalCorpus(corpus, testCase.query, {
      topK: 3,
    });
    const resultIds = results.map((result) => result.chunk.chunkId);
    const firstExpectedRank =
      resultIds.findIndex((chunkId) => testCase.expectedChunkIds.includes(chunkId)) + 1;
    const expectedFound = testCase.expectedChunkIds.filter((chunkId) =>
      resultIds.includes(chunkId)
    );
    const recallAtK = expectedFound.length / testCase.expectedChunkIds.length;
    const reciprocalRank = firstExpectedRank > 0 ? 1 / firstExpectedRank : 0;
    const finalResults = results.slice(0, 1);
    const citations = finalResults.map(createCitation);
    const citationCoverage =
      citations.filter((citation) =>
        testCase.expectedChunkIds.includes(citation.chunkId)
      ).length / testCase.expectedChunkIds.length;
    const citationPrecision =
      citations.length === 0
        ? 0
        : citations.filter((citation) => {
            const relevant = testCase.expectedChunkIds.includes(citation.chunkId);
            return (
              relevant &&
              citation.sourceBlockIds.length > 0 &&
              citation.snippet.length > 0
            );
          }).length / citations.length;

    evaluated.push({
      id: testCase.id,
      recallAtK,
      reciprocalRank,
      citationCoverage,
      citationPrecision,
    });

    assertCondition(recallAtK === 1, `${testCase.id} recall@3 below 1.0`, failures);
    assertCondition(
      reciprocalRank === 1,
      `${testCase.id} expected result was not top ranked`,
      failures
    );
    assertCondition(
      citationCoverage === 1,
      `${testCase.id} citation coverage below 1.0`,
      failures
    );
    assertCondition(
      citationPrecision === 1,
      `${testCase.id} citation precision below 1.0`,
      failures
    );
  }

  const unsupportedCases = [
    {
      query: "bank routing number wire transfer",
      question: "What is the bank routing number?",
    },
    {
      query: "bank routing status wire transfer",
      question: "What is the bank routing status?",
    },
    {
      query: "tell me about status",
      question: "Tell me about status",
    },
  ];

  for (const unsupportedCase of unsupportedCases) {
    const unsupportedResults = searchLocalRetrievalCorpus(
      corpus,
      unsupportedCase.query,
      { topK: 3 }
    );
    const supportedUnsupportedResults = unsupportedResults.filter(
      (result) => result.score >= MIN_LOCAL_RETRIEVAL_SCORE
    );
    const unsupportedAnswer = buildGroundedLocalAnswer(
      unsupportedCase.question,
      supportedUnsupportedResults.map((result) => result.snippet)
    );
    assertCondition(
      supportedUnsupportedResults.length === 0,
      `${unsupportedCase.query} should not retrieve supported evidence`,
      failures
    );
    assertCondition(
      unsupportedAnswer.toLowerCase().includes("could not find enough support"),
      `${unsupportedCase.query} should produce insufficient-evidence answer`,
      failures
    );
  }

  const tenantIsolationResults = searchLocalRetrievalCorpus(
    corpus,
    "Filing status single",
    { topK: 3, documentIds: ["doc_other_firm"] }
  );
  assertCondition(
    tenantIsolationResults.length === 0,
    "foreign document filter should fail closed with no results",
    failures
  );

  return evaluated;
}

function summarizeMetrics(evaluated) {
  const mean = (values) =>
    values.reduce((total, value) => total + value, 0) / values.length;

  return {
    recallAt3: mean(evaluated.map((item) => item.recallAtK)),
    mrr: mean(evaluated.map((item) => item.reciprocalRank)),
    citationCoverage: mean(evaluated.map((item) => item.citationCoverage)),
    citationPrecision: mean(evaluated.map((item) => item.citationPrecision)),
  };
}

function main() {
  const failures = [];
  const regressionResults = runRegressionCommands(failures);
  const evaluated = evaluateRetrieval(failures);
  const metrics = summarizeMetrics(evaluated);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("M3 quality gates verified");
  console.log(
    JSON.stringify(
      {
        metrics,
        evaluated,
        regressions: regressionResults.map((result) => ({
          label: result.label,
          status: result.status,
        })),
      },
      null,
      2
    )
  );
}

main();
