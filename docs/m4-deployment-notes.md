# M4 Deployment Notes — Staging Runbook

Self-sufficient procedure to deploy or redeploy the current M4 build (AI chat + vector
retrieval + retrieval reranking) to the staging EC2 host. Follow the sections in order.
Everything required is here; `docs/deployment-guide.md` and `docs/staging-notes.md` are
the original references but are **not** needed to complete a deploy with this document.

What M4 ships on top of the baseline app: AI chat (`gpt-4o-mini`), Pinecone vector
indexing + retrieval, and a new **retrieval reranking** stage (Pinecone-hosted
`bge-reranker-v2-m3`). The DB change is one additive nullable column.

---

## 0. AWS Target For M4

Use the AWS CLI profile `trueblue-m4` for all M4 AWS/ECR/SSM commands.

- Account: `536573256060`
- Region: `us-east-1`
- Staging instance: `i-0a34ef089984569b6`
- Current public host: `52.70.0.80`
- SSM status: online
- Instance profile: `TrueBlueStagingAppWorkerInstanceProfile`
- App dir on the host: `/opt/trueblue` (holds `docker-compose.prod.yml` + `.env`)

Do not use the default AWS profile or the older local `trueblue` profile for M4 unless
`aws sts get-caller-identity` confirms account `536573256060`. Those profiles have
previously resolved to non-M4 accounts. If the access key starts with `ASIA`, it is a
temporary STS key and `aws_session_token` is required.

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

---

## 1. Prerequisites

Confirm all of these before touching the host:

- **AWS access** — profile `trueblue-m4` configured and resolving to account
  `536573256060`. Verify the target and that the instance is reachable by SSM:

  ```powershell
  aws sts get-caller-identity --profile trueblue-m4 --query Account --output text   # -> 536573256060
  aws ssm describe-instance-information --profile trueblue-m4 --region us-east-1 `
    --query "InstanceInformationList[?InstanceId=='i-0a34ef089984569b6'].PingStatus" --output text   # -> Online
  ```

- **Host access** — one of:
  - **SSM (primary for M4)**: the AWS CLI Session Manager plugin installed, plus
    `ssm:SendCommand` / `ssm:StartSession` on the instance. No SSH key or open port 22
    needed. This is the path the bundled `.ssm-params-*.json` files use.
  - **SSH (alternative)**: an SSH key whose source IP is allowlisted in the instance
    security group (`ssh ec2-user@52.70.0.80`). On-box commands are identical to the SSM
    path once you are at `/opt/trueblue`.

- **Local tooling** — AWS CLI v2, Docker + buildx (to build/push images for
  `linux/amd64`), and Node 20 / npm (to run the `verify:*` gates and the staging E2E
  script). PowerShell for `run-m4-e2e-staging.ps1`.

- **Service credentials, ready to paste** (all are secrets — never commit):
  - **OpenAI** API key with access to `gpt-4o-mini` + `text-embedding-3-small`.
  - **Pinecone** API key, index name, and index host. **Pinecone Inference must be
    enabled on the account** — the reranker calls `pc.inference.rerank(...)`; without it
    reranking falls back to raw vector order (see §2).

- **Deploy target / release** — instance `i-0a34ef089984569b6` (`52.70.0.80`), and the
  **release tag** you intend to ship (e.g. `m4-<date>-<shortsha>`). The previous/current
  tag is recorded in `.deploy-current-tag.txt` / `.deploy-latest-prod-tag.txt` and inside
  `/opt/trueblue/.env` (`APP_IMAGE`/`MIGRATE_IMAGE`/`WORKER_IMAGE`) — capture it now so
  rollback (§7) is trivial.

> TLS: the M4 readiness gate (`npm run verify:m4-deploy`) **requires** an `https://`
> `NEXT_PUBLIC_APP_URL` and `USE_SECURE_COOKIES=true`. If the endpoint is still HTTP-only,
> restrict testing to non-sensitive sample PDFs — real client tax documents require
> HTTPS/TLS and data-handling approval.

---

## 2. Environment Variables

`.env.staging.example` is the source of truth. Locally, copy it to `.env.staging`, fill in
secrets, and run the gates (§ below). On the **host**, the same inventory lives in
`/opt/trueblue/.env`, which `docker compose` auto-loads from that directory.

