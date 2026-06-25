# M2 PDF Extraction Remediation Plan

## Purpose

This document defines the remediation plan for the Milestone 2 PDF extraction, chunking, and form-tagging issues raised during client review.

The goal is not only to fix the specific examples the client flagged, but to close the broader quality gaps that could trigger a second round of valid objections after a partial fix.

This plan is intended to remove ambiguity. A change is not complete unless it satisfies the acceptance criteria in this document.

---

## Current Client-Reported Issues

The client reported four concrete defects:

1. **Chunking / text capture is incomplete**
   The extracted text does not always match the full selectable text visible in the PDF. In some pages, the API output matches only a partial-selection behavior rather than the full-page selectable text.

2. **`chunkIndex = 0` is not starting at the beginning of the page**
   At least one example shows the first chunk beginning mid-page. This suggests the page text is already incomplete or out of order before chunking begins.

3. **`formType` propagation issue**
   `formType` is correct for the first chunk only, while later chunks from the same form return `null` or an invalid value even though they still belong to the same Form 1040 packet.

4. **Additional example of missing selectable text**
   The client found another page where visible selectable text is not present in the extracted API output, indicating the issue is not isolated to one page.

These four findings are treated as valid until disproven by direct side-by-side evidence.

---

## Likely Root Causes

### 1. Page text reconstruction is too naive

Current extraction in [src/lib/pdf-processor.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/pdf-processor.ts:28) concatenates `textContent.items` in raw stream order:

- `item.str + " "`

This does **not** reconstruct layout using X/Y position, line grouping, or reading order. As a result:

- top-of-page text can be omitted or reordered
- line breaks are lost
- paragraph boundaries are lost
- page-start content can appear to begin mid-page
- content that is selectable in the PDF can still be missing or misplaced in extracted output

### 2. Header stripping may remove real form-identifying text

Current repeated-header removal in [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:386) removes lines from later pages if they appear within the first 150 characters of every page.

This is risky for tax returns because repeated top-of-page lines often include:

- form titles
- tax year
- taxpayer name
- SSN fragments
- continuation-page identifiers

Even after fixing extraction, this logic can still create missing-text or missing-form-tag complaints.

### 3. `formType` is page-local, not document-flow-aware

Current `formType` detection in [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:221) runs on the current page text only.

That means:

- continuation pages without the full header/title/OMB may become `null`
- later chunks only inherit the page-local guess
- legacy short-page merge behavior can smear one label across unrelated content

### 4. Completeness checks are too weak

Current pipeline success gating in [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:10) only requires a very low minimum total text threshold.

A long PDF with major extraction loss can still finish as `COMPLETED`.

### 5. The current verifier can miss this class of defect

Current verifier coverage in [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:344) proves only that selected expected values appear somewhere in matching chunks.

It does **not** reliably prove:

- page-start correctness
- full-page completeness
- reading order
- absence of dropped middle sections
- continuation-page `formType`
- per-chunk propagation behavior

---

## Remediation Objectives

The remediation is complete only when all five objectives below are met:

1. **Full-page text reconstruction**
   Extracted text must reflect the actual readable page content in correct top-to-bottom reading order for the client's flagged examples and the known sample PDFs.

2. **Correct chunk starts**
   `chunkIndex = 0` must begin at the actual beginning of the source page for standalone pages.

3. **Reliable form tagging**
   Chunks belonging to the same multi-page form must carry the correct resolved `formType` where the page clearly remains part of that form.

4. **Strong regression coverage**
   The verifier must fail if page-start text, continuation-page labels, or known missing-text regions regress.

5. **No staging sign-off without direct evidence**
   The exact client examples that triggered this remediation must be rerun and documented before asking for client sign-off again.

---

## Current Status

The local remediation is now green.

- The document-detail API path normalizes Prisma `JsonValue` chunk metadata and keeps legacy provenance as `null` instead of inventing `propagated`.
- The completeness gate now rejects a realistic partially extracted document through the real `processDocument()` path while the six sample PDFs still complete successfully.
- The quality verifier now enforces page-start, chunk-boundary, paragraph-split, and resolved form-metadata checks on the current sample PDFs.
- Staging evidence and client re-review packaging are still open.

---

## Execution Phases and Tracking

This section converts the remediation into tracked phases. Work should move phase by phase. A later phase does **not** count as complete if an earlier phase still has open blockers.

### Phase Status Legend

