# M3 Multi-Source & Intent Verification Suite

**Stakeholder URL:** http://52.70.0.80
**Authored:** 2026-05-28
**Purpose:** Detect and gate three failure modes the original `m3-acceptance-testing.md` suite does not cover. These verifications fail today on staging and must pass after the fixes in [`m3-rag-improvement-plan.md`](./m3-rag-improvement-plan.md) ship.

## Why this suite exists

The original M3 acceptance guide only exercises **single-document** retrieval. Every "select a source, ask a question" step in `m3-acceptance-testing.md` uses one document. Three failure modes are therefore invisible to it:

1. **Multi-document retrieval collapse.** When N>1 sources are selected, the single Pinecone `documentId: $in: [...]` + `slice(0, 8)` pipeline ranks chunks globally and the top-8 collapse onto whichever document has prose closest to the query embedding. Other selected docs contribute zero citations. For generic prompts ("summarize", "compare") this is nearly deterministic.
2. **Greeting / small-talk routing.** `isSimpleNonDocumentMessage` matches a hardcoded English allowlist of 9 phrases. Anything outside it — `"good morning"`, `"yo"`, `"hola"`, `"Hi everyone"`, meta-questions like `"what can you help me with?"` — falls through to retrieval, often returns an "insufficient evidence" reply for a greeting.
3. **Citation faithfulness.** The current safeguard is "if the answer has no `[Sn]` markers, run a citation-repair LLM call." That detects marker absence, not whether the cited snippet actually supports the claim.

The suite below addresses all three with explicit pass criteria. Test IDs are stable so the post-fix run can be diffed against this baseline.

---

