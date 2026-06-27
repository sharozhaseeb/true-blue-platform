# Milestone 4 — Client Acceptance Testing Guide

**Stakeholder URL:** http://52.70.0.80
**Milestone:** Output Generation, Testing & Deployment
**Build tag:** `m4-20260627-191552-ed97574` (app + worker)
**Structured output schema:** `trueblue.chat.output.v1`
**Prerequisite:** Milestone 3 (vector database & grounded AI chat) is available

**Current AI/retrieval providers:** Client-owned OpenAI key + Pinecone configured on staging.

**Important — read before uploading anything:** The current stakeholder environment is served over **HTTP, not HTTPS**, and the application does **not yet redact PII** (SSN, bank/account numbers, email, phone) from answers. For M4 acceptance testing, use **only non-sensitive or redacted sample PDFs**. Do **not** upload real client tax documents until TLS/HTTPS and an output-layer redaction pass are complete or the risk is explicitly waived in writing. Open `http://52.70.0.80/login` directly with `http://`, not `https://`.

---

## Contents

- [What This Milestone Proves](#what-this-milestone-proves)
- [What M4 Delivers (Mapped to Scope)](#what-m4-delivers-mapped-to-scope)
- [Access](#access)
- [Test Environment](#test-environment)
- [Pre-Verified Evidence (Already Run)](#pre-verified-evidence-already-run)
- [Before You Start](#before-you-start)
- [UAT Test Matrix](#uat-test-matrix)
- [Detailed Test Walkthroughs](#detailed-test-walkthroughs)
- [Scope and Limitations](#scope-and-limitations)
- [Acceptance Criteria Checklist](#acceptance-criteria-checklist)
- [Sign-off](#sign-off)

---

## What This Milestone Proves

Milestone 4 validates the complete document Q&A path from upload through a **structured, source-cited response**, delivered through a chat interface on a deployed staging environment.

Scope acceptance criteria being tested (from the Phase 1 Statement of Work):

1. **End-to-end flow is functional:** upload a PDF, query it, and receive a **structured JSON response with source citations**.
2. **Output conforms to the agreed JSON schema** (`trueblue.chat.output.v1`).
3. **Chat interface allows query submission and displays structured responses with source citations.**
4. **System is deployed and accessible at the agreed endpoint/URL.**
5. **Deployment documentation is sufficient for an engineer to redeploy independently.**

What M4 deliberately does **not** cover (so testing stays in scope):

- OCR for scanned/image-only PDFs — **Milestone 5**.
- The full tax-domain **8-section advisory report**, tax-strategy categorization, advice disclaimers, usage dashboards, and admin rate-limit controls — **Milestone 6**. M4 proves the *grounded, source-cited structured envelope*, not advisory generation.
- Live LLM/provider swap as a UI action — that is an operator deployment step, not a client UAT step.

---

## What M4 Delivers (Mapped to Scope)

| SOW deliverable | What was built | Where to verify |
|---|---|---|
| Structured JSON output format (response text, source references, page/section metadata, confidence/relevance) | Server-built `trueblue.chat.output.v1` envelope: `responseText`, `sources[]`, `coverage`, `support` (confidence label + basis + retrieval mode), `warnings`, `metadata`. The LLM does not author this envelope; the server builds it from the finalized answer and final citations. | TC-02; `docs/m4-structured-output-contract.md` |
| Configurable output template engine with support for client-defined schemas | Registered templates `rag_qa.default.v1` (default) and `rag_qa.compact.v1`. Unknown templates are rejected. **Client-defined schemas are supported as approved/registered templates, not arbitrary runtime JSON schemas** (see Limitation 2). | TC-05 |
| Chat/query interface with citations | Redesigned full-bleed chat workspace: query input, streamed answer with inline `[S1]` markers, source selection, citation detail (filename + page + snippet), an **Insights** view and a **Raw / Structured JSON** view, and a per-answer action bar (Copy / Regenerate). | TC-06, TC-07, TC-08 |
| End-to-end pipeline testing (upload → process → embed → query → response) | Automated staging E2E (`m4-e2e-report.json`) plus a frontend Playwright smoke and a manual browser pass. | TC-01; [Pre-Verified Evidence](#pre-verified-evidence-already-run) |
| Deployment to agreed staging environment | Deployed to `http://52.70.0.80` (AWS account `536573256060`), build tag `m4-20260627-191552-ed97574`. | TC-10 |
| Deployment documentation | `docs/m4-deployment-notes.md`, `docs/m4-structured-output-contract.md`, this guide. | TC-11 |

---

## Access

**URL:** http://52.70.0.80 (HTTP only — see the caveat at the top of this document).

### Test accounts (staging seed)

| Email | Password | Role | Firm |
|---|---|---|---|
| admin@acmetax.com | FirmAdmin1! | Firm Admin | Acme Tax Services |
| user@acmetax.com | FirmUser1! | Firm User | Acme Tax Services |
| admin@besttax.com | FirmAdmin1! | Firm Admin | Best Tax Advisors |
| admin@trueblue.dev | Admin123! | Platform Admin | All firms |

Recommended account for most browser checks:

```text
admin@acmetax.com / FirmAdmin1!
```

Use `admin@besttax.com` only for the tenant-isolation check (TC-09). The Platform Admin account is **not** the primary document Q&A account, because M4 chat and upload are firm-scoped.

Registration firm codes (if you create your own user): `acme-tax`, `best-tax`.

> These are **throwaway** staging passwords on an HTTP environment. Do not reuse them anywhere real.

### Sample PDFs

Use the same non-sensitive sample tax returns used for M2/M3. Good M4 candidates:

- `2025 Tax Return Documents (Whittaker Jordan).pdf` (25 pages — the pre-verified E2E document)
- `2025 Tax Return Documents (Jimenez Julio).pdf`
- `2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf`

At least one text-based PDF must be uploaded or already present with status `COMPLETED`.

---

## Test Environment

| Property | Value |
|---|---|
| Endpoint | `http://52.70.0.80` (HTTP only) |
| Build tag | `m4-20260627-191552-ed97574` (app + worker) |
| AWS account | `536573256060`, region `us-east-1` |
| Feature flags | `ENABLE_AI_CHAT`, `ENABLE_VECTOR_RETRIEVAL`, `ENABLE_VECTOR_INDEXING`, `ENABLE_TEXTRACT_PIPELINE` = **true** |
| Vector index | Tenant-scoped Pinecone vector index (embedding model `text-embedding-3-small`, 1536-dim), per-firm namespaces |
| Schema version | `trueblue.chat.output.v1` |
| DB migration | `20260623090000_add_chat_thread_output_template` applied (adds `chat_threads.outputTemplate`); pre-migration backup taken |
| Secrets present | `OPENAI_API_KEY`, `PINECONE_API_KEY` configured on staging |

If the `Sources` area shows no completed documents, upload one sample PDF (UI or API) and wait for `COMPLETED` before continuing.

---

## Pre-Verified Evidence (Already Run)

Several acceptance items were verified by the engineering team before this guide was shared. They are marked **Pre-verified** in the matrix. The client is welcome to re-run any of them; the evidence below is provided so the matrix can be signed off efficiently.

**1. Automated staging E2E — `m4-e2e-report.json` (run 2026-06-27, `http://52.70.0.80`, zero failures):**

- Uploaded `2025 Tax Return Documents (Whittaker Jordan).pdf` → processing timeline `PROCESSING → COMPLETED`, **25 pages**.
- Vector index **ACTIVE**: **115 vectors / 115 chunks** in the tenant-scoped Pinecone vector index (embedding model `text-embedding-3-small`, 1536-dim), per-firm namespace.
- Supported question → chat mode **`vector_retrieval`** (not local fallback), `output.schemaVersion = trueblue.chat.output.v1`, `output.status = answered`, **1 source**.
- Unsupported question → `output.status = insufficient_evidence`, **0 sources**.
- Thread replay → reconstructed `data-output`, `schemaVersion = trueblue.chat.output.v1`.

**2. Frontend Playwright smoke (passed):** login, `/dashboard/chat`, source selection, grounded UI question, visible citations, and the Raw/Insights structured-output surface. Screenshots: `output/playwright/m4-staging-chat-smoke.png`, `m4-staging-chat-ui-response.png`, `m4-staging-chat-diagnostic.png`.

**3. Live browser re-check (2026-06-27):** login OK; the redesigned full-bleed chat UI is deployed; documents are indexed; a grounded "filing status" question returned a grounded answer with the cited sources marked **"Used"** and a **Copy / Regenerate** action bar.

---

## Before You Start

1. Open http://52.70.0.80/login (use `http://`).
2. Log in as `admin@acmetax.com`.
3. Open http://52.70.0.80/dashboard/chat.
4. Confirm the chat workspace loads: a query/composer area, a way to select **Sources**, a conversation area, and (after an answer) a structured-output / **Insights** view and a **Raw / Structured JSON** view.

> **Sequential uploads:** uploads are processed **one at a time per app process**. If two testers upload simultaneously, one may see `429 Too Many Requests`. Upload **one document at a time** and wait for `COMPLETED` before the next.

> **Upload size:** keep test PDFs under **20 MB**. The UI accepts files up to 25 MB, but the API rejects files over 20 MB (see Limitation 4). All provided sample PDFs are well under 20 MB.

> **Reporting issues during UAT:** record results in the [Acceptance Criteria Checklist](#acceptance-criteria-checklist) below. Report any failure or question to your EulerTel handoff contact `<NAME / EMAIL — to be filled in>`, attaching the question you asked, the response you received, and a screenshot.

### Optional — API testing notes

Browser testing is sufficient for sign-off. For deeper verification, the API can be exercised with curl or Postman. On Windows, run curl from Git Bash or WSL to avoid quoting issues. Log in with `-c acme.txt` to save cookies and reuse them with `-b acme.txt`; re-run the login if you see `401 Unauthorized`.

```bash
BASE_URL="http://52.70.0.80"

curl -c acme.txt "$BASE_URL/api/auth/login" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"
```

Replace `DOCUMENT_ID` in later commands with the real `id` returned by staging.

---

## UAT Test Matrix

Status legend: **Pre-verified** = run by engineering with cited evidence (re-run optional). **Client-to-run** = recommended for the client to execute during UAT.

| TC | Scope criterion / deliverable | Steps (summary) | Expected result | Evidence / Status |
|---|---|---|---|---|
| **TC-01** | C1 — E2E upload → process → query → structured JSON w/ citations | Upload a text PDF; wait for `COMPLETED`; select it; ask a supported question (e.g. filing status / wages). | Answer is grounded in the document, shows an inline citation (`[S1]`), and the response carries `output.schemaVersion = trueblue.chat.output.v1`, `status = answered`, ≥1 source whose `documentId` is the uploaded doc. | **Pre-verified** (`m4-e2e-report.json`: COMPLETED 25pp; vector index ACTIVE 115/115; mode `vector_retrieval`; answered, 1 source) + **Client-to-run** in browser |
| **TC-02** | C2 — Output conforms to `trueblue.chat.output.v1` | Inspect the API `output` object or the UI **Raw / Structured JSON** view for an answered response. | All required fields present: `schemaVersion`, `templateId`, `templateVersion`, `status`, `responseText`, `sources[]`, `coverage`, `support`, `warnings`, `metadata`. `responseText` matches the visible answer; `sources[]` are final cited sources only with page metadata. | **Pre-verified** (schema version asserted in E2E + contract doc) + **Client-to-run** |
| **TC-03** | C1/C2 — Insufficient-evidence behavior | Against a selected source, ask a question the document cannot answer (e.g. "What spacecraft purchase is in this return?"). | Assistant does not invent an answer; `status = insufficient_evidence`; `sources = []`; warning `INSUFFICIENT_EVIDENCE`; no citations shown. | **Pre-verified** (E2E: `insufficient_evidence`, 0 sources) + **Client-to-run** |
| **TC-04** | C3 — Non-document message hygiene | Ask `hi` (a greeting) with a source selected. | Brief guidance, no citations; `status = non_document`; `sources = []`. | **Client-to-run** |
| **TC-05** | Deliverable — configurable output templates / "client-defined schemas" | Request the compact registered template (`rag_qa.compact.v1`); then request an unregistered template id. | Compact request returns `templateId = rag_qa.compact.v1` with valid cited sources. Unknown template returns **HTTP 400** (rejected). Confirms client-defined schemas are supported as **approved registered templates**, not arbitrary runtime schemas. | **Client-to-run** (API) |
| **TC-06** | C3 — Chat UI shows structured responses + citations | In `/dashboard/chat`, ask a supported question; expand the citation and the structured-output views. | Answer streams into the conversation; inline `[S1]` marker; citation expands to filename + page + snippet; **Insights** view shows status/support/coverage; **Raw / Structured JSON** view shows the full `output` object; cited sources are marked "Used". | **Pre-verified** (Playwright smoke + live browser re-check) + **Client-to-run** |
| **TC-07** | C3 — Thread persistence & replay | Ask a supported question; confirm a History entry; reopen it. | Previous messages reload; the assistant message still shows citations and structured output (`data-output` is reconstructed on replay); the locked source scope is preserved. | **Pre-verified** (E2E: replay has `data-output`) + **Client-to-run** |
| **TC-08** | C3 — Source selection + multi-source coverage honesty | Start a new thread; select 2–3 completed PDFs; ask "For each selected return, what taxpayer name is shown?" | Answer addresses each selected return; if one return lacks evidence for the field, it is explicitly called out (not silently dropped); citations correspond to the documents actually used; `coverage` reflects selected vs cited documents. | **Client-to-run** |
| **TC-09** | Security spot-check — tenant isolation | Confirm Acme docs/chats as `admin@acmetax.com`; sign out; log in as `admin@besttax.com`; confirm Acme data is not visible. (Optional API: request an Acme `DOCUMENT_ID` as Best Tax.) | Best Tax cannot see Acme documents or chats. Cross-tenant document access by ID returns **404** (not 403), preventing ID enumeration. | **Client-to-run** |
| **TC-10** | C4 — Deployed and accessible | Open `http://52.70.0.80/login`; log in; open `/dashboard/chat`. (Optional: `curl -s -o /dev/null -w "%{http_code}" http://52.70.0.80/login` → `200`; `GET /api/auth/me` returns your email.) | Login page loads; login succeeds; dashboard and chat load without server errors at the agreed endpoint. | **Pre-verified** (E2E ran end-to-end against this URL) + **Client-to-run** |
| **TC-11** | C5 — Deployment documentation redeployable | Confirm `docs/m4-deployment-notes.md`, `docs/m4-structured-output-contract.md`, and this guide are delivered and that an engineer can identify env vars, the DB migration, validation commands, and the staging E2E command. | The documents are present and sufficient for an engineer to redeploy and re-run M4 validation independently. | **Pre-verified** (docs delivered) + engineer review |

---

## Detailed Test Walkthroughs

The matrix above is the spine of sign-off. The walkthroughs below give step-by-step detail for the browser-first checks. API equivalents are in the [Before You Start](#before-you-start) note and in `docs/m4-deployment-notes.md`.

### TC-01 — End-to-end: upload → process → query → structured response

**Browser:**

1. Open `http://52.70.0.80/dashboard/chat`.
2. In the Sources area, upload a non-sensitive text-based sample PDF (one at a time — see the sequential-upload note).
3. Wait for the document to reach `COMPLETED`.
4. Select the document and ask:

   ```text
   What filing status and wages appear in this return?
   ```

**Expected:**

- The answer is grounded in the selected document and includes a citation marker such as `[S1]`.
- The cited source is the document you selected.
- The structured-output view shows `trueblue.chat.output.v1` and status `answered`.

**API confirmation (optional):**

```bash
curl -sS -b acme.txt "http://52.70.0.80/api/chat" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"requestKey\":\"m4-uat-e2e-1\",\"message\":{\"role\":\"user\",\"content\":\"What filing status and wages appear in this return?\"},\"documentFilter\":{\"documentIds\":[\"DOCUMENT_ID\"]}}"
```

Expect `output.schemaVersion = "trueblue.chat.output.v1"`, `output.status = "answered"`, and at least one `output.sources[].documentId` equal to `DOCUMENT_ID`.

### TC-02 — Output conforms to `trueblue.chat.output.v1`

Inspect the `output` object (UI Raw / Structured JSON view, or the API response). Confirm every field is present:

| Field | Expected |
|---|---|
| `schemaVersion` | Exactly `trueblue.chat.output.v1` |
| `templateId` / `templateVersion` | `rag_qa.default.v1` / `1` |
| `status` | One of `answered`, `insufficient_evidence`, `narrowing_required`, `non_document` |
| `responseText` | Matches the visible answer |
| `sources[]` | Final cited sources only (marker/sourceId, documentId, page metadata, snippet) |
| `coverage` | Selected / retrieved / final / no-evidence document coverage |
| `support` | `confidenceLabel`, `confidenceBasis`, `retrievalMode`, source counts |
| `warnings` | Structured warnings, if any |
| `metadata` | Thread / message / model / timestamp |

> `support.confidenceLabel` is **source-support** confidence (how well retrieved evidence backs the answer), **not** tax-advice confidence. See Limitation 7.

### TC-03 / TC-04 — Insufficient-evidence and non-document behavior

- Ask an out-of-document question (e.g. spacecraft purchase) against a selected source → expect `insufficient_evidence`, no citations, warning `INSUFFICIENT_EVIDENCE`.
- Ask `hi` → expect `non_document` status, brief guidance, no citations.

### TC-05 — Configurable output templates ("client-defined schemas")

Compact registered template:

```bash
curl -sS -b acme.txt "http://52.70.0.80/api/chat" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"requestKey\":\"m4-uat-compact-1\",\"message\":{\"role\":\"user\",\"content\":\"What filing status appears in this return?\"},\"documentFilter\":{\"documentIds\":[\"DOCUMENT_ID\"]},\"outputTemplate\":{\"templateId\":\"rag_qa.compact.v1\"}}"
```

Expect `output.templateId = "rag_qa.compact.v1"`. Then submit an unregistered template id and expect **HTTP 400**. This demonstrates that "client-defined schemas" are delivered as **approved, registered templates** rather than arbitrary runtime JSON (Limitation 2).

### TC-06 / TC-07 — Chat UI and thread replay

- Ask a supported question; confirm the streamed answer, inline `[S1]`, an expandable citation (filename + page + snippet), the **Insights** view (status/support/coverage), and the **Raw / Structured JSON** view.
- Confirm a new entry appears in History; reopen it and confirm the answer, citations, and structured output replay, with the source scope locked.

### TC-08 — Source selection and multi-source honesty

Start a new thread, select 2–3 completed PDFs, and ask:

```text
For each selected return, what taxpayer name is shown?
```

Each selected return should be addressed; any return without supporting evidence for the asked field should be explicitly flagged (not silently omitted); citations should map to the documents actually used.

### TC-09 — Tenant isolation spot-check

Confirm Acme data as `admin@acmetax.com`, then sign in as `admin@besttax.com` and confirm Acme documents and chats are not visible. Optional API:

```bash
curl -c best.txt "http://52.70.0.80/api/auth/login" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@besttax.com\",\"password\":\"FirmAdmin1!\"}"

curl -b best.txt "http://52.70.0.80/api/documents/ACME_DOCUMENT_ID"
```

Expect `{"error":"Not Found","message":"Document not found"}` (404, not 403).

> Note: data-layer tenant isolation holds (foreign-document probes fail closed with 404/400). A separate **prompt-premise** edge case exists where a deliberately misleading "list another firm's clients" prompt can cause the model to mislabel the *user's own* firm data — this is a wording/hygiene issue, **not** a cross-tenant data leak. It is tracked as a deferred prompt-hardening item (see Limitation notes).

### TC-10 — Deployed and accessible

Open `http://52.70.0.80/login`, log in, open `/dashboard/chat`. Optional:

```bash
curl -s -o /dev/null -w "%{http_code}" http://52.70.0.80/login   # expect 200
curl -b acme.txt http://52.70.0.80/api/auth/me                   # expect your email + Acme context
```

### TC-11 — Deployment documentation

Confirm these are delivered and an engineer can act on them independently:

| File | Purpose |
|---|---|
| `docs/m4-deployment-notes.md` | AWS target, env vars, DB migration, local validation, staging E2E, manual smoke |
| `docs/m4-structured-output-contract.md` | `trueblue.chat.output.v1` schema, templates, M6 extension path |
| `docs/m4-client-acceptance-testing.md` | This client acceptance guide |

---

## Scope and Limitations

These are stated plainly so acceptance is honest. They define the boundary between a **controlled M4 demo on non-sensitive samples** (supported now) and **unrestricted real-tax-document use** (not yet).

1. **HTTP only — use redacted/non-sensitive samples only.** Staging is served over plain HTTP. Passwords and uploads are unencrypted in transit. Do **not** upload real client tax data until TLS/HTTPS is added or the risk is explicitly waived.
2. **"Client-defined schemas" = approved registered templates, not arbitrary runtime schemas.** M4 delivers a configurable template engine with registered templates (`rag_qa.default.v1`, `rag_qa.compact.v1`). Unknown/unregistered templates are rejected (HTTP 400). New client output shapes are added by registering a template, not by posting an arbitrary JSON schema at runtime.
3. **Tax-domain advisory output is M6, not M4.** M4 proves the **source-cited structured envelope** (`responseText` + `citations` + `coverage` + retrieval-support `confidence` + `warnings`). The full 8-section tax advisory report, strategy categorization, and advice disclaimers are Milestone 6.
4. **Upload size: UI/proxy allows up to 25 MB, but the API rejects files over 20 MB.** A file between 20–25 MB can pass the proxy and then be rejected by the application (HTTP 413, "exceeds maximum of 20MB"). Recommendation: align the UI/proxy limit to 20 MB. For testing, keep sample PDFs comfortably under 20 MB (all provided samples are well under).
5. **Uploads are serialized per app process.** Simultaneous uploads from multiple testers can return `429 Too Many Requests`. Upload one document at a time and wait for `COMPLETED`.
6. **Operational docs/tooling still reference some legacy Docker Hub / bearer-token paths.** These are being cleaned up before a polished, single-source redeploy runbook is finalized. They do not affect client testing but are noted for transparency.
7. **PII redaction is not yet implemented, and numeric field-mapping is pending SME certification.**
   - The chat can echo identifier PII (SSN, bank/routing/account numbers, email, phone) verbatim from a source document. There is no output-layer masking yet. This is the primary reason to use **redacted/non-sensitive samples only** until a redaction pass ships.
   - The system enforces that answers are **grounded** and tied to a **real page** of a real document, and it strips unsupported numbers. It does **not** yet certify that a given figure maps to the **intended tax line** (e.g. that "9,649" is the *total tax* line). Numeric **field-mapping correctness** requires subject-matter-expert (SME) certification, which is pending.
8. **Response time — expect a few seconds per answer.** Each response is retrieved, re-ranked for relevance, and grounded before it is returned, so answers typically take **a few seconds** (up to ~10–15s for complex multi-document questions, or for the first request after an idle period). This is expected behaviour, not an error.
9. **Relevance re-ranking runs on a shared service tier.** Retrieved evidence is re-ranked for relevance before answering. Under heavy **simultaneous** testing this may slow responses or briefly fall back to standard retrieval ordering — the system **degrades gracefully and does not fail**. For the cleanest, most comparable results, have testers run **sequentially** where practical.

Additional product notes (consistent with prior milestones):

- AI wording may vary between runs, but answers must remain supported by the selected source evidence.
- `insufficient_evidence` is a **correct** result when the selected documents do not support the question.
- OCR for scanned/image PDFs is M5; the full tax advisory categorization is M6. Neither should block M4 acceptance.

---

## Acceptance Criteria Checklist

Use this for sign-off. "PV" marks items with pre-verified engineering evidence (re-run optional).

**Criterion 1 — End-to-end upload → process → query → structured response**
- [ ] A text-based PDF uploads and reaches `COMPLETED`. *(PV)*
- [ ] The document appears as a selectable source.
- [ ] A supported query returns a grounded answer with a citation.
- [ ] The response carries `output.schemaVersion = "trueblue.chat.output.v1"`, `status = "answered"`. *(PV)*
- [ ] At least one `output.sources[].documentId` matches the uploaded document. *(PV)*

**Criterion 2 — Output conforms to the agreed JSON schema**
- [ ] `schemaVersion`, `templateId`, `templateVersion`, `status`, `responseText`, `sources`, `coverage`, `support`, `warnings`, `metadata` all present.
- [ ] `responseText` matches the visible answer; `sources[]` are final cited sources only.
- [ ] Unsupported question → `insufficient_evidence`, 0 sources, `INSUFFICIENT_EVIDENCE` warning. *(PV)*
- [ ] Greeting / non-document message → `non_document`, 0 sources.
- [ ] Compact template → `templateId = "rag_qa.compact.v1"`; unknown template → HTTP 400.

**Criterion 3 — Chat interface**
- [ ] User can submit a query and see the answer in the conversation.
- [ ] Inline citation marker + expandable citation (filename, page, snippet) appear for grounded answers.
- [ ] Insights view shows status/support/coverage; Raw / Structured JSON view shows the full `output`. *(PV)*
- [ ] History saves the thread; reopening replays answer, citations, and structured output; source scope stays locked. *(PV)*
- [ ] Multi-source query addresses each selected document or flags no-evidence per document.

**Criterion 4 — Deployed and accessible**
- [ ] `http://52.70.0.80/login` loads and returns `200`. *(PV)*
- [ ] Login succeeds; `/dashboard/chat` loads without server errors. *(PV)*
- [ ] `/api/auth/me` works with a fresh session.

**Criterion 5 — Deployment documentation**
- [ ] `m4-deployment-notes.md`, `m4-structured-output-contract.md`, and this guide are delivered.
- [ ] Env vars, DB migration, validation commands, and the staging E2E command are documented.

**Supporting checks**
- [ ] Best Tax cannot see/access Acme documents or chats; cross-tenant returns 404.
- [ ] Public output does not reveal system prompts, secrets, or raw hidden context.

---

## Sign-off

| Field | Value |
|---|---|
| Milestone | M4 — Output Generation, Testing & Deployment |
| Build tag | `m4-20260627-191552-ed97574` (app + worker) |
| Environment | `http://52.70.0.80` (HTTP, staging), AWS account `536573256060` |
| Schema version | `trueblue.chat.output.v1` |
| Pre-verified evidence | `m4-e2e-report.json` (2026-06-27, zero failures); Playwright smoke (`output/playwright/*`); live browser re-check 2026-06-27 |
| Acceptance scope | Controlled M4 testing on **non-sensitive / redacted** sample PDFs over HTTP |

**Sign-off acknowledges:** the five SOW acceptance criteria above are met on staging for non-sensitive sample documents, **and** that the Scope and Limitations section (especially HTTP-only, no PII redaction, and pending SME numeric-field certification) is understood. Sign-off does **not** authorize unrestricted real-client-tax-document use; that is gated on TLS/HTTPS + an output-layer PII redaction pass (or an explicit written waiver).

| Role | Name | Decision (Accept / Accept-with-conditions / Reject) | Date |
|---|---|---|---|
| Client approver | | | |
| Delivery (engineering) | | | |

**Conditions / notes:**

```text
(record any conditions, deferred items accepted, or follow-ups here)
```
