import { prisma } from "@/lib/prisma";
import fs from "fs";
import os from "os";
import path from "path";

const ABANDONED_UPLOAD_THRESHOLD_MINUTES = 30;

/**
 * Startup sweeper - runs once when the application starts.
 *
 * PROCESSING documents are intentionally excluded because async Textract jobs
 * can survive app restarts and exceed short startup windows. Provider cleanup
 * and storage deletion belong to explicit reconciliation/delete flows.
 */
export async function runStartupSweeper(): Promise<void> {
  console.log("[sweeper] Starting cleanup...");

  await markAbandonedUploads();
  cleanTempFiles();

  console.log("[sweeper] Cleanup complete");
}

async function markAbandonedUploads(): Promise<void> {
  try {
    const threshold = new Date(
      Date.now() - ABANDONED_UPLOAD_THRESHOLD_MINUTES * 60 * 1000
    );

    const result = await prisma.document.updateMany({
      where: {
        status: "UPLOADING",
        updatedAt: { lt: threshold },
      },
      data: {
        status: "FAILED",
        errorMessage: "Upload interrupted - document may need to be re-uploaded",
      },
    });

    if (result.count > 0) {
      console.log(
        `[sweeper] Marked ${result.count} abandoned upload(s) as FAILED`
      );
    }
  } catch {
    console.error("[sweeper] Failed to mark abandoned uploads");
  }
}

/**
 * Delete any trueblue-*.pdf temp files from os.tmpdir().
 * These are leftover from worker handoffs that survived a crash.
 */
function cleanTempFiles(): void {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    let cleaned = 0;

    for (const file of files) {
      if (file.startsWith("trueblue-") && file.endsWith(".pdf")) {
        try {
          fs.unlinkSync(path.join(tmpDir, file));
          cleaned++;
        } catch {
          // Best-effort: file may be locked or already deleted.
        }
      }
    }

    if (cleaned > 0) {
      console.log(`[sweeper] Cleaned ${cleaned} temp file(s)`);
    }
  } catch {
    console.error("[sweeper] Failed to clean temp files");
  }
}
