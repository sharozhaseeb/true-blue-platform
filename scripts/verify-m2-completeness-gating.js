#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

const { prisma } = require(path.join(repoRoot, "src/lib/prisma.ts"));
const fixtureConfig = require(path.join(
  repoRoot,
  "scripts/fixtures/m2-pdf-quality-fixtures.js"
));
const samplePdfDir = path.resolve(repoRoot, "..", "client_shared_pdfs");

const originalMethods = {
  documentUpdate: prisma.document.update,
  documentFindUnique: prisma.document.findUnique,
  documentChunkCreateMany: prisma.documentChunk.createMany,
  transaction: prisma.$transaction,
};

let activeCase = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makePage(pageNumber, text) {
  return { pageNumber, text };
}

function buildRepeatedText(prefix, tokenCount) {
  return Array.from({ length: tokenCount }, (_, index) =>
    `${prefix}${String(index).padStart(4, "0")}`
  ).join(" ");
}

function sanitizeDocumentId(filename) {
  const digest = crypto
    .createHash("sha1")
    .update(filename)
    .digest("hex")
    .slice(0, 10);

  return `m2-completeness-${digest}`;
}

function createCaseState(caseDef) {
  return {
    documentId: caseDef.documentId,
    filename: caseDef.filename,
    pages: caseDef.pages,
    pageCount: caseDef.pages?.length ?? caseDef.expectedPageCount ?? 0,
    expectedPageCount: caseDef.expectedPageCount ?? null,
    useRealExtraction: Boolean(caseDef.useRealExtraction),
    pdfPath: caseDef.pdfPath ?? null,
    documentStatus: "PROCESSING",
    calls: {
      extractTextByPage: [],
      documentUpdate: [],
      documentFindUnique: [],
      documentChunkCreateMany: [],
      transactionCount: 0,
    },
  };
}

async function runPipelineCase(caseDef) {
  const state = createCaseState(caseDef);
  activeCase = state;

  try {
    const fileBuffer =
      caseDef.fileBuffer ??
      (caseDef.pdfPath ? fs.readFileSync(caseDef.pdfPath) : Buffer.alloc(0));
    const extractPages = caseDef.useRealExtraction
      ? undefined
      : async (buffer, documentId) => {
          if (!activeCase) {
            throw new Error("No active completeness case");
          }

          activeCase.calls.extractTextByPage.push({
            documentId,
            byteLength: buffer.length,
            mode: "stub",
          });

          return {
            pages: activeCase.pages,
            pageCount: activeCase.pageCount,
          };
        };

    const result = extractPages
      ? await processDocument(
          caseDef.documentId,
          fileBuffer,
          caseDef.filename,
          extractPages
        )
      : await processDocument(caseDef.documentId, fileBuffer, caseDef.filename);
    return { state, result, error: null };
  } catch (error) {
    return { state, result: null, error };
  } finally {
    activeCase = null;
  }
}

prisma.document.update = async (args) => {
  if (!activeCase) {
    throw new Error("No active completeness case");
  }

  activeCase.calls.documentUpdate.push(args);
  if (args?.data?.status) {
    activeCase.documentStatus = args.data.status;
  }

  return {
    id: activeCase.documentId,
    ...args.data,
  };
};

prisma.document.findUnique = async (args) => {
  if (!activeCase) {
    throw new Error("No active completeness case");
  }

  activeCase.calls.documentFindUnique.push(args);
  return {
    status: activeCase.documentStatus,
  };
};

prisma.documentChunk.createMany = async (args) => {
  if (!activeCase) {
    throw new Error("No active completeness case");
  }

  activeCase.calls.documentChunkCreateMany.push(args);
  return { count: args.data.length };
};

prisma.$transaction = async (callback) => {
  if (!activeCase) {
    throw new Error("No active completeness case");
  }

  activeCase.calls.transactionCount += 1;
  return callback({
    documentChunk: {
      createMany: prisma.documentChunk.createMany,
    },
    document: {
      update: prisma.document.update,
    },
  });
};

