import { PageText } from "@/lib/pdf-processor";
import type { StructuredPage } from "@/lib/document-structure";
import { resolvePageFormTypes } from "@/lib/form-resolution";
import type { FormTypeSource } from "@/lib/form-resolution";
import { normalizeStructuredBlockText } from "@/lib/text-cleaner";

export interface DocumentChunkData {
  content: string;
  pageNumber: number;
  chunkIndex: number;
  tokenEstimate: number;
  metadata: {
    filename: string;
    formType: string | null; // stable public alias for resolvedFormType
    explicitFormType: string | null;
    resolvedFormType: string | null;
    formTypeSource: FormTypeSource | null;
    formTypeOriginPage: number | null;
    sourcePageNumbers: number[];
    coversPageStart: boolean;
    coversPageEnd: boolean;
    pageRange?: string;
    isPartialPage?: boolean;
    partIndex?: number;
  };
}

export const MAX_TOKENS_PER_CHUNK = 1200;
export const OVERLAP_TOKENS = 100;
const WHITESPACE_RE = /\s/;

type ChunkSourcePage = PageText | StructuredPage;

/**
 * Estimate the number of tokens in a string.
 * Approximation: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text at paragraph boundaries (double newline) to stay under maxTokens.
 * Adds overlap between sub-chunks.
 */
export function splitAtParagraphBoundary(
  text: string,
  maxTokens: number,
  overlap: number
): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }

    if (estimateTokens(trimmedParagraph) > maxTokens) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      chunks.push(...splitChunkIfNeeded(trimmedParagraph, maxTokens, overlap));
      continue;
    }

    const candidate = currentChunk
      ? currentChunk + "\n\n" + trimmedParagraph
      : trimmedParagraph;

    if (estimateTokens(candidate) > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());

      currentChunk = buildChunkWithOverlap(
        currentChunk,
        trimmedParagraph,
        maxTokens,
        overlap
      );
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.flatMap((chunk) =>
    splitChunkIfNeeded(chunk, maxTokens, overlap)
  );
}

function splitChunkIfNeeded(
  text: string,
  maxTokens: number,
  overlap: number
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= maxTokens) {
    return [trimmed];
  }

  return forceSplitByLength(trimmed, maxTokens, overlap).flatMap((chunk) =>
    splitChunkIfNeeded(chunk, maxTokens, overlap)
  );
}

function buildChunkWithOverlap(
  previousChunk: string,
  nextChunk: string,
  maxTokens: number,
  overlap: number
): string {
  const trimmedNext = nextChunk.trim();
  if (!trimmedNext) {
    return "";
  }

  const nextTokens = estimateTokens(trimmedNext);
  if (nextTokens >= maxTokens) {
    return trimmedNext;
  }

  const maxOverlapTokens = Math.min(overlap, Math.max(maxTokens - nextTokens, 0));

  for (let overlapTokens = maxOverlapTokens; overlapTokens > 0; overlapTokens--) {
    const overlapText = getOverlapText(previousChunk, overlapTokens);
    const candidate = overlapText ? overlapText + "\n\n" + trimmedNext : trimmedNext;

    if (estimateTokens(candidate) <= maxTokens) {
      return candidate.trim();
    }
  }

  return trimmedNext;
}

function walkToTokenBoundary(
  text: string,
  position: number,
  lowerBound: number,
  upperBound: number,
  direction: "forward" | "backward"
): number {
  const cap = Math.min(upperBound, text.length);
  if (direction === "backward") {
    for (let i = Math.min(position, cap); i > lowerBound; i--) {
      if (WHITESPACE_RE.test(text[i])) return i;
    }
    for (let i = Math.min(position, cap) + 1; i < cap; i++) {
      if (WHITESPACE_RE.test(text[i])) return i;
    }
    return position;
  }

  let i = Math.max(lowerBound, position);
  if (i >= cap) return cap;

  if (WHITESPACE_RE.test(text[i])) {
    while (i < cap && WHITESPACE_RE.test(text[i])) i++;
    return i;
  }

  while (i < cap && !WHITESPACE_RE.test(text[i])) i++;
  while (i < cap && WHITESPACE_RE.test(text[i])) i++;
  return i;
}

