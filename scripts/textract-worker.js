#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require(path.join(repoRoot, "node_modules", "ts-node")).register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

const { processTextractQueueOnce } = require(path.join(
  repoRoot,
  "src/lib/textract-pipeline.ts"
));

const runContinuously = process.argv.includes("--watch");
const idleDelayMs = Number(process.env.TEXTRACT_WORKER_IDLE_DELAY_MS || 1000);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  do {
    const count = await processTextractQueueOnce();
    if (!runContinuously) {
      console.log(`[textract-worker] Processed ${count} message(s)`);
      return;
    }

    if (count === 0) {
      await sleep(idleDelayMs);
    }
  } while (runContinuously);
}

main().catch((error) => {
  console.error(
    "[textract-worker] Fatal error",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
