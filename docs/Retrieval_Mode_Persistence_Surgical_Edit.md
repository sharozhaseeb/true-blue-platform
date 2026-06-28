# Retrieval Mode Persistence — Surgical Edit Plan (Option A)

Implements **Option A** from `docs/Retrieval_Mode_Persistence_Readiness.md`:
persist the true retrieval mode inside the existing `evidenceCoverage` JSON (no DB
migration), and read it back on thread reload, falling back to
`modeFromModel(message.model)` for legacy rows.

All line numbers verified against the current source. Snippets are exact (strip
the editor's leading line-number gutter when matching). Keep edits minimal — do
not refactor surrounding code.

Edit summary (4 source files changed + 1 test file; 1 file confirmed no-change):

1. `src/lib/chat-persistence.ts` — add mode type + optional fields on
   `EvidenceCoverageV1` and `AppendAssistantMessageInput`; merge mode into stored
   coverage in `appendAssistantMessageToThread` (via the existing `toNullableJson`).
2. `src/app/api/chat/route.ts` — **(File 2)** pass `mode` at all **5** assistant
   persist calls (1269, 1504, 1669, 1757, 1897); **(File 2b)** add a
   `retrievalModeFromPersisted` raw-read helper and apply it at the 3 POST
   replay/retry read-back sites (1473, 1490, 1608). Line 753 is a documented no-op.
3. `src/app/api/chat/threads/[id]/route.ts` — **(File 3)** read persisted mode on
   reload (raw read, before normalization), fall back to `modeFromModel`.
4. `scripts/verify-m4-structured-output.js` — **(File 5)** mirror the persist-merge
   in the mock + add vector-reload and legacy-reload `retrievalMode` assertions.
5. `src/lib/chat-output-builder.ts` / `chat-output-schema.ts` — **(File 4) no
   change required** (documented below).

---

## File 1 — `src/lib/chat-persistence.ts`

### 1a. Add a shared mode type alias (anchor: just above `EvidenceCoverageV1`, ~line 29)

Why: `appendAssistantMessageToThread` lives here and cannot import the route-local
`ChatRetrievalMode`; define the literal union once and reuse it.

BEFORE (lines 29–35):

```ts
export type EvidenceCoverageV1 = {
  version: 1;
  selectedDocumentIds: string[];
  retrievedByDocumentId: Record<string, number>;
  finalByDocumentId: Record<string, number>;
  noEvidenceDocumentIds: string[];
};
```

AFTER:

```ts
export type ChatRetrievalModeV1 = "local_retrieval_fallback" | "vector_retrieval";

export type EvidenceCoverageV1 = {
  version: 1;
  selectedDocumentIds: string[];
  retrievedByDocumentId: Record<string, number>;
  finalByDocumentId: Record<string, number>;
  noEvidenceDocumentIds: string[];
  mode?: ChatRetrievalModeV1;
};
```

Why this is safe: `mode?` is optional, so every existing object literal that omits
it (the coverage builders in `route.ts`, and the reconstructors in both routes)
still type-checks. The output-builder uses a *different* `EvidenceCoverageV1`
(Zod-inferred, from `chat-output-schema.ts`) and is untouched.

### 1b. Add optional `mode` to `AppendAssistantMessageInput` (anchor: line 93)

Why: lets each persist call pass its mode as a single explicit argument instead of
spreading it into the coverage object at every call site.

BEFORE (lines 86–98):

```ts
export interface AppendAssistantMessageInput {
  firmId: string;
  threadId: string;
  content: string;
  userId: string;
  retrievedChunkIds: string[];
  citations: BaseDocumentCitation[];
  evidenceCoverage?: EvidenceCoverageV1 | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  requestKey?: string | null;
}
```

AFTER (add one line after `evidenceCoverage`):

```ts
export interface AppendAssistantMessageInput {
  firmId: string;
  threadId: string;
  content: string;
  userId: string;
  retrievedChunkIds: string[];
  citations: BaseDocumentCitation[];
  evidenceCoverage?: EvidenceCoverageV1 | null;
  mode?: ChatRetrievalModeV1 | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  requestKey?: string | null;
}
```

### 1c. Merge `mode` into the stored coverage in `appendAssistantMessageToThread` (anchor: lines 970–973)

Why: centralizes "persisted coverage carries the mode" in exactly one place; the
column already stores the coverage object verbatim. Mode is only injected for a
real coverage object; `undefined` skips the field and `null` is written as a
proper JSON null.

> Null-handling correctness (do NOT ship a raw JS `null`): Prisma rejects a raw
> JS `null` for a `Json?` column — it requires the `Prisma.JsonNull` / `Prisma.DbNull`
> sentinel and would otherwise **throw at runtime**. The repo already has the
> `toNullableJson` helper for exactly this (`src/lib/chat-persistence.ts` lines
> 314–316: `value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue)`).
> Route the null/object case through it. (All current callers pass a non-null
> `emptyCoverage(...)` / `finalCoverage`, so the null branch is latent — but it
> must not be a branch that claims to handle null and then throws.)

BEFORE (lines 970–973, inside `tx.chatMessage.create({ data: { ... } })`):

```ts
            evidenceCoverage:
              input.evidenceCoverage === undefined
                ? undefined
                : (input.evidenceCoverage as unknown as Prisma.InputJsonValue),
```

AFTER (reuse the existing `toNullableJson` helper; it is already defined in this
file at line 314, so no new import is needed):

```ts
            evidenceCoverage:
              input.evidenceCoverage === undefined
                ? undefined
                : toNullableJson(
                    input.evidenceCoverage === null
                      ? null
                      : {
                          ...input.evidenceCoverage,
                          ...(input.mode ? { mode: input.mode } : {}),
                        }
                  ),
```

Behavior: `undefined` → field omitted (unchanged); `null` → `Prisma.JsonNull`
(safe — no throw); object → object with `mode` merged in when `input.mode` is set.

---

## File 2 — `src/app/api/chat/route.ts`

Pass `mode` at **every** `appendAssistantMessageToThread(...)` call. In each case
the mode is already in scope and already equals the mode used to build that path's
live output, so persisted and live labels stay identical. Add exactly one line per
call (placement next to the existing `evidenceCoverage:`/`model:` lines).

> Note: `ChatRetrievalMode` in `route.ts` (line 80) is the same literal union as
> `ChatRetrievalModeV1`, so the values pass without casts.

> Necessity (be precise): **Only call site 1 is load-bearing.** It is the only
> path that persists a non-marker `model` (the real LLM `gpt-4o-mini`), so it is
> the only path where `modeFromModel` cannot recover the truth — and the only one
> that actually mislabels today. Call sites 2–5 persist *marker* models
> (`NON_DOCUMENT_CHAT_MODEL`, `MULTI_SOURCE_NARROWING_MODEL`,
> `AI_CHAT_INSUFFICIENT_MODEL`, or `evidenceSelection.model` which is itself the
> `local-grounded-vector-retrieval-v0` / `local-retrieval-fallback-v0` marker), so
> `modeFromModel` already returns the correct label for them. Persisting `mode` on
> sites 2–5 is **belt-and-suspenders for consistency/future-proofing**, not a fix.
> In particular, site 4 (insufficient-evidence) is `vector_retrieval` only in
> theory: in practice any vector-supported document yields ≥1 kept result, so an
> empty `finalResults` resolves `evidenceSelection.mode` to
> `local_retrieval_fallback`. Do not present sites 2–5 as load-bearing.

### Call site 1 — AI streaming path (`streamAiChatResponse`), lines 1269–1281

Mode value: `input.mode` (the function param; `= evidenceSelection.mode`, passed
from line 1867). Model persisted: `input.model` (`gpt-4o-mini`). This is the call
that causes the reported bug.

BEFORE (lines 1269–1281):

```ts
  const assistantMessage = await appendAssistantMessageToThread({
    firmId: input.firmId,
    userId: input.userId,
    threadId: input.threadId,
    content: finalAnswer,
    retrievedChunkIds: input.finalResults.map((resultItem) => resultItem.chunk.chunkId),
    citations: finalCitations,
    evidenceCoverage: finalCoverage,
    model: input.model,
    inputTokens,
    outputTokens,
    requestKey: input.requestKey,
  });
```

AFTER (add `mode: input.mode,` after `evidenceCoverage:`):

```ts
  const assistantMessage = await appendAssistantMessageToThread({
    firmId: input.firmId,
    userId: input.userId,
    threadId: input.threadId,
    content: finalAnswer,
    retrievedChunkIds: input.finalResults.map((resultItem) => resultItem.chunk.chunkId),
    citations: finalCitations,
    evidenceCoverage: finalCoverage,
    mode: input.mode,
    model: input.model,
    inputTokens,
    outputTokens,
    requestKey: input.requestKey,
  });
```

### Call site 2 — Non-document message, lines 1504–1514

Mode value: `"local_retrieval_fallback"` (literal — matches the live output mode
at line 1523). Model: `NON_DOCUMENT_CHAT_MODEL`.

BEFORE (lines 1504–1514):

```ts
      const assistantMessage = await appendAssistantMessageToThread({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        content: answer,
        retrievedChunkIds: [],
        citations: [],
        evidenceCoverage: nonDocumentCoverage,
        model: NON_DOCUMENT_CHAT_MODEL,
        requestKey: assistantRequestKey,
      });
```

AFTER (add `mode: "local_retrieval_fallback",`):

```ts
      const assistantMessage = await appendAssistantMessageToThread({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        content: answer,
        retrievedChunkIds: [],
        citations: [],
        evidenceCoverage: nonDocumentCoverage,
        mode: "local_retrieval_fallback",
        model: NON_DOCUMENT_CHAT_MODEL,
        requestKey: assistantRequestKey,
      });
```

### Call site 3 — Multi-source narrowing, lines 1669–1679

Mode value: `evidenceSelection.mode` (matches live output at line 1688). Model:
`MULTI_SOURCE_NARROWING_MODEL`.

BEFORE (lines 1669–1679):

```ts
      const assistantMessage = await appendAssistantMessageToThread({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        content: answer,
        retrievedChunkIds: [],
        citations: [],
        evidenceCoverage: narrowingCoverage,
        model: MULTI_SOURCE_NARROWING_MODEL,
        requestKey: assistantRequestKey,
      });
```

AFTER (add `mode: evidenceSelection.mode,`):

```ts
      const assistantMessage = await appendAssistantMessageToThread({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        content: answer,
        retrievedChunkIds: [],
        citations: [],
        evidenceCoverage: narrowingCoverage,
        mode: evidenceSelection.mode,
        model: MULTI_SOURCE_NARROWING_MODEL,
        requestKey: assistantRequestKey,
      });
```

### Call site 4 — AI-enabled insufficient-evidence, lines 1757–1767

Mode value: `evidenceSelection.mode` (matches live output at line 1776). Model:
`AI_CHAT_INSUFFICIENT_MODEL`.

BEFORE (lines 1757–1767):

```ts
        const assistantMessage = await appendAssistantMessageToThread({
          firmId: ctx.firmId,
          userId: ctx.userId,
          threadId: thread.id,
          content: answer,
          retrievedChunkIds: [],
          citations: [],
          evidenceCoverage: insufficientCoverage,
          model: AI_CHAT_INSUFFICIENT_MODEL,
          requestKey: assistantRequestKey,
        });
```

AFTER (add `mode: evidenceSelection.mode,`):

```ts
        const assistantMessage = await appendAssistantMessageToThread({
          firmId: ctx.firmId,
          userId: ctx.userId,
          threadId: thread.id,
          content: answer,
          retrievedChunkIds: [],
          citations: [],
          evidenceCoverage: insufficientCoverage,
          mode: evidenceSelection.mode,
          model: AI_CHAT_INSUFFICIENT_MODEL,
          requestKey: assistantRequestKey,
        });
```

### Call site 5 — Local-retrieval fallback final answer, lines 1897–1907

Mode value: `evidenceSelection.mode` (matches live output at line 1916). Model:
`evidenceSelection.model`.

BEFORE (lines 1897–1907):

```ts
    const assistantMessage = await appendAssistantMessageToThread({
      firmId: ctx.firmId,
      userId: ctx.userId,
      threadId: thread.id,
      content: finalLocalAnswer,
      retrievedChunkIds: finalResults.map((result) => result.chunk.chunkId),
      citations: finalLocalCitations,
      evidenceCoverage: finalLocalCoverage,
      model: evidenceSelection.model,
      requestKey: assistantRequestKey,
    });
```

AFTER (add `mode: evidenceSelection.mode,`):

```ts
    const assistantMessage = await appendAssistantMessageToThread({
      firmId: ctx.firmId,
      userId: ctx.userId,
      threadId: thread.id,
      content: finalLocalAnswer,
      retrievedChunkIds: finalResults.map((result) => result.chunk.chunkId),
      citations: finalLocalCitations,
      evidenceCoverage: finalLocalCoverage,
      mode: evidenceSelection.mode,
      model: evidenceSelection.model,
      requestKey: assistantRequestKey,
    });
```

> These are all 5 `appendAssistantMessageToThread` call sites in `route.ts`. After
> these edits every newly persisted assistant message carries
> `evidenceCoverage.mode`. The **read-back** of that mode on the POST replay/retry
> paths is covered in **File 2b** below (in scope).

---

## File 2b — `src/app/api/chat/route.ts` POST replay/retry read-back (IN SCOPE)

The POST handler reconstructs a previously-persisted assistant message in three
places, and each currently derives the label from `modeFromModel(...)` — so on a
genuine resend (same `requestKey`) or a sequence-reservation retry, a vector
`gpt-4o-mini` answer is reconstructed as `local_retrieval_fallback`. This is the
**same user-visible mislabel** as the GET-reload bug, on the POST path, so it is
in scope.

Important: these three sites rebuild coverage via `coverageFromMessage`
(`route.ts` lines 169–209), which **strips** the `mode` key (it returns only the
five canonical coverage fields). The mode must therefore be read from the **raw**
persisted `message.evidenceCoverage`, independently of `coverageFromMessage`.

### 2b-i. Add a shared raw-read helper (anchor: just below `modeFromModel`, after line 215)

Why: reads the persisted mode from raw coverage and degrades to `modeFromModel`
for legacy rows. Same logic as the reload reader in File 3 (the two helpers are
intentional small duplicates, one per route file; optionally factor a single
exported helper into `chat-persistence.ts` if you prefer DRY).

BEFORE (lines 211–215):

```ts
function modeFromModel(model: string | null | undefined): ChatRetrievalMode {
  return model === VECTOR_RETRIEVAL_CHAT_MODEL
    ? "vector_retrieval"
    : "local_retrieval_fallback";
}
```

AFTER (insert the helper immediately after `modeFromModel`):

```ts
function modeFromModel(model: string | null | undefined): ChatRetrievalMode {
  return model === VECTOR_RETRIEVAL_CHAT_MODEL
    ? "vector_retrieval"
    : "local_retrieval_fallback";
}

function retrievalModeFromPersisted(message: {
  evidenceCoverage: unknown;
  model: string | null;
}): ChatRetrievalMode {
  const coverage = message.evidenceCoverage;
  if (coverage && typeof coverage === "object" && "mode" in coverage) {
    const mode = (coverage as { mode?: unknown }).mode;
    if (mode === "vector_retrieval" || mode === "local_retrieval_fallback") {
      return mode;
    }
  }

  return modeFromModel(message.model);
}
```

### 2b-ii. Apply at the assistant-UI replay (line 1473)

BEFORE:

```ts
          mode: modeFromModel(existingAssistantMessage.model),
```

AFTER:

```ts
          mode: retrievalModeFromPersisted(existingAssistantMessage),
```

### 2b-iii. Apply at the JSON replay (line 1490)

BEFORE:

```ts
        mode: modeFromModel(existingAssistantMessage.model),
```

AFTER:

```ts
        mode: retrievalModeFromPersisted(existingAssistantMessage),
```

### 2b-iv. Apply at the sequence-reservation retry replay (line 1608)

This is the `completedRetryMessage` path inside the `selectChatEvidence` catch
block — the site the first draft missed.

BEFORE:

```ts
          mode: modeFromModel(completedRetryMessage.model),
```

AFTER:

```ts
          mode: retrievalModeFromPersisted(completedRetryMessage),
```

### 2b-v. `route.ts` line 753 needs NO change (documented no-op)

`chatResponse` computes `const mode = input.mode ?? modeFromModel(input.assistantMessage.model);`
(line 753). Every `chatResponse(...)` caller passes an **explicit** `mode`
(lines 1341, 1485, 1573, 1603, 1739, 1827, 1968), so the `?? modeFromModel(...)`
fallback is **dead code** — it never fires. Changing it would have no observable
effect, so leave it as-is. (The reconstructed-message labels are fixed at the
call sites 1473/1490/1608, which pass `mode` explicitly into `chatResponse` /
`streamPersistedText`.)

---

## File 3 — `src/app/api/chat/threads/[id]/route.ts`

Read the persisted mode on reload; fall back to `modeFromModel(message.model)`
when absent (legacy rows). The `select` block (lines 219–235) already selects
`evidenceCoverage`, so **no select change is needed** — the mode rides inside that
JSON.

### 3a. Add a reader helper (anchor: just below `modeFromModel`, after line 92)

Why: prefers the persisted mode and degrades gracefully for pre-fix rows. It reads
from the **raw** `message.evidenceCoverage` — this matters because `coverageForMessage`
(`threads/[id]/route.ts` lines 110–152) and the builder's `normalizeCoverage` both
rebuild coverage from the five canonical fields and **drop** any `mode` key, so the
mode must be read before/independently of that normalization. This is the same
logic as `retrievalModeFromPersisted` in File 2b.

BEFORE (lines 88–92):

```ts
function modeFromModel(model: string | null | undefined) {
  return model === VECTOR_RETRIEVAL_CHAT_MODEL
    ? "vector_retrieval"
    : "local_retrieval_fallback";
}
```

AFTER (insert the new helper immediately after `modeFromModel`):

```ts
function modeFromModel(model: string | null | undefined) {
  return model === VECTOR_RETRIEVAL_CHAT_MODEL
    ? "vector_retrieval"
    : "local_retrieval_fallback";
}

function retrievalModeForMessage(message: {
  evidenceCoverage: unknown;
  model: string | null;
}): "vector_retrieval" | "local_retrieval_fallback" {
  const coverage = message.evidenceCoverage;
  if (coverage && typeof coverage === "object" && "mode" in coverage) {
    const mode = (coverage as { mode?: unknown }).mode;
    if (mode === "vector_retrieval" || mode === "local_retrieval_fallback") {
      return mode;
    }
  }

  return modeFromModel(message.model);
}
```

### 3b. Use the reader when rebuilding the structured output (anchor: line 72)

BEFORE (line 72, inside the `buildStructuredChatOutputV1({ ... })` call in
`uiPartsForMessage`):

```ts
          mode: modeFromModel(message.model),
```

AFTER:

```ts
          mode: retrievalModeForMessage(message),
```

Note: `uiPartsForMessage`'s `message` parameter already includes both
`evidenceCoverage: unknown` (line 27) and `model: string | null` (line 28), so
`retrievalModeForMessage(message)` type-checks with no signature change.

---

## File 4 — `src/lib/chat-output-builder.ts` & `src/lib/chat-output-schema.ts`

**No change required.** Rationale:

- The builder computes `support.retrievalMode` from its `mode` argument
  (`createSupport` → `retrievalMode: input.mode`, `chat-output-builder.ts` line
  344). Our fix feeds that argument the correct value on both write and reload, so
  no builder change is needed.
- The builder's `normalizeCoverage` (`chat-output-builder.ts` 76–102) rebuilds the
  coverage object from the five known fields, so a persisted `evidenceCoverage.mode`
  never flows into the output coverage.
- `EvidenceCoverageV1Schema` (`chat-output-schema.ts` 17–77) is a non-strict Zod
  object; even if an extra `mode` key reached it, it would be stripped, not
  rejected. The output schema and `OutputSupportV1Schema.retrievalMode` enum
  (`chat-output-schema.ts` line 120) remain valid and unchanged.

---

## Legacy fallback behavior

Rows written before this fix have no `evidenceCoverage.mode`. On reload,
`retrievalModeForMessage` finds no valid `mode` and returns
`modeFromModel(message.model)` — i.e., exactly today's behavior. So a pre-fix
real-LLM vector answer will still reopen as `local_retrieval_fallback` (it cannot
be recovered — see Readiness §4 Option C). All **new** answers reopen correctly.
Recommend deleting stale pre-fix staging test threads before the client demo.

---

## File 5 — Regression test: `scripts/verify-m4-structured-output.js`

Nothing currently asserts `support.retrievalMode` on reload, and the mocked
`appendAssistantMessageToThread` does not replicate the new persist-merge — so the
mock would mask the bug. Two edits: (a) make the mock mirror the real merge, and
(b) add reload assertions for the vector-persisted and legacy cases.

### 5a. Make the mock merge `input.mode` into stored coverage (anchor: line 239)

Why: the real `appendAssistantMessageToThread` now stores
`{ ...evidenceCoverage, mode }`; the mock must do the same or the reload test runs
against coverage that never carries `mode`.

BEFORE (line 239, inside the mocked `persistence.appendAssistantMessageToThread`):

```js
      evidenceCoverage: input.evidenceCoverage ?? null,
```

AFTER:

```js
      evidenceCoverage:
        input.evidenceCoverage == null
          ? null
          : { ...input.evidenceCoverage, ...(input.mode ? { mode: input.mode } : {}) },
```

### 5b. Add a vector-persisted reload assertion + a legacy-fallback reload assertion

Why: locks in the fix (vector survives reload) and the legacy contract (no `mode`
key still falls back to `local_retrieval_fallback`). Mirror the existing
`thread_replay` block (lines 617–699): it already covers the legacy **local-marker**
case; add a second `findFirst` override for a thread whose assistant message has
`model: "gpt-4o-mini"`, then a third override with no `mode` key.

Insert after the existing replay assertion (after line 699), before the
`if (failures.length > 0)` block:

```js
  // Reopen a vector answer persisted with the real LLM id: the persisted
  // evidenceCoverage.mode must win over modeFromModel(model).
  prismaModule.prisma.chatThread.findFirst = async () => ({
    id: "thread_vector_reload",
    title: "Vector reload",
    documentFilter: { documentIds: ["doc_a"] },
    outputTemplate: { templateId: "rag_qa.default.v1", templateVersion: 1 },
    createdAt: new Date("2026-06-23T08:00:00.000Z"),
    updatedAt: new Date("2026-06-23T08:05:00.000Z"),
    messages: [
      {
        id: "message_vector_assistant",
        role: "ASSISTANT",
        sequence: 1,
        requestKey: "req_vector:assistant:key",
        content: "Vector-grounded answer [S1]",
        citations: [
          {
            marker: "[S1]",
            rank: 1,
            chunkId: "chunk_vector",
            documentId: "doc_a",
            pageStart: 1,
            pageEnd: 1,
            snippet: "Vector evidence",
            sourceBlockIds: ["field_vector"],
            relevanceScore: 0.578,
          },
        ],
        evidenceCoverage: {
          version: 1,
          selectedDocumentIds: ["doc_a"],
          retrievedByDocumentId: { doc_a: 1 },
          finalByDocumentId: { doc_a: 1 },
          noEvidenceDocumentIds: [],
          mode: "vector_retrieval",
        },
        model: "gpt-4o-mini",
        inputTokens: 11,
        outputTokens: 5,
        createdAt: new Date("2026-06-23T08:04:00.000Z"),
      },
    ],
  });
  const vectorReload = await json(
    await threadRoute.GET({}, { params: Promise.resolve({ id: "thread_vector_reload" }) })
  );
  const vectorReloadOutput = vectorReload.body.messages
    .find((message) => message.role === "assistant")
    ?.parts?.find((part) => part.type === "data-output")?.data?.output;
  assertCondition(
    vectorReloadOutput?.support?.retrievalMode === "vector_retrieval",
    "reopened vector answer must report retrievalMode=vector_retrieval from persisted mode",
    failures
  );

  // Legacy row: real LLM id, NO persisted mode -> still falls back to local.
  prismaModule.prisma.chatThread.findFirst = async () => ({
    id: "thread_legacy_reload",
    title: "Legacy reload",
    documentFilter: { documentIds: ["doc_a"] },
    outputTemplate: { templateId: "rag_qa.default.v1", templateVersion: 1 },
    createdAt: new Date("2026-06-23T08:00:00.000Z"),
    updatedAt: new Date("2026-06-23T08:05:00.000Z"),
    messages: [
      {
        id: "message_legacy_assistant",
        role: "ASSISTANT",
        sequence: 1,
        requestKey: "req_legacy:assistant:key",
        content: "Legacy answer [S1]",
        citations: [
          {
            marker: "[S1]",
            rank: 1,
            chunkId: "chunk_legacy",
            documentId: "doc_a",
            pageStart: 1,
            pageEnd: 1,
            snippet: "Legacy evidence",
            sourceBlockIds: ["field_legacy"],
          },
        ],
        evidenceCoverage: {
          version: 1,
          selectedDocumentIds: ["doc_a"],
          retrievedByDocumentId: { doc_a: 1 },
          finalByDocumentId: { doc_a: 1 },
          noEvidenceDocumentIds: [],
        },
        model: "gpt-4o-mini",
        inputTokens: 11,
        outputTokens: 5,
        createdAt: new Date("2026-06-23T08:04:00.000Z"),
      },
    ],
  });
  const legacyReload = await json(
    await threadRoute.GET({}, { params: Promise.resolve({ id: "thread_legacy_reload" }) })
  );
  const legacyReloadOutput = legacyReload.body.messages
    .find((message) => message.role === "assistant")
    ?.parts?.find((part) => part.type === "data-output")?.data?.output;
  assertCondition(
    legacyReloadOutput?.support?.retrievalMode === "local_retrieval_fallback",
    "legacy row without persisted mode must fall back to local_retrieval_fallback",
    failures
  );
```

Note: the citation `snippet` does not need to appear in any chunk content for the
reload path — `threads/[id]/route.ts` builds output directly from the persisted
`citations`/`coverage` and does not re-run `validateAssistantEvidenceForFirm`
(that validation only runs on the write path). So these `findFirst` fixtures need
no `documentRetrievalChunk` mock.

---

## Verification commands (run after editing)

```bash
# 1. Type check (repo convention — no dedicated npm script exists)
npx tsc --noEmit

# 2. Lint
npm run lint

# 3. Contract / schema guards most relevant to this change
npm run verify:chat-output
npm run verify:chat-persistence
npm run verify:chat-streaming
npm run verify:m4-structured-output

# 4. Production build
npm run build
```

Then redeploy the rebuilt **app** image to staging (no migration needed for
Option A), delete stale pre-fix test threads, and re-run the acceptance check:
ask a vector question, confirm the live stream shows `vector_retrieval`, reopen the
thread via `GET /api/chat/threads/[id]`, and assert the assistant message's
`data-output.support.retrievalMode === "vector_retrieval"`.
