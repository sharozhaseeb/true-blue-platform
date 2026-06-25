# M3 RAG Improvement Plan — Multi-Source, Intent Routing, Citation Quality, Provider Abstraction

**Authored:** 2026-05-28
**Companion:** [`m3-multi-source-and-intent-verification.md`](./m3-multi-source-and-intent-verification.md) (the regression suite this plan must turn green)
**Source research:** four parallel research streams summarised below — multi-doc RAG patterns, LLM provider abstraction, citation/grounding quality, intent routing.

## TL;DR

Five phases, ordered by cost-to-value. Phases 1–2 close the user-reported bug and the most visible UX gap in a single sprint. Phases 3–5 raise the floor toward what NotebookLM, Glean, and Anthropic Citations-API products already do.

| Phase | What | Closes verification | Effort | Risk |
| --- | --- | --- | --- | --- |
| **1** | Stratified per-document retrieval + cross-encoder rerank | V-MULTI-01, V-MULTI-02, V-MULTI-05 | 1–2 days | Low |
| **2** | Semantic-router intent layer | V-INTENT-03..07 | 1–2 days | Low |
| **3** | Map-reduce branch for `summarize`/`compare` intents (+ per-doc summary cache at ingest) | V-MULTI-01, V-MULTI-03, V-VAGUE-01 | 3–5 days | Med |
| **4** | Vercel AI SDK provider registry + embedding registry split | V-PROV-01 (literal version) | 1–2 days | Low |
| **5** | NLI groundedness gate (Vectara HHEM 2.1-Open) + sentence-window chunking | V-CITE-02 (manual today, automated after) | 4–7 days | Med |

Each phase is independently shippable. The verification report in `staging-m3-multi-source-verification-report.json` should improve monotonically through them.

---

## Phase 1 — Stratified per-document retrieval + rerank

**The bug, named.** A single `$in` Pinecone query over heterogeneous selected sources is the canonical "flat top-K over multiple docs" failure mode. Vector similarity is a global popularity contest; one doc with summary-shaped prose dominates when scores are close. Cohere, Vectara, Pinecone, LlamaIndex multi-doc agents, and Sourcegraph Cody all converge on the same fix: **N parallel per-document queries, then merge**.

**Today (broken).** [`src/lib/vector/vector-retrieval.ts:286-297`](../src/lib/vector/vector-retrieval.ts) issues one query with `documentId: { $in: ids }, topK: 30`. [`src/app/api/chat/route.ts:750`](../src/app/api/chat/route.ts) slices to top 8. Verified collapse: `V-MULTI-01` returned 5 citations all from a single doc (Whittaker) when 3 were selected.

**Fix shape.** In `vector-retrieval.ts`, when `documentIds && documentIds.length > 1`:

1. Fire `N = documentIds.length` parallel `vectorStore.queryVectors` calls, each with `documentId: { $eq: dᵢ }`.
2. Per-doc `topK = max(6, ceil(24 / N))`. Enforce a **floor**: every selected doc gets at least 2 chunks in the candidate pool.
3. Merge into a single candidate list.
4. **Cross-encoder rerank** the merged pool against the query. Default to Cohere Rerank 3.5 (one API call, ~150–300ms, ~$1/1k requests). Optional fallback: do not rerank, just interleave (less precise but zero extra latency).
5. Take top 8 from reranked pool **with a per-doc quota**: e.g., max 4 chunks per doc in the final 8. This guarantees citation coverage even when one doc is genuinely more relevant.

**Where to add rerank.** New module `src/lib/ai/rerank.ts` with a `RerankProvider` interface (`rerank(query, docs[]) -> docs[] with score`) and a `CohereRerankProvider` implementation. Env: `RERANK_PROVIDER=cohere|none`, `COHERE_API_KEY`, `COHERE_RERANK_MODEL=rerank-english-v3.0`. Default `none` so behavior is opt-in until validated.

**Single-doc path** stays unchanged — when `documentIds.length <= 1`, keep the current code path. Anti-regression: V-MULTI-04.

