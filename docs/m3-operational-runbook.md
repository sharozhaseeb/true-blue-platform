# M3 Operational Runbook

This runbook covers the M3 structured-document, vector indexing, vector retrieval, and grounded chat foundation. Staging has live Textract enabled; Pinecone/OpenAI provider wiring, AI SDK streaming, and assistant-ui integration are implemented locally and should be promoted only with client-owned credentials.

## Current Operating Mode

| Area | Current State | Operator Action |
| --- | --- | --- |
| Structured extraction | Live AWS Textract -> SNS -> SQS -> worker -> `BaseDocument` artifact mode in staging | Keep testing with sample PDFs until full provider/data-processing approval is complete |
| Retrieval | Postgres-backed structured chunks with optional Pinecone vector retrieval and lexical local fallback | Enable `ENABLE_VECTOR_RETRIEVAL=true` only after vector indexing smoke passes on staging |
| Chat | Authenticated firm-scoped `/api/chat` with legacy JSON compatibility and AI SDK streaming support | Enable `ENABLE_AI_CHAT=true` only after OpenAI/Pinecone staging smoke passes with sample data |
| UI | `/dashboard/chat` assistant-ui surface for firm users/admins only | Platform admins need an explicit firm context before chat is supported |
| Logs | Redacted JSON records for chat completion, failure, and rate limiting | Logs may contain IDs/counts/durations only, not prompts, answers, snippets, or extracted text |

## Required Verification

Run these before staging promotion:

```bash
node scripts/verify-chat-hardening.js
node scripts/verify-vector-provider-config.js
node scripts/verify-vector-indexing.js
node scripts/verify-vector-retrieval.js
node scripts/verify-chat-streaming-contract.js
node scripts/verify-m3-quality-gates.js
npx tsc --noEmit
npm run build
```

`npm run lint` currently has unrelated legacy failures. For the M3 slices, run targeted ESLint over changed files until the repo-wide lint backlog is cleaned.

Targeted M3 lint command:

```bash
npx eslint src/app/api/chat/route.ts "src/app/(dashboard)/dashboard/chat/page.tsx" "src/app/api/documents/[id]/route.ts" scripts/verify-chat-api-boundary.js scripts/verify-chat-streaming-contract.js scripts/verify-textract-pipeline.js scripts/verify-vector-indexing.js scripts/verify-vector-retrieval.js
```

## Chat Rate Limits

Environment variables:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `CHAT_USER_RATE_LIMIT_PER_MINUTE` | `60` | Max chat requests per user per app process per minute |
| `CHAT_FIRM_RATE_LIMIT_PER_MINUTE` | `300` | Max chat requests per firm per app process per minute |

Current implementation is in-memory and process-local. It is acceptable for single-instance staging and should be replaced with Redis, DynamoDB, or another shared counter before horizontal scaling.

If users report `429` responses:

1. Check app logs for `chat.rate_limited`.
2. Confirm whether the limit is user-level or firm-level from the logged `limit` and IDs.
3. If legitimate testing is blocked, temporarily raise the env value and restart the app.
4. Do not disable rate limits for real client data.

## Redacted Logging Rules

Allowed log fields:

- firm ID
- user ID
- thread ID
- counts
- durations
- boolean statuses
- error class names

Disallowed log fields:

- user prompt text
- assistant answer text
- raw extracted text
- citation snippets
- provider payloads
- cookies, tokens, secrets, passwords
- presigned URLs

The logger redacts sensitive key families case-insensitively, including `message`, `content`, `text`, `snippet`, `prompt`, `completion`, `token`, `secret`, `password`, and `cookie`. Still prefer explicit safe-field logging instead of relying only on redaction.

## Failed Chat Request

Symptoms:

- User sees a chat error.
- App logs `chat.expected_error` for expected validation/retrieval-limit failures or `chat.failed` for unexpected failures.
- A user message may have been persisted before retrieval or assistant persistence failed.

Recovery:

1. Ask the user to retry the same prompt in the same browser session. The UI reuses the same request key for same-content failed retries.
2. If the assistant response was already persisted, the API returns the persisted assistant without recomputing retrieval.
3. If repeated failures continue, run:

```bash
node scripts/verify-chat-api-boundary.js
node scripts/verify-persisted-base-document-retrieval.js
```

4. Check whether the failure is due to candidate overflow. If so, narrow the document filter or move to vector retrieval before increasing candidate limits.

## Stuck Or Failed Structured Artifact

For local or fixture-backed artifact mode:

1. Re-run `node scripts/verify-base-document-normalizer.js`.
2. Re-run `node scripts/verify-base-document-persistence-service.js`.
3. Inspect artifact status in Postgres:

```sql
SELECT id, "documentId", "firmId", generation, "isCurrent", status, "lastErrorCode", "lastErrorMessage"
FROM document_base_artifacts
ORDER BY "createdAt" DESC
LIMIT 20;
```

For live Textract mode:

1. Confirm the document row status and `DocumentBaseArtifact` status.
2. Confirm the Textract job status using the stored provider job ID.
3. Check whether an SNS/SQS completion message is visible or in the DLQ.
4. Check worker logs for `textract-worker` message processing errors.
5. Do not mark provider-backed jobs failed based on old synchronous upload timeouts.

## Duplicate Or Retried Provider Message

1. Match SNS/SQS message to `DocumentBaseArtifact` by Textract `JobTag`.
2. Ignore duplicate completion messages for terminal artifacts.
3. For failed jobs, create a new artifact generation rather than mutating a successful current generation.
4. Only one valid current generation should be queryable.

## Vector Rebuild

Current behavior:

1. Build generation `N+1`.
2. Upsert vectors without deleting generation `N`.
3. Smoke-test exact document retrieval.
4. Mark `N+1` active.
5. Retire and later delete generation `N`.

Safety rules:

1. Use `ENABLE_VECTOR_INDEXING=true` only for controlled indexing runs.
2. Use `ENABLE_VECTOR_RETRIEVAL=true` only after indexing and retrieval smoke pass.
3. Keep chunk text in Postgres; Pinecone metadata must remain allowlisted.
4. Delete vectors by exact stored vector IDs from `document_vector_indexes`, not by metadata filter.

## Credential Rotation

1. Rotate provider keys outside the repo.
2. Update staging env values.
3. Restart the app containers.
4. Run:

```bash
node scripts/verify-m3-quality-gates.js
npm run build
```

Do not commit `.env`, AWS credentials, provider keys, or raw provider payloads.

## Current Blockers

AWS Textract access is no longer blocked for staging. Remaining stakeholder-handover blockers are:

- Deploy the latest AI SDK streaming/assistant-ui implementation to staging.
- Replace any temporary developer Pinecone/OpenAI keys with client-owned keys before stakeholder testing with non-synthetic data.
- Enable `ENABLE_VECTOR_INDEXING`, `ENABLE_VECTOR_RETRIEVAL`, and `ENABLE_AI_CHAT` intentionally for staging demo after provider smoke passes.
- UI acceptance pass for `/dashboard/chat`, including citations, insufficient-evidence behavior, errors, and cross-firm isolation.
- Rollback/reprocess command documentation for Textract artifacts and vector generations.
