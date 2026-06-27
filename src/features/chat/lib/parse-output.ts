import type { MessageState, ThreadMessage } from "@assistant-ui/react";

import {
  isRecord,
  type ChatCitation,
  type ChatEvidenceCoverageV1,
  type StructuredChatOutputV1,
} from "./types";

export function stringArrayFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

export function numberRecordFrom(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

export function documentIdsFromFilter(filter: unknown): string[] {
  if (!isRecord(filter) || !Array.isArray(filter.documentIds)) {
    return [];
  }

  return filter.documentIds.filter(
    (documentId): documentId is string =>
      typeof documentId === "string" && documentId.length > 0
  );
}

export function metadataString(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function metadataNumber(
  metadata: Record<string, unknown>,
  key: string
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function messageText(message: MessageState): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export function messageCitations(message: MessageState): ChatCitation[] {
  return message.content.flatMap((part) => {
    if (part.type !== "data" || part.name !== "citations" || !isRecord(part.data)) {
      return [];
    }

    const citations = part.data.citations;
    return Array.isArray(citations) ? (citations as ChatCitation[]) : [];
  });
}

export function parseCoverage(value: unknown): ChatEvidenceCoverageV1 | null {
  const coverage = isRecord(value) && isRecord(value.coverage) ? value.coverage : value;
  if (!isRecord(coverage) || coverage.version !== 1) {
    return null;
  }

  const selectedDocumentIds = stringArrayFrom(coverage.selectedDocumentIds);
  const finalByDocumentId = numberRecordFrom(coverage.finalByDocumentId);
  const noEvidenceDocumentIds = stringArrayFrom(coverage.noEvidenceDocumentIds);
  const retrievedByDocumentId =
    coverage.retrievedByDocumentId === undefined
      ? undefined
      : numberRecordFrom(coverage.retrievedByDocumentId);

  if (
    !selectedDocumentIds ||
    !finalByDocumentId ||
    !noEvidenceDocumentIds ||
    retrievedByDocumentId === null
  ) {
    return null;
  }

  return {
    version: 1,
    selectedDocumentIds,
    retrievedByDocumentId,
    finalByDocumentId,
    noEvidenceDocumentIds,
  };
}

export function messageCoverage(
  message: Pick<ThreadMessage, "content"> | Pick<MessageState, "content">
): ChatEvidenceCoverageV1 | null {
  for (const part of message.content) {
    if (part.type !== "data") {
      continue;
    }

    const coverage = parseCoverage(part.data);
    if (coverage) {
      return coverage;
    }
  }

  return null;
}

export function parseStructuredOutput(value: unknown): StructuredChatOutputV1 | null {
  const output = isRecord(value) && isRecord(value.output) ? value.output : value;
  if (
    !isRecord(output) ||
    output.schemaVersion !== "trueblue.chat.output.v1" ||
    typeof output.templateId !== "string" ||
    typeof output.templateVersion !== "number" ||
    typeof output.status !== "string" ||
    !isRecord(output.support)
  ) {
    return null;
  }

  const coverage = parseCoverage(output.coverage);
  if (!coverage) {
    return null;
  }

  const sourceCount = output.support.sourceCount;
  const selectedDocumentCount = output.support.selectedDocumentCount;
  const citedDocumentCount = output.support.citedDocumentCount;
  const retrievalWarningCount = output.support.retrievalWarningCount;
  const confidenceLabel = output.support.confidenceLabel;
  const confidenceBasis = output.support.confidenceBasis;
  const retrievalMode = output.support.retrievalMode;
  const scoreThreshold = output.support.scoreThreshold;
  if (
    typeof sourceCount !== "number" ||
    typeof selectedDocumentCount !== "number" ||
    typeof citedDocumentCount !== "number" ||
    typeof retrievalWarningCount !== "number" ||
    typeof confidenceBasis !== "string" ||
    (retrievalMode !== "local_retrieval_fallback" &&
      retrievalMode !== "vector_retrieval") ||
    (scoreThreshold !== undefined && typeof scoreThreshold !== "number") ||
    !["high", "medium", "low", "none"].includes(String(confidenceLabel))
  ) {
    return null;
  }

  const warnings: StructuredChatOutputV1["warnings"] = Array.isArray(output.warnings)
    ? output.warnings.flatMap((warning) =>
        isRecord(warning) && typeof warning.code === "string"
          ? [
              {
                code: warning.code,
                message:
                  typeof warning.message === "string" ? warning.message : undefined,
                severity:
                  warning.severity === "error" ||
                  warning.severity === "warning" ||
                  warning.severity === "info"
                    ? warning.severity
                    : "info",
              },
            ]
          : []
      )
    : [];

  return {
    schemaVersion: "trueblue.chat.output.v1",
    templateId: output.templateId,
    templateVersion: output.templateVersion,
    status: output.status as StructuredChatOutputV1["status"],
    responseText: typeof output.responseText === "string" ? output.responseText : "",
    sources: Array.isArray(output.sources) ? (output.sources as ChatCitation[]) : [],
    coverage,
    support: {
      confidenceLabel:
        confidenceLabel as StructuredChatOutputV1["support"]["confidenceLabel"],
      confidenceBasis,
      retrievalMode,
      ...(scoreThreshold !== undefined ? { scoreThreshold } : {}),
      sourceCount,
      selectedDocumentCount,
      citedDocumentCount,
      retrievalWarningCount,
    },
    warnings,
    metadata: isRecord(output.metadata) ? output.metadata : {},
    raw: output,
  };
}

export function messageOutput(
  message: Pick<ThreadMessage, "content"> | Pick<MessageState, "content">
): StructuredChatOutputV1 | null {
  for (const part of message.content) {
    if (part.type !== "data" || part.name !== "output") {
      continue;
    }

    const output = parseStructuredOutput(part.data);
    if (output) {
      return output;
    }
  }

  return null;
}

export function latestAssistantOutput(
  messages: readonly ThreadMessage[]
): StructuredChatOutputV1 | null {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return latestAssistantMessage ? messageOutput(latestAssistantMessage) : null;
}

export function latestAssistantCoverage(
  messages: readonly ThreadMessage[]
): ChatEvidenceCoverageV1 | null {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return latestAssistantMessage ? messageCoverage(latestAssistantMessage) : null;
}