- **Not started**: no implementation work has been done for this phase
- **In progress**: some code or verifier work exists, but the exit criteria are not all satisfied
- **Ready for review**: local implementation and local verification are complete, pending critic/staging confirmation
- **Done**: exit criteria are fully satisfied and documented

### Phase 0: Freeze Repro Cases and Baseline

**Status:** Done

**Goal**

Turn the client's objections into concrete, testable repro cases so there is no ambiguous definition of "fixed."

**Primary files**

- `docs/m2-extraction-remediation-plan.md`
- `docs/m2-extraction-implementation-checklist.md`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`

**Required inputs**

- Every client-reported example
- The exact PDF filename and page number for each example
- The expected top-of-page text and missing-text markers for each example
- The expected resolved `formType` behavior for each example

**Tasks**

1. Record every client-reported example in fixture form or an adjacent repro note.
2. For each example, write down:
   - source PDF
   - page number
   - expected page-start prefix
   - expected missing-text markers that must appear
   - expected `formType`
   - expected chunk behavior if the page splits
3. Capture the current failing/brittle behavior in writing before any more fixes are made.

**Verification commands**

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
```

**Exit criteria**

- Every client issue is mapped to an exact PDF and page.
- The expected output is testable without interpretation.
- The baseline failure mode is documented clearly enough that another engineer could reproduce it without additional explanation.

### Phase 1: Preserve Full Selectable Text and True Page Start

**Status:** Done

**Goal**

Ensure the stored page text matches the full readable/selectable page content closely enough that the client cannot legitimately claim content is missing or that chunk 0 starts mid-page because text was deleted or reordered before chunking.

**Primary files**

- `src/lib/pdf-processor.ts`
- `src/lib/text-cleaner.ts`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`

**Tasks**

1. Keep layout-aware extraction in `pdf-processor.ts`, but verify it against the exact client examples.
2. Remove or constrain any text-cleaning step that deletes visible selectable text the client expects to see.
   This currently includes:
   - `Page X of Y`
   - `DO NOT FILE`
   - `DRAFT`
3. Tighten verifier assertions so page-start checks validate true prefix order, not just token presence somewhere near the start.
4. Add explicit assertions for the client's missing-text regions.

**Verification commands**

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
```

**Exit criteria**

- No visible selectable text required by the client is intentionally removed before storage/chunking.
- For every flagged page, extracted text starts with the actual top-of-page content in the correct order.
- The verifier fails if a page-start prefix is wrong, reordered, or materially incomplete.
- The verifier fails if any client-cited missing-text region disappears again.

### Phase 2: Chunk Boundary and Token-Cap Integrity

**Status:** Done

**Goal**

Prove that chunking does not create new correctness defects after extraction is fixed.

**Primary files**

- `src/lib/chunker.ts`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`

**Tasks**

1. Audit all chunking paths, not only force-split:
   - force-split path
   - paragraph-split path
   - any remaining overlap path
2. Fix `splitAtParagraphBoundary()` so no oversize chunk can be emitted after an earlier chunk already exists.
3. Add verifier assertions for:
   - `tokenEstimate <= MAX_TOKENS_PER_CHUNK`
   - no mid-token boundary starts
   - no obvious duplication around overlaps
   - no obvious omission around split boundaries
4. Ensure `chunkIndex = 0` for a standalone page always reflects the actual beginning of that page's text.

**Verification commands**

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-boundary-clean
```

**Exit criteria**

- No chunk exceeds the declared token cap unless the cap is intentionally redefined and documented.
- Boundary audits cover paragraph-split behavior, not only flat force-split pages.
- The verifier fails if a split drops, duplicates, or corrupts content at the boundary.
- `chunkIndex = 0` no longer passes merely because a boolean flag says it covers the page start.

### Phase 3: Resolved Form Ownership and Metadata Contract

**Status:** Done

**Goal**

Make `formType` semantics explicit and verifiable across multi-page form packets.

**Primary files**

- `src/lib/text-cleaner.ts`
- `src/lib/chunker.ts`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`

**Tasks**

1. Treat resolved form ownership as a first-class concept, not only explicit page-local detection.
2. Define and preserve the metadata contract clearly:
   - `explicitFormType`
   - `resolvedFormType`
   - `formTypeSource`
   - `formTypeOriginPage`
3. Harden propagation so it does not drop to `null` on continuation pages just because the page is table-heavy or header-light.
4. Add verifier assertions against the emitted chunk metadata, not only `detectFormType(page.text)`.
5. Raise thresholds and/or convert critical form checks from soft metrics to exact assertions where the fixture is deterministic.

**Verification commands**

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold
```

**Exit criteria**

