# Staging Environment — True Blue Financial Intelligence Platform

## Overview

| Property | Value |
|---|---|
| Instance ID | `i-082a8ba117faac61c` |
| Instance Type | t3.small (2 vCPU, 2GB RAM) |
| Region | us-east-1 (N. Virginia) |
| OS | Amazon Linux 2023 |
| Elastic IP | `54.208.102.72` |
| Elastic IP Allocation | `eipalloc-0797d3c7a5b8c9f2c` |
| URL | http://54.208.102.72 |
| Protocol | HTTP only (no SSL) |
| Architecture | Docker Compose: PostgreSQL 16 + Next.js + Nginx |
| Security Group | `sg-0a378d48da47d1008` (trueblue-staging-sg) |
| Key Pair | trueblue-staging (ED25519) |
| IAM Role | TrueBlue-EC2-Staging (no policies yet) |
| Instance Profile | TrueBlue-EC2-Staging |
| S3 Bucket | `trueblue-documents-prod` (AES-256, versioning, public access blocked) |
| Deploy Key | trueblue-staging-ec2 (read-only, ED25519) |
| GitHub Repo | sharozhaseeb/true-blue-platform (PRIVATE) |
| IMDSv2 | Enforced |

## HTTP Security Warning

Staging runs over **plain HTTP**. All traffic including passwords is transmitted unencrypted.

- Use **throwaway passwords only**. Do NOT reuse real passwords.
- Seed data passwords (`Admin123!`, `FirmAdmin1!`, `FirmUser1!`) are for testing only.
- SSL/TLS will be added when a domain is configured (Milestone 4).
- The `USE_SECURE_COOKIES` env var is set to `false` for HTTP staging.

## Accessing the Server

```bash
# SSH into the instance
ssh -i ~/.ssh/trueblue-staging.pem ec2-user@54.208.102.72

# View logs
cd true-blue-platform
docker compose -f docker-compose.prod.yml logs -f        # all services
docker compose -f docker-compose.prod.yml logs -f app     # app only
docker compose -f docker-compose.prod.yml logs -f nginx   # nginx only
docker compose -f docker-compose.prod.yml logs -f db      # database only

# Restart services
docker compose -f docker-compose.prod.yml restart

# Check status
docker compose -f docker-compose.prod.yml ps
```

**SSH access is restricted** to IP `139.135.38.242/32` via security group `sg-0a378d48da47d1008`. To add a new developer's IP, update the security group inbound rules (see deployment guide).

## Updating the Deployment

```bash
ssh -i ~/.ssh/trueblue-staging.pem ec2-user@54.208.102.72
cd true-blue-platform
git pull
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
# If there are new migrations:
docker compose -f docker-compose.prod.yml --profile setup run --rm migrate
```

## Test Accounts

| Email | Password | Role | Firm |
|---|---|---|---|
| admin@trueblue.dev | Admin123! | Platform Admin | — |
| admin@acmetax.com | FirmAdmin1! | Firm Admin | Acme Tax Services |
| user@acmetax.com | FirmUser1! | Firm User | Acme Tax Services |
| admin@besttax.com | FirmAdmin1! | Firm Admin | Best Tax Advisors |

Firm codes for registration: `acme-tax`, `best-tax`

## Deferred Items — Future Milestones