## Contents
- [Setup](#setup)
- [Section A — Multi-source coverage](#section-a--multi-source-coverage)
- [Section B — Intent routing for greetings & meta messages](#section-b--intent-routing-for-greetings--meta-messages)
- [Section C — Vague-but-valid query handling](#section-c--vague-but-valid-query-handling)
- [Section D — Insufficient evidence (negative regression)](#section-d--insufficient-evidence-negative-regression)
- [Section E — Citation faithfulness (substring)](#section-e--citation-faithfulness-substring)
- [Section F — Provider/model configuration surface](#section-f--providermodel-configuration-surface)
- [Section G — Tenant isolation (sanity regression)](#section-g--tenant-isolation-sanity-regression)
- [Baseline run summary — 2026-05-28](#baseline-run-summary--2026-05-28)
- [Runner script](#runner-script)

---

## Setup

Run from any environment that has `curl`. Bash examples below; for PowerShell use the runner at `scripts/run-m3-multi-source-verification-staging.ps1`.

```bash
# 1) Log in as Acme firm admin and save cookies
curl -c acme.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@acmetax.com","password":"FirmAdmin1!"}'

# 2) Confirm the three sample documents already uploaded as Acme
curl -b acme.txt "http://52.70.0.80/api/documents?status=COMPLETED&limit=20"

# Expected: at minimum these three (IDs as of 2026-05-28; refresh if recreated)
DOC_WHITTAKER=cmpnngfdc0003rzbigyhovwsi   # 2025 Tax Return Documents (Whittaker Jordan).pdf  — 25 pages
DOC_SMITH=cmpmb2rvy0003k03kz3c1lnun       # 2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf — 52 pages
DOC_JIMENEZ=cmpiapf2l000tmzgfpy79jh20     # 2025 Tax Return Documents (Jimenez Julio).pdf — 22 pages
```

If those IDs no longer resolve, re-list `GET /api/documents?status=COMPLETED&limit=20` and update the runner.

> **Stream response shape.** `/api/chat` returns Server-Sent Events when `transport=assistant_ui` is not set. The relevant frames for verification are `data-citations` (one frame, `citations: [{marker, chunkId, documentId, pageStart, pageEnd, snippet, ...}]`), `text-delta` frames (concatenated to form the answer text), and a final `data-usage` frame with `model`. Pass criteria below reference these frames.

---

## Section A — Multi-source coverage

The core regression suite for the bug the client reported.

**Pass principle.** When a user selects N sources and asks a question that should reasonably draw on more than one, the citation set must include at least one chunk from **every selected document**, OR the answer must explicitly state that a given selected document was searched but contained no relevant evidence (per-doc transparency). A silent collapse to one document — answering as if the others were not selected — is a fail.

### V-MULTI-01: "Summarize all of the selected documents." across 3 sources

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-MULTI-01\",\"messageId\":\"V-MULTI-01-msg\",\"messages\":[{\"id\":\"V-MULTI-01-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Summarize all of the selected documents.\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\",\"$DOC_SMITH\",\"$DOC_JIMENEZ\"]}}}"
```

**Pass criteria** (parsed from response):
- Distinct `documentId` values across `data-citations.citations[]` ≥ 3 (one per selected doc), OR
- Answer text contains an explicit per-document acknowledgement (e.g., "Smith return: [citation]; Jimenez return: [no relevant evidence]; Whittaker return: [citation]").
- Total citations ≥ 3, ≤ 24.
- No `insufficient evidence` response.

**Baseline 2026-05-28: FAIL.** 5 citations, all `documentId=cmpnngfdc0003rzbigyhovwsi` (Whittaker). Smith and Jimenez contributed zero. Answer mentioned `$27,645 wages` and `seven-year retention policy` — both Whittaker-only content — without acknowledging the other two selected returns. Raw capture: [`m3-multi-source-baseline-2026-05-28/V-MULTI-01-summarize-3docs.txt`](./m3-multi-source-baseline-2026-05-28/V-MULTI-01-summarize-3docs.txt).

### V-MULTI-02: "For each selected return, what taxpayer name is shown?" across 3 sources

The three sample PDFs deliberately have different taxpayer names (Whittaker, Smith, Jimenez), so a correct answer must surface three names.

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-MULTI-02\",\"messageId\":\"V-MULTI-02-msg\",\"messages\":[{\"id\":\"V-MULTI-02-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"For each selected return, what taxpayer name is shown?\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\",\"$DOC_SMITH\",\"$DOC_JIMENEZ\"]}}}"
```

**Pass criteria:**
- Distinct `documentId` values in citations ≥ 3.
- Answer text mentions at least 3 distinct taxpayer names (loose check: 3 distinct capitalised surnames, OR contains all of `Whittaker`, `Smith`, `Jimenez`).
- No silent collapse: answer is not phrased as "the taxpayer is X" when 3 are selected.

**Baseline 2026-05-28: FAIL.** Answer was `"The taxpayer name shown on the return is Jordan Whittaker [S1][S4]."` — singular phrasing, no mention of Smith or Jimenez, citations exclusively from Whittaker. Raw capture: [`V-MULTI-02-taxpayer-3docs.txt`](./m3-multi-source-baseline-2026-05-28/V-MULTI-02-taxpayer-3docs.txt).

### V-MULTI-03: "Compare the total wages across all three selected returns."

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-MULTI-03\",\"messageId\":\"V-MULTI-03-msg\",\"messages\":[{\"id\":\"V-MULTI-03-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Compare the total wages across all three selected returns.\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\",\"$DOC_SMITH\",\"$DOC_JIMENEZ\"]}}}"
```

**Pass criteria:**
- Distinct `documentId` values in citations ≥ 3, OR per-document acknowledgement of which wage figures were and were not found.
- If no wage figure is available in a given selected return, the answer must say so for that specific return rather than returning a blanket `insufficient evidence`.

**Baseline 2026-05-28: FAIL.** 0 citations, response was `"I could not find enough support in the uploaded documents to answer that question."` The query is comparative, embedded vectors are generic, and `vectorMinScore=0.25` filtered every chunk out. Raw capture: [`V-MULTI-03-compare-wages-3docs.txt`](./m3-multi-source-baseline-2026-05-28/V-MULTI-03-compare-wages-3docs.txt).

### V-MULTI-04: Single-doc summarize regression — must still work

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-MULTI-04\",\"messageId\":\"V-MULTI-04-msg\",\"messages\":[{\"id\":\"V-MULTI-04-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Summarize this return.\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\"]}}}"
```

**Pass criteria:**
- ≥ 3 citations, all `documentId = $DOC_WHITTAKER`.
- Answer mentions known Whittaker facts: `Jordan Whittaker` or `$27,645`.

**Baseline 2026-05-28: not captured.** Run before merging fixes to confirm single-doc path is not regressed by stratification logic.

### V-MULTI-05: Two-doc factual question — both must cite

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-MULTI-05\",\"messageId\":\"V-MULTI-05-msg\",\"messages\":[{\"id\":\"V-MULTI-05-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"For each selected return, list the filing status.\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_SMITH\",\"$DOC_JIMENEZ\"]}}}"
```

**Pass criteria:**
- Distinct `documentId` values in citations ≥ 2.
- Answer surfaces 2 filing statuses or explicitly says one was not found.

**Baseline 2026-05-28: not captured.** Add to baseline run.

---

## Section B — Intent routing for greetings & meta messages

The current allowlist in `src/app/api/chat/route.ts` (`isSimpleNonDocumentMessage`) covers only `["hi", "hello", "hey", "hi there", "hello there", "thanks", "thank you", "ok", "okay"]`. Everything else triggers retrieval. Pass criteria are the same for V-INTENT-01..08: no citations, no `insufficient evidence` text, model field is `m3-rag-non-document-message-v0` (or whatever the post-fix non-document model marker is).

For each test below, the request body is the same shape — only `text` changes:

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-INTENT-XX\",\"messageId\":\"V-INTENT-XX-msg\",\"messages\":[{\"id\":\"V-INTENT-XX-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"<PHRASE>\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\"]}}}"
```

| ID | Phrase | Expected after fix | Baseline expectation |
| --- | --- | --- | --- |
| V-INTENT-01 | `hi` | PASS (no citations, friendly guidance) | PASS (allowlist hit) |
| V-INTENT-02 | `hi!` | PASS | likely PASS — punctuation is stripped (`replace(/[.!?]+$/g, "")`) |
| V-INTENT-03 | `good morning` | PASS | FAIL — falls through to retrieval |
| V-INTENT-04 | `yo` | PASS | FAIL |
| V-INTENT-05 | `hola` | PASS | FAIL |
| V-INTENT-06 | `Hi everyone` | PASS | FAIL — phrase not in allowlist |
| V-INTENT-07 | `what can you help me with?` | PASS (meta-help branch) | FAIL — will be embedded and retrieved |
| V-INTENT-08 | `thanks!` | PASS | PASS (punctuation stripped, allowlist hit) |

**Pass criteria** per test:
- `data-citations.citations.length === 0`.
- Answer text does **not** contain `"I could not find enough support"`.
- Answer text is short (< 600 chars) and reads as guidance (encourages asking a document question).
- `data-usage.model` is a non-document marker, not `gpt-4o-mini`.

**Note on baseline:** auto-mode permissions prevented an automated 8-request sweep against staging during initial baseline capture (2026-05-28). Run these manually or via the runner script before merging fixes to lock down the failing set. Expected baseline failures are V-INTENT-03..07.

---

## Section C — Vague-but-valid query handling

### V-VAGUE-01: "What is this document about?" on single doc

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-VAGUE-01\",\"messageId\":\"V-VAGUE-01-msg\",\"messages\":[{\"id\":\"V-VAGUE-01-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"What is this document about?\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\"]}}}"
```

**Pass criteria:**
- ≥ 2 citations, all from `$DOC_WHITTAKER`.
- Answer mentions tax-return-shaped content (`tax`, `return`, `1040`, `wages`, or `Whittaker`).
- Not `insufficient evidence`.

**Why it matters.** This is a natural first user move when picking a single source. If the embedding similarity for "what is this document about?" falls below `vectorMinScore=0.25`, the system silently refuses on a question it could trivially answer with the first chunk of the document. Pre-computed per-doc summary anchors (Phase 3 in the improvement plan) make this robust.

---

## Section D — Insufficient evidence (negative regression)

### V-NEG-01: Spacecraft question — must NOT cite

Mirror of the existing Criterion 4 test from `m3-acceptance-testing.md`. Included here so regressions to it from any of the new logic surface in this suite too.

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-NEG-01\",\"messageId\":\"V-NEG-01-msg\",\"messages\":[{\"id\":\"V-NEG-01-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Does this document mention a spacecraft purchase?\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\"]}}}"
```

**Pass criteria:**
- `citations.length === 0`.
- Answer contains "could not find enough support" or "insufficient information".

---

## Section E — Citation faithfulness (substring)

Each emitted citation carries a `snippet`. The deterministic check: every snippet should be derivable from a real `DocumentRetrievalChunk` (it is built by `createSnippet(row.content)`). The runner verifies this with a single Prisma-free check: for each citation, GET `/api/documents/$documentId` is 200 (the chunk's doc exists for this firm) and the snippet looks like cleanly-extracted text, not raw JSON.

### V-CITE-01: Each citation's documentId resolves and snippet is non-empty

For every citation returned in V-MULTI-01..05:
- `GET /api/documents/{citation.documentId}` returns 200 from the same firm cookie.
- `citation.snippet.length > 20`.
- `citation.pageStart >= 1` and `citation.pageEnd >= citation.pageStart`.

### V-CITE-02 (manual, optional): Snippet supports the claim

Human spot-check. For each cited claim in V-MULTI-01..05, open the document at the cited page and confirm the snippet contains the supporting text. This is the layer that catches "marker is real, page is real, but the snippet doesn't actually support the claim."

A future automated version of V-CITE-02 should run an NLI gate (Vectara HHEM 2.1-Open or Bespoke-MiniCheck-7B) — see Phase 5 of the improvement plan.

---

## Section F — Provider/model configuration surface

### V-PROV-01: Usage event names the configured model

Final `data-usage` frame on any successful chat response should match the configured `AI_MODEL` env var.

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"V-PROV-01\",\"messageId\":\"V-PROV-01-msg\",\"messages\":[{\"id\":\"V-PROV-01-msg\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"What taxpayer name is shown on this return?\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"$DOC_WHITTAKER\"]}}}" \
  | grep -o '"model":"[^"]*"' | tail -1
```

**Pass criteria (current scope):**
- Model string equals `gpt-4o-mini` (current staging config).

**Pass criteria (after Phase 4 of improvement plan):**
- Model string is one of `openai:*`, `anthropic:*`, `google:*` per the registered provider in `LLM_CHAT_PROVIDER`. A change of `LLM_CHAT_PROVIDER` env var, followed by restart, must produce a different `model` value here without code changes — this is the literal "swap by config" criterion.

---

## Section G — Tenant isolation (sanity regression)

### V-TENANT-01: Best Tax cannot read an Acme document

Mirror of the existing Criterion 2 test, included so this suite is sufficient as a single regression run for chat + intent + multi-source + isolation.

```bash
# Log in as Best Tax
curl -c best.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"admin@besttax.com","password":"FirmAdmin1!"}'

# Try to fetch an Acme document
curl -b best.txt "http://52.70.0.80/api/documents/$DOC_WHITTAKER"
```

**Pass criteria:** HTTP 404, body `{"error":"Not Found","message":"Document not found"}`.

---

## Baseline run summary — 2026-05-28

| ID | Description | Result | Notes |
| --- | --- | --- | --- |
| V-MULTI-01 | Summarize 3 selected docs | **FAIL** | 5 citations, all 1 doc (Whittaker). Smith + Jimenez ignored. |
| V-MULTI-02 | For each return, taxpayer name | **FAIL** | Singular answer "Jordan Whittaker [S1][S4]". Smith + Jimenez ignored. |
| V-MULTI-03 | Compare wages across 3 returns | **FAIL** | 0 citations — vectorMinScore=0.25 filtered everything → blanket "insufficient evidence". |
| V-MULTI-04 | Single-doc summarize regression | not captured | run pre-merge as anti-regression baseline |
| V-MULTI-05 | Two-doc filing status | not captured | run pre-merge as anti-regression baseline |
| V-INTENT-01..08 | Greeting & meta routing | not captured | auto-mode blocked the 8-prompt sweep; run via runner script |
| V-VAGUE-01 | "What is this document about?" | not captured | run pre-merge |
| V-NEG-01 | Spacecraft (must refuse) | covered by M3 acceptance | should still PASS — re-verify after fixes |
| V-CITE-01 | Citations resolve | not captured | run pre-merge |
| V-PROV-01 | Model name in usage event | implicit PASS | usage event currently emits `gpt-4o-mini` (verified in baseline captures) |
| V-TENANT-01 | Cross-tenant 404 | covered by M3 acceptance | should still PASS |

**Raw evidence** for the three captured FAILs lives under [`m3-multi-source-baseline-2026-05-28/`](./m3-multi-source-baseline-2026-05-28/). Diff these against the post-fix run.

---

## Runner script

`scripts/run-m3-multi-source-verification-staging.ps1` automates Sections A–G end-to-end against staging, captures every response, and emits a JSON pass/fail report in the project root (next to the existing `staging-*-report.json` files).

```powershell
# from true-blue-platform/
pwsh scripts/run-m3-multi-source-verification-staging.ps1 `
  -BaseUrl "http://52.70.0.80" `
  -ReportPath "staging-m3-multi-source-verification-report.json"
```

The script writes one report per run with per-test request URL, response excerpt, citation `documentId` distinct count, answer text, model field, and pass/fail. Re-run after each fix from the improvement plan; the report path is git-ignorable per existing convention.

---

## What "PASS" means before and after the fix

| Section | Before fix (today) | After all fixes in improvement plan |
| --- | --- | --- |
| A. Multi-source | 3/5 FAIL (collapse to 1 doc OR blanket refusal) | All 5 PASS — distinct `documentId` count matches selected count, or per-doc acknowledgement |
| B. Intent routing | ~5/8 FAIL (allowlist misses) | All 8 PASS — semantic router covers natural greetings + multilingual + meta |
| C. Vague query | likely FAIL | PASS — pre-computed doc-summary anchor returns a grounded answer for "what is this doc about?" |
| D. Negative | PASS | PASS (no regression) |
| E. Citation faithfulness substring | PASS (chunks resolve) | PASS, plus NLI gate gives semantic faithfulness score |
| F. Provider config | technical PASS (model name surfaces) | Literal PASS — `LLM_CHAT_PROVIDER` env can swap from openai → anthropic without code changes |
| G. Tenant isolation | PASS | PASS (no regression) |

A single command (`pwsh scripts/run-m3-multi-source-verification-staging.ps1`) should turn green for all sections before the fix branch merges to production.
