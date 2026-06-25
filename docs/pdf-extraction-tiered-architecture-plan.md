# PDF Extraction Tiered Architecture Plan

## Purpose

This document defines the next extraction architecture in two tiers:

- **Tier 1**: highest-value improvements using only first-party code already in this repo and the current runtime stack
- **Tier 2**: optional selective fallback and longer-horizon hardening that may introduce a third-party document parser

The goal is to improve extraction fidelity and client readiness without overfitting to the current six PDFs or turning the pipeline into a pile of one-off heuristics.

This plan is written for agent execution. Every phase names the exact files to inspect, the files to edit, the verification commands to run, and the explicit exit criteria. No phase is complete because it "looks better." A phase is complete only when its checks pass.

---

## Ground Rules

1. **Tier 1 must not depend on any new third-party document parsing service or library.**
   The existing stack is allowed: `pdf-parse` / PDF.js, Prisma, Next.js, and the current local scripts.

2. **Do not optimize only for the six sample PDFs.**
   Every change must be framed as a fix for a failure class:
   - page-start loss
   - wrong reading order
   - missing middle span
   - table/column corruption
   - continuation-page form ownership failure
   - support-page false positive

3. **Do not break the current API contract while improving the internals.**
   Existing consumers of:
   - `GET /api/documents/[id]`
   - `GET /api/documents/[id]?chunks=true`
   must continue to work.
   This includes preserving the current metadata semantics verified by:
   - `scripts/verify-m2-api-boundary.js`
   - `src/lib/document-chunk-metadata.ts`

4. **Structure is the primary artifact.**
   Plain page text and chunks should become derived outputs from a richer internal page model. The current "flatten page text first, compensate later" pattern must stop in Tier 1.

5. **Every phase must produce a critic-ready handoff.**
   After each Tier 1 phase, the worker must provide:
   - files changed
   - commands run
   - exact pass/fail results
   - known gaps

---

## Current Code Surface

The current extraction pipeline lives in:

- [src/lib/pdf-processor.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/pdf-processor.ts:1)
- [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:1)
- [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:1)
- [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:1)
- [src/lib/document-chunk-metadata.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-chunk-metadata.ts:1)
- [src/app/api/documents/[id]/route.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/app/api/documents/[id]/route.ts:1)

Current local verification lives in:

- [scripts/fixtures/m2-pdf-quality-fixtures.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/fixtures/m2-pdf-quality-fixtures.js:1)
- [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:1)
- [scripts/verify-m2-completeness-gating.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-completeness-gating.js:1)
- [scripts/verify-m2-api-boundary.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-api-boundary.js:1)

---

## Non-Negotiable Architecture Decisions

These decisions are fixed for the work below. The worker should not reinterpret them.

### 1. Internal page representation

Tier 1 will introduce a structured page model with concrete geometry and grouping:

- `StructuredTextSpan`
- `StructuredTextLine`
- `StructuredTextBlock`
- `StructuredPage`

This model should live in a new file:

- `src/lib/document-structure.ts`

The worker should not invent different file names for this model.

### 2. Public form metadata contract

The public API should continue to expose `metadata.formType`, but internally the code must preserve:

- `explicitFormType`
- `resolvedFormType`
- `formTypeSource`
- `formTypeOriginPage`

`metadata.formType` remains the public alias for `resolvedFormType`.

### 3. Tier 1 persistence scope

Tier 1 should **not** change the Prisma schema unless a blocker makes it unavoidable. The structured page model should stay in-memory inside the processing pipeline in Tier 1.

### 4. Chunking scope

Tier 1 chunking should be **structure-aware and page-safe**, but still emit the same high-level chunk records already used by the rest of the app.

### 5. Tier 2 scope

Tier 2 is the only place where managed fallback or an external parser may be introduced.

### 6. Test seam stability

Tier 1 must preserve one stable extraction seam so the synthetic completeness harness can continue to test `processDocument()` without invoking the real PDF worker.

The implementation must keep `processDocument()` testable with injected synthetic extracted pages.

---

## Tier Summary

### Tier 1

Build a structure-first native extraction pipeline using the current PDF.js-based extraction stack, then route cleaning, form ownership, chunking, and completeness checks through that richer page model.

### Tier 2

