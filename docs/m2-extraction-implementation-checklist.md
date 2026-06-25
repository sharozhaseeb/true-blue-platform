# M2 Extraction Implementation Checklist

This is the short execution checklist for the remediation described in [m2-extraction-remediation-plan.md](/abs/path/C:/Users/pc/work/yan/true-blue-platform/docs/m2-extraction-remediation-plan.md:1).

Use this document while implementing. It is intentionally shorter than the full plan, but it does not replace the full acceptance criteria in the remediation plan.

---

## Goal

Fix the M2 PDF extraction, chunking, and form-tagging defects so that:

- extracted text matches the full readable page content for the client's flagged examples
- `chunkIndex = 0` starts at the real top of the page for standalone pages
- `formType` behaves like a resolved form label across continuation pages where appropriate
- the verifier fails if these issues regress
- staging evidence is strong enough to ask the client to retest without ambiguity

---

## Current Blocker Snapshot

Do not treat the current implementation as client-retest ready. The local proof is complete, but the staging evidence package is still missing:

1. The staging evidence package required for client retest does not yet exist.

Until staging proof is collected, the remediation stays in local hardening mode.

---

## Phase Checklist

Use this as the execution tracker. A later phase does not count if an earlier phase still has open blockers.

### Phase 0: Freeze Repro Cases and Baseline

**Status:** Done

- [x] Every client-reported example is mapped to a specific PDF and page.
- [x] Each example has expected page-start text, required missing-text markers, expected `formType`, and expected chunk behavior recorded.
- [x] A reproducible before-state is captured for every client example.

### Phase 1: Preserve Full Selectable Text and True Page Start

**Status:** Done

- [x] No visible selectable text required by the client is intentionally removed before storage/chunking.
- [x] Page-start assertions validate true prefix order, not just token presence near the start.
- [x] The verifier fails if a client-cited missing-text region disappears or if a page start is materially wrong.

### Phase 2: Chunk Boundary and Token-Cap Integrity

**Status:** Done

- [x] Force-split, paragraph-split, and any remaining overlap paths are all audited.
- [x] No chunk exceeds the declared token cap without an explicit documented reason.
- [x] Boundary checks catch dropped, duplicated, or mid-token content around chunk transitions.
- [x] `chunkIndex = 0` is proven by content, not only metadata flags.

### Phase 3: Resolved Form Ownership and Metadata Contract

**Status:** Done

- [x] The verifier checks resolved chunk-level form behavior, not only explicit page-local detection.
- [x] Continuation pages do not fall back to `null` solely because explicit detection is weak on that page.
- [x] Negative pages remain unlabeled.
- [x] Metadata clearly distinguishes explicit vs propagated form assignment.

### Phase 4: End-to-End Completeness Gating

**Status:** Done

- [x] A real negative-path test proves the pipeline can reject materially under-extracted output.
- [x] Healthy sample PDFs still complete successfully.
- [x] Completeness thresholds are documented and defensible.

### Phase 5: Evidence Package and Staging Retest

**Status:** Not started

- [ ] Before/after evidence exists for each client example.
- [ ] Local verifier evidence is saved with exact commands and results.
- [ ] Staging evidence includes original M2 acceptance plus the client repro fixes.

### Phase 6: Client Retest Readiness Gate

**Status:** Not started

- [ ] All prior phases are done.
- [ ] A critic review finds no remaining High-severity correctness or verification blocker.
- [ ] The retest decision is evidence-based, not confidence-based.

---

## Suggested File Edit Order

Edit in this order unless a concrete dependency forces a small adjustment:

1. [scripts/fixtures/m2-pdf-quality-fixtures.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/fixtures/m2-pdf-quality-fixtures.js:1)
2. [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:1)
3. [src/lib/pdf-processor.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/pdf-processor.ts:1)
4. [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:1)
5. [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:1)
6. [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:1)
7. Revisit [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:1) and [scripts/fixtures/m2-pdf-quality-fixtures.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/fixtures/m2-pdf-quality-fixtures.js:1) one more time after the code changes settle

