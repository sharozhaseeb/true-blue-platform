import { ChatMessageRole, ChatThreadStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BaseDocumentCitation } from "@/lib/base-document-retrieval";
import {
  normalizeOutputTemplateSelection,
  type OutputTemplateSelection,
} from "@/lib/chat-output-templates";

export const MAX_CHAT_MESSAGE_LENGTH = 8000;
export const MAX_CHAT_DOCUMENT_FILTER_IDS = 25;
export const MAX_CHAT_HISTORY_MESSAGES = 12;
const DEFAULT_THREAD_TITLE = "New document chat";

export type ChatDocumentFilter = {
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: {
    start: number;
    end: number;
  };
};

export type ChatUiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type EvidenceCoverageV1 = {
  version: 1;
  selectedDocumentIds: string[];
  retrievedByDocumentId: Record<string, number>;
  finalByDocumentId: Record<string, number>;
  noEvidenceDocumentIds: string[];
};

export type PersistedChatMessage = {
  id: string;
  role: ChatMessageRole;
  sequence: number;
  requestKey: string | null;
  content: string;
  uiMessage: unknown;
  retrievedChunkIds: unknown;
  citations: unknown;
  evidenceCoverage: unknown;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
};

export type PersistedChatThread = {
  id: string;
  firmId: string;
  userId: string;
  requestKey: string | null;
  title: string;
  status: ChatThreadStatus;
  documentFilter: unknown;
  outputTemplate: unknown;
  nextMessageSequence: number;
  createdAt: Date;
  updatedAt: Date;
  messages: PersistedChatMessage[];
};

export interface CreateChatThreadInput {
  firmId: string;
  userId: string;
  messageContent: string;
  documentFilter?: ChatDocumentFilter | null;
  outputTemplate?: OutputTemplateSelection | null;
  title?: string | null;
  requestKey?: string | null;
}

export interface AppendUserMessageInput {
  firmId: string;
  userId: string;
  threadId: string;
  messageContent: string;
  requestKey?: string | null;
}

export interface AppendAssistantMessageInput {
  firmId: string;
  threadId: string;
  content: string;
  userId: string;
  retrievedChunkIds: string[];
  citations: BaseDocumentCitation[];
  evidenceCoverage?: EvidenceCoverageV1 | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  requestKey?: string | null;
}

export interface LoadAssistantMessageByRequestKeyInput {
  firmId: string;
  userId: string;
  threadId: string;
  requestKey?: string | null;
}

type ChatPersistenceTransaction = {
  chatThread: {
    findFirst(args: {
      where: {
        id: string;
        firmId: string;
        userId: string;
        status?: ChatThreadStatus;
      };
      select: {
        id: true;
        firmId: true;
        userId: true;
        status: true;
        nextMessageSequence?: true;
      };
    }): Promise<{
      id: string;
      firmId: string;
      userId: string;
      status: ChatThreadStatus;
      nextMessageSequence?: number;
    } | null>;
    findUnique(args: {
      where: {
        firmId_userId_requestKey: {
          firmId: string;
          userId: string;
          requestKey: string;
        };
        status: ChatThreadStatus;
      };
      include: { messages: { orderBy: { sequence: "asc" } } };
    }): Promise<PersistedChatThread | null>;
    update(args: {
      where: { id: string };
      data: {
        nextMessageSequence?: { increment: number };
        updatedAt?: Date;
      };
      select: { nextMessageSequence: true };
    }): Promise<{ nextMessageSequence: number }>;
    updateMany(args: {
      where: {
        id: string;
        firmId: string;
        userId: string;
        status: ChatThreadStatus;
        nextMessageSequence: number;
      };
      data: {
        nextMessageSequence: { increment: number };
        updatedAt: Date;
      };
    }): Promise<{ count: number }>;
    create(args: {
      data: Prisma.ChatThreadCreateInput;
      include: { messages: { orderBy: { sequence: "asc" } } };
    }): Promise<PersistedChatThread>;
  };
  chatMessage: {
    findUnique(args: {
      where: {
        threadId_role_requestKey: {
          threadId: string;
          role: ChatMessageRole;
          requestKey: string;
        };
      };
    }): Promise<PersistedChatMessage | null>;
    create(args: {
      data: Prisma.ChatMessageCreateInput;
    }): Promise<PersistedChatMessage>;
  };
  user: {
    count(args: {
      where: {
        id: string;
        firmId: string;
        isActive: true;
      };
    }): Promise<number>;
  };
  documentRetrievalChunk: {
    findMany(args: {
      where: {
        id: { in: string[] };
        firmId: string;
      };
      select: {
        id: true;
        documentId: true;
        formType: true;
        pageStart: true;
        pageEnd: true;
        content: true;
        sourceBlockIds: true;
      };
    }): Promise<
      Array<{
        id: string;
        documentId: string;
        formType: string | null;
        pageStart: number;
        pageEnd: number;
        content: string;
        sourceBlockIds: unknown;
      }>
    >;
  };
};