```powershell
# local, from true-blue-platform/
cp .env.staging.example .env.staging   # then edit: no SET_* / change-me / example.com placeholders may remain
```

Complete required inventory (defaults shown are the compose/code defaults; **SECRET** =
fill with a real value, never leave a placeholder):

| Variable | Value / default | Notes |
|---|---|---|
| `APP_IMAGE` | ECR app image:tag | set to the release tag you ship (§3) |
| `MIGRATE_IMAGE` | ECR migrate image:tag | same tag |
| `WORKER_IMAGE` | ECR worker image:tag | same tag |
| `DATABASE_URL` | `postgresql://<user>:<pw>@db:5432/<db>?schema=public` | password must equal `POSTGRES_PASSWORD` |
| `POSTGRES_USER` | e.g. `trueblue` | |
| `POSTGRES_PASSWORD` | **SECRET** | must match the password in `DATABASE_URL` |
| `POSTGRES_DB` | e.g. `trueblue` | |
| `JWT_ACCESS_SECRET` | **SECRET**, ≥ 32 chars | gate fails if shorter |
| `JWT_REFRESH_SECRET` | **SECRET**, ≥ 32 chars | gate fails if shorter |
| `JWT_ACCESS_EXPIRY` | `900` | seconds |
| `JWT_REFRESH_EXPIRY` | `604800` | seconds |
| `NEXT_PUBLIC_APP_URL` | `https://<staging host>` | **must be HTTPS** for the gate |
| `NODE_ENV` | `production` | |
| `USE_SECURE_COOKIES` | `true` | gate fails if not `true` |
| `ENABLE_TEST_ENDPOINTS` | `false` | gate fails if not `false` |
| `AWS_REGION` | `us-east-1` | |
| `AWS_S3_BUCKET` | `trueblue-documents-536573256060-staging` | gate fails if it looks like prod |
| `AWS_S3_KMS_KEY_ID` | KMS ARN (see §0) | must start `arn:aws:kms:` |
| `AWS_TEXTRACT_REGION` | `us-east-1` | |
| `TEXTRACT_FEATURE_SET` | `FORMS,TABLES,LAYOUT` | |
| `TEXTRACT_RESULTS_BUCKET` | `trueblue-document-artifacts-536573256060-staging` | |
| `TEXTRACT_SNS_TOPIC_ARN` | SNS ARN (see §0) | must start `arn:aws:sns:` |
| `TEXTRACT_SQS_QUEUE_URL` | SQS HTTPS URL (see §0) | must start `https://` |
| `TEXTRACT_NOTIFICATION_ROLE_ARN` | IAM role ARN (see §0) | must start `arn:aws:iam::` |
| `ENABLE_TEXTRACT_PIPELINE` | `true` | OCR pipeline for scanned/image PDFs |
| `ENABLE_BASE_DOCUMENT_DEBUG_API` | `false` | keep off for client-facing |
| `OPENAI_API_KEY` | **SECRET** | required when chat/vector flags are on |
| `AI_MODEL` | `gpt-4o-mini` | **current model** |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | |
| `EMBEDDING_DIMENSION` | `1536` | numeric |
| `ENABLE_AI_CHAT` | `true` | gate requires `true` |
| `ENABLE_VECTOR_INDEXING` | `true` | gate requires `true` |
| `ENABLE_VECTOR_RETRIEVAL` | `true` | gate requires `true`; drives the vector E2E gate |
| `VECTOR_MIN_SCORE` | `0.25` | cosine floor applied before rerank |
| `PINECONE_API_KEY` | **SECRET** | reused by the reranker (no new key) |
| `PINECONE_INDEX_NAME` | **SECRET/config** | |
| `PINECONE_INDEX_HOST` | **SECRET/config** | |
| `PINECONE_NAMESPACE_PREFIX` | `trueblue` | |
| `ENABLE_RERANK` | `true` (**ships ON**) | set `=false` to A/B raw vector order — see below |
| `RERANK_MODEL` | `bge-reranker-v2-m3` | optional; free, Pinecone-hosted |
| `CHAT_USER_RATE_LIMIT_PER_MINUTE` | `60` | numeric |
| `CHAT_FIRM_RATE_LIMIT_PER_MINUTE` | `300` | numeric |