Why this order:

- The fixtures/verifier must fail first so there is real red-to-green proof.
- Extraction must be fixed before cleanup/chunking/form assignment can be validated honestly.
- Header removal and form propagation depend on the new page text shape.
- Completeness gating should be tuned against the final extraction output, not the old one.

---

## Preconditions

Do not start implementation until both decisions below are written down:

1. **Client examples are pinned down**
   For each reported defect, record:
   - PDF filename
   - page number
   - missing text or wrong chunk start
   - expected `formType`

2. **`formType` meaning is decided**
   Document whether `formType` means:
   - explicit page-local detection, or
   - resolved form label for the page/chunk

This remediation assumes the client expects the second meaning for continuation pages of the same form.

3. **The verifier must be made capable of failing on the client examples before the extractor fix lands**
   Do not rely on the current all-green verifier as proof that the pipeline is healthy. The current harness is too weak for this defect class.

---

## Execution Order

## 1. Capture baseline evidence before changing code

### Files

- no code changes yet
- optional local notes or scratch evidence outside the repo

### Tasks

- Save current API output for each client-reported example.
- Save the current verifier output.
- Record at least one example where:
  - extraction is incomplete
  - chunk 0 starts mid-page
  - continuation-page `formType` is missing or wrong

### Done when

- You can show a before/after comparison for every client-reported example.

---

## 2. Front-load fixture and verifier changes

### Files

- [scripts/fixtures/m2-pdf-quality-fixtures.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/fixtures/m2-pdf-quality-fixtures.js:1)
- [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:1)

### Tasks

- Add the exact client-reported examples as explicit fixture entries before changing extraction logic.
- Add assertions for:
  - page-start text
  - missing-text regions
  - continuation-page `formType`
  - per-chunk metadata expectations
  - paragraph-split and any legacy merge-path boundary behavior
- Make the verifier fail on the current broken behavior so there is a defensible red-to-green proof.

### Done when

- The verifier fails on at least the client-reported examples before the extraction/tagging fix is applied.
- The harness no longer relies only on “needle exists somewhere in a chunk.”

---

## 3. Rebuild page text extraction

### File

- [src/lib/pdf-processor.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/pdf-processor.ts:1)

### Tasks

- Replace raw `item.str + " "` concatenation with layout-aware reconstruction.
- Group text items into lines using Y-position tolerance.
- Sort text items within each line by X-position.
- Insert line breaks between rows.
- Insert paragraph breaks only when vertical spacing clearly warrants them.
- Preserve enough page structure for downstream chunking and form detection.

### Do not do

- Do not silently drop difficult pages.
- Do not patch only the specific client pages by special case.

### Done when

- Client-flagged missing text appears in extracted page text.
- Page text begins with the real top-of-page content for the flagged pages.
- Known sample PDFs still extract with correct page counts.

---

## 4. Make repeated-header removal safe

### File

- [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:386)

### Tasks

- Reassess `removeRepeatedHeaders()` after layout-aware extraction is in place.
- Either narrow it to clearly boilerplate lines only, or disable it temporarily.
- Verify it does not strip repeated form-identifying lines on continuation pages.

### Done when

- Header cleanup does not remove tax year, form title, taxpayer identity, continuation markers, or other form-identifying text that appears at the top of later pages.
- The flagged examples no longer look like they start mid-page because of cleanup.

---

## 5. Redesign page-level form ownership and propagation

### Files

- [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:1)
- [src/lib/text-cleaner.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/text-cleaner.ts:1)

### Tasks

- Define page-level form ownership before finalizing any legacy short-page merge behavior.
- Keep explicit page-level form detection separate from resolved page/chunk form assignment.
- Detect explicit form headers where they truly appear.
- Propagate the active form across continuation pages until a new form header begins.
- Apply the resolved form label to every chunk from those pages.
- Prevent carryover across unrelated pages, worksheets, filing instructions, or support sections.

### Metadata/provenance requirement

