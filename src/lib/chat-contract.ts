import type { ChatDocumentFilter } from "@/lib/chat-persistence";
import { MAX_CHAT_DOCUMENT_FILTER_IDS } from "@/lib/chat-persistence";
import { DEFAULT_CHAT_OUTPUT_TEMPLATE_ID } from "@/lib/chat-output-schema";
import {
  normalizeOutputTemplateSelection,
  type OutputTemplateSelection,
} from "@/lib/chat-output-templates";

export interface ParsedChatRequest {
  threadId?: string;
  requestKey?: string;
  transport: "legacy_json" | "assistant_ui";
  message: {
    role: "user";
    content: string;
  };
  documentFilter?: ChatDocumentFilter | null;
  outputTemplate?: OutputTemplateSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, label: string, maxItems: number): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  if (value.length > maxItems) {
    throw new Error(`${label} exceeds ${maxItems} items`);
  }

  if (value.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }

  if (!value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${label} must contain only non-empty strings`);
  }

  return value.map((item) => item.trim());
}

function parsePageRange(value: unknown): ChatDocumentFilter["pageRange"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("pageRange must be an object");
  }

  const start = value.start;
  const end = value.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start
  ) {
    throw new Error("pageRange must contain valid integer start/end values");
  }

  return { start, end };
}

function parseDocumentFilter(value: unknown): ChatDocumentFilter | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error("documentFilter must be an object");
  }

  return {
    ...(value.documentIds !== undefined
      ? {
          documentIds: parseStringArray(
            value.documentIds,
            "documentIds",
            MAX_CHAT_DOCUMENT_FILTER_IDS
          ),
        }
      : {}),
    ...(value.formTypes !== undefined
      ? { formTypes: parseStringArray(value.formTypes, "formTypes", 25) }
      : {}),
    ...(value.pageRange !== undefined
      ? { pageRange: parsePageRange(value.pageRange) }
      : {}),
  };
}

function parseOutputTemplate(value: unknown): OutputTemplateSelection | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("outputTemplate must be an object");
  }

  const templateId = value.templateId;
  if (templateId !== undefined && typeof templateId !== "string") {
    throw new Error("outputTemplate.templateId must be a string");
  }

  return normalizeOutputTemplateSelection({
    templateId: typeof templateId === "string" ? templateId : undefined,
  });
}

function textFromMessageParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const text = parts
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text") {
        return [];
      }

      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("");

  return text || undefined;
}

function parseAssistantUiRequestBody(body: Record<string, unknown>): ParsedChatRequest | null {
  if (!Array.isArray(body.messages)) {
    return null;
  }

  const messages = body.messages.filter(isRecord);
  const lastMessage = [...messages].reverse().find((message) => message.role === "user");
  if (!lastMessage) {
    throw new Error("A user message is required");
  }

  const content =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : textFromMessageParts(lastMessage.parts);
  if (typeof content !== "string") {
    throw new Error("message.content must be a string");
  }

  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const bodyThreadId =
    typeof body.threadId === "string" && body.threadId.trim()
      ? body.threadId.trim()
      : undefined;
  const metadataThreadId =
    typeof metadata.threadId === "string" && metadata.threadId.trim()
      ? metadata.threadId.trim()
      : undefined;
  const requestKey =
    typeof body.messageId === "string" && body.messageId.trim()
      ? body.messageId.trim()
      : typeof lastMessage.id === "string" && lastMessage.id.trim()
        ? lastMessage.id.trim()
        : undefined;
  const documentFilter = bodyThreadId || metadataThreadId
    ? undefined
    : parseDocumentFilter(
        isRecord(metadata) && metadata.documentFilter !== undefined
          ? metadata.documentFilter
          : body.documentFilter
      );
  const outputTemplate = bodyThreadId || metadataThreadId
    ? undefined
    : parseOutputTemplate(
        isRecord(metadata) && metadata.outputTemplate !== undefined
          ? metadata.outputTemplate
          : body.outputTemplate
      );

  return {
    ...(bodyThreadId || metadataThreadId
      ? { threadId: bodyThreadId ?? metadataThreadId }
      : {}),
    ...(requestKey ? { requestKey } : {}),
    transport: "assistant_ui",
    message: {
      role: "user",
      content,
    },
    documentFilter,
    ...(outputTemplate ? { outputTemplate } : {}),
  };
}

export function parseChatRequestBody(body: unknown): ParsedChatRequest {
  if (!isRecord(body)) {
    throw new Error("Request body must be an object");
  }

  const assistantUiRequest = parseAssistantUiRequestBody(body);
  if (assistantUiRequest) {
    return assistantUiRequest;
  }

  const message = body.message;
  if (!isRecord(message)) {
    throw new Error("message is required");
  }

  if (message.role !== "user") {
    throw new Error("Only user messages are accepted");
  }

  if (typeof message.content !== "string") {
    throw new Error("message.content must be a string");
  }

  const threadId =
    typeof body.threadId === "string" && body.threadId.trim()
      ? body.threadId.trim()
      : undefined;
  const requestKey =
    typeof body.requestKey === "string" && body.requestKey.trim()
      ? body.requestKey.trim()
      : undefined;

  const documentFilter = threadId
    ? undefined
    : parseDocumentFilter(body.documentFilter);
  const outputTemplate = threadId
    ? undefined
    : parseOutputTemplate(body.outputTemplate);

  return {
    ...(threadId ? { threadId } : {}),
    ...(requestKey ? { requestKey } : {}),
    transport: "legacy_json",
    message: {
      role: "user",
      content: message.content,
    },
    documentFilter,
    ...(outputTemplate ? { outputTemplate } : {}),
  };
}

export function buildGroundedLocalAnswer(
  question: string,
  snippets: string[],
  noEvidenceDocumentIds: string[] = [],
  maxLength = 6000
): string {
  if (snippets.length === 0 && noEvidenceDocumentIds.length === 0) {
    return "I could not find enough support in the uploaded documents to answer that question.";
  }

  const evidence = snippets.map((snippet, index) => {
    return `${index + 1}. ${snippet} [S${index + 1}]`;
  });
  const noEvidence =
    noEvidenceDocumentIds.length > 0
      ? [
          "",
          "No supporting evidence was found for these selected document IDs:",
          noEvidenceDocumentIds.map((documentId) => `- ${documentId}`).join("\n"),
        ]
      : [];

  const answer = [
    "Based on the retrieved document evidence, the relevant extracted text is:",
    ...evidence,
    ...noEvidence,
    "",
    `Question: ${question.slice(0, 1000)}`,
  ].join("\n");

  return answer.length > maxLength ? `${answer.slice(0, maxLength - 3)}...` : answer;
}

export function stableChatRequestFingerprint(input: {
  threadId?: string;
  content: string;
  documentFilter?: ChatDocumentFilter | null;
  fingerprintOutputTemplate?: OutputTemplateSelection | null;
}): string {
  const documentFilter = input.documentFilter
    ? {
        documentIds: input.documentFilter.documentIds
          ? [...input.documentFilter.documentIds].sort()
          : undefined,
        formTypes: input.documentFilter.formTypes
          ? [...input.documentFilter.formTypes].sort()
          : undefined,
        pageRange: input.documentFilter.pageRange,
      }
    : null;

  const payload = {
    threadId: input.threadId ?? null,
    content: input.content.trim(),
    documentFilter,
  };

  if (
    input.fingerprintOutputTemplate &&
    input.fingerprintOutputTemplate.templateId !== DEFAULT_CHAT_OUTPUT_TEMPLATE_ID
  ) {
    return JSON.stringify({
      ...payload,
      outputTemplate: {
        templateId: input.fingerprintOutputTemplate.templateId,
        templateVersion: input.fingerprintOutputTemplate.templateVersion,
      },
    });
  }

  return JSON.stringify(payload);
}
