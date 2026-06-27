# M4 Deployment Notes

## AWS Target For M4

Use the AWS CLI profile `trueblue-m4` for M4 deployment work.

- Account: `536573256060`
- Region: `us-east-1`
- Staging instance: `i-0a34ef089984569b6`
- Current public host: `52.70.0.80`
- SSM status: online
- Instance profile: `TrueBlueStagingAppWorkerInstanceProfile`

Do not use the default AWS profile or the older local `trueblue` profile for M4 unless `aws sts get-caller-identity` confirms account `536573256060`. Those profiles have previously resolved to non-M4 accounts. If the access key starts with `ASIA`, it is a temporary STS key and `aws_session_token` is required.

Verify the target before any deploy action:

```powershell
aws sts get-caller-identity --profile trueblue-m4 --query Account --output text
aws ssm describe-instance-information --profile trueblue-m4 --region us-east-1
```

M4 AWS resources already present in account `536573256060`:

- App image repo: `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app`
- Migration image repo: `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-migrate`
- Worker image repo: `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-worker`
- Upload bucket: `trueblue-documents-536573256060-staging`
- Textract artifact bucket: `trueblue-document-artifacts-536573256060-staging`
- KMS key alias: `alias/trueblue-staging-documents`
- KMS key ARN: `arn:aws:kms:us-east-1:536573256060:key/8e4eec90-60cc-4e55-a7a8-dc9dc81b5958`
- Textract SNS topic: `arn:aws:sns:us-east-1:536573256060:trueblue-textract-complete-staging`
- Textract SQS queue: `https://queue.amazonaws.com/536573256060/trueblue-textract-jobs-staging`
- Textract publish role: `arn:aws:iam::536573256060:role/TrueBlueTextractPublishRole-staging`

## Environment

M4 depends on the baseline application deployment environment plus the chat/retrieval variables below. Use `.env.staging.example` as the source of truth for required staging keys, then verify the real `.env.staging` before handoff.

Baseline app/deployment variables:

- `APP_IMAGE`
- `MIGRATE_IMAGE`
- `WORKER_IMAGE`
- `DATABASE_URL`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `JWT_ACCESS_EXPIRY`
- `JWT_REFRESH_EXPIRY`
- `NEXT_PUBLIC_APP_URL`
- `USE_SECURE_COOKIES`
- `ENABLE_TEST_ENDPOINTS`
- `AWS_REGION`
- `AWS_S3_BUCKET`
- `AWS_S3_KMS_KEY_ID`

Textract/OCR worker variables, required when the worker service is deployed:

- `TEXTRACT_RESULTS_BUCKET`
- `TEXTRACT_SNS_TOPIC_ARN`
- `TEXTRACT_SQS_QUEUE_URL`
- `TEXTRACT_NOTIFICATION_ROLE_ARN`
- `ENABLE_TEXTRACT_PIPELINE`
- `ENABLE_BASE_DOCUMENT_DEBUG_API`

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
npm run verify:m4-deploy
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
npm run verify:m4-deploy
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
Create `cookies.txt` first by logging in through the API or browser-exported cookie workflow described in `m4-acceptance-testing.md` (client UAT now lives in `m4-client-acceptance-testing.md`).

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