type ChatPersistenceDb = {
  $transaction<T>(
    callback: (tx: ChatPersistenceTransaction) => Promise<T>
  ): Promise<T>;
  chatThread: {
    findFirst(args: {
      where: {
        id: string;
        firmId: string;
        userId?: string;
        status?: ChatThreadStatus;
      };
      include: {
        messages: {
          orderBy: { sequence: "asc" | "desc" };
          take?: number;
        };
      };
    }): Promise<PersistedChatThread | null>;
  };
  document: {
    count(args: {
      where: {
        id: { in: string[] };
        firmId: string;
        status: "COMPLETED";
      };
    }): Promise<number>;
    findMany(args: {
      where: {
        firmId: string;
        status: "COMPLETED";
      };
      select: { id: true };
      orderBy: { createdAt: "asc" };
      take?: number;
    }): Promise<Array<{ id: string }>>;
  };
  user: {
    count(args: {
      where: {
        id: string;
        firmId: string;
        isActive: true;
      };
    }): Promise<number>;
  };
  documentRetrievalChunk: {
    findMany(args: {
      where: {
        id: { in: string[] };
        firmId: string;
      };
      select: {
        id: true;
        documentId: true;
        formType: true;
        pageStart: true;
        pageEnd: true;
        content: true;
        sourceBlockIds: true;
      };
    }): Promise<
      Array<{
        id: string;
        documentId: string;
        formType: string | null;
        pageStart: number;
        pageEnd: number;
        content: string;
        sourceBlockIds: unknown;
      }>
    >;
  };
};

function assertFirmUserScope(firmId: string, userId: string): void {
  if (!firmId || !userId) {
    throw new Error("Chat persistence requires firmId and userId");
  }
}

function normalizeRequestKey(requestKey: string | null | undefined): string | null {
  const normalized = requestKey?.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > 120) {
    throw new Error("Chat request key exceeds 120 characters");
  }

  return normalized;
}

function toNullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

export function normalizeUserMessageContent(content: string): string {
  const normalized = content.trim();
  if (normalized.length === 0) {
    throw new Error("Chat message cannot be empty");
  }

  if (normalized.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new Error(
      `Chat message exceeds ${MAX_CHAT_MESSAGE_LENGTH} characters`
    );
  }

  return normalized;
}

function normalizeTitle(title: string | null | undefined, message: string): string {
  const normalized = title?.trim();
  if (normalized) {
    return normalized.slice(0, 120);
  }

  return (message || DEFAULT_THREAD_TITLE).slice(0, 80);
}

export function normalizeChatDocumentFilter(
  filter: ChatDocumentFilter | null | undefined
): ChatDocumentFilter | null {
  if (!filter) {
    return null;
  }

  const documentIds = filter.documentIds
    ?.filter((documentId) => typeof documentId === "string" && documentId.length > 0)
    .slice(0, MAX_CHAT_DOCUMENT_FILTER_IDS);
  if (
    filter.documentIds &&
    (documentIds?.length ?? 0) !== filter.documentIds.length
  ) {
    throw new Error("Document filter contains invalid document IDs");
  }

  const formTypes = filter.formTypes
    ?.filter((formType) => typeof formType === "string" && formType.length > 0)
    .slice(0, 25);
  if (filter.formTypes && (formTypes?.length ?? 0) !== filter.formTypes.length) {
    throw new Error("Document filter contains invalid form types");
  }

  if (filter.pageRange) {
    const { start, end } = filter.pageRange;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start
    ) {
      throw new Error("Document filter contains invalid page range");
    }
  }

  return {
    ...(documentIds && documentIds.length > 0 ? { documentIds } : {}),
    ...(formTypes && formTypes.length > 0 ? { formTypes } : {}),
    ...(filter.pageRange ? { pageRange: filter.pageRange } : {}),
  };
}

