import { prisma } from "@/lib/prisma";
import { extractStructuredPages } from "@/lib/pdf-processor";
import type { PageText } from "@/lib/pdf-processor";
import type { StructuredPage } from "@/lib/document-structure";
import {
  cleanPageText,
  removeRepeatedHeaders,
} from "@/lib/text-cleaner";
import { chunkDocument } from "@/lib/chunker";

const MIN_TEXT_THRESHOLD = 100;
const MIN_MEANINGFUL_PAGE_CHARS = 80;
const SPARSE_PAGE_CHARS = 40;
const MIN_AVERAGE_CHARS_PER_NON_EMPTY_PAGE = 250;

export interface ExtractionCompletenessAssessment {
  ok: boolean;
  reason: string | null;
  metrics: {
    totalText: number;
    nonEmptyPages: number;
    meaningfulPages: number;
    sparsePages: number;
    densePages: number;
    averageCharsPerNonEmptyPage: number;
    medianCharsPerNonEmptyPage: number;
    structuredPages: number;
    pagesWithBlocks: number;
    pagesWithLines: number;
    pagesWithSpans: number;
    averageBlocksPerNonEmptyPage: number;
    averageLinesPerNonEmptyPage: number;
    averageSpansPerNonEmptyPage: number;
  };
}

export interface PreparedDocumentProcessing {
  cleanedPages: ChunkSourcePage[];
  processedPages: ChunkSourcePage[] | null;
  completeness: ExtractionCompletenessAssessment;
  chunks: ReturnType<typeof chunkDocument>;
}

export type DocumentPageExtractionResult = {
  pages: ChunkSourcePage[];
  pageCount: number;
};

export type ChunkSourcePage = PageText | StructuredPage;

export type DocumentPageExtractor = (
  fileBuffer: Buffer,
  documentId: string
) => Promise<DocumentPageExtractionResult>;

function hasStructuredLayout(page: ChunkSourcePage): page is StructuredPage {
  return (
    Array.isArray((page as StructuredPage).blocks) ||
    Array.isArray((page as StructuredPage).lines) ||
    Array.isArray((page as StructuredPage).spans)
  );
}

async function extractNormalizedStructuredPages(
  fileBuffer: Buffer,
  documentId: string
): Promise<DocumentPageExtractionResult> {
  const { pages, pageCount } = await extractStructuredPages(
    fileBuffer,
    documentId
  );

  return {
    pages: pages.map((page) => ({
      ...page,
      text: cleanPageText(page.text),
    })),
    pageCount,
  };
}

