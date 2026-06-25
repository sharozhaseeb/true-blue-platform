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

const { ChatMessageRole, ChatThreadStatus } = require("@prisma/client");
const {
  appendAssistantMessageToThread,
  appendUserMessageToThread,
  createChatThreadWithUserMessage,
  loadChatThreadForUser,
  normalizeChatDocumentFilter,
  normalizeUserMessageContent,
} = require(path.join(repoRoot, "src/lib/chat-persistence.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function createMockDb() {
  const calls = [];
  const threads = new Map();
  const messagesByThread = new Map();
  let threadCounter = 0;

  const makeThread = (data, id = `thread_${++threadCounter}`) => {
    const thread = {
      id,
      firmId: data.firm.connect.id,
      userId: data.user.connect.id,
      requestKey: data.requestKey ?? null,
      title: data.title,
      status: data.status,
      documentFilter: data.documentFilter,
      nextMessageSequence: data.nextMessageSequence ?? 0,
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      messages: [],
    };
    const firstMessage = data.messages?.create;
    if (firstMessage) {
      thread.messages.push({
        id: "message_0",
        threadId: id,
        firmId: firstMessage.firm.connect.id,
        role: firstMessage.role,
        sequence: firstMessage.sequence,
        content: firstMessage.content,
        uiMessage: firstMessage.uiMessage,
        retrievedChunkIds: null,
        citations: null,
        requestKey: firstMessage.requestKey ?? null,
        model: null,
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
      });
    }
    threads.set(id, thread);
    messagesByThread.set(id, [...thread.messages]);

    return thread;
  };

  const tx = {
    chatThread: {
      async create(args) {
        calls.push({ type: "thread.create", args });
        const duplicateRequestKey = [...threads.values()].find(
          (thread) =>
            thread.firmId === args.data.firm.connect.id &&
            thread.userId === args.data.user.connect.id &&
            thread.requestKey &&
            thread.requestKey === args.data.requestKey
        );
        if (duplicateRequestKey) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }

        return makeThread(args.data);
      },
      async findUnique(args) {
        calls.push({ type: "thread.findUnique", args });
        const key = args.where.firmId_userId_requestKey;
        const thread = [...threads.values()].find(
          (candidate) =>
            candidate.firmId === key.firmId &&
            candidate.userId === key.userId &&
            candidate.requestKey === key.requestKey &&
            candidate.status === args.where.status
        );
        if (!thread) return null;

        return {
          ...thread,
          messages: [...(messagesByThread.get(thread.id) ?? [])].sort(
            (left, right) => left.sequence - right.sequence
          ),
        };
      },
      async findFirst(args) {
        calls.push({ type: "thread.findFirst", args });
        const thread = threads.get(args.where.id);
        if (!thread) return null;
        if (thread.firmId !== args.where.firmId) return null;
        if (args.where.userId && thread.userId !== args.where.userId) return null;
        if (args.where.status && thread.status !== args.where.status) return null;

        return {
          id: thread.id,
          firmId: thread.firmId,
          userId: thread.userId,
          status: thread.status,
          nextMessageSequence: thread.nextMessageSequence,
        };
      },
      async updateMany(args) {
        calls.push({ type: "thread.updateMany", args });
        const thread = threads.get(args.where.id);
        if (
          !thread ||
          thread.firmId !== args.where.firmId ||
          thread.userId !== args.where.userId ||
          thread.status !== args.where.status ||
          thread.nextMessageSequence !== args.where.nextMessageSequence
        ) {
          return { count: 0 };
        }

        thread.nextMessageSequence += args.data.nextMessageSequence.increment;
        thread.updatedAt = args.data.updatedAt;
        return { count: 1 };
      },
      async update(args) {
        calls.push({ type: "thread.update", args });
        const thread = threads.get(args.where.id);
        if (thread) {
          if (args.data.nextMessageSequence?.increment) {
            thread.nextMessageSequence += args.data.nextMessageSequence.increment;
          }
          if (args.data.updatedAt) {
            thread.updatedAt = args.data.updatedAt;
          }
        }
        return { nextMessageSequence: thread.nextMessageSequence };
      },
    },
    chatMessage: {
      async findUnique(args) {
        calls.push({ type: "message.findUnique", args });
        const key = args.where.threadId_role_requestKey;
        const messages = messagesByThread.get(key.threadId) ?? [];
        return (
          messages.find(
            (message) =>
              message.requestKey === key.requestKey && message.role === key.role
          ) ??
          null
        );
      },
      async create(args) {
        calls.push({ type: "message.create", args });
        const threadId = args.data.thread.connect.id_firmId.id;
        const messages = messagesByThread.get(threadId) ?? [];
        const message = {
          id: `message_${args.data.sequence}`,
          threadId,
          firmId: args.data.firm.connect.id,
          role: args.data.role,
          sequence: args.data.sequence,
          content: args.data.content,
          uiMessage: args.data.uiMessage,
          retrievedChunkIds: args.data.retrievedChunkIds ?? null,
          citations: args.data.citations ?? null,
          requestKey: args.data.requestKey ?? null,
          model: args.data.model ?? null,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        };
        messages.push(message);
        messagesByThread.set(threadId, messages);
        return message;
      },
      },
      user: {
        async count(args) {
          calls.push({ type: "user.count", args });
          return args.where.id === "user_a" &&
            args.where.firmId === "firm_a" &&
            args.where.isActive === true
            ? 1
            : 0;
        },
      },
      documentRetrievalChunk: {
        async findMany(args) {
          calls.push({ type: "chunk.findMany", args });
          const validChunks = {
            chunk_a: {
              id: "chunk_a",
              firmId: "firm_a",
              documentId: "doc_a",
              formType: "Form 1040",
              pageStart: 1,
              pageEnd: 1,
              content: "Filing status: Single",
              sourceBlockIds: ["field_1", "value_1"],
            },
            chunk_b: {
              id: "chunk_b",
              firmId: "firm_a",
              documentId: "doc_b",
              formType: "Schedule C",
              pageStart: 3,
              pageEnd: 3,
              content: "Schedule C income",
              sourceBlockIds: ["field_b"],
            },
            chunk_x: {
              id: "chunk_x",
              firmId: "firm_b",
              documentId: "doc_x",
              formType: "Form 1040",
              pageStart: 1,
              pageEnd: 1,
              content: "Cross-firm content",
              sourceBlockIds: ["field_x"],
            },
          };
          return args.where.id.in.flatMap((chunkId) => {
            const chunk = validChunks[chunkId];
            if (!chunk || chunk.firmId !== args.where.firmId) return [];
            return [chunk];
          });
        },
      },
    };

  return {
    calls,
    threads,
    messagesByThread,
    db: {
      async $transaction(callback) {
        return callback(tx);
      },
      chatThread: {
        async findFirst(args) {
          calls.push({ type: "db.thread.findFirst", args });
          const thread = threads.get(args.where.id);
          if (!thread) return null;
          if (thread.firmId !== args.where.firmId) return null;
          if (args.where.userId && thread.userId !== args.where.userId) return null;
          if (args.where.status && thread.status !== args.where.status) return null;

          const orderedMessages = [...(messagesByThread.get(thread.id) ?? [])]
            .sort((left, right) =>
              args.include.messages.orderBy.sequence === "desc"
                ? right.sequence - left.sequence
                : left.sequence - right.sequence
            )
            .slice(0, args.include.messages.take ?? undefined);

          return {
            ...thread,
            messages: orderedMessages,
          };
        },
      },
      document: {
        async count(args) {
          calls.push({ type: "document.count", args });
          const validIds = new Set(["doc_a", "doc_b"]);
          return args.where.id.in.filter(
            (documentId) =>
              validIds.has(documentId) &&
              args.where.firmId === "firm_a" &&
              args.where.status === "COMPLETED"
          ).length;
        },
      async findMany(args) {
        calls.push({ type: "document.findMany", args });
        if (args.where.firmId !== "firm_a" || args.where.status !== "COMPLETED") {
          return [];
        }

          const rows = Array.from({ length: 30 }, (_, index) => ({
            id: `doc_${index}`,
          }));
          rows[0] = { id: "doc_a" };
          rows[1] = { id: "doc_b" };
          return rows.slice(0, args.take ?? rows.length);
      },
      },
      user: {
        async count(args) {
          calls.push({ type: "db.user.count", args });
          return args.where.id === "user_a" &&
            args.where.firmId === "firm_a" &&
            args.where.isActive === true
            ? 1
            : 0;
        },
      },
      documentRetrievalChunk: {
        async findMany(args) {
          calls.push({ type: "db.chunk.findMany", args });
          const validChunks = {
            chunk_a: {
              id: "chunk_a",
              firmId: "firm_a",
              documentId: "doc_a",
              formType: "Form 1040",
              pageStart: 1,
              pageEnd: 1,
              content: "Filing status: Single",
              sourceBlockIds: ["field_1", "value_1"],
            },
            chunk_b: {
              id: "chunk_b",
              firmId: "firm_a",
              documentId: "doc_b",
              formType: "Schedule C",
              pageStart: 3,
              pageEnd: 3,
              content: "Schedule C income",
              sourceBlockIds: ["field_b"],
            },
            chunk_x: {
              id: "chunk_x",
              firmId: "firm_b",
              documentId: "doc_x",
              formType: "Form 1040",
              pageStart: 1,
              pageEnd: 1,
              content: "Cross-firm content",
              sourceBlockIds: ["field_x"],
            },
          };
          return args.where.id.in.flatMap((chunkId) => {
            const chunk = validChunks[chunkId];
            if (!chunk || chunk.firmId !== args.where.firmId) return [];
            return [chunk];
          });
        },
      },
    },
  };
}

