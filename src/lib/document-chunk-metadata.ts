import type { Prisma } from "@prisma/client";
import type { FormTypeSource } from "@/lib/form-resolution";

export interface NormalizedChunkMetadata {
  filename: string | null;
  formType: string | null;
  explicitFormType: string | null;
  resolvedFormType: string | null;
  formTypeSource: FormTypeSource | null;
  formTypeOriginPage: number | null;
  sourcePageNumbers: number[];
  coversPageStart: boolean;
  coversPageEnd: boolean;
  pageRange: string | null;
  isPartialPage: boolean;
  partIndex: number | null;
}

type RawChunkMetadata = Prisma.JsonValue | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toNumberOrNull(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => toNumberOrNull(entry))
    .filter((entry): entry is number => entry !== null);
}

function toFormTypeSource(value: unknown): FormTypeSource | null {
  return value === "explicit" || value === "propagated" ? value : null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return null;
}

function parsePageRange(pageRange: string | null): number[] {
  if (!pageRange) return [];

  const match = /^(\d+)-(\d+)$/.exec(pageRange);
  if (!match) return [];

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return [];
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/**
 * Normalize chunk metadata for the API boundary.
 *
 * `formType` is the public alias for the resolved chunk ownership value. The
 * original explicit detection state remains available via
 * `explicitFormType`/`resolvedFormType`/`formTypeSource`.
 */
export function normalizeChunkMetadata(
  metadata: RawChunkMetadata,
  pageNumber?: number
): NormalizedChunkMetadata {
  const raw = isRecord(metadata) ? metadata : {};
  const explicitFormType = toStringOrNull(raw.explicitFormType);
  const legacyFormType = toStringOrNull(raw.formType);
  const resolvedFormType =
    toStringOrNull(raw.resolvedFormType) ?? legacyFormType ?? explicitFormType;
  const formTypeSource =
    toFormTypeSource(raw.formTypeSource) ??
    (explicitFormType ? "explicit" : null);
  const sourcePageNumbers = toNumberArray(raw.sourcePageNumbers);
  const pageRange = toStringOrNull(raw.pageRange);
  const derivedSourcePageNumbers = parsePageRange(pageRange);
  const coversPageStart = toBooleanOrNull(raw.coversPageStart);
  const coversPageEnd = toBooleanOrNull(raw.coversPageEnd);
  const isPartialPage = toBooleanOrNull(raw.isPartialPage);

  return {
    filename: toStringOrNull(raw.filename),
    formType: resolvedFormType,
    explicitFormType,
    resolvedFormType,
    formTypeSource,
    formTypeOriginPage: toNumberOrNull(raw.formTypeOriginPage),
    sourcePageNumbers:
      sourcePageNumbers.length > 0
        ? sourcePageNumbers
        : derivedSourcePageNumbers.length > 0
          ? derivedSourcePageNumbers
          : pageNumber != null &&
              coversPageStart === true &&
              coversPageEnd === true &&
              isPartialPage === false
          ? [pageNumber]
          : [],
    coversPageStart: coversPageStart ?? false,
    coversPageEnd: coversPageEnd ?? false,
    pageRange,
    isPartialPage: isPartialPage ?? false,
    partIndex: toNumberOrNull(raw.partIndex),
  };
}
