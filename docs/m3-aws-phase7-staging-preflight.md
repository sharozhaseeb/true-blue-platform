# M3 AWS Phase 7 Staging Preflight

Created: 2026-05-20
Last updated: 2026-05-20 after staging deploy and Textract smoke

## Account And Region

| Item | Value |
| --- | --- |
| AWS account | `536573256060` |
| Region | `us-east-1` |
| Environment | `staging` |
| Staging URL | `http://52.70.0.80` |
| EC2 instance | `i-0a34ef089984569b6` |
| Instance type | `t3.small` |
| SSM status | Online |

## Provisioned Resources

| Resource | Value |
| --- | --- |
| KMS alias | `alias/trueblue-staging-documents` |
| KMS key ID | `8e4eec90-60cc-4e55-a7a8-dc9dc81b5958` |
| Document bucket | `trueblue-documents-536573256060-staging` |
| Artifact bucket | `trueblue-document-artifacts-536573256060-staging` |
| SNS topic | `arn:aws:sns:us-east-1:536573256060:trueblue-textract-complete-staging` |
| SQS queue | `https://queue.amazonaws.com/536573256060/trueblue-textract-jobs-staging` |
| SQS DLQ | `https://queue.amazonaws.com/536573256060/trueblue-textract-jobs-dlq-staging` |
| Textract publish role | `arn:aws:iam::536573256060:role/TrueBlueTextractPublishRole-staging` |
| Runtime role | `arn:aws:iam::536573256060:role/TrueBlueStagingAppWorkerRole` |
| Runtime instance profile | `arn:aws:iam::536573256060:instance-profile/TrueBlueStagingAppWorkerInstanceProfile` |
| App log group | `/trueblue/staging/app` |
| Worker log group | `/trueblue/staging/worker` |
| ECR app repo | `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app` |
| ECR migrate repo | `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-migrate` |
| ECR worker repo | `536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-worker` |

## Security Baseline

S3 buckets:

- Public access blocked.
- Versioning enabled.
- Bucket owner enforced.
- Default encryption uses customer-managed KMS key.
- S3 bucket keys enabled.
- Bucket policy denies insecure transport.

SNS/SQS:

- SNS topic encrypted with the customer-managed KMS key.
- SQS queue and DLQ encrypted with the customer-managed KMS key.
- Main queue has redrive policy to DLQ with `maxReceiveCount=5`.
- Queue policy allows `sqs:SendMessage` only from the Textract completion SNS topic.
- SNS-to-SQS delivery smoke test passed.

IAM:

- Textract publish role can publish only to the completion SNS topic and use the KMS key through SNS.
- Runtime role is least-privilege for document/artifact buckets, Textract start/get, SQS consume/delete, limited SNS read, CloudWatch Logs write, KMS use, and `iam:PassRole` only for the Textract publish role.

ECR:

- App, migrate, and worker repositories use immutable image tags.
- Repositories are KMS encrypted.
- Scan-on-push is enabled.
- Untagged images expire after 7 days.

## Release Images

Built and pushed: 2026-05-20

Use the patched tag below. Earlier tags were superseded:

- `phase7-textract-20260520-0905`: superseded after ECR found base-image critical/high CVEs.
- `phase7-textract-20260520-0925`: superseded after staging revealed oversized retrieval provenance arrays.

```env
APP_IMAGE=536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-app:phase7-textract-20260520-0940
MIGRATE_IMAGE=536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-migrate:phase7-textract-20260520-0940
WORKER_IMAGE=536573256060.dkr.ecr.us-east-1.amazonaws.com/true-blue-platform-worker:phase7-textract-20260520-0940
```

| Image | Digest | ECR scan result |
| --- | --- | --- |
| App | `sha256:21dcc0b0943eeaf16f5459299e1e48bcaa6d47d8f33df2b0c7262ac7250787b0` | 0 critical, 0 high, 1 medium |
| Migrate | `sha256:817e8b382405dadde71f53769268c343502b5dfc05e6e955c1fe3261118164ec` | 0 critical, 0 high, 1 medium |
| Worker | `sha256:797768d17d5fc6d974b3303c25c28aa5bcf1d515c41656fd1877d37e70f8b9c6` | 0 critical, 0 high, 1 medium |

Residual scan note:

- Remaining medium finding: `CVE-2026-41989` in `libgcrypt20` `1.10.1-3`.
- ECR reports CVSS 6.7 with local attack vector characteristics.
- No critical/high findings remain after OS package upgrades in the Dockerfile.

Local image smoke tests:

- App runner image: `/` returned `200`; `/login` returned `200`.
- Migrate image: `npx prisma --version` succeeded on Linux x64 with `debian-openssl-3.0.x`.
- Worker image: `ENABLE_TEXTRACT_PIPELINE=false node scripts/textract-worker.js` exited cleanly with `0` messages processed.

## Live Textract Smoke Test

### Direct AWS service smoke

Input:

- Source PDF: `node_modules/pdf-parse/test/data/04-valid.pdf`
- S3 object: `s3://trueblue-documents-536573256060-staging/smoke-tests/textract/04-valid.pdf`

Textract:

