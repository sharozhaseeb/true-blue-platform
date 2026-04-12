/**
 * Next.js instrumentation hook — runs once on server startup.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Used to run the startup sweeper which:
 * 1. Marks zombie documents (stuck in UPLOADING/PROCESSING) as FAILED
 * 2. Cleans up orphaned S3 objects for FAILED documents
 * 3. Deletes leftover temp PDF files from os.tmpdir()
 */
export async function register() {
  // Only run on the server, not in Edge Runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupSweeper } = await import("@/lib/startup-sweeper");
    await runStartupSweeper();
  }
}
