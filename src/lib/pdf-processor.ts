import { Worker } from "worker_threads";
import fs from "fs";
import os from "os";
import path from "path";
import { buildStructuredPageFromTextContent } from "./document-structure";
import type { StructuredPageExtractionResult } from "./document-structure";

export interface PageText {
  pageNumber: number;
  text: string;
}

const WORKER_TIMEOUT_MS = 30_000;

if (typeof buildStructuredPageFromTextContent !== "function") {
  throw new Error("Structured document helper failed to load");
}

const WORKER_SCRIPT = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

async function run() {
  const buffer = fs.readFileSync(workerData.filePath);
  const pdfParse = require('pdf-parse/lib/pdf-parse');

  const pages = [];
  let currentPage = 0;

  const result = await pdfParse(buffer, {
    pagerender: function(pageData) {
      currentPage++;
      const pageNumber = currentPage;
      return pageData
        .getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        })
        .then(function(textContent) {
          const items = Array.isArray(textContent.items) ? textContent.items : [];
          pages.push({
            pageNumber,
            items,
            text: items
              .map((item) => String(item && item.str != null ? item.str : ""))
              .join(" "),
          });
          return pages[pages.length - 1].text;
        });
    }
  });

  parentPort.postMessage({
    success: true,
    pages: pages.sort((left, right) => left.pageNumber - right.pageNumber),
    pageCount: result.numpages,
  });
}

run().catch((err) => {
  parentPort.postMessage({
    success: false,
    error: err.message || 'PDF parsing failed',
  });
});
`;

async function runStructuredExtractionWorker(
  filePath: string
): Promise<{
  pages: Array<{
    pageNumber: number;
    items: Array<Record<string, unknown>>;
    text: string;
  }>;
  pageCount: number;
}> {
  return await new Promise<{
    pages: Array<{
      pageNumber: number;
      items: Array<Record<string, unknown>>;
      text: string;
    }>;
    pageCount: number;
  }>((resolve, reject) => {
    let settled = false;

    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      workerData: { filePath },
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        reject(new Error("PDF processing timed out after 30 seconds"));
      }
    }, WORKER_TIMEOUT_MS);

    worker.on("message", (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (msg.success) {
        resolve({
          pages: msg.pages,
          pageCount: msg.pageCount,
        });
      } else {
        reject(new Error(msg.error || "PDF parsing failed"));
      }
    });

    worker.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("PDF worker thread error"));
    });

    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`PDF worker exited with code ${code}`));
      }
    });
  });
}

/**
 * Extract structured page content from a PDF buffer using an isolated worker thread.
 */
export async function extractStructuredPages(
  fileBuffer: Buffer,
  documentId: string
): Promise<StructuredPageExtractionResult> {
  const tempPath = path.join(os.tmpdir(), `trueblue-${documentId}.pdf`);

  try {
    fs.writeFileSync(tempPath, fileBuffer);

    const { pages: rawPages, pageCount } = await runStructuredExtractionWorker(
      tempPath
    );
    const pages = rawPages
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map((page) =>
        buildStructuredPageFromTextContent(
          { items: page.items },
          page.pageNumber
        )
      );

    return {
      pages,
      pageCount,
    };
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Extract text from a PDF buffer page-by-page using the structured page model.
 */
export async function extractTextByPage(
  fileBuffer: Buffer,
  documentId: string
): Promise<{ pages: PageText[]; pageCount: number }> {
  const { pages, pageCount } = await extractStructuredPages(
    fileBuffer,
    documentId
  );

  return {
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
    })),
    pageCount,
  };
}
