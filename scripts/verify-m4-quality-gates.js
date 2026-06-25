#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const { spawnSync } = require("child_process");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(
  request,
  parent,
  isMain,
  options
) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const tsNode = require(path.join(repoRoot, "node_modules", "ts-node"));
tsNode.register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

const REGRESSION_COMMANDS = [
  ["node", ["scripts/verify-base-document-normalizer.js"]],
  ["node", ["scripts/verify-base-document-retrieval.js"]],
  ["node", ["scripts/verify-persisted-base-document-retrieval.js"]],
  ["node", ["scripts/verify-textract-pipeline.js"]],
  ["node", ["scripts/verify-chat-persistence.js"]],
  ["node", ["scripts/verify-chat-api-boundary.js"]],
  ["node", ["scripts/verify-chat-streaming-contract.js"]],
  ["node", ["scripts/verify-chat-hardening.js"]],
  ["node", ["scripts/verify-vector-provider-config.js"]],
  ["node", ["scripts/verify-vector-indexing.js"]],
  ["node", ["scripts/verify-vector-retrieval.js"]],
  ["node", ["scripts/verify-chat-output-schema.js"]],
  ["node", ["scripts/verify-m4-structured-output.js"]],
  ["node", ["scripts/verify-tenant-context.js"]],
];

function main() {
  const failures = [];
  const results = [];

  for (const [command, args] of REGRESSION_COMMANDS) {
    const result = spawnSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    const label = [command, ...args].join(" ");
    results.push({
      label,
      status: result.status,
    });

    if (result.status !== 0) {
      failures.push(`regression command failed: ${label}\n${result.stderr || result.stdout}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("M4 quality gates verified");
  console.log(JSON.stringify({ regressions: results }, null, 2));
}

main();
