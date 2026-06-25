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
} = require("@prisma/client");
const {
  retrievePersistedBaseDocumentChunks,
} = require(path.join(repoRoot, "src/lib/persisted-base-document-retrieval.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function createRows() {
    const base = {
      baseArtifactId: "artifact_read_1",
      parserVersion: "textract-base-v1",
      chunkStrategy: "base-document-structure-v1",
    pageStart: 1,
    pageEnd: 1,
    formType: "Form 1040",
    sectionPath: "page/1/fields",
    tableId: null,
      sourceBlockIds: ["field-1", "value-1"],
    };
  const artifact = (firmId, generation, isCurrent = true) => ({
    firmId,
    generation,
    parserVersion: "textract-base-v1",
    featureSet: "FORMS,LAYOUT,TABLES",
    isCurrent,
    status: DocumentBaseArtifactStatus.READY_FOR_INDEXING,
  });

  return [
    {
      ...base,
      id: "firm_a:doc_a:artifact_read_1:textract-base-v1:base-document-structure-v1:g1:0",
      documentId: "doc_a",
      firmId: "firm_a",
      vectorGeneration: 1,
      content: "Filing status: Single",
      contentType: DocumentRetrievalContentType.FIELD_GROUP,
      baseArtifact: artifact("firm_a", 1),
    },
    {
      ...base,
      id: "firm_a:doc_a:artifact_read_1:textract-base-v1:base-document-structure-v1:g2:0",
      documentId: "doc_a",
      firmId: "firm_a",
      vectorGeneration: 2,
      content: "Filing status: Married filing jointly",
      contentType: DocumentRetrievalContentType.FIELD_GROUP,
      baseArtifact: artifact("firm_a", 2, false),
    },
    {
      ...base,
      id: "firm_b:doc_b:artifact_read_2:textract-base-v1:base-document-structure-v1:g1:0",
      documentId: "doc_b",
      firmId: "firm_b",
      vectorGeneration: 1,
      content: "Filing status: Single",
      contentType: DocumentRetrievalContentType.FIELD_GROUP,
      baseArtifact: artifact("firm_b", 1),
    },
    {
      ...base,
      id: "firm_a:doc_c:artifact_read_3:textract-base-v1:base-document-structure-v1:g2:0",
      documentId: "doc_c",
      firmId: "firm_a",
      vectorGeneration: 2,
      content: "Income: REDACTED_AMOUNT",
      contentType: DocumentRetrievalContentType.TABLE,
      baseArtifactId: "artifact_read_3",
      tableId: "table-1",
      sourceBlockIds: ["table-1", "cell-1"],
      baseArtifact: artifact("firm_a", 2),
    },
    {
      ...base,
      id: "firm_a:doc_d:artifact_read_4:textract-base-v1:base-document-structure-v1:g1:0",
      documentId: "doc_d",
      firmId: "firm_a",
      vectorGeneration: 1,
      content: "Hidden corrupted source",
      contentType: DocumentRetrievalContentType.PROSE,
      baseArtifactId: "artifact_read_4",
      sourceBlockIds: [],
      baseArtifact: artifact("firm_a", 1),
    },
    {
      ...base,
      id: "firm_a:doc_g:artifact_read_7:textract-base-v1:base-document-structure-v1:g1:0",
      documentId: "doc_g",
      firmId: "firm_a",
      vectorGeneration: 1,
      content: "Schedule C net profit: REDACTED_AMOUNT",
      contentType: DocumentRetrievalContentType.FIELD_GROUP,
      baseArtifactId: "artifact_read_7",
      pageStart: 2,
      pageEnd: 2,
      formType: "Schedule C",
      sourceBlockIds: ["field-profit", "value-profit"],
      baseArtifact: artifact("firm_a", 1),
    },
    {
      ...base,
      id: "firm_a:doc_e:artifact_read_5:textract-base-v2:base-document-structure-v1:g1:0",
      documentId: "doc_e",
      firmId: "firm_a",
      vectorGeneration: 1,
      content: "Alternate parser filing status: Single",
      contentType: DocumentRetrievalContentType.FIELD_GROUP,
      baseArtifactId: "artifact_read_5",
      parserVersion: "textract-base-v2",
      baseArtifact: {
        ...artifact("firm_a", 1),
        parserVersion: "textract-base-v2",
      },
    },
    {
      ...base,
      id: "firm_a:doc_f:artifact_read_6:textract-base-v1:base-document-structure-v1:g1:0",
      documentId: "doc_f",
      firmId: "firm_a",
      vectorGeneration: 1,
      content: "Partially corrupted source ids",
      contentType: DocumentRetrievalContentType.PROSE,
      baseArtifactId: "artifact_read_6",
      sourceBlockIds: ["valid-block", 123],
      baseArtifact: artifact("firm_a", 1),
    },
  ];
}

function createMockDb(rows, calls) {
  return {
    documentRetrievalChunk: {
      async findMany(args) {
        calls.push(args);
        const documentIds = args.where.documentId?.in ?? null;
        const generation = args.where.vectorGeneration ?? null;
        const artifactFilter = args.where.baseArtifact;
        const formTypes = args.where.formType?.in ?? null;
        const pageStart = args.where.pageStart?.gte ?? null;
        const pageEnd = args.where.pageEnd?.lte ?? null;

        return rows
          .filter((row) => row.firmId === args.where.firmId)
          .filter((row) => generation === null || row.vectorGeneration === generation)
          .filter((row) => row.parserVersion === args.where.parserVersion)
          .filter((row) => row.chunkStrategy === args.where.chunkStrategy)
          .filter((row) => !documentIds || documentIds.includes(row.documentId))
          .filter((row) => !formTypes || formTypes.includes(row.formType))
          .filter((row) => pageStart === null || row.pageStart >= pageStart)
          .filter((row) => pageEnd === null || row.pageEnd <= pageEnd)
          .filter((row) => row.baseArtifact.firmId === artifactFilter.firmId)
          .filter((row) => row.baseArtifact.isCurrent === artifactFilter.isCurrent)
          .filter((row) => row.baseArtifact.status === artifactFilter.status)
          .filter((row) => row.baseArtifact.parserVersion === artifactFilter.parserVersion)
          .filter((row) => row.baseArtifact.featureSet === artifactFilter.featureSet)
          .filter(
            (row) =>
              artifactFilter.generation === undefined ||
              row.baseArtifact.generation === artifactFilter.generation
          )
          .slice(0, args.take);
      },
    },
  };
}

async function main() {
  const failures = [];
  const rows = createRows();
  const calls = [];
  const db = createMockDb(rows, calls);
  const output = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 1,
      query: "filing status single",
      documentIds: ["doc_a"],
      topK: 5,
    },
    db
  );

  assertCondition(calls.length === 1, "expected exactly one DB query", failures);
  assertCondition(calls[0]?.where.firmId === "firm_a", "DB query is not firm-scoped", failures);
  assertCondition(
    calls[0]?.where.vectorGeneration === 1,
    "DB query is not active-generation scoped",
    failures
  );
  assertCondition(
    calls[0]?.where.baseArtifact?.isCurrent === true &&
      calls[0]?.where.baseArtifact?.status ===
        DocumentBaseArtifactStatus.READY_FOR_INDEXING,
    "DB query does not require current index-ready artifacts",
    failures
  );
  assertCondition(
    calls[0]?.where.parserVersion === "textract-base-v1" &&
      calls[0]?.where.chunkStrategy === "base-document-structure-v1" &&
      calls[0]?.where.baseArtifact?.featureSet === "FORMS,LAYOUT,TABLES",
    "DB query is not scoped to the default parser/feature/chunk corpus",
    failures
  );
  assertCondition(
    calls[0]?.where.documentId?.in?.length === 1 &&
      calls[0].where.documentId.in[0] === "doc_a",
    "DB query is not document-filter scoped",
    failures
  );
  assertCondition(output.results.length > 0, "expected retrieval result", failures);
  assertCondition(
    output.results.every(
      (result) =>
        result.chunk.firmId === "firm_a" &&
        result.chunk.vectorGeneration === 1 &&
        result.chunk.documentId === "doc_a"
    ),
    "retrieval returned wrong tenant/document/generation",
    failures
  );
  assertCondition(
    output.citations.every(
      (citation) =>
        citation.documentId === "doc_a" &&
        citation.sourceBlockIds.length > 0 &&
        Boolean(citation.snippet)
    ),
    "citation lost document/provenance/snippet contract",
    failures
  );

  const currentOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      query: "income",
      documentIds: ["doc_a", "doc_c"],
      topK: 5,
    },
    db
  );

  assertCondition(
    currentOutput.results.some(
      (result) =>
        result.chunk.documentId === "doc_c" &&
        result.chunk.vectorGeneration === 2
    ),
    "current artifact retrieval did not support mixed per-document generations",
    failures
  );
  assertCondition(
    currentOutput.results.every(
      (result) =>
        result.chunk.documentId !== "doc_a" ||
        result.chunk.vectorGeneration === 1
    ),
    "current artifact retrieval included stale document generation",
    failures
  );

  const emptyOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 3,
      query: "filing status single",
      topK: 5,
    },
    db
  );

  assertCondition(
    emptyOutput.results.length === 0 && emptyOutput.citations.length === 0,
    "missing active generation should return empty output",
    failures
  );

  const corruptedOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 1,
      query: "corrupted source",
      documentIds: ["doc_d"],
      topK: 5,
    },
    db
  );

  assertCondition(
    corruptedOutput.results.length === 0 &&
      corruptedOutput.warnings.some((warning) =>
        warning.includes("invalid sourceBlockIds")
      ),
    "invalid sourceBlockIds should be surfaced and excluded",
    failures
  );

  const partialCorruptionOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 1,
      query: "partially corrupted",
      documentIds: ["doc_f"],
      topK: 5,
    },
    db
  );

  assertCondition(
    partialCorruptionOutput.results.length === 0 &&
      partialCorruptionOutput.warnings.some((warning) =>
        warning.includes("invalid sourceBlockIds")
      ),
    "partially invalid sourceBlockIds should be surfaced and excluded",
    failures
  );

  const alternateParserOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 1,
      query: "alternate parser filing status",
      documentIds: ["doc_e"],
      topK: 5,
    },
    db
  );

  assertCondition(
    alternateParserOutput.results.length === 0,
    "default retrieval corpus should not include alternate parser artifacts",
    failures
  );

  const callsBeforeEmptyFilter = calls.length;
  const emptyFilterOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 1,
      query: "filing status single",
      documentIds: [],
      topK: 5,
    },
    db
  );
  const invalidFilterOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      activeGeneration: 1,
      query: "filing status single",
      documentIds: [""],
      topK: 5,
    },
    db
  );

  assertCondition(
    emptyFilterOutput.results.length === 0 &&
      emptyFilterOutput.citations.length === 0,
    "empty document filter widened retrieval",
    failures
  );
  assertCondition(
    invalidFilterOutput.results.length === 0 &&
      invalidFilterOutput.citations.length === 0,
    "invalid document filter widened retrieval",
    failures
  );
  assertCondition(
    calls.length === callsBeforeEmptyFilter,
    "empty/invalid document filters should not query all documents",
    failures
  );

  try {
    await retrievePersistedBaseDocumentChunks(
      {
        firmId: "firm_a",
        query: "filing income",
        topK: 5,
        maxCandidateChunks: 1,
      },
      db
    );
    failures.push("candidate overflow should fail loudly before local scoring");
  } catch (error) {
    assertCondition(
      String(error.message || error).includes("exceeded 1 candidate chunks"),
      "candidate overflow raised an unexpected error",
      failures
    );
  }

  const callsBeforeFilteredOverflow = calls.length;
  const filteredOverflowOutput = await retrievePersistedBaseDocumentChunks(
    {
      firmId: "firm_a",
      query: "Schedule C profit",
      formTypes: ["Schedule C"],
      pageRange: { start: 2, end: 2 },
      topK: 5,
      maxCandidateChunks: 1,
    },
    db
  );
  const filteredOverflowCall = calls[callsBeforeFilteredOverflow];

  assertCondition(
    filteredOverflowCall?.where.formType?.in?.[0] === "Schedule C" &&
      filteredOverflowCall?.where.pageStart?.gte === 2 &&
      filteredOverflowCall?.where.pageEnd?.lte === 2,
    "form/page filters were not pushed into the DB candidate query",
    failures
  );
  assertCondition(
    filteredOverflowOutput.results.length === 1 &&
      filteredOverflowOutput.results[0].chunk.documentId === "doc_g",
    "selective form/page filters should avoid candidate overflow and return the matching chunk",
    failures
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Persisted retrieval verified: results=${output.results.length} citations=${output.citations.length}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