### Retrieval reranking (new in this build)

- **`ENABLE_RERANK`** — default **`true`**, so reranking **ships ON**. Set
  `ENABLE_RERANK=false` only to A/B the raw vector order (degraded precision). The
  reranker re-orders the retrieved candidates (top-30 → top-8) for higher precision.
- **`RERANK_MODEL`** — optional, default `bge-reranker-v2-m3` (free, Pinecone-hosted
  cross-encoder).
- Reranking **reuses the existing `PINECONE_API_KEY`** — no new key, no new vendor — and
  requires **Pinecone Inference enabled** on the account. If the rerank call fails it
  **falls back gracefully** to vector-score order and adds a warning; it **never fails the
  request**.

> Wiring note: `docker-compose.prod.yml` (app service) maps `ENABLE_RERANK` and
> `RERANK_MODEL` into the container with defaults `true` / `bge-reranker-v2-m3`. If you
> redeploy onto a host whose `/opt/trueblue/docker-compose.prod.yml` predates this build,
> copy the updated compose file too, otherwise an `ENABLE_RERANK=false` override in `.env`
> will not reach the app (it would stay ON via the code default).

### Preflight the env before deploying

```powershell
# from true-blue-platform/
npm run verify:m4-deploy                                                  # validates .env.staging keys/values
docker compose --env-file .env.staging -f docker-compose.prod.yml config --quiet
npx prisma validate
```

`verify:m4-deploy` (`scripts/verify-m4-deploy-readiness.js`) fails on missing keys,
leftover placeholders, non-HTTPS app URL, `USE_SECURE_COOKIES != true`,
`ENABLE_TEST_ENDPOINTS != false`, any of the three M4 flags not `true`, short JWT secrets,
a staging file pointing at a prod bucket, and malformed ARNs. It does **not** require the
rerank vars (they default safely).

---

## 3. Dependencies / Build (rebuild + push the image)

This build adds new npm dependencies (`@tanstack/react-table`, `react-dropzone`, `sonner`,
`next-themes`, `tw-animate-css`, shadcn UI). They are **not** installed on the host — they
are baked into the image by `npm ci` during the Docker build. **You must rebuild and push
all three images and redeploy with the new tag**; pulling an old image will not include
these deps.

Build + push (same three `buildx` targets the publish script uses —
`scripts/publish-staging-images.sh`, which builds `--target runner` / `migrate` / `worker`
for `linux/amd64` and `--push`):

```bash
# from true-blue-platform/ — Docker Hub (publish script default namespace: sharozhaseeb)
./scripts/publish-staging-images.sh <release-tag>
# prints the resulting APP_IMAGE / MIGRATE_IMAGE / WORKER_IMAGE refs
```

The M4 staging host pulls from **ECR** (`536573256060.dkr.ecr.us-east-1.amazonaws.com/...`,
see `.deploy-current-images.env` and the `.ssm-params-*` files). To build/push to ECR with
the same targets:

```bash
TAG="<release-tag>"
ECR="536573256060.dkr.ecr.us-east-1.amazonaws.com"
aws ecr get-login-password --region us-east-1 --profile trueblue-m4 \
  | docker login --username AWS --password-stdin "$ECR"

docker buildx build --platform linux/amd64 --target runner  -t "$ECR/true-blue-platform-app:$TAG"     --push .
docker buildx build --platform linux/amd64 --target migrate -t "$ECR/true-blue-platform-migrate:$TAG" --push .
docker buildx build --platform linux/amd64 --target worker  -t "$ECR/true-blue-platform-worker:$TAG"  --push .
```

Set `APP_IMAGE` / `MIGRATE_IMAGE` / `WORKER_IMAGE` in the host `/opt/trueblue/.env` (and
your local `.env.staging`) to the registry+tag you just pushed.

---

## 4. Database Migration

This build adds one migration: **`20260623090000_add_chat_thread_output_template`**.

```sql
ALTER TABLE "chat_threads" ADD COLUMN "outputTemplate" JSONB;   -- nullable
```

It is additive and nullable, so it is backward-compatible — existing rows with `null`
replay as `rag_qa.default.v1`. **Take a DB backup first** anyway, then apply via the
migration image (its entrypoint runs `npx prisma migrate deploy && npx prisma db seed`,
which applies all pending migrations including this one):