export async function validateChatDocumentFilterForFirm(
  firmId: string,
  filter: ChatDocumentFilter | null | undefined,
  db: Pick<ChatPersistenceDb, "document">
): Promise<ChatDocumentFilter | null> {
  const normalized = normalizeChatDocumentFilter(filter);
  const documentIds = normalized?.documentIds;
  if (!documentIds || documentIds.length === 0) {
    const completedDocuments = await db.document.findMany({
      where: {
        firmId,
        status: "COMPLETED",
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: MAX_CHAT_DOCUMENT_FILTER_IDS,
    });

    return {
      ...(normalized ?? {}),
      documentIds: completedDocuments.map((document) => document.id),
    };
  }

  const uniqueDocumentIds = [...new Set(documentIds)];
  if (uniqueDocumentIds.length !== documentIds.length) {
    throw new Error("Document filter contains duplicate document IDs");
  }

  const ownedCompletedCount = await db.document.count({
    where: {
      id: { in: uniqueDocumentIds },
      firmId,
      status: "COMPLETED",
    },
  });

  if (ownedCompletedCount !== uniqueDocumentIds.length) {
    throw new Error(
      "Document filter contains unknown, cross-firm, or unprocessed documents"
    );
  }

  return {
    ...normalized,
    documentIds: uniqueDocumentIds,
  };
}

async function assertUserBelongsToFirm(
  firmId: string,
  userId: string,
  db: Pick<ChatPersistenceDb, "user">
): Promise<void> {
  const userCount = await db.user.count({
    where: {
      id: userId,
      firmId,
      isActive: true,
    },
  });

  if (userCount !== 1) {
    throw new Error("Chat user does not belong to firm");
  }
}

async function validateAssistantEvidenceForFirm(
  input: AppendAssistantMessageInput,
  db: Pick<ChatPersistenceDb, "chatThread" | "documentRetrievalChunk">
): Promise<void> {
  const uniqueChunkIds = [...new Set(input.retrievedChunkIds)];
  if (uniqueChunkIds.length !== input.retrievedChunkIds.length) {
    throw new Error("Assistant evidence contains duplicate chunk IDs");
  }

  const citationChunkIds = input.citations.map((citation) => citation.chunkId);
  const uniqueCitationChunkIds = [...new Set(citationChunkIds)];
  if (uniqueCitationChunkIds.length !== citationChunkIds.length) {
    throw new Error("Assistant citations contain duplicate chunk IDs");
  }

  if (
    uniqueCitationChunkIds.some((chunkId) => !uniqueChunkIds.includes(chunkId))
  ) {
    throw new Error("Assistant citations reference unretrieved chunks");
  }

  const thread = await db.chatThread.findFirst({
    where: {
      id: input.threadId,
      firmId: input.firmId,
      userId: input.userId,
      status: ChatThreadStatus.ACTIVE,
    },
    include: {
      messages: {
        orderBy: { sequence: "asc" },
        take: 0,
      },
    },
  });

  if (!thread) {
    throw new Error("Chat thread not found for firm/user");
  }

  const threadFilter = normalizeChatDocumentFilter(
    thread.documentFilter as ChatDocumentFilter | null | undefined
  );
  const allowedDocumentIds = threadFilter?.documentIds;
  if (uniqueChunkIds.length === 0) {
    return;
  }

  const chunkRows = await db.documentRetrievalChunk.findMany({
    where: {
      id: { in: uniqueChunkIds },
      firmId: input.firmId,
    },
      select: {
        id: true,
        documentId: true,
        formType: true,
        pageStart: true,
        pageEnd: true,
        content: true,
        sourceBlockIds: true,
      },
  });

  if (chunkRows.length !== uniqueChunkIds.length) {
    throw new Error("Assistant evidence contains unknown or cross-firm chunks");
  }

  const chunksById = new Map(chunkRows.map((chunk) => [chunk.id, chunk]));

  for (const chunk of chunkRows) {
    if (allowedDocumentIds && !allowedDocumentIds.includes(chunk.documentId)) {
      throw new Error("Assistant evidence references documents outside the thread filter");
    }
    if (
      threadFilter?.formTypes &&
      (!chunk.formType || !threadFilter.formTypes.includes(chunk.formType))
    ) {
      throw new Error("Assistant evidence references form types outside the thread filter");
    }

    if (
      threadFilter?.pageRange &&
      (chunk.pageStart < threadFilter.pageRange.start ||
        chunk.pageEnd > threadFilter.pageRange.end)
    ) {
      throw new Error("Assistant evidence references pages outside the thread filter");
    }
  }

  for (const citation of input.citations) {
    const chunk = chunksById.get(citation.chunkId);
    if (!chunk) {
      throw new Error("Assistant citations reference unknown chunks");
    }

    if (citation.documentId !== chunk.documentId) {
      throw new Error("Assistant citations do not match retrieved chunk documents");
    }

    if (citation.pageStart !== chunk.pageStart || citation.pageEnd !== chunk.pageEnd) {
      throw new Error("Assistant citations do not match retrieved chunk pages");
    }

    const chunkSourceBlockIds = parseSourceBlockIds(chunk.sourceBlockIds);
    if (
      chunkSourceBlockIds.length === 0 ||
      JSON.stringify(citation.sourceBlockIds) !== JSON.stringify(chunkSourceBlockIds)
    ) {
      throw new Error("Assistant citations do not match retrieved chunk source blocks");
    }

    const snippetCore = citation.snippet.replace(/\.\.\.$/, "").trim();
    if (!snippetCore || !chunk.content.includes(snippetCore)) {
      throw new Error("Assistant citations do not match retrieved chunk snippets");
    }

    if (
      threadFilter?.pageRange &&
      (citation.pageStart < threadFilter.pageRange.start ||
        citation.pageEnd > threadFilter.pageRange.end)
    ) {
      throw new Error("Assistant citations reference pages outside the thread filter");
    }
  }
}

function parseSourceBlockIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (sourceBlockId): sourceBlockId is string =>
      typeof sourceBlockId === "string" && sourceBlockId.length > 0
  );
}

