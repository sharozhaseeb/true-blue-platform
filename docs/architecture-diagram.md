# Architecture Overview — True Blue Financial Intelligence Platform

## System Architecture (Phase 1)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Browser                           │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│   │  Login   │  │ Register │  │Dashboard │  │ Chat (M4)    │   │
│   │  Page    │  │  Page    │  │  Page    │  │ Docs (M5)    │   │
│   │         │  │         │  │         │  │ Admin (M6)   │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Next.js Application                           │
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
│  │   PostgreSQL    │  │  AWS S3      │  │  Pinecone         │  │
│  │   (RDS)        │  │  (M2+)      │  │  Serverless (M3+) │  │
│  │                │  │              │  │                   │  │
│  │  • firms       │  │  • PDF       │  │  • Per-tenant     │  │
│  │  • users       │  │    storage   │  │    namespaces     │  │
│  │  • refresh_    │  │  • Path:     │  │  • Vector         │  │
│  │    tokens      │  │    /{firmId}/│  │    embeddings     │  │
│  │  • documents   │  │    docs/     │  │                   │  │
│  │    (M2+)       │  │              │  │                   │  │
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
4. Server verifies refresh JWT → extracts tokenId
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
| Frontend | Next.js 16 + Tailwind CSS | Pages, SSR, API routes |
| Language | TypeScript | Type safety across frontend and backend |
| Database | PostgreSQL 16 (Docker local / RDS production) | Users, firms, tokens, metadata |
| ORM | Prisma 5 | Schema management, migrations, typed queries |
| Auth | jose (HS256 JWT) + bcrypt | Token signing/verification, password hashing |
| Vector DB | Pinecone Serverless (M3+) | Document embeddings with per-tenant namespaces |
| LLM | OpenAI GPT-4o-mini (M3+) | RAG responses, vendor-agnostic abstraction |
| OCR | AWS Textract (M5) | Scanned PDF text extraction |
| File Storage | AWS S3 (M2+) | PDF document storage |
| Containerization | Docker + Docker Compose | Local dev, production portability |

## Deployment Topology

### Local Development (Current)
```
Docker Compose
├── PostgreSQL 16 (port 5432)
└── Next.js dev server (port 3000, runs on host)
```

### Production (M4 — Staging)
```
AWS
├── EC2 instance
│   └── Docker container: Next.js app
├── RDS PostgreSQL (AES-256 at rest)
├── S3 bucket (AES-256 at rest, per-tenant paths)
├── Pinecone Serverless (per-tenant namespaces)
└── ALB + ACM certificate (TLS termination)
```

### Phase 2 Upgrade Path
```
AWS
├── ECS / Kubernetes cluster
│   ├── Next.js container (auto-scaling)
│   └── Load balancer
├── RDS PostgreSQL (same — scales independently)
├── S3 (same — scales independently)
├── Pinecone Serverless (same — scales independently)
└── CloudWatch monitoring + alerting
```

No application code changes required for Phase 2 — only orchestration and infrastructure.
