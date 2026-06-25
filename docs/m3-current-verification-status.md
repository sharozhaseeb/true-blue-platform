# M3 Current Verification Status

Updated: 2026-05-27

## Scope Source

Primary criteria are in:

- `../docs/True_Blue_Phase1_Scope_of_Work.md`
- `docs/m3-production-ai-structured-document-plan.md`
- `docs/m3-operational-runbook.md`
- `docs/m3-aws-phase7-staging-preflight.md`
- `docs/m3-next-steps-execution-plan.md`

## Current Staging State

| Area | Status | Evidence |
| --- | --- | --- |
| AWS staging host | Passed | EC2 `i-0a34ef089984569b6`, public URL `http://52.70.0.80`, SSM online |
| Runtime size | Acceptable for staging | `t3.small`, about 1.1 GiB memory available, 4 GiB swap mostly unused |
| Images | Passed | App image `chat-citation-20260527-1903` deployed; migrate/worker unchanged from latest prior promotion |
| Image scan | Passed with residual note | ECR scan: 0 critical, 0 high, 1 medium on each image |
| App health | Passed | app, db, nginx healthy; worker running |
| Fallback M2 upload path | Passed | login, document upload, detail read, delete, and S3 cleanup verified |
| Live Textract path | Passed for sample PDF | upload -> Textract job -> SNS/SQS -> worker -> normalized artifact -> completed document |
| Structured retrieval chunks | Passed | Textract-backed sample created M3 retrieval chunks |
| Chat retrieval | Passed for sample PDF | `/api/chat` streams AI SDK responses with citations only when the final answer references valid source markers |
| Retrieval warnings | Passed after patch | warning count is `0` on latest sample smoke |
| Local M3 quality gates | Passed | `npm run verify:m3-quality` |
| TypeScript | Passed | `npx tsc --noEmit` |
| Production build | Passed | `npm run build` |
| Targeted M3 lint | Passed | Targeted ESLint over M3 chat/vector/Textract files |
| OpenAI embedding provider | Passed locally | live synthetic smoke returned one `text-embedding-3-small` vector with dimension `1536` |
| Pinecone vector provider | Passed locally | live synthetic smoke upserted, queried, and deleted one synthetic vector |
| Vector indexing orchestration | Passed locally | `npm run verify:vector-indexing` |
| Vector retrieval orchestration | Passed locally | `npm run verify:vector-retrieval` |
| AI SDK streaming route | Passed locally | `npm run verify:chat-streaming`; includes stale citation and orphan-marker regression checks |
| assistant-ui dashboard integration | Passed locally | TypeScript/build/targeted lint |

## 2026-05-26 M3 AI Staging Promotion

Release tag: `m3-ai-20260526-114138`

Images promoted to ECR:

- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app:m3-ai-20260526-114138`
- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-migrate:m3-ai-20260526-114138`
- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-worker:m3-ai-20260526-114138`

Deployment notes:

- Built locally with Docker and pushed to ECR.
- ECR scan result: `0` critical, `0` high, `1` medium per image.
- Staging path: `/opt/trueblue`.
- Backup timestamp: `20260526-070147`.
- DB backup: `/opt/trueblue/backups/db-backup-pre-m3-ai-20260526-070147.sql.gz`.
- Previous `.env` and `docker-compose.prod.yml` were backed up with the same timestamp.
- Temporary SSM SecureString parameters and temporary IAM read policy used for provider secret transfer were removed after deployment.
- Nginx required a forced recreate after app replacement because it had cached the previous app container IP; after recreate, `GET /` and `GET /login` returned `200`, and nginx health is `healthy`.

Staging smoke after deployment:

- Uploaded `2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf`.
- Document ID: `cmpmb2rvy0003k03kz3c1lnun`.
- Result: `COMPLETED`.
- Pages: `52`.
- Retrieval chunks: `238`.
- Vector inventory: active generation present.
- Supported chat question streamed successfully with `text/event-stream`.
- Citation metadata includes source filename and page range.
- Cross-firm document detail access returned `404`.
- Cross-firm chat with another firm's document returned `400`.
- `/dashboard/chat` returned `200`.

Residual product note:

- This historical residual was resolved by `chat-citation-20260527-1903`: unsupported questions now produce an insufficient-information answer without public citations. Retrieved chunks remain internal evidence candidates and are not displayed unless the final answer uses valid source markers.

## 2026-05-27 Client-Owned Pinecone Rotation

Client Pinecone setup:

- Client-provided Pinecone API key was validated.
- The client Pinecone project initially had no indexes.
- Created client-owned Pinecone serverless index `trueblue-m3-staging`.
- Index config: AWS `us-east-1`, dimension `1536`, metric `cosine`.
- Local live provider smoke passed against the client-owned index.

Remote rotation:

- Rotated `/opt/trueblue/.env` to the client-owned Pinecone key and host.
- Active remote index host prefix: `trueblue-m3-staging-1vwzcud`.
- Backup created: `.env.backup-pre-client-pinecone-20260527-055239`.
- Restarted app, worker, and nginx.
- App and nginx health: `healthy`; worker running.
- Temporary SSM SecureString parameters and temporary IAM read policy used for secret transfer were removed after rotation.

Post-rotation stakeholder smoke:

- Uploaded `2025 Tax Return Documents (Whittaker Jordan).pdf`.
- Document ID: `cmpnngfdc0003rzbigyhovwsi`.
- Result: `COMPLETED`.
- Pages: `25`.
- Retrieval chunks: `115`.
- Vector inventory: active generation present.
- Supported chat question streamed successfully with `text/event-stream`.
- Answer examples:
  - Taxpayer name: `Jordan Whittaker`.
  - Wages/total income: `$27,645`.
- Citation metadata includes source filename and page range.
- Unsupported question returned insufficient-information answer.
- Cross-firm document detail access returned `404`.
- Cross-firm chat with another firm's document returned `400`.
- `/dashboard/chat` returned `200`.

## 2026-05-27 Chat UX Staging Promotion

Release tag: `chat-ux-20260527-1248`

Images promoted to ECR:

- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app:chat-ux-20260527-1248`
- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-migrate:chat-ux-20260527-1248`
- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-worker:chat-ux-20260527-1248`

Deployment notes:

- App, migrate, and worker images were built locally and pushed to ECR.
- Staging `.env` now points to the `chat-ux-20260527-1248` image triplet.
- DB backup: `/opt/trueblue/backups/db-backup-pre-chat-ux-20260527-083250.sql.gz`.
- Previous `.env` backups:
  - `/opt/trueblue/backups/.env.pre-chat-ux-20260527-083250`
  - `/opt/trueblue/backups/.env.pre-chat-ux-retry-20260527-083329`
- Previous `docker-compose.prod.yml` backups:
  - `/opt/trueblue/backups/docker-compose.prod.pre-chat-ux-20260527-083250.yml`
  - `/opt/trueblue/backups/docker-compose.prod.pre-chat-ux-retry-20260527-083329.yml`
- First deploy attempt stopped before container replacement because the staging host Docker ECR token had expired; retry reauthenticated to ECR and completed.
- App and nginx health: `healthy`; worker running.
- ECR scan result: `0` critical, `0` high, `1` medium, `3` undefined per image.

Staging smoke after deployment:

- `GET /dashboard/chat` returned `200`.
- Browser verification confirmed the new History rail and Sources panel render.
- Browser verification confirmed a restored chat displays locked source scope.
- Browser verification confirmed citations are collapsed by default and expand to filename, page, and snippet.
- `GET /api/chat/threads?limit=5` returned `200`.
- `GET /api/chat/threads/:id` returned persisted messages and citation data for an owned thread.
- Cross-firm `GET /api/chat/threads/:id` returned `404`.
- Other-firm thread list returned `200` with no Acme threads.
- Supported chat question streamed successfully with `text/event-stream` and created a new thread in history.

## 2026-05-27 Chat Delete Controls Staging Promotion

Release tag: `chat-delete-20260527-1406`

Images promoted to ECR:

- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app:chat-delete-20260527-1406`
- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-migrate:chat-delete-20260527-1406`
- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-worker:chat-delete-20260527-1406`

Deployment notes:

- Local verification before deployment: `npx tsc --noEmit`, targeted ESLint, `npm run build`, `npm run verify:chat-persistence`, `npm run verify:chat-api`, `npm run verify:chat-streaming`, and `npm run verify:chat-hardening`.
- Added soft-delete support for owned chat threads through `DELETE /api/chat/threads/:id`.
- Added deployed UI controls for deleting chats from the History rail and source files from the Sources panel.
- Source-file deletion uses the existing document deletion API, preserving backend tenant checks, owner/admin permission checks, vector cleanup, artifact cleanup, and S3 cleanup.
- First deploy attempt stopped before image pull/container replacement because the remote env-update script did not export image variables into the Python update step.
- Retry pulled the new images, ran migrations successfully, and replaced app and worker.
- Nginx required forced recreation after app replacement; after recreate, app and nginx were healthy and worker was running.
- ECR scan result: `0` critical, `0` high, `1` medium, `3` undefined per image.
- DB backups:
  - `/opt/trueblue/backups/db-backup-pre-chat-delete-20260527-1406-20260527-091837.sql.gz`
  - `/opt/trueblue/backups/db-backup-pre-chat-delete-20260527-1406-retry-20260527-091928.sql.gz`

Staging smoke after deployment:

- `GET /` and `GET /login` returned `200`.
- Browser verification confirmed chat history delete buttons render in the History rail.
- Browser verification confirmed source-file delete buttons render in the Sources panel for the firm admin.
- Temporary chat smoke created a new chat thread, deleted it with `DELETE /api/chat/threads/:id`, confirmed the deleted thread returned `404`, and confirmed it no longer appeared in the thread list.
- Source-file delete button was not clicked during browser smoke to avoid deleting real staging documents.

## 2026-05-27 Chat Citation Semantics Staging Promotion

Release tag: `chat-citation-20260527-1903`

Image promoted to ECR:

- `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app:chat-citation-20260527-1903`

Deployment notes:

- App-only promotion; migrate and Textract worker images were unchanged because this patch only affects web/API chat behavior.
- First local ECR push hit a TLS handshake timeout after build; retrying `docker push` for the already-built image succeeded.
- First SSM deploy attempt failed before sending because PowerShell quoting produced invalid AWS CLI JSON.
- Second SSM deploy attempt reached the server but failed before `.env` write due heredoc quoting.
- Final SSM deploy used a simpler `sed`-based `.env` update and completed successfully.
- App and nginx health: `healthy`; worker remained running.

Local verification before deployment:

- `npx tsc --noEmit --pretty false`
- Targeted ESLint over chat route, chat thread route, dashboard chat UI, chat contract, public-output sanitizer, and chat verification scripts
- `npm run build`
- `npm run verify:chat-api`
- `npm run verify:chat-streaming`
- `npm run verify:chat-persistence`
- `npm run verify:chat-hardening`
- Critic pass reported no blocker/high issue remaining before staging deployment.

Staging acceptance pass after deployment:

- `GET /` and `GET /login` returned `200`.
- Supported taxpayer-name question returned `Jordan Whittaker` with citation.
- Supported wages/total-income question returned `$27,645` with citation page metadata.
- Unsupported spacecraft question returned canonical insufficient-information text with no public citations and no orphan source markers.
- Greeting `hi` returned guidance with no public citations.
- Cross-firm document access returned `404`.
- Best Tax thread list did not expose the Acme chat thread.
- Chat history listed newly created chats and reopened supported messages with citation data.
- Temporary chat deletion returned `204`; reopening deleted chat returned `404`.
- Disposable duplicate source upload completed processing; source deletion returned `204`; deleted source detail returned `404`.
- Browser verification confirmed `/dashboard/chat` renders History, Document Q&A, and Sources panels.
- Browser verification confirmed greeting response does not render `Sources used`.
- Browser verification confirmed supported answer renders collapsed `Sources used: 1`, expanding to filename, page, and snippet.

## 2026-05-23 Public Staging Smoke

Historical pre-promotion result before the `m3-ai-20260526-114138` deployment. The public staging URL at `http://52.70.0.80` was reachable over HTTP and accepted the seeded firm admin login. A representative sample tax PDF was uploaded through the public API and processed successfully:

- Document: `2025 Tax Return Documents (Jimenez Julio).pdf`
- Document ID: `cmpiapf2l000tmzgfpy79jh20`
- Result: `COMPLETED`
- Pages: `22`
- Processing time: about `25s`

Chat/retrieval smoke against that processed sample returned citations for supported tax-return questions, including taxpayer name and total wages. At that time, the public staging runtime still responded in `local_retrieval_fallback` mode, not the latest OpenAI streaming implementation verified locally.

Observed public-staging anomalies:

- Unsupported-question handling is too permissive on the deployed runtime; an unrelated question still returned retrieved snippets instead of an insufficient-evidence response.
- Citation response objects on the deployed runtime omit user-facing `filename` and `pageNumber` fields even though chunk IDs are present.
- These anomalies were resolved by deploying the latest AI streaming/vector-enabled build on 2026-05-26.

