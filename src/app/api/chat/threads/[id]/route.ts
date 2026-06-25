import { ChatMessageRole, ChatThreadStatus } from "@prisma/client";
import { hasPermission } from "@/lib/rbac";
import { forbidden, internalError, notFound, unauthorized } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getFirmScopedRequestContext } from "@/lib/tenant";
import type { EvidenceCoverageV1 } from "@/lib/chat-persistence";
import { buildStructuredChatOutputV1 } from "@/lib/chat-output-builder";
import { outputTemplateSelectionFromPersisted } from "@/lib/chat-output-templates";
import { M3_RAG_RESPONSE_MODE } from "@/lib/ai/prompts";

const VECTOR_RETRIEVAL_CHAT_MODEL = "local-grounded-vector-retrieval-v0";
const AI_CHAT_INSUFFICIENT_MODEL = "m3-rag-insufficient-evidence-v0";
const NON_DOCUMENT_CHAT_MODEL = "m3-rag-non-document-message-v0";
const MULTI_SOURCE_NARROWING_MODEL = "m3-rag-narrow-source-scope-v0";

const MAX_VISIBLE_THREAD_MESSAGES = 200;

interface RouteParams {
  params: Promise<{ id: string }>;
}

function uiPartsForMessage(message: {
  id: string;
  role: ChatMessageRole;
  content: string;
  citations: unknown;
  evidenceCoverage: unknown;
  model: string | null;
  requestKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
  threadId: string;
  outputTemplate: unknown;
}) {
  const citations =
    message.role === ChatMessageRole.ASSISTANT &&
    Array.isArray(message.citations)
      ? message.citations
      : [];
  const coverage = coverageForMessage(message);
  const parts: Array<Record<string, unknown>> = [
    { type: "text", text: message.content },
  ];

  if (citations.length > 0) {
    parts.push({
      type: "data-citations",
      data: { citations },
    });
  }

  if (coverage) {
    parts.push({
      type: "data-coverage",
      data: { coverage },
    });
  }

  if (message.role === ChatMessageRole.ASSISTANT) {
    parts.push({
      type: "data-output",
      data: {
        output: buildStructuredChatOutputV1({
          threadId: message.threadId,
          messageId: message.id,
          requestKey: message.requestKey,
          answer: message.content,
          citations,
          coverage,
          retrievalWarnings: [],
          mode: modeFromModel(message.model),
          model: message.model,
          inputTokens: message.inputTokens,
          outputTokens: message.outputTokens,
          responseMode: M3_RAG_RESPONSE_MODE,
          outputTemplate: outputTemplateSelectionFromPersisted(message.outputTemplate),
          statusHint: statusHintFromModel(message.model),
          generatedAt: message.createdAt,
        }),
      },
    });
  }

  return parts;
}

function modeFromModel(model: string | null | undefined) {
  return model === VECTOR_RETRIEVAL_CHAT_MODEL
    ? "vector_retrieval"
    : "local_retrieval_fallback";
}

function statusHintFromModel(model: string | null | undefined) {
  if (model === NON_DOCUMENT_CHAT_MODEL) {
    return "non_document";
  }

  if (model === MULTI_SOURCE_NARROWING_MODEL) {
    return "narrowing_required";
  }

  if (model === AI_CHAT_INSUFFICIENT_MODEL) {
    return "insufficient_evidence";
  }

  return undefined;
}