Add selective fallback for hard pages or hard documents, plus longer-horizon evaluation and operational hardening.

---

## Tier 1 Plan

### Tier 1 Outcome

At the end of Tier 1, the repo must have:

- a structure-first extraction core
- stronger fidelity verification by failure class
- safer form ownership resolution
- structure-aware chunking
- stronger completeness gates
- unchanged public API behavior for current consumers

Tier 1 is complete only when the local sample PDFs produce better outputs than the frozen pre-plan baseline and the verification suite proves that claim.

---

### Tier 1, Phase 1: Freeze Fidelity Contract and Expand Failure-Class Verification

**Goal**

Make the verifier capable of failing on the exact problems the client can still flag, before changing architecture again.

**Read first**

- [scripts/fixtures/m2-pdf-quality-fixtures.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/fixtures/m2-pdf-quality-fixtures.js:1)
- [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:1)
- [docs/m2-extraction-remediation-plan.md](/abs/path/C:/Users/pc/work/yan/true-blue-platform/docs/m2-extraction-remediation-plan.md:1)

**Files to edit**

- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`
- `docs/pdf-extraction-tier1-baseline.md`
- `docs/pdf-extraction-tiered-architecture-plan.md`

**Step-by-step implementation**

1. Run the current verifier once before any edits and capture the baseline.
2. Save the baseline as a repo artifact at:
   - `docs/pdf-extraction-tier1-baseline.md`
3. Record, for the client-relevant pages:
   - exact page-start snippet
   - exact missing-span snippet
   - explicit form result
   - resolved form result
   - chunk metadata snippet
4. Add a dedicated section in the fixture file for **fidelity assertions**, not just value assertions.
5. For each client-relevant page, record:
   - expected top-of-page prefix
   - required mid-page spans
   - expected ordered anchors
   - expected explicit and resolved form behavior
6. Add at least one table-heavy or row/column-sensitive page from the current sample set to the fixture coverage.
7. Extend the verifier to score failure classes separately:
   - page-start fidelity
   - ordered-anchor fidelity
   - missing-span fidelity
   - explicit form detection
   - resolved form ownership
   - chunk-boundary integrity
   - table/column-sensitive anchor order
8. Keep the current value assertions, but stop treating them as sufficient proof.
9. Add a small printed summary that groups failures by failure class.

**Verification commands**

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
node scripts/verify-m2-api-boundary.js
```

**Exit criteria**

- The baseline is frozen in `docs/pdf-extraction-tier1-baseline.md`.
- The verifier can fail specifically on fidelity problems, not only on missing tokens.
- Failures are grouped by failure class in the output.
- The fixture file explicitly covers:
  - top-of-page starts
  - missing middle spans
  - continuation-page form ownership
  - support/worksheet negative pages
  - at least one table/column-sensitive example

**Critic questions**

- Does the verifier still over-reward "contains the right text somewhere"?
- Are any failure classes the client could raise still unrepresented?
- Are the fixture expectations specific enough that another engineer would reach the same pass/fail result?

---

### Tier 1, Phase 2: Introduce Structured Page Model

**Goal**

Stop treating page text as the primary artifact. Build a structured in-memory representation first, then derive text from it.

**Read first**

- [src/lib/pdf-processor.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/pdf-processor.ts:1)
- [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:1)
- [scripts/verify-m2-completeness-gating.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-completeness-gating.js:1)

**Files to add**

- `src/lib/document-structure.ts`

**Files to edit**

