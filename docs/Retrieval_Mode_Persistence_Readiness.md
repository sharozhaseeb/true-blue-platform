# Retrieval Mode Persistence — Readiness & Analysis

Status: Analysis / ready for implementation
Scope: Fix the reopened-thread (`GET /api/chat/threads/[id]`) retrieval-mode mislabel.
Companion doc: `docs/Retrieval_Mode_Persistence_Surgical_Edit.md` (file-by-file edit plan).

---

## 1. Problem statement & user impact

When a user asks a question through the streaming UI path, the live response is
labeled correctly: the AI-SDK `text/event-stream` `data-output` part carries
`support.retrievalMode = "vector_retrieval"`, and the answer cites a real source
with a Pinecone relevance score (~0.578 observed on staging today).

However, **reopening that same saved thread** via `GET /api/chat/threads/[id]`
returns `support.retrievalMode = "local_retrieval_fallback"` for the very same
assistant message. The History / saved-thread view therefore mislabels every
reopened AI answer as a local fallback even though vector retrieval actually ran.

Impact:

- **Cosmetic only** — retrieval itself is genuinely fine; the answer, citations,
  coverage, and relevance scores are all correct. Only the displayed
  `retrievalMode` label is wrong on reload.
- **Client acceptance risk** — the EulerTel/True Blue client acceptance step
  "confirm `vector_retrieval`" is performed against a reopened thread, where the
  label reads `local_retrieval_fallback`. The acceptance check appears to fail
  even though the system behaved correctly. This is the concrete reason to fix it.

---

## 2. Root cause (verified against source)

The reload route **does not persist or read the true retrieval mode**. Instead it
re-derives the mode from the stored `model` string, which for live AI answers is
the real LLM id (`gpt-4o-mini`), not the vector marker — so the derivation always
falls through to `local_retrieval_fallback`.

### 2.1 Reload re-derives mode from `model`

`src/app/api/chat/threads/[id]/route.ts`

- Line **11**: `const VECTOR_RETRIEVAL_CHAT_MODEL = "local-grounded-vector-retrieval-v0";`
  (the marker string).
- Lines **60–83**: for every `ASSISTANT` message the route rebuilds the structured
  output via `buildStructuredChatOutputV1({ ... })`. The `mode` argument is set on
  line **72**: `mode: modeFromModel(message.model)`.
- Lines **88–92**: the discriminator function:

  ```ts
  function modeFromModel(model: string | null | undefined) {
    return model === VECTOR_RETRIEVAL_CHAT_MODEL
      ? "vector_retrieval"
      : "local_retrieval_fallback";
  }
  ```

  It returns `"vector_retrieval"` **only** when `model` equals the marker string;
  otherwise `"local_retrieval_fallback"`.

### 2.2 The live AI answer persists the real LLM id, not the marker

`src/app/api/chat/route.ts`

- The AI path persists the assistant message at lines **1269–1281**
  (`appendAssistantMessageToThread({ ... })`). The model is set on line **1277**:
  `model: input.model`. `input.model` is `providerConfig.aiModel`
  (`gpt-4o-mini`), passed in at line **1864**.
- The true mode **is** known at generation time: it is `input.mode`
  (`= evidenceSelection.mode`, passed at line **1867**) and is used for the live
  output on line **1290** (`mode: input.mode`). But it is **never written to the
  message row**.

Net effect: `modeFromModel("gpt-4o-mini")` → `local_retrieval_fallback` on every
reload, regardless of what actually ran.

### 2.3 No column carries the mode

`prisma/schema.prisma`, model `ChatMessage` (lines **286–311**) persists:
`content`, `uiMessage`, `retrievedChunkIds`, `citations`, `evidenceCoverage`,
`model`, `inputTokens`, `outputTokens`. **None of these carries the retrieval
mode.** The `model` field is overloaded as a pseudo-discriminator only for the
synthetic-marker paths (non-document, narrowing, insufficient-evidence, and the
local fallback), which is why those reload correctly but the real-LLM AI path does
not.

---

## 3. What IS vs ISN'T persisted, and why each candidate discriminator fails

Per assistant `ChatMessage` row (`prisma/schema.prisma` 286–311):

