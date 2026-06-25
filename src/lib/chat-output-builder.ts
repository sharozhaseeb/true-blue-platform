import {
  CHAT_OUTPUT_SCHEMA_VERSION,
  StructuredChatOutputV1Schema,
  type EvidenceCoverageV1,
  type OutputStatusV1,
  type OutputWarningV1,
  type SourceCitationV1,
  type StructuredChatOutputV1,
  type StructuredOutputStatusV1,
} from "@/lib/chat-output-schema";
import {
  DEFAULT_CHAT_OUTPUT_TEMPLATE,
  getChatOutputTemplate,
  type OutputTemplateRegistryEntry,
  type OutputTemplateSelection,
} from "@/lib/chat-output-templates";
import { isInsufficientEvidenceText } from "@/lib/chat-public-output";

type RetrievalMode = "local_retrieval_fallback" | "vector_retrieval";

type ChatCitationForOutput = {
  marker?: string;
  rank?: number;
  chunkId?: string;
  documentId?: string;
  filename?: string | null;
  pageStart?: number;
  pageEnd?: number;
  snippet?: string;
  snippetFull?: string;
  sourceBlockIds?: string[];
  formType?: string | null;
  contentType?: "prose" | "field_group" | "table" | "mixed";
  sectionPath?: string | null;
  tableId?: string | null;
  relevanceScore?: number;
};

export type BuildStructuredChatOutputV1Input = {
  threadId: string;
  messageId?: string;
  requestKey?: string | null;
  answer: string;
  citations: ChatCitationForOutput[];
  coverage: EvidenceCoverageV1 | null;
  retrievalWarnings?: string[];
  mode: RetrievalMode;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  responseMode: "rag_qa";
  templateId?: string;
  templateVersion?: number;
  outputTemplate?: OutputTemplateSelection;
  scoreThreshold?: number;
  statusHint?: OutputStatusV1;
  generatedAt?: Date;
};

function trimToString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function emptyCoverage(): EvidenceCoverageV1 {
  return {
    version: 1,
    selectedDocumentIds: [],
    retrievedByDocumentId: {},
    finalByDocumentId: {},
    noEvidenceDocumentIds: [],
  };
}

function normalizeCoverage(coverage: EvidenceCoverageV1 | null): EvidenceCoverageV1 {
  if (!coverage || coverage.version !== 1) {
    return emptyCoverage();
  }

  const selectedDocumentIds = [...new Set(coverage.selectedDocumentIds)];
  const finalByDocumentId = Object.fromEntries(
    selectedDocumentIds.map((documentId) => [
      documentId,
      coverage.finalByDocumentId?.[documentId] ?? 0,
    ])
  );
  const retrievedByDocumentId = Object.fromEntries(
    selectedDocumentIds.map((documentId) => [
      documentId,
      coverage.retrievedByDocumentId?.[documentId] ?? finalByDocumentId[documentId] ?? 0,
    ])
  );

  return {
    version: 1,
    selectedDocumentIds,
    retrievedByDocumentId,
    finalByDocumentId,
    noEvidenceDocumentIds: [...new Set(coverage.noEvidenceDocumentIds)],
  };
}

function sourceIdFromCitation(citation: ChatCitationForOutput, index: number): string {
  const marker = trimToString(citation.marker);
  const markerMatch = marker?.match(/^\[S([1-9][0-9]*)\]$/);
  if (markerMatch) {
    return `S${Number(markerMatch[1])}`;
  }

  return `S${index + 1}`;
}