function getOverlapText(text: string, overlapTokens: number): string {
  const charCount = overlapTokens * 4;
  if (text.length <= charCount) return text;
  const target = text.length - charCount;
  const anchored = walkToTokenBoundary(text, target, 0, text.length, "forward");
  return anchored >= text.length ? "" : text.substring(anchored);
}

function forceSplitByLength(
  text: string,
  maxTokens: number,
  overlap: number
): string[] {
  const maxChars = maxTokens * 4;
  const overlapChars = Math.min(overlap * 4, maxChars - 100);
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      end = walkToTokenBoundary(text, end, start + 1, text.length, "backward");
    }

    chunks.push(text.substring(start, end).trim());

    if (end >= text.length) break;

    const overlapTarget = end - overlapChars;
    let nextStart = walkToTokenBoundary(
      text,
      overlapTarget,
      start + 1,
      end,
      "forward"
    );
    if (nextStart >= end) {
      nextStart = end;
    }

    start = Math.max(nextStart, start + 1);
  }

  return chunks;
}

function hasStructuredBlocks(page: ChunkSourcePage): page is StructuredPage {
  return Array.isArray((page as StructuredPage).blocks);
}

function splitFlatPageUnits(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function collectPageUnits(page: ChunkSourcePage): string[] {
  if (hasStructuredBlocks(page) && page.blocks.length > 0) {
    const blockUnits = page.blocks
      .map((block) => normalizeStructuredBlockText(block))
      .filter(Boolean);

    if (blockUnits.length > 0) {
      return blockUnits;
    }
  }

  return splitFlatPageUnits(page.text);
}

function chunkPageUnits(
  units: string[],
  maxTokens: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const unit of units) {
    const trimmedUnit = unit.trim();
    if (!trimmedUnit) {
      continue;
    }

    if (estimateTokens(trimmedUnit) > maxTokens) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      chunks.push(trimmedUnit);
      continue;
    }

    const candidate = currentChunk
      ? currentChunk + "\n\n" + trimmedUnit
      : trimmedUnit;

    if (estimateTokens(candidate) > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());

      currentChunk = buildChunkWithOverlap(
        currentChunk,
        trimmedUnit,
        maxTokens,
        overlap
      );
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.flatMap((chunk) =>
    splitChunkIfNeeded(chunk, maxTokens, overlap)
  );
}

/**
 * Hybrid page-based chunking.
 *
 * Pages stay page-local by default. Large pages may split into sub-chunks with
 * overlap, but short pages are no longer merged across boundaries because that
 * made chunk starts ambiguous and smeared form labels.
 */
export function chunkDocument(
  pages: ChunkSourcePage[],
  filename: string
): DocumentChunkData[] {
  const chunks: DocumentChunkData[] = [];
  const pageForms = new Map(
    resolvePageFormTypes(pages).map((entry) => [entry.pageNumber, entry])
  );
  let chunkIndex = 0;

  for (const page of pages) {
    const text = page.text.trim();
    if (!text) continue;

    const pageForm = pageForms.get(page.pageNumber) ?? {
      pageNumber: page.pageNumber,
      explicitFormType: null,
      resolvedFormType: null,
      formTypeSource: null,
      formTypeOriginPage: null,
    };

    const pageChunks = chunkPageUnits(
      collectPageUnits(page),
      MAX_TOKENS_PER_CHUNK,
      OVERLAP_TOKENS
    );

    for (let partIndex = 0; partIndex < pageChunks.length; partIndex++) {
      const content = pageChunks[partIndex];
      const isPartialPage = pageChunks.length > 1;
      const coversPageStart = partIndex === 0;
      const coversPageEnd = partIndex === pageChunks.length - 1;

      chunks.push({
        content,
        pageNumber: page.pageNumber,
        chunkIndex,
        tokenEstimate: estimateTokens(content),
        metadata: {
          filename,
          formType: pageForm.resolvedFormType, // public alias for resolved ownership
          explicitFormType: pageForm.explicitFormType,
          resolvedFormType: pageForm.resolvedFormType,
          formTypeSource: pageForm.formTypeSource,
          formTypeOriginPage: pageForm.formTypeOriginPage,
          sourcePageNumbers: [page.pageNumber],
          coversPageStart,
          coversPageEnd,
          ...(isPartialPage
            ? {
                isPartialPage: true,
                partIndex,
              }
            : {}),
        },
      });
      chunkIndex++;
    }
  }

  return chunks;
}
