-- CreateEnum
CREATE TYPE "DocumentBaseArtifactStatus" AS ENUM (
    'QUEUED',
    'STARTING_PROVIDER_JOB',
    'AWAITING_PROVIDER_RESULT',
    'PROVIDER_RESULT_READY',
    'NORMALIZING',
    'READY_FOR_INDEXING',
    'INDEXED',
    'NEEDS_REVIEW',
    'FAILED',
    'CANCELLED'
);

-- CreateEnum
CREATE TYPE "DocumentArtifactSourceMode" AS ENUM (
    'BASE_DOCUMENT_JSON',
    'TEXTRACT_RESPONSE_FIXTURE',
    'LIVE_TEXTRACT'
);

-- CreateEnum
CREATE TYPE "DocumentRetrievalContentType" AS ENUM (
    'PROSE',
    'FIELD_GROUP',
    'TABLE',
    'MIXED'
);

-- CreateEnum
CREATE TYPE "DocumentVectorIndexStatus" AS ENUM (
    'BUILDING',
    'ACTIVE',
    'RETIRED',
    'FAILED',
    'DISABLED'
);

-- CreateTable
CREATE TABLE "document_base_artifacts" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceMode" "DocumentArtifactSourceMode" NOT NULL,
    "providerJobId" TEXT,
    "featureSet" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "status" "DocumentBaseArtifactStatus" NOT NULL,
    "rawArtifactS3Key" TEXT,
    "normalizedArtifactS3Key" TEXT,
    "summary" JSONB,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_base_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_retrieval_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "baseArtifactId" TEXT NOT NULL,
    "vectorGeneration" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentType" "DocumentRetrievalContentType" NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "formType" TEXT,
    "sectionPath" TEXT,
    "tableId" TEXT,
    "sourceBlockIds" JSONB NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "chunkStrategy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_retrieval_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_vector_indexes" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "indexName" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingDim" INTEGER NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "chunkStrategy" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "status" "DocumentVectorIndexStatus" NOT NULL,
    "vectorIds" JSONB NOT NULL,
    "chunkIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_vector_indexes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_base_artifacts_providerJobId_idx" ON "document_base_artifacts"("providerJobId");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_firmId_key" ON "documents"("id", "firmId");

-- CreateIndex
CREATE UNIQUE INDEX "document_base_artifacts_id_documentId_firmId_key" ON "document_base_artifacts"("id", "documentId", "firmId");

-- CreateIndex
CREATE INDEX "document_base_artifacts_documentId_idx" ON "document_base_artifacts"("documentId");

-- CreateIndex
CREATE INDEX "document_base_artifacts_firmId_idx" ON "document_base_artifacts"("firmId");

-- CreateIndex
CREATE INDEX "document_base_artifacts_status_idx" ON "document_base_artifacts"("status");

-- CreateIndex
CREATE INDEX "document_base_artifacts_documentId_parserVersion_featureSet_isCurrent_idx" ON "document_base_artifacts"("documentId", "parserVersion", "featureSet", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "document_base_artifacts_documentId_parserVersion_featureSet_generation_key" ON "document_base_artifacts"("documentId", "parserVersion", "featureSet", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "document_base_artifacts_one_current_generation_idx" ON "document_base_artifacts"("documentId", "parserVersion", "featureSet") WHERE "isCurrent" = true;

-- CreateIndex
CREATE INDEX "document_retrieval_chunks_documentId_idx" ON "document_retrieval_chunks"("documentId");

-- CreateIndex
CREATE INDEX "document_retrieval_chunks_firmId_idx" ON "document_retrieval_chunks"("firmId");

-- CreateIndex
CREATE INDEX "document_retrieval_chunks_baseArtifactId_idx" ON "document_retrieval_chunks"("baseArtifactId");

-- CreateIndex
CREATE INDEX "document_retrieval_chunks_documentId_vectorGeneration_idx" ON "document_retrieval_chunks"("documentId", "vectorGeneration");

-- CreateIndex
CREATE INDEX "document_retrieval_chunks_firmId_formType_pageStart_pageEnd_idx" ON "document_retrieval_chunks"("firmId", "formType", "pageStart", "pageEnd");

-- CreateIndex
CREATE INDEX "document_retrieval_chunks_parserVersion_chunkStrategy_idx" ON "document_retrieval_chunks"("parserVersion", "chunkStrategy");

-- CreateIndex
CREATE INDEX "document_vector_indexes_documentId_idx" ON "document_vector_indexes"("documentId");

-- CreateIndex
CREATE INDEX "document_vector_indexes_firmId_namespace_idx" ON "document_vector_indexes"("firmId", "namespace");

-- CreateIndex
CREATE INDEX "document_vector_indexes_status_idx" ON "document_vector_indexes"("status");

-- CreateIndex
CREATE INDEX "document_vector_indexes_documentId_isActive_idx" ON "document_vector_indexes"("documentId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "document_vector_indexes_documentId_indexName_namespace_generation_key" ON "document_vector_indexes"("documentId", "indexName", "namespace", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "document_vector_indexes_one_active_generation_idx" ON "document_vector_indexes"("documentId", "indexName", "namespace") WHERE "isActive" = true;

-- AddCheck
ALTER TABLE "document_base_artifacts" ADD CONSTRAINT "document_base_artifacts_generation_positive_check" CHECK ("generation" > 0);

-- AddCheck
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_vector_generation_positive_check" CHECK ("vectorGeneration" > 0);

-- AddCheck
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_page_span_check" CHECK ("pageStart" > 0 AND "pageEnd" >= "pageStart");

-- AddCheck
ALTER TABLE "document_vector_indexes" ADD CONSTRAINT "document_vector_indexes_generation_positive_check" CHECK ("generation" > 0);

-- AddCheck
ALTER TABLE "document_vector_indexes" ADD CONSTRAINT "document_vector_indexes_embedding_dim_positive_check" CHECK ("embeddingDim" > 0);

-- AddCheck
ALTER TABLE "document_vector_indexes" ADD CONSTRAINT "document_vector_indexes_active_status_check" CHECK ("isActive" = ("status" = 'ACTIVE'));

-- AddForeignKey
ALTER TABLE "document_base_artifacts" ADD CONSTRAINT "document_base_artifacts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_base_artifacts" ADD CONSTRAINT "document_base_artifacts_documentId_firmId_fkey" FOREIGN KEY ("documentId", "firmId") REFERENCES "documents"("id", "firmId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_base_artifacts" ADD CONSTRAINT "document_base_artifacts_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "firms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_documentId_firmId_fkey" FOREIGN KEY ("documentId", "firmId") REFERENCES "documents"("id", "firmId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "firms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_baseArtifactId_fkey" FOREIGN KEY ("baseArtifactId") REFERENCES "document_base_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retrieval_chunks" ADD CONSTRAINT "document_retrieval_chunks_baseArtifactId_documentId_firmId_fkey" FOREIGN KEY ("baseArtifactId", "documentId", "firmId") REFERENCES "document_base_artifacts"("id", "documentId", "firmId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_vector_indexes" ADD CONSTRAINT "document_vector_indexes_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_vector_indexes" ADD CONSTRAINT "document_vector_indexes_documentId_firmId_fkey" FOREIGN KEY ("documentId", "firmId") REFERENCES "documents"("id", "firmId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_vector_indexes" ADD CONSTRAINT "document_vector_indexes_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "firms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
