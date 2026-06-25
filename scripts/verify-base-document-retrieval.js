#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const fixtureFolders = [
  path.join(
    repoRoot,
    "scripts",
    "fixtures",
    "textract-base-document",
    "redacted-mini"
  ),
  path.join(
    repoRoot,
    "scripts",
    "fixtures",
    "textract-base-document",
    "redacted-multipage"
  ),
];

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
const { chunkBaseDocument } = require(path.join(
  repoRoot,
  "src/lib/base-document-chunker.ts"
));
const {
  buildLocalRetrievalCorpus,
  createCitation,
  createVectorMetadata,
  getFirmVectorNamespace,
  searchLocalRetrievalCorpus,
  validateChunksForIndexing,
  validateVectorMetadata,
} = require(path.join(repoRoot, "src/lib/base-document-retrieval.ts"));

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

async function loadFixtureArtifact(folderPath, index) {
  const summaryPath = path.join(folderPath, "summary.json");
  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : {};
  const jobId = readTextIfExists(path.join(folderPath, "job-id.txt")) || summary.jobId || null;
  const responses = fs
    .readdirSync(folderPath)
    .filter((filename) => /^page-\d+\.json$/.test(filename))
    .sort((left, right) => chunkNumber(left) - chunkNumber(right))
    .map((filename) => readJson(path.join(folderPath, filename)));

  return textractFixtureBaseDocumentSource.load({
    artifactId: `retrieval-fixture-artifact-${index + 1}`,
    documentId: `retrieval-fixture-document-${index + 1}`,
    firmId: "firm_retrieval_fixture",
    generation: 1,
    responses,
    providerJobId: jobId,
    sourceFilename: summary.pdf || path.basename(folderPath),
    expectedPageCount: summary.pageCount || null,
    featureSet: ["FORMS", "TABLES", "LAYOUT"],
  });
}

function verifyMetadataAllowlist(chunks, failures) {
  let sawNullFormTypeChunk = false;

  for (const chunk of chunks) {
    const metadata = createVectorMetadata(chunk);
    const metadataErrors = validateVectorMetadata(metadata);
    const idParts = chunk.chunkId.split(":");

    assertCondition(
      metadataErrors.length === 0,
      `metadata allowlist failed for ${chunk.chunkId}: ${metadataErrors.join("; ")}`,
      failures
    );
    assertCondition(
      !("content" in metadata) && !("sourceBlockIds" in metadata),
      `metadata leaked content/provenance for ${chunk.chunkId}`,
      failures
    );
    assertCondition(
      !Object.values(metadata).some((value) => value === null || value === undefined),
      `metadata contains null/undefined value for ${chunk.chunkId}`,
      failures
    );
    assertCondition(
      idParts.length === 7 &&
        idParts[0] === chunk.firmId &&
        idParts[1] === chunk.documentId &&
        idParts[2] === chunk.baseArtifactId &&
        idParts[3] === chunk.parserVersion &&
        idParts[4] === chunk.chunkStrategy &&
        idParts[5] === `g${chunk.vectorGeneration}`,
      `chunk ID does not match production vector ID shape: ${chunk.chunkId}`,
      failures
    );

    if (chunk.formType === null) {
      sawNullFormTypeChunk = true;
      assertCondition(
        !("formType" in metadata),
        `metadata should omit null formType for ${chunk.chunkId}`,
        failures
      );
    }
  }

  assertCondition(
    sawNullFormTypeChunk,
    "retrieval fixtures did not cover a null formType chunk",
    failures
  );

  const invalidMetadataErrors = validateVectorMetadata({
    chunkId: "invalid",
    documentId: "doc",
    firmId: "firm",
    pageStart: 1,
    pageEnd: 1,
    formType: null,
    parserVersion: "parser",
    chunkStrategy: "strategy",
    contentType: "prose",
  });

  assertCondition(
    invalidMetadataErrors.length > 0,
    "metadata validator did not reject null formType",
    failures
  );
}

function verifyChunkSet(chunks, artifacts, failures) {
  const indexingErrors = validateChunksForIndexing(chunks);
  assertCondition(
    indexingErrors.length === 0,
    `chunk indexing validation failed: ${indexingErrors.join("; ")}`,
    failures
  );

  for (const artifact of artifacts) {
    const artifactChunks = chunks.filter(
      (chunk) => chunk.baseArtifactId === artifact.id
    );
    const contentTypes = new Set(artifactChunks.map((chunk) => chunk.contentType));

    assertCondition(
      artifact.status === "READY_FOR_INDEXING",
      `artifact ${artifact.id} is not ready for indexing`,
      failures
    );
    assertCondition(contentTypes.has("prose"), `artifact ${artifact.id} has no prose chunk`, failures);
    assertCondition(contentTypes.has("mixed"), `artifact ${artifact.id} has no layout/mixed chunk`, failures);

    if (artifact.baseDocument.summary.fieldCount > 0) {
      assertCondition(
        contentTypes.has("field_group"),
        `artifact ${artifact.id} has fields but no field_group chunk`,
        failures
      );
    }

    if (artifact.baseDocument.summary.tableCount > 0) {
      assertCondition(
        contentTypes.has("table"),
        `artifact ${artifact.id} has tables but no table chunk`,
        failures
      );
    }
  }
}