async function expectThrows(action, expectedMessage, failures) {
  try {
    await action();
    failures.push(`expected throw: ${expectedMessage}`);
  } catch (error) {
    assertCondition(
      String(error.message || error).includes(expectedMessage),
      `unexpected error for ${expectedMessage}: ${String(error.message || error)}`,
      failures
    );
  }
}

async function main() {
  const failures = [];
  const fixture = createMockDb();

  assertCondition(
    normalizeUserMessageContent("  What is my filing status?  ") ===
      "What is my filing status?",
    "message content was not trimmed",
    failures
  );

  await expectThrows(
    () => normalizeUserMessageContent(" "),
    "Chat message cannot be empty",
    failures
  );
  await expectThrows(
    () => normalizeUserMessageContent("x".repeat(8001)),
    "exceeds 8000 characters",
    failures
  );
  await expectThrows(
    () =>
      normalizeChatDocumentFilter({
        documentIds: Array.from({ length: 26 }, (_, index) => `doc_${index}`),
      }),
    "invalid document IDs",
    failures
  );

  await expectThrows(
    () =>
      createChatThreadWithUserMessage(
        {
          firmId: "firm_a",
          userId: "user_a",
          messageContent: "Invalid document",
          documentFilter: { documentIds: ["doc_a", "doc_a"] },
        },
        fixture.db
      ),
    "duplicate document IDs",
    failures
  );

  await expectThrows(
    () =>
      createChatThreadWithUserMessage(
        {
          firmId: "firm_a",
          userId: "user_a",
          messageContent: "Cross-firm document",
          documentFilter: { documentIds: ["doc_x"] },
        },
        fixture.db
      ),
    "unknown, cross-firm, or unprocessed documents",
    failures
  );

  await expectThrows(
    () =>
      createChatThreadWithUserMessage(
        {
          firmId: "firm_b",
          userId: "user_a",
          messageContent: "Cross-firm user",
        },
        fixture.db
      ),
    "Chat user does not belong to firm",
    failures
  );
  await expectThrows(
    () => normalizeChatDocumentFilter({ pageRange: { start: 3, end: 1 } }),
    "invalid page range",
    failures
  );

  const thread = await createChatThreadWithUserMessage(
    {
      firmId: "firm_a",
      userId: "user_a",
      messageContent: "  What is my filing status?  ",
      documentFilter: { documentIds: ["doc_a"], pageRange: { start: 1, end: 2 } },
      requestKey: "req-thread-1",
    },
    fixture.db
  );
  const defaultScopedThread = await createChatThreadWithUserMessage(
    {
      firmId: "firm_a",
      userId: "user_a",
      messageContent: "Default document scope",
      requestKey: "req-thread-default-scope",
    },
    fixture.db
  );
  assertCondition(
    defaultScopedThread.documentFilter?.documentIds?.length === 25,
    "default document scope should be capped at MAX_CHAT_DOCUMENT_FILTER_IDS",
    failures
  );

  const repeatedThread = await createChatThreadWithUserMessage(
    {
      firmId: "firm_a",
      userId: "user_a",
      messageContent: "  What is my filing status?  ",
      documentFilter: { documentIds: ["doc_a"], pageRange: { start: 1, end: 2 } },
      requestKey: "req-thread-1",
    },
    fixture.db
  );
  assertCondition(
    repeatedThread.id === thread.id,
    "thread creation request key did not return existing thread",
    failures
  );
  const archivedThread = fixture.threads.get(thread.id);
  archivedThread.status = ChatThreadStatus.ARCHIVED;
  try {
    await createChatThreadWithUserMessage(
      {
        firmId: "firm_a",
        userId: "user_a",
        messageContent: "Retry after archive",
        requestKey: "req-thread-1",
      },
      fixture.db
    );
    failures.push("archived idempotent thread retry should not return inactive thread");
  } catch (error) {
    assertCondition(
      String(error.message || error).includes("inactive thread"),
      "archived retry raised unexpected error",
      failures
    );
  } finally {
    archivedThread.status = ChatThreadStatus.ACTIVE;
  }

  const unfilteredThread = await createChatThreadWithUserMessage(
    {
      firmId: "firm_a",
      userId: "user_a",
      messageContent: "Unfiltered question",
    },
    fixture.db
  );
  assertCondition(
    unfilteredThread.documentFilter !== undefined,
    "unfiltered thread did not persist nullable document filter safely",
    failures
  );

  assertCondition(thread.firmId === "firm_a", "thread firm mismatch", failures);
  assertCondition(thread.userId === "user_a", "thread user mismatch", failures);
  assertCondition(
    thread.status === ChatThreadStatus.ACTIVE,
    "thread status mismatch",
    failures
  );
  assertCondition(
    thread.nextMessageSequence === 1,
    "thread did not reserve next sequence after initial message",
    failures
  );
  assertCondition(
    thread.messages.length === 1 &&
      thread.messages[0].role === ChatMessageRole.USER &&
      thread.messages[0].sequence === 0 &&
      thread.messages[0].requestKey === "req-thread-1",
    "initial user message was not created at sequence 0",
    failures
  );

  const userMessage = await appendUserMessageToThread(
    {
      firmId: "firm_a",
      userId: "user_a",
      threadId: thread.id,
      messageContent: "Show income",
      requestKey: "req-user-2",
    },
    fixture.db
  );
  const repeatedUserMessage = await appendUserMessageToThread(
    {
      firmId: "firm_a",
      userId: "user_a",
      threadId: thread.id,
      messageContent: "Show income",
      requestKey: "req-user-2",
    },
    fixture.db
  );
  assertCondition(
    repeatedUserMessage.id === userMessage.id,
    "user append request key did not return existing message",
    failures
  );
  assertCondition(
    userMessage.sequence === 1 &&
      userMessage.role === ChatMessageRole.USER &&
      userMessage.requestKey === "req-user-2",
    "appended user message did not use next sequence",
    failures
  );
  assertCondition(
    fixture.threads.get(thread.id).nextMessageSequence === 2,
    "thread counter was not atomically incremented for user append",
    failures
  );

  await expectThrows(
    () =>
      appendUserMessageToThread(
        {
          firmId: "firm_a",
          userId: "user_b",
          threadId: thread.id,
          messageContent: "Cross user access",
        },
        fixture.db
      ),
    "Chat user does not belong to firm",
    failures
  );
  await expectThrows(
    () =>
      appendUserMessageToThread(
        {
          firmId: "firm_a",
          userId: "user_b",
          threadId: thread.id,
          messageContent: "Cross user request-key access",
          requestKey: "req-user-2",
        },
        fixture.db
      ),
    "Chat user does not belong to firm",
    failures
  );

  const assistantMessage = await appendAssistantMessageToThread(
    {
      firmId: "firm_a",
      threadId: thread.id,
      userId: "user_a",
      content: "The document shows Single filing status.",
      retrievedChunkIds: ["chunk_a"],
      citations: [
        {
          chunkId: "chunk_a",
          documentId: "doc_a",
          pageStart: 1,
          pageEnd: 1,
          snippet: "Filing status: Single",
          sourceBlockIds: ["field_1", "value_1"],
        },
      ],
      model: "local-evidence-v0",
      inputTokens: 10,
      outputTokens: 7,
      requestKey: "req-user-2",
    },
    fixture.db
  );
  const repeatedAssistantMessage = await appendAssistantMessageToThread(
    {
      firmId: "firm_a",
      threadId: thread.id,
      userId: "user_a",
      content: "Changed retry content should not matter.",
      retrievedChunkIds: ["chunk_x"],
      citations: [],
      requestKey: "req-user-2",
    },
    fixture.db
  );
  assertCondition(
    repeatedAssistantMessage.id === assistantMessage.id,
    "assistant append request key did not return existing message",
    failures
  );

  assertCondition(
    assistantMessage.sequence === 2 &&
      assistantMessage.role === ChatMessageRole.ASSISTANT &&
      assistantMessage.requestKey === "req-user-2" &&
      assistantMessage.retrievedChunkIds[0] === "chunk_a" &&
      assistantMessage.citations[0].sourceBlockIds.length === 2,
    "assistant message lost retrieval/citation metadata",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Mismatched citation document",
          retrievedChunkIds: ["chunk_a"],
          citations: [
            {
              chunkId: "chunk_a",
              documentId: "doc_b",
              pageStart: 1,
              pageEnd: 1,
              snippet: "Bad doc",
              sourceBlockIds: ["field_a"],
            },
          ],
        },
        fixture.db
      ),
    "do not match retrieved chunk documents",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Forged citation page span",
          retrievedChunkIds: ["chunk_a"],
          citations: [
            {
              chunkId: "chunk_a",
              documentId: "doc_a",
              pageStart: 2,
              pageEnd: 2,
              snippet: "Bad page",
              sourceBlockIds: ["field_a"],
            },
          ],
        },
        fixture.db
      ),
    "do not match retrieved chunk pages",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Forged citation source blocks",
          retrievedChunkIds: ["chunk_a"],
          citations: [
            {
              chunkId: "chunk_a",
              documentId: "doc_a",
              pageStart: 1,
              pageEnd: 1,
              snippet: "Filing status: Single",
              sourceBlockIds: ["wrong_block"],
            },
          ],
        },
        fixture.db
      ),
    "do not match retrieved chunk source blocks",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Forged citation snippet",
          retrievedChunkIds: ["chunk_a"],
          citations: [
            {
              chunkId: "chunk_a",
              documentId: "doc_a",
              pageStart: 1,
              pageEnd: 1,
              snippet: "Not in chunk",
              sourceBlockIds: ["field_1", "value_1"],
            },
          ],
        },
        fixture.db
      ),
    "do not match retrieved chunk snippets",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Out of filter citation",
          retrievedChunkIds: ["chunk_b"],
          citations: [
            {
              chunkId: "chunk_b",
              documentId: "doc_b",
              pageStart: 1,
              pageEnd: 1,
              snippet: "Other doc",
              sourceBlockIds: ["field_b"],
            },
          ],
        },
        fixture.db
      ),
    "documents outside the thread filter",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Mixed retrieved evidence",
          retrievedChunkIds: ["chunk_a", "chunk_b"],
          citations: [
            {
              chunkId: "chunk_a",
              documentId: "doc_a",
              pageStart: 1,
              pageEnd: 1,
              snippet: "Valid cited chunk",
              sourceBlockIds: ["field_a"],
            },
          ],
        },
        fixture.db
      ),
    "documents outside the thread filter",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_a",
          content: "Cross-firm chunk",
          retrievedChunkIds: ["chunk_x"],
          citations: [
            {
              chunkId: "chunk_x",
              documentId: "doc_a",
              pageStart: 1,
              pageEnd: 1,
              snippet: "Bad chunk",
              sourceBlockIds: ["field_x"],
            },
          ],
        },
        fixture.db
      ),
    "unknown or cross-firm chunks",
    failures
  );

  const formScopedThread = await createChatThreadWithUserMessage(
    {
      firmId: "firm_a",
      userId: "user_a",
      messageContent: "Schedule C only",
      documentFilter: { documentIds: ["doc_b"], formTypes: ["Form 1040"] },
    },
    fixture.db
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: formScopedThread.id,
          userId: "user_a",
          content: "Wrong form type",
          retrievedChunkIds: ["chunk_b"],
          citations: [
            {
              chunkId: "chunk_b",
              documentId: "doc_b",
              pageStart: 3,
              pageEnd: 3,
              snippet: "Schedule C",
              sourceBlockIds: ["field_b"],
            },
          ],
        },
        fixture.db
      ),
    "form types outside the thread filter",
    failures
  );

  const pageScopedThread = await createChatThreadWithUserMessage(
    {
      firmId: "firm_a",
      userId: "user_a",
      messageContent: "Page 1 only",
      documentFilter: { documentIds: ["doc_b"], pageRange: { start: 1, end: 1 } },
    },
    fixture.db
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: pageScopedThread.id,
          userId: "user_a",
          content: "Wrong page",
          retrievedChunkIds: ["chunk_b"],
          citations: [
            {
              chunkId: "chunk_b",
              documentId: "doc_b",
              pageStart: 3,
              pageEnd: 3,
              snippet: "Page 3",
              sourceBlockIds: ["field_b"],
            },
          ],
        },
        fixture.db
      ),
    "pages outside the thread filter",
    failures
  );

  await expectThrows(
    () =>
      appendAssistantMessageToThread(
        {
          firmId: "firm_a",
          threadId: thread.id,
          userId: "user_b",
          content: "Cross-user assistant write",
          retrievedChunkIds: [],
          citations: [],
        },
        fixture.db
      ),
    "Chat user does not belong to firm",
    failures
  );

  const laterUserMessage = await appendUserMessageToThread(
    {
      firmId: "firm_a",
      userId: "user_a",
      threadId: thread.id,
      messageContent: "Final context turn",
    },
    fixture.db
  );
  assertCondition(
    laterUserMessage.sequence === 3,
    "later user message did not continue sequence",
    failures
  );

  const loadedThread = await loadChatThreadForUser(
    {
      firmId: "firm_a",
      userId: "user_a",
      threadId: thread.id,
    },
    fixture.db
  );
  assertCondition(
    loadedThread?.messages.length === 4,
    "thread loader did not enforce ownership or load messages",
    failures
  );

  const limitedThread = await loadChatThreadForUser(
    {
      firmId: "firm_a",
      userId: "user_a",
      threadId: thread.id,
      messageLimit: 2,
    },
    fixture.db
  );
  assertCondition(
    JSON.stringify(limitedThread?.messages.map((message) => message.sequence)) ===
      JSON.stringify([2, 3]),
    "limited thread loader did not return latest messages in ascending order",
    failures
  );

  const zeroLimitThread = await loadChatThreadForUser(
    {
      firmId: "firm_a",
      userId: "user_a",
      threadId: thread.id,
      messageLimit: 0,
    },
    fixture.db
  );
  assertCondition(
    zeroLimitThread?.messages.length === 1 &&
      zeroLimitThread.messages[0].sequence === 3,
    "zero message limit should clamp to one latest message",
    failures
  );

  const crossTenantThread = await loadChatThreadForUser(
    {
      firmId: "firm_b",
      userId: "user_a",
      threadId: thread.id,
    },
    fixture.db
  );
  assertCondition(crossTenantThread === null, "cross-tenant thread loaded", failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Chat persistence verified: scoped threads, append-only messages, citations");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
