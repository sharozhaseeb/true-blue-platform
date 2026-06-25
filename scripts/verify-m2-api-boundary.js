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

const { prisma } = require(path.join(repoRoot, "src/lib/prisma.ts"));
const tenant = require(path.join(repoRoot, "src/lib/tenant.ts"));
const documentRoute = require(path.join(
  repoRoot,
  "src/app/api/documents/[id]/route.ts"
));

const originalMethods = {
  getRequestContext: tenant.getRequestContext,
  enforceTenantAccess: tenant.enforceTenantAccess,
  documentFindUnique: prisma.document.findUnique,
  documentChunkFindMany: prisma.documentChunk.findMany,
  documentChunkCount: prisma.documentChunk.count,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makeRequest(url) {
  return { url };
}

function restoreOriginalMethods() {
  tenant.getRequestContext = originalMethods.getRequestContext;
  tenant.enforceTenantAccess = originalMethods.enforceTenantAccess;
  prisma.document.findUnique = originalMethods.documentFindUnique;
  prisma.documentChunk.findMany = originalMethods.documentChunkFindMany;
  prisma.documentChunk.count = originalMethods.documentChunkCount;
}

async function main() {
  const documentId = "m2-api-boundary-document";

  tenant.getRequestContext = async () => ({
    userId: "platform-admin",
    role: "PLATFORM_ADMIN",
    firmId: null,
    isAuthenticated: true,
  });
  tenant.enforceTenantAccess = () => true;

  prisma.document.findUnique = async () => ({
    id: documentId,
    filename: "api-boundary.pdf",
    originalName: "api-boundary.pdf",
    s3Key: "firms/1/documents/1/api-boundary.pdf",
    s3Bucket: "unit-test-bucket",
    mimeType: "application/pdf",
    fileSize: 42,
    pageCount: 2,
    status: "COMPLETED",
    errorMessage: null,
    firmId: "firm-1",
    uploadedById: "user-1",
    createdAt: new Date("2026-04-23T00:00:00.000Z"),
    updatedAt: new Date("2026-04-23T00:00:00.000Z"),
  });

  prisma.documentChunk.findMany = async () => [
    {
      id: "chunk-explicit",
      pageNumber: 1,
      chunkIndex: 0,
      content: "Form 1040 explicit chunk",
      tokenEstimate: 6,
      metadata: {
        filename: "api-boundary.pdf",
        formType: "Form 1040",
        explicitFormType: "Form 1040",
        resolvedFormType: "Form 1040",
        formTypeSource: "explicit",
        formTypeOriginPage: 1,
        sourcePageNumbers: [1],
        coversPageStart: true,
        coversPageEnd: true,
        pageRange: null,
        isPartialPage: false,
        partIndex: 0,
      },
    },
    {
      id: "chunk-legacy",
      pageNumber: 2,
      chunkIndex: 1,
      content: "Schedule 2 legacy chunk",
      tokenEstimate: 6,
      metadata: {
        filename: "api-boundary.pdf",
        formType: "Schedule 2",
        sourcePageNumbers: [2],
        coversPageStart: true,
        coversPageEnd: true,
        pageRange: "2-2",
      },
    },
    {
      id: "chunk-legacy-merge",
      pageNumber: 3,
      chunkIndex: 2,
      content: "Schedule C merged chunk",
      tokenEstimate: 8,
      metadata: {
        filename: "api-boundary.pdf",
        formType: "Schedule C",
        pageRange: "3-4",
        coversPageStart: "false",
        coversPageEnd: "false",
        isPartialPage: "false",
      },
    },
  ];

  prisma.documentChunk.count = async () => 3;

  try {
    const response = await documentRoute.GET(
      makeRequest(
        `https://example.test/api/documents/${documentId}?chunks=true&limit=10`
      ),
      { params: Promise.resolve({ id: documentId }) }
    );
    const body = await response.json();

    assert(response.status === 200, `Expected 200, got ${response.status}`);
    assert(body.document?.id === documentId, "Document payload missing");
    assert(body.chunkTotal === 3, `Expected chunkTotal 3, got ${body.chunkTotal}`);
    assert(Array.isArray(body.chunks), "Expected chunks array");
    assert(body.chunks.length === 3, `Expected 3 chunks, got ${body.chunks.length}`);

    const explicitChunk = body.chunks[0];
    const legacyChunk = body.chunks[1];
    const legacyMergedChunk = body.chunks[2];

    assert(
      explicitChunk.metadata.formType === "Form 1040",
      "Expected explicit chunk formType to remain Form 1040"
    );
    assert(
      explicitChunk.metadata.resolvedFormType === "Form 1040",
      "Expected explicit chunk resolvedFormType to remain Form 1040"
    );
    assert(
      explicitChunk.metadata.formTypeSource === "explicit",
      "Expected explicit chunk formTypeSource to remain explicit"
    );

    assert(
      legacyChunk.metadata.formType === "Schedule 2",
      "Expected legacy chunk formType to stay Schedule 2"
    );
    assert(
      legacyChunk.metadata.resolvedFormType === "Schedule 2",
      "Expected legacy chunk resolvedFormType to stay Schedule 2"
    );
    assert(
      legacyChunk.metadata.formTypeSource === null,
      "Expected legacy chunk formTypeSource to remain null"
    );
    assert(
      legacyChunk.metadata.explicitFormType === null,
      "Expected legacy chunk explicitFormType to remain null"
    );
    assert(
      JSON.stringify(legacyChunk.metadata.sourcePageNumbers) === JSON.stringify([2]),
      `Expected legacy chunk sourcePageNumbers [2], got ${JSON.stringify(legacyChunk.metadata.sourcePageNumbers)}`
    );

    assert(
      legacyMergedChunk.metadata.formType === "Schedule C",
      "Expected legacy merged chunk formType to stay Schedule C"
    );
    assert(
      legacyMergedChunk.metadata.formTypeSource === null,
      "Expected legacy merged chunk formTypeSource to remain null"
    );
    assert(
      JSON.stringify(legacyMergedChunk.metadata.sourcePageNumbers) === JSON.stringify([3, 4]),
      `Expected legacy merged chunk sourcePageNumbers [3,4], got ${JSON.stringify(legacyMergedChunk.metadata.sourcePageNumbers)}`
    );
    assert(
      legacyMergedChunk.metadata.coversPageStart === false &&
        legacyMergedChunk.metadata.coversPageEnd === false,
      "Expected legacy merged chunk string booleans to parse strictly as false"
    );

    console.log("M2 API boundary verification");
    console.log("- GET /api/documents/[id]?chunks=true normalizes Prisma JsonValue metadata");
    console.log("- Legacy chunk provenance remains null instead of fabricated propagated");
    console.log("- Legacy merged chunks derive sourcePageNumbers from pageRange without inventing booleans");
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    restoreOriginalMethods();
  }
}

main();