Historical deployment access note:

- The latest build was prepared and verified locally, but deployment to the active public staging host was blocked because AWS temporary credentials returned `ExpiredToken`, and SSH access to `52.70.0.80` was not available from this workstation.
- SSH access is available to the older `54.208.102.72` host, but that host is not confirmed as the active M3 stakeholder target and should not be switched without confirmation.

## Criteria Mapping

| M3 criterion | Current status | Notes |
| --- | --- | --- |
| BaseDocument normalization is deterministic and provenance-backed | Passed locally | Covered by normalizer and M3 quality gates |
| Local artifact source can feed retrieval without Textract response coupling | Passed locally | Downstream uses `BaseDocument` contract |
| Textract worker completes live jobs into the same BaseDocument contract | Passed on staging | Verified with sample PDF |
| Missed/duplicate SQS messages do not corrupt state | Covered locally | `verify:textract-pipeline` covers duplicate/terminal safety; staging duplicate replay not yet run |
| Retrieval has citation coverage and no cross-tenant leakage | Passed locally and staging smoke | Cross-firm document detail returned `404`; cross-firm chat returned `400` |
| Chat answers include citations when evidence exists | Passed locally and staging sample | Server-built citations are persisted and streamed |
| Unsupported questions avoid grounded hallucinations | Passed locally and staging smoke | Final answer states insufficient information and no public citations are exposed |
| Authenticated users can ask questions against own documents | Passed on staging sample | `/dashboard/chat` and `/api/chat` reachable |
| Citations visible and understandable in UI | Passed | Browser review confirmed collapsed `Sources used` expands to filename, page, and snippet |
| Chat streams responses | Passed on staging | `POST /api/chat` returns `text/event-stream` |
| Pinecone vectors created for completed base artifacts | Passed on staging | Fresh 52-page sample has active vector inventory and 238 retrieval chunks |
| Cross-tenant vector namespace isolation | Passed locally and staging smoke | Namespaces are firm-derived; cross-firm document filter rejected |
| Deleted documents are not retrievable from vector store | Passed locally and staging smoke | Disposable source upload/process/delete lifecycle returned deleted source detail as `404` |
| Production rollback/reprocess path documented | Partial | AWS deployment path documented; Textract/vector reprocess commands still need operator-level detail |

## Verified Commands

Local:

```bash
npx tsc --noEmit
npm run verify:textract-pipeline
npm run verify:vector-provider
npm run verify:vector-indexing
npm run verify:vector-retrieval
npm run verify:live-vector-providers
npm run verify:m3-quality
npm run build
npx eslint src/app/api/chat/route.ts "src/app/(dashboard)/dashboard/chat/page.tsx" "src/app/api/documents/[id]/route.ts" scripts/verify-chat-api-boundary.js scripts/verify-chat-streaming-contract.js scripts/verify-textract-pipeline.js scripts/verify-vector-indexing.js scripts/verify-vector-retrieval.js
```

Staging:

```text
GET / -> 200
GET /login -> 200
POST /api/auth/login -> 200
POST /api/documents/upload -> PROCESSING with providerJobId
GET /api/documents/:id -> COMPLETED after worker processing
POST /api/chat -> 200 text/event-stream with citations
GET /dashboard/chat -> 200
Cross-firm GET /api/documents/:id -> 404
Cross-firm POST /api/chat with another firm's document -> 400
```

## Current Gaps Before Stakeholder Handover

1. Client-owned OpenAI credentials are now being used for stakeholder testing.
2. Add operator-level rollback/reprocess commands for Textract artifacts and vector generations before treating this as production runbook complete.
3. Repo-wide `npm run lint` still has unrelated legacy findings outside the M3-touched files; targeted M3 lint passes.

Use `docs/m3-next-steps-execution-plan.md` for the implementation sequence.

## Professional Recommendation

The M3 implementation is deployed to staging and ready for stakeholder sample-data review: vector DB integration, embeddings, tenant namespaces, RAG retrieval, OpenAI-backed streaming chat, source-grounding prompts, citations, insufficient-context behavior, and retrieval thresholds are implemented and verified. Pinecone and OpenAI are client-owned for current stakeholder testing. Do not use non-synthetic client data until the client approves provider processing and HTTP/TLS handling for the environment.