function createUiMessage(
  role: ChatUiMessage["role"],
  content: string,
  sequence: number
): ChatUiMessage {
  return {
    id: `${role}-${sequence}`,
    role,
    content,
  };
}

function isSequenceReservationConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Chat thread sequence reservation conflict")
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function findExistingMessageForOwnedThread(
  input: {
    firmId: string;
    userId: string;
    threadId: string;
    role: ChatMessageRole;
    requestKey: string;
  },
  tx: ChatPersistenceTransaction
): Promise<PersistedChatMessage | null> {
  const thread = await tx.chatThread.findFirst({
    where: {
      id: input.threadId,
      firmId: input.firmId,
      userId: input.userId,
      status: ChatThreadStatus.ACTIVE,
    },
    select: {
      id: true,
      firmId: true,
      userId: true,
      status: true,
    },
  });

  if (!thread) {
    throw new Error("Chat thread not found for firm/user");
  }

  return tx.chatMessage.findUnique({
    where: {
      threadId_role_requestKey: {
        threadId: input.threadId,
        role: input.role,
        requestKey: input.requestKey,
      },
    },
  });
}

async function findExistingThreadByRequestKey(
  input: {
    firmId: string;
    userId: string;
    requestKey: string;
  },
  tx: ChatPersistenceTransaction
): Promise<PersistedChatThread | null> {
  return tx.chatThread.findUnique({
    where: {
      firmId_userId_requestKey: {
        firmId: input.firmId,
        userId: input.userId,
        requestKey: input.requestKey,
      },
      status: ChatThreadStatus.ACTIVE,
    },
    include: { messages: { orderBy: { sequence: "asc" } } },
  });
}