| Field | Persisted? | Can it recover the true mode? |
|---|---|---|
| `content` | yes | No — answer text is mode-agnostic. |
| `uiMessage` | yes (Json) | No — see below; also not even selected on reload. |
| `retrievedChunkIds` | yes (Json) | No — chunk ids are identical shape for vector and local. |
| `citations` | yes (Json) | No — see `relevanceScore` row. |
| `evidenceCoverage` | yes (Json) | Not today, but **this is the chosen carrier** (see §4). |
| `model` | yes | Partially — only encodes the marker paths, NOT the real-LLM vector path. This is the bug. |
| `inputTokens` / `outputTokens` | yes | No — present for both vector and local. |

Why each specific candidate discriminator fails:

- **`model` field** — For live AI answers it stores `gpt-4o-mini` (real LLM), not
  the `local-grounded-vector-retrieval-v0` marker. `modeFromModel` therefore
  cannot tell a vector answer apart from a local one. (Root cause, §2.)
- **`relevanceScore`** — Cannot discriminate. The local fallback path also sets
  `relevanceScore: result.score` on its citations (`src/app/api/chat/route.ts`
  line **1632**, inside the shared citation-mapping at 1618–1633 that feeds both
  vector and local answers). Both modes carry a `relevanceScore`, so a
  score-presence or score-threshold heuristic would be wrong. **Do not use it.**
- **`uiMessage`** — Built inside `appendAssistantMessageToThread` via
  `createUiMessage(...)` (`src/lib/chat-persistence.ts` 963–967), which only
  stores `{ id, role, content }` — no mode. Worse, the reload `select` block
  (`threads/[id]/route.ts` lines **219–235**) does not even select `uiMessage`.
  So the mode is neither stored there nor read from there.
- **`evidenceCoverage`** — Today `EvidenceCoverageV1`
  (`src/lib/chat-persistence.ts` lines **29–35**) is
  `{ version, selectedDocumentIds, retrievedByDocumentId, finalByDocumentId,
  noEvidenceDocumentIds }` — no mode. But it **is** selected on reload (line 227),
  it **is** persisted verbatim for every assistant path, and it is the natural
  place to carry one more optional discriminator field. This is the basis for the
  recommended fix.

Conclusion: existing/legacy rows have **no reliable persisted mode signal** for
the real-LLM vector path. Only new answers can be fixed by persisting the mode
going forward.

---

## 4. Options analysis

### Option A — Persist the true mode inside `evidenceCoverage` JSON (recommended)

Add an optional `mode?: ChatRetrievalMode` to the persisted `EvidenceCoverageV1`
shape, thread it through `AppendAssistantMessageInput` →
`appendAssistantMessageToThread` (merge it into the stored `evidenceCoverage`
JSON), and have every assistant persist call pass the mode already in its scope.
On every read-back path, read the raw `evidenceCoverage.mode` when present, else
fall back to `modeFromModel(message.model)` for legacy rows. Read-back paths in
scope: the GET reload (`threads/[id]/route.ts`) **and** the three POST
replay/retry reconstruction sites (`route.ts` 1473, 1490, 1608) which exhibit the
same mislabel on a resend/retry (see §6). The raw read is required because both
`coverageForMessage`/`coverageFromMessage` reconstructors and the builder's
`normalizeCoverage` strip the `mode` key.

> Necessity (precise): Of the five assistant persist sites, **only the AI
> streaming site (`route.ts` 1269) is load-bearing** — it is the only one that
> persists a non-marker `model` (`gpt-4o-mini`), so it is the only path
> `modeFromModel` cannot recover and the only one that mislabels today. Sites 1504
> / 1669 / 1757 / 1897 persist *marker* models, so `modeFromModel` already returns
> their correct label; persisting `mode` there is defensive consistency, not a
> fix. (Site 1757, insufficient-evidence, is `vector_retrieval` only in theory: in
> practice a vector-supported document yields ≥1 kept result, so an
> insufficient/empty result set resolves to `local_retrieval_fallback`.)

- **Pros**: Zero database migration. `evidenceCoverage` is already a `Json?`
  column that is already selected on reload and already persisted on every
  assistant path. Backward compatible — legacy rows simply lack `.mode` and fall
  back to today's behavior. Output schema is untouched (`evidenceCoverage.mode`
  lives in the persisted JSON only; the builder rebuilds coverage from the five
  known fields and Zod strips anything extra — see §6). Smallest, lowest-risk
  surface; no deploy-time schema step.