- Job ID: `0b0ce3410cd86e2875bf76ef8a9b2c5777252cf580183ffeb414e57171a424db`
- Job tag: `trueblue-smoke-c4ad42d7b8ba4755`
- Feature types: `FORMS`, `TABLES`, `LAYOUT`
- Completion status: `SUCCEEDED`
- Completion path: Textract -> SNS -> SQS verified

Result summary:

| Metric | Value |
| --- | ---: |
| Document pages | 5 |
| Textract result chunks | 4 |
| Total blocks | 3,654 |
| `PAGE` blocks | 5 |
| `LINE` blocks | 444 |
| `WORD` blocks | 2,927 |
| `TABLE` blocks | 4 |
| `CELL` blocks | 84 |
| `KEY_VALUE_SET` blocks | 70 |
| `SELECTION_ELEMENT` blocks | 2 |
| Layout blocks | present |

Stored artifacts:

- `s3://trueblue-document-artifacts-536573256060-staging/smoke-tests/textract/0b0ce3410cd86e2875bf76ef8a9b2c5777252cf580183ffeb414e57171a424db/`
- Files uploaded: `chunk-1.json` through `chunk-4.json`, plus `summary.json`

### App-integrated staging smoke

Input:

- Source PDF: `node_modules/pdf-parse/test/data/04-valid.pdf`
- Staging URL: `http://52.70.0.80`
- Auth user: seeded Acme firm user
- Document ID: `cmpdvc8bw0003mzgfqsosz0wq`
- Base artifact ID: `cmpdvc8j70005mzgfdyb3z7bw`
- Provider job ID: `ad9c8d6f9c65d15117cc5aecdecb3c7cdc3cae41b4bfe6f81408cf4798b9aaf2`

Verified behavior:

1. Login returned `200`.
2. Upload returned truthful async status: `PROCESSING`, `chunkCount=0`, provider job ID present.
3. Worker completed Textract -> SNS -> SQS -> normalization.
4. Document reached `COMPLETED` with `pageCount=5`.
5. Base artifact reached `READY_FOR_INDEXING`.
6. Persisted retrieval chunks were created for M3 retrieval.
7. Chat over the uploaded document returned 5 citations and `insufficientEvidence=false`.
8. Retrieval warning count was `0` after the provenance cap patch.

Known API presentation note:

- `/api/documents/:id?chunks=true` still reads the legacy M2 `document_chunks` table.
- Textract-backed documents write M3 retrieval chunks into `document_retrieval_chunks`.
- Therefore `legacyChunkTotal=0` on that endpoint is expected for Textract-backed documents and is not the M3 chat retrieval path.

## Required Staging Env

```env
AWS_REGION=us-east-1
AWS_S3_BUCKET=trueblue-documents-536573256060-staging
AWS_S3_KMS_KEY_ID=arn:aws:kms:us-east-1:536573256060:key/8e4eec90-60cc-4e55-a7a8-dc9dc81b5958
AWS_TEXTRACT_REGION=us-east-1
TEXTRACT_FEATURE_SET=FORMS,TABLES,LAYOUT
TEXTRACT_RESULTS_BUCKET=trueblue-document-artifacts-536573256060-staging
TEXTRACT_SNS_TOPIC_ARN=arn:aws:sns:us-east-1:536573256060:trueblue-textract-complete-staging
TEXTRACT_SQS_QUEUE_URL=https://queue.amazonaws.com/536573256060/trueblue-textract-jobs-staging
TEXTRACT_NOTIFICATION_ROLE_ARN=arn:aws:iam::536573256060:role/TrueBlueTextractPublishRole-staging
ENABLE_TEXTRACT_PIPELINE=true
```

`ENABLE_TEXTRACT_PIPELINE=true` is enabled on the new staging host after the controlled sample-PDF smoke passed.

## Current Deployment Status

Staging is deployed in AWS account `536573256060`.

Host:

- EC2: `i-0a34ef089984569b6`
- Public IP: `52.70.0.80`
- Instance type: `t3.small`
- Root volume: 30 GB gp3 encrypted
- Swap: 4 GB
- Access path: SSM Session Manager

Final health check after `0940` deploy:

- `app`: healthy
- `db`: healthy
- `nginx`: healthy
- `textract-worker`: running
- Memory: about 1.1 GiB available
- Swap: 4.0 GiB available, about 8 MiB used
- Disk: 36% used

## Next Staging Verification Step

Completed:

1. Deploy patched ECR image triplet.
2. Verify fallback M2 upload/read/delete path.
3. Enable `textract-worker` and Textract feature flag.
4. Verify source upload, Textract job start, SNS/SQS completion, worker normalization, raw/normalized artifact storage, retrieval chunks, and chat citations.
5. Keep sample PDFs only; do not use real tax-firm data until full M3 provider approval is complete.

Remaining before full M3 client acceptance:

1. Decide whether this milestone acceptance is the current structured local-retrieval slice or the full Pinecone/OpenAI streaming implementation.
2. If full M3: add Pinecone vector indexing, OpenAI/AI SDK streaming, and assistant-ui integration.
3. Run staging negative tests for unsupported questions, cross-tenant retrieval, and UI citation visibility.
4. Document rollback/reprocess commands for Textract artifacts and chat retrieval.