- `src/lib/pdf-processor.ts`
- `src/lib/document-pipeline.ts`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/verify-m2-completeness-gating.js`

**Phase prerequisite**

The worker must solve the inline worker boundary explicitly.

Allowed approaches:

- move reconstruction helpers into serializable pure helpers that are consumed inside the worker path, or
- move the worker script to a dedicated file and share serializable helpers across worker and main thread

Disallowed approach:

- duplicating span/line/block grouping logic in two places

**Step-by-step implementation**

1. Create `src/lib/document-structure.ts` with explicit exported types:
   - `StructuredTextSpan`
   - `StructuredTextLine`
   - `StructuredTextBlock`
   - `StructuredPage`
   - helper functions for derived text rendering
2. Refactor `pdf-processor.ts` so extraction builds:
   - positioned spans from PDF.js items
   - grouped lines
   - grouped blocks
   - derived page text from blocks
3. Preserve the existing `extractTextByPage()` export for compatibility, but back it with the new structured model.
4. Add a new export from `pdf-processor.ts`:
   - `extractStructuredPages()`
5. Preserve one stable injectable extraction seam so `processDocument()` can still be tested with synthetic extracted pages without invoking the real PDF worker.
6. Update `scripts/verify-m2-completeness-gating.js` if needed so it still exercises the real completeness path through `processDocument()`.
7. Ensure the structure model carries enough information for later phases:
   - page number
   - span text
   - x/y/width/height
   - line bounding box
   - block bounding box
   - block text
8. Do not persist this structure yet. Keep it in-memory inside the processing path.

**Verification commands**

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-api-boundary.js
```

**Exit criteria**

- `extractStructuredPages()` exists and returns typed page structure.
- `extractTextByPage()` still works and now derives from the structured output.
- `processDocument()` remains testable with synthetic extracted pages without invoking the real worker.
- No duplicate span/line/block grouping logic exists in two places.
- The current API boundary verifier still passes.
- No Prisma schema change is required.

**Critic questions**

- Is the new structure real, or just text with light wrappers?
- Has the worker handled the inline worker refactor explicitly and safely?
- Is the worker accidentally baking PDF-specific heuristics directly into later phases instead of into structure generation?
- Does the model retain enough geometry to support table-safe or block-safe chunking later?

---

### Tier 1, Phase 3: Move Cleaning to Structure-Aware Normalization

**Goal**

Preserve client-visible text while normalizing only what is actually noise.

**Read first**

- [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:1)
- [src/lib/document-structure.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-structure.ts:1)

**Files to edit**

- `src/lib/text-cleaner.ts`
- `src/lib/document-pipeline.ts`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/verify-m2-completeness-gating.js`

**Step-by-step implementation**

1. Keep `cleanPageText()` for compatibility, but introduce structure-aware normalization helpers that operate on:
   - spans
   - lines
   - blocks
2. Restrict normalization to character cleanup and spacing repair.
3. Do not remove client-visible text such as:
   - `Page X of Y`
   - `DO NOT FILE`
   - `DRAFT`
   unless a later, separately verified rule proves removal is safe.
4. Keep `removeRepeatedHeaders()` disabled unless the worker can prove, with new fixtures, that a narrower rule is safe.
5. Ensure the derived page text still preserves top-of-page order and visible middle spans.

**Verification commands**

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
node scripts/verify-m2-completeness-gating.js
```

**Exit criteria**

- No cleaner rule removes text that the client can visibly select in the PDF and reasonably expect in API output.
- The verifier catches regressions in page-start or missing middle spans.
- Text normalization is clearly separate from structure generation.

**Critic questions**

- Is any rule still deleting visible text for convenience?
- Are line/block boundaries preserved well enough for later chunking?
- Has the worker reintroduced aggressive header stripping under a new name?

---

### Tier 1, Phase 4: Replace Regex-Only Form Ownership With Evidence-Driven Resolution

**Goal**

Keep explicit detection conservative while making resolved page/chunk ownership stable across continuation pages.

**Read first**

- [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:1)
- [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:1)

**Files to add**

- `src/lib/form-resolution.ts`

**Files to edit**

- `src/lib/text-cleaner.ts`
- `src/lib/form-resolution.ts`
- `src/lib/chunker.ts`
- `src/lib/document-chunk-metadata.ts`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`

**Step-by-step implementation**

1. Move form ownership logic out of cleaning helpers into `src/lib/form-resolution.ts`.
2. Keep explicit page-local form detection conservative.
3. Introduce a small evidence-driven resolver for page ownership that evaluates:
   - explicit positive evidence
   - continuation evidence
   - negative/support-page evidence
   - reset boundaries
4. Keep the existing public metadata fields, but make the internal logic use the structure-first page model where possible.
5. Ensure chunks from the same resolved page ownership carry the same `resolvedFormType`.
6. Keep support pages, instructions, worksheets, and negative pages from inheriting labels incorrectly.

**Verification commands**

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold
node scripts/verify-m2-api-boundary.js
```

