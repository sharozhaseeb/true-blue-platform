export type PublicChatCitation = {
  marker?: string;
  [key: string]: unknown;
};

export function createInsufficientEvidenceAnswer(): string {
  return "I could not find enough support in the uploaded documents to answer that question.";
}

export function isInsufficientEvidenceText(answer: string): boolean {
  const normalized = stripCitationMarkers(answer)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const withoutTrailingPunctuation = normalized.replace(/[.!?]+$/g, "").trim();
  if (
    withoutTrailingPunctuation ===
      createInsufficientEvidenceAnswer().toLowerCase().replace(/[.!?]+$/g, "") ||
    withoutTrailingPunctuation === "insufficient evidence" ||
    withoutTrailingPunctuation === "insufficient information"
  ) {
    return true;
  }

  const hasGroundedContrast = /\b(?:but|however|although|though|while)\b/i.test(
    normalized
  );
  if (hasGroundedContrast) {
    return false;
  }

  return [
    /^i could not find enough support\b.{0,160}$/,
    /^(?:the\s+)?(?:document|provided context|retrieved context|uploaded documents?)\s+(?:does not|doesn't)\s+(?:mention|include|state|show|contain)\b.{0,220}$/,
    /^(?:there is|there's)\s+insufficient (?:evidence|information)\s+(?:in|from|within)\s+(?:the\s+)?(?:uploaded\s+)?documents?\b.{0,120}$/,
    /^insufficient (?:evidence|information)\s+(?:to|in|from|within)\b.{0,120}$/,
    /^i (?:do not|don't|cannot|can't) have (?:enough|sufficient) (?:evidence|information)\b.{0,120}$/,
  ].some((pattern) => pattern.test(normalized));
}

const CITATION_MARKER_VARIANT_PATTERN =
  /\[\s*(?:s\s*(\d+)|source\s*(\d+))\s*\]|\(\s*s\s*(\d+)\s*\)/gi;

const CITATION_MARKER_ONLY_PATTERN =
  /^\[\s*(?:s\s*(\d+)|source\s*(\d+))\s*\]$|^\(\s*s\s*(\d+)\s*\)$/i;

function canonicalMarkerFromNumber(rawNumber: string): string {
  return `[S${Number(rawNumber)}]`;
}

function canonicalizeCitationMarker(marker: string): string {
  const match = marker.match(CITATION_MARKER_ONLY_PATTERN);
  if (!match) {
    return marker;
  }

  return canonicalMarkerFromNumber(match[1] ?? match[2] ?? match[3]);
}

function cleanMarkerWhitespace(answer: string): string {
  return answer
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripCitationMarkers(answer: string): string {
  return cleanMarkerWhitespace(
    answer
      .replace(CITATION_MARKER_VARIANT_PATTERN, "")
      .replace(/\bsource\s*\d+\b/gi, "")
  );
}

function stripOrphanCitationMarkerVariants(answer: string): string {
  return cleanMarkerWhitespace(
    answer
      .replace(/\[s\s*\d+\]/g, "")
      .replace(/\[S\s+\d+\]/g, "")
      .replace(/\[(?:source|Source|SOURCE)\s*\d+\]/g, "")
      .replace(/\(\s*[sS]\s*\d+\s*\)/g, "")
      .replace(/\bsource\s*\d+\b/gi, "")
  );
}

export function finalizePublicChatOutput<TCitation extends PublicChatCitation>(
  answer: string,
  citations: TCitation[]
): {
  answer: string;
  citations: TCitation[];
  markerCount: number;
  invalidMarkerCount: number;
  usedMarkerCount: number;
} {
  const validMarkers = new Set(
    citations.map((citation, index) =>
      citation.marker
        ? canonicalizeCitationMarker(citation.marker)
        : `[S${index + 1}]`
    )
  );
  const referencedMarkers = new Set<string>();
  let markerCount = 0;
  let invalidMarkerCount = 0;
  const sanitizedAnswer = answer
    .replace(
      CITATION_MARKER_VARIANT_PATTERN,
      (_marker, sNumber, sourceNumber, parenNumber) => {
        const canonicalMarker = canonicalMarkerFromNumber(
          sNumber ?? sourceNumber ?? parenNumber
        );
        markerCount += 1;
        if (!validMarkers.has(canonicalMarker)) {
          invalidMarkerCount += 1;
          return "";
        }

        referencedMarkers.add(canonicalMarker);
        return canonicalMarker;
      }
    )
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (isInsufficientEvidenceText(sanitizedAnswer)) {
    return {
      answer: createInsufficientEvidenceAnswer(),
      citations: [],
      markerCount,
      invalidMarkerCount,
      usedMarkerCount: 0,
    };
  }

  if (referencedMarkers.size === 0) {
    return {
      answer: stripCitationMarkers(sanitizedAnswer),
      citations: [],
      markerCount,
      invalidMarkerCount,
      usedMarkerCount: 0,
    };
  }

  return {
    answer: stripOrphanCitationMarkerVariants(sanitizedAnswer),
    citations: citations.filter((citation, index) =>
      referencedMarkers.has(
        citation.marker
          ? canonicalizeCitationMarker(citation.marker)
          : `[S${index + 1}]`
      )
    ),
    markerCount,
    invalidMarkerCount,
    usedMarkerCount: referencedMarkers.size,
  };
}
