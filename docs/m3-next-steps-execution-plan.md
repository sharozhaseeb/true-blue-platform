# M3 Next Steps Execution Plan

Updated: 2026-05-20

## Decision

We already have an M3 plan in `docs/m3-production-ai-structured-document-plan.md`.
The relevant package decision is:

- Use `assistant-ui` for the chat interface.
- Use Vercel AI SDK for streaming chat transport and model streaming.
- Use OpenAI behind an internal wrapper for model calls.
- Use Pinecone Serverless for vector search with one namespace per firm.

This is not a hosted chatbot product and not a separate "Vercel ChatKit" dependency.
The current plan is closer to: **assistant-ui frontend + Vercel AI SDK streaming route + OpenAI model provider + Pinecone retrieval**.

## Current Starting Point

Already working:

1. PDF upload to S3.
2. Live Textract async processing through SNS/SQS/worker.
3. Provider-neutral `BaseDocument` artifact.
4. Structure-first retrieval chunks in Postgres.
5. Authenticated `/api/chat` JSON fallback using local lexical retrieval.
6. Server-side citations from retrieved chunks.
7. Staging deployment on AWS with Textract enabled.

Still missing for full M3:

1. Pinecone vector indexing.
2. OpenAI embedding wrapper.
3. Vector-backed retrieval path.
4. Vercel AI SDK streaming response.
5. assistant-ui integration in the dashboard.
6. Staging negative tests and UI acceptance.
7. Rollback/reprocess commands for vector generations.

## Package Direction

Use these package families unless a compatibility check during install proves otherwise:

| Area | Package |
| --- | --- |
| AI SDK core | `ai` |
| AI SDK React | `@ai-sdk/react` |
| OpenAI AI SDK provider | `@ai-sdk/openai` |
| Optional low-level OpenAI wrapper | `openai` |
| Chat UI | `@assistant-ui/react` |
| assistant-ui AI SDK adapter | `@assistant-ui/react-ai-sdk` |
| Pinecone | `@pinecone-database/pinecone` |
| Runtime/env validation | `zod` |

Pinned package versions selected for Phase 1:

| Package | Version |
| --- | --- |
| `ai` | `6.0.185` |
| `@ai-sdk/react` | `3.0.187` |
| `@ai-sdk/openai` | `3.0.64` |
| `@assistant-ui/react` | `0.14.5` |
| `@assistant-ui/react-ai-sdk` | `1.3.26` |
| `openai` | `6.38.0` |
| `@pinecone-database/pinecone` | `7.2.0` |
| `zod` | `4.4.3` |

Important implementation notes from current docs:

1. Vercel AI SDK route handlers use `streamText(...)` and return a UI message stream response.
2. Vercel AI SDK React clients use `useChat`.
3. assistant-ui integrates through `useChatRuntime` and `AssistantChatTransport` from `@assistant-ui/react-ai-sdk`, wrapped by `AssistantRuntimeProvider`.
4. Pinecone Serverless vector deletion should use exact vector IDs from our own inventory table. Do not rely on metadata-filter deletion for document cleanup.

## Phase 0 - Scope And Access Gate

Goal: avoid implementing the wrong M3 variant.

Steps:

1. Confirm whether M3 acceptance requires full Pinecone/OpenAI streaming now, or whether the current structured retrieval fallback can be accepted as an interim M3 slice.
2. Confirm provider approval for OpenAI and Pinecone with sample/redacted data first.
3. Get required secrets:
   - `OPENAI_API_KEY`
   - `PINECONE_API_KEY`
   - `PINECONE_INDEX_NAME`
   - `PINECONE_INDEX_HOST` if using host-based client targeting
   - embedding model name and dimension
4. Keep `ENABLE_AI_CHAT=false` and `ENABLE_VECTOR_INDEXING=false` until local gates pass.
5. Do not use real tax-firm data for provider calls until approval is explicit.

Exit criteria:

1. Provider access exists or the phase is explicitly blocked.
2. Required env vars are documented in `.env.example` and staging notes.
3. No provider keys or raw data are committed.

Status:

1. OpenAI and Pinecone env names are documented in `.env.example` and `.env.staging.example`.
2. Provider keys are still intentionally absent from committed files.
3. Runtime flags remain default-off: `ENABLE_VECTOR_INDEXING=false` and `ENABLE_AI_CHAT=false`.
4. Local verification passed with zero npm audit vulnerabilities.

## Phase 1 - Package And Compatibility Spike

Goal: prove the selected stack works with this Next.js/React version before larger refactors.

Steps:

1. Install pinned package versions.
2. Add a local spike route separate from production chat if needed.
3. Verify a minimal AI SDK streaming route can compile.
4. Verify assistant-ui runtime can connect to a local route.
5. Verify package peer dependencies with React 19 and Next 16.
6. Remove or isolate spike-only code before production implementation.

Verification:

```bash
npm install
npx tsc --noEmit
npm run build
```