**Exit criteria**

- Explicit detection and resolved ownership remain distinct.
- Continuation pages can carry the right resolved form label without forcing explicit detection to overfit.
- Negative pages remain negative.
- Form ownership logic is no longer housed primarily in cleaning helpers.
- API metadata normalization still passes.

**Critic questions**

- Is the worker just adding more regexes without changing the ownership model?
- Can a support page still inherit a label accidentally?
- Does the public metadata still make debugging possible?

---

### Tier 1, Phase 5: Make Chunking Structure-Aware and Page-Safe

**Goal**

Chunk from structure, not from one flat page string, while preserving page provenance and safe boundaries.

**Read first**

- [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:1)
- [src/lib/document-structure.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-structure.ts:1)

**Files to edit**

- `src/lib/chunker.ts`
- `src/lib/document-pipeline.ts`
- `src/lib/document-chunk-metadata.ts`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/verify-m2-completeness-gating.js`

**Step-by-step implementation**

1. Change chunk construction so it starts from structured blocks or lines, not only from page text strings.
2. Keep chunking page-local in Tier 1.
3. Preserve the existing output shape:
   - `content`
   - `pageNumber`
   - `chunkIndex`
   - `tokenEstimate`
   - `metadata`
4. Explicitly preserve metadata semantics for:
   - `sourcePageNumbers`
   - `coversPageStart`
   - `coversPageEnd`
   - `isPartialPage`
   - `partIndex`
5. Keep token-aware fallback splitting for oversized blocks, but prefer block boundaries first.
6. If a page must split into multiple chunks, ensure:
   - `chunkIndex = 0` starts with the actual page start
   - provenance fields remain correct
   - boundary overlap does not corrupt tokens
7. Add at least one table/column-sensitive ordered-anchor check that still passes after structure-aware chunking.
8. Do not merge across pages in Tier 1.

**Verification commands**

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-boundary-clean --enforce-form-threshold
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-api-boundary.js
```

**Exit criteria**

- Chunking starts from structure-aware units.
- Cross-page merging remains disabled.
- Boundary verification is green.
- Page-start fidelity and resolved ownership checks remain green after the chunker change.
- Legacy and current metadata semantics remain intact at the API boundary.

**Critic questions**

- Is the chunker still effectively chunking a flat string with cosmetic wrappers?
- Can a large block still exceed token limits without safe fallback?
- Are tables or column-like regions likely to be flattened incorrectly?

---

### Tier 1, Phase 6: Strengthen Completeness Gating and Local Release Gate

**Goal**

Make under-extracted documents fail predictably and make the local release gate reflect client-visible quality, not only pipeline completion.

**Read first**

- [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:1)
- [scripts/verify-m2-completeness-gating.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-completeness-gating.js:1)

**Files to edit**

- `src/lib/document-pipeline.ts`
- `scripts/verify-m2-completeness-gating.js`
- `docs/pdf-extraction-tiered-architecture-plan.md`

**Step-by-step implementation**

1. Reassess completeness using multiple signals, not only raw text volume:
   - non-empty page coverage
   - meaningful page coverage
   - suspiciously sparse pages
   - derived structural density
2. Keep the existing failure path through `processDocument()`.
3. Expand the completeness verifier to prove:
   - severe under-extraction fails
   - realistic partial extraction fails
   - healthy sample PDFs still complete
4. Update this plan doc with final Tier 1 local verification commands if they changed during implementation.