export async function createChatThreadWithUserMessage(
  input: CreateChatThreadInput,
  db: ChatPersistenceDb = prisma
): Promise<PersistedChatThread> {
  assertFirmUserScope(input.firmId, input.userId);
  const content = normalizeUserMessageContent(input.messageContent);
  const requestKey = normalizeRequestKey(input.requestKey);
  await assertUserBelongsToFirm(input.firmId, input.userId, db);
  const documentFilter = await validateChatDocumentFilterForFirm(
    input.firmId,
    input.documentFilter,
    db
  );
  const outputTemplate = normalizeOutputTemplateSelection(input.outputTemplate);

  try {
    return await db.$transaction(async (tx) => {
      if (requestKey) {
        const existingThread = await findExistingThreadByRequestKey(
          {
            firmId: input.firmId,
            userId: input.userId,
            requestKey,
          },
          tx
        );

        if (existingThread) {
          return existingThread;
        }
      }

      return tx.chatThread.create({
        data: {
          firm: { connect: { id: input.firmId } },
          user: { connect: { id: input.userId } },
          requestKey,
          title: normalizeTitle(input.title, content),
          status: ChatThreadStatus.ACTIVE,
          documentFilter: toNullableJson(documentFilter),
          outputTemplate: outputTemplate as unknown as Prisma.InputJsonValue,
          nextMessageSequence: 1,
          messages: {
            create: {
              firm: { connect: { id: input.firmId } },
              role: ChatMessageRole.USER,
              sequence: 0,
              requestKey,
              content,
              uiMessage: createUiMessage(
                "user",
                content,
                0
              ) as Prisma.InputJsonValue,
            },
          },
        },
        include: { messages: { orderBy: { sequence: "asc" } } },
      });
    });
  } catch (error) {
    if (requestKey && isUniqueConstraintError(error)) {
      const existingThread = await db.$transaction((tx) =>
        findExistingThreadByRequestKey(
          {
            firmId: input.firmId,
            userId: input.userId,
            requestKey,
          },
          tx
        )
      );

      if (existingThread) {
        return existingThread;
      }

      throw new Error("Chat thread request key belongs to an inactive thread");
    }

    throw error;
  }
}

async function reserveNextSequence(
  tx: ChatPersistenceTransaction,
  firmId: string,
  threadId: string,
  userId: string
): Promise<number> {
  const thread = await tx.chatThread.findFirst({
    where: {
      id: threadId,
      firmId,
      userId,
      status: ChatThreadStatus.ACTIVE,
    },
    select: {
      id: true,
      firmId: true,
      userId: true,
      status: true,
      nextMessageSequence: true,
    },
  });

  if (!thread || thread.nextMessageSequence === undefined) {
    throw new Error("Chat thread not found for firm/user");
  }

  const updateResult = await tx.chatThread.updateMany({
    where: {
      id: threadId,
      firmId,
      userId,
      status: ChatThreadStatus.ACTIVE,
      nextMessageSequence: thread.nextMessageSequence,
    },
    data: {
      nextMessageSequence: { increment: 1 },
      updatedAt: new Date(),
    },
  });

  if (updateResult.count !== 1) {
    throw new Error("Chat thread sequence reservation conflict");
  }

  return thread.nextMessageSequence;
}

