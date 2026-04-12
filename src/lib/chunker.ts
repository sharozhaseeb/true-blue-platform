import { PageText } from "@/lib/pdf-processor";
import { detectFormType } from "@/lib/text-cleaner";

export interface DocumentChunkData {
  content: string;
  pageNumber: number;
  chunkIndex: number;
  tokenEstimate: number;
  metadata: {
    filename: string;
    formType: string | null;
    pageRange?: string;
    isPartialPage?: boolean;
    partIndex?: number;
  };
}

const MAX_TOKENS_PER_CHUNK = 1200;
const MIN_PAGE_TOKENS = 50;
const OVERLAP_TOKENS = 100;

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
    const candidate = currentChunk
      ? currentChunk + "\n\n" + paragraph
      : paragraph;

    if (estimateTokens(candidate) > maxTokens && currentChunk) {
      chunks.push(currentChunk.trim());

      // Add overlap from the end of the current chunk
      const overlapText = getOverlapText(currentChunk, overlap);
      currentChunk = overlapText ? overlapText + "\n\n" + paragraph : paragraph;
    } else {
      currentChunk = candidate;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // If we couldn't split by paragraphs (single huge paragraph), force-split by characters
  if (chunks.length === 1 && estimateTokens(chunks[0]) > maxTokens) {
    return forceSplitByLength(chunks[0], maxTokens, overlap);
  }

  return chunks;
}

/**
 * Get the last N tokens worth of text for overlap.
 */
function getOverlapText(text: string, overlapTokens: number): string {
  const charCount = overlapTokens * 4; // Reverse the token estimation
  if (text.length <= charCount) return text;
  return text.substring(text.length - charCount);
}

/**
 * Force-split text by character length when paragraph splitting isn't possible.
 */
function forceSplitByLength(
  text: string,
  maxTokens: number,
  overlap: number
): string[] {
  const maxChars = maxTokens * 4;
  const overlapChars = Math.min(overlap * 4, maxChars - 100); // Overlap can't exceed chunk size
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at a space boundary
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > start + maxChars * 0.5) {
        end = lastSpace;
      }
    }

    chunks.push(text.substring(start, end).trim());

    if (end >= text.length) break;

    // Next chunk starts with overlap from end of current
    const nextStart = end - overlapChars;
    // Guarantee forward progress: never go backwards
    start = Math.max(nextStart, start + 1);
  }

  return chunks;
}

/**
 * Hybrid page-based chunking.
 *
 * Strategy:
 * 1. One chunk per page (default)
 * 2. Pages exceeding ~1200 tokens → split at paragraph boundaries
 * 3. Sub-chunks get same pageNumber, incremented chunkIndex
 * 4. 100-token overlap between sub-chunks
 * 5. Empty pages skipped
 * 6. Pages under 50 tokens merged with the next page
 */
export function chunkDocument(
  pages: PageText[],
  filename: string
): DocumentChunkData[] {
  const chunks: DocumentChunkData[] = [];
  let chunkIndex = 0;
  let pendingMerge: { text: string; startPage: number } | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const text = page.text.trim();

    // Skip empty pages
    if (!text) continue;

    let currentText = text;
    let currentPageNumber = page.pageNumber;

    // Handle pending merge from previous short page
    if (pendingMerge) {
      currentText = pendingMerge.text + "\n\n" + currentText;
      currentPageNumber = pendingMerge.startPage;
      pendingMerge = null;
    }

    const tokens = estimateTokens(currentText);

    // Pages under 50 tokens: merge with next page
    if (tokens < MIN_PAGE_TOKENS && i < pages.length - 1) {
      pendingMerge = { text: currentText, startPage: currentPageNumber };
      continue;
    }

    const formType = detectFormType(currentText);

    // Pages exceeding max tokens: split at paragraph boundaries
    if (tokens > MAX_TOKENS_PER_CHUNK) {
      const subChunks = splitAtParagraphBoundary(
        currentText,
        MAX_TOKENS_PER_CHUNK,
        OVERLAP_TOKENS
      );

      for (let j = 0; j < subChunks.length; j++) {
        const subText = subChunks[j];
        chunks.push({
          content: subText,
          pageNumber: currentPageNumber,
          chunkIndex,
          tokenEstimate: estimateTokens(subText),
          metadata: {
            filename,
            formType,
            isPartialPage: true,
            partIndex: j,
            ...(currentPageNumber !== page.pageNumber
              ? { pageRange: `${currentPageNumber}-${page.pageNumber}` }
              : {}),
          },
        });
        chunkIndex++;
      }
    } else {
      // Normal case: one chunk per page
      chunks.push({
        content: currentText,
        pageNumber: currentPageNumber,
        chunkIndex,
        tokenEstimate: tokens,
        metadata: {
          filename,
          formType,
          ...(pendingMerge !== null ||
          currentPageNumber !== page.pageNumber
            ? { pageRange: `${currentPageNumber}-${page.pageNumber}` }
            : {}),
        },
      });
      chunkIndex++;
    }
  }

  // Handle any remaining pending merge (last page was short)
  if (pendingMerge) {
    const formType = detectFormType(pendingMerge.text);
    chunks.push({
      content: pendingMerge.text,
      pageNumber: pendingMerge.startPage,
      chunkIndex,
      tokenEstimate: estimateTokens(pendingMerge.text),
      metadata: {
        filename,
        formType,
      },
    });
  }

  return chunks;
}