- The verifier directly validates resolved chunk-level `formType` behavior.
- Continuation pages do not lose form ownership solely because explicit detection is weak on that page.
- Negative pages remain unlabeled.
- The gate is strict enough that a meaningful propagation regression cannot still pass.

### Phase 4: End-to-End Completeness Gating

**Status:** Done

**Goal**

Prove that a materially bad extraction cannot still become `COMPLETED`.

**Primary files**

- `src/lib/document-pipeline.ts`
- `src/lib/pdf-processor.ts`
- `src/lib/text-cleaner.ts`
- `scripts/verify-m2-pdf-quality.js`
- any targeted pipeline test file or script added for this proof

**Tasks**

1. Keep the existing heuristic gate only if it is strengthened by real pipeline evidence.
2. Add a negative-path test that drives the actual pipeline or a close equivalent, not just a helper function in isolation.
3. Use a case that represents the client's concern:
   - document is mostly present
   - but top or middle page content is materially missing
   - pipeline must not mark it `COMPLETED`
4. Document the exact heuristic thresholds and why they are defensible.

**Verification commands**

```powershell
node scripts/verify-m2-completeness-gating.js
```

**Exit criteria**

- There is a committed, repeatable negative-path proof for completeness gating.
- A materially under-extracted document cannot silently reach `COMPLETED`.
- Healthy sample PDFs still complete successfully.
- The proof uses the actual pipeline logic, not only a detached helper call.

### Phase 5: Evidence Package and Staging Retest

**Status:** Not started

**Goal**

Produce the exact evidence package required before asking the client to review again.

**Primary files**

- `docs/m2-extraction-remediation-plan.md`
- `docs/m2-extraction-implementation-checklist.md`
- any staging evidence note created for this retest

**Tasks**

1. Collect before/after evidence for each client example:
   - page-start snippet
   - missing-text snippet
   - chunk metadata
   - `formType` behavior
2. Run the full local verifier and record the exact command/results.
3. Deploy to staging only after Phases 0-4 are complete.
4. Re-run:
   - original M2 acceptance checks
   - client repro pages
   - chunk detail checks
   - resolved-form checks on continuation pages
5. Package the evidence in a client-review-ready format.

