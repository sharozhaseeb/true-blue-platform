#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
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

const {
  checkChatRateLimits,
  checkRateLimit,
  resetRateLimitsForTests,
} = require(path.join(repoRoot, "src/lib/rate-limit.ts"));
const {
  createRedactedLogRecord,
} = require(path.join(repoRoot, "src/lib/server-logger.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function verifyRateLimit(failures) {
  resetRateLimitsForTests();
  const first = checkRateLimit({
    key: "chat:user:user_a",
    limit: 2,
    windowMs: 60_000,
    now: 1_000,
  });
  const second = checkRateLimit({
    key: "chat:user:user_a",
    limit: 2,
    windowMs: 60_000,
    now: 2_000,
  });
  const third = checkRateLimit({
    key: "chat:user:user_a",
    limit: 2,
    windowMs: 60_000,
    now: 3_000,
  });
  const reset = checkRateLimit({
    key: "chat:user:user_a",
    limit: 2,
    windowMs: 60_000,
    now: 61_001,
  });

  assertCondition(first.allowed, "first request should be allowed", failures);
  assertCondition(second.allowed, "second request should be allowed", failures);
  assertCondition(!third.allowed, "third request should be rate limited", failures);
  assertCondition(third.remaining === 0, "rate-limited request should have zero remaining", failures);
  assertCondition(reset.allowed, "request after reset window should be allowed", failures);

  resetRateLimitsForTests();
  const previousFirmLimit = process.env.CHAT_FIRM_RATE_LIMIT_PER_MINUTE;
  const previousUserLimit = process.env.CHAT_USER_RATE_LIMIT_PER_MINUTE;
  process.env.CHAT_FIRM_RATE_LIMIT_PER_MINUTE = "1";
  process.env.CHAT_USER_RATE_LIMIT_PER_MINUTE = "2";
  const firstCombined = checkChatRateLimits({
    firmId: "firm_shared",
    userId: "user_a",
    now: 10_000,
  });
  const firmDenied = checkChatRateLimits({
    firmId: "firm_shared",
    userId: "user_b",
    now: 11_000,
  });
  const userStillHasQuota = checkChatRateLimits({
    firmId: "firm_other",
    userId: "user_b",
    now: 12_000,
  });
  process.env.CHAT_FIRM_RATE_LIMIT_PER_MINUTE = previousFirmLimit;
  process.env.CHAT_USER_RATE_LIMIT_PER_MINUTE = previousUserLimit;

  assertCondition(firstCombined.allowed, "first combined request should be allowed", failures);
  assertCondition(!firmDenied.allowed, "shared firm limit should deny second request", failures);
  assertCondition(
    userStillHasQuota.allowed,
    "firm-denied request should not consume the user's own quota",
    failures
  );
}

function verifyRedaction(failures) {
  const record = createRedactedLogRecord("info", "chat.completed", {
    firmId: "firm_a",
    userId: "user_a",
    threadId: "thread_a",
    messageContent: "Taxpayer secret text",
    Message: "Uppercase message text",
    errorMessage: "Provider error with raw text",
    completionText: "Completion text",
    presignedUrl: "https://example.com/signed-secret",
    apiKey: "provider-api-key",
    accessKeyId: "aws-access-key",
    credential: "generic credential",
    nested: {
      prompt: "Raw prompt",
      RawText: "Raw extracted text",
      citations: [{ snippet: "Sensitive extracted snippet", chunkId: "chunk_a" }],
    },
    error: new Error("Sensitive provider failure"),
  });
  const serialized = JSON.stringify(record);

  assertCondition(record.firmId === "firm_a", "safe IDs should remain visible", failures);
  assertCondition(
    !serialized.includes("Taxpayer secret text") &&
      !serialized.includes("Raw prompt") &&
      !serialized.includes("Uppercase message text") &&
      !serialized.includes("Provider error with raw text") &&
      !serialized.includes("Completion text") &&
      !serialized.includes("https://example.com/signed-secret") &&
      !serialized.includes("provider-api-key") &&
      !serialized.includes("aws-access-key") &&
      !serialized.includes("generic credential") &&
      !serialized.includes("Raw extracted text") &&
      !serialized.includes("Sensitive extracted snippet") &&
      !serialized.includes("Sensitive provider failure"),
    "redacted log record leaked sensitive values",
    failures
  );
  assertCondition(
    serialized.includes("[REDACTED]"),
    "redacted log record should mark sensitive values",
    failures
  );
}

function main() {
  const failures = [];
  verifyRateLimit(failures);
  verifyRedaction(failures);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Chat hardening verified: rate limits and redacted logs");
}

main();