const { processDocument } = require(path.join(
  repoRoot,
  "src/lib/document-pipeline.ts"
));

function restoreOriginalMethods() {
  prisma.document.update = originalMethods.documentUpdate;
  prisma.document.findUnique = originalMethods.documentFindUnique;
  prisma.documentChunk.createMany = originalMethods.documentChunkCreateMany;
  prisma.$transaction = originalMethods.transaction;
}

function buildPositiveControlPages() {
  return Array.from({ length: 12 }, (_, index) =>
    makePage(
      index + 1,
      `Control page ${index + 1} ` +
        buildRepeatedText(`control${index + 1}-`, 60)
    )
  );
}

function buildPartiallyMissingPages() {
  const pages = [];

  for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
    if (pageNumber <= 15) {
      pages.push(
        makePage(
          pageNumber,
          `Partially extracted page ${pageNumber}\n` +
            buildRepeatedText(`partial${pageNumber}-`, 22) +
            `\nContinuation details for page ${pageNumber}`
        )
      );
      continue;
    }

    pages.push(makePage(pageNumber, ""));
  }

  return pages;
}

function buildNegativeControlPages() {
  const pages = [];

  for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
    if (pageNumber <= 10) {
      pages.push(makePage(pageNumber, "A".repeat(150)));
      continue;
    }

    if (pageNumber <= 15) {
      pages.push(makePage(pageNumber, "B".repeat(20)));
      continue;
    }

    pages.push(makePage(pageNumber, ""));
  }

  return pages;
}

function buildRealSampleCases() {
  return fixtureConfig.documents.map((documentFixture) => {
    const pdfPath = path.join(samplePdfDir, documentFixture.filename);

    return {
      documentId: `m2-completeness-real-${sanitizeDocumentId(
        documentFixture.filename
      )}`,
      filename: documentFixture.filename,
      pdfPath,
      expectedPageCount: documentFixture.expectedPageCount,
      useRealExtraction: true,
    };
  });
}

async function verifyRejectedCase() {
  const { state, result, error } = await runPipelineCase({
    documentId: "m2-completeness-negative",
    filename: "synthetic-under-extracted.pdf",
    pages: buildNegativeControlPages(),
  });

  assert(error instanceof Error, "Expected the under-extracted case to fail");
  assert(
    state.calls.documentUpdate.length === 1,
    `Expected one FAILED status update, saw ${state.calls.documentUpdate.length}`
  );
  assert(
    state.calls.documentUpdate[0]?.data?.status === "FAILED",
    "Expected the real pipeline to mark the document FAILED"
  );
  assert(
    state.calls.documentFindUnique.length >= 1,
    "Expected the real processDocument catch path to inspect persisted status"
  );
  assert(
    state.calls.transactionCount === 0,
    "Expected the failing case to skip chunk persistence"
  );
  assert(
    state.calls.documentChunkCreateMany.length === 0,
    "Expected no chunks to be written for the failing case"
  );
  assert(result === null, "Failing case should not return a success result");

  return {
    message: error.message,
    state,
  };
}

async function verifyRealisticRejectedCase() {
  const { state, result, error } = await runPipelineCase({
    documentId: "m2-completeness-partial",
    filename: "synthetic-partially-missing.pdf",
    pages: buildPartiallyMissingPages(),
  });

  assert(
    error instanceof Error,
    "Expected the moderately incomplete case to fail through the real pipeline"
  );
  assert(
    state.calls.documentUpdate.length === 1,
    `Expected one FAILED status update, saw ${state.calls.documentUpdate.length}`
  );
  assert(
    state.calls.documentUpdate[0]?.data?.status === "FAILED",
    "Expected the real pipeline to mark the moderately incomplete document FAILED"
  );
  assert(
    state.calls.documentFindUnique.length >= 1,
    "Expected the real processDocument catch path to inspect persisted status"
  );
  assert(
    state.calls.transactionCount === 0,
    "Expected the failing case to skip chunk persistence"
  );
  assert(
    state.calls.documentChunkCreateMany.length === 0,
    "Expected no chunks to be written for the failing case"
  );
  assert(result === null, "Failing case should not return a success result");

  return {
    message: error.message,
    state,
  };
}

