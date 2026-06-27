import type {
  ChatEvidenceCoverageV1,
  ConfidenceLabel,
  SourceCoverageStatus,
} from "./types";

export const CONFIDENCE_DOT_CLASS: Record<ConfidenceLabel, string> = {
  high: "bg-[var(--color-confidence-high)]",
  medium: "bg-[var(--color-confidence-medium)]",
  low: "bg-[var(--color-confidence-low)]",
  none: "bg-[var(--color-confidence-none)]",
};

export function coverageStatusForDocument(input: {
  coverage: ChatEvidenceCoverageV1 | null;
  documentId: string;
  available: boolean;
}): SourceCoverageStatus | null {
  const { coverage, documentId, available } = input;
  if (!coverage || !coverage.selectedDocumentIds.includes(documentId)) {
    return null;
  }

  if (!available) {
    return { label: "Unavailable", tone: "unavailable" };
  }

  if ((coverage.finalByDocumentId[documentId] ?? 0) > 0) {
    return { label: "Used", tone: "used" };
  }

  if (coverage.noEvidenceDocumentIds.includes(documentId)) {
    return { label: "No evidence used", tone: "noEvidence" };
  }

  return { label: "Selected", tone: "selected" };
}

export function coverageBadgeClass(
  status: SourceCoverageStatus,
  selected: boolean
): string {
  if (selected) {
    return {
      used: "bg-emerald-400/15 text-emerald-100 ring-emerald-300/25",
      noEvidence: "bg-amber-400/15 text-amber-100 ring-amber-300/25",
      selected: "bg-white/10 text-slate-200 ring-white/15",
      unavailable: "bg-rose-400/15 text-rose-100 ring-rose-300/25",
    }[status.tone];
  }

  return {
    used: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    noEvidence: "bg-amber-50 text-amber-700 ring-amber-200",
    selected: "bg-slate-100 text-slate-600 ring-slate-200",
    unavailable: "bg-rose-50 text-rose-700 ring-rose-200",
  }[status.tone];
}
