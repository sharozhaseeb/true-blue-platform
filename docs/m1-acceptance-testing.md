# Milestone 1 — Acceptance Testing Guide

**Staging URL:** http://54.208.102.72

---

## How Authentication Works

This platform uses **httpOnly JWT cookies** instead of API keys. This is a security best practice — httpOnly cookies cannot be accessed by JavaScript, preventing token theft via XSS attacks. It's the same approach used by Stripe, GitHub, and most modern web platforms.

**What this means for testing:**
- **Browser:** Log in via the UI → cookies are set automatically → navigate to any API URL in the same browser to see the response
- **curl:** Use `-c` to save cookies and `-b` to send them (shown in examples below)
- **Postman:** Make a POST to `/api/auth/login` → Postman stores cookies automatically → subsequent requests include them

---

## Test Accounts

| Email | Password | Role | Firm |
|---|---|---|---|
| admin@trueblue.dev | Admin123! | Platform Admin | — |
| admin@acmetax.com | FirmAdmin1! | Firm Admin | Acme Tax Services |
| user@acmetax.com | FirmUser1! | Firm User | Acme Tax Services |
| admin@besttax.com | FirmAdmin1! | Firm Admin | Best Tax Advisors |

**Firm codes for registration:** `acme-tax`, `best-tax`

---

## Criterion 1: Registration, Login, and JWT

### Test 1a: Register a new user via UI

1. Go to http://54.208.102.72/register
2. Fill in: First name, Last name, Email, Password (min 8 chars, uppercase, lowercase, number)
3. Firm code: enter `acme-tax` (note: this is a slug, not the firm name)
4. Click "Create account"
5. **Expected:** Redirected to dashboard showing your name, role (Firm User), and firm (Acme Tax Services)

### Test 1b: Login via UI

1. Go to http://54.208.102.72/login
2. Email: `admin@acmetax.com`, Password: `FirmAdmin1!`
3. Click "Sign in"
4. **Expected:** Redirected to dashboard showing Alice Admin, Firm Admin, Acme Tax Services

### Test 1c: Verify JWT tokens via curl

```bash
# Login and see the Set-Cookie headers
curl -v http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@acmetax.com","password":"FirmAdmin1!"}' \
  2>&1 | grep "Set-Cookie"

# Expected: Two Set-Cookie headers
#   Set-Cookie: tb_access=eyJ... (JWT access token, 15 min)
#   Set-Cookie: tb_refresh=eyJ... (JWT refresh token, 7 days)
```

### Test 1d: Verify unauthenticated access is blocked

```bash
# No cookies = no access
curl http://54.208.102.72/api/auth/me
# Expected: {"error":"Unauthorized"} (401)

# Dashboard page redirects to login
curl -v http://54.208.102.72/dashboard 2>&1 | grep "Location"
# Expected: 307 redirect to /login
```

---

## Criterion 2: Tenant Isolation

### Test 2a: Browser test (simplest)

1. Log in as `user@acmetax.com` / `FirmUser1!` via the UI
2. In the same browser, navigate to: `http://54.208.102.72/api/test/tenant-check`
3. **Expected:** JSON showing `yourFirm: "Acme Tax Services"`, `otherFirmsVisible: 0`
4. Log out, log in as `admin@besttax.com` / `FirmAdmin1!`
5. Navigate to the same URL again
6. **Expected:** JSON showing `yourFirm: "Best Tax Advisors"`, `otherFirmsVisible: 0`

### Test 2b: curl test (compare across firms)

```bash
# Login as Acme Tax user
curl -c acme.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"user@acmetax.com","password":"FirmUser1!"}'

# Check tenant isolation
curl -b acme.txt http://54.208.102.72/api/test/tenant-check
# Expected:
# {
#   "test": "tenant_isolation",
#   "scope": "single_firm",
#   "yourFirm": "Acme Tax Services",
#   "yourFirmUserCount": 2,
#   "otherFirmsVisible": 0,
#   ...
# }

# Login as Best Tax user
curl -c best.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@besttax.com","password":"FirmAdmin1!"}'

# Check tenant isolation
curl -b best.txt http://54.208.102.72/api/test/tenant-check
# Expected:
# {
#   "test": "tenant_isolation",
#   "scope": "single_firm",
#   "yourFirm": "Best Tax Advisors",
#   "yourFirmUserCount": 1,
#   "otherFirmsVisible": 0,
#   ...
# }
```