**Why this is the right first move.** It fixes the user-reported bug with no schema change, no LLM-architecture change, and no new infrastructure. Industry references:
- LlamaIndex [Multi-Document Agents v1](https://developers.llamaindex.ai/python/examples/agent/multi_document_agents-v1/) — per-doc agents, top-level routing.
- OpenAI [Assistants `file_search`](https://platform.openai.com/docs/assistants/tools/file-search) — parallel queries + rerank, returns up to 20 chunks.
- Sourcegraph [Cody multi-repo context](https://sourcegraph.com/blog/how-cody-understands-your-codebase) — up to 10 repos, global rerank merge.
- Cohere [Rerank 3.5](https://cohere.com/blog/rerank-3pt5) — +20–35% precision lift on RAG when bolted onto existing retrieval.

**Verifications expected to turn green after Phase 1:** V-MULTI-01 (Summarize-3), V-MULTI-02 (taxpayer name per return), V-MULTI-05 (filing status across 2 docs). V-MULTI-03 (compare wages) may still fail because the query embedding for "compare wages" is too generic — that needs Phase 3.

---

## Phase 2 — Semantic-router intent layer

**Today (broken).** [`src/app/api/chat/route.ts:164-182`](../src/app/api/chat/route.ts) — `isSimpleNonDocumentMessage` is a 9-phrase English allowlist. Falls through to retrieval on "good morning", "yo", "hola", "Hi everyone", or anything meta like "what can you help me with?".

**Fix shape.** Replace the allowlist with a **Semantic Router** ([Aurelio Labs, MIT-licensed](https://github.com/aurelio-labs/semantic-router)). Define routes with canonical utterances:
- `greeting` — 15–20 examples covering "hi", "good morning", "yo", "hola", "hey there", "Hi everyone", "morning team" (multilingual via `paraphrase-multilingual-MiniLM-L12-v2`).
- `gratitude` — "thanks", "thank you", "appreciate it", "cheers".
- `meta_help` — "what can you help me with?", "how does this work?", "what documents do you have?".

At request time:
1. Embed the user message (one local CPU pass, ~5ms with MiniLM, or ~50ms via OpenAI `text-embedding-3-small` reusing the existing embedding provider).
2. Cosine-match against route anchors. Pick top route with similarity ≥ threshold (`0.78` typical).
3. If matched → return canned response per route, skip retrieval. Use a distinct `model` marker per route (`m3-intent-greeting-v0`, etc.) so the verification suite can confirm the bypass was taken.
4. If unmatched → fall through to retrieval (fail-open).

**Mixed-message escape hatch.** If the message has any of `$`, digits, a known tax token (`Schedule`, `W-2`, `1099`, `deduction`, `wages`, four-digit year), **skip the router** and go straight to retrieval. "Hi, what does this say about depreciation?" is a document query, not a greeting.

**Multi-turn.** Classify only the current message; do not concatenate history. The natural flow ("hi" → "now what does this say about X?") works because turn 2 routes to retrieval on its own merits.

**Implementation files.**
- New module `src/lib/ai/intent-router.ts` exposing `classifyIntent(message): "greeting" | "gratitude" | "meta_help" | "document_query"`.
- Replace `isSimpleNonDocumentMessage` call in `route.ts:669` with `classifyIntent(...)` and branch on result.
- New module `src/lib/ai/intent-responses.ts` for canned replies per route.

**Why not an LLM classifier.** Haiku 4.5 / `gpt-4o-mini` TTFT is 400–950ms — that's an extra round-trip per chat request just to classify "hi". Semantic Router with cached embeddings is 10×–100× cheaper and equally accurate for these route shapes ([When to Reason paper](https://arxiv.org/html/2510.08731v1), [OATS](https://arxiv.org/html/2603.13426v1)).

**Verifications expected to turn green after Phase 2:** V-INTENT-01..08.

---

## Phase 3 — Map-reduce summarize/compare branch + per-doc summary cache

**Why retrieval is the wrong tool here.** For prompts like "summarize" or "compare", you want **coverage**, not relevance. Even stratified retrieval (Phase 1) can return 8 cherry-picked chunks per doc that miss the document's gist. Map-reduce is the textbook fix.

**Fix shape, in three parts.**

### 3a. Pre-compute a one-paragraph summary per document at ingest

When the document pipeline completes (`src/lib/document-pipeline.ts`), generate a ~200-token summary using the same LLM and store it on the `Document` model (new column `summaryText: String?`, `summaryEmbedding: Bytes?` if you want vector storage too). Cheap, one-time, regenerated on reindex.

This summary becomes a **guaranteed anchor**: even in retrieval mode (Phase 1), the candidate pool can include the doc's summary chunk for every selected doc — eliminating the "doc has no high-scoring chunks" failure mode that triggered V-MULTI-03.

### 3b. Intent → strategy routing for summarize/compare

Reuse the intent router from Phase 2. Add three more route classes:
- `summarize_all` ("summarize", "give me an overview", "what's in these documents")
- `compare_across` ("compare", "differences between", "for each", "list X across")
- `factual` (default → Phase 1 stratified retrieval + rerank)

For `summarize_all`:
1. For each selected doc, fetch its cached summary (3a). If missing, generate on the fly.
2. Combine in a single LLM call with a structured prompt: "Combine the following per-document summaries into a unified overview. One section per document, in the order listed. Cite each section as `[S<n>]` using the source markers below."
3. Citations point to the doc-summary chunk per doc — guaranteed N citations from N sources.

For `compare_across`:
1. Stratified retrieval per doc on the comparison query (Phase 1).
2. Combine with an explicit "section per source" prompt asking for the comparison axis.
3. If a doc returns no qualifying evidence, the answer must say `"<doc name>: no evidence found for X"` rather than dropping it silently.

### 3c. Token budget

Bump `maxOutputTokens` from `1200` to `2400` for `summarize_all` and `compare_across` — multi-doc syntheses need the headroom. Keep `factual` at `1200`.

**Industry references.**
- LangChain [map_reduce summarisation chain](https://medium.com/@abonia/summarization-with-langchain-b3d83c030889) — the canonical pattern.
- LlamaIndex [`SummaryIndex` + `tree_summarize`](https://docs.llamaindex.ai/en/stable/) — same idea, batteries included.
- NotebookLM ["Briefing Doc" feature](https://www.baytechconsulting.com/blog/google-notebooklm-2025) — runs per-source map then combine; every source contributes.

**Verifications expected to turn green after Phase 3:** V-MULTI-01 (deeper coverage with per-source sections), V-MULTI-03 (no more blanket refusal on comparative queries), V-VAGUE-01 (vague queries return doc-summary anchor).

---

## Phase 4 — Vercel AI SDK provider registry + embedding registry split

**Today (literal-criterion miss).** [`src/app/api/chat/route.ts:49,423`](../src/app/api/chat/route.ts) hardcodes `createOpenAI` from `@ai-sdk/openai`. [`src/lib/ai/embedding-provider.ts:1`](../src/lib/ai/embedding-provider.ts) hardcodes `import OpenAI from "openai"`. `M3ProviderConfig` exposes only `openAiApiKey`, `aiModel`, `embeddingModel`. The literal M3 scope wording is *"swapped by changing a configuration value (no core code changes required)"* — that's only true for swapping models within OpenAI today.

**Fix shape.** Adopt the Vercel AI SDK's [`createProviderRegistry`](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry) + [`customProvider`](https://ai-sdk.dev/docs/reference/ai-sdk-core/custom-provider) pattern. One file:

```ts
// src/lib/ai/registry.ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createProviderRegistry, customProvider } from "ai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

export const registry = createProviderRegistry({ openai, anthropic, google });

export function getChatModel() {
  return registry.languageModel(
    `${process.env.LLM_CHAT_PROVIDER}:${process.env.LLM_CHAT_MODEL}`
  );
}
export function getEmbeddingModel() {
  return registry.textEmbeddingModel(
    `${process.env.LLM_EMBEDDING_PROVIDER}:${process.env.LLM_EMBEDDING_MODEL}`
  );
}
```

Call `getChatModel()` from `route.ts` (replace `openai(providerConfig.aiModel)`) and `getEmbeddingModel()` from `embedding-provider.ts` (replace the direct `openai.embeddings.create` path).

**Critical: embeddings must be independent of chat.** Anthropic ships no first-party embeddings. If the chat provider swap accidentally swaps embeddings too, RAG breaks. The registry's separate `languageModels` and `textEmbeddingModels` maps handle this cleanly.

**Dimension-mismatch guard.** Embedding swaps are dangerous because pgvector / Pinecone indexes are dimension-typed. Add a startup assertion:

```ts
// src/lib/ai/config.ts
function assertEmbeddingDimensionMatch() {
  const stored = Number(process.env.EMBEDDING_DIMENSION); // e.g. 1536
  const configured = getEmbeddingModel().dimensions; // resolved from provider
  if (configured !== stored) {
    throw new Error(
      `EMBEDDING_DIMENSION=${stored} but configured model is ${configured}-dim. ` +
      `Refusing to start to avoid silent index corruption. Reindex required to swap.`
    );
  }
}
```

A failed assertion at boot is the right failure mode — silent dimension mismatch is the documented worst case ([mem0 bug report](https://github.com/mem0ai/mem0/issues/4985)).

**Don't adopt a proxy yet.** LiteLLM and Portkey are excellent but they're extra infrastructure (Python container, Postgres for virtual keys, Redis for rate limits, another on-call surface). The registry pattern is enough for the M3 criterion. Revisit Portkey or Vercel AI Gateway only when reliability/cost-routing demands it.

**Verifications expected to turn green after Phase 4:** V-PROV-01 (literal version — `LLM_CHAT_PROVIDER=anthropic` env swap + restart produces a different `model` name in the usage event without code changes).

---

## Phase 5 — NLI groundedness gate + sentence-window chunking

**Why.** The current safeguard ([`route.ts:449-489`](../src/app/api/chat/route.ts)) detects **marker absence**, not **claim faithfulness**. A confident hallucination like `"The taxpayer is John Doe [S1]"` where `[S1]` is a real chunk about a different person sails through. For a tax product where false grounding is a regulatory risk (Stanford audit found 17–34% hallucination in Lexis+ AI *with* RAG — [Wiley study](https://onlinelibrary.wiley.com/doi/full/10.1111/jels.12413)), prompt-based citation is not enough.

**Fix shape.**

### 5a. Sentence-window chunking

Index single sentences for retrieval, but the LLM sees ±3–5 surrounding sentences. Tax language hinges on single sentences inside large paragraphs (a §-reference qualifier, a specific dollar amount). Tight citation anchors + adequate generation context. ([LlamaIndex SentenceWindowNodeParser](https://docs.llamaindex.ai/en/stable/api_reference/packs/sentence_window_retriever/)).

Changes: extend `src/lib/base-document-chunker.ts` with a sentence-window strategy. Migrate existing chunks blue/green — new chunk strategy version, reindex one tenant at a time.

### 5b. NLI groundedness gate after generation

For each cited claim in the answer, run an entailment check against the cited snippet. Options:
- **Vectara HHEM 2.1-Open** ([HF model card](https://huggingface.co/vectara/hallucination_evaluation_model)) — DeBERTa-v3-base, returns 0–1 factual-consistency score, threshold ~0.5, <1.5s CPU per claim. Apache-style open. Beats GPT-3.5 by 1.5× F1 on summarization.
- **Bespoke-MiniCheck-7B** ([HF](https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B)) — SOTA on LLM-AggreFact, ~200ms with vLLM on A6000, requires GPU.
- **MiniCheck-Flan-T5-Large** ([repo](https://github.com/Liyan06/MiniCheck), [paper](https://arxiv.org/abs/2404.10774)) — 770M, CPU-runnable, GPT-4-level accuracy at ~400× lower cost.

For Phase 5 start with HHEM 2.1-Open as a hosted endpoint (Vectara API) to avoid the model-serving lift. Move to self-hosted only if cost or compliance demands.

Fail mode: any claim with NLI score < 0.5 → replace that claim with `"<insufficient evidence for: [<claim>]>"` or refuse the whole answer. Per-claim refusal is the kinder UX.

### 5c. Retire the citation-repair LLM call

Replace `route.ts:449-489` with: NLI gate result → either pass-through or refuse. The repair pattern optimizes for marker presence and lets a second LLM invent grounding — a known anti-pattern for legal/regulatory RAG ([HalluGraph paper](https://arxiv.org/abs/2512.01659)).

### 5d. (Optional) Switch the answer-generation call to Anthropic Citations API

[Anthropic Citations API](https://platform.claude.com/docs/en/build-with-claude/citations) (`citations.enabled=true` on `document` blocks) guarantees `cited_text` is a verbatim substring of the source — the model literally cannot emit a citation pointing at fabricated text. This is the strongest available model-level enforcement. Caveat: incompatible with Structured Outputs. After Phase 4, the registry makes this a one-env-var change for the chat path.

**Verifications expected to turn green after Phase 5:** automated V-CITE-02 (no fabricated grounding); meaningful improvement on factual precision for V-MULTI-02 and V-VAGUE-01.

---

## Out of scope / deferred

These were considered and explicitly deferred. Document so the next planner doesn't relitigate:

- **RAG-Fusion / HyDE / multi-query expansion** — help recall on hard factual queries but don't address the coverage problem. Tax docs reward precision over recall. Revisit only if Phase 5 NLI evals show recall is the bottleneck.
- **LiteLLM / Portkey / OpenRouter** — see Phase 4 note. Real ops cost, doesn't move the criterion.
- **LLM-as-judge online** (RAGAS, TruLens in the request path) — expensive, circular when same-family. Keep judges offline on 1–5% sampled traces + CI regression set.
- **Fine-tuned embedding model** — Cohere Embed v3 or Voyage gives 5–15% recall lift but requires reindex. Defer until corpus stabilises post-M3.
- **Anthropic Citations API switchover before Phase 4** — possible standalone, but landing it after the provider registry is one config change instead of a rewrite.

---

## Verification gating

Before any phase merges to production, the runner at `scripts/run-m3-multi-source-verification-staging.ps1` must show monotone improvement vs the prior run. The expected progression:

| | Phase 0 (today) | After Phase 1 | After Phase 2 | After Phase 3 | After Phase 4 | After Phase 5 |
| --- | --- | --- | --- | --- | --- | --- |
| V-MULTI-01 | FAIL | PASS | PASS | PASS | PASS | PASS |
| V-MULTI-02 | FAIL | PASS | PASS | PASS | PASS | PASS |
| V-MULTI-03 | FAIL | partial | partial | PASS | PASS | PASS |
| V-MULTI-04 | (anchor) | PASS | PASS | PASS | PASS | PASS |
| V-MULTI-05 | (anchor) | PASS | PASS | PASS | PASS | PASS |
| V-INTENT-01..08 | mixed | mixed | PASS | PASS | PASS | PASS |
| V-VAGUE-01 | likely FAIL | likely FAIL | likely FAIL | PASS | PASS | PASS |
| V-NEG-01 | PASS | PASS | PASS | PASS | PASS | PASS |
| V-CITE-01 | PASS | PASS | PASS | PASS | PASS | PASS |
| V-CITE-02 (manual) | (manual) | (manual) | (manual) | (manual) | (manual) | automated |
| V-PROV-01 (literal) | technical PASS | technical PASS | technical PASS | technical PASS | literal PASS | literal PASS |
| V-TENANT-01 | PASS | PASS | PASS | PASS | PASS | PASS |

If any cell regresses run-to-run, halt and root-cause before moving to the next phase. The raw `m3-multi-source-baseline-2026-05-28/` captures are the ground truth Phase 0.

---

## Why this order

Phase 1 closes the user-reported bug fastest with the smallest blast radius — no schema migration, no new infra, one new dependency optional (Cohere). Phase 2 is the second-most-visible UX bug and is also schema-free. Phase 3 needs a migration (per-doc summary column + ingest hook) and an intent router worth iterating on — so it goes after Phase 2's router is in place. Phase 4 is a refactor with no behavioural change, easiest to ship between two product wins. Phase 5 is the deepest engineering investment and the one most worth piloting on a single tenant before fleetwide rollout.

Phases are independently shippable. If only one phase ships in a given milestone, ship Phase 1.