function pageLabel(pageStart: number, pageEnd: number): string {
  return pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`;
}

function positivePage(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 1
    ? value
    : fallback;
}

function nonNullStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );
}

export function sourceCitationsFromChatCitations(input: {
  citations: ChatCitationForOutput[];
  coverage?: EvidenceCoverageV1;
  compact?: boolean;
  maxSources?: number;
}): SourceCitationV1[] {
  const citations =
    input.maxSources !== undefined
      ? input.citations.slice(0, Math.max(input.maxSources, 0))
      : input.citations;

  return citations.map((citation, index) => {
    const sourceId = sourceIdFromCitation(citation, index);
    const chunkId = trimToString(citation.chunkId) ?? `legacy:${sourceId}`;
    const documentId =
      trimToString(citation.documentId) ??
      input.coverage?.selectedDocumentIds.find(
        (selectedDocumentId) =>
          (input.coverage?.finalByDocumentId[selectedDocumentId] ?? 0) > 0
      ) ??
      input.coverage?.selectedDocumentIds[0] ??
      `legacy:${sourceId}`;
    const pageStart = positivePage(citation.pageStart, 1);
    const pageEnd = Math.max(positivePage(citation.pageEnd, pageStart), pageStart);
    const snippet =
      trimToString(citation.snippet) ??
      trimToString(citation.snippetFull) ??
      "Source snippet unavailable";
    const sourceBlockIds = nonNullStringArray(citation.sourceBlockIds);
    const snippetFull = input.compact ? undefined : trimToString(citation.snippetFull);

    return {
      sourceId,
      marker: `[${sourceId}]`,
      rank:
        Number.isInteger(citation.rank) && citation.rank !== undefined && citation.rank >= 1
          ? citation.rank
          : Number(sourceId.slice(1)),
      chunkId,
      documentId,
      ...(trimToString(citation.filename) ? { filename: trimToString(citation.filename) } : {}),
      pageStart,
      pageEnd,
      pageLabel: pageLabel(pageStart, pageEnd),
      snippet,
      ...(snippetFull ? { snippetFull } : {}),
      sourceBlockIds:
        sourceBlockIds.length > 0 ? sourceBlockIds : [`legacy:${chunkId}`],
      ...(trimToString(citation.formType) ? { formType: trimToString(citation.formType) } : {}),
      ...(citation.contentType ? { contentType: citation.contentType } : {}),
      ...(trimToString(citation.sectionPath)
        ? { sectionPath: trimToString(citation.sectionPath) }
        : {}),
      ...(trimToString(citation.tableId) ? { tableId: trimToString(citation.tableId) } : {}),
      ...(Number.isFinite(citation.relevanceScore)
        ? { relevanceScore: citation.relevanceScore }
        : {}),
    };
  });
}

export function inferStructuredOutputStatus(input: {
  answer: string;
  sources: SourceCitationV1[];
  statusHint?: OutputStatusV1;
}): StructuredOutputStatusV1 {
  if (input.statusHint) {
    return input.statusHint;
  }

  if (input.sources.length > 0 && !isInsufficientEvidenceText(input.answer)) {
    return "answered";
  }

  return "insufficient_evidence";
}

function sanitizeWarning(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240) || "Retrieval warning";
}

export function createOutputWarnings(input: {
  status: OutputStatusV1;
  coverage: EvidenceCoverageV1;
  sources: SourceCitationV1[];
  retrievalWarnings?: string[];
  templateDefaulted?: boolean;
}): OutputWarningV1[] {
  const warnings: OutputWarningV1[] = [];

  if (input.templateDefaulted) {
    warnings.push({
      code: "TEMPLATE_DEFAULTED",
      message: "The default output template was used.",
      severity: "info",
    });
  }

  if (input.status === "insufficient_evidence") {
    warnings.push({
      code: "INSUFFICIENT_EVIDENCE",
      message: "The selected documents did not provide enough cited support.",
      severity: "warning",
    });
  } else if (input.status === "narrowing_required") {
    warnings.push({
      code: "NARROWING_REQUIRED",
      message: "The source scope is too broad for a reliable answer.",
      severity: "info",
      documentIds: input.coverage.selectedDocumentIds,
    });
  } else if (input.status === "non_document") {
    warnings.push({
      code: "NON_DOCUMENT_MESSAGE",
      message: "The message did not require document retrieval.",
      severity: "info",
    });
  }

  const citedDocumentIds = new Set(input.sources.map((source) => source.documentId));
  if (
    input.status === "answered" &&
    input.coverage.selectedDocumentIds.length > 1 &&
    citedDocumentIds.size < input.coverage.selectedDocumentIds.length
  ) {
    warnings.push({
      code: "PARTIAL_SOURCE_COVERAGE",
      message: "Only part of the selected source set supported the answer.",
      severity: "warning",
      documentIds: input.coverage.selectedDocumentIds.filter(
        (documentId) => !citedDocumentIds.has(documentId)
      ),
    });
  }

  if (
    input.status === "answered" &&
    input.coverage.noEvidenceDocumentIds.length > 0
  ) {
    warnings.push({
      code: "NO_EVIDENCE_FOR_SELECTED_DOCUMENT",
      message: "No cited support was found for one or more selected documents.",
      severity: "warning",
      documentIds: input.coverage.noEvidenceDocumentIds,
    });
  }

  for (const [index, warning] of (input.retrievalWarnings ?? []).entries()) {
    warnings.push({
      code: "RETRIEVAL_WARNING",
      message: sanitizeWarning(warning),
      severity: "warning",
      details: { warningIndex: index + 1 },
    });
  }

  return warnings;
}

function createSupport(input: {
  status: OutputStatusV1;
  sources: SourceCitationV1[];
  coverage: EvidenceCoverageV1;
  warnings: OutputWarningV1[];
  mode: RetrievalMode;
  scoreThreshold?: number;
  retrievalWarningCount: number;
}) {
  const citedDocumentCount = new Set(input.sources.map((source) => source.documentId)).size;
  const selectedDocumentCount = input.coverage.selectedDocumentIds.length;
  const hasCoverageWarning = input.warnings.some((warning) =>
    [
      "PARTIAL_SOURCE_COVERAGE",
      "NO_EVIDENCE_FOR_SELECTED_DOCUMENT",
      "RETRIEVAL_WARNING",
    ].includes(warning.code)
  );
  const allVectorScoresMeetThreshold =
    input.mode === "vector_retrieval" &&
    input.scoreThreshold !== undefined &&
    input.sources.length > 0 &&
    input.sources.every(
      (source) =>
        source.relevanceScore !== undefined &&
        source.relevanceScore >= (input.scoreThreshold as number)
    );

  const confidenceLabel =
    input.status !== "answered" || input.sources.length === 0
      ? "none"
      : hasCoverageWarning
        ? "low"
        : allVectorScoresMeetThreshold || input.sources.length >= 2
          ? "high"
          : input.sources.length === 1
            ? "medium"
            : "low";

  const confidenceBasis =
    confidenceLabel === "none"
      ? "No cited source support is attached to this response."
      : confidenceLabel === "low"
        ? "Support is limited by source coverage or retrieval warnings."
        : confidenceLabel === "high"
          ? "Support is based on cited source coverage and retrieval score evidence."
          : "Support is based on one cited source without retrieval warnings.";

  return {
    confidenceLabel,
    confidenceBasis,
    retrievalMode: input.mode,
    ...(input.scoreThreshold !== undefined ? { scoreThreshold: input.scoreThreshold } : {}),
    sourceCount: input.sources.length,
    selectedDocumentCount,
    citedDocumentCount,
    retrievalWarningCount: input.retrievalWarningCount,
  };
}

function normalizeGeneratedAt(generatedAt?: Date): string {
  if (generatedAt && !Number.isNaN(generatedAt.getTime())) {
    return generatedAt.toISOString();
  }

  return new Date().toISOString();
}

function resolveTemplate(input: BuildStructuredChatOutputV1Input): {
  template: OutputTemplateSelection;
  registryEntry: OutputTemplateRegistryEntry;
  compact: boolean;
  defaulted: boolean;
} {
  const requestedTemplateId = input.outputTemplate?.templateId ?? input.templateId;
  const requestedTemplateVersion =
    input.outputTemplate?.templateVersion ?? input.templateVersion;

  try {
    const template = getChatOutputTemplate(requestedTemplateId);
    return {
      template: {
        templateId: template.templateId as OutputTemplateSelection["templateId"],
        templateVersion: requestedTemplateVersion ?? template.templateVersion,
      },
      registryEntry: template,
      compact: template.templateId === "rag_qa.compact.v1",
      defaulted: false,
    };
  } catch {
    return {
      template: {
        templateId: DEFAULT_CHAT_OUTPUT_TEMPLATE.templateId,
        templateVersion: DEFAULT_CHAT_OUTPUT_TEMPLATE.templateVersion,
      },
      registryEntry: DEFAULT_CHAT_OUTPUT_TEMPLATE,
      compact: false,
      defaulted: true,
    };
  }
}

export function buildStructuredChatOutputV1(
  input: BuildStructuredChatOutputV1Input
): StructuredChatOutputV1 {
  const { template, registryEntry, compact, defaulted } = resolveTemplate(input);
  const coverage = normalizeCoverage(input.coverage);
  const sources = sourceCitationsFromChatCitations({
    citations: input.citations,
    coverage,
    compact,
    maxSources: registryEntry.maxSources,
  });
  const status = inferStructuredOutputStatus({
    answer: input.answer,
    sources,
    statusHint: input.statusHint,
  });
  const warnings = createOutputWarnings({
    status,
    coverage,
    sources,
    retrievalWarnings: input.retrievalWarnings,
    templateDefaulted: defaulted,
  });
  const retrievalWarningCount = input.retrievalWarnings?.length ?? 0;
  const output = {
    schemaVersion: CHAT_OUTPUT_SCHEMA_VERSION,
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    status,
    responseText: input.answer,
    sources,
    coverage,
    support: createSupport({
      status,
      sources,
      coverage,
      warnings,
      mode: input.mode,
      scoreThreshold: input.scoreThreshold,
      retrievalWarningCount,
    }),
    warnings,
    metadata: {
      threadId: input.threadId,
      ...(trimToString(input.messageId) ? { messageId: trimToString(input.messageId) } : {}),
      ...(trimToString(input.requestKey) ? { requestKey: trimToString(input.requestKey) } : {}),
      ...(trimToString(input.model) ? { model: trimToString(input.model) } : {}),
      generatedAt: normalizeGeneratedAt(input.generatedAt),
      responseMode: input.responseMode,
      ...(input.inputTokens !== null &&
      input.inputTokens !== undefined &&
      Number.isInteger(input.inputTokens) &&
      input.inputTokens >= 0
        ? { inputTokens: input.inputTokens }
        : {}),
      ...(input.outputTokens !== null &&
      input.outputTokens !== undefined &&
      Number.isInteger(input.outputTokens) &&
      input.outputTokens >= 0
        ? { outputTokens: input.outputTokens }
        : {}),
    },
  };

  return StructuredChatOutputV1Schema.parse(output);
}