**Verification commands**

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
```

Staging verification commands should be added to the evidence package once the deploy candidate exists.

**Exit criteria**

- Every client example has before/after evidence.
- Staging reproduces the fixed behavior, not only local scripts.
- Original M2 behavior still passes.
- The evidence package is complete enough to send without explanatory backfill.

### Phase 6: Client Retest Readiness Gate

**Status:** Not started

**Goal**

Enforce a final stop/go decision so the team does not send another premature retest request.

**Release gate**

Client retest is allowed only when all of the following are true:

- Phase 0 is done.
- Phase 1 is done.
- Phase 2 is done.
- Phase 3 is done.
- Phase 4 is done.
- Phase 5 is done.
- A critic review finds no remaining High-severity verification or correctness gaps.

**Exit criteria**

- The answer to "Is this ready for client retest?" is supported by evidence, not confidence.

---

## Workstreams

## Workstream 1: Lock Down Repro Cases

### Required tasks

- Capture the exact client examples that failed.
- For each example, record:
  - source PDF filename
  - page number
  - what the client says is missing
  - what the API currently returns
  - what the correct page-start text should be
  - what `formType` should be on that page/chunk

### Blocking rule

Implementation does **not** start until the client's flagged examples are recorded as explicit fixtures or documented reproduction cases.

### Acceptance criteria

- Every client-reported defect is mapped to a specific PDF and page.
- The expected correct output is written down in a form that can be tested.
- There is no “fix by feel” or “looks better now” sign-off.

---

## Workstream 2: Rebuild Page Text Extraction

### Required tasks

- Replace raw `textContent.items` concatenation in `pdf-processor.ts` with layout-aware reconstruction.
- Group text items into lines using Y-coordinate tolerance.
- Sort items within each line by X-coordinate.
- Insert line breaks between distinct rows.
- Insert paragraph breaks only when vertical spacing justifies them.
- Preserve full top-of-page content in output.
- Preserve enough line structure for downstream header detection and chunking.

### Explicit non-goals

- Do not attempt OCR in this workstream.
- Do not build a universal table parser.
- Do not silently “fix” extraction by dropping hard pages from output.

### Acceptance criteria

- For each client-flagged page, extracted text contains the full selectable page content the client cited as missing.
- Page text begins with the actual top-of-page content, not a mid-page fragment.
- Reading order is top-to-bottom and left-to-right within a line for the known sample PDFs.
- The known sample PDFs still produce expected page counts.
- No previously passing sentinel-value assertions regress.

---

## Workstream 3: Make Header Removal Safe

### Required tasks

- Reevaluate `removeRepeatedHeaders()` in `text-cleaner.ts`.
- Either:
  - heavily constrain it to clearly boilerplate lines only, or
  - temporarily disable it until safe logic is proven by regression tests.
- Verify it does not remove repeated form-identifying lines from continuation pages.

### Acceptance criteria

- Repeated top-of-page lines that are necessary to identify the form or continuation page are preserved.
- Removal logic does not delete tax year, form title, taxpayer identity, or continuation markers when those are part of the real page content.
- Any removed header line is demonstrably boilerplate and not relied on by later form-tagging or page-start assertions.

---

## Workstream 4: Redesign Form Tagging as Document-Flow-Aware

### Required tasks

- Separate:
  - **explicit page-level detection**
  - **resolved form assignment for the page/chunks**
- Detect explicit form headers where they truly appear.
- Propagate the active form across continuation pages until a new explicit form header begins.
- Apply the resolved form label to all chunks on those pages.
- Prevent label bleed across unrelated page boundaries or form boundaries.

### Required product decision

Before implementation, decide and document:

- Does `formType` mean:
  - “explicitly detected on this page”, or
  - “resolved form this page/chunk belongs to”?

This plan assumes the client expects the second meaning for multi-page forms.

### Acceptance criteria

- All chunks from a page that clearly belongs to the same multi-page form carry the correct resolved `formType`.
- Continuation pages of Form 1040 do not fall back to `null` solely because the full header/title is missing on later pages.
- A new form header on a later page stops propagation from the previous form.
- Legacy short-page merge behavior does not cause one page's form label to be incorrectly assigned to unrelated content.
- Known negative pages such as worksheets, filing instructions, support statements, and notices remain correctly unlabeled or differently labeled as intended.

---

## Workstream 5: Reassess any legacy short-page merge behavior

### Required tasks

- Review any legacy under-50-token merge behavior in `chunker.ts`.
- Decide whether it still makes sense after layout-aware extraction is introduced.
- If a merge path is ever reintroduced, verify that:
  - merged chunks preserve clear page provenance
  - merged chunks do not distort page start
  - merged chunks do not corrupt `formType`

### Acceptance criteria

- A merge path does not cause the first visible content of a chunk to begin mid-page unexpectedly.
- If a merge path is ever reintroduced, `pageRange` values are accurate.
- If a merge path is ever reintroduced, merged chunks do not create incorrect form-type inheritance across pages with different semantics.
- If any legacy merge behavior creates ambiguity, it must be reduced or removed rather than explained away.

---

## Workstream 6: Strengthen Pipeline Completeness Gating

### Required tasks

- Add stronger completeness checks in `document-pipeline.ts`.
- A document must not be marked `COMPLETED` if extraction is suspiciously sparse for its size.
- Add at least one defensible extraction-completeness heuristic, such as:
  - minimum extracted text density per non-empty page
  - minimum percentage of pages with meaningful text
  - low-density warning/failure for text-based PDFs that should contain far more text

### Acceptance criteria

- A document with severe partial extraction cannot silently finish as `COMPLETED`.
- The known sample PDFs still pass as `COMPLETED`.
- Completeness logic does not falsely fail legitimate low-text pages if the overall document is healthy.

---

## Workstream 7: Upgrade Regression Coverage

### Required tasks

- Expand `scripts/verify-m2-pdf-quality.js`.
- Expand `scripts/fixtures/m2-pdf-quality-fixtures.js`.
- Add explicit assertions for:
  - page-start text
  - missing-text client examples
  - continuation-page `formType`
  - per-chunk metadata on propagated forms
  - no dropped known sections
  - no duplicate spans on split pages where detectable
- Add boundary checks for:
  - force-split paths
  - paragraph-split paths
  - any legacy short-page merge paths

### Required verifier behaviors

The verifier must be able to fail on:

- page-start regression
- missing text in a previously fixed page
- continuation page reverting to `null` `formType`
- split/overlap duplication or omission around boundaries
- suspiciously incomplete extraction compared with the fixture baseline

### Acceptance criteria

- The verifier fails before the fix on the client examples.
- The verifier passes only after the extraction/tagging fixes are in place.
- The verifier is not limited to “needle exists somewhere.”
- The verifier explicitly covers the client's reported failure mode.

---

## Workstream 8: Staging Validation and Client Evidence

### Required tasks

- Redeploy only after Workstreams 1-7 are complete locally.
- Reprocess the sample PDFs on staging.
- Rerun:
  - original M2 acceptance checks
  - all client-reported repro cases
  - new regression checks introduced by this remediation

### Acceptance criteria

- The exact client examples now show full expected text.
- `chunkIndex = 0` begins at the correct page start for the flagged examples.
- `formType` is correct on continuation chunks/pages where the client expects the same form to continue.
- Original M2 upload/storage/tenant/validation behavior still passes.
- No previously fixed `formType` false positives reappear.

---

## Detailed Acceptance Criteria

The remediation is not complete until **all** criteria in this section pass.

## A. Extraction completeness

- Every client-flagged missing-text page has a documented expected substring list.
- Each expected substring appears in the extracted API output for the correct page.
- The extracted page text begins with the actual top-of-page content for the flagged pages.
- No known middle-of-page section cited by the client is absent from the API output.
- There is no reordering that makes the page read as an obviously broken fragment.

## B. Chunk start correctness

- For every flagged page, the first chunk that covers that page begins with the actual start-of-page text unless a legacy merge path is explicitly accepted.
- No `chunkIndex = 0` on a standalone page begins with content that belongs materially later on the page.
- Chunk boundaries do not split tokens mid-word, mid-number, or mid-currency value.

## C. Form tagging correctness

- Every chunk from an explicit form header page carries the correct `formType`.
- Continuation pages of the same form carry the correct resolved `formType` where the page clearly remains part of that form.
- A new form start page terminates propagation from the prior form.
- Worksheets, filing instructions, notices, support pages, and unrelated pages do not inherit the previous form label by accident.
- Merged pages do not produce misleading `formType` values.

## D. Header stripping safety

- Repeated-header cleanup does not remove required form-identifying text from continuation pages.
- Repeated-header cleanup does not create a false “mid-page start” appearance.
- If safe header stripping cannot be proven, the pipeline must prefer preserving text over aggressively removing it.

## E. Completeness gating

- A severely under-extracted text PDF cannot be marked `COMPLETED`.
- Healthy sample PDFs still complete successfully.
- Completeness thresholds are documented and reproducible.

## F. Regression harness quality

- The verifier includes explicit page-start assertions.
- The verifier includes the client's flagged examples.
- The verifier includes continuation-page `formType` assertions.
- The verifier includes negative-label checks to prevent false positives.
- The verifier covers force-split, paragraph-split, and any legacy merge-related boundary behavior.
- The verifier must fail when any of the fixed client issues regress.

## G. Staging sign-off readiness

- All original M2 acceptance criteria still pass.
- The client's exact reported examples now pass.
- Evidence is collected in a form that can be shared without interpretation or guesswork.

---

## Evidence Required Before Client Re-Review

Before sending the client a new review request, collect the following:

1. **Per client example**
   - PDF name
   - page number
   - before output snippet
   - after output snippet
   - expected text markers
   - `formType` before/after

2. **Regression summary**
   - verifier command used
   - pass/fail result
   - any new fixtures added

3. **Staging summary**
   - deployment commit
   - upload results for all 6 sample PDFs
   - chunk-detail examples for fixed pages
   - continuation-page `formType` examples

No client-facing “please retest” message should be sent without this evidence package.

---

## Risks That Must Be Considered Closed

The following are likely future client objections if left unaddressed:

1. **Header stripping still hides real continuation-page text**
2. **`formType` still goes `null` on later pages of the same form**
3. **Merged pages blur form ownership**
4. **A partial extraction still ends as `COMPLETED`**
5. **Verifier still passes despite missing page-start text**
6. **Paragraph-based splitting loses or duplicates content after layout reconstruction**
7. **Product meaning of `formType` is still ambiguous**

Each of these must be explicitly tested and closed during the remediation.

---

## Non-Negotiable Exit Criteria

The remediation is complete only if all of the following are true:

- Client-reported examples are reproducibly fixed
- Extracted page text is layout-aware and complete enough for the flagged pages
- Chunk 0 does not start mid-page on the flagged examples
- `formType` behaves as a resolved form label across applicable continuation pages
- Header stripping is proven safe or intentionally constrained/disabled
- Partial extraction cannot silently ship as `COMPLETED`
- Regression harness covers page starts, missing text, continuation pages, and boundary integrity
- Staging evidence is collected before requesting client sign-off again

If any one of these is not true, the remediation is not done.