- **Cons**: Slightly overloads the "coverage" object with a non-coverage field.
  Mitigated by it being an explicit, documented optional field.
- **Recommendation**: **Adopt Option A** unless a blocker is found. None was found.

### Option B — Dedicated nullable `ChatMessage.retrievalMode` column + migration

Add `retrievalMode String?` (or an enum) to `ChatMessage`, write it on every
assistant persist, select it on reload, and prefer it over `modeFromModel`.

- **Pros**: Cleanest semantics — mode is a first-class, queryable column, not
  smuggled inside coverage JSON. Easier to index/report on later.
- **Cons**: Requires a Prisma schema change + migration. The staging deploy does
  run migrations automatically — `docker-compose.prod.yml` has a `migrate`
  service (lines **28–30**) running `npx prisma migrate deploy && npx prisma db
  seed` from `${MIGRATE_IMAGE}` — so this is feasible, but it adds a migration
  artifact to the deploy and a larger blast radius (new column, generated client,
  select lists) for a purely cosmetic label. Heavier than warranted right now.
- **Recommendation**: Viable and arguably "more correct" long-term; defer unless
  the team wants mode as a queryable column. Not needed to fix the client demo.

### Option C — Recover mode for legacy threads from already-persisted data (infeasible)

Attempt to retroactively label existing rows correctly without persisting a new
signal.

- **Why it cannot be done reliably**: For a real-LLM vector answer, the only
  stored signals are `model` (= `gpt-4o-mini`, indistinguishable from a
  hypothetical local LLM answer), `relevanceScore` (present in **both** modes, see
  §3), citations, coverage counts, and chunk ids — none of which uniquely
  identifies vector vs local. The vector-vs-local decision happened in
  `retrieveChatEvidence` at request time and was discarded. There is no stored bit
  to reconstruct from. **Documented as infeasible.**

---

## 5. Legacy / existing-thread limitation

- The fix is **forward-only**. Threads already saved before the fix have no
  persisted `evidenceCoverage.mode`, so on reload they will continue to use
  `modeFromModel(message.model)` and a pre-fix vector AI answer will still show
  `local_retrieval_fallback`. This cannot be retroactively corrected (Option C).
- **Recommendation for the client demo**: delete the stale pre-fix test threads on
  staging so the acceptance reviewer starts clean. Every **new** question asked
  after the fix is deployed will display `vector_retrieval` correctly on both the
  live stream and on reopen.

---

## 6. Blast-radius / non-regression checklist

- [ ] **Live streaming label unchanged.** The live path already derives
  `support.retrievalMode` from `input.mode` (route.ts 1290), which the fix does
  not touch. Adding `mode` into the persisted coverage must not alter the live
  output.
- [ ] **Other persist+reload paths stay correct.** Non-document (route.ts 1504),
  multi-source narrowing (1669), insufficient-evidence (1757), and local-fallback
  (1897) all already reload correctly via their synthetic-marker `model`. After
  the fix they will additionally carry an explicit `evidenceCoverage.mode` that
  must equal the mode each path already reports in its live output
  (`"local_retrieval_fallback"`, `evidenceSelection.mode`, `evidenceSelection.mode`,
  and `evidenceSelection.mode` respectively).
- [ ] **Output schema stays valid.** `EvidenceCoverageV1Schema`
  (`src/lib/chat-output-schema.ts` 17–77) is the *output* coverage type and is
  NOT modified. The builder's `normalizeCoverage` (`chat-output-builder.ts`
  76–102) rebuilds coverage from the five known fields, so a persisted
  `evidenceCoverage.mode` never reaches the schema; and even if it did, the Zod
  object is non-strict and strips unknown keys. `support.retrievalMode` continues
  to come solely from the `mode` argument.
- [ ] **TypeScript compiles.** Adding an optional `mode?` to the persisted
  `EvidenceCoverageV1` is additive; object literals that omit it remain valid, and
  the output-builder's separate (Zod-inferred) `EvidenceCoverageV1` is untouched.
