# True Blue Financial Intelligence Platform

Secure, multi-tenant document-based AI platform for tax professionals.

## Staging URL

**http://54.208.102.72** (HTTP only — no SSL yet)

## Tech Stack

- **Next.js 16** — Frontend pages + API routes (standalone output mode)
- **TypeScript** — Full type safety
- **Tailwind CSS 4** — Styling
- **PostgreSQL 16** — Database (Docker for local + staging, RDS for production)
- **Prisma 5** — ORM and migrations (`binaryTargets: ["native", "debian-openssl-3.0.x"]`)
- **jose** — JWT authentication (Edge-compatible, HS256)
- **bcrypt** — Native password hashing (compiled with python3/make/g++ in Docker)
- **Nginx** — Reverse proxy (rate limiting, security headers)
- **Aceternity UI** — BackgroundGradientAnimation for landing page
- **clsx + tailwind-merge** — Utility class management (cn helper)
- **lucide-react** — Icon library
- **Docker + Docker Compose** — Local development and staging deployment

## Prerequisites

- Node.js 20+
- Docker Desktop

## Getting Started

```bash
# 1. Clone the repo
git clone git@github.com:sharozhaseeb/true-blue-platform.git
cd true-blue-platform

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your own JWT secrets for production

# 4. Start PostgreSQL
docker compose up -d

# 5. Run database migrations
npx prisma migrate dev

# 6. Seed test data
npx prisma db seed

# 7. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Pages

| Route | Description |
|---|---|
| `/` | Landing/gateway page — animated gradient background, glass card, Sign in + Register CTAs |
| `/login` | Login page |
| `/register` | Registration page |
| `/dashboard` | Authenticated dashboard — plain background, shows user info |

## Test Accounts

| Email | Password | Role | Firm |
|---|---|---|---|
| admin@trueblue.dev | Admin123! | Platform Admin | — |
| admin@acmetax.com | FirmAdmin1! | Firm Admin | Acme Tax Services |
| user@acmetax.com | FirmUser1! | Firm User | Acme Tax Services |
| admin@besttax.com | FirmAdmin1! | Firm Admin | Best Tax Advisors |

**Firm codes for registration:** `acme-tax`, `best-tax`

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed the database |
| `npm run db:reset` | Reset database and re-seed |
| `npm run db:studio` | Open Prisma Studio (DB GUI) |
| `npm run docker:up` | Start Docker services |
| `npm run docker:down` | Stop Docker services |

## API Endpoints

### Authentication

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| POST | `/api/auth/register` | Register new user | Public |
| POST | `/api/auth/login` | Login, receive JWT | Public |
| POST | `/api/auth/refresh` | Refresh access token | Cookie |
| POST | `/api/auth/logout` | Logout, clear tokens | Cookie |
| GET | `/api/auth/me` | Get current user profile | Required |

## Project Structure

```
true-blue-platform/
├── prisma/
│   ├── schema.prisma          # Database schema (binaryTargets for Debian)
│   ├── seed.ts                # Test data seeder
│   └── migrations/            # Migration history
├── src/
│   ├── app/
│   │   ├── page.tsx           # Landing page (animated gradient)
│   │   ├── (auth)/            # Auth pages + shared layout
│   │   │   ├── layout.tsx     # Animated background + footer
│   │   │   ├── login/         # Login page
│   │   │   └── register/      # Registration page
│   │   ├── (dashboard)/       # Authenticated pages
│   │   │   ├── layout.tsx     # Nav bar + logout
│   │   │   └── dashboard/     # Dashboard page
│   │   └── api/auth/          # Auth API routes
│   ├── components/
│   │   └── ui/                # UI components (Aceternity)
│   ├── lib/                   # Core utilities
│   │   ├── auth.ts            # JWT + cookie helpers (lazy secrets, USE_SECURE_COOKIES)
│   │   ├── fetch-with-auth.ts # Auto-refresh fetch wrapper (handles 401 + token rotation)
│   │   ├── password.ts        # bcrypt helpers
│   │   ├── prisma.ts          # DB client singleton
│   │   ├── tenant.ts          # Tenant context + access control
│   │   ├── rbac.ts            # Role-permission mapping
│   │   ├── errors.ts          # API error responses
│   │   └── utils.ts           # cn() class utility
│   ├── middleware.ts           # Auth + RBAC middleware
│   └── types/                 # Shared TypeScript types
├── nginx/
│   └── nginx.conf             # Reverse proxy config (rate limiting, security headers)
├── scripts/
│   └── test-build.sh          # Local Docker build verification
├── docs/
│   ├── architecture-diagram.md
│   ├── tenant-isolation-strategy.md
│   ├── staging-notes.md
│   └── deployment-guide.md
├── Dockerfile                 # Multi-stage: deps -> builder (Debian slim) -> runner
├── docker-compose.yml         # Local development (PostgreSQL only)
├── docker-compose.prod.yml    # Staging/production (db + app + nginx + migrate)
├── .dockerignore
├── .env.example               # Environment variable template
├── .env.staging               # Staging environment template
└── public/
    └── .gitkeep               # Prevents Docker COPY failure on empty dir
```

## Documentation

- [Architecture Diagram](docs/architecture-diagram.md) — System architecture, Docker setup, tech stack, deployment topology
- [Tenant Isolation Strategy](docs/tenant-isolation-strategy.md) — Multi-tenancy model, RBAC, query scoping
- [Staging Notes](docs/staging-notes.md) — AWS resource IDs, SSH access, deferred items
- [Deployment Guide](docs/deployment-guide.md) — Complete step-by-step deployment procedure, troubleshooting
