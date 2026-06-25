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
  StructuredChatOutputV1Schema,
  SourceCitationV1Schema,
  EvidenceCoverageV1Schema,
  CHAT_OUTPUT_SCHEMA_VERSION,
} = require(path.join(repoRoot, "src/lib/chat-output-schema.ts"));
const {
  DEFAULT_CHAT_OUTPUT_TEMPLATE,
  getChatOutputTemplate,
  normalizeOutputTemplateSelection,
} = require(path.join(repoRoot, "src/lib/chat-output-templates.ts"));
const {
  buildStructuredChatOutputV1,
} = require(path.join(repoRoot, "src/lib/chat-output-builder.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function assertThrows(fn, message, failures) {
  try {
    fn();
    failures.push(message);
  } catch {
    // expected
  }
}

function answeredFixture(overrides = {}) {
  return {
    threadId: "thread_schema",
    messageId: "message_schema",
    requestKey: "req_schema:assistant:abc",
    answer: "Filing status is Single [S1].",
    citations: [
      {
        marker: "[S1]",
        rank: 1,
        chunkId: "chunk_schema",
        documentId: "doc_schema",
        filename: "return.pdf",
        pageStart: 1,
        pageEnd: 1,
        snippet: "Filing status: Single",
        snippetFull: "Filing status: Single\nTaxpayer: Example",
        sourceBlockIds: ["field_filing_status", "value_single"],
        formType: "Form 1040",
        contentType: "field_group",
        sectionPath: "page/1/fields",
        tableId: "table_1",
        relevanceScore: 0.93,
      },
    ],
    coverage: {
      version: 1,
      selectedDocumentIds: ["doc_schema"],
      retrievedByDocumentId: { doc_schema: 1 },
      finalByDocumentId: { doc_schema: 1 },
      noEvidenceDocumentIds: [],
    },
    retrievalWarnings: [],
    mode: "vector_retrieval",
    model: "local-grounded-vector-retrieval-v0",
    inputTokens: 12,
    outputTokens: 7,
    responseMode: "rag_qa",
    outputTemplate: normalizeOutputTemplateSelection({
      templateId: "rag_qa.default.v1",
    }),
    scoreThreshold: 0.25,
    generatedAt: new Date("2026-06-23T10:00:00.000Z"),
    ...overrides,
  };
}

function main() {
  const failures = [];

  const answered = buildStructuredChatOutputV1(answeredFixture());
  assertCondition(
    answered.schemaVersion === CHAT_OUTPUT_SCHEMA_VERSION &&
      answered.status === "answered" &&
      answered.sources[0].marker === "[S1]" &&
      answered.sources[0].sourceId === "S1" &&
      answered.sources[0].sectionPath === "page/1/fields" &&
      answered.sources[0].tableId === "table_1" &&
      answered.support.scoreThreshold === 0.25 &&
      answered.metadata.generatedAt === "2026-06-23T10:00:00.000Z",
    "valid answered output did not preserve schema, source metadata, threshold, or timestamp",
    failures
  );
  assertCondition(
    StructuredChatOutputV1Schema.safeParse(answered).success,
    "valid answered output did not validate",
    failures
  );

  const insufficient = buildStructuredChatOutputV1(
    answeredFixture({
      answer:
        "I could not find enough support in the uploaded documents to answer that question.",
      citations: [],
      coverage: {
        version: 1,
        selectedDocumentIds: ["doc_schema"],
        retrievedByDocumentId: { doc_schema: 0 },
        finalByDocumentId: { doc_schema: 0 },
        noEvidenceDocumentIds: ["doc_schema"],
      },
      mode: "local_retrieval_fallback",
      statusHint: "insufficient_evidence",
      retrievalWarnings: ["vector retrieval unavailable"],
    })
  );
  assertCondition(
    insufficient.status === "insufficient_evidence" &&
      insufficient.sources.length === 0 &&
      insufficient.warnings.some((warning) => warning.code === "INSUFFICIENT_EVIDENCE") &&
      insufficient.warnings.some((warning) => warning.code === "RETRIEVAL_WARNING"),
    "insufficient evidence output did not carry expected status and warnings",
    failures
  );

  const narrowing = buildStructuredChatOutputV1(
    answeredFixture({
      answer: "Please select up to 8 documents.",
      citations: [],
      statusHint: "narrowing_required",
    })
  );
  assertCondition(
    narrowing.status === "narrowing_required" &&
      narrowing.warnings.some((warning) => warning.code === "NARROWING_REQUIRED"),
    "narrowing output did not carry expected warning",
    failures
  );

  const nonDocument = buildStructuredChatOutputV1(
    answeredFixture({
      answer: "Ask a question about the selected documents.",
      citations: [],
      statusHint: "non_document",
    })
  );
  assertCondition(
    nonDocument.status === "non_document" &&
      nonDocument.warnings.some((warning) => warning.code === "NON_DOCUMENT_MESSAGE"),
    "non-document output did not carry expected warning",
    failures
  );

  const compact = buildStructuredChatOutputV1(
    answeredFixture({
      outputTemplate: normalizeOutputTemplateSelection({
        templateId: "rag_qa.compact.v1",
      }),
    })
  );
  assertCondition(
    compact.templateId === "rag_qa.compact.v1" &&
      compact.sources[0].snippet === "Filing status: Single" &&
      compact.sources[0].snippetFull === undefined,
    "compact template did not keep snippet and omit snippetFull",
    failures
  );
  const compactManySources = buildStructuredChatOutputV1(
    answeredFixture({
      answer: Array.from({ length: 10 }, (_, index) => `[S${index + 1}]`).join(" "),
      citations: Array.from({ length: 10 }, (_, index) => ({
        marker: `[S${index + 1}]`,
        rank: index + 1,
        chunkId: `chunk_${index + 1}`,
        documentId: "doc_schema",
        filename: "return.pdf",
        pageStart: 1,
        pageEnd: 1,
        snippet: `Snippet ${index + 1}`,
        snippetFull: `Snippet ${index + 1} full text`,
        sourceBlockIds: [`block_${index + 1}`],
      })),
      coverage: {
        version: 1,
        selectedDocumentIds: ["doc_schema"],
        retrievedByDocumentId: { doc_schema: 10 },
        finalByDocumentId: { doc_schema: 10 },
        noEvidenceDocumentIds: [],
      },
      outputTemplate: normalizeOutputTemplateSelection({
        templateId: "rag_qa.compact.v1",
      }),
    })
  );
  assertCondition(
    compactManySources.sources.length === 8 &&
      compactManySources.support.sourceCount === 8 &&
      compactManySources.sources.every((source) => source.snippetFull === undefined),
    "compact template did not enforce maxSources while preserving compact source shape",
    failures
  );

  const partial = buildStructuredChatOutputV1(
    answeredFixture({
      answer: "Document A and B had supporting evidence [S1] [S2].",
      citations: [
        {
          marker: "[S1]",
          rank: 1,
          chunkId: "chunk_a",
          documentId: "doc_a",
          pageStart: 1,
          pageEnd: 1,
          snippet: "Document A support",
          sourceBlockIds: ["block_a"],
        },
        {
          marker: "[S2]",
          rank: 2,
          chunkId: "chunk_b",
          documentId: "doc_b",
          pageStart: 1,
          pageEnd: 1,
          snippet: "Document B support",
          sourceBlockIds: ["block_b"],
        },
      ],
      coverage: {
        version: 1,
        selectedDocumentIds: ["doc_a", "doc_b", "doc_c"],
        retrievedByDocumentId: { doc_a: 1, doc_b: 1, doc_c: 1 },
        finalByDocumentId: { doc_a: 1, doc_b: 1, doc_c: 0 },
        noEvidenceDocumentIds: ["doc_c"],
      },
    })
  );
  assertCondition(
    partial.support.confidenceLabel === "low" &&
      partial.warnings.some((warning) => warning.code === "PARTIAL_SOURCE_COVERAGE"),
    "partial source coverage did not lower confidence and emit warning",
    failures
  );

  const noThreshold = buildStructuredChatOutputV1(
    answeredFixture({ scoreThreshold: undefined })
  );
  assertCondition(
    noThreshold.support.scoreThreshold === undefined &&
      noThreshold.support.confidenceLabel === "medium",
    "builder inferred vector threshold confidence when threshold was omitted",
    failures
  );

  assertCondition(
    getChatOutputTemplate().templateId === DEFAULT_CHAT_OUTPUT_TEMPLATE.templateId,
    "default template lookup failed",
    failures
  );
  assertCondition(
    getChatOutputTemplate("rag_qa.compact.v1").templateId === "rag_qa.compact.v1",
    "compact template lookup failed",
    failures
  );
  assertThrows(
    () => getChatOutputTemplate("unknown.template.v1"),
    "unknown template lookup did not fail",
    failures
  );
  assertCondition(
    JSON.stringify(normalizeOutputTemplateSelection({ templateId: "rag_qa.default.v1" })) ===
      JSON.stringify({ templateId: "rag_qa.default.v1", templateVersion: 1 }),
    "normalized template selection was not deterministic",
    failures
  );

  assertThrows(
    () => StructuredChatOutputV1Schema.parse({ ...answered, schemaVersion: undefined }),
    "missing schemaVersion did not fail validation",
    failures
  );
  assertThrows(
    () => StructuredChatOutputV1Schema.parse({ ...answered, status: "bad_status" }),
    "unknown status did not fail validation",
    failures
  );
  assertThrows(
    () =>
      SourceCitationV1Schema.parse({
        ...answered.sources[0],
        marker: "[S2]",
      }),
    "marker/sourceId mismatch did not fail validation",
    failures
  );
  assertThrows(
    () =>
      SourceCitationV1Schema.parse({
        ...answered.sources[0],
        snippet: "",
      }),
    "empty source snippet did not fail validation",
    failures
  );
  assertThrows(
    () =>
      EvidenceCoverageV1Schema.parse({
        version: 1,
        selectedDocumentIds: ["doc_a"],
        retrievedByDocumentId: { doc_a: 1 },
        finalByDocumentId: { doc_a: -1 },
        noEvidenceDocumentIds: [],
      }),
    "negative coverage count did not fail validation",
    failures
  );
  assertThrows(
    () =>
      EvidenceCoverageV1Schema.parse({
        version: 1,
        selectedDocumentIds: ["doc_a"],
        finalByDocumentId: { doc_a: 1 },
        noEvidenceDocumentIds: [],
      }),
    "missing retrievedByDocumentId did not fail validation",
    failures
  );
  assertThrows(
    () =>
      EvidenceCoverageV1Schema.parse({
        version: 1,
        selectedDocumentIds: ["doc_a", "doc_b"],
        retrievedByDocumentId: { doc_a: 1, doc_b: 0 },
        finalByDocumentId: { doc_a: 1 },
        noEvidenceDocumentIds: ["doc_b"],
      }),
    "coverage missing a selected finalByDocumentId key did not fail validation",
    failures
  );
  assertThrows(
    () =>
      EvidenceCoverageV1Schema.parse({
        version: 1,
        selectedDocumentIds: ["doc_a", "doc_b"],
        retrievedByDocumentId: { doc_a: 1 },
        finalByDocumentId: { doc_a: 1, doc_b: 0 },
        noEvidenceDocumentIds: ["doc_b"],
      }),
    "coverage missing a selected retrievedByDocumentId key did not fail validation",
    failures
  );
  assertThrows(
    () =>
      EvidenceCoverageV1Schema.parse({
        version: 1,
        selectedDocumentIds: ["doc_a"],
        retrievedByDocumentId: { doc_a: 1, doc_unselected: 1 },
        finalByDocumentId: { doc_a: 1 },
        noEvidenceDocumentIds: [],
      }),
    "coverage retrievedByDocumentId with an unselected key did not fail validation",
    failures
  );
  assertThrows(
    () =>
      StructuredChatOutputV1Schema.parse({
        ...answered,
        sources: [{ ...answered.sources[0], documentId: "doc_unselected" }],
      }),
    "source document outside selected coverage did not fail validation",
    failures
  );
  assertThrows(
    () =>
      StructuredChatOutputV1Schema.parse({
        ...answered,
        support: { ...answered.support, sourceCount: 99 },
      }),
    "support.sourceCount mismatch did not fail validation",
    failures
  );
  assertThrows(
    () =>
      StructuredChatOutputV1Schema.parse({
        ...answered,
        support: { ...answered.support, selectedDocumentCount: 99 },
      }),
    "support.selectedDocumentCount mismatch did not fail validation",
    failures
  );
  assertThrows(
    () =>
      StructuredChatOutputV1Schema.parse({
        ...answered,
        support: { ...answered.support, citedDocumentCount: 99 },
      }),
    "support.citedDocumentCount mismatch did not fail validation",
    failures
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Chat output schema verified: schemas, templates, builder");
}

main();