function cloneChunksForFirm(chunks, firmId) {
  return chunks.map((chunk) => ({
    ...chunk,
    firmId,
    chunkId: chunk.chunkId.replace(chunk.firmId, firmId),
  }));
}

function cloneChunksForGeneration(chunks, generation) {
  return chunks.map((chunk) => ({
    ...chunk,
    vectorGeneration: generation,
    chunkId: chunk.chunkId.replace(/:g\d+:/, `:g${generation}:`),
  }));
}

function verifyRetrieval(chunks, failures) {
  const corpus = buildLocalRetrievalCorpus(chunks, "firm_retrieval_fixture", 1);
  const filingResults = searchLocalRetrievalCorpus(corpus, "filing status single", {
    topK: 3,
  });
  const incomeResults = searchLocalRetrievalCorpus(corpus, "income redacted amount", {
    topK: 3,
  });
  const filteredResults = searchLocalRetrievalCorpus(corpus, "income", {
    topK: 3,
    documentIds: ["retrieval-fixture-document-2"],
  });

  assertCondition(
    corpus.namespace === getFirmVectorNamespace("firm_retrieval_fixture"),
    "firm namespace mismatch",
    failures
  );
  assertCondition(filingResults.length > 0, "filing status query returned no results", failures);
  assertCondition(
    filingResults[0]?.chunk.contentType === "field_group",
    "filing status query did not prioritize field_group chunk",
    failures
  );
  assertCondition(incomeResults.length > 0, "income query returned no results", failures);
  assertCondition(
    incomeResults.some((result) => result.chunk.contentType === "table"),
    "income query did not return table evidence",
    failures
  );
  assertCondition(
    filteredResults.every(
      (result) => result.chunk.documentId === "retrieval-fixture-document-2"
    ),
    "document filter returned chunks from the wrong document",
    failures
  );

  if (filingResults[0]) {
    const citation = createCitation(filingResults[0]);
    assertCondition(Boolean(citation.chunkId), "citation missing chunkId", failures);
    assertCondition(Boolean(citation.snippet), "citation missing snippet", failures);
    assertCondition(
      citation.sourceBlockIds.length > 0,
      "citation missing sourceBlockIds",
      failures
    );
  }

  const otherFirmChunks = cloneChunksForFirm(chunks, "firm_other_fixture");
  const mixedTenantChunks = [...chunks, ...otherFirmChunks];
  const mixedPrimaryCorpus = buildLocalRetrievalCorpus(
    mixedTenantChunks,
    "firm_retrieval_fixture",
    1
  );
  const mixedOtherCorpus = buildLocalRetrievalCorpus(
    mixedTenantChunks,
    "firm_other_fixture",
    1
  );
  const mixedPrimaryResults = searchLocalRetrievalCorpus(
    mixedPrimaryCorpus,
    "filing status single",
    { topK: 10 }
  );
  const mixedOtherResults = searchLocalRetrievalCorpus(
    mixedOtherCorpus,
    "filing status single",
    { topK: 10 }
  );

  assertCondition(
    mixedOtherCorpus.namespace !== corpus.namespace,
    "tenant namespaces are not isolated",
    failures
  );
  assertCondition(
    mixedPrimaryResults.every(
      (result) => result.chunk.firmId === "firm_retrieval_fixture"
    ),
    "mixed-tenant primary search returned another firm's chunks",
    failures
  );
  assertCondition(
    mixedOtherResults.every((result) => result.chunk.firmId === "firm_other_fixture"),
    "mixed-tenant secondary search returned primary firm chunks",
    failures
  );

  const staleGenerationChunks = cloneChunksForGeneration(chunks, 2);
  const futureGenerationChunks = cloneChunksForGeneration(chunks, 3);
  const mixedGenerationCorpus = buildLocalRetrievalCorpus(
    [...staleGenerationChunks, ...chunks, ...futureGenerationChunks],
    "firm_retrieval_fixture",
    1
  );
  const mixedGenerationResults = searchLocalRetrievalCorpus(
    mixedGenerationCorpus,
    "income redacted amount",
    { topK: 10 }
  );

  assertCondition(
    mixedGenerationResults.every((result) => result.chunk.vectorGeneration === 1),
    "active-generation search returned stale or future generation chunks",
    failures
  );
  assertCondition(
    mixedGenerationResults
      .map(createCitation)
      .every((citation) =>
        mixedGenerationResults.some(
          (result) =>
            result.chunk.chunkId === citation.chunkId &&
            result.chunk.vectorGeneration === 1
        )
      ),
    "active-generation citation did not map to active-generation result",
    failures
  );
}

async function main() {
  const failures = [];
  const artifacts = await Promise.all(
    fixtureFolders.map((folderPath, index) => loadFixtureArtifact(folderPath, index))
  );
  const chunks = artifacts.flatMap((artifact) =>
    chunkBaseDocument(artifact.baseDocument, {
      documentId: artifact.documentId,
      firmId: artifact.firmId,
      baseArtifactId: artifact.id,
      vectorGeneration: artifact.generation,
    })
  );

  verifyChunkSet(chunks, artifacts, failures);
  verifyMetadataAllowlist(chunks, failures);
  verifyRetrieval(chunks, failures);

  console.log(
    [
      `artifacts=${artifacts.length}`,
      `chunks=${chunks.length}`,
      `metadata=${chunks.length}`,
      `namespace=${getFirmVectorNamespace("firm_retrieval_fixture")}`,
    ].join(" ")
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
