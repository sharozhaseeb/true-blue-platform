import { prisma } from "@/lib/prisma";
import { extractTextByPage } from "@/lib/pdf-processor";
import {
  cleanPageText,
  detectFormType,
  removeRepeatedHeaders,
} from "@/lib/text-cleaner";
import { chunkDocument } from "@/lib/chunker";

const MIN_TEXT_THRESHOLD = 100; // Minimum total characters across all pages

/**
 * Process a PDF document: extract text, clean, chunk, and store.
 *
 * Orchestrates the full pipeline:
 * 1. Extract text page-by-page (worker process with 30s timeout)
 * 2. Minimum text threshold check
 * 3. Clean each page's text
 * 4. Detect form types
 * 5. Remove repeated headers
 * 6. Chunk the document
 * 7. Store all chunks in a single prisma.$transaction()
 * 8. Update document status to COMPLETED
 *
 * On failure, document is marked FAILED with a generic error message.
 */
export async function processDocument(
  documentId: string,
  fileBuffer: Buffer,
  filename: string
): Promise<{ pageCount: number; chunkCount: number }> {
  try {
    // Step 1: Extract text page-by-page
    const { pages, pageCount } = await extractTextByPage(
      fileBuffer,
      documentId
    );

    // Step 2: Clean each page's text
    const cleanedPages = pages.map((page) => ({
      ...page,
      text: cleanPageText(page.text),
    }));

    // Step 3: Minimum text threshold check
    const totalText = cleanedPages.reduce(
      (sum, page) => sum + page.text.length,
      0
    );
    if (totalText < MIN_TEXT_THRESHOLD) {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: "FAILED",
          errorMessage:
            "No extractable text found. This may be a scanned or image-only PDF — please use a text-based PDF for Milestone 2, or wait for OCR support in Milestone 5.",
        },
      });
      throw new Error("Insufficient extractable text");
    }

    // Step 4: Remove repeated headers
    const processedPages = removeRepeatedHeaders(cleanedPages);

    // Step 5: Chunk the document
    const chunks = chunkDocument(processedPages, filename);

    // Step 6: Store all chunks in a single transaction + update document
    await prisma.$transaction(async (tx) => {
      // Insert all chunks
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

      // Update document status to COMPLETED
      await tx.document.update({
        where: { id: documentId },
        data: {
          status: "COMPLETED",
          pageCount,
        },
      });
    });

    return { pageCount, chunkCount: chunks.length };
  } catch (err: any) {
    // If the document isn't already marked FAILED, mark it now
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
      // Best-effort status update — don't mask the original error
    }

    throw err;
  }
}