- [ ] **No DB migration introduced** (Option A) — `evidenceCoverage` is an
  existing `Json?` column.
- [ ] **Null-coverage write stays safe.** The persist-merge in
  `appendAssistantMessageToThread` must route a `null` coverage through the
  existing `toNullableJson` helper (`chat-persistence.ts` 314–316) so Prisma gets
  `Prisma.JsonNull`, not a raw JS `null` (which a `Json?` column rejects at
  runtime). All current callers pass non-null coverage, so this is a latent path —
  but the branch must not throw.
- [ ] **POST replay/retry read-back (IN SCOPE).** The POST handler reconstructs a
  persisted assistant message at three sites — `route.ts` **1473** (assistant-UI
  replay), **1490** (JSON replay), and **1608** (`completedRetryMessage` after a
  sequence-reservation retry) — each currently using
  `modeFromModel(existing.model)`. On a genuine resend (same `requestKey`) or a
  retry, a vector `gpt-4o-mini` answer is reconstructed as
  `local_retrieval_fallback` — the **same** mislabel on the POST path. These must
  read the raw persisted `evidenceCoverage.mode` (they rebuild coverage via
  `coverageFromMessage`, `route.ts` 169–209, which **strips** `mode`). Fixed via a
  shared `retrievalModeFromPersisted` helper in the surgical doc.
- [ ] **`route.ts` line 753 is a no-op (no change).** `chatResponse`'s
  `input.mode ?? modeFromModel(...)` fallback is dead code: every `chatResponse`
  caller (1341, 1485, 1573, 1603, 1739, 1827, 1968) passes an explicit `mode`, so
  the `??` branch never fires. Hardening it would change nothing.

---

## 7. Verification plan

1. **Type check**: `npx tsc --noEmit` (repo convention; there is no dedicated
   `typecheck` npm script).
2. **Lint**: `npm run lint`.
3. **Output-schema / contract guards**: `npm run verify:chat-output`,
   `npm run verify:chat-persistence`, `npm run verify:chat-streaming`,
   `npm run verify:m4-structured-output`.
4. **Build**: `npm run build`.
5. **Automated regression test (new — GAP #3).** `verify-m4-structured-output.js`
   is the only guard that drives the reload `GET`, but it currently asserts nothing
   about `retrievalMode` and its mocked `appendAssistantMessageToThread` does not
   replicate the persist-merge. The surgical doc (File 5) specifies: (a) update the
   mock to mirror the real `{ ...evidenceCoverage, mode }` merge, (b) add a reload
   case `model:"gpt-4o-mini"` + `evidenceCoverage.mode:"vector_retrieval"` →
   assert `support.retrievalMode === "vector_retrieval"`, and (c) add a legacy case
   `model:"gpt-4o-mini"` with **no** `evidenceCoverage.mode` → assert it still
   falls back to `"local_retrieval_fallback"`. Without the mock update, the test
   would mask the bug.
6. **Concrete manual reload test** (the acceptance scenario):
   - Ask a question that triggers vector retrieval; confirm the live
     `text/event-stream` `data-output.support.retrievalMode === "vector_retrieval"`.
   - `GET /api/chat/threads/[id]` for that thread and assert the assistant
     message's `data-output.support.retrievalMode === "vector_retrieval"`
     (previously `local_retrieval_fallback`).
   - Repeat for a local-fallback question and assert it still reloads as
     `local_retrieval_fallback` (non-regression).
7. **Final confirmation happens on staging** after rebuilding the app image and
   redeploying — the bug was confirmed live on staging, so acceptance must be
   re-run there post-deploy.

---

## 8. Rollout

1. Apply the surgical edits (Option A) — see companion doc.
2. Run the local verification (§7 steps 1–5, incl. the new regression test) until
   green.
3. Rebuild the **app** image and redeploy staging. No migration is required for
   Option A, so the `migrate` service has nothing new to apply. Existing
   environment is unchanged (`ENABLE_RERANK` and all other M3/M4 env vars stay as
   configured — the fix touches no provider/config code).
4. Delete the stale pre-fix test threads on staging (§5).
5. Re-run the acceptance check (§7 step 6) on staging and confirm both the live
   stream and the reopened thread report `vector_retrieval`.