Exit criteria:

1. Packages compile cleanly.
2. No incompatible peer dependency risk remains unresolved.
3. The production implementation path is confirmed.

Status:

1. Phase 1 packages have been installed and pinned.
2. `npm install --package-lock-only` reports zero vulnerabilities.
3. `npx tsc --noEmit` passes.
4. `npm run build` passes on Next.js 16.2.6 with Turbopack.
5. `npm run verify:m3-quality` and `npm run verify:textract-pipeline` pass.

## Phase 2 - Embedding And Pinecone Indexing

Goal: convert completed `DocumentRetrievalChunk` rows into searchable vectors.

Steps:

1. Add an embedding wrapper in `src/lib/ai/embedding-provider.ts`.
2. Centralize model config:
   - model name
   - dimension
   - batch size
   - timeout
   - retry policy
3. Add a Pinecone wrapper in `src/lib/vector/pinecone.ts`.
4. Use one namespace per firm, derived server-side from authenticated firm ID.
5. Store only allowlisted metadata in Pinecone:
   - document ID
   - firm ID
   - base artifact ID
   - page start/end
   - parser version
   - chunk strategy
   - vector generation
   - content type
   - form type if present
6. Do not store chunk text, field values, prompts, answers, SSNs, names, or snippets in Pinecone metadata.
7. Add vector inventory persistence using the existing `document_vector_indexes` model.
8. Use blue-green generation:
   - create generation `N+1`
   - embed and upsert all vectors for `N+1`
   - verify expected vector count
   - mark `N+1` active
   - retire `N`
9. Delete vectors by exact stored vector IDs from inventory. Do not use metadata-filter deletion.

Verification:

```bash
node scripts/verify-base-document-persistence.js
node scripts/verify-base-document-persistence-service.js
node scripts/verify-base-document-retrieval.js
npx tsc --noEmit
```

New verification to add:

```bash
node scripts/verify-vector-indexing.js
```

Exit criteria:

1. A completed base artifact creates vectors in the correct firm namespace.
2. Re-indexing is idempotent and generation-safe.
3. Deleted documents are no longer retrievable from vector search.
4. Cross-firm vector reads fail closed.

Foundation status:

1. Provider config is implemented in `src/lib/ai/config.ts` with `ENABLE_VECTOR_INDEXING` and `ENABLE_AI_CHAT` default-off.
2. OpenAI embedding wrapper is implemented in `src/lib/ai/embedding-provider.ts`.
3. Pinecone vector wrapper is implemented in `src/lib/vector/pinecone.ts`.
4. Vector indexing orchestration is implemented in `src/lib/vector/vector-indexing.ts`.
5. Offline verification is implemented in `scripts/verify-vector-provider-config.js` and `scripts/verify-vector-indexing.js`; both are included in `npm run verify:m3-quality`.
6. Textract completion now calls the vector indexing hook only when `ENABLE_VECTOR_INDEXING=true`.
7. Vector indexing failures are non-blocking for document completion and are surfaced as failed vector inventory, not failed documents.
8. Runtime indexing remains default-off and should not run in staging until a live Pinecone/OpenAI smoke passes on sample data.

Verified:

```bash
npm run verify:vector-provider
npm run verify:vector-indexing
npm run verify:textract-pipeline
npm run verify:live-vector-providers
npx tsc --noEmit
npm run build
npm run verify:m3-quality
```

Live provider smoke status:

1. `npm run verify:live-vector-providers` passed against synthetic data only.
2. OpenAI returned one `text-embedding-3-small` vector with dimension `1536`.
3. Pinecone upsert/query/delete worked in namespace `trueblue_firm_live_smoke`.
4. The smoke vector is deleted at the end of the script.
5. This command is intentionally not part of default quality gates because it uses live provider calls.

## Phase 3 - Vector Retrieval Service

Goal: replace local lexical retrieval as the primary retrieval path while keeping it as fallback.

Steps:

1. Add `src/lib/vector/vector-retrieval.ts`.
2. For each chat request:
   - authenticate user and firm server-side
   - validate document filters against firm ownership
   - embed query
   - query only the authenticated firm's Pinecone namespace
   - apply metadata filters for selected documents/page ranges/form types
   - load canonical chunk text from Postgres by vector IDs
   - discard unknown, stale, cross-firm, or inactive generation chunks
3. Keep lexical retrieval fallback behind a controlled flag.
4. Keep citations constructed from Postgres chunks, not model output.

Verification:

```bash
node scripts/verify-persisted-base-document-retrieval.js
node scripts/verify-vector-retrieval.js
npm run verify:m3-quality
```

Exit criteria:

1. Known sample questions retrieve expected chunks.
2. Cross-tenant retrieval returns no results.
3. Stale vector generations are not queryable.
4. Citation coverage remains at or above current local retrieval baseline.

Status:

