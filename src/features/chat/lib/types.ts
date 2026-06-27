export type ChatCitation = {
  marker?: string;
  sourceId?: string;
  chunkId: string;
  documentId: string;
  filename?: string;
  pageStart: number;
  pageEnd: number;
  pageLabel?: string;
  snippet: string;
  snippetFull?: string;
  sourceBlockIds: string[];
};

export type ChatEvidenceCoverageV1 = {
  version: 1;
  selectedDocumentIds: string[];
  retrievedByDocumentId?: Record<string, number>;
  finalByDocumentId: Record<string, number>;
  noEvidenceDocumentIds: string[];
};

export type StructuredChatOutputV1 = {
  schemaVersion: "trueblue.chat.output.v1";
  templateId: string;
  templateVersion: number;
  status:
    | "answered"
    | "insufficient_evidence"
    | "narrowing_required"
    | "non_document";
  responseText: string;
  sources: ChatCitation[];
  coverage: ChatEvidenceCoverageV1;
  support: {
    confidenceLabel: "high" | "medium" | "low" | "none";
    confidenceBasis: string;
    retrievalMode: "local_retrieval_fallback" | "vector_retrieval";
    scoreThreshold?: number;
    sourceCount: number;
    selectedDocumentCount: number;
    citedDocumentCount: number;
    retrievalWarningCount: number;
  };
  warnings: Array<{
    code: string;
    message?: string;
    severity: "info" | "warning" | "error";
  }>;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type ConfidenceLabel = StructuredChatOutputV1["support"]["confidenceLabel"];

export type SourceCoverageStatus = {
  label: "Used" | "No evidence used" | "Selected" | "Unavailable";
  tone: "used" | "noEvidence" | "selected" | "unavailable";
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
