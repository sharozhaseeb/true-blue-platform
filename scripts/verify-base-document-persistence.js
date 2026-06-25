#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
const migrationPath = path.join(
  repoRoot,
  "prisma",
  "migrations",
  "20260515124500_add_base_document_persistence",
  "migration.sql"
);

function assertIncludes(content, needle, label, failures) {
  if (!content.includes(needle)) {
    failures.push(`${label} missing: ${needle}`);
  }
}

function main() {
  const failures = [];
  const schema = fs.readFileSync(schemaPath, "utf8");
  const migration = fs.readFileSync(migrationPath, "utf8");

  for (const model of [
    "model DocumentBaseArtifact",
    "model DocumentRetrievalChunk",
    "model DocumentVectorIndex",
  ]) {
    assertIncludes(schema, model, "schema model", failures);
  }

  for (const enumName of [
    "enum DocumentBaseArtifactStatus",
    "enum DocumentArtifactSourceMode",
    "enum DocumentRetrievalContentType",
    "enum DocumentVectorIndexStatus",
  ]) {
    assertIncludes(schema, enumName, "schema enum", failures);
  }

  for (const field of [
    "generation              Int",
    "isCurrent               Boolean",
    "providerJobId           String?",
    "sourceMode              DocumentArtifactSourceMode",
    "baseArtifactId   String",
    "vectorGeneration Int",
    "content          String                       @db.Text",
    "sourceBlockIds   Json",
    "isActive       Boolean",
    "vectorIds      Json",
    "chunkIds       Json",
    "@@unique([id, firmId])",
    "@@unique([id, documentId, firmId])",
  ]) {
    assertIncludes(schema, field, "schema field", failures);
  }

  for (const relation of [
    "baseArtifacts",
    "retrievalChunks DocumentRetrievalChunk[]",
    "vectorIndexes",
  ]) {
    assertIncludes(schema, relation, "document relation", failures);
  }

  for (const sql of [
    'CREATE TYPE "DocumentBaseArtifactStatus"',
    'CREATE TABLE "document_base_artifacts"',
    'CREATE TABLE "document_retrieval_chunks"',
    'CREATE TABLE "document_vector_indexes"',
    'CREATE INDEX "document_base_artifacts_providerJobId_idx"',
    'CREATE UNIQUE INDEX "documents_id_firmId_key"',
    'CREATE UNIQUE INDEX "document_base_artifacts_id_documentId_firmId_key"',
    'CREATE UNIQUE INDEX "document_base_artifacts_one_current_generation_idx"',
    'WHERE "isCurrent" = true',
    'CREATE UNIQUE INDEX "document_vector_indexes_one_active_generation_idx"',
    'WHERE "isActive" = true',
    'CHECK ("generation" > 0)',
    'CHECK ("vectorGeneration" > 0)',
    'CHECK ("pageStart" > 0 AND "pageEnd" >= "pageStart")',
    'CHECK ("isActive" = ("status" = \'ACTIVE\'))',
    'FOREIGN KEY ("baseArtifactId") REFERENCES "document_base_artifacts"("id") ON DELETE CASCADE',
    'FOREIGN KEY ("documentId", "firmId") REFERENCES "documents"("id", "firmId") ON DELETE CASCADE',
    'FOREIGN KEY ("baseArtifactId", "documentId", "firmId") REFERENCES "document_base_artifacts"("id", "documentId", "firmId") ON DELETE CASCADE',
  ]) {
    assertIncludes(migration, sql, "migration SQL", failures);
  }

  if (schema.includes("providerJobId           String?                    @unique")) {
    failures.push("schema still makes providerJobId globally unique");
  }

  if (migration.includes('CREATE UNIQUE INDEX "document_base_artifacts_providerJobId_key"')) {
    failures.push("migration still creates a globally unique providerJobId index");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("BaseDocument persistence schema and migration invariants verified.");
}

main();
