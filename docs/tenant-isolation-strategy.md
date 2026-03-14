# Tenant Isolation Strategy — True Blue Financial Intelligence Platform

## Overview

The platform uses a **single-database, shared-schema** multi-tenancy model where all tenants share the same PostgreSQL database and tables. Isolation is enforced at the **application layer** through a combination of middleware, service-layer query scoping, and role-based access control.

**Tenant model:** 1 firm = 1 tenant. Each user belongs to exactly one firm (except Platform Admins, who operate across all firms).

## Isolation Layers

### Layer 1: JWT Token — Identity & Tenant Binding

Every authenticated user receives a JWT access token containing:

```json
{
  "userId": "clxyz...",
  "email": "user@acmetax.com",
  "role": "FIRM_USER",
  "firmId": "clxyz..."
}
```

- The `firmId` is set at registration and cannot be changed by the user.
- Platform Admins have `firmId: null` — they are not bound to any single firm.
- Tokens are signed with HS256 and stored in httpOnly cookies — not accessible via JavaScript.

### Layer 2: Middleware — Context Injection

The Next.js middleware (`src/middleware.ts`) runs before every request:

1. Validates the JWT access token from the `tb_access` cookie.
2. Extracts `userId`, `role`, and `firmId` from the token payload.
3. Injects these values as request headers:
   - `x-user-id`
   - `x-user-role`
   - `x-user-firm-id`
4. API routes read these headers — they never parse the JWT themselves.

This guarantees that every API route receives verified, tamper-proof user context.

### Layer 3: Service Layer — Query Scoping

Every API route that accesses tenant-scoped data uses the `getRequestContext()` helper (`src/lib/tenant.ts`) to extract the authenticated user's firm context:

```typescript
const ctx = await getRequestContext();
// ctx = { userId, role, firmId }
```

All database queries for tenant-scoped resources include a `WHERE firmId = ctx.firmId` filter:

```typescript
// Example: fetching documents for the current tenant
const documents = await prisma.document.findMany({
  where: { firmId: ctx.firmId },
});
```

**Platform Admins** can optionally query across firms or target a specific firm. The `enforceTenantAccess()` helper checks this:

```typescript
if (!enforceTenantAccess(ctx, resource.firmId)) {
  return forbidden("Access denied");
}
```

### Layer 4: Role-Based Access Control (RBAC)

Three roles with hierarchical permissions (`src/lib/rbac.ts`):

| Permission | Platform Admin | Firm Admin | Firm User |
|---|:---:|:---:|:---:|
| manage_firms | Yes | — | — |
| manage_all_users | Yes | — | — |
| manage_firm_users | Yes | Yes | — |
| view_firm_data | Yes | Yes | Yes |
| upload_documents | Yes | Yes | Yes |
| query_documents | Yes | Yes | Yes |

- **Platform Admin**: Full access across all firms. No `firmId` binding.
- **Firm Admin**: Can manage users within their firm. Cannot see other firms' data.
- **Firm User**: Can view, upload, and query within their firm. Cannot manage users.

RBAC is enforced at two levels:
1. **Middleware**: Admin-only route patterns (e.g., `/api/admin/*`) are blocked for non-admin roles.
2. **API Routes**: Individual endpoints check permissions using `hasPermission(ctx.role, "permission_name")`.

### Layer 5: Data Storage Isolation (M2+)

When file storage and vector databases are added:

**AWS S3:**
- Documents stored under tenant-prefixed paths: `s3://bucket/{firmId}/documents/`
- A user from Firm A cannot construct a path to access Firm B's files — the `firmId` comes from the authenticated JWT, not from user input.

**Pinecone Vector DB:**
- Per-tenant namespaces: each firm's document embeddings are stored in a separate namespace.
- Queries are scoped to the authenticated user's namespace — no cross-tenant vector search is possible.

## Why Not Postgres Row-Level Security (RLS)?

We chose **application-enforced** query scoping over Postgres RLS for these reasons:

1. **Prisma compatibility**: Prisma uses connection pooling. RLS policies are set per-connection (`SET app.current_tenant = ...`), which conflicts with pooled connections that may be reused across tenants.
2. **Visibility**: Application-layer filtering is explicit in code — easier to audit, test, and debug.
3. **Flexibility**: Platform Admins need to bypass tenant filtering. With RLS, this requires switching between policies or using `SECURITY DEFINER` functions, adding complexity.
4. **Consistent enforcement**: The same `getRequestContext()` pattern applies to all data sources (PostgreSQL, S3, Pinecone), not just the database.

## Testing Tenant Isolation

### Seed Data

The database is seeded with two test firms:

| Firm | Slug | Users |
|---|---|---|
| Acme Tax Services | `acme-tax` | admin@acmetax.com (Firm Admin), user@acmetax.com (Firm User) |
| Best Tax Advisors | `best-tax` | admin@besttax.com (Firm Admin) |

Plus one Platform Admin: admin@trueblue.dev

### Verification Steps

1. **Cross-tenant API access**: Log in as `user@acmetax.com`, call any data endpoint. Log in as `admin@besttax.com`, call the same endpoint. Verify each user only sees their own firm's data.

2. **RBAC enforcement**: Log in as `user@acmetax.com` (FIRM_USER), attempt to call admin-only endpoints (e.g., `/api/admin/firms`). Verify 403 Forbidden response.

3. **Token tampering**: Modify the `tb_access` cookie value. Verify the middleware rejects the request with 401.

4. **Missing tenant context**: Send a request without cookies to a protected endpoint. Verify redirect to `/login` (pages) or 401 (API).

## Summary

```
Request
  │
  ▼
Middleware ──► Validate JWT ──► Extract firmId ──► Inject headers
  │
  ▼
API Route ──► getRequestContext() ──► firmId from headers
  │
  ▼
Database Query ──► WHERE firmId = ctx.firmId
  │
  ▼
Response ──► Only tenant-scoped data returned
```

Every layer reinforces the one before it. No single point of failure — even if one layer is bypassed, the next layer prevents cross-tenant data access.