| Item | Milestone | Details |
|---|---|---|
| **S3 CORS update** | M2 | Add Elastic IP to S3 bucket CORS `AllowedOrigins` when S3 integration is built. Current CORS only allows `localhost:3000`. Command: `aws s3api put-bucket-cors --bucket trueblue-documents-prod --cors-configuration '{"CORSRules":[{"AllowedHeaders":["*"],"AllowedMethods":["GET","PUT","POST","DELETE"],"AllowedOrigins":["http://localhost:3000","http://54.208.102.72"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]}'` |
| **IAM Instance Profile policies** | M2 | Add S3 read/write policy scoped to `trueblue-documents-prod` bucket. Add CloudWatch Logs policy. Role `TrueBlue-EC2-Staging` exists but has no policies yet. |
| **Database backups** | M2+ | Add cron job: `0 2 * * * docker exec $(docker ps -qf "name=db") pg_dump -U trueblue trueblue \| gzip > /home/ec2-user/backups/trueblue-$(date +\%Y\%m\%d).sql.gz`. Rotate backups older than 7 days. |
| **SSL/TLS certificate** | M4 | Requires domain name. Use Let's Encrypt via certbot. Update `nginx/nginx.conf` to listen on 443, redirect 80->443. Set `USE_SECURE_COOKIES=true` in `.env`. Open port 443 in security group `sg-0a378d48da47d1008`. |
| **Domain name + DNS** | M4 | Point domain A record to `54.208.102.72`. Update `NEXT_PUBLIC_APP_URL` in `.env`. Update `server_name` in nginx config. |
| **RDS migration** | M4 | Migrate from Docker PostgreSQL to AWS RDS. Export with `pg_dump`, import to RDS. Update `DATABASE_URL` in `.env`. Remove `db` service from `docker-compose.prod.yml`. Enable RDS encryption at rest + automated backups. |
| **CI/CD pipeline** | M3+ | GitHub Actions: on push to main -> SSH to EC2, pull, rebuild, restart. Or use ECR + CodeDeploy for zero-downtime deployments. |
| **CloudWatch monitoring** | M3+ | Install CloudWatch agent for memory/disk metrics. Configure alarms for CPU > 80%, disk > 90%. Set up SNS topic for alert emails. |
| **Seed password rotation** | Before real use | Generate new passwords with `openssl rand -base64 16`. Update `prisma/seed.ts`. Re-seed database. Update this document. |
| **Horizontal scaling** | Phase 2 | Move containers to ECS/Fargate or EKS. Add ALB for load balancing. No application code changes required — only orchestration. |

## Architecture Decisions Log

| Decision | Rationale |
|---|---|
| **bcrypt@6 (native)** over bcryptjs | 3-4x faster hashing. Build deps (`python3 make g++`) added to Dockerfile builder stage only — not in production image. |
| **`output: "standalone"`** | Reduces Docker image from ~1GB to ~200MB. Self-contained `server.js` with bundled dependencies. |
| **Nginx reverse proxy** | Rate limiting (5r/s auth, 10r/s API), security headers, static asset caching, single entry point. Port 3000 never exposed. |
| **PostgreSQL in Docker** (not RDS) | Cost savings for staging (~$0 vs ~$15-30/month). Acceptable for demo with seed data. Migrate to RDS for production in M4. |
| **HTTP-only staging** | No domain available. `USE_SECURE_COOKIES=false` allows cookies over HTTP. Risk mitigated with throwaway passwords. |
| **IAM Instance Profile** | Created with no policies (placeholder). Eliminates need for hardcoded AWS credentials on EC2. Policies added as features require them. |
| **ED25519 deploy key** | Read-only GitHub access from EC2. More secure than RSA. No personal tokens on the server. |
| **node:20-slim over node:20-alpine** | Alpine uses musl libc which is incompatible with Prisma 5 schema engine. Debian slim uses glibc and works correctly with `debian-openssl-3.0.x` binary target. |
| **IMDSv2 enforced** | Prevents SSRF attacks that could steal EC2 instance credentials via the metadata service. |
| **Lazy JWT secret initialization** | JWT secrets are lazily loaded on first use rather than at module level. Prevents build-time crashes when env vars aren't set (Docker build stage has no `.env`). Also removed `@prisma/client` import from `auth.ts` to avoid Edge Runtime issues in middleware. |
| **fetchWithAuth singleton refresh** | Client-side fetch wrapper that intercepts 401 responses, refreshes the token, and retries. Uses a singleton promise to prevent concurrent 401s from triggering multiple refresh calls (token rotation would invalidate the second). |
