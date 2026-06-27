import type { StructuredChatOutputV1 } from "./types";

export async function copyValue(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has a chance to start.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportFilenameBase(output: StructuredChatOutputV1): string {
  const messageId =
    typeof output.metadata.messageId === "string" ? output.metadata.messageId : null;
  const threadId =
    typeof output.metadata.threadId === "string" ? output.metadata.threadId : null;
  const id = (messageId ?? threadId ?? "answer").replace(/[^a-zA-Z0-9_-]/g, "");
  return `trueblue-answer-${id || "answer"}`;
}

export function exportOutputJson(output: StructuredChatOutputV1): void {
  const json = JSON.stringify(output.raw, null, 2);
  triggerDownload(`${exportFilenameBase(output)}.json`, json, "application/json");
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : String(value);
  // Always quote and escape embedded quotes for a robust, Excel-safe CSV.
  return `"${text.replace(/"/g, '""')}"`;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * Flatten the answer envelope into a single CSV: a "support"/"coverage"
 * key/value section followed by one row per cited source. Section, field,
 * value, document, and pages columns keep both summaries and per-source
 * provenance in one file.
 */
export function outputToCsv(output: StructuredChatOutputV1): string {
  const header = ["section", "field", "value", "documentId", "pages"];
  const rows: string[] = [csvRow(header)];

  const generatedAt =
    typeof output.metadata.generatedAt === "string"
      ? output.metadata.generatedAt
      : "";
  const model = typeof output.metadata.model === "string" ? output.metadata.model : "";
  const inputTokens =
    typeof output.metadata.inputTokens === "number" ? output.metadata.inputTokens : "";
  const outputTokens =
    typeof output.metadata.outputTokens === "number"
      ? output.metadata.outputTokens
      : "";

  const summaryRows: Array<[string, unknown]> = [
    ["status", output.status],
    ["templateId", output.templateId],
    ["templateVersion", output.templateVersion],
    ["confidenceLabel", output.support.confidenceLabel],
    ["confidenceBasis", output.support.confidenceBasis],
    ["retrievalMode", output.support.retrievalMode],
    ["sourceCount", output.support.sourceCount],
    ["selectedDocumentCount", output.support.selectedDocumentCount],
    ["citedDocumentCount", output.support.citedDocumentCount],
    ["retrievalWarningCount", output.support.retrievalWarningCount],
    ["generatedAt", generatedAt],
    ["model", model],
    ["inputTokens", inputTokens],
    ["outputTokens", outputTokens],
  ];
  for (const [field, value] of summaryRows) {
    rows.push(csvRow(["support", field, value, "", ""]));
  }

  for (const documentId of output.coverage.selectedDocumentIds) {
    const used = output.coverage.finalByDocumentId[documentId] ?? 0;
    const status = output.coverage.noEvidenceDocumentIds.includes(documentId)
      ? "no_evidence"
      : used > 0
        ? "used"
        : "selected";
    rows.push(csvRow(["coverage", "documentStatus", status, documentId, used]));
  }

  for (const source of output.sources) {
    const pages =
      source.pageStart === source.pageEnd
        ? `${source.pageStart}`
        : `${source.pageStart}-${source.pageEnd}`;
    rows.push(
      csvRow([
        "source",
        source.marker ?? source.sourceId ?? "",
        source.filename ?? source.snippet ?? "",
        source.documentId,
        pages,
      ])
    );
  }

  return rows.join("\r\n");
}

export function exportOutputCsv(output: StructuredChatOutputV1): void {
  triggerDownload(
    `${exportFilenameBase(output)}.csv`,
    outputToCsv(output),
    "text/csv;charset=utf-8"
  );
}