1. Vector-backed retrieval is implemented in `src/lib/vector/vector-retrieval.ts`.
2. It embeds the query, queries only the authenticated firm's Pinecone namespace, loads canonical chunk text from Postgres, and discards stale/unknown/corrupt matches.
3. It keeps Pinecone metadata allowlisted and does not trust Pinecone for answer text or citations.
4. Offline verification is implemented in `scripts/verify-vector-retrieval.js` and included in `npm run verify:m3-quality`.
5. Runtime chat still uses the local retrieval fallback until we explicitly switch the chat route behind a controlled flag.
6. Chat route now supports vector retrieval behind `ENABLE_VECTOR_RETRIEVAL=false` by default.
7. If vector retrieval fails, chat logs the failure and falls back to the existing local retrieval path.

Verified:

```bash
npm run verify:vector-retrieval
npm run verify:chat-api
npx tsc --noEmit
npm run build
npm run verify:m3-quality
```

## Phase 4 - Streaming Chat API

Goal: upgrade `/api/chat` from JSON fallback to AI SDK streaming while preserving current security guarantees.

Steps:

1. Add an AI provider wrapper in `src/lib/ai/chat-provider.ts`.
2. Keep all auth, firm scoping, thread ownership, document filter validation, and rate limiting server-side.
3. Convert persisted thread history into AI SDK UI/model messages server-side.
4. Retrieve context before model call.
5. Build a strict grounded system prompt:
   - answer only from retrieved evidence
   - cite relevant evidence
   - if evidence is weak, say there is not enough evidence
6. Stream via Vercel AI SDK `streamText`.
7. Persist user message before streaming.
8. Persist assistant message after stream completion.
9. Construct citation payloads server-side from retrieved chunks.
10. Ensure logs contain counts/status only, not prompts, answers, chunks, or snippets.
11. Keep `ENABLE_AI_CHAT=false` until local and staging gates pass.

Verification:

```bash
node scripts/verify-chat-api-boundary.js
node scripts/verify-chat-persistence.js
node scripts/verify-chat-hardening.js
node scripts/verify-streaming-chat-api.js
npm run verify:m3-quality
npx tsc --noEmit
npm run build
```

Exit criteria:

1. Chat streams responses.
2. Supported questions cite evidence.
3. Unsupported questions do not hallucinate grounded tax facts.
4. Server-produced citations match retrieved chunks.
5. Cross-firm documents cannot be selected, retrieved, cited, or inferred.

## Phase 5 - assistant-ui Dashboard Chat

Goal: replace the current custom/basic chat surface with a production-grade chat UI.

Steps:

1. Create assistant-ui runtime provider connected to `/api/chat`.
2. Pass selected document filters as request metadata/body, not as trusted auth context.
3. Preserve the existing authenticated dashboard route.
4. Add document selection controls:
   - all firm documents
   - specific completed documents
   - clear selected document context display
5. Add UI states:
   - empty state
   - streaming state
   - retry state
   - recoverable error state
   - insufficient evidence state
6. Render citations under assistant answers:
   - document name
   - page span
   - snippet
   - chunk/source IDs collapsed by default for readability
7. Ensure no cross-firm documents appear in the selector.

Verification:

```bash
npx tsc --noEmit
npm run build
```

Staging browser checks:

1. Login as Acme firm user.
2. Upload sample PDF.
3. Wait for Textract completion.
4. Ask a supported question.
5. Confirm streamed answer and visible citations.
6. Ask unsupported question.
7. Confirm insufficient-evidence behavior.
8. Login as another firm user.
9. Confirm Acme documents and threads are not visible.

Exit criteria:

1. Authenticated users can ask questions against their own completed documents.
2. Citations are visible and understandable.
3. Streaming failures are recoverable.
4. UI does not expose other firms' documents or chat threads.

## Phase 6 - Staging Acceptance And Evidence Package

Goal: produce client-safe proof before asking for M3 acceptance.

Steps:

1. Run local verification suite.
2. Deploy to staging with feature flags off.
3. Run fallback health and document smoke.
4. Enable vector indexing for sample documents only.
5. Run vector indexing smoke.
6. Enable AI chat for sample/redacted data only.
7. Run streaming chat smoke.
8. Run cross-tenant negative tests.
9. Run UI acceptance checks.
10. Save sanitized evidence:
   - image tag
   - ECR scan summary
   - staging URL
   - sample PDF IDs
   - retrieval/citation counts
   - no raw tax data

Exit criteria:

1. Local checks pass.
2. Staging checks pass.
3. No critical/high image scan findings.
4. No sensitive data in logs.
5. Evidence package is safe to share.

## Recommended Immediate Next Action

Start with **Phase 0** and **Phase 1**:

1. Ask the client for OpenAI and Pinecone approval/credentials if full M3 is expected now.
2. In parallel, run the package compatibility spike locally with assistant-ui and Vercel AI SDK.
3. Do not start broad UI refactoring until the streaming route/package compatibility is proven.