### Test 2c: Verify it's a live query (not hardcoded)

1. Register a new user under `acme-tax` (via UI or curl)
2. Call `/api/test/tenant-check` again as an Acme Tax user
3. **Expected:** `yourFirmUserCount` increases by 1

### Test 2d: Platform Admin sees all firms

```bash
curl -c admin.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@trueblue.dev","password":"Admin123!"}'

curl -b admin.txt http://54.208.102.72/api/test/tenant-check
# Expected: scope "all_firms" with both firms listed
```

### How Tenant Isolation Works

```
Request → Nginx (strips injected x-user-* headers)
       → Middleware (validates JWT, extracts firmId from token)
       → API Route (reads firmId from trusted headers, scopes all queries)
       → Response (only authenticated user's firm data)
```

---

## Criterion 3: Role-Based Access Control (RBAC)

### Test 3a: Browser test (simplest)

1. Log in as `user@acmetax.com` / `FirmUser1!` via the UI
2. Navigate to: `http://54.208.102.72/api/test/rbac-check`
3. **Expected:** role "FIRM_USER", 3 granted permissions, 3 denied
4. Log out, log in as `admin@trueblue.dev` / `Admin123!`
5. Navigate to the same URL
6. **Expected:** role "PLATFORM_ADMIN", 6 granted, 0 denied

### Test 3b: curl test (all three roles)

```bash
# As Platform Admin (6 granted, 0 denied)
curl -b admin.txt http://54.208.102.72/api/test/rbac-check

# As Firm Admin (4 granted, 2 denied: manage_firms, manage_all_users)
curl -c firm_admin.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@acmetax.com","password":"FirmAdmin1!"}'
curl -b firm_admin.txt http://54.208.102.72/api/test/rbac-check

# As Firm User (3 granted, 3 denied: manage_firms, manage_all_users, manage_firm_users)
curl -b acme.txt http://54.208.102.72/api/test/rbac-check
```

### Test 3c: Middleware blocking (direct 403 proof)

```bash
# Firm User tries an admin endpoint → BLOCKED (403)
curl -b acme.txt http://54.208.102.72/api/admin/anything
# Expected: {"error":"Forbidden"}

# Platform Admin tries the same endpoint → ALLOWED (404 because admin panel is M6, but NOT 403)
curl -b admin.txt http://54.208.102.72/api/admin/anything
# Expected: 404 (middleware allowed it through — endpoint doesn't exist yet)
```

The difference: Firm User gets **403 Forbidden** (blocked by middleware). Platform Admin gets **404 Not Found** (middleware allowed the request — the endpoint itself just isn't built until M6).

### RBAC Permission Matrix

| Permission | Platform Admin | Firm Admin | Firm User |
|---|:---:|:---:|:---:|
| manage_firms | Yes | — | — |
| manage_all_users | Yes | — | — |
| manage_firm_users | Yes | Yes | — |
| view_firm_data | Yes | Yes | Yes |
| upload_documents | Yes | Yes | Yes |
| query_documents | Yes | Yes | Yes |

---

## Criterion 4: Architecture Diagram and Tenant Isolation Strategy

Delivered as separate attached documents:

1. **Architecture Diagram** (`docs/architecture-diagram.md`) — System architecture, auth flow, token refresh sequence, Docker setup, deployment topology, tech stack, security configuration
2. **Tenant Isolation Strategy** (`docs/tenant-isolation-strategy.md`) — 5-layer isolation model (JWT binding, middleware enforcement, query scoping, RBAC, storage isolation), RLS rationale, verification steps

---

## Criterion 5: Login and Registration Pages

1. **Landing page:** http://54.208.102.72 — Animated gradient background, glass card with Sign in / Register buttons
2. **Login:** http://54.208.102.72/login — Email/password form with error handling and loading states
3. **Register:** http://54.208.102.72/register — Full registration form with firm code field
4. **Dashboard:** http://54.208.102.72/dashboard — Shows user name, email, role badge, firm name (after login)
5. **Logout:** Click "Sign out" in dashboard nav → returns to login page

---

## Note on Test Endpoints

The `/api/test/tenant-check` and `/api/test/rbac-check` endpoints are **staging-only**. They are gated behind an environment variable (`ENABLE_TEST_ENDPOINTS`) and return 404 in production environments. They exist solely for acceptance testing verification.
