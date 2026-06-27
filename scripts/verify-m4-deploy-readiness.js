#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const envPath = path.resolve(repoRoot, process.argv[2] || ".env.staging");

const REQUIRED_BASE_KEYS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "JWT_ACCESS_EXPIRY",
  "JWT_REFRESH_EXPIRY",
  "NEXT_PUBLIC_APP_URL",
  "USE_SECURE_COOKIES",
  "ENABLE_TEST_ENDPOINTS",
  "APP_IMAGE",
  "MIGRATE_IMAGE",
  "WORKER_IMAGE",
  "AWS_REGION",
  "AWS_S3_BUCKET",
  "AWS_S3_KMS_KEY_ID",
  "AWS_TEXTRACT_REGION",
  "TEXTRACT_FEATURE_SET",
  "TEXTRACT_RESULTS_BUCKET",
  "TEXTRACT_SNS_TOPIC_ARN",
  "TEXTRACT_SQS_QUEUE_URL",
  "TEXTRACT_NOTIFICATION_ROLE_ARN",
  "ENABLE_TEXTRACT_PIPELINE",
  "PINECONE_INDEX_NAME",
  "PINECONE_INDEX_HOST",
  "PINECONE_NAMESPACE_PREFIX",
  "ENABLE_VECTOR_INDEXING",
  "ENABLE_VECTOR_RETRIEVAL",
  "AI_MODEL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSION",
  "ENABLE_AI_CHAT",
  "CHAT_USER_RATE_LIMIT_PER_MINUTE",
  "CHAT_FIRM_RATE_LIMIT_PER_MINUTE",
];

const M4_SECRET_KEYS = ["OPENAI_API_KEY", "PINECONE_API_KEY"];

const PLACEHOLDER_PATTERNS = [
  /^SET_/i,
  /SET_RELEASE_TAG/i,
  /ELASTIC_IP_HERE/i,
  /change-me/i,
  /example\.com/i,
  /localhost/i,
];

function parseEnv(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim().replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

function isMissing(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isPlaceholder(value) {
  if (isMissing(value)) return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(String(value)));
}

function asBool(value) {
  return String(value).trim().toLowerCase() === "true";
}

function main() {
  const failures = [];
  const warnings = [];

  if (!fs.existsSync(envPath)) {
    console.error(`FAIL env file not found: ${envPath}`);
    process.exitCode = 1;
    return;
  }

  const fileEnv = parseEnv(fs.readFileSync(envPath, "utf8"));
  const env = { ...fileEnv, ...process.env };

  for (const key of REQUIRED_BASE_KEYS) {
    if (isMissing(env[key])) {
      failures.push(`missing required key: ${key}`);
    }
  }

  const placeholderKeys = Object.keys(fileEnv)
    .filter((key) => isPlaceholder(env[key]))
    .sort();
  for (const key of placeholderKeys) {
    failures.push(`placeholder value still present: ${key}`);
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL;
  if (!isMissing(appUrl) && !String(appUrl).startsWith("https://")) {
    failures.push("NEXT_PUBLIC_APP_URL must be HTTPS for client document testing");
  }

  if (!asBool(env.USE_SECURE_COOKIES)) {
    failures.push("USE_SECURE_COOKIES must be true for staging/client testing");
  }

  if (String(env.ENABLE_TEST_ENDPOINTS).toLowerCase() !== "false") {
    failures.push("ENABLE_TEST_ENDPOINTS must be false for client-facing deployment");
  }

  if (!asBool(env.ENABLE_AI_CHAT)) {
    failures.push("ENABLE_AI_CHAT must be true for M4 client testing");
  }

  if (!asBool(env.ENABLE_VECTOR_INDEXING)) {
    failures.push("ENABLE_VECTOR_INDEXING must be true for M4 vector evidence");
  }

  if (!asBool(env.ENABLE_VECTOR_RETRIEVAL)) {
    failures.push("ENABLE_VECTOR_RETRIEVAL must be true for M4 vector evidence");
  }

  if (asBool(env.ENABLE_AI_CHAT) || asBool(env.ENABLE_VECTOR_INDEXING) || asBool(env.ENABLE_VECTOR_RETRIEVAL)) {
    for (const key of M4_SECRET_KEYS) {
      if (isMissing(env[key])) {
        failures.push(`missing required M4 secret/config key: ${key}`);
      }
    }
  }

  for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
    if (!isMissing(env[key]) && String(env[key]).length < 32) {
      failures.push(`${key} must be at least 32 characters`);
    }
  }

  if (
    path.basename(envPath).toLowerCase().includes("staging") &&
    !isMissing(env.AWS_S3_BUCKET) &&
    /\bprod(uction)?\b/i.test(String(env.AWS_S3_BUCKET))
  ) {
    failures.push("AWS_S3_BUCKET appears to point at production from a staging env file");
  }

  if (
    !isMissing(env.AWS_S3_KMS_KEY_ID) &&
    !String(env.AWS_S3_KMS_KEY_ID).startsWith("arn:aws:kms:")
  ) {
    failures.push("AWS_S3_KMS_KEY_ID must be a KMS ARN");
  }

  if (!isMissing(env.TEXTRACT_SNS_TOPIC_ARN) && !String(env.TEXTRACT_SNS_TOPIC_ARN).startsWith("arn:aws:sns:")) {
    failures.push("TEXTRACT_SNS_TOPIC_ARN must be an SNS ARN");
  }

  if (!isMissing(env.TEXTRACT_NOTIFICATION_ROLE_ARN) && !String(env.TEXTRACT_NOTIFICATION_ROLE_ARN).startsWith("arn:aws:iam::")) {
    failures.push("TEXTRACT_NOTIFICATION_ROLE_ARN must be an IAM role ARN");
  }

  if (!isMissing(env.TEXTRACT_SQS_QUEUE_URL) && !String(env.TEXTRACT_SQS_QUEUE_URL).startsWith("https://")) {
    failures.push("TEXTRACT_SQS_QUEUE_URL must be an HTTPS SQS queue URL");
  }

  for (const key of ["CHAT_USER_RATE_LIMIT_PER_MINUTE", "CHAT_FIRM_RATE_LIMIT_PER_MINUTE", "EMBEDDING_DIMENSION"]) {
    if (!isMissing(env[key]) && !Number.isFinite(Number(env[key]))) {
      failures.push(`${key} must be numeric`);
    }
  }

  if (!asBool(env.ENABLE_TEXTRACT_PIPELINE)) {
    warnings.push("ENABLE_TEXTRACT_PIPELINE is false; confirm uploaded PDFs already have the required extraction path for client testing");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    for (const warning of warnings) {
      console.warn(`WARN ${warning}`);
    }
    process.exitCode = 1;
    return;
  }

  for (const warning of warnings) {
    console.warn(`WARN ${warning}`);
  }
  console.log(`M4 deployment readiness verified for ${path.relative(repoRoot, envPath)}`);
}

main();
