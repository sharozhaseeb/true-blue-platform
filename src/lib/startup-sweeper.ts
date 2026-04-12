import { prisma } from "@/lib/prisma";
import { deleteFromS3 } from "@/lib/s3";
import fs from "fs";
import os from "os";
import path from "path";

const ZOMBIE_THRESHOLD_MINUTES = 5;

/**
 * Startup sweeper — runs once when the application starts.
 *
 * 1. Mark zombie documents (UPLOADING/PROCESSING older than 5 min) as FAILED
 * 2. Delete S3 objects for FAILED docs with s3Key (best-effort)
 * 3. Clean up trueblue-*.pdf temp files from os.tmpdir()
 */
export async function runStartupSweeper(): Promise<void> {
  console.log("[sweeper] Starting cleanup...");

  await markZombieDocuments();
  await cleanOrphanedS3Objects();
  cleanTempFiles();

  console.log("[sweeper] Cleanup complete");
}

/**
 * Mark documents stuck in UPLOADING or PROCESSING for more than 5 minutes as FAILED.
 */
async function markZombieDocuments(): Promise<void> {
  try {
    const threshold = new Date(
      Date.now() - ZOMBIE_THRESHOLD_MINUTES * 60 * 1000
    );

    const result = await prisma.document.updateMany({
      where: {
        status: { in: ["UPLOADING", "PROCESSING"] },
        updatedAt: { lt: threshold },
      },
      data: {
        status: "FAILED",
        errorMessage:
          "Processing interrupted — document may need to be re-uploaded",
      },
    });

    if (result.count > 0) {
      console.log(
        `[sweeper] Marked ${result.count} zombie document(s) as FAILED`
      );
    }
  } catch (err) {
    console.error("[sweeper] Failed to mark zombie documents");
  }
}

/**
 * Delete S3 objects for FAILED documents that have an s3Key set.
 * Best-effort: log failures but don't throw.
 */
async function cleanOrphanedS3Objects(): Promise<void> {
  try {
    const failedDocs = await prisma.document.findMany({
      where: {
        status: "FAILED",
        s3Key: { not: "" },
      },
      select: {
        id: true,
        s3Bucket: true,
        s3Key: true,
      },
    });

    for (const doc of failedDocs) {
      try {
        await deleteFromS3(doc.s3Bucket, doc.s3Key);
        console.log(
          `[sweeper] Deleted orphaned S3 object for document ${doc.id}`
        );
      } catch {
        console.error(
          `[sweeper] Failed to delete S3 object for document ${doc.id}`
        );
      }
    }
  } catch {
    console.error("[sweeper] Failed to query orphaned S3 objects");
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
          // Best-effort — file may be locked or already deleted
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