```bash
# on the host, in /opt/trueblue (COMPOSE = docker compose -f docker-compose.prod.yml)
mkdir -p backups
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "backups/pre-<release-tag>-$(date +%Y%m%d-%H%M%S).sql.gz"

docker compose -f docker-compose.prod.yml --profile setup run --rm migrate
```

Verify the column exists afterward:

```bash
docker compose -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='chat_threads' AND column_name='outputTemplate';"
# -> outputTemplate
```

---

## 5. Deploy / Redeploy

Two equivalent paths. **Path A (SSM)** matches the bundled `.ssm-params-*.json` artifacts
and needs no SSH. **Path B (SSH + docker-compose)** is the same commands run interactively.

### Path A — SSM (primary)

The bundled `.ssm-params-*.json` files are `AWS-RunShellScript` payloads run on the host
under `/opt/trueblue`. They **hardcode a `RELEASE_TAG` and ECR image refs** (currently an
`m3-*` tag) — edit those lines to your new M4 tag (or regenerate the JSON) before sending.

Bundled payloads:

- `.ssm-params-deploy.json` — full deploy: checks the upload pipeline is idle, takes a
  gzipped `pg_dump` backup under `backups/`, upserts `APP_IMAGE`/`MIGRATE_IMAGE`/
  `WORKER_IMAGE` into `.env`, ECR-logs-in, `pull app migrate textract-worker`, runs the
  migrate profile, `up -d app textract-worker nginx`, waits for app health, and prints
  `ps` + applied-migration verification.
- `.ssm-params-prod-redeploy-latest.json` — redeploy the images **already** in `.env`:
  re-pull, re-run migrate, `up -d --force-recreate app textract-worker nginx`, health wait,
  running-image inspect.
- `.ssm-params-status-check.json` / `.ssm-params-postdeploy.json` — post-deploy
  verification (running images, health, local HTTP, migrations, backups, log tails).
- `.ssm-params-safe-logs.json` / `.ssm-params-logs.json` — log tails only.

Send a payload and capture the command id:

```powershell
$cmd = aws ssm send-command `
  --profile trueblue-m4 --region us-east-1 `
  --instance-ids i-0a34ef089984569b6 `
  --document-name "AWS-RunShellScript" `
  --parameters file://.ssm-params-deploy.json `
  --query "Command.CommandId" --output text
$cmd
```

Poll for completion + output:

```powershell
aws ssm get-command-invocation `
  --profile trueblue-m4 --region us-east-1 `
  --command-id $cmd --instance-id i-0a34ef089984569b6 `
  --query "{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}"
```

Status should reach `Success`; the output ends with `docker compose ps` and the applied
migration list.

### Path B — SSH + docker-compose

```bash
ssh ec2-user@52.70.0.80          # key/IP must be allowlisted in the security group
cd /opt/trueblue
COMPOSE="docker compose -f docker-compose.prod.yml"

# 1. point the image refs at the new tag (edit the three lines), then confirm
vi .env
grep -E '^(APP_IMAGE|MIGRATE_IMAGE|WORKER_IMAGE)=' .env
set -a; . ./.env; set +a

# 2. backup (see §4) then pull the new images
mkdir -p backups
$COMPOSE exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "backups/pre-$(date +%Y%m%d-%H%M%S).sql.gz"
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 536573256060.dkr.ecr.us-east-1.amazonaws.com
$COMPOSE pull app migrate textract-worker

# 3. migrate, then roll the runtime services
$COMPOSE --profile setup run --rm migrate
$COMPOSE up -d app textract-worker nginx

# 4. wait for health
for i in $(seq 1 30); do s=$(docker inspect true-blue-platform-app-1 --format "{{.State.Health.Status}}" 2>/dev/null || echo starting); echo "app_health=$s"; [ "$s" = healthy ] && break; sleep 5; done
$COMPOSE ps
```

> The host's compose file must include the `ENABLE_RERANK`/`RERANK_MODEL` passthrough (§2
> wiring note). If it does not, copy the current `docker-compose.prod.yml` to
> `/opt/trueblue/` before the `up -d` step.

---

