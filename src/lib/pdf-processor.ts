import { Worker } from "worker_threads";
import fs from "fs";
import os from "os";
import path from "path";

export interface PageText {
  pageNumber: number;
  text: string;
}

const WORKER_TIMEOUT_MS = 30_000; // 30 seconds

// The worker script as a string — avoids file-path resolution issues
// with Next.js Turbopack/standalone bundling. The worker runs in a
// separate V8 isolate with its own event loop.
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
      const pageNum = currentPage;
      return pageData.getTextContent().then(function(textContent) {
        let text = '';
        for (const item of textContent.items) {
          text += item.str + ' ';
        }
        pages.push({ pageNumber: pageNum, text: text.trim() });
        return text;
      });
    }
  });

  parentPort.postMessage({
    success: true,
    pages: pages.sort((a, b) => a.pageNumber - b.pageNumber),
    pageCount: result.numpages
  });
}

run().catch(err => {
  parentPort.postMessage({ success: false, error: err.message || 'PDF parsing failed' });
});
`;

/**
 * Extract text from a PDF buffer page-by-page using an isolated worker thread.
 *
 * The worker runs in a separate V8 isolate. On timeout, worker.terminate()
 * kills the thread immediately — true cancellation, no stale CPU burn.
 *
 * The buffer is written to a temp file to avoid IPC memory duplication.
 */
export async function extractTextByPage(
  fileBuffer: Buffer,
  documentId: string
): Promise<{ pages: PageText[]; pageCount: number }> {
  const tempPath = path.join(os.tmpdir(), `trueblue-${documentId}.pdf`);

  try {
    fs.writeFileSync(tempPath, fileBuffer);

    return await new Promise<{ pages: PageText[]; pageCount: number }>(
      (resolve, reject) => {
        let settled = false;

        const worker = new Worker(WORKER_SCRIPT, {
          eval: true,
          workerData: { filePath: tempPath },
        });

        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            worker.terminate();
            reject(
              new Error("PDF processing timed out after 30 seconds")
            );
          }
        }, WORKER_TIMEOUT_MS);

        worker.on("message", (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);

          if (msg.success) {
            resolve({ pages: msg.pages, pageCount: msg.pageCount });
          } else {
            reject(new Error(msg.error || "PDF parsing failed"));
          }
        });

        worker.on("error", (err) => {
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
      }
    );
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best-effort — startup sweeper catches leftovers
    }
  }
}
