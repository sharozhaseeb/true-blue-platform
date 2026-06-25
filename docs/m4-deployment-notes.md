# M4 Deployment Notes

## Environment

M4 depends on the baseline application deployment environment plus the chat/retrieval variables below. Use `.env.staging.example` as the source of truth for required staging keys, then verify the real `.env.staging` before handoff.

Baseline app/deployment variables:

- `APP_IMAGE`
- `WORKER_IMAGE`
- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `NEXT_PUBLIC_APP_URL`
- `AWS_REGION`
- `AWS_S3_BUCKET`
- `AWS_S3_KMS_KEY_ID`
- `UPLOAD_MAX_FILE_SIZE`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_MS`

Textract/OCR worker variables, required when the worker service is deployed:

- `TEXTRACT_RESULTS_BUCKET`
- `TEXTRACT_SNS_TOPIC_ARN`
- `TEXTRACT_SQS_QUEUE_URL`
- `TEXTRACT_NOTIFICATION_ROLE_ARN`
- `ENABLE_TEXTRACT_PIPELINE`
- `TEXTRACT_ADAPTER_ID`
- `TEXTRACT_ADAPTER_VERSION`

M4 chat and retrieval variables:

- `ENABLE_AI_CHAT`
- `ENABLE_VECTOR_RETRIEVAL`
- `ENABLE_VECTOR_INDEXING`
- `OPENAI_API_KEY`
- `AI_MODEL`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSION`
- `VECTOR_MIN_SCORE`
- `PINECONE_API_KEY`
- `PINECONE_INDEX_NAME`
- `PINECONE_INDEX_HOST`
- `PINECONE_NAMESPACE_PREFIX`

The database migration adds `chat_threads."outputTemplate"` as nullable JSONB. Existing rows with `null` replay as `rag_qa.default.v1`.

Preflight the staging env before redeploying:

```powershell
docker compose --env-file .env.staging -f docker-compose.prod.yml config --quiet
npx prisma validate
```

If `ENABLE_VECTOR_RETRIEVAL=true`, the staging E2E evidence must prove vector retrieval. A fallback response with `output.support.retrievalMode = "local_retrieval_fallback"` does not satisfy the vector E2E gate.

If the M4 endpoint is HTTP-only, use only non-sensitive sample PDFs. Real client tax documents require HTTPS/TLS and data-handling approval.

## Local Validation

Run from `true-blue-platform`:

```powershell
npm run verify:chat-output
npm run verify:m4-structured-output
npm run verify:m4-quality
npm run verify:m3-quality
npx prisma validate
npm run build
```

Useful regression gates:

```powershell
npm run verify:chat-api
npm run verify:chat-streaming
npm run verify:chat-hardening
npm run verify:vector-retrieval
npm run verify:m3-quality
```

## Staging E2E Evidence

Run against a deployed staging host with a real authenticated session:

```powershell
.\scripts\run-m4-e2e-staging.ps1 `
  -BaseUrl "<canonical M4 URL>" `
  -CookieFile ".\cookies.txt" `
  -PdfPath "..\client_shared_pdfs\2025 Tax Return Documents (Whittaker Jordan).pdf" `
  -OutputPath ".\m4-e2e-report.json"
```

Use `-BearerToken` instead of `-CookieFile` when staging auth provides a test token.
Create `cookies.txt` first by logging in through the API or browser-exported cookie workflow described in `m4-acceptance-testing.md`.

When vector retrieval is enabled, pass `-ExpectVectorRetrieval`. The script reads `/api/internal/m4/vector-index-status?documentId=...` to prove active vector readiness without exposing vectors, embeddings, prompts, source text, snippets, or secrets. If an older deployment does not include that endpoint, attach DB-side evidence from `document_vector_indexes` showing an active index, namespace, generation, chunk count, vector ID count, embedding model/dimension, parser version, chunk strategy, and `isActive`.

## Manual Smoke

1. Log in as a firm user.
2. Upload a text-based PDF.
3. Wait until the document status is `COMPLETED`.
4. Ask a question answerable from that PDF.
5. Confirm the response has citations and `output.schemaVersion = "trueblue.chat.output.v1"`.
6. Ask an unsupported question.
7. Confirm `output.status = "insufficient_evidence"` and `output.sources = []`.
8. Reload the thread.
9. Confirm assistant history includes `data-output`.