async function verifyAcceptedCase() {
  const { state, result, error } = await runPipelineCase({
    documentId: "m2-completeness-positive",
    filename: "synthetic-complete.pdf",
    pages: buildPositiveControlPages(),
  });

  assert(!error, `Expected the dense control case to succeed: ${error?.message}`);
  assert(result, "Expected the dense control case to return a result");
  assert(
    result.pageCount === state.pageCount,
    `Expected pageCount ${state.pageCount}, got ${result.pageCount}`
  );
  assert(result.chunkCount > 0, "Expected at least one emitted chunk");
  assert(
    state.calls.transactionCount === 1,
    "Expected the passing case to use the real transaction path"
  );
  assert(
    state.calls.documentChunkCreateMany.length === 1,
    "Expected exactly one chunk write batch"
  );
  assert(
    state.calls.documentUpdate.some((entry) => entry?.data?.status === "COMPLETED"),
    "Expected the real pipeline to mark the document COMPLETED"
  );
  assert(
    state.calls.documentFindUnique.length === 0,
    "Expected no failure-path lookup for the passing case"
  );
  assert(
    state.documentStatus === "COMPLETED",
    "Expected the passing case to end in COMPLETED status"
  );

  const writtenChunks = state.calls.documentChunkCreateMany[0].data;
  assert(
    writtenChunks.length === result.chunkCount,
    "Expected the persisted chunk count to match the return value"
  );

  return state;
}

async function verifyRealSampleCases() {
  const cases = buildRealSampleCases();
  const results = [];

  for (const caseDef of cases) {
    const { state, result, error } = await runPipelineCase(caseDef);

    assert(
      !error,
      `Expected ${caseDef.filename} to complete successfully: ${error?.message}`
    );
    assert(result, `Expected ${caseDef.filename} to return a result`);
    assert(
      result.pageCount === caseDef.expectedPageCount,
      `Expected ${caseDef.filename} pageCount ${caseDef.expectedPageCount}, got ${result.pageCount}`
    );
    assert(result.chunkCount > 0, `Expected ${caseDef.filename} to emit chunks`);
    assert(
      state.calls.transactionCount === 1,
      `Expected ${caseDef.filename} to use the real transaction path`
    );
    assert(
      state.calls.documentChunkCreateMany.length === 1,
      `Expected ${caseDef.filename} to write exactly one chunk batch`
    );
    assert(
      state.calls.documentUpdate.some(
        (entry) => entry?.data?.status === "COMPLETED"
      ),
      `Expected ${caseDef.filename} to be marked COMPLETED`
    );
    assert(
      state.calls.documentFindUnique.length === 0,
      `Expected ${caseDef.filename} not to use the failure-path lookup`
    );
    assert(
      state.documentStatus === "COMPLETED",
      `Expected ${caseDef.filename} to end in COMPLETED status`
    );

    results.push({
      filename: caseDef.filename,
      pageCount: result.pageCount,
      chunkCount: result.chunkCount,
    });
  }

  return results;
}

async function main() {
  try {
    const rejected = await verifyRejectedCase();
    const realisticRejected = await verifyRealisticRejectedCase();
    await verifyAcceptedCase();
    const realSamples = await verifyRealSampleCases();

    console.log("M2 completeness gating verification");
    console.log(`- Under-extracted case rejected: ${rejected.message}`);
    console.log(`- Moderately incomplete case rejected: ${realisticRejected.message}`);
    console.log("- Dense control case completed through processDocument()");
    for (const sample of realSamples) {
      console.log(
        `- ${sample.filename} completed through processDocument() ` +
          `(${sample.pageCount} pages, ${sample.chunkCount} chunks)`
      );
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    restoreOriginalMethods();
  }
}

main();
