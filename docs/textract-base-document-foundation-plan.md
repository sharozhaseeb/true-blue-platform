# Textract Base-Document Foundation Plan

## Contents

- [Purpose](#purpose)
- [Current Constraints](#current-constraints)
- [Locked Decisions](#locked-decisions)
- [Industry Practice Notes For The Open Decisions](#industry-practice-notes-for-the-open-decisions)
  - [1. Base-Document Contract](#1-base-document-contract)
  - [2. Async Runtime And Job Orchestration](#2-async-runtime-and-job-orchestration)
  - [3. Storage, Security, Retention, And Compliance](#3-storage-security-retention-and-compliance)
  - [4. Evaluation, Confidence, And Human Review](#4-evaluation-confidence-and-human-review)
  - [5. Structured Output Plus Chunking / Retrieval](#5-structured-output-plus-chunking--retrieval)
- [Non-Goals](#non-goals)
- [Target Architecture](#target-architecture)
- [Canonical Base-Document Contract](#canonical-base-document-contract)
- [Async State Machine And Idempotency](#async-state-machine-and-idempotency)
  - [Document.status](#documentstatus)
  - [DocumentBaseArtifact.artifactStatus](#documentbaseartifactartifactstatus)
  - [Allowed transitions](#allowed-transitions)
  - [Invariants](#invariants)
  - [Idempotency rules](#idempotency-rules)
  - [Atomic write boundaries](#atomic-write-boundaries)
  - [PARTIAL_SUCCESS policy](#partial_success-policy)
- [AWS Resource Specification](#aws-resource-specification)
- [Upload Contract](#upload-contract)
- [Deletion, Cancellation, And Retention Semantics](#deletion-cancellation-and-retention-semantics)
- [Migration, Backfill, And Rollback](#migration-backfill-and-rollback)
- [Evaluation Rubric](#evaluation-rubric)
- [Implementation Phases](#implementation-phases)
  - [Phase 0 - Prerequisites And Spike Gate](#phase-0---prerequisites-and-spike-gate)
  - [Phase 1 - Async Runtime Foundation](#phase-1---async-runtime-foundation)
  - [Phase 2 - Schema And Persistence Layer](#phase-2---schema-and-persistence-layer)
  - [Phase 3 - Textract Provider Integration](#phase-3---textract-provider-integration)
  - [Phase 4 - Base-Document Normalization](#phase-4---base-document-normalization)
  - [Phase 5 - Structured Evaluation Harness](#phase-5---structured-evaluation-harness)
  - [Phase 6 - Chunk Derivation From The Base Artifact](#phase-6---chunk-derivation-from-the-base-artifact)
  - [Phase 7 - API Surface And Compatibility Rollout](#phase-7---api-surface-and-compatibility-rollout)
  - [Phase 8 - Operations, Security, And Compliance Hardening](#phase-8---operations-security-and-compliance-hardening)
  - [Phase 9 - Spike Decision Gate Before Milestone 3](#phase-9---spike-decision-gate-before-milestone-3)
- [Verification Commands](#verification-commands)
- [Primary Risks To Recheck During Implementation](#primary-risks-to-recheck-during-implementation)
- [Final Recommendation](#final-recommendation)

## Purpose

This plan defines how to introduce an AWS Textract-backed structured "base document"
artifact before Milestone 3 so downstream AI work is built on a stronger document
representation than plain text chunks.

This is not a small extractor swap. It is a controlled architecture change that:

- keeps current M2 chunk reads working as long as practical
- introduces a new canonical structured document artifact
- changes upload/processing from synchronous completion to asynchronous completion
- prepares the system for structured extraction, confidence-aware review, and later
  M3/M4 work

This document now also includes research-backed notes on how teams using Textract and
similar document-understanding systems typically answer the same open architectural
questions. Those notes are meant to reduce future re-research and make the plan easier
to execute and defend.

## Current Constraints

These constraints are already true in the repo and must be treated as hard facts:

1. `POST /api/documents/upload` is currently synchronous from the client point of view.
   - File: [src/app/api/documents/upload/route.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/app/api/documents/upload/route.ts:121)
   - Today the route uploads to S3, calls `processDocument(...)`, and returns
     `status: "COMPLETED"` with `pageCount` and `chunkCount` in the same response.

2. Current document persistence stores only:
   - `Document`
   - `DocumentChunk`
   - File: [prisma/schema.prisma](/abs/path/C:/Users/pc/work/yan/true-blue-platform/prisma/schema.prisma:70)

3. The current structured page model exists only in memory during processing.
   - Files:
     - [src/lib/document-structure.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-structure.ts:1)
     - [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:287)

4. The startup sweeper is not safe for async provider-backed processing.
   - File: [src/lib/startup-sweeper.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/startup-sweeper.ts:27)
   - It marks `UPLOADING` / `PROCESSING` documents older than 5 minutes as `FAILED`
     and then deletes failed S3 objects.

5. The current deployment has no worker service or queue consumer.
   - File: [docker-compose.prod.yml](/abs/path/C:/Users/pc/work/yan/true-blue-platform/docker-compose.prod.yml:3)

6. The current client AWS account cannot use Textract yet.
   - Verified error:
     - `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service`

## Locked Decisions

These decisions are treated as fixed for this plan. If any of them change, the plan
must be updated before implementation starts.

1. The new structured artifact is **internal first**.
   - We will not immediately promise the full client-requested structured JSON as a
     public API contract.

2. The new artifact will be **provider-neutral** at the app boundary.
   - Raw Textract output is input to normalization, not the public contract.

3. The current chunk read endpoints remain the compatibility surface where practical.
   - `GET /api/documents`
   - `GET /api/documents/[id]`
   - `GET /api/documents/[id]?chunks=true...`

4. The current upload POST response shape is **not** treated as preservable.
   - Upload will move from inline `COMPLETED` to async `PROCESSING`.

5. The first Textract feature set is:
   - `FORMS`
   - `TABLES`
   - `LAYOUT`
   - Not `QUERIES` by default
   - Not `SIGNATURES` by default

6. Raw provider payloads will be stored in S3, not only in Postgres.

7. The full canonical base-document artifact will also be stored in S3 in compressed
   form, with Postgres holding only:
   - artifact metadata
   - processing state
   - a compact summary JSON
   - pointers to the canonical and raw payload objects

8. The async runtime model will be:
   - `POST /upload` starts processing
   - SNS -> SQS completion notifications
   - separate worker service consumes SQS

9. Success is not defined by chunk quality alone.
   - The evaluation gate must include field, table, selection mark, geometry, and
     confidence behavior.

## Industry Practice Notes For The Open Decisions

This section captures current research on how teams using Textract and similar
document-understanding systems handle the same architectural questions. It exists so
future implementation work does not have to rediscover the same patterns.

### 1. Base-Document Contract

**What other teams do**

1. Keep the provider output behind an internal normalized model instead of exposing raw
   provider blocks directly.
2. Preserve provenance:
   - source block IDs
   - geometry
   - page attribution
   - evidence chains
3. Use a two-layer model:
   - provider-neutral canonical document
   - raw-provider sidecar for audit/debug

**Industry examples**

- AWS sample parser wraps Textract blocks into higher-level document/page/form/table
  objects:
  - https://github.com/aws-samples/amazon-textract-response-parser
- AWS Textractor exposes multiple derived views from one structured document:
  - https://aws-samples.github.io/amazon-textract-textractor/index.html
- AWS document data extraction platform maps detections into schema-defined records:
  - https://github.com/aws-samples/aws-textract-document-data-extraction-platform
- Google Document AI treats `Document` as the canonical interchange model:
  - https://cloud.google.com/document-ai/docs/reference/rest/v1/Document
- Unstructured and Docling both keep provider-agnostic document representations:
  - https://docs.unstructured.io/api-reference/legacy-api/partition/document-elements
  - https://docling-project.github.io/docling/concepts/docling_document/

**Default for this repo**

1. Keep a provider-neutral canonical base document.
2. Keep raw Textract output as a sidecar, not as the public contract.
3. Keep source block IDs on every normalized object.

### 2. Async Runtime And Job Orchestration

**What other teams do**

1. Start Textract with:
   - `ClientRequestToken`
   - `JobTag`
   - `NotificationChannel`
2. Treat every delivery layer as at-least-once.
3. Use SNS -> SQS -> worker or Lambda.
4. Make the worker idempotent because duplicates and out-of-order delivery are normal.
5. Use a durable job row / claim instead of treating queue delivery as the lock.

**Industry examples**

- Textract async docs:
  - https://docs.aws.amazon.com/textract/latest/dg/api-async.html
- `StartDocumentAnalysis`:
  - https://docs.aws.amazon.com/textract/latest/dg/API_StartDocumentAnalysis.html
- `GetDocumentAnalysis`:
  - https://docs.aws.amazon.com/textract/latest/dg/API_GetDocumentAnalysis.html
- SNS completion payload:
  - https://docs.aws.amazon.com/textract/latest/dg/async-notification-payload.html
- SQS at-least-once delivery:
  - https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html
- AWS AI Intelligent Document Processing sample:
  - https://github.com/aws-samples/aws-ai-intelligent-document-processing

**Default for this repo**

1. Standard SQS queue, not FIFO by default.
2. `ClientRequestToken` derived from `document.id`.
3. Worker claims by `providerJobId`, not by queue receipt alone.
4. Queue duplicates and out-of-order events must be safe no-ops.

### 3. Storage, Security, Retention, And Compliance

**What other teams do**

1. Keep large/raw artifacts in object storage, not the relational DB.
2. Keep only compact summaries and pointers in the DB.
3. Use encryption, retention, and lifecycle policies from the start.
4. Separate raw, derived, and audit storage paths.
5. Redact logs aggressively and treat structured artifacts as sensitive.

**Industry examples**

- AWS guidance to offload large items to S3:
  - https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-use-s3-too.html
- S3 object/storage guidance:
  - https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingObjects.html
- AWS sensitive-data / data-lake guidance:
  - https://docs.aws.amazon.com/prescriptive-guidance/latest/defining-bucket-names-data-lakes/sensitive-data.html
- S3 encryption best practices:
  - https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/s3.html
- S3 lifecycle:
  - https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html
- CloudWatch masking:
  - https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/mask-sensitive-log-data.html
- CloudTrail validation:
  - https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html
- Macie discovery:
  - https://docs.aws.amazon.com/macie/latest/user/data-classification.html

**Default for this repo**

1. Full raw and canonical artifacts in S3.
2. Only compact summary/state in Postgres.
3. Default sensitive artifact stance:
   - SSE-KMS for any real-client-data or production path
4. Log redaction is mandatory.
5. Explicit lifecycle policies are mandatory.

### 4. Evaluation, Confidence, And Human Review

**What other teams do**

1. Do not judge quality by OCR text alone.
2. Score:
   - fields
   - tables
   - selection marks
   - geometry/provenance
3. Use confidence for routing and review, not as truth.
4. Keep a held-out validation set.
5. Use human review on low-confidence or missing critical fields.

**Industry examples**

- Textract best practices:
  - https://docs.aws.amazon.com/textract/latest/dg/textract-best-practices.html
- Textract A2I:
  - https://docs.aws.amazon.com/sagemaker/latest/dg/a2i-textract-task-type.html
- Human-loop activation conditions:
  - https://docs.aws.amazon.com/sagemaker/latest/dg/a2i-json-humantaskactivationconditions-textract-example.html
- Google Document AI evaluation:
  - https://docs.cloud.google.com/document-ai/docs/evaluate
- Table evaluation reference:
  - https://arxiv.org/abs/2208.00385

**Default starting thresholds for this repo**

These are research-backed defaults, not final truths. They must be validated on a
held-out set.

1. Critical fields:
   - held-out `F1 >= 0.97`
   - review if key/value confidence `< 0.95`
2. Standard fields:
   - held-out `F1 >= 0.95`
   - review if confidence `< 0.90`
3. Tables:
   - cell `F1 >= 0.97`
   - structure `TEDS >= 0.95`
4. Selection marks:
   - `F1 >= 0.99`
5. Provenance:
   - missing provenance is an automatic failure
6. Test data:
   - no raw PII or real ground truth in git

### 5. Structured Output Plus Chunking / Retrieval

**What other teams do**

1. Keep the structured parser output as canonical.
2. Derive text, Markdown, HTML, XML-tagged sections, CSV tables, and chunks from that
   canonical artifact.
3. Prefer structure-first chunking:
   - titles
   - sections
   - page boundaries
   - table boundaries
4. Keep tables isolated instead of flattening them into prose.
5. Use chunk metadata with provenance, layout, and page spans.

**Industry examples**

- Textractor structured -> text/Markdown/HTML linearization:
  - https://aws-samples.github.io/amazon-textract-textractor/notebooks/document_linearization_to_markdown_or_html.html
- Textractor for LLM use:
  - https://aws-samples.github.io/amazon-textract-textractor/notebooks/textractor_for_large_language_models.html
- AWS layout-aware RAG sample:
  - https://github.com/aws-samples/layout-aware-document-processing-and-retrieval-augmented-generation
- Bedrock chunking guidance:
  - https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking.html
- Bedrock structured-store guidance:
  - https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-build-structured.html
- Unstructured element-first chunking:
  - https://docs.unstructured.io/open-source/core-functionality/chunking
- AWS custom chunking article:
  - https://aws.amazon.com/blogs/machine-learning/accelerate-performance-using-a-custom-chunking-mechanism-with-amazon-bedrock/

**Default for this repo**

1. Keep the base artifact canonical.
2. Make chunks derived projections, not the source of truth.
3. Split chunks on structure, not just token length.
4. Keep tables separate from prose chunks.
5. Carry these metadata fields on derived chunks where applicable:
   - `doc_id`
   - `page_start`
   - `page_end`
   - `section_path`
   - `table_id`
   - `source_block_ids`
   - `parser_version`
   - `chunk_strategy`

## Non-Goals

The following are intentionally out of scope for this plan:

1. Exposing the final client-facing structured JSON API contract immediately.
2. Replacing all existing chunk logic in one step.
3. Supporting multiple provider backends at once.
4. Building tax-return semantic mapping such as `Form1040.line11` in the first pass.
5. Solving every document-understanding problem in one iteration.

## Target Architecture

The target architecture after this plan:

1. Upload stores source PDF in S3.
2. Upload creates `Document` and `DocumentBaseArtifact` records.
3. Upload starts Textract async analysis and returns `PROCESSING`.
4. A worker receives completion, fetches all Textract pages/blocks, and normalizes
   them into one canonical base document.
5. The normalized base document is persisted.
6. Chunks are materialized from the base document, not directly from raw PDF text.
7. Existing chunk endpoints continue reading from `DocumentChunk`.
8. A later phase may expose the base document via a dedicated endpoint.

## Canonical Base-Document Contract

This contract is the internal source of truth before M3.

Required top-level structure:

```json
{
  "document": {
    "provider": "aws-textract",
    "providerModelVersion": "string",
    "pageCount": 0,
    "source": {
      "s3Bucket": "string",
      "s3Key": "string"
    }
  },
  "pages": [
    {
      "pageNumber": 1,
      "rawText": "string",
      "lines": [],
      "layout": [],
      "fields": [],
      "tables": [],
      "queries": [],
      "signatures": []
    }
  ],
  "fullText": "string",
  "providerRaw": {
    "warnings": [],
    "jobMetadata": {},
    "sourceBlockIdsByPage": {}
  }
}
```

Minimum normalization rules:

1. Every normalized object must preserve backpointers to raw provider block IDs.
2. Every field/table/selection object must carry page attribution.
3. Geometry stays normalized, not pixel-converted, in the base artifact.
4. Confidence is stored, but treated as a review/routing signal, not as correctness.
5. `fullText` is derived from normalized page content, not from a second unrelated
   extraction path.

Minimum nested shapes:

1. `lines[]`
   - `id`
   - `pageNumber`
   - `text`
   - `confidence`
   - `geometry`
   - `sourceBlockIds[]`

2. `layout[]`
   - `id`
   - `pageNumber`
   - `type`
   - `text`
   - `confidence`
   - `geometry`
   - `childIds[]`
   - `sourceBlockIds[]`

3. `fields[]`
   - `id`
   - `pageNumber`
   - `key`
   - `value`
   - `selectionMarks[]`
   - `confidence`
   - `sourceBlockIds[]`
   - `status`
     - `resolved`
     - `ambiguous`
     - `missing_value`

4. `tables[]`
   - `id`
   - `pageNumber`
   - `tableType`
   - `title`
   - `footer`
   - `geometry`
   - `cells[]`
   - `sourceBlockIds[]`

5. `cells[]`
   - `id`
   - `row`
   - `column`
   - `rowSpan`
   - `columnSpan`
   - `kind`
   - `text`
   - `confidence`
   - `geometry`
   - `selectionMarks[]`
   - `sourceBlockIds[]`

6. Every normalized object means:
   - line
   - layout object
   - field
   - field key
   - field value
   - selection mark
   - table
   - table cell
   - query
   - signature

Backpointer shape:

```json
{
  "sourceBlockIds": ["textract-block-id-1", "textract-block-id-2"]
}
```

Geometry policy:

1. Geometry stays in Textract-normalized coordinates:
   - `BoundingBox`
   - `Polygon`
   - `RotationAngle`
2. No pixel conversion is stored in the canonical artifact.
3. If `Polygon` exists, it must be preserved.
4. `BoundingBox` is required on every normalized object that maps to a provider block.
5. `RotationAngle` defaults to `0` only if provider output does not include it.

Storage policy:

1. Full canonical artifact:
   - compressed JSON in S3
2. Full raw provider payload:
   - compressed JSON in S3
3. Postgres stores only:
   - artifact metadata
   - processing state
   - pointer keys
   - compact summary JSON
4. No full raw provider payload is stored in Postgres.
5. No full canonical artifact is stored in Postgres by default.

## Async State Machine And Idempotency

This section is mandatory. Implementation must not invent its own state handling.

### Document.status

Public coarse status remains:

- `UPLOADING`
- `PROCESSING`
- `COMPLETED`
- `FAILED`

Rules:

1. `COMPLETED` means:
   - base artifact persisted successfully
   - chunks persisted successfully
2. `PROCESSING` means:
   - work may still be in progress
   - clients must not assume chunks are ready
3. `FAILED` means:
   - terminal failure unless a controlled reprocess is started

### DocumentBaseArtifact.artifactStatus

Internal fine-grained status:

- `QUEUED`
- `STARTING_PROVIDER_JOB`
- `AWAITING_PROVIDER_RESULT`
- `PROVIDER_RESULT_READY`
- `NORMALIZING`
- `NORMALIZED`
- `CHUNKING`
- `READY`
- `FAILED`
- `CANCELLED`

### Allowed transitions

1. `QUEUED -> STARTING_PROVIDER_JOB`
2. `STARTING_PROVIDER_JOB -> AWAITING_PROVIDER_RESULT`
3. `AWAITING_PROVIDER_RESULT -> PROVIDER_RESULT_READY`
4. `PROVIDER_RESULT_READY -> NORMALIZING`
5. `NORMALIZING -> NORMALIZED`
6. `NORMALIZED -> CHUNKING`
7. `CHUNKING -> READY`
8. Any non-terminal state may transition to `FAILED`
9. Any non-terminal state may transition to `CANCELLED`

### Invariants

1. Only one worker may actively claim an artifact at a time.
2. `Document.status = COMPLETED` only when `artifactStatus = READY`.
3. Chunks must not be written twice for the same artifact version.
4. A deleted or cancelled document must not be resurrected by late provider
   notifications.

### Idempotency rules

1. `ClientRequestToken` must be deterministic per upload attempt.
2. Token source:
   - `document.id`
   - not a random retry-local value
3. Reprocessing must use a new artifact version and a new provider job.
4. Duplicate SNS/SQS deliveries must be safe.
5. Worker writes must be idempotent and guarded by DB claim checks.

### Atomic write boundaries

1. Raw provider payload pointer persisted before normalization starts.
2. Canonical artifact pointer and summary persisted atomically with
   `artifactStatus = NORMALIZED`.
3. Chunk creation and `Document.status = COMPLETED` happen in one transaction.

### PARTIAL_SUCCESS policy

Default policy:

1. `PARTIAL_SUCCESS` does not auto-complete a document.
2. `PARTIAL_SUCCESS` becomes:
   - `FAILED` if missing pages/critical structure make the artifact unreliable
   - otherwise explicit manual-review candidate only if a later review workflow is
     added
3. In the first implementation pass, treat `PARTIAL_SUCCESS` as `FAILED` unless a
   written exception rule is added for a specific document class.

## AWS Resource Specification

The implementation plan assumes these resources exist:

1. SNS topic for Textract completion events
2. SQS queue subscribed to the SNS topic
3. Dead-letter queue for failed or poison messages
4. Textract notification role that permits publish to SNS
5. App/worker IAM permissions for:
   - `textract:StartDocumentAnalysis`
   - `textract:GetDocumentAnalysis`
   - S3 read/write on source and artifact buckets/prefixes
   - SQS receive/delete/change-visibility
   - KMS permissions if SSE-KMS is used
   - `iam:PassRole` where required

Queue rules:

1. Queue policy must only allow the configured SNS topic to publish.
2. Server-side encryption must be enabled.
3. Visibility timeout must exceed the expected single-job processing window.
4. Redrive policy must exist.
5. Worker must parse the SNS-to-SQS envelope, not assume the queue body is already the
   Textract payload.
6. Required lookup rule:
   - completion message `JobId` -> `DocumentBaseArtifact.providerJobId`
   - only then may the worker claim the artifact row
7. Default queue operating stance:
   - standard SQS queue
   - long polling enabled
   - `maxReceiveCount >= 5`
   - visibility timeout sized to at least `6x` the expected worker timeout

Required environment variables:

- `AWS_REGION`
- `AWS_TEXTRACT_NOTIFICATION_TOPIC_ARN`
- `AWS_TEXTRACT_NOTIFICATION_ROLE_ARN`
- `AWS_TEXTRACT_QUEUE_URL`
- `AWS_TEXTRACT_DLQ_URL` if used
- `AWS_TEXTRACT_ARTIFACT_BUCKET`
- `AWS_TEXTRACT_ARTIFACT_PREFIX`
- `AWS_TEXTRACT_RAW_PREFIX`
- `AWS_TEXTRACT_CANONICAL_PREFIX`
- `AWS_TEXTRACT_FEATURE_TYPES`
- `AWS_TEXTRACT_KMS_KEY_ID` if used

## Upload Contract

`POST /api/documents/upload` must move to this response shape:

```json
{
  "document": {
    "id": "string",
    "originalName": "string",
    "fileSize": 123,
    "status": "PROCESSING",
    "analysisProvider": "TEXTRACT",
    "processingStage": "QUEUED",
    "baseDocumentReady": false,
    "chunkCount": null,
    "pageCount": null
  }
}
```

Rules:

1. `chunkCount` is `null` until chunking completes.
2. `pageCount` is `null` until provider result is normalized.
3. Existing clients must poll document detail or list endpoints for completion.
4. Recommended polling guidance:
   - exponential backoff
   - no tight loop

Polling contract:

1. `GET /api/documents`
2. `GET /api/documents/[id]`

must expose these fields during the transition:

- `status`
- `analysisProvider`
- `processingStage`
- `baseDocumentReady`

Clients may treat `Document.status = COMPLETED` as the only completion guarantee.

## Deletion, Cancellation, And Retention Semantics

1. If a document is deleted while processing:
   - mark artifact as `CANCELLED`
   - delete source PDF
   - delete raw/canonical S3 artifacts if already written
   - ignore late provider completion messages

2. If a late provider notification arrives for a deleted/cancelled document:
   - acknowledge the message
   - do not recreate DB rows
   - do not recreate chunks

3. Raw payload retention:
   - explicit S3 lifecycle policy required
   - default staging retention: 14 days
4. Canonical artifact retention:
   - explicit S3 lifecycle policy required
   - default staging retention: 30 days
5. Logs must never contain raw field values unless specifically redacted and approved.

## Migration, Backfill, And Rollback

1. Mixed-mode support is required:
   - legacy documents with chunks only
   - new documents with base artifact + chunks

2. Backfill is not part of the first rollout unless explicitly approved.

3. Reprocessing rules:
   - create a new artifact version
   - delete or archive old chunks before writing replacement chunks
   - avoid `@@unique([documentId, chunkIndex])` collisions by removing old derived
     chunks within the same transaction before inserting new ones

4. Rollout must be feature-flagged.
   - flag for async upload behavior
   - flag for worker consumption
   - flag for base-document route exposure

5. Rollback path:
   - disable worker consumption
   - disable async upload flag
   - keep legacy chunk reads working
   - do not drop legacy-compatible schema until rollout is stable

## Evaluation Rubric

Before implementation starts, the following quality checks are treated as mandatory.

1. Field correctness
   - Key text
   - Value text
   - linked value-to-key relationship

2. Table correctness
   - row/column positions
   - merged cells where present
   - title/footer linkage where present

3. Selection marks
   - correct selected vs not-selected state
   - correct ownership by field or table cell

4. Layout
   - section/title/header/footer/page-number capture
   - usable reading-order reconstruction

5. Geometry and provenance
   - every normalized object has geometry
   - every normalized object can be traced back to raw provider blocks

6. Confidence handling
   - stored consistently
   - not treated as guaranteed correctness

7. Compatibility
   - existing chunk endpoints still work
   - chunk output is derived from the base artifact

8. Operational correctness
   - jobs survive restarts
   - retries are idempotent
   - stuck jobs are recoverable

9. Human review defaults
   - missing critical fields route to review
   - low-confidence critical fields route to review
   - stable document flows may use light random sampling
   - new document families should use higher sampling until performance is proven

## Implementation Phases

### Phase 0 - Prerequisites And Spike Gate

**Goal**

Make sure the project is allowed to use Textract and define the smallest proof before
code changes start.

**Files to update**

- `docs/textract-base-document-foundation-plan.md`
- `docs/staging-notes.md`
- deployment/IAM notes if needed

**Step-by-step**

1. Resolve Textract access in the client AWS account.
   - Confirm the `SubscriptionRequiredException` is gone.
   - Confirm the chosen region.

2. Decide the initial processing region and keep it aligned with the S3 bucket region.

3. Freeze the initial feature set:
   - `FORMS`
   - `TABLES`
   - `LAYOUT`

4. Freeze the spike document set.
   - Minimum:
     - one individual return
     - one business or table-heavier return
     - one document with selection/checkbox behavior if available
   - If the packet set does not contain a strong selection-mark example, document that
     gap explicitly instead of silently skipping it.

5. Freeze spike success criteria:
   - required field relationships pass the agreed checks on every spike PDF
   - required tables pass the agreed cell/row checks on every spike PDF
   - layout reconstruction passes the agreed reading-order/section checks on every
     spike PDF
   - no hidden dependency on old extraction for `fullText`
   - no raw provider payload or PII ground truth is committed to git

6. Decide where raw provider payloads will be stored.
   - Default: S3

7. Decide whether the base-document endpoint is internal-only for the first pass.
   - Default: yes

**Verification**

- AWS account can call Textract successfully.
- A single manual `StartDocumentAnalysis` succeeds on a spike PDF.
- Spike success criteria are written down before implementation.

**Exit criteria**

- Textract access works
- region is fixed
- feature set is fixed
- spike PDFs are fixed
- success criteria are fixed

---

### Phase 1 - Async Runtime Foundation

**Goal**

Introduce the runtime shape required for async provider-backed processing.

**Files to edit**

- [src/app/api/documents/upload/route.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/app/api/documents/upload/route.ts:1)
- [src/lib/startup-sweeper.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/startup-sweeper.ts:1)
- [src/instrumentation.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/instrumentation.ts:1)
- [docker-compose.prod.yml](/abs/path/C:/Users/pc/work/yan/true-blue-platform/docker-compose.prod.yml:1)
- worker entrypoint files to be added
- env templates and deployment docs

**Files to add**

- `src/lib/processing-runtime.ts`
- `src/lib/queue/` or equivalent worker modules
- worker bootstrap file

**Step-by-step**

1. Stop treating upload and full processing as one request lifecycle.

2. Change the upload route so it:
   - validates and stores the PDF in S3
   - creates the document row
   - creates a base-artifact placeholder row
   - starts the provider job
   - returns `PROCESSING`

3. Add a worker service to the deployment model.
   - separate service in Compose
   - same image is acceptable if boot mode differs

4. Define queue handling.
   - SNS topic
   - SQS queue
   - DLQ
   - queue policy
   - queue encryption
   - redrive policy
   - visibility timeout
   - message format parser

5. Remove the dangerous sweeper behavior for async jobs.
   - do not auto-delete S3 source PDFs for provider-backed in-flight documents
   - do not fail documents purely because they exceeded the old 5-minute inline model

6. Add a reconciliation path for stale jobs.
   - worker can re-check outstanding job IDs
   - sweeper becomes recovery-aware instead of delete-first

7. Add idempotent job-start semantics.
   - use `ClientRequestToken`
   - derive token from `document.id`
   - use a new token for explicit reprocessing attempts

8. Define the worker algorithm explicitly:
   - receive SQS message
   - validate source topic
   - locate `DocumentBaseArtifact`
   - claim the artifact row for processing
   - fetch all result pages until `NextToken` is exhausted
   - persist raw payload pointer
   - normalize and persist canonical artifact pointer + summary
   - regenerate chunks transactionally
   - mark the document complete
   - acknowledge the message only after terminal state write

**Verification**

- `POST /api/documents/upload` returns quickly with `PROCESSING`.
- Worker service can start independently.
- Restarting the app does not destroy legitimate in-flight jobs.
- Duplicate upload retries do not start duplicate Textract jobs for the same request.

**Exit criteria**

- async runtime exists
- upload route no longer blocks on extraction
- worker runtime is deployable
- sweeper is safe for async jobs

---

### Phase 2 - Schema And Persistence Layer

**Goal**

Persist the canonical base artifact without breaking current chunk reads.

**Files to edit**

- [prisma/schema.prisma](/abs/path/C:/Users/pc/work/yan/true-blue-platform/prisma/schema.prisma:1)
- Prisma migration files
- delete paths and associated service code

**Files to add**

- `DocumentBaseArtifact` model
- optional `DocumentBasePage` model if needed

**Recommended schema shape**

`DocumentBaseArtifact`
- `id`
- `documentId` unique
- `provider`
- `providerJobId`
- `artifactVersion`
- `artifactStatus`
- `artifactSummaryJson`
- `canonicalS3Key`
- `rawPayloadS3Key`
- `pageCount`
- `textLayerDetected`
- `ocrUsed`
- `confidenceSummary`
- `errorMessage`
- timestamps

Optional `DocumentBasePage`
- `artifactId`
- `pageNumber`
- `rawText`
- `structuredJson`
- `confidenceSummary`

**Step-by-step**

1. Add the new Prisma models.

2. Keep `Document.status` coarse for compatibility.

3. Add finer-grained artifact status on the new model.

4. Add indexes for:
   - `documentId`
   - `providerJobId`
   - `artifactStatus`

5. Update delete flow planning.
   - deleting a document must clean:
     - chunks
     - base artifact rows
     - canonical artifact S3 object
     - raw payload S3 objects

6. Store the full canonical artifact in S3 and only a summary in DB.
   - default:
     - compact summary JSON in DB
     - full canonical artifact in S3
     - full raw provider payload in S3

7. Add mandatory artifact versioning fields.

**Verification**

- Prisma migration applies cleanly on a local DB.
- Existing chunk reads still work after the migration.
- Delete logic leaves no orphaned artifact rows or raw payload pointers.

**Exit criteria**

- schema supports async provider jobs
- schema supports canonical artifact persistence
- schema supports compatibility with current chunk reads

---

### Phase 3 - Textract Provider Integration

**Goal**

Integrate Textract as the provider that produces the raw analysis graph.

**Files to edit**

- `package.json`
- new AWS SDK client wiring
- provider modules
- env handling

**Files to add**

- `src/lib/providers/document-analysis-provider.ts`
- `src/lib/providers/textract-provider.ts`
- `src/lib/providers/textract-types.ts`

**Step-by-step**

1. Add the Textract SDK dependency.

2. Implement a provider interface that is not Textract-specific.

3. Implement `TextractProvider` with:
   - `startAnalysis(...)`
   - `getAnalysisResult(...)`
   - `normalizeProviderMetadata(...)`

4. Use `StartDocumentAnalysis` with:
   - `FORMS`
   - `TABLES`
   - `LAYOUT`
   - `ClientRequestToken`

5. Collect all `GetDocumentAnalysis` pages by exhausting `NextToken`.

6. Persist raw provider payloads to S3.

7. Persist provider job state and warnings.

8. Define behavior for:
   - `FAILED`
   - `PARTIAL_SUCCESS`
   - warnings
   - throttling / retryable errors
   - duplicate completion messages
   - out-of-order completion messages

**Verification**

- A spike PDF produces a complete raw provider payload.
- Pagination is fully exhausted.
- Warnings and status values are stored.
- Retries do not duplicate jobs incorrectly.

**Exit criteria**

- Textract raw analysis can be started, fetched, persisted, and retried safely

---

### Phase 4 - Base-Document Normalization

**Goal**

Transform raw Textract blocks into the canonical provider-neutral base document.

**Files to add**

- `src/lib/base-document/types.ts`
- `src/lib/base-document/normalize-textract.ts`
- `src/lib/base-document/confidence.ts`
- `src/lib/base-document/layout.ts`
- `src/lib/base-document/fields.ts`
- `src/lib/base-document/tables.ts`

**Files to edit**

- current processing pipeline modules as needed

**Step-by-step**

1. Build a block index by `Id`.

2. Group blocks by page.

3. Build normalized `lines`.

4. Build normalized `layout` objects from `LAYOUT_*` blocks.

5. Build normalized `fields` by traversing:
   - `KEY_VALUE_SET`
   - `VALUE`
   - `CHILD`
   - selection elements where present

6. Build normalized `tables` by traversing:
   - `TABLE`
   - `CELL`
   - `MERGED_CELL`
   - title/footer relationships where present

7. Build `fullText` from normalized page content, not from a second extraction path.

8. Preserve geometry, confidence, page attribution, and source block IDs on every
   normalized object.

9. Version the artifact shape.

10. Persist the canonical normalized artifact.

**Verification**

- Base artifact is deterministic for the same provider payload.
- Every normalized field/table/selection object has source block IDs.
- Every page has recoverable raw text and structured content.
- No provider block pagination gaps appear in the normalized artifact.

**Exit criteria**

- canonical base artifact exists
- artifact is provider-neutral at the app boundary
- provenance is preserved

---

### Phase 5 - Structured Evaluation Harness

**Goal**

Prevent another “looks good locally, client still unhappy” cycle by adding a proper
structured-extraction gate.

**Files to add**

- `scripts/verify-textract-base-document.ts`
- `scripts/fixtures/textract-base-document-fixtures.ts`
- `docs/textract-base-document-evaluation.md`

**Step-by-step**

1. Add positive checks for:
   - key-value pairs
   - table cells
   - selection marks
   - geometry presence
   - page attribution

2. Add negative checks for:
   - wrong field pairing
   - duplicate candidate ambiguity
   - missing table rows
   - merged-cell flattening failures
   - empty geometry

3. Add a tuning set and a holdout set.
   - fixtures must not store raw PII values in git

4. Add at least one cross-page table or multi-page layout case.

5. Add confidence-policy checks.
   - stored consistently
   - not treated as correctness

6. Add regression checks ensuring chunk derivation still works from the new base artifact.

7. Freeze objective pass thresholds:
   - required fields: all pass
   - required geometry: all pass
   - required tables: all pass
   - required selection marks: all pass
   - worker restart/retry scenario: pass

**Verification**

- structured verifier fails on intentionally corrupted artifacts
- structured verifier passes on the agreed spike PDFs
- holdout checks exist, not just tuning checks

**Exit criteria**

- structured evaluation exists
- success is not judged by chunk quality alone

---

### Phase 6 - Chunk Derivation From The Base Artifact

**Goal**

Make chunks a derived compatibility layer from the canonical base document.

**Files to edit**

- [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:1)
- [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:1)
- any metadata normalization files

**Step-by-step**

1. Refactor the current pipeline into two stages:
   - build/persist base artifact
   - materialize chunks from the base artifact

2. Reuse chunking where safe, but use base-document structure as input.

3. Make chunk metadata explicitly provider-agnostic.

4. Preserve existing M2 chunk metadata fields where practical.

5. Ensure chunk derivation never bypasses the base artifact once the new flow is active.

6. Keep old chunk GET endpoints reading from `DocumentChunk`.

**Verification**

- Existing chunk endpoints still respond successfully.
- Chunks are derived from the new base artifact.
- Chunk pagination and metadata still work.

**Exit criteria**

- chunk compatibility layer is restored on top of the new foundation

---

### Phase 7 - API Surface And Compatibility Rollout

**Goal**

Expose only the minimum new surface needed before M3 while preserving existing
consumer behavior where possible.

**Files to edit**

- [src/app/api/documents/upload/route.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/app/api/documents/upload/route.ts:1)
- [src/app/api/documents/[id]/route.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/app/api/documents/[id]/route.ts:1)
- [src/app/api/documents/route.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/app/api/documents/route.ts:1)

**Files to add**

- `src/app/api/documents/[id]/base-document/route.ts` (internal or gated first)

**Step-by-step**

1. Change upload response semantics to async:
   - return `PROCESSING`
   - include `document.id`
   - include coarse processing info

2. Do not overload the current detail route with the whole base artifact.

3. Add an internal/gated base-document route.
   - protected by authz and feature flag
   - response sizing strategy must be defined before exposure

4. Optionally add summary fields to existing document responses:
   - `baseDocumentReady`
   - `analysisProvider`
   - `processingStage`

5. Keep current chunk GET behavior intact during the transition.

6. Update acceptance/testing docs only after behavior is stable.

**Verification**

- Upload returns a truthful async state.
- Existing chunk GET consumers are not broken.
- Base-document route returns the normalized artifact correctly when enabled.

**Exit criteria**

- public surface is coherent
- current compatibility endpoints still work
- new internal surface exists for structured testing and M3 preparation

---

### Phase 8 - Operations, Security, And Compliance Hardening

**Goal**

Make the async structured-extraction pipeline operable for tax-document workloads.

**Files to edit**

- deployment docs
- env docs
- staging notes
- queue/worker config

**Step-by-step**

1. Add required IAM permissions:
   - Textract start/get
   - S3 read/write for raw payloads
   - SNS/SQS permissions
   - `iam:PassRole` if required by the chosen setup

2. Decide KMS behavior for output storage.
   - decide SSE-S3 vs SSE-KMS
   - if SSE-KMS is used, define exact key ownership and decrypt scope
   - default stance:
     - staging spike: SSE-S3 is acceptable
     - any production or real-client-data path requires explicit SSE-KMS review

3. Add AI-services opt-out review if the client AWS org uses it.

4. Add monitoring/observability:
   - `documentId`
   - `providerJobId`
   - provider feature set
   - start/completion time
   - retries
   - throttles
   - warnings
   - partial-success pages
   - artifact size

5. Add dead-letter / reconciliation handling.

6. Add log-redaction policy for sensitive structured fields.
   - no raw field values in standard logs or traces by default

7. Update delete paths so no raw artifacts remain orphaned.

**Verification**

- worker failures are observable
- job retries are observable
- stale jobs are recoverable
- no sensitive structured payload is dumped accidentally to logs

**Exit criteria**

- async provider-backed analysis is operable and supportable

---

### Phase 9 - Spike Decision Gate Before Milestone 3

**Goal**

Decide whether Textract becomes the base-document foundation before M3.

**Step-by-step**

1. Run the spike PDFs end to end.

2. Compare:
   - current native extraction artifact
   - Textract raw block graph
   - normalized base artifact
   - derived chunks

3. Evaluate against the structured rubric, not only chunk quality.

4. Record:
   - what materially improved
   - what remained weak
   - what still needs normalization
   - what changed in upload/runtime behavior

5. Apply explicit go/no-go thresholds:
   - all spike documents complete without orphaned async state
   - all objective checks from Phase 5 pass
   - restart/retry scenario passes
   - no unresolved compliance blocker remains
   - cost remains within agreed staging tolerance

6. Make an explicit go/no-go call:
   - `GO`: Textract becomes the pre-M3 foundation
   - `NO-GO`: keep native path and revisit fallback-only use

**Verification**

- decision is evidence-based
- no milestone proceeds on assumption alone

**Exit criteria**

- team has a written, evidence-backed decision before beginning M3 implementation

## Verification Commands

These commands are placeholders for the implementation phases and should be updated as
new scripts are added.

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-api-boundary.js
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
```

Expected future commands after implementation:

```powershell
node scripts/verify-textract-base-document.ts --pdf-dir ..\client_shared_pdfs
node scripts/verify-textract-worker-flow.ts
node scripts/verify-textract-api-compat.ts
```

## Primary Risks To Recheck During Implementation

1. Upload API contract drift
2. Startup sweeper deleting valid async documents
3. Missing worker durability
4. Mixed legacy/new document support
5. Raw payload storage bloat
6. Confidence being treated as correctness
7. Structured artifact still not being client-usable after normalization
8. M3 retrieval semantics drifting without explicit redesign

## Final Recommendation

Do not implement this as a silent Textract swap.

Implement it as:

1. async runtime foundation
2. additive schema/artifact layer
3. Textract provider integration
4. structured evaluation gate
5. chunk compatibility restoration
6. explicit go/no-go decision before M3
