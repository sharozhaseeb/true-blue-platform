-- CreateEnum
CREATE TYPE "ChatThreadStatus" AS ENUM (
    'ACTIVE',
    'ARCHIVED',
    'DELETED'
);

-- CreateEnum
CREATE TYPE "ChatMessageRole" AS ENUM (
    'USER',
    'ASSISTANT',
    'SYSTEM',
    'TOOL'
);

-- CreateTable
CREATE TABLE "chat_threads" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestKey" TEXT,
    "title" TEXT NOT NULL,
    "status" "ChatThreadStatus" NOT NULL DEFAULT 'ACTIVE',
    "documentFilter" JSONB,
    "nextMessageSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "role" "ChatMessageRole" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "requestKey" TEXT,
    "content" TEXT NOT NULL,
    "uiMessage" JSONB NOT NULL,
    "retrievedChunkIds" JSONB,
    "citations" JSONB,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_threads_id_firmId_key" ON "chat_threads"("id", "firmId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_threads_firmId_userId_requestKey_key" ON "chat_threads"("firmId", "userId", "requestKey");

-- CreateIndex
CREATE INDEX "chat_threads_firmId_updatedAt_idx" ON "chat_threads"("firmId", "updatedAt");

-- CreateIndex
CREATE INDEX "chat_threads_userId_updatedAt_idx" ON "chat_threads"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "chat_threads_status_idx" ON "chat_threads"("status");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_threadId_sequence_key" ON "chat_messages"("threadId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_threadId_role_requestKey_key" ON "chat_messages"("threadId", "role", "requestKey");

-- CreateIndex
CREATE INDEX "chat_messages_firmId_createdAt_idx" ON "chat_messages"("firmId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_messages_threadId_createdAt_idx" ON "chat_messages"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_messages_role_idx" ON "chat_messages"("role");

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "firms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_threadId_firmId_fkey" FOREIGN KEY ("threadId", "firmId") REFERENCES "chat_threads"("id", "firmId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "firms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraints
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_title_not_blank_check" CHECK (length(btrim("title")) > 0);
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_next_message_sequence_nonnegative_check" CHECK ("nextMessageSequence" >= 0);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sequence_nonnegative_check" CHECK ("sequence" >= 0);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_content_not_blank_check" CHECK (length(btrim("content")) > 0);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_input_tokens_nonnegative_check" CHECK ("inputTokens" IS NULL OR "inputTokens" >= 0);
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_output_tokens_nonnegative_check" CHECK ("outputTokens" IS NULL OR "outputTokens" >= 0);