function coverageForMessage(message: {
  role: ChatMessageRole;
  evidenceCoverage: unknown;
}): EvidenceCoverageV1 | null {
  if (
    message.role !== ChatMessageRole.ASSISTANT ||
    typeof message.evidenceCoverage !== "object" ||
    message.evidenceCoverage === null
  ) {
    return null;
  }

  const coverage = message.evidenceCoverage as Partial<EvidenceCoverageV1>;
  if (
    coverage.version !== 1 ||
    !Array.isArray(coverage.selectedDocumentIds) ||
    typeof coverage.finalByDocumentId !== "object" ||
    coverage.finalByDocumentId === null ||
    !Array.isArray(coverage.noEvidenceDocumentIds)
  ) {
    return null;
  }

  return {
    version: 1,
    selectedDocumentIds: coverage.selectedDocumentIds,
    retrievedByDocumentId: Object.fromEntries(
      coverage.selectedDocumentIds.map((documentId) => [
        documentId,
        coverage.retrievedByDocumentId?.[documentId] ??
          coverage.finalByDocumentId?.[documentId] ??
          0,
      ])
    ),
    finalByDocumentId: Object.fromEntries(
      coverage.selectedDocumentIds.map((documentId) => [
        documentId,
        coverage.finalByDocumentId?.[documentId] ?? 0,
      ])
    ),
    noEvidenceDocumentIds: coverage.noEvidenceDocumentIds,
  };
}

function toUiMessage(message: {
  id: string;
  role: ChatMessageRole;
  content: string;
  citations: unknown;
  evidenceCoverage: unknown;
  requestKey: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
}, thread: { id: string; outputTemplate: unknown }) {
  return {
    id: message.id,
    role: message.role === ChatMessageRole.USER ? "user" : "assistant",
    parts: uiPartsForMessage({
      ...message,
      threadId: thread.id,
      outputTemplate: thread.outputTemplate,
    }),
    metadata: {
      createdAt: message.createdAt.toISOString(),
    },
  };
}

function sourceCount(documentFilter: unknown): number | null {
  if (
    typeof documentFilter !== "object" ||
    documentFilter === null ||
    !("documentIds" in documentFilter)
  ) {
    return null;
  }

  const documentIds = (documentFilter as { documentIds?: unknown }).documentIds;
  return Array.isArray(documentIds) ? documentIds.length : 0;
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getFirmScopedRequestContext();
    if (!ctx) {
      return unauthorized();
    }

    if (!hasPermission(ctx.role, "query_documents")) {
      return forbidden("You do not have permission to query documents");
    }

    const thread = await prisma.chatThread.findFirst({
      where: {
        id,
        firmId: ctx.firmId,
        userId: ctx.userId,
        status: ChatThreadStatus.ACTIVE,
      },
      select: {
        id: true,
        title: true,
        documentFilter: true,
        outputTemplate: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          select: {
            id: true,
            role: true,
            sequence: true,
            requestKey: true,
            content: true,
            citations: true,
            evidenceCoverage: true,
            model: true,
            inputTokens: true,
            outputTokens: true,
            createdAt: true,
          },
          orderBy: { sequence: "asc" },
          take: MAX_VISIBLE_THREAD_MESSAGES,
        },
      },
    });

    if (!thread) {
      return notFound("Chat thread not found");
    }

    return Response.json({
      thread: {
        id: thread.id,
        title: thread.title,
        documentFilter: thread.documentFilter,
        sourceCount: sourceCount(thread.documentFilter),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      },
      messages: thread.messages
        .filter(
          (message) =>
            message.role === ChatMessageRole.USER ||
            message.role === ChatMessageRole.ASSISTANT
        )
        .map((message) =>
          toUiMessage(message, {
            id: thread.id,
            outputTemplate: thread.outputTemplate,
          })
        ),
    });
  } catch (error) {
    console.error("[chat:thread] Failed to load thread", error);
    return internalError("Failed to load chat thread");
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getFirmScopedRequestContext();
    if (!ctx) {
      return unauthorized();
    }

    if (!hasPermission(ctx.role, "query_documents")) {
      return forbidden("You do not have permission to query documents");
    }

    const result = await prisma.chatThread.updateMany({
      where: {
        id,
        firmId: ctx.firmId,
        userId: ctx.userId,
        status: ChatThreadStatus.ACTIVE,
      },
      data: {
        status: ChatThreadStatus.DELETED,
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return notFound("Chat thread not found");
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("[chat:thread] Failed to delete thread", error);
    return internalError("Failed to delete chat thread");
  }
}