- Add enough metadata to explain why a chunk has its assigned form label.
- At minimum, preserve the distinction between:
  - explicit page-level detection, and
  - resolved propagated form assignment

This can be done with fields such as `explicitFormType` and `resolvedFormType`, or an equivalent structure. One undifferentiated `formType` field is not strong enough for debugging or future client review.

### Watch for

- Legacy short-page merge behavior can accidentally smear one page's form label across another page.
- A conservative page-local detector is not enough if the client expects continuation pages to remain tagged.

### Done when

- Continuation pages of the same form carry the expected resolved `formType`.
- Later chunks from a clearly tagged page do not fall back to `null`.
- Negative pages remain unlabeled or differently labeled as intended.
- Metadata is sufficient to explain whether a label was explicitly detected on the page or propagated from document flow.

---

## 6. Reassess any legacy short-page merge behavior

### File

- [src/lib/chunker.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/chunker.ts:206)

### Tasks

- Perform this only after page-level form ownership rules are decided.
- Reevaluate whether under-50-token page merging is still acceptable after extraction changes.
- If a legacy merge path is ever reintroduced:
  - verify `pageRange`
  - verify chunk start behavior
  - verify `formType` behavior
- If any legacy merge behavior creates ambiguity, reduce or remove it.

### Done when

- Chunk 0 does not begin mid-page unexpectedly.
- Merged chunks do not obscure where page content starts.
- Merged chunks do not mislabel form ownership.

---

## 7. Strengthen completeness gating

### File

- [src/lib/document-pipeline.ts](/abs/path/C:/Users/pc/work/yan/true-blue-platform/src/lib/document-pipeline.ts:1)

### Tasks

- Add a stronger extraction completeness gate than the current document-wide 100-character minimum.
- Use at least one defensible heuristic, such as:
  - minimum text density per non-empty page
  - minimum count of materially populated pages
  - low-density failure or warning for known text-based PDFs
- Add a negative-path test that proves the pipeline can reject or flag a suspiciously under-extracted document.

### Required proof path

- The completeness gate must be exercised through the real pipeline behavior, not only through the local verifier.
- At least one intentionally sparse or under-extracted input case must demonstrate the expected `FAILED` or warning behavior.

### Done when

- A severely under-extracted text-based PDF cannot silently finish as `COMPLETED`.
- Healthy sample PDFs still pass.
- There is a concrete negative-path test proving the gate works.

---

## 8. Expand the regression fixtures

### File

- [scripts/fixtures/m2-pdf-quality-fixtures.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/fixtures/m2-pdf-quality-fixtures.js:1)

### Tasks

- Keep the client-reported examples added in Step 2 and extend them as needed.
- Add page-start assertions for affected pages.
- Add continuation-page `formType` expectations.
- Add any new negative pages needed to prevent form-tagging overreach.
- Add paragraph-split and any legacy short-page-merge fixture coverage where those paths are exercised.

### Done when

- Every client-reported example is represented in the fixture file.
- There is no unresolved “manual check only” example.
- Boundary-sensitive paths are represented, not only simple one-page positives/negatives.

---

## 9. Upgrade the verifier

### File

- [scripts/verify-m2-pdf-quality.js](/abs/path/C:/Users/pc/work/yan/true-blue-platform/scripts/verify-m2-pdf-quality.js:1)

### Tasks

- Keep the Step 2 failing checks and complete the verifier with checks for:
  - page-start correctness
  - missing-text client examples
  - continuation-page `formType`
  - per-chunk propagation behavior
  - boundary integrity on force-split, paragraph-split, and any legacy merge paths
- Keep the existing value assertions, but do not rely on them alone.

### Done when

- The verifier fails before the remediation on the client examples.
- The verifier passes only after the extraction/tagging issues are actually fixed.
- A regression in page-start text or continuation-page tagging causes a verifier failure.
- A regression in paragraph-split or any legacy merge-path chunk boundaries causes a verifier failure where applicable.

---

## 10. Run local validation before touching staging

### Tasks