export async function appendUserMessageToThread(
  input: AppendUserMessageInput,
  db: ChatPersistenceDb = prisma
): Promise<PersistedChatMessage> {
  assertFirmUserScope(input.firmId, input.userId);
  const content = normalizeUserMessageContent(input.messageContent);
  const requestKey = normalizeRequestKey(input.requestKey);
  await assertUserBelongsToFirm(input.firmId, input.userId, db);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        if (requestKey) {
          const existingMessage = await findExistingMessageForOwnedThread({
            firmId: input.firmId,
            userId: input.userId,
            threadId: input.threadId,
            role: ChatMessageRole.USER,
            requestKey,
          },
          tx);

          if (existingMessage) {
            return existingMessage;
          }
        }

        const sequence = await reserveNextSequence(
          tx,
          input.firmId,
          input.threadId,
          input.userId
        );
        const message = await tx.chatMessage.create({
          data: {
            thread: {
              connect: {
                id_firmId: { id: input.threadId, firmId: input.firmId },
              },
            },
            firm: { connect: { id: input.firmId } },
            role: ChatMessageRole.USER,
            sequence,
            requestKey,
            content,
            uiMessage: createUiMessage(
              "user",
              content,
              sequence
            ) as Prisma.InputJsonValue,
          },
        });

        return message;
      });
    } catch (error) {
      if (requestKey && isUniqueConstraintError(error)) {
        const existingMessage = await db.$transaction((tx) =>
          findExistingMessageForOwnedThread(
            {
              firmId: input.firmId,
              userId: input.userId,
              threadId: input.threadId,
              role: ChatMessageRole.USER,
              requestKey,
            },
            tx
          )
        );

        if (existingMessage) {
          return existingMessage;
        }
      }

      if (attempt < 2 && isSequenceReservationConflict(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Chat thread sequence reservation failed");
}

export async function appendAssistantMessageToThread(
  input: AppendAssistantMessageInput,
  db: ChatPersistenceDb = prisma
): Promise<PersistedChatMessage> {
  assertFirmUserScope(input.firmId, input.userId);
  const content = normalizeUserMessageContent(input.content);
  const requestKey = normalizeRequestKey(input.requestKey);
  await assertUserBelongsToFirm(input.firmId, input.userId, db);
  if (requestKey) {
    const existingMessage = await db.$transaction((tx) =>
      findExistingMessageForOwnedThread(
        {
          firmId: input.firmId,
          userId: input.userId,
          threadId: input.threadId,
          role: ChatMessageRole.ASSISTANT,
          requestKey,
        },
        tx
      )
    );

    if (existingMessage) {
      return existingMessage;
    }
  }

  await validateAssistantEvidenceForFirm(input, db);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        if (requestKey) {
          const existingMessage = await findExistingMessageForOwnedThread(
            {
              firmId: input.firmId,
              userId: input.userId,
              threadId: input.threadId,
              role: ChatMessageRole.ASSISTANT,
              requestKey,
            },
            tx
          );

          if (existingMessage) {
            return existingMessage;
          }
        }

        const sequence = await reserveNextSequence(
          tx,
          input.firmId,
          input.threadId,
          input.userId
        );
        const message = await tx.chatMessage.create({
          data: {
            thread: {
              connect: {
                id_firmId: { id: input.threadId, firmId: input.firmId },
              },
            },
            firm: { connect: { id: input.firmId } },
            role: ChatMessageRole.ASSISTANT,
            sequence,
            requestKey,
            content,
            uiMessage: createUiMessage(
              "assistant",
              content,
              sequence
            ) as Prisma.InputJsonValue,
            retrievedChunkIds: input.retrievedChunkIds as Prisma.InputJsonValue,
            citations: input.citations as unknown as Prisma.InputJsonValue,
            evidenceCoverage:
              input.evidenceCoverage === undefined
                ? undefined
                : (input.evidenceCoverage as unknown as Prisma.InputJsonValue),
            model: input.model ?? null,
            inputTokens: input.inputTokens ?? null,
            outputTokens: input.outputTokens ?? null,
          },
        });

        return message;
      });
    } catch (error) {
      if (requestKey && isUniqueConstraintError(error)) {
        const existingMessage = await db.$transaction((tx) =>
          findExistingMessageForOwnedThread(
            {
              firmId: input.firmId,
              userId: input.userId,
              threadId: input.threadId,
              role: ChatMessageRole.ASSISTANT,
              requestKey,
            },
            tx
          )
        );

        if (existingMessage) {
          return existingMessage;
        }
      }

      if (attempt < 2 && isSequenceReservationConflict(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Chat thread sequence reservation failed");
}

export async function loadAssistantMessageByRequestKey(
  input: LoadAssistantMessageByRequestKeyInput,
  db: ChatPersistenceDb = prisma
): Promise<PersistedChatMessage | null> {
  assertFirmUserScope(input.firmId, input.userId);
  const requestKey = normalizeRequestKey(input.requestKey);
  if (!requestKey) {
    return null;
  }

  await assertUserBelongsToFirm(input.firmId, input.userId, db);
  return db.$transaction((tx) =>
    findExistingMessageForOwnedThread(
      {
        firmId: input.firmId,
        userId: input.userId,
        threadId: input.threadId,
        role: ChatMessageRole.ASSISTANT,
        requestKey,
      },
      tx
    )
  );
}

export async function loadChatThreadForUser(
  input: { firmId: string; userId: string; threadId: string; messageLimit?: number },
  db: ChatPersistenceDb = prisma
): Promise<PersistedChatThread | null> {
  assertFirmUserScope(input.firmId, input.userId);
  const messageLimit =
    input.messageLimit === undefined || !Number.isFinite(input.messageLimit)
      ? undefined
      : Math.min(Math.max(Math.trunc(input.messageLimit), 1), MAX_CHAT_HISTORY_MESSAGES);

  const thread = await db.chatThread.findFirst({
    where: {
      id: input.threadId,
      firmId: input.firmId,
      userId: input.userId,
      status: ChatThreadStatus.ACTIVE,
    },
    include: {
      messages: {
        orderBy: { sequence: messageLimit ? "desc" : "asc" },
        ...(messageLimit ? { take: messageLimit } : {}),
      },
    },
  });

  if (!thread || !messageLimit) {
    return thread;
  }

  return {
    ...thread,
    messages: [...thread.messages].sort(
      (left, right) => left.sequence - right.sequence
    ),
  };
}
