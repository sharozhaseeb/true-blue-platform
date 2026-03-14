# True Blue Financial Intelligence Platform

Secure, multi-tenant document-based AI platform for tax professionals.

## Tech Stack

- **Next.js 16** — Frontend pages + API routes
- **TypeScript** — Full type safety
- **Tailwind CSS** — Styling
- **PostgreSQL 16** — Database
- **Prisma 5** — ORM and migrations
- **jose** — JWT authentication (Edge-compatible)
- **bcrypt** — Password hashing
- **Docker** — Local development and deployment

## Prerequisites

- Node.js 20+
- Docker Desktop

## Getting Started

```bash
# 1. Clone the repo
git clone <repo-url>
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
│   ├── schema.prisma          # Database schema
│   ├── seed.ts                # Test data seeder
│   └── migrations/            # Migration history
├── src/
│   ├── app/
│   │   ├── (auth)/            # Public pages (login, register)
│   │   ├── (dashboard)/       # Authenticated pages
│   │   └── api/auth/          # Auth API routes
│   ├── lib/                   # Core utilities
│   │   ├── auth.ts            # JWT + cookie helpers
│   │   ├── password.ts        # bcrypt helpers
│   │   ├── prisma.ts          # DB client singleton
│   │   ├── tenant.ts          # Tenant context + access control
│   │   ├── rbac.ts            # Role-permission mapping
│   │   └── errors.ts          # API error responses
│   ├── middleware.ts           # Auth + RBAC middleware
│   └── types/                 # Shared TypeScript types
├── docs/
│   ├── architecture-diagram.md
│   └── tenant-isolation-strategy.md
├── docker-compose.yml
└── .env.example
```

## Documentation

- [Architecture Diagram](docs/architecture-diagram.md)
- [Tenant Isolation Strategy](docs/tenant-isolation-strategy.md)
