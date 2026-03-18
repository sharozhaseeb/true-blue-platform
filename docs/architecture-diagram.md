# Architecture Overview — True Blue Financial Intelligence Platform

## System Architecture (Phase 1)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Browser                           │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│   │  Landing │  │  Login   │  │ Register │  │  Dashboard   │   │
│   │  Page    │  │  Page    │  │  Page    │  │  Page        │   │
│   │  /       │  │  /login  │  │ /register│  │  /dashboard  │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                                 │
│   Future:                                                       │
│   ┌──────────────┐                                              │
│   │ Chat (M4)    │                                              │
│   │ Docs (M5)    │                                              │
│   │ Admin (M6)   │                                              │
│   └──────────────┘                                              │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP (port 80)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Nginx Reverse Proxy (Alpine)                  │
│                                                                 │
│  • Listens on port 80 (exposed to internet)                     │
│  • Proxies to Next.js app on port 3000 (internal)               │
│  • Rate limiting: 5r/s on /api/auth/*, 10r/s on /api/*         │
│  • Security headers (X-Frame-Options, X-Content-Type-Options,   │
│    X-XSS-Protection, Referrer-Policy, Permissions-Policy)       │
│  • Static asset caching                                         │
│  • Gzip compression                                             │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP (port 3000, internal only)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Next.js Application (Debian slim)             │
│                    Standalone output mode                        │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Middleware                              │  │
│  │  • JWT validation (jose)                                  │  │
│  │  • Route protection (public vs authenticated)             │  │
│  │  • User context injection (x-user-id, x-user-role,        │  │
│  │    x-user-firm-id headers)                                │  │
│  │  • RBAC enforcement (admin-only routes)                   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                         │                                       │
│  ┌──────────────────────┴─────────────────────────────────────┐  │
│  │                    API Routes                              │  │
│  │                                                           │  │
│  │  /api/auth/register  POST  — Create new user account      │  │
│  │  /api/auth/login     POST  — Authenticate, issue JWT      │  │
│  │  /api/auth/refresh   POST  — Rotate refresh token         │  │
│  │  /api/auth/logout    POST  — Revoke tokens, clear cookies │  │
│  │  /api/auth/me        GET   — Return current user profile  │  │
│  │                                                           │  │
│  │  /api/documents/*    (M2)  — Upload, list, status         │  │
│  │  /api/query/*        (M3-4)— RAG query pipeline           │  │
│  │  /api/admin/*        (M6)  — Firm & user management       │  │
│  └──────────────────────┬─────────────────────────────────────┘  │
│                         │                                       │
│  ┌──────────────────────┴─────────────────────────────────────┐  │
│  │                  Service Layer (src/lib/)                  │  │
│  │                                                           │  │
│  │  auth.ts     — JWT sign/verify, cookie management         │  │
│  │  password.ts — bcrypt hash/compare, validation            │  │
│  │  tenant.ts   — Request context extraction, access control │  │
│  │  rbac.ts     — Permission map per role                    │  │
│  │  prisma.ts   — Database client singleton                  │  │
│  │  errors.ts   — Standardized API error responses           │  │
│  └────────────────────────────────────────────────────────────┘  │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
│                                                                 │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  PostgreSQL 16  │  │  AWS S3      │  │  Pinecone         │  │
│  │  (Alpine,       │  │  (M2+)      │  │  Serverless (M3+) │  │
│  │   Docker)       │  │              │  │                   │  │
│  │                │  │  Bucket:     │  │  • Per-tenant     │  │
│  │  • firms       │  │  trueblue-  │  │    namespaces     │  │
│  │  • users       │  │  documents- │  │  • Vector         │  │
│  │  • refresh_    │  │  prod       │  │    embeddings     │  │
│  │    tokens      │  │  • PDF      │  │                   │  │
│  │  • documents   │  │    storage  │  │                   │  │
│  │    (M2+)       │  │  • Path:    │  │                   │  │
│  │                │  │   /{firmId}/│  │                   │  │
│  │  Port 5432     │  │   docs/    │  │                   │  │
│  │  (internal)    │  │            │  │                   │  │
│  └─────────────────┘  └──────────────┘  └───────────────────┘  │
│                                                                 │
│  ┌─────────────────┐                                           │
│  │   OpenAI API   │                                           │
│  │   (M3+)       │                                           │
│  │                │                                           │
│  │  • GPT-4o-mini │                                           │
│  │  • Embeddings  │                                           │
│  │  • Vendor-     │                                           │
│  │    agnostic    │                                           │
│  │    abstraction │                                           │
│  └─────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication Flow

```
┌──────┐          ┌──────────┐         ┌────────────┐       ┌──────────┐
│Client│          │Middleware │         │ API Route  │       │PostgreSQL│
└──┬───┘          └────┬─────┘         └─────┬──────┘       └────┬─────┘
   │                   │                     │                   │
   │ POST /api/auth/login                    │                   │
   │ {email, password} │                     │                   │
   │──────────────────>│                     │                   │
   │                   │                     │                   │
   │    (public route — pass through)        │                   │
   │                   │────────────────────>│                   │
   │                   │                     │                   │
   │                   │                     │  Find user by     │
   │                   │                     │  email            │
   │                   │                     │──────────────────>│
   │                   │                     │     User record   │
   │                   │                     │<──────────────────│
   │                   │                     │                   │
   │                   │                     │  Verify password  │
   │                   │                     │  (bcrypt)         │
   │                   │                     │                   │
   │                   │                     │  Create refresh   │
   │                   │                     │  token in DB      │
   │                   │                     │──────────────────>│
   │                   │                     │                   │
   │                   │                     │  Sign JWT access  │
   │                   │                     │  + refresh tokens │
   │                   │                     │  (jose / HS256)   │
   │                   │                     │                   │
   │  Set-Cookie: tb_access (httpOnly, 15m)  │                   │
   │  Set-Cookie: tb_refresh (httpOnly, 7d)  │                   │
   │  {user: {...}}    │                     │                   │
   │<────────────────────────────────────────│                   │
   │                   │                     │                   │
   │ GET /api/auth/me  │                     │                   │
   │ Cookie: tb_access │                     │                   │
   │──────────────────>│                     │                   │
   │                   │                     │                   │
   │    Verify JWT     │                     │                   │
   │    Inject headers:│                     │                   │
   │    x-user-id      │                     │                   │
   │    x-user-role    │                     │                   │
   │    x-user-firm-id │                     │                   │
   │                   │────────────────────>│                   │
   │                   │                     │  Query user by ID │
   │                   │                     │──────────────────>│
   │                   │                     │<──────────────────│
   │  {user: {...}}    │                     │                   │
   │<────────────────────────────────────────│                   │
```

## Token Refresh (Rotation)

```
1. Client sends request with expired tb_access cookie
2. Middleware returns 401 "Token expired"
3. Client calls POST /api/auth/refresh with tb_refresh cookie
4. Server verifies refresh JWT -> extracts tokenId
5. Server looks up tokenId in refresh_tokens table
6. Server DELETES old token (one-time use)
7. Server creates NEW refresh token record
8. Server signs new access + refresh JWTs
9. Server returns new cookies
10. Client retries original request
```

Each refresh token can only be used once. If a stolen token is reused after the legitimate user has already refreshed, the lookup fails and the session is invalidated.

## Technology Stack

| Component | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 16 + Tailwind CSS 4 | Pages, SSR, API routes |
| Language | TypeScript | Type safety across frontend and backend |
| Database | PostgreSQL 16 (Docker local + staging / RDS production) | Users, firms, tokens, metadata |
| ORM | Prisma 5 (`binaryTargets: ["native", "debian-openssl-3.0.x"]`) | Schema management, migrations, typed queries |
| Auth | jose (HS256 JWT) + bcrypt (native) | Token signing/verification, password hashing |
| UI Components | Aceternity UI (BackgroundGradientAnimation) | Animated landing page effects |
| Utilities | clsx + tailwind-merge (cn utility) | Class name management |
| Icons | lucide-react | Icon library |
| Reverse Proxy | Nginx (Alpine) | Rate limiting, security headers, port 80 -> 3000 |
| Containerization | Docker + Docker Compose | Local dev, staging deployment |
| Vector DB | Pinecone Serverless (M3+) | Document embeddings with per-tenant namespaces |
| LLM | OpenAI GPT-4o-mini (M3+) | RAG responses, vendor-agnostic abstraction |
| OCR | AWS Textract (M5) | Scanned PDF text extraction |
| File Storage | AWS S3 (M2+) | PDF document storage |

## Docker Architecture

### Multi-stage Dockerfile

```
Stage 1: deps
  Base: node:20-slim
  Purpose: Install npm dependencies only (cached layer)

Stage 2: builder
  Base: node:20-slim
  Installs: python3, make, g++ (required for bcrypt native compilation)
  Runs: npx prisma generate, npm run build
  Output: Next.js standalone build

Stage 3: runner
  Base: node:20-slim
  Copies: standalone server.js, static assets, public files, prisma client
  Runs as: nextjs user (non-root)
  Exposes: port 3000 (internal only)
```

### Docker Compose Services (docker-compose.prod.yml)

```
┌─────────────────────────────────────────────────────────┐
│                Docker Compose Network                    │
│                                                         │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────┐   │
│  │    db     │  │    app    │  │      nginx        │   │
│  │           │  │           │  │                   │   │
│  │ PostgreSQL│  │  Next.js  │  │  Reverse Proxy    │   │
│  │ 16-alpine │  │ Standalone│  │  Alpine           │   │
│  │           │  │           │  │                   │   │
│  │ Port 5432 │  │ Port 3000 │  │ Port 80 (exposed) │   │
│  │ (internal)│  │ (internal)│  │                   │   │
│  └───────────┘  └───────────┘  └───────────────────┘   │
│                                                         │
│  ┌───────────┐                                          │
│  │  migrate  │  (profile: setup)                        │
│  │  One-shot │  Runs: npx prisma migrate deploy         │
│  └───────────┘                                          │
└─────────────────────────────────────────────────────────┘
```

## Deployment Topology

### Local Development
```
Host Machine
├── PostgreSQL 16 via Docker Compose (port 5432)
└── Next.js dev server on host (port 3000, npm run dev)
```

### Staging (Current — EC2)
```
AWS EC2 (t3.small, Amazon Linux 2023)
├── Docker Compose
│   ├── PostgreSQL 16 Alpine (port 5432, internal only)
│   ├── Next.js app / Debian slim (port 3000, internal only)
│   └── Nginx Alpine (port 80, exposed to internet)
├── Elastic IP: 54.208.102.72
├── Security Group: SSH restricted to 139.135.38.242/32, HTTP open
├── IMDSv2 enforced
└── Deploy key: read-only ED25519 for GitHub
```

### Production (Future — M4+)
```
AWS
├── EC2 or ECS
│   └── Docker containers: Next.js app + Nginx
├── RDS PostgreSQL (AES-256 at rest, automated backups)
├── S3 bucket (AES-256 at rest, per-tenant paths)
├── Pinecone Serverless (per-tenant namespaces)
├── ACM certificate + domain (TLS termination)
└── CloudWatch monitoring + alerting
```

### Phase 2 Upgrade Path
```
AWS
├── ECS / Kubernetes cluster
│   ├── Next.js container (auto-scaling)
│   └── Load balancer (ALB)
├── RDS PostgreSQL (same — scales independently)
├── S3 (same — scales independently)
├── Pinecone Serverless (same — scales independently)
└── CloudWatch monitoring + alerting
```

No application code changes required for Phase 2 — only orchestration and infrastructure.

## Pages

| Route | Description |
|---|---|
| `/` | Landing/gateway page — animated gradient background (BackgroundGradientAnimation), glass card with Sign in + Register CTAs |
| `/login` | Login page |
| `/register` | Registration page |
| `/dashboard` | Authenticated dashboard — plain background, shows user info |

## Security Configuration

### Nginx Rate Limiting
- `/api/auth/*` endpoints: 5 requests/second per IP
- `/api/*` endpoints: 10 requests/second per IP

### Security Headers (applied by both Nginx and next.config.ts)
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- X-XSS-Protection: 1; mode=block
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy: restricted

### Cookie Security
- `USE_SECURE_COOKIES` env var decouples cookie `Secure` flag from `NODE_ENV`
- Staging: `USE_SECURE_COOKIES=false` (HTTP only, no SSL yet)
- Production: `USE_SECURE_COOKIES=true` (after SSL is configured)