## 6. Post-Deploy Validation

### 6.1 Health and basic reachability

```bash
# on host
docker compose -f docker-compose.prod.yml ps
docker inspect true-blue-platform-app-1 --format "APP={{.Config.Image}} HEALTH={{.State.Health.Status}}"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/          # 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/login     # 200
```

(Or run `.ssm-params-status-check.json` via SSM for the same checks remotely.)

### 6.2 Log in

Log in through the deployed URL with a firm user (seed accounts: `admin@acmetax.com` /
`FirmAdmin1!`, `user@acmetax.com` / `FirmUser1!`; firm codes `acme-tax`, `best-tax`). Over
HTTP staging use throwaway passwords only.

### 6.3 Prove vector retrieval (M4 gate — this is the acceptance bar)

The deploy **fails the M4 gate** if chat answers come from the lexical fallback. Run the
staging E2E from a trusted machine and require vector mode:

```powershell
# from true-blue-platform/
.\scripts\run-m4-e2e-staging.ps1 `
  -BaseUrl "<canonical M4 HTTPS URL>" `
  -CookieFile ".\cookies.txt" `
  -PdfPath "..\client_shared_pdfs\2025 Tax Return Documents (Whittaker Jordan).pdf" `
  -OutputPath ".\m4-e2e-report.json" `
  -ExpectVectorRetrieval
```

- Use `-BearerToken` instead of `-CookieFile` if staging auth provides a test token.
  Create `cookies.txt` first by logging in via the API/browser-export flow described in
  `m4-acceptance-testing.md` (client UAT lives in `m4-client-acceptance-testing.md`).
- **Pass condition:** the answer's `output.support.retrievalMode` must be
  **`"vector_retrieval"`**. A `"local_retrieval_fallback"` response does **not** satisfy
  the vector E2E gate — it means Pinecone/OpenAI/embeddings were not actually used.
- With `-ExpectVectorRetrieval` the script also reads
  `/api/internal/m4/vector-index-status?documentId=...` to confirm an active index without
  exposing vectors, prompts, or secrets. If an older deployment lacks that endpoint, attach
  DB-side evidence from `document_vector_indexes` (active index, namespace, generation,
  chunk count, vector-id count, embedding model/dimension, parser version, chunk strategy,
  `isActive`).

### 6.4 Manual smoke

1. Log in as a firm user.
2. Upload a text-based PDF; wait until status is `COMPLETED`.
3. Ask a question answerable from that PDF. Confirm citations and
   `output.schemaVersion = "trueblue.chat.output.v1"`.
4. Ask an unsupported question. Confirm `output.status = "insufficient_evidence"` and
   `output.sources = []`.
5. Reload the thread; confirm assistant history includes `data-output`.

---

## 7. Rollback

The images are immutable per tag, so rollback = repoint to the previous tag and recreate.
The migration is additive/nullable, so the prior app build tolerates the extra column —
a DB restore is normally **not** required.

```bash
ssh ec2-user@52.70.0.80
cd /opt/trueblue
COMPOSE="docker compose -f docker-compose.prod.yml"

# set the three image refs back to the previous tag (recorded before deploy / in
# .deploy-current-tag.txt / .deploy-latest-prod-tag.txt)
vi .env
grep -E '^(APP_IMAGE|MIGRATE_IMAGE|WORKER_IMAGE)=' .env
set -a; . ./.env; set +a

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 536573256060.dkr.ecr.us-east-1.amazonaws.com
$COMPOSE pull app textract-worker
$COMPOSE up -d --force-recreate app textract-worker nginx
for i in $(seq 1 30); do s=$(docker inspect true-blue-platform-app-1 --format "{{.State.Health.Status}}" 2>/dev/null || echo starting); echo "app_health=$s"; [ "$s" = healthy ] && break; sleep 5; done
$COMPOSE ps
```

(Equivalently via SSM, edit `.ssm-params-prod-redeploy-latest.json` to the previous tag and
send it.)

Only if a future migration is **not** backward-compatible: restore the pre-deploy backup
before rolling the app back:

```bash
gunzip -c backups/pre-<tag>-<timestamp>.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

---

## Appendix — Local Validation Gates

Run from `true-blue-platform/` before building/shipping a new tag:

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
```
