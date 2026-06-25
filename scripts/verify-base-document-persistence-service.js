#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const fixtureFolder = path.join(
  repoRoot,
  "scripts",
  "fixtures",
  "textract-base-document",
  "redacted-mini"
);

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

const { textractFixtureBaseDocumentSource } = require(path.join(
  repoRoot,
  "src/lib/base-document-source.ts"
));
const {
  buildRetrievalChunkCreateManyInput,
  persistBaseDocumentArtifact,
} = require(path.join(repoRoot, "src/lib/base-document-persistence.ts"));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : null;
}

function chunkNumber(filename) {
  const match = filename.match(/page-(\d+)\.json$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

async function loadArtifact() {
  const summary = readJson(path.join(fixtureFolder, "summary.json"));
  const responses = fs
    .readdirSync(fixtureFolder)
    .filter((filename) => /^page-\d+\.json$/.test(filename))
    .sort((left, right) => chunkNumber(left) - chunkNumber(right))
    .map((filename) => readJson(path.join(fixtureFolder, filename)));

  return textractFixtureBaseDocumentSource.load({
    artifactId: "artifact_persist_fixture_1",
    documentId: "document_persist_fixture_1",
    firmId: "firm_persist_fixture_1",
    generation: 1,
    responses,
    providerJobId: readTextIfExists(path.join(fixtureFolder, "job-id.txt")),
    sourceFilename: summary.pdf,
    expectedPageCount: summary.pageCount,
    featureSet: ["LAYOUT", "TABLES", "FORMS"],
  });
}

function createMockDb({ documentExists = true } = {}) {
  const calls = [];
  const tx = {
    document: {
      async findFirst(args) {
        calls.push({ model: "document", action: "findFirst", args });
        return documentExists
          ? { id: args.where.id, firmId: args.where.firmId }
          : null;
      },
    },
    documentBaseArtifact: {
      async updateMany(args) {
        calls.push({ model: "documentBaseArtifact", action: "updateMany", args });
        return { count: 1 };
      },
      async create(args) {
        calls.push({ model: "documentBaseArtifact", action: "create", args });
        return {
          id: args.data.id,
          documentId: args.data.document.connect.id,
          firmId: args.data.firm.connect.id,
          generation: args.data.generation,
          status: args.data.status,
        };
      },
    },
    documentRetrievalChunk: {
      async createMany(args) {
        calls.push({ model: "documentRetrievalChunk", action: "createMany", args });
        return { count: args.data.length };
      },
    },
  };

  return {
    calls,
    db: {
      async $transaction(callback) {
        calls.push({ model: "db", action: "transaction:start" });
        const result = await callback(tx);
        calls.push({ model: "db", action: "transaction:commit" });
        return result;
      },
    },
  };
}

async function main() {
  const failures = [];
  const artifact = await loadArtifact();
  const retrievalRows = buildRetrievalChunkCreateManyInput(artifact);
  const secondArtifact = {
    ...artifact,
    id: "artifact_persist_fixture_2",
  };
  const secondRetrievalRows = buildRetrievalChunkCreateManyInput(secondArtifact);
  const { calls, db } = createMockDb();
  const result = await persistBaseDocumentArtifact(
    {
      artifact,
      provider: "aws-textract",
      rawArtifactS3Key: "raw/artifact.json",
      normalizedArtifactS3Key: "normalized/artifact.json",
    },
    db
  );

  const updateCurrentCall = calls.find(
    (call) => call.model === "documentBaseArtifact" && call.action === "updateMany"
  );
  const createArtifactCall = calls.find(
    (call) => call.model === "documentBaseArtifact" && call.action === "create"
  );
  const createChunksCall = calls.find(
    (call) => call.model === "documentRetrievalChunk" && call.action === "createMany"
  );

  assertCondition(retrievalRows.length > 0, "no retrieval rows generated", failures);
  assertCondition(
    retrievalRows.every((row, index) => row.id !== secondRetrievalRows[index]?.id),
    "retrieval chunk IDs are not artifact-scoped",
    failures
  );
  assertCondition(result.chunkCount === retrievalRows.length, "chunk count mismatch", failures);
  assertCondition(result.status === "READY_FOR_INDEXING", "persisted artifact status mismatch", failures);
  assertCondition(Boolean(updateCurrentCall), "previous-current update missing", failures);
  assertCondition(Boolean(createArtifactCall), "artifact create missing", failures);
  assertCondition(Boolean(createChunksCall), "retrieval chunk createMany missing", failures);
  assertCondition(
    updateCurrentCall?.args.where.isCurrent === true,
    "updateMany does not target current artifacts",
    failures
  );
  assertCondition(
    updateCurrentCall?.args.data.isCurrent === false,
    "updateMany does not unset current artifacts",
    failures
  );
  assertCondition(
    createArtifactCall?.args.data.isCurrent === true,
    "new artifact is not current",
    failures
  );
  assertCondition(
    createArtifactCall?.args.data.featureSet === "FORMS,LAYOUT,TABLES",
    "feature set was not canonicalized",
    failures
  );
  assertCondition(
    createArtifactCall?.args.data.normalizedArtifactS3Key === "normalized/artifact.json",
    "normalized artifact key missing",
    failures
  );
  assertCondition(
    createChunksCall?.args.data.every(
      (row) =>
        row.documentId === artifact.documentId &&
        row.firmId === artifact.firmId &&
        row.baseArtifactId === artifact.id &&
        row.vectorGeneration === artifact.generation &&
        Array.isArray(row.sourceBlockIds)
    ),
    "one or more retrieval rows lost document/firm/artifact/provenance contract",
    failures
  );

  const missingDocumentMock = createMockDb({ documentExists: false });
  let rejectedWrongFirm = false;
  try {
    await persistBaseDocumentArtifact(
      {
        artifact,
        provider: "aws-textract",
      },
      missingDocumentMock.db
    );
  } catch (error) {
    rejectedWrongFirm = String(error).includes("Document not found for firm");
  }

  assertCondition(rejectedWrongFirm, "missing/wrong firm document was not rejected", failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Persistence service verified: artifact=${result.artifactId} chunks=${result.chunkCount}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
