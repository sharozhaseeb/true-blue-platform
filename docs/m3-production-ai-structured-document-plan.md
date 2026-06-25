# M3 Production AI And Structured Document Plan

## Contents

- [Summary](#summary)
- [Non-Negotiable Defaults](#non-negotiable-defaults)
- [Phase 0 - Access, Secrets, And Safety Baseline](#phase-0---access-secrets-and-safety-baseline)
- [Runtime Topology Decision](#runtime-topology-decision)
- [Data Classification And Retention Matrix](#data-classification-and-retention-matrix)
- [Auth And Tenant Security Model](#auth-and-tenant-security-model)
- [Phase 1 - Base Document Normalizer](#phase-1---base-document-normalizer)
- [Phase 2 - Local BaseDocument Artifact Source](#phase-2---local-basedocument-artifact-source)
- [Phase 3 - Structure-First Chunking And Indexing](#phase-3---structure-first-chunking-and-indexing)
- [Phase 4 - RAG Backend](#phase-4---rag-backend)
- [Phase 5 - Chat UI](#phase-5---chat-ui)
- [Phase 6 - Evaluation And Quality Gates](#phase-6---evaluation-and-quality-gates)
- [Phase 7 - Deferred Live Textract Async Processing](#phase-7---deferred-live-textract-async-processing)
- [Phase 8 - Production Hardening](#phase-8---production-hardening)
- [Public Interfaces And Types](#public-interfaces-and-types)
- [Prisma Schema Sketch](#prisma-schema-sketch)
- [Chat API Contract](#chat-api-contract)
- [Rollback And Recovery Runbook](#rollback-and-recovery-runbook)
- [Package Decisions](#package-decisions)
- [Package Version Matrix](#package-version-matrix)
- [Verification Matrix](#verification-matrix)
- [Assumptions](#assumptions)
- [Primary Sources](#primary-sources)

## Summary

M3 should be built on a structured document foundation before adding user-facing AI
chat. The current text/chunk pipeline remains as fallback and comparison, but the
new primary path should be:

1. PDF in S3.
2. Textract structured analysis.
3. Provider-neutral `BaseDocument`.
4. Structure-first retrieval chunks.
5. Pinecone indexing per firm namespace.
6. Streaming chat through Vercel AI SDK and assistant-ui.
7. Answers with citations tied back to document/page/chunk/source blocks.

This plan uses production-ready packages where they reduce risk, while keeping tenant
authorization, document ownership, retrieval, citations, and tax-document data control
inside the True Blue backend.

## Non-Negotiable Defaults

1. Do not remove the existing M2 extraction/chunking path until the Textract path is
   proven in staging and has a rollback path.
2. Do not expose raw Textract JSON as the product API contract.
3. Do not store raw PDFs, raw Textract text, prompts, completions, SSNs, taxpayer names,
   JWTs, presigned URLs, or extracted field values in queues, logs, traces, or hosted
   observability tools.
4. Do not use hosted chatbot platforms as the core tax-document Q&A layer.
5. Do not use OpenAI hosted file search as the primary retrieval store for M3; keep
   retrieval app-owned to preserve tenant isolation and citation control.
6. Every AI answer must either cite retrieved document evidence or explicitly say there
   is not enough evidence.
7. Every retrieval and chat route must derive firm/user scope from authenticated server
   context, never from trusted client input.

## Runtime Topology Decision

Default worker runtime for M3 is a **separate Node.js worker process deployed beside the
Next.js app container** in the existing Docker Compose/staging topology.

Do not implement the SQS consumer as a Next.js route. A route is request-scoped and is
not a durable queue worker.

### Worker Runtime Defaults

1. Add a `worker` service to production/staging compose.
   - Same image as the app.
   - Command runs a dedicated worker entrypoint, for example `node dist/worker.js` or a
     compiled TypeScript worker command.
   - Worker has the same env access as the app plus SQS/Textract/Pinecone/OpenAI keys.

2. Use SQS long polling.
   - `WaitTimeSeconds=20`.
   - Batch size starts at `1` for M3 to simplify idempotency.
   - Increase batch size only after duplicate/retry tests are passing.

3. Use conservative concurrency.
   - Start with one worker process and one active job per worker.
   - Add concurrency only after rate limits, idempotency, and logging are proven.

4. Configure queue safety.
   - Visibility timeout: at least `6x` expected max worker processing time for one
     document.
   - DLQ redrive: `maxReceiveCount >= 5`.
   - Worker must extend visibility timeout for long post-processing.

5. Graceful shutdown.
   - On `SIGTERM`, stop polling.
   - Finish the active job or release it by letting visibility timeout expire.
   - Do not acknowledge the SQS message until terminal state is persisted.

6. Deployment supervision.
   - Docker restart policy: `unless-stopped`.
   - Logs go to the same log collection path as the app.
   - Health check reports whether the worker can reach Postgres and SQS.

Future option: move this worker to ECS/Fargate or Lambda after the flow is stable. Do
not use BullMQ/Redis, Inngest, Trigger.dev, or Step Functions for M3 unless this plan is
explicitly revised.

## Data Classification And Retention Matrix

| Data Class | Examples | Storage | Retention Default | Encryption | Logging Rule |
| --- | --- | --- | --- | --- | --- |
| Source PDF | Uploaded tax PDFs | S3 document bucket | Until document deletion or client retention policy | SSE-S3 now, SSE-KMS for production | Never log contents or presigned URLs |
| Raw Textract payload | `GetDocumentAnalysis` JSON | S3 artifact prefix | Same as source PDF unless retention policy says shorter | SSE-S3 now, SSE-KMS for production | Never log payload |
| BaseDocument | Normalized fields/tables/layout/text | S3 artifact prefix, compact summary in Postgres | Same as source PDF | SSE-S3/SSE-KMS | Log counts/status only |
| Retrieval chunks | Derived chunk text and provenance | Postgres canonical chunk table; Pinecone stores vectors plus allowlisted metadata only | Same as document/vector lifecycle | DB encryption/storage defaults | Do not log text |
| Embeddings | Vector values | Pinecone namespace per firm | Deleted on document deletion/re-index | Pinecone managed controls | Never log vectors |
| Prompts | Chat prompt with retrieved context | Not persisted by default | Request lifetime only unless debug flag approved | N/A | Never log |
| Completions | AI answer text | `ChatMessage` if chat persistence enabled | Same as chat thread retention | DB encryption/storage defaults | Log IDs/counts only |
| Chat messages | User and assistant messages | Postgres | Client-defined retention; default keep until thread/document deletion | DB encryption/storage defaults | Never log body |
| Citations | Document/page/chunk/source IDs and snippets | Postgres with chat message | Same as chat message | DB encryption/storage defaults | Log citation counts only |
| Queue messages | Document/job IDs only | SQS | Queue retention default, DLQ reviewed manually | AWS managed | No raw text/field values |
| Evals | Redacted sample Q&A | Repo only if redacted; otherwise S3 | Review each dataset | N/A or S3 encryption | No real PII in repo |

Deletion rule: deleting a document must delete or tombstone source PDF, raw payload,
normalized artifact, retrieval chunks, vectors, and document-scoped citations according
to the selected retention policy. If legal retention requires preserving any artifact,
the UI/API must hide it from normal retrieval.

## Auth And Tenant Security Model

M3 routes must not rely only on middleware-injected headers for authorization.

### Required Server-Side Helper

Add a route-level helper such as `requireAuthenticatedUser()` that:

1. Reads the signed access token from HTTP-only cookies.
2. Verifies the JWT server-side.
3. Reloads the user from Postgres.
4. Reloads the firm from Postgres.
5. Rejects inactive users and inactive firms.
6. Returns `{ userId, firmId, role }`.
7. Ignores any client-supplied firm/user headers.

### Role Rules

1. `FIRM_USER` and `FIRM_ADMIN` may chat only over documents in their own firm.
2. `PLATFORM_ADMIN` may not query across all firms by default.
3. If platform-admin document Q&A is needed, require an explicit firm scope chosen
   server-side and audited in logs by ID only.
4. Every document ID in chat filters must be checked against the authenticated firm
   before retrieval.

## Phase 0 - Access, Secrets, And Safety Baseline

### Goal

Prepare credentials, environment variables, and sensitive-data guardrails before any
M3 implementation work touches live services.

### Step-By-Step Implementation

1. Refresh AWS access for account `536573256060`.
   - Confirm the role can call `sts:GetCallerIdentity`.
   - Confirm `textract:ListAdapters` works in `us-east-1`.
   - Confirm S3, SNS, SQS, CloudWatch Logs, and IAM permissions are available.

2. Rotate local temporary credentials.
   - Replace expired local temporary credentials only in local untracked files.
   - Do not commit `aws_creds.env`, `.env.local`, copied CLI exports, or any generated
     credential snapshots.
   - Delete the temporary credential file once AWS work is complete for the session.

3. Add environment names to `.env.example`.
   - `AWS_REGION`
   - `AWS_TEXTRACT_REGION`
   - `TEXTRACT_FEATURE_SET`
   - `TEXTRACT_RESULTS_BUCKET`
   - `TEXTRACT_SNS_TOPIC_ARN`
   - `TEXTRACT_SQS_QUEUE_URL`
   - `PINECONE_API_KEY`
   - `PINECONE_INDEX_NAME`
   - `OPENAI_API_KEY`
   - `AI_MODEL`
   - `EMBEDDING_MODEL`
   - `ENABLE_TEXTRACT_PIPELINE`
   - `ENABLE_VECTOR_INDEXING`
   - `ENABLE_AI_CHAT`
   - `ENABLE_BASE_DOCUMENT_DEBUG_API`

4. Add a repo-level ignore/safety check if missing.
   - Ensure local credential files and Textract raw output folders are ignored.
   - Ensure client evidence packages and generated raw provider payloads are ignored.

5. Define sensitive-data logging rules.
   - Logs may contain document IDs, firm IDs, job IDs, status, durations, counts, and
     error classes.
   - Logs must not contain extracted text, field values, raw prompts, raw completions,
     taxpayer identifiers, presigned URLs, or temporary credentials.

6. Add production vendor approval gate before real taxpayer data leaves AWS/app storage.
   - Confirm approved terms/DPA and data-processing posture for OpenAI and Pinecone.
   - Confirm whether prompts, completions, embeddings, and vector metadata are retained,
     trained on, region-bound, or available to provider personnel.
   - Use project-scoped API keys for this client/environment; do not reuse personal or
     shared keys.
   - Document deletion expectations for embeddings and persisted chat data.
   - Until this approval is complete, use only redacted/sample data for OpenAI/Pinecone
     in staging and keep `ENABLE_VECTOR_INDEXING=false` and `ENABLE_AI_CHAT=false` for
     real taxpayer documents.

7. Document deferred worker runtime prerequisites.
   - Docker Compose can run a second service from the app image.
   - The worker can reach Postgres from the same network as the app.
   - The worker can reach AWS SQS/Textract/S3 through configured credentials.
   - The worker process has a documented start command before Phase 7 begins.
   - Do not block local artifact mode on worker readiness.

### Exit Criteria

1. AWS access is either verified, or live Textract is marked blocked and deferred to
   Phase 7.
2. Required environment variables are documented.
3. No sensitive local credential or raw-provider file is tracked by git.
4. Vendor approval is complete, or the plan is explicitly limited to redacted/sample
   data for OpenAI/Pinecone until approval is complete.
5. M3 implementation can proceed without leaking tax data through logs or queues.

## Phase 1 - Base Document Normalizer

### Goal

Build the reusable normalizer first, using saved Textract spike outputs, so the core
structured artifact is proven before live async AWS integration.

### Inputs

Use tracked redacted fixtures as the default reproducible input:

1. `scripts/fixtures/textract-base-document/redacted-mini`
2. `scripts/fixtures/textract-base-document/redacted-multipage`

Larger saved spike outputs may be used only through explicit CLI paths,
`TEXTRACT_FIXTURE_DIRS`, or an untracked local manifest.

Each folder contains raw `GetDocumentAnalysis` result chunks named `page-*.json`,
plus `summary.json` and `job-id.txt`. Do not hard-code machine-specific spike paths in
source code.

### Step-By-Step Implementation

1. Create internal base-document types.
   - Add a provider-neutral module for `BaseDocument`, `BaseDocumentPage`,
     `BaseDocumentLine`, `BaseDocumentField`, `BaseDocumentTable`,
     `BaseDocumentTableCell`, `BaseDocumentSelectionMark`, `BaseDocumentGeometry`,
     and `BaseDocumentSourceRef`.
   - Use normalized Textract coordinates for geometry: `left`, `top`, `width`,
     `height`, and optional `rotation`.
   - Preserve provider provenance on every normalized object using `sourceBlockIds`.

2. Create raw Textract type guards.
   - Accept only object-shaped blocks with `BlockType`.
   - Treat absent relationships as empty arrays.
   - Treat absent confidence as `null`, not `0`.
   - Treat absent geometry as `null` and record a verification warning.

3. Build block indexing utilities.
   - Index all raw blocks by `Id`.
   - Group blocks by `Page`.
   - Provide relationship helpers for `CHILD`, `VALUE`, `MERGED_CELL`, `TABLE_TITLE`,
     and `TABLE_FOOTER`.
   - Detect pagination gaps by comparing all loaded result chunks against the expected
     total block count from the summary when available.

4. Normalize lines.
   - Convert Textract `LINE` blocks into page lines.
   - Preserve text, confidence, bounding box, and block ID.
   - Build each page `text` from normalized lines in page order.

5. Normalize fields.
   - Convert `KEY_VALUE_SET` blocks with `EntityTypes` containing `KEY`.
   - Resolve each key's `VALUE` relationship.
   - Build label text from key child `WORD` and `SELECTION_ELEMENT` blocks.
   - Build value text from value child `WORD` and `SELECTION_ELEMENT` blocks.
   - Represent selected values as `SELECTED` / `NOT_SELECTED`, not bracket-only text
     in the internal model.
   - Preserve key block ID, value block ID, child block IDs, confidence, key geometry,
     and value geometry.

6. Normalize tables.
   - Convert `TABLE` blocks and their child `CELL` blocks.
   - Preserve row index, column index, row span, column span, cell text, confidence,
     geometry, and source block ID.
   - Preserve table titles, footers, and merged-cell relationships where present.
   - Keep tables separate from prose.

7. Normalize selection marks.
   - Convert standalone `SELECTION_ELEMENT` blocks.
   - Exclude selection marks already represented as field values unless explicitly
     referenced in field provenance.
   - Preserve selected state, confidence, geometry, and source block ID.

8. Normalize layout objects.
   - Convert `LAYOUT_*` blocks into lightweight layout entries.
   - Preserve layout type, text if present, confidence, geometry, page, and source
     block ID.
   - Do not make layout objects the source of truth for fields/tables.

9. Produce document summary.
   - Include provider, provider job ID, source filename, page count, raw block count,
     normalized field count, table count, cell count, selection mark count, line count,
     parser version, and feature set.

10. Add local verification script.
   - Read tracked redacted fixture folders by default.
   - Normalize each fixture folder.
   - Write generated output only to an ignored local output folder.
   - Print aggregate counts and warnings.
   - Fail on missing pages, missing provenance, no fields, no lines, table cells without
     row/column indexes, or selected marks with unknown state.

11. Add reproducible fixture strategy.
   - Use minimized, redacted Textract fixtures for committed verification.
   - Do not depend on machine-specific local paths.
   - For full raw fixtures, use explicit CLI paths, `TEXTRACT_FIXTURE_DIRS`, an
     untracked local manifest, or a documented S3/download command once AWS artifact
     storage is configured.
   - Snapshot only redacted normalized outputs in repo tests.

### Exit Criteria

1. Normalization is deterministic across repeated runs.
2. Tracked redacted fixtures produce valid `BaseDocument` artifacts.
3. Every normalized field, table, table cell, selection mark, line, and layout object has
   source provenance.
4. Optional full saved spikes can be verified through explicit local fixture input.
5. Existing M2 quality checks still pass.

## Phase 2 - Local BaseDocument Artifact Source

### Goal

Keep M3 moving without live AWS/Textract access by creating a non-AWS artifact source
that produces the same `BaseDocument` artifact contract the later Textract pipeline will
produce.

Live Textract, SNS, SQS, and worker implementation is explicitly deferred until the
client provides AWS access. Downstream phases must depend on `BaseDocument` and
`DocumentBaseArtifact` semantics, not on Textract APIs.

### Step-By-Step Implementation

1. Add a `BaseDocument` source boundary.
   - Add an internal source interface that returns `BaseDocumentArtifact`.
   - Current implementations may load existing normalized `BaseDocument` JSON or
     normalize local Textract response fixtures.
   - Downstream chunking, indexing, retrieval, and chat must not import Textract response
     shapes directly.
   - Keep `BaseDocument.provider="aws-textract"` for fixture outputs derived from real
     Textract responses; represent fixture/local mode outside the document contract.

2. Add non-AWS artifact semantics.
   - Use the same artifact fields planned for live extraction: artifact ID, document ID,
     firm ID, generation, current marker, source mode, parser version, feature set, and
     `BaseDocument`.
   - Add status values for internal artifact state: `QUEUED`, `STARTING_PROVIDER_JOB`,
     `AWAITING_PROVIDER_RESULT`, `PROVIDER_RESULT_READY`, `NORMALIZING`,
     `READY_FOR_INDEXING`, `INDEXED`, `NEEDS_REVIEW`, `FAILED`, and `CANCELLED`.
   - In local artifact mode, artifacts can skip provider job states and move directly to
     `READY_FOR_INDEXING` after validation.

3. Use reproducible fixture inputs.
   - Default tests must use tracked redacted fixtures.
   - Larger full-sample Textract outputs may be used through explicit CLI paths or an
     untracked local manifest/env var, never through hard-coded machine paths.
   - Generate deterministic normalized `BaseDocument` outputs for local validation.

4. Keep upload behavior unchanged for now.
   - `ENABLE_TEXTRACT_PIPELINE=false` remains the default.
   - Existing M2 extraction/chunking remains the upload path until live AWS access is
     available and Phase 7 is implemented.

5. Add a `BaseDocument`-native chunking path before vector work.
   - Convert `BaseDocument` pages, fields, tables, layout, and source block IDs into
     retrieval chunks.
   - Preserve source block IDs, table IDs, page spans, parser version, chunk strategy,
     artifact ID, and vector generation.
   - Do not reuse the M2 plain-text chunker for structured-document retrieval except as
     a fallback/comparison path.

### Exit Criteria

1. Downstream code can consume `BaseDocumentArtifact` without importing Textract response
   shapes.
2. Redacted fixtures and optional local full fixtures generate deterministic
   `BaseDocument` artifacts.
3. `BaseDocument`-native retrieval chunks preserve field/table/layout/source provenance.
4. Live Textract/SNS/SQS/worker work is explicitly blocked until AWS access is provided.

## Phase 3 - Structure-First Chunking And Indexing

### Goal

Derive retrieval-ready chunks from `BaseDocument` and index them into Pinecone with
tenant-safe metadata.

### Step-By-Step Implementation

1. Define retrieval unit shape.
   - `chunkId`
   - `documentId`
   - `firmId`
   - `baseArtifactId`
   - `vectorGeneration`
   - `content`
   - `contentType`: `prose`, `field_group`, `table`, or `mixed`
   - `pageStart`
   - `pageEnd`
   - `formType`
   - `sectionPath`
   - `tableId`
   - `sourceBlockIds`
   - `parserVersion`
   - `chunkStrategy`

2. Build chunks from structure.
   - Use page boundaries, layout headings, form boundaries, and table boundaries.
   - Keep tables as table chunks with cell structure summarized into readable text.
   - Group related fields into field-group chunks when labels/values are dense.
   - Preserve the existing M2 text chunks separately for fallback.
   - Store canonical chunk text in Postgres, not Pinecone metadata.
   - Pinecone returns vector IDs and allowlisted metadata; the app then loads chunk
     content from Postgres by `chunkId` after firm ownership validation.

   Pinecone metadata allowlist:
   - `chunkId`
   - `documentId`
   - `firmId`
   - `pageStart`
   - `pageEnd`
   - `formType`
   - `parserVersion`
   - `chunkStrategy`
   - `contentType`

   Pinecone metadata must not include chunk text, field values, snippets, prompts, raw
   source text, SSNs, taxpayer names, or extracted financial values.

3. Add embedding service.
   - Use OpenAI embeddings through an internal wrapper.
   - Store embedding model and dimension in config.
   - Batch embeddings with retry and rate-limit handling.
   - If `ENABLE_VECTOR_INDEXING=false`, skip embedding and Pinecone writes, keep the
     normalized artifact available, and mark the index status as skipped/disabled
     without deleting existing vectors.

4. Add Pinecone index integration.
   - Use Pinecone Serverless.
   - Use one namespace per `firmId`.
   - Store `firmId` in metadata as defense-in-depth.
   - Upsert vectors by stable IDs derived from firm ID, document ID, parser version,
     chunk strategy, vector generation, and chunk index.
   - Required vector/chunk ID shape:
     `{firmId}:{documentId}:{parserVersion}:{chunkStrategy}:g{generation}:{chunkIndex}`.
   - Do not omit generation from vector IDs; otherwise generation `N+1` can overwrite
     generation `N` before rollback validation is complete.

   Retrieval defaults:
   - Query `topK=30`.
   - Rerank to `topN=8` when a reranker is available.
   - If no reranker is configured, use top `8` vector matches.
   - Keep score thresholds configurable; initial insufficient-evidence threshold is
     `0.2` below the top score distribution observed in the first eval set.

5. Add idempotent indexing.
   - Re-index by creating a new vector generation first, not by deleting the current
     working vectors.
   - Mark indexing status in Postgres.
   - Preserve enough metadata to rebuild the index from S3/Postgres.

6. Add vector inventory table.
   - Store index name, namespace, embedding model, embedding dimension, parser version,
     chunk strategy, vector IDs, document ID, firm ID, generation, status, and timestamps.
   - Delete vectors by exact IDs from this inventory on document deletion.
   - Re-index by creating a new generation, then retiring the old generation after the
     new one is queryable.

7. Use blue-green vector generation for every re-index.
   - Create generation `N+1` in Postgres with status `BUILDING`.
   - Generate chunks and embeddings for generation `N+1`.
   - Upsert generation `N+1` vectors without deleting generation `N`.
   - Verify expected vector count and run a smoke retrieval by exact document filter.
   - Atomically mark generation `N+1` as `ACTIVE` in Postgres.
   - Retrieval must load only vector IDs/chunks from the active generation.
   - Mark generation `N` as `RETIRED`.
   - Delete retired vectors only after active generation verification succeeds.

8. Add deletion cleanup.
   - Document deletion must remove or tombstone Pinecone vectors in the firm namespace.
   - S3 artifacts and raw provider payloads follow retention policy.

9. Add retrieval and citation quality gates before enabling vector search in chat.
   - Run redacted/sample retrieval questions.
   - Verify recall@k, citation coverage, and no cross-tenant retrieval.
   - Do not expose indexed documents to chat until these checks pass.

### Exit Criteria

1. Completed base artifacts create Pinecone vectors.
2. Cross-tenant vector access is blocked by namespace and server auth.
3. Re-indexing is deterministic and idempotent.
4. Deleted documents are not retrievable.

## Phase 4 - RAG Backend

### Goal

Add authenticated, tenant-safe, citation-grounded document Q&A.

### Step-By-Step Implementation

1. Add AI provider wrapper.
   - Default to Vercel AI SDK for streaming and tool abstractions.
   - Use OpenAI official SDK/Responses API only behind the wrapper when lower-level
     control is needed.
   - Centralize model names, retries, timeouts, max output tokens, and safety prompts.

2. Add chat persistence.
   - `ChatThread`: firm ID, user ID, title, created/updated timestamps.
   - `ChatMessage`: thread ID, role, UI message JSON, model, token usage, retrieved
     chunk IDs, citations, created timestamp.
   - Store AI SDK-compatible UI messages so the UI can hydrate threads.

3. Add `POST /api/chat`.
   - Authenticate using the existing cookie/JWT flow.
   - Resolve firm and user server-side.
   - Validate thread ownership.
   - Validate document filters against firm ownership.
   - Accept only a new user message plus optional thread/document filters from the
     client.
   - Reload prior thread history from Postgres server-side.
   - Reject client-supplied `system`, `assistant`, or `tool` messages that are not
     already stored in the thread.
   - Enforce append-only message ordering.
   - Retrieve from Pinecone namespace for the firm.
   - Rerank to a small final context set.
   - Stream the response through AI SDK.

   Request limits:
   - Max user message length: `8,000` characters.
   - Max thread history sent to model: last `12` messages or configured token budget,
     whichever is smaller.
   - Max selected documents per request: `25`.
   - Reject requests with unknown document IDs before retrieval.

4. Add citation contract.
   - Each cited item includes document ID, original filename, page span, chunk ID,
     snippet, source block IDs, and optional bounding boxes.
   - Citations are produced from retrieved chunks, not model-generated guesses.

5. Add insufficient-evidence behavior.
   - If retrieval returns weak or irrelevant evidence, answer that the uploaded documents
     do not contain enough support.
   - Do not allow the model to provide uncited tax conclusions as if grounded.

6. Build citations deterministically.
   - The model may refer to citations, but citation objects are constructed server-side
     from retrieved chunks.
   - Every cited chunk must include document ID, filename, page span, chunk ID, snippet,
     and source block IDs.
   - If no retrieved chunk is cited, the answer is treated as failed in verification.

7. Add chat groundedness and tenant-isolation gates before UI exposure.
   - Verify supported sample questions produce cited answers.
   - Verify unsupported questions produce insufficient-evidence answers.
   - Verify documents from another firm cannot be selected, retrieved, cited, or inferred.
   - Keep `ENABLE_AI_CHAT=false` in staging for real users until these checks pass.

### Exit Criteria

1. Chat streams responses.
2. Answers include citations when evidence exists.
3. Unsupported questions produce a clear insufficient-evidence response.
4. Tenant isolation is enforced for threads, documents, retrieval, and citations.

## Phase 5 - Chat UI

### Goal

Add a production-grade authenticated chat interface without building chat primitives
from scratch.

### Step-By-Step Implementation

1. Install UI packages.
   - `@assistant-ui/react`
   - `@assistant-ui/react-ai-sdk`
   - Vercel AI SDK packages required by the backend route.

2. Add dashboard chat route.
   - Add a document Q&A page inside the authenticated dashboard.
   - Do not replace existing document management flows.

3. Add runtime provider.
   - Use assistant-ui's AI SDK runtime connected to `/api/chat`.
   - Pass auth via existing cookie flow.
   - Pass selected document IDs or filters as request body metadata, not trusted auth
     context.

4. Add chat surface.
   - Thread view.
   - Composer.
   - Streaming assistant response.
   - Retry/regenerate.
   - Empty state.
   - Error state.
   - Loading state.
   - Citation list under answers.

5. Add document context controls.
   - Let the user choose all firm documents or specific uploaded documents.
   - Show selected document context clearly.
   - Server still validates access regardless of client selection.

### Exit Criteria

1. Authenticated users can ask questions against their documents.
2. Citations are visible and understandable.
3. Streaming failure is recoverable.
4. UI does not expose other firms' documents or chat threads.

## Phase 6 - Evaluation And Quality Gates

### Goal

Make M3 quality measurable before client retest.

### Step-By-Step Implementation

1. Create a redacted eval set.
   - Use sample PDFs only.
   - Include expected answer, acceptable evidence pages, and expected citations.
   - Do not commit raw PII or real client return data.

   Sequencing rule:
   - Normalizer fixture tests are part of Phase 1.
   - Retrieval and citation tests are part of Phase 3 and must pass before chat can use
     vector search.
   - Chat groundedness and tenant-isolation tests are part of Phase 4 and must pass
     before Phase 5 UI exposure.
   - Phase 6 collects, automates, and reports the gates; it does not defer all quality
     checks until after the UI is built.

2. Add retrieval metrics.
   - recall@k
   - MRR or nDCG
   - citation precision
   - citation coverage
   - tenant-isolation failures

3. Add answer-quality checks.
   - grounded answer present
   - citation present when evidence exists
   - insufficient-evidence answer when retrieval fails
   - no answer from another tenant's namespace

4. Add regression scripts.
   - normalizer verification
   - indexing verification
   - retrieval verification
   - chat API verification
   - UI smoke test

5. Keep hosted eval tools out of production data initially.
   - Braintrust or LangSmith may be considered later with redacted data or approved
     enterprise controls.

### Exit Criteria

1. Known sample questions pass.
2. Bad questions do not hallucinate grounded tax facts.
3. Cross-tenant retrieval tests fail closed.
4. M3 has a repeatable local/staging acceptance path.

## Phase 7 - Deferred Live Textract Async Processing

### Goal

Add live AWS Textract only after the client provides access, using the same
`BaseDocumentArtifact` contract already exercised by local artifact mode.

### Blocker

This phase is blocked until the client provides working AWS access with Textract, S3,
SNS, SQS, IAM, and CloudWatch permissions.

### Step-By-Step Implementation

1. Create AWS resources.
   - S3 prefix or bucket for raw Textract output and normalized artifacts.
   - SNS topic for Textract completion.
   - SQS Standard queue subscribed to the SNS topic.
   - DLQ with redrive policy.
   - IAM role allowing Textract to publish to SNS.
   - Worker permissions for SQS, Textract get-result calls, S3 artifact writes, and
     Postgres access.

2. Update upload behavior behind `ENABLE_TEXTRACT_PIPELINE`.
   - If disabled, keep the existing M2 path.
   - If enabled, upload stores the PDF, creates the document and artifact row, starts
     Textract, and returns `PROCESSING`.
   - Do not block upload while waiting for Textract completion.

3. Start Textract safely.
   - Use `StartDocumentAnalysis` with `FORMS`, `TABLES`, and `LAYOUT`.
   - Use deterministic generation-safe `ClientRequestToken`.
   - Use `JobTag` containing the document/artifact ID.
   - Use `NotificationChannel` for SNS completion.

4. Handle provider terminal states.
   - `SUCCEEDED`: fetch all result chunks, persist raw payload, normalize to
     `BaseDocument`, and mark artifact `READY_FOR_INDEXING`.
   - `FAILED`: mark artifact failed, preserve error code/message, keep source PDF.
   - `PARTIAL_SUCCESS`: fail unless page coverage and critical structure checks pass.

5. Implement worker claim and reconciliation.
   - Parse SNS/SQS messages and match by artifact ID from `JobTag` first.
   - Reconcile provider job IDs if startup crashed after Textract start.
   - Treat duplicate or late messages as no-ops.
   - Add a scheduled reconciler for missed notifications and stale provider states.

6. Preserve retry semantics.
   - Retrying a failed provider job creates generation `N+1`.
   - The retry generation becomes current only after successful normalization/indexing.
   - Failed or partial generations are never current.

7. Fix startup sweeper behavior before enabling live Textract.
   - Do not fail provider-backed in-flight jobs because of old synchronous timeouts.
   - Do not delete source PDFs for provider-backed documents unless terminal state and
     retention policy allow it.

### Exit Criteria

1. Upload returns truthful async status under the feature flag.
2. Worker completes a live Textract job into the same `BaseDocumentArtifact` contract
   used by local artifact mode.
3. Missed/duplicate SQS messages do not corrupt state.
4. Failed jobs are visible and can be retried or intentionally failed.

## Phase 8 - Production Hardening

### Goal

Make the system operable, auditable, and recoverable.

### Step-By-Step Implementation

1. Add redacted JSON logging.
   - Prefer `pino`.
   - Redact known sensitive keys.
   - Log IDs, counts, durations, statuses, and error classes.

2. Add CloudWatch metrics.
   - document processing duration
   - Textract failures
   - queue depth
   - DLQ count
   - indexing failures
   - chat latency
   - model errors
   - token usage

3. Add rate limits.
   - Per-user and per-firm limits for chat.
   - Per-firm limits for document processing and indexing.
   - Protect public auth/API endpoints as already planned.

4. Add operational runbooks.
   - stuck Textract job
   - failed normalization
   - failed indexing
   - duplicate SQS message
   - vector rebuild
   - credential rotation
   - document deletion cleanup

5. Add error reporting only after redaction.
   - Sentry is acceptable only with `sendDefaultPii: false` and `beforeSend` redaction.
   - Do not attach prompts, completions, raw extracted text, or files.

### Exit Criteria

1. Worker failures are visible.
2. Sensitive data does not appear in logs or third-party tools.
3. A failed document can be retried or intentionally failed.
4. Staging has a documented rollback and reprocess path.

## Public Interfaces And Types

1. Add internal `BaseDocument`; do not treat it as the final public API contract yet.
2. Add `DocumentBaseArtifact` persistence for structured extraction status and artifact
   pointers.
3. Add chat persistence for threads and messages.
4. Add `POST /api/chat`.
5. Optionally add a gated internal route for base-document inspection.
6. Preserve existing document list/detail/chunk endpoints during the transition.

## Prisma Schema Sketch

This is an implementation sketch, not a migration file. Exact enum names may be adjusted
to Prisma style during implementation, but these fields and constraints must be present.

```prisma
model DocumentBaseArtifact {
  id                    String   @id @default(cuid())
  documentId            String
  document              Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  firmId                String
  provider              String
  providerJobId         String?  @unique
  featureSet            String
  parserVersion         String
  generation            Int
  isCurrent             Boolean  @default(false)
  status                String
  rawArtifactS3Key      String?
  normalizedArtifactS3Key String?
  summary               Json?
  retryCount            Int      @default(0)
  lastErrorCode         String?
  lastErrorMessage      String?
  startedAt             DateTime?
  completedAt           DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@index([documentId])
  @@index([firmId])
  @@index([status])
  @@index([documentId, parserVersion, featureSet, isCurrent])
  @@unique([documentId, parserVersion, featureSet, generation])
}

model DocumentVectorIndex {
  id              String   @id @default(cuid())
  documentId      String
  firmId          String
  indexName       String
  namespace       String
  embeddingModel  String
  embeddingDim    Int
  parserVersion   String
  chunkStrategy   String
  generation      Int
  isActive        Boolean  @default(false)
  status          String
  vectorIds       Json
  chunkIds        Json
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([documentId])
  @@index([firmId, namespace])
  @@index([status])
  @@index([documentId, isActive])
  @@unique([documentId, indexName, namespace, generation])
}

model DocumentRetrievalChunk {
  id             String   @id
  documentId     String
  firmId         String
  baseArtifactId String
  vectorGeneration Int
  content        String   @db.Text
  contentType    String
  pageStart      Int
  pageEnd        Int
  formType       String?
  sectionPath    String?
  tableId        String?
  sourceBlockIds Json
  parserVersion  String
  chunkStrategy  String
  createdAt      DateTime @default(now())

  @@index([documentId])
  @@index([firmId])
  @@index([baseArtifactId])
  @@index([documentId, vectorGeneration])
  @@index([parserVersion, chunkStrategy])
}

model ChatThread {
  id        String   @id @default(cuid())
  firmId    String
  userId    String
  title     String?
  status    String   @default("ACTIVE")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([firmId])
  @@index([userId])
}

model ChatMessage {
  id              String   @id @default(cuid())
  threadId        String
  firmId          String
  userId          String?
  role            String
  uiMessage       Json
  model           String?
  tokenUsage      Json?
  retrievedChunkIds Json?
  citations       Json?
  createdAt       DateTime @default(now())

  @@index([threadId])
  @@index([firmId])
  @@index([createdAt])
}
```

Migration note:

1. Prisma cannot reliably express every partial-unique constraint needed for active
   generations.
2. Add raw SQL migration constraints or active pointer fields so the database enforces:
   - only one current `DocumentBaseArtifact` per document/parser/feature set where
     `isCurrent=true`;
   - only one active `DocumentVectorIndex` per document/index/namespace where
     `isActive=true`.
3. Do not rely only on application code for these active/current invariants.

## Chat API Contract

### `POST /api/chat`

Request body:

```json
{
  "threadId": "optional-existing-thread-id",
  "message": {
    "role": "user",
    "content": "question text"
  },
  "documentFilter": {
    "documentIds": ["optional-document-id-list"],
    "formTypes": ["optional-form-type-list"],
    "pageRange": { "start": 1, "end": 10 }
  }
}
```

Server rules:

1. Ignore any client-supplied `firmId` or `userId`.
2. Validate all `documentIds` against authenticated firm ownership.
3. Reload existing thread history from Postgres; do not trust client-supplied chat
   history.
4. Reject forged `system`, `assistant`, or `tool` messages from the request body.
5. Persist the new user message before model execution.
6. Persist only server-produced assistant messages, retrieved chunk IDs, citations, and
   usage metadata.
7. Retrieve only from the authenticated firm's Pinecone namespace.
8. Construct citations server-side from retrieved chunks.
9. Stream with AI SDK UI message stream response.

Response stream:

1. Assistant text deltas.
2. Citation data parts containing source document/page/chunk metadata.
3. Final usage/model metadata where available.
4. Error part for recoverable failures, without sensitive internals.

Typed stream data parts:

```ts
type ChatCitation = {
  chunkId: string;
  documentId: string;
  filename: string;
  pageStart: number;
  pageEnd: number;
  snippet: string;
  sourceBlockIds: string[];
  boundingBoxes?: Array<{
    pageNumber: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
};

type ChatStreamDataPart =
  | { type: "citations"; citations: ChatCitation[] }
  | { type: "usage"; model: string; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code: string; message: string };
```

## Rollback And Recovery Runbook

Feature flags must be separate:

1. `ENABLE_TEXTRACT_PIPELINE`
2. `ENABLE_VECTOR_INDEXING`
3. `ENABLE_AI_CHAT`
4. `ENABLE_BASE_DOCUMENT_DEBUG_API`

Rollback behavior:

1. Disable `ENABLE_AI_CHAT` to hide chat while document processing continues.
2. Disable `ENABLE_VECTOR_INDEXING` to stop new vector writes while preserving artifacts.
3. Disable `ENABLE_TEXTRACT_PIPELINE` to return uploads to the existing M2 pipeline.
4. Do not delete already-created artifacts or vectors automatically during rollback.
5. Provide scripts for:
   - reprocess document by ID
   - rebuild vectors for document by ID
   - delete vectors for document by ID
   - mark artifact failed by ID
   - replay DLQ message by message ID

Recovery defaults:

1. A failed Textract job can be retried by creating a new artifact generation. The retry
   generation becomes current only after it reaches a valid terminal success state.
2. A failed normalization can be retried against the raw artifact S3 key.
3. A failed index can be retried from the normalized artifact S3 key using blue-green
   vector generation.
4. A stale vector generation is not queryable after a newer generation is marked active.
5. Disabling vector indexing must not delete active vectors; it only stops new embedding
   and Pinecone write work.

## Package Decisions

1. Use `assistant-ui` for chat UI.
2. Use Vercel AI SDK for chat streaming, `useChat`, tool calling, and route protocol.
3. Use OpenAI official SDK/Responses API only behind an internal wrapper where needed.
4. Use Pinecone Serverless for M3 vectors, with one namespace per firm.
5. Use AWS SNS/SQS for async document processing.
6. Defer LangChain, LlamaIndex, Mastra, Trigger.dev, Inngest, Step Functions,
   OpenSearch, pgvector, and hosted chatbot platforms unless a later requirement
   justifies them.

## Package Version Matrix

Use these package families for the first implementation pass. Pin exact versions in
`package.json` during installation, but do not cross these major-version boundaries
without revising this plan.

| Capability | Package | Required Major / Constraint | Notes |
| --- | --- | --- | --- |
| AI SDK core | `ai` | `^6` | Must match assistant-ui AI SDK adapter expectations. |
| AI SDK React | `@ai-sdk/react` | `^3` | Used by assistant-ui AI SDK runtime. |
| OpenAI provider | `@ai-sdk/openai` | compatible with `ai@6` | Default model provider for AI SDK streaming. |
| OpenAI low-level SDK | `openai` | `^5` if current stable remains v5 | Use only behind internal wrapper for Responses API fallback. |
| Chat UI | `@assistant-ui/react` | same major as `@assistant-ui/react-ai-sdk` peer requirements | Provides chat/thread UI primitives. |
| Chat UI AI SDK adapter | `@assistant-ui/react-ai-sdk` | compatible with `ai@6` / `@ai-sdk/react@3` | Bridges assistant-ui runtime to AI SDK. |
| Validation | `zod` | `^4` if current stable remains v4 | Request schemas, tool inputs, env validation. |
| Pinecone | `@pinecone-database/pinecone` | current stable major at install time, pinned after install | Serverless index, namespaces, metadata filtering. |
| Textract | `@aws-sdk/client-textract` | AWS SDK v3 | Start/get document analysis. |
| SQS | `@aws-sdk/client-sqs` | AWS SDK v3 | Worker queue polling and ack/delete. |
| SNS | `@aws-sdk/client-sns` | AWS SDK v3 | Resource setup/testing if needed. |
| CloudWatch Logs | `@aws-sdk/client-cloudwatch-logs` | AWS SDK v3 | Optional log group/resource checks. |
| Logging | `pino` | `^9` if current stable remains v9 | Redacted JSON logs. |

Do not install LangChain, LlamaIndex, Mastra, BullMQ, Inngest, Trigger.dev, Botpress,
or Chatwoot in the first M3 pass.

## Verification Matrix

| Area | Required Verification |
| --- | --- |
| Normalizer | deterministic output, page coverage, provenance, geometry, counts |
| Textract worker | success, failure, duplicate message, late message, retry |
| Indexing | upsert, re-index, delete, namespace isolation |
| Retrieval | recall, citation coverage, metadata filters, no cross-tenant leakage |
| Chat API | auth, streaming, insufficient evidence, citation payloads |
| UI | authenticated access, streaming states, citations, errors |
| Security | no sensitive logs, no raw text in queues, no committed credentials |

## Assumptions

1. Textract remains the structured extraction foundation.
2. Pinecone is acceptable for M3 even though it is outside AWS.
3. The normalized base document is internal first.
4. The old extraction pipeline remains available as fallback.
5. The client accepts a timeline extension for the foundation work.
6. Fresh AWS credentials are required before live Textract/SQS/SNS work resumes.

## Primary Sources

1. assistant-ui AI SDK integration:
   - https://www.assistant-ui.com/docs/runtimes/ai-sdk/overview
2. Vercel AI SDK:
   - https://ai-sdk.dev/docs/introduction
3. OpenAI streaming / Responses:
   - https://platform.openai.com/docs/guides/streaming-responses
4. Pinecone multitenancy:
   - https://docs.pinecone.io/troubleshooting/namespaces-vs-metadata-filtering
5. Pinecone TypeScript client:
   - https://github.com/pinecone-io/pinecone-ts-client
6. AWS Textract async:
   - https://docs.aws.amazon.com/textract/latest/dg/api-async.html
7. SQS at-least-once delivery:
   - https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html
8. Sentry sensitive data controls:
   - https://docs.sentry.dev/platforms/javascript/guides/nextjs/data-management/sensitive-data/