- Run the verifier locally against the 6 sample PDFs.
- Manually inspect the exact client-reported pages side by side with the extracted output.
- Check at least:
  - one incomplete-text example
  - one bad chunk-start example
  - one continuation-page form-tag example

### Done when

- Local output matches the expected result for all client-reported examples.
- The verifier passes with the new fixture coverage.
- There is a clear red-to-green record from the broken baseline to the fixed output.

---

## 11. Deploy once, then gather staging evidence

### Files

- deployment path only after local validation is complete

### Tasks

- Deploy the full remediation in one pass.
- Reprocess the sample PDFs on staging.
- Capture:
  - exact document IDs
  - exact chunk-detail URLs used
  - before/after output for the client examples
  - continuation-page `formType` examples
  - any new metadata/provenance fields used to explain propagated labels
  - original M2 acceptance results
  - negative-path completeness evidence if staging exercises it

### Done when

- Original M2 acceptance checks still pass.
- The client's flagged examples now pass on staging.
- Evidence is ready to send without explanation-by-guesswork.

---

## Verification Commands

Run these in the repo root: `C:\Users\pc\work\yan\true-blue-platform`

## Baseline commands before code changes

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ../client_shared_pdfs
```

Use this output as the pre-fix baseline. Save the failing examples and any relevant snippets separately.

## Local verification after fixture/verifier updates

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ../client_shared_pdfs
node scripts/verify-m2-pdf-quality.js --pdf-dir ../client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
```

Expectation:

- The first command should fail before the remediation is complete if the client examples are represented correctly.
- Both commands should pass only after the extraction/tagging issues are actually fixed.

## Required local inspection checks

After the code changes, inspect the exact client-reported examples directly through the document-detail path or an equivalent local readback path.

At minimum verify:

- the extracted page-start text for each flagged page
- the missing text regions the client called out
- the first chunk covering each flagged page
- the resolved `formType` on continuation chunks/pages

## Staging verification commands

After deployment, rerun the documented acceptance flow plus the client-specific examples:

```powershell
npm run verify:m2-quality -- --pdf-dir ../client_shared_pdfs
npm run verify:m2-quality -- --pdf-dir ../client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
```

Then verify on staging:

- upload of the 6 sample PDFs
- `GET /api/documents/{id}`
- `GET /api/documents/{id}?chunks=true`
- `GET /api/documents/{id}?chunks=true&limit=3`
- `GET /api/documents/{id}?chunks=true&page=1&limit=5`
- `GET /api/documents/{id}?chunks=true&page=2&limit=5`

Required evidence to save from staging:

- exact document IDs used
- exact URLs used
- before/after snippets for each client-reported page
- `formType` examples on continuation pages/chunks
- original M2 acceptance results still passing

---

## Required Acceptance Checks Before Client Retest

These must all be true before asking the client to review again:

1. The client's missing-text examples are fixed on staging.
2. `chunkIndex = 0` starts correctly on the flagged pages.
3. Continuation pages/chunks carry the expected resolved `formType`.
4. Header stripping does not remove required form-identifying text.
5. Partial extraction can no longer finish as `COMPLETED` without detection.
6. The verifier covers the fixed issues directly.
7. Original M2 upload/storage/tenant/validation behavior still passes.
8. Paragraph-split and any legacy merge-path boundaries are explicitly checked where affected by the new layout-aware extraction.

---

## Stop Conditions

Stop and reassess if any of the following happens:

- The extractor fix restores missing text but breaks page order badly.
- Header stripping becomes the new source of missing-text complaints.
- Form propagation causes worksheets, support pages, or notices to inherit the wrong label.
- Merge behavior makes page ownership or form ownership ambiguous.
- The verifier still passes while a client-reported example is visibly broken.
- The pipeline assigns a propagated form label but cannot explain whether that label was explicit or inherited.

---

## Final Deliverables

Before client re-review, the implementation should produce:

- code changes across the required pipeline files
- expanded fixture coverage for the client examples
- stronger verifier logic
- a clean local pass
- a clean staging pass
- a concise evidence package showing that the exact reported defects are fixed
