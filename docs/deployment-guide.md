# Deployment Guide — True Blue Financial Intelligence Platform

Complete step-by-step procedure for deploying the platform to AWS EC2 staging.

## Table of Contents

- [AWS Resource Summary](#aws-resource-summary)
- [Phase 1 — Local Preparation](#phase-1--local-preparation)
- [Phase 2 — AWS Provisioning](#phase-2--aws-provisioning)
- [Phase 3 — EC2 Configuration](#phase-3--ec2-configuration)
- [Phase 4 — Deployment](#phase-4--deployment)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Adding a New Developer](#adding-a-new-developers-ssh-ip)
- [Cost Breakdown](#cost-breakdown)
- [Security Configuration](#security-configuration)

---

## AWS Resource Summary

| Resource | Value |
|---|---|
| EC2 Instance | `i-082a8ba117faac61c` (t3.small, Amazon Linux 2023) |
| Elastic IP | `54.208.102.72` |
| Elastic IP Allocation | `eipalloc-0797d3c7a5b8c9f2c` |
| Security Group | `sg-0a378d48da47d1008` (trueblue-staging-sg) |
| Key Pair | trueblue-staging (ED25519, `~/.ssh/trueblue-staging.pem`) |
| IAM Role | TrueBlue-EC2-Staging (no policies yet — placeholder for future S3 access) |
| Instance Profile | TrueBlue-EC2-Staging |
| S3 Bucket | `trueblue-documents-prod` (AES-256, versioning, public access blocked) |
| Deploy Key | trueblue-staging-ec2 (read-only, ED25519) |
| GitHub Repo | sharozhaseeb/true-blue-platform (PRIVATE) |
| Region | us-east-1 (N. Virginia) |

---

## Phase 1 — Local Preparation

These changes were made to the codebase before deploying to AWS.

### 1.1 Enable standalone output

Modified `next.config.ts` to add standalone output mode (reduces Docker image from ~1GB to ~200MB):

```typescript
const nextConfig: NextConfig = {
  output: "standalone",
  // ... existing config
};
```

### 1.2 Decouple cookie security from NODE_ENV

Modified `src/lib/auth.ts` to use `USE_SECURE_COOKIES` env var instead of checking `NODE_ENV`:

```typescript
const IS_PRODUCTION = process.env.USE_SECURE_COOKIES === "true";
```

This allows cookies to work over HTTP in staging (where `USE_SECURE_COOKIES=false`) while still running `NODE_ENV=production` for performance.

### 1.3 Create .dockerignore

Created `.dockerignore` to exclude unnecessary files from the Docker build context:

```
node_modules
.next
.git
.env*
*.md
```

### 1.4 Create Dockerfile

Created a multi-stage `Dockerfile` based on `node:20-slim` (Debian):

- **Stage 1 (deps):** Installs npm dependencies only (cached layer)
- **Stage 2 (builder):** Installs `python3`, `make`, `g++` for bcrypt native compilation. Runs `prisma generate` and `npm run build`.
- **Stage 3 (runner):** Copies standalone build output. Runs as non-root `nextjs` user. Exposes port 3000 (internal only).

### 1.5 Create docker-compose.prod.yml

Created `docker-compose.prod.yml` with 3 services + 1 setup profile:

- **db** — PostgreSQL 16 Alpine, port 5432 (internal), health check, persistent volume
- **migrate** — One-shot service (profile: setup), runs `npx prisma migrate deploy`
- **app** — Next.js standalone, port 3000 (internal), depends on db healthy
- **nginx** — Reverse proxy, port 80 (exposed), depends on app

### 1.6 Create nginx/nginx.conf

Created `nginx/nginx.conf` with:

- Reverse proxy from port 80 to app on port 3000
- Rate limiting: 5r/s on `/api/auth/*`, 10r/s on other `/api/*` endpoints
- Security headers: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy
- Gzip compression
- Static asset caching

### 1.7 Create supporting files

- `.env.staging` — Template for staging environment variables
- `scripts/test-build.sh` — Local Docker build verification script
- `public/.gitkeep` — Prevents Docker COPY failure on empty `public/` directory
- Updated `.env.example` with `USE_SECURE_COOKIES` variable

### 1.8 Update Prisma schema

Added `binaryTargets` to `prisma/schema.prisma`:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}
```

### 1.9 Test locally

```bash
# Build the Docker image
docker build -t trueblue-test .

# Start all services
docker compose -f docker-compose.prod.yml up --build

# Verify endpoints work
curl http://localhost
curl http://localhost/login
curl http://localhost/register
curl http://localhost/api/auth/login
```

---

## Phase 2 — AWS Provisioning

All commands use the AWS CLI. Replace `--profile <your-profile>` with your AWS credential configuration.

### 2.1 Create IAM Role and Instance Profile

```bash
# Create the IAM role with EC2 trust policy
aws iam create-role \
  --role-name TrueBlue-EC2-Staging \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name TrueBlue-EC2-Staging

# Attach role to instance profile
aws iam add-role-to-instance-profile \
  --instance-profile-name TrueBlue-EC2-Staging \
  --role-name TrueBlue-EC2-Staging
```

No policies are attached yet — this is a placeholder for future S3 access.

### 2.2 Create Security Group

```bash
# Create the security group
aws ec2 create-security-group \
  --group-name trueblue-staging-sg \
  --description "True Blue staging server"
# Returns: sg-0a378d48da47d1008

# Allow SSH from your IP only
aws ec2 authorize-security-group-ingress \
  --group-id sg-0a378d48da47d1008 \
  --protocol tcp \
  --port 22 \
  --cidr 139.135.38.242/32

# Allow HTTP from anywhere
aws ec2 authorize-security-group-ingress \
  --group-id sg-0a378d48da47d1008 \
  --protocol tcp \
  --port 80 \
  --cidr 0.0.0.0/0
```

### 2.3 Create Key Pair

```bash
aws ec2 create-key-pair \
  --key-name trueblue-staging \
  --key-type ed25519 \
  --query 'KeyMaterial' \
  --output text > ~/.ssh/trueblue-staging.pem

chmod 400 ~/.ssh/trueblue-staging.pem
```

### 2.4 Launch EC2 Instance

```bash
aws ec2 run-instances \
  --image-id ami-0c02fb55956c7d316 \
  --instance-type t3.small \
  --key-name trueblue-staging \
  --security-group-ids sg-0a378d48da47d1008 \
  --iam-instance-profile Name=TrueBlue-EC2-Staging \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --metadata-options '{"HttpTokens":"required","HttpEndpoint":"enabled"}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=trueblue-staging}]'
# Returns: i-082a8ba117faac61c
```

Key options:
- **IMDSv2 enforced** (`HttpTokens: required`) — prevents SSRF attacks on metadata service
- **20GB gp3** — sufficient for staging
- **t3.small** — 2 vCPU, 2GB RAM

### 2.5 Allocate and Associate Elastic IP

```bash
# Allocate Elastic IP
aws ec2 allocate-address --domain vpc
# Returns: 54.208.102.72, eipalloc-0797d3c7a5b8c9f2c

# Associate to instance
aws ec2 associate-address \
  --instance-id i-082a8ba117faac61c \
  --allocation-id eipalloc-0797d3c7a5b8c9f2c
```

---

## Phase 3 — EC2 Configuration

### 3.1 SSH into the instance

```bash
ssh -i ~/.ssh/trueblue-staging.pem ec2-user@54.208.102.72
```

### 3.2 Update the system

```bash
sudo dnf update -y
```

### 3.3 Install Docker

```bash
sudo dnf install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user
```

Log out and back in for the group change to take effect.

### 3.4 Install Docker Compose v5.1.0

```bash
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version
# Docker Compose v5.1.0
```

### 3.5 Install Docker buildx v0.32.1

Docker Compose v5 requires a recent version of buildx. The version shipped with Amazon Linux 2023 is too old.

```bash
sudo curl -SL https://github.com/docker/buildx/releases/download/v0.20.0/buildx-v0.20.0.linux-amd64 \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
docker buildx version
# github.com/docker/buildx v0.32.1
```

### 3.6 Install Git

```bash
sudo dnf install -y git
git --version
# git version 2.50.1
```

### 3.7 Generate deploy key

```bash
ssh-keygen -t ed25519 -C "trueblue-staging-ec2" -f ~/.ssh/trueblue-deploy -N ""
cat ~/.ssh/trueblue-deploy.pub
# Copy this public key
```

### 3.8 Add deploy key to GitHub

1. Go to GitHub repo Settings > Deploy keys
2. Add the public key with title "trueblue-staging-ec2"
3. Leave "Allow write access" unchecked (read-only)

### 3.9 Configure SSH for GitHub

```bash
cat >> ~/.ssh/config << 'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/trueblue-deploy
  IdentitiesOnly yes
EOF

chmod 600 ~/.ssh/config
```

### 3.10 Add GitHub to known hosts

```bash
ssh-keyscan github.com >> ~/.ssh/known_hosts
```

---

## Phase 4 — Deployment

### 4.1 Clone the repository

```bash
git clone git@github.com:sharozhaseeb/true-blue-platform.git
cd true-blue-platform
```

### 4.2 Create the .env file

```bash
cat > .env << EOF
DATABASE_URL=postgresql://trueblue:$(openssl rand -base64 32)@db:5432/trueblue
POSTGRES_USER=trueblue
POSTGRES_PASSWORD=$(openssl rand -base64 32)
POSTGRES_DB=trueblue
JWT_ACCESS_SECRET=$(openssl rand -base64 64)
JWT_REFRESH_SECRET=$(openssl rand -base64 64)
NEXT_PUBLIC_APP_URL=http://54.208.102.72
USE_SECURE_COOKIES=false
NODE_ENV=production
EOF
```

**Important:** The `DATABASE_URL` password and `POSTGRES_PASSWORD` must match. Generate them once and use the same value in both. The command above generates different passwords — manually edit to use the same one:

```bash
# Generate a single password
DB_PASS=$(openssl rand -base64 32)

cat > .env << EOF
DATABASE_URL=postgresql://trueblue:${DB_PASS}@db:5432/trueblue
POSTGRES_USER=trueblue
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=trueblue
JWT_ACCESS_SECRET=$(openssl rand -base64 64)
JWT_REFRESH_SECRET=$(openssl rand -base64 64)
NEXT_PUBLIC_APP_URL=http://54.208.102.72
USE_SECURE_COOKIES=false
NODE_ENV=production
EOF
```

### 4.3 Build Docker images

```bash
docker compose -f docker-compose.prod.yml build --no-cache
```

This takes 3-5 minutes on a t3.small. The multi-stage build:
1. Installs npm dependencies
2. Installs python3/make/g++ and compiles bcrypt
3. Generates Prisma client
4. Builds Next.js in standalone mode
5. Creates minimal production image

### 4.4 Start the database

```bash
docker compose -f docker-compose.prod.yml up -d db
```

Wait for the database to be healthy:

```bash
docker compose -f docker-compose.prod.yml ps
# db should show "healthy"
```

### 4.5 Run migrations

```bash
docker compose -f docker-compose.prod.yml --profile setup run --rm migrate
```

### 4.6 Start the application and Nginx

```bash
docker compose -f docker-compose.prod.yml up -d app nginx
```

### 4.7 Verify

```bash
# Check all containers are running
docker compose -f docker-compose.prod.yml ps

# Test endpoints
curl -s -o /dev/null -w "%{http_code}" http://54.208.102.72/
# Should return 200

curl -s -o /dev/null -w "%{http_code}" http://54.208.102.72/login
# Should return 200

curl -s -o /dev/null -w "%{http_code}" http://54.208.102.72/register
# Should return 200

curl -s -o /dev/null -w "%{http_code}" http://54.208.102.72/api/auth/login
# Should return 405 (GET not allowed, POST required)
```

---

## Operations

### View logs

```bash
ssh -i ~/.ssh/trueblue-staging.pem ec2-user@54.208.102.72
cd true-blue-platform

# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml logs -f nginx
docker compose -f docker-compose.prod.yml logs -f db

# Last 100 lines
docker compose -f docker-compose.prod.yml logs --tail 100 app

# Nginx access logs
docker compose -f docker-compose.prod.yml exec nginx cat /var/log/nginx/access.log
```

### Restart services

```bash
# Restart all
docker compose -f docker-compose.prod.yml restart

# Restart specific service
docker compose -f docker-compose.prod.yml restart app
docker compose -f docker-compose.prod.yml restart nginx
```

### Check service status

```bash
docker compose -f docker-compose.prod.yml ps
```

### Update / Redeploy

```bash
ssh -i ~/.ssh/trueblue-staging.pem ec2-user@54.208.102.72
cd true-blue-platform

# Pull latest code
git pull

# Rebuild and restart
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

# If there are new database migrations
docker compose -f docker-compose.prod.yml --profile setup run --rm migrate

# Verify
docker compose -f docker-compose.prod.yml ps
curl -s -o /dev/null -w "%{http_code}" http://54.208.102.72/
```

### Quick redeploy (no migration changes)

```bash
ssh -i ~/.ssh/trueblue-staging.pem ec2-user@54.208.102.72
cd true-blue-platform
git pull && docker compose -f docker-compose.prod.yml build --no-cache && docker compose -f docker-compose.prod.yml up -d
```

### Seed the database

```bash
# Enter the app container and run seed
docker compose -f docker-compose.prod.yml exec app npx prisma db seed
```

### Access the database directly

```bash
docker compose -f docker-compose.prod.yml exec db psql -U trueblue -d trueblue
```

### Database backup

```bash
docker compose -f docker-compose.prod.yml exec db pg_dump -U trueblue trueblue | gzip > ~/backup-$(date +%Y%m%d).sql.gz
```

### Database restore

```bash
gunzip -c ~/backup-YYYYMMDD.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U trueblue -d trueblue
```

---

## Troubleshooting

### Issue 1: Alpine OpenSSL incompatibility with Prisma 5

**Symptom:** Prisma schema engine crashes during `prisma generate` or `prisma migrate` with errors about missing shared libraries.

**Cause:** Alpine Linux uses musl libc, which is incompatible with the Prisma 5 schema engine. The `linux-musl-openssl-3.0.x` binary target does not work.

**Fix:** Switch all Dockerfile stages from `node:20-alpine` to `node:20-slim` (Debian). Update `prisma/schema.prisma` to use `debian-openssl-3.0.x` instead of `linux-musl-openssl-3.0.x`:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}
```

### Issue 2: Docker buildx too old on Amazon Linux 2023

**Symptom:** `docker compose build` fails with errors about unsupported buildx features.

**Cause:** The version of Docker buildx shipped with Amazon Linux 2023 is too old for Docker Compose v5.

**Fix:** Install buildx v0.32.1 manually:

```bash
sudo curl -SL https://github.com/docker/buildx/releases/download/v0.20.0/buildx-v0.20.0.linux-amd64 \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
```

### Issue 3: SSH key format issue (Windows line endings)

**Symptom:** `ssh -i ~/.ssh/trueblue-staging.pem` fails with "invalid format" or "bad permissions" even after `chmod 400`.

**Cause:** The .pem file was saved with Windows CRLF line endings.

**Fix:**

```bash
sed -i 's/\r$//' ~/.ssh/trueblue-staging.pem
```

### Issue 4: Empty public/ directory causes Docker COPY failure

**Symptom:** `docker build` fails at the `COPY public ./public` step with "no source files were specified".

**Cause:** The `public/` directory was empty and git does not track empty directories.

**Fix:** Add a `.gitkeep` file:

```bash
touch public/.gitkeep
git add public/.gitkeep
```

### Issue 5: Prisma binaryTargets wrong for Debian

**Symptom:** Prisma works locally (macOS/Windows) but fails in Docker with "Query engine not found".

**Cause:** The Prisma schema only had `"native"` as a binary target, which generates binaries for the build machine's OS — not for the Docker container's Debian.

**Fix:** Add the Debian binary target:

```prisma
binaryTargets = ["native", "debian-openssl-3.0.x"]
```

### General: Container won't start

```bash
# Check container logs
docker compose -f docker-compose.prod.yml logs app

# Check if the image built correctly
docker images | grep trueblue

# Rebuild from scratch
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

### General: App returns 502 Bad Gateway

This means Nginx is running but cannot reach the Next.js app.

```bash
# Check if app container is running
docker compose -f docker-compose.prod.yml ps app

# Check app logs
docker compose -f docker-compose.prod.yml logs app

# Restart the app
docker compose -f docker-compose.prod.yml restart app
```

---

## Adding a New Developer's SSH IP

SSH access to the EC2 instance is restricted by security group `sg-0a378d48da47d1008`. To add a new developer:

```bash
# Find the developer's public IP
# They can visit https://checkip.amazonaws.com/

# Add their IP to the security group
aws ec2 authorize-security-group-ingress \
  --group-id sg-0a378d48da47d1008 \
  --protocol tcp \
  --port 22 \
  --cidr <DEVELOPER_IP>/32

# To remove an IP later
aws ec2 revoke-security-group-ingress \
  --group-id sg-0a378d48da47d1008 \
  --protocol tcp \
  --port 22 \
  --cidr <DEVELOPER_IP>/32
```

The developer will also need a copy of the `trueblue-staging.pem` key file (shared securely, not via email or chat).

---

## Cost Breakdown

### Monthly Costs (Staging)

| Resource | Cost | Notes |
|---|---|---|
| EC2 t3.small | ~$15.18/mo | On-demand pricing, us-east-1 |
| Elastic IP | $0.00 | Free while associated to a running instance |
| EBS 20GB gp3 | ~$1.60/mo | $0.08/GB/month |
| Data transfer | ~$0.00-$1.00 | First 100GB/month free to internet |
| S3 bucket | ~$0.00 | Minimal storage, no traffic yet |
| **Total** | **~$17/mo** | |

### Cost Optimization Options

- **Reserved Instance (1yr):** ~$9.50/mo (37% savings)
- **Spot Instance:** ~$5/mo (not recommended for staging — can be interrupted)
- **Stop when not in use:** $0 compute cost when stopped (EBS + EIP still charged: ~$5/mo)

To stop/start the instance:

```bash
# Stop (saves compute cost, EBS persists)
aws ec2 stop-instances --instance-ids i-082a8ba117faac61c

# Start
aws ec2 start-instances --instance-ids i-082a8ba117faac61c
```

The Elastic IP remains associated. No data is lost when stopping.

---

## Security Configuration

### Network Security

| Rule | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| SSH | TCP | 22 | 139.135.38.242/32 | Admin access (restricted to single IP) |
| HTTP | TCP | 80 | 0.0.0.0/0 | Web application access |

### Instance Security

- **IMDSv2 enforced** — Prevents SSRF attacks on EC2 metadata service. The instance metadata service requires a session token (PUT request) before returning any data.
- **IAM Instance Profile** — `TrueBlue-EC2-Staging` role with no policies. No hardcoded AWS credentials on the server. Policies will be added as needed (S3, CloudWatch).
- **Deploy key** — Read-only ED25519 key for GitHub. No personal access tokens or SSH keys on the server.

### Application Security

- **Nginx rate limiting** — 5r/s on auth endpoints, 10r/s on API endpoints. Mitigates brute force and DoS.
- **Security headers** — Applied by both Nginx and `next.config.ts` (defense in depth):
  - `X-Frame-Options: DENY` — Prevents clickjacking
  - `X-Content-Type-Options: nosniff` — Prevents MIME sniffing
  - `X-XSS-Protection: 1; mode=block` — XSS filter
  - `Referrer-Policy: strict-origin-when-cross-origin` — Controls referrer leakage
  - `Permissions-Policy` — Restricts browser feature access
- **Port isolation** — Only port 80 is exposed. PostgreSQL (5432) and Next.js (3000) are internal to the Docker network.
- **httpOnly cookies** — JWT tokens stored in httpOnly cookies, not accessible via JavaScript.
- **USE_SECURE_COOKIES=false** — Required for HTTP staging. Will be set to `true` when SSL is added.

### What's NOT secured yet (deferred)

- **No SSL/TLS** — All traffic is plaintext. Requires a domain name (Milestone 4).
- **No database backups** — Acceptable for staging with seed data. Will add automated backups in M2+.
- **No CloudWatch monitoring** — Will add CPU/memory/disk alerts in M3+.
- **No WAF** — Consider adding AWS WAF when production traffic begins.