function cleanChunkSourcePage<T extends ChunkSourcePage>(page: T): T {
  return {
    ...page,
    text: cleanPageText(page.text),
  } as T;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

export function assessExtractionCompleteness(
  pages: ChunkSourcePage[],
  pageCount: number
): ExtractionCompletenessAssessment {
  const pageLengths = pages.map((page) => page.text.trim().length);
  const nonEmptyPageLengths = pageLengths.filter((length) => length > 0);
  const totalText = pageLengths.reduce((sum, length) => sum + length, 0);
  const nonEmptyPages = nonEmptyPageLengths.length;
  const meaningfulPages = pageLengths.filter(
    (length) => length >= MIN_MEANINGFUL_PAGE_CHARS
  ).length;
  const sparsePages = pageLengths.filter(
    (length) => length > 0 && length < SPARSE_PAGE_CHARS
  ).length;
  const densePages = pageLengths.filter((length) => length >= 250).length;
  const averageCharsPerNonEmptyPage = nonEmptyPages
    ? totalText / nonEmptyPages
    : 0;
  const medianCharsPerNonEmptyPage = median(nonEmptyPageLengths);
  const structuredPages = pages.filter(hasStructuredLayout);
  const pagesWithBlocks = structuredPages.filter(
    (page) => page.blocks.length > 0
  ).length;
  const pagesWithLines = structuredPages.filter(
    (page) => page.lines.length > 0
  ).length;
  const pagesWithSpans = structuredPages.filter(
    (page) => page.spans.length > 0
  ).length;
  const totalBlocks = structuredPages.reduce(
    (sum, page) => sum + page.blocks.length,
    0
  );
  const totalLines = structuredPages.reduce(
    (sum, page) => sum + page.lines.length,
    0
  );
  const totalSpans = structuredPages.reduce(
    (sum, page) => sum + page.spans.length,
    0
  );
  const averageBlocksPerNonEmptyPage = nonEmptyPages
    ? totalBlocks / nonEmptyPages
    : 0;
  const averageLinesPerNonEmptyPage = nonEmptyPages
    ? totalLines / nonEmptyPages
    : 0;
  const averageSpansPerNonEmptyPage = nonEmptyPages
    ? totalSpans / nonEmptyPages
    : 0;
  const minimumTotalText = Math.max(MIN_TEXT_THRESHOLD, pageCount * 75);
  const minimumMeaningfulPages =
    pageCount >= 4 ? Math.ceil(pageCount * 0.76) : 1;
  const minimumNonEmptyPages = pageCount >= 6 ? Math.ceil(pageCount * 0.76) : 1;

  const metrics = {
    totalText,
    nonEmptyPages,
    meaningfulPages,
    sparsePages,
    densePages,
    averageCharsPerNonEmptyPage,
    medianCharsPerNonEmptyPage,
    structuredPages: structuredPages.length,
    pagesWithBlocks,
    pagesWithLines,
    pagesWithSpans,
    averageBlocksPerNonEmptyPage,
    averageLinesPerNonEmptyPage,
    averageSpansPerNonEmptyPage,
  };

  if (totalText < minimumTotalText) {
    return {
      ok: false,
      reason:
        "Text extraction was too sparse to trust. The PDF may be scanned or the extractor may have only captured a fragment of the document.",
      metrics,
    };
  }

  if (meaningfulPages < minimumMeaningfulPages) {
    return {
      ok: false,
      reason:
        "Too few pages contained meaningful extracted text. This document appears only partially extracted.",
      metrics,
    };
  }

  if (nonEmptyPages < minimumNonEmptyPages) {
    return {
      ok: false,
      reason:
        "Most pages extracted as empty or near-empty text. This document cannot be marked complete.",
      metrics,
    };
  }

  if (
    pageCount >= 10 &&
    averageCharsPerNonEmptyPage < MIN_AVERAGE_CHARS_PER_NON_EMPTY_PAGE
  ) {
    return {
      ok: false,
      reason:
        "The extraction contains too many short pages relative to the document size, which suggests the PDF was only partially captured.",
      metrics,
    };
  }

  if (structuredPages.length > 0) {
    const minimumStructuredBlockDensity = pageCount >= 4 ? 1.5 : 1;
    const minimumStructuredLineDensity = pageCount >= 4 ? 12 : 6;
    const minimumStructuredCoverage = pageCount >= 4 ? 0.7 : 0.5;
    const structuredCoverage = nonEmptyPages
      ? structuredPages.length / nonEmptyPages
      : 0;

    if (
      structuredCoverage < minimumStructuredCoverage ||
      averageBlocksPerNonEmptyPage < minimumStructuredBlockDensity ||
      averageLinesPerNonEmptyPage < minimumStructuredLineDensity
    ) {
      return {
        ok: false,
        reason:
          "The extraction does not contain enough structured page density to trust. This document appears only partially captured or flattened.",
        metrics,
      };
    }
  }

  if (densePages >= 2 && sparsePages >= Math.ceil(pageCount * 0.35)) {
    return {
      ok: false,
      reason:
        "The extraction contains an implausible mix of dense pages and many near-empty pages, which suggests severe partial capture.",
      metrics,
    };
  }

  return {
    ok: true,
    reason: null,
    metrics,
  };
}

/**
 * Prepare the document for persistence without writing to the database.
 */
export function prepareDocumentProcessing(
  pages: ChunkSourcePage[],
  pageCount: number,
  filename: string
): PreparedDocumentProcessing {
  const cleanedPages = pages.map(cleanChunkSourcePage);

  const completeness = assessExtractionCompleteness(cleanedPages, pageCount);
  if (!completeness.ok) {
    return {
      cleanedPages,
      processedPages: null,
      completeness,
      chunks: [],
    };
  }

  const processedPages = removeRepeatedHeaders(cleanedPages as PageText[]) as ChunkSourcePage[];
  const chunks = chunkDocument(processedPages, filename);

  return {
    cleanedPages,
    processedPages,
    completeness,
    chunks,
  };
}

/**
 * Process a PDF document: extract text, clean, chunk, and store.
 *
 * On failure, the document is marked FAILED before the error is rethrown.
 */
export async function processDocument(
  documentId: string,
  fileBuffer: Buffer,
  filename: string,
  extractPages: DocumentPageExtractor = extractNormalizedStructuredPages
): Promise<{ pageCount: number; chunkCount: number }> {
  try {
    const { pages, pageCount } = await extractPages(fileBuffer, documentId);

    const preparation = prepareDocumentProcessing(pages, pageCount, filename);
    const { completeness, processedPages, chunks } = preparation;

    if (!completeness.ok) {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "FAILED",
          errorMessage: completeness.reason,
        },
      });
      throw new Error(
        completeness.reason ?? "Insufficient extractable text"
      );
    }

    if (!processedPages || chunks.length === 0) {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "FAILED",
          errorMessage:
            "No extractable text chunks were produced. This document cannot be marked complete.",
        },
      });
      throw new Error("No extractable text chunks produced");
    }

    await prisma.$transaction(async (tx) => {
      await tx.documentChunk.createMany({
        data: chunks.map((chunk) => ({
          documentId,
          content: chunk.content,
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          tokenEstimate: chunk.tokenEstimate,
          metadata: chunk.metadata,
        })),
      });

      await tx.document.update({
        where: { id: documentId },
        data: {
          status: "COMPLETED",
          pageCount,
        },
      });
    });

    return { pageCount, chunkCount: chunks.length };
  } catch (err: unknown) {
    try {
      const doc = await prisma.document.findUnique({
        where: { id: documentId },
        select: { status: true },
      });
      if (doc && doc.status !== "FAILED") {
        await prisma.document.update({
          where: { id: documentId },
          data: {
            status: "FAILED",
            errorMessage: "Document processing failed",
          },
        });
      }
    } catch {
      // Best-effort status update.
    }

    if (err instanceof Error) {
      throw err;
    }

    throw new Error(String(err));
  }
}
