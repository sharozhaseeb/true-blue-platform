import { createInsufficientEvidenceAnswer } from "@/lib/chat-public-output";

export type GroundingCitation = {
  marker?: string;
  [key: string]: unknown;
};

export type NumericGroundingResult<TCitation extends GroundingCitation> = {
  answer: string;
  citations: TCitation[];
  removedUnsupportedNumericClaims: boolean;
};

const NUMERIC_CLAIM_PATTERN =
  /(?:\$|\bUSD\s*)?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$\s*\d+(?:\.\d+)?/gi;
const MARKER_PATTERN = /\[S(\d+)\]/g;
const DISCLOSURE =
  "Some numeric claims were omitted because they could not be verified from the cited source text.";

function normalizeNumber(value: string): string {
  return value
    .toLowerCase()
    .replace(/usd/g, "")
    .replace(/[$,\s]/g, "")
    .replace(/\.00$/g, "");
}

function normalizedNumbersFromText(text: string): Set<string> {
  return new Set(
    [...text.matchAll(NUMERIC_CLAIM_PATTERN)]
      .map((match) => normalizeNumber(match[0]))
      .filter(Boolean)
  );
}

function canonicalMarker(citation: GroundingCitation, index: number): string {
  return citation.marker ?? `[S${index + 1}]`;
}

function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMERIC_CLAIM_PATTERN)]
    .map((match) => normalizeNumber(match[0]))
    .filter(Boolean);
}

function extractMarkers(text: string): string[] {
  return [...text.matchAll(MARKER_PATTERN)].map((match) => `[S${match[1]}]`);
}

function sourceContainsNumber(source: string | undefined, normalizedNumber: string): boolean {
  if (!source) {
    return false;
  }

  return normalizedNumbersFromText(source).has(normalizedNumber);
}

function lineHasUnsupportedNumericClaim(
  line: string,
  sourceContentByMarker: Map<string, string>
): boolean {
  const numbers = extractNumbers(line);
  if (numbers.length === 0) {
    return false;
  }

  const markers = extractMarkers(line);
  if (markers.length === 0) {
    return true;
  }

  return numbers.some(
    (number) =>
      !markers.some((marker) =>
        sourceContainsNumber(sourceContentByMarker.get(marker), number)
      )
  );
}

export function enforceNumericGrounding<TCitation extends GroundingCitation>(input: {
  answer: string;
  citations: TCitation[];
  sourceContentByMarker: Map<string, string>;
}): NumericGroundingResult<TCitation> {
  const sourceContentByMarker = new Map(input.sourceContentByMarker);
  input.citations.forEach((citation, index) => {
    const marker = canonicalMarker(citation, index);
    if (!sourceContentByMarker.has(marker)) {
      sourceContentByMarker.set(marker, "");
    }
  });

  const lines = input.answer.split(/\r?\n/);
  let removedUnsupportedNumericClaims = false;
  const keptLines = lines.filter((line) => {
    const remove = lineHasUnsupportedNumericClaim(line, sourceContentByMarker);
    if (remove) {
      removedUnsupportedNumericClaims = true;
    }
    return !remove;
  });

  if (!removedUnsupportedNumericClaims) {
    return {
      answer: input.answer,
      citations: input.citations,
      removedUnsupportedNumericClaims: false,
    };
  }

  const answer = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!answer || extractMarkers(answer).length === 0) {
    return {
      answer: createInsufficientEvidenceAnswer(),
      citations: [],
      removedUnsupportedNumericClaims: true,
    };
  }

  return {
    answer: `${answer}\n\n${DISCLOSURE}`,
    citations: input.citations,
    removedUnsupportedNumericClaims: true,
  };
}