**Verification commands**

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-api-boundary.js
```

**Exit criteria**

- The local release gate is green.
- Under-extracted synthetic cases still fail.
- All six sample PDFs still process successfully.
- Tier 1 produces demonstrably better outputs than the frozen pre-plan baseline for client-relevant pages.

**Critic questions**

- Is completeness still mostly a weak heuristic?
- Are there still untested client-visible failure modes?
- Does the final local release gate prove fidelity, ownership, API compatibility, and completeness together?

---

## Tier 2 Plan

Tier 2 begins only after Tier 1 is locally stable and staging evidence is collected from the Tier 1 result.

### Tier 2 Outcome

At the end of Tier 2, the system may selectively route hard pages or hard documents through one managed fallback path, with explicit cost and confidence controls.

---

### Tier 2, Phase 0: Decouple Upload From Extraction

**Goal**

Make managed fallback possible without forcing long-running external parsing into the synchronous upload request.

**Files to edit**

- `src/app/api/documents/upload/route.ts`
- `src/lib/document-pipeline.ts`
- document status flow and any required supporting code

**Step-by-step implementation**

1. Stop treating upload and full document processing as one synchronous request lifecycle.
2. Introduce an asynchronous processing flow for document extraction.
3. Make document status transitions explicit for queued, processing, completed, and failed states.
4. Do not begin managed fallback work until this phase exists.

**Verification checks**

- Upload can complete without waiting on a managed parser.
- Document processing state transitions are explicit and testable.

---

### Tier 2, Phase 1: Hard-Page Detection and Routing Contract

**Goal**

Define when native extraction is considered low-confidence enough to justify fallback.

**Files to edit**

- `src/lib/document-pipeline.ts`
- `docs/pdf-extraction-tiered-architecture-plan.md`

**Step-by-step implementation**

1. Add a routing contract for hard pages/documents based on signals such as:
   - image-only or near-empty extraction
   - severe fragmentation
   - suspicious structural density
   - known table-heavy failure signature
2. Keep this routing contract dormant until a fallback adapter exists.
3. Record the decision path in logs or debug metadata, not in public API payloads yet.

**Verification checks**

- Hard-page detection logic is testable locally.
- No external service is invoked yet.

---

### Tier 2, Phase 2: Add One Selective Fallback Adapter

**Goal**

Introduce a single fallback provider for hard pages/documents, not multiple vendors at once.

**Recommended first provider**

- AWS Textract, because the current stack is already on AWS and the operational lift is lowest

**Files to add**

- `src/lib/fallback-extractor.ts`
- `src/lib/fallback-types.ts`

**Files to edit**

- `src/lib/document-pipeline.ts`
- deployment/config docs as needed

**Step-by-step implementation**

1. Implement a provider-agnostic fallback interface.
2. Implement exactly one provider adapter first.
3. Route only low-confidence pages/documents to fallback.
4. Keep the default path native and structure-first.
5. Record which pages used fallback for later evaluation.

**Verification checks**

- Fallback is selective, not default.
- Native path still handles standard digital PDFs.
- Fallback provenance is observable.

---

### Tier 2, Phase 3: Expand Evaluation Beyond the Six PDFs

**Goal**

Prevent Tier 1 or Tier 2 from overfitting to the current sample set.

**Files to edit**

- fixture and verifier files
- evaluation docs

**Step-by-step implementation**

1. Build a stratified holdout set across failure classes.
2. Add challenge documents for:
   - year changes
   - exported vs printed PDFs
   - tables
   - multi-column regions
   - support/worksheet pages
3. Track failure-class metrics separately.

**Verification checks**

- Holdout set exists and is not used for day-to-day tuning.
- Release gate includes both golden-set and holdout-set reporting.

---

## Worker Execution Order

The worker should execute Tier 1 in this exact order:

1. Phase 1
2. Critic review
3. Phase 2
4. Critic review
5. Phase 3
6. Critic review
7. Phase 4
8. Critic review
9. Phase 5
10. Critic review
11. Phase 6
12. Final critic review
13. Final local sample-PDF rerun and comparison report

Do not batch all phases together before critique. The point is to surface structural mistakes early.

---

## Required Worker Handoff After Each Phase

After each Tier 1 phase, the worker must report:

1. Files changed
2. Commands run
3. Exact command results
4. What improved
5. What is still intentionally unresolved until the next phase

If any check fails, the phase is not complete.

---

## Final Local Tier 1 Release Gate

Before claiming Tier 1 is locally complete, all commands below must pass:

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-api-boundary.js
```

In addition, the worker must provide a before/after comparison for the client-relevant pages showing that output is better than the frozen pre-plan baseline.

---

## What Success Looks Like

The repo is more client-ready when all of the following are true:

- the extractor is structure-first, not string-first
- the verifier catches failure classes the client actually cares about
- form ownership is evidence-driven instead of regex sprawl
- chunking is structure-aware and page-safe
- completeness is harder to fake
- public API behavior remains stable
- Tier 2 remains optional and selective, not a premature dependency
