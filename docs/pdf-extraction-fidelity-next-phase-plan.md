# PDF Extraction Fidelity Next-Phase Plan

## Purpose

This document defines the next extraction phase after the Tier 1 staging deploy.

Tier 1 made the pipeline safer:

- chunk starts are correct
- resolved form ownership is stable
- support pages remain unlabeled
- the local verifier is stronger

But staging evidence shows the client-visible output is still not good enough in one critical area:

- **text fidelity inside chunks**

The remaining problem is not chunk counts, not page ownership, and not API shape. The remaining problem is that rendered chunk text still contains spacing and reading-order artifacts such as:

- `Form1040U.S.`
- `Income Tax Return2025`
- `Page2`
- `yourtotal income`
- `bothmust sign`
- `Go towww.irs.gov/...`
- `Form1065`

The next phase must fix those fidelity defects without overfitting to the six current PDFs.

This document is written for execution by an engineering agent. Every phase includes:

- the issue class being fixed
- exact files to inspect
- exact files to edit
- verification commands
- exit criteria
- explicit anti-overfitting rules

No phase is complete because output "looks cleaner." A phase is complete only when the verification gates in this document pass.

---

## Current Standing

### What is already good

- Staging deploy is healthy.
- All six sample PDFs upload and process successfully.
- Chunk counts are stable versus the old staging implementation.
- `chunkIndex = 0` starts at the true top of page for the sampled pages.
- Resolved `formType` propagation works on continuation pages.
- Negative/support pages remain `null` where expected.

### What is still failing in practical terms

- Adjacent spans that should have visible spacing still collapse together.
- Header lines and field labels still render with token joining artifacts.
- Chunk text is readable but not faithfully rendered enough for a client doing side-by-side inspection.
- The current verifier still proves stability better than it proves visible fidelity.

### Concrete examples from current staging

- Jimenez p1:
  - `Form1040U.S.`
  - `Return2025`
- Jimenez p2:
  - `Page2`
  - `bothmust sign`
- Jimenez p11:
  - `bEmployer identification number`
- Smith p3:
  - `Attachment2025`
  - `Go towww.irs.gov/Form1040for instructions`
- Crestline p1:
  - `Form1065`
  - `Go towww.irs.gov/Form1065for instructions`

These are the defects this phase is meant to close.

---

## Research Summary

The next phase should be guided by industry-standard document extraction practice, not by ad hoc tuning on six PDFs.

### Research conclusion 1: PDFs do not contain a reliable text stream

PDF text extraction quality depends on reconstructing layout from geometry. Strong extractors group characters into words, lines, and higher-order boxes instead of trusting raw content order.

Sources:

- pdfminer.six: the format does not contain a text stream and layout analysis groups characters into words, lines, and boxes  
  <https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html>
- Reading order is a first-class document-intelligence problem, not an incidental formatting issue  
  <https://arxiv.org/abs/2409.19672>

### Research conclusion 2: Serious systems preserve structure before chunking

Modern document pipelines keep headings, headers, tables, lists, and hierarchical context before chunking. They do not flatten first and recover later.

Sources:

- Google Document AI Layout Parser: standard OCR flattens documents and destroys structure; layout parser creates context-aware chunks with ancestral context  
  <https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk>
- Azure Document Intelligence Layout: output includes lines, words, bounding boxes, tables, and natural reading order options  
  <https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0>
- AWS Textract: extraction returns layout elements, tables, bounding boxes, and confidence scores  
  <https://aws.amazon.com/documentation-overview/textract/>

### Research conclusion 3: Better chunk tests must evaluate multiple failure classes

Stronger evaluation separates:

- text fidelity
- reading order
- noise reduction
- completeness
- context coherence
- downstream retrieval usefulness

Sources:

- OCR-D: evaluation should localize aberrations within and across documents; naive CER is distorted by wrong reading order  
  <https://ocr-d.de/en/spec/ocrd_eval.html>
- AutoChunker: effective chunking evaluation should consider noise reduction, completeness, context coherence, task relevance, and retrieval performance  
  <https://aclanthology.org/2025.acl-industry.69.pdf>

### Research conclusion 4: Layout diversity matters

Benchmarks built only on narrow layouts overestimate real quality. Diverse layout variation is necessary.

Sources:

- DocLayNet: layout accuracy drops on challenging and diverse layouts if evaluation/training data are too narrow  
  <https://research.ibm.com/publications/doclaynet-a-large-human-annotated-dataset-for-document-layout-segmentation>

### Research conclusion 5: Do not add a third-party parser yet just to fix spacing

Managed parsers are useful for hard pages and scanned documents, but the current defect class is still in the native rendering path. The right next move is to strengthen fidelity evaluation and fix span/line/block rendering before adding a fallback.

---

## Strategic Decision

The next phase will stay inside **Tier 1** and will focus on:

1. **upgrading chunk-quality evaluation first**
2. **fixing intra-line spacing and line rendering**
3. **hardening reading-order and table/column checks**
4. **rerunning staging comparisons against the old baseline**

The next phase will **not**:

- add a managed parser
- add OCR for all documents
- expand `formType` rules again
- optimize chunk counts
- tune only against one or two screenshots

---

## Phase Overview

### Phase 0

Upgrade the chunk-quality test harness so it can fail on visible fidelity defects.

### Phase 1

Fix intra-line spacing reconstruction and token-boundary rendering.

### Phase 2

Fix line/header rendering artifacts and enforce ordered-anchor fidelity.

### Phase 3

Add table/column-sensitive challenge checks and block-aware chunk verification.

### Phase 4

Run local regression, then staging comparison against the old implementation and decide whether client-visible quality actually improved.

---

## Phase 0: Upgrade Chunk-Quality Evaluation

### Goal

Improve the verifier so it catches the actual remaining client-facing defect class: **visible chunk text fidelity**.

### Why this phase comes first

Right now the verifier proves stability and semantic coverage better than it proves rendered quality. That is why the pipeline can be green while staging still shows `Form1040U.S.` and `bothmust sign`.

### Mandatory dataset split

To reduce overfitting risk, the verifier work in this phase must explicitly separate pages into:

- **tuning pages**: pages the engineer is allowed to inspect while implementing fixes
- **holdout pages**: pages that represent the same failure classes but are not used for day-to-day tuning

At minimum, the holdout set must include at least:

- one Form 1040 continuation page
- one W-2 page
- one schedule page
- one business-return page
- one support/instructions page

The phase is not complete unless both tuning and holdout subsets are green.

### Issue classes this phase must cover

1. **Collapsed spacing**
   Examples:
   - `Form1040U.S.`
   - `Return2025`
   - `Page2`
   - `bothmust sign`
2. **Anchor-order corruption**
   Example:
   - header/title/year/source labels appearing in the wrong visible order
3. **Header-label rendering defects**
   Example:
   - `bEmployer identification number`
4. **Table/column-sensitive rendering defects**
   Example:
   - labels or cells rendered in visibly wrong adjacency order
5. **Chunk context quality**
   A chunk can contain the right tokens but still be a bad retrieval unit because it is noisy or context-switched.

### Files to inspect

- `scripts/verify-m2-pdf-quality.js`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `docs/pdf-extraction-tier1-baseline.md`
- `staging-tier1-retest-report.json`
- `src/lib/document-structure.ts`
- `src/lib/chunker.ts`

### Files to edit

- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`
- `docs/pdf-extraction-fidelity-next-phase-plan.md`

### Required implementation steps

1. Add a **rendered-fidelity assertion section** to the fixture file.
2. For each sampled high-value page, record:
   - expected top-of-page rendered prefix
   - expected mid-page rendered spans
   - forbidden collapsed forms
   - ordered anchors
3. Split the fixture set into **tuning** and **holdout** subsets.
4. Ensure both subsets exercise the same failure classes.
5. Keep the holdout subset out of day-to-day implementation spot-checking as much as practical.
6. Add a **forbidden artifact list** for exact known bad renderings, for example:
   - `Form1040U.S.`
   - `Return2025`
   - `Page2`
   - `yourtotal income`
   - `bothmust sign`
   - `Go towww.irs.gov/`
7. Add a **rendered-anchor order check** that verifies specific anchor strings appear in the correct order on a page.
8. Add a **spacing quality score** per sampled page, using exact forbidden forms and allowed normalized forms.
9. Add a **chunk context quality audit** for:
   - completeness
   - context switching
   - obvious noise concentration
   This can be deterministic and rule-based in Tier 1. Do not add LLM judges in this repo phase.
10. Print failures grouped by:
   - rendered spacing
   - anchor order
   - explicit form
   - resolved form
   - boundary integrity
   - table/column-sensitive order
11. Print results separately for tuning and holdout subsets.
12. Keep current value assertions, but demote them from primary signal to supporting signal.

### Verification commands

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
node scripts/verify-m2-api-boundary.js
```

### Exit criteria

- The verifier can fail on collapsed-spacing defects.
- The verifier can fail on wrong anchor order.
- The verifier can fail on bad rendered header labels.
- The verifier report groups failures by fidelity class.
- The six current PDFs are covered by page-level rendered-fidelity checks on the known problematic pages.
- Both tuning and holdout subsets are present and green.

### Anti-overfitting rules

- Do not encode entire pages as golden strings.
- Use anchor sequences, required spans, and forbidden forms.
- Every new assertion must represent a failure class, not a one-off literal unless the literal is a client-visible defect pattern.
- Do not pass the phase by hand-selecting only pages already known to improve.

---

## Phase 1: Intra-Line Spacing Reconstruction

### Goal

Fix the span-to-line rendering logic so adjacent tokens that should be separated are rendered with correct spacing.

### Target defect class

Spacing collapse between adjacent spans on the same rendered line.

### Likely root cause

The structure-first pipeline is still too aggressive when rendering adjacent spans back into line text. The current gap heuristics are strong enough for semantic content recovery, but not strong enough for client-visible text fidelity.

### Files to inspect

- `src/lib/document-structure.ts`
- `src/lib/pdf-processor.ts`
- `src/lib/text-cleaner.ts`
- `scripts/verify-m2-pdf-quality.js`

### Files to edit

- `src/lib/document-structure.ts`
- `src/lib/pdf-processor.ts`
- `src/lib/text-cleaner.ts`

### Required implementation steps

1. Audit how spans are rendered back into line text.
2. Make spacing insertion depend on geometry and token class, not only raw gap width.
3. Introduce explicit handling for common span-boundary cases:
   - word to word
   - word to punctuation
   - punctuation to word
   - label to value
   - title to year
   - field marker to field label
4. Preserve justified text and tight form layouts without blindly inserting spaces everywhere.
5. Add deterministic rules for known safe joins:
   - punctuation that should remain attached
   - decimal/currency forms
   - hyphenated carry-over forms only if geometry supports it
6. Add deterministic rules for known unsafe joins:
   - alpha-to-alpha joins where the original spans are distinct
   - title-to-year joins
   - word-to-URL joins
7. Keep normalization separate from rendering. Do not "repair" spacing later in cleaner code if the renderer can emit the right text earlier.

### Verification commands

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
```

### Exit criteria

- The known collapsed-spacing artifacts fail before the fix and pass after the fix.
- No regression in page-start correctness.
- No regression in form ownership.
- No regression in chunk counts or boundary checks.

### Anti-overfitting rules

- Do not add string replacements like `text.replace("Page2", "Page 2")`.
- Fix the rendering rule that creates the error.
- Any token-class rule must be generic enough to apply across unseen PDFs of the same layout pattern.

---

## Phase 2: Line Fidelity and Ordered-Anchor Rendering

### Goal

Fix visible line-level rendering quality so headers, labels, and important ordered anchors render in a client-reasonable way.

### Target defect class

The chunk contains the right information, but visible line output is still awkward or misleading because line composition is poor.

### Files to inspect

- `src/lib/document-structure.ts`
- `src/lib/pdf-processor.ts`
- `src/lib/chunker.ts`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`

### Files to edit

- `src/lib/document-structure.ts`
- `src/lib/pdf-processor.ts`
- `src/lib/chunker.ts`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`

### Required implementation steps

1. Audit line grouping tolerance for:
   - form headers
   - W-2 labels
   - schedule titles
   - filing instruction pages
2. Ensure lines are not over-merged vertically when the page uses compact government-form spacing.
3. Ensure adjacent labels are not incorrectly stitched into the prior token.
4. Add ordered-anchor checks for sampled pages, for example:
   - department/tax authority
   - form title
   - year
   - taxpayer name
   - page number marker
5. Ensure chunk rendering preserves those anchors in that order.
6. Keep page-local chunking semantics unchanged unless a line-level fix requires chunk text derivation updates.

### Verification commands

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-boundary-clean --enforce-form-threshold
```

### Exit criteria

- Ordered-anchor fidelity is green on the sampled pages.
- Header and label rendering is visibly improved on the known problematic pages.
- No chunk start regresses.
- No API boundary metadata regresses.

### Anti-overfitting rules

- Do not optimize only Form 1040 p1 and p2.
- At least one W-2 page, one schedule page, one business-return page, and one filing-instructions page must be represented in the checks.

---

## Phase 3: Table/Column-Sensitive Challenge Set and Chunk Quality Gate

### Goal

Make sure improvements for current forms do not damage table-heavy or column-sensitive pages, and make chunk quality evaluation more realistic.

### Target defect class

Output looks better on simple headers but gets worse on tables, side-by-side labels, or denser pages.

### Files to inspect

- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`
- `src/lib/document-structure.ts`
- `src/lib/chunker.ts`
- `staging-tier1-retest-report.json`

### Files to edit

- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`
- `src/lib/chunker.ts` if needed

### Required implementation steps

1. Promote at least one page from each of these categories into the challenge set:
   - W-2
   - schedule with dense labels
   - business return with compact layout
   - filing instructions/support page
2. Ensure at least one challenge page per category is holdout-only.
3. Add table/column-sensitive anchor-order checks.
4. Add a chunk-level rule that flags excessive context switching inside one chunk.
5. Add a chunk-level rule that flags chunks with too many known rendering artifacts even if values are present.
6. Ensure chunk quality scoring distinguishes:
   - text presence
   - text fidelity
   - chunk coherence
7. Keep the chunk-quality gate deterministic and fast enough to run in the standard local release gate.

### Verification commands

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-boundary-clean --enforce-form-threshold
node scripts/verify-m2-completeness-gating.js
```

### Exit criteria

- The verifier now covers table/column-sensitive rendering.
- Chunk-quality reporting distinguishes fidelity from mere presence.
- The gate fails if a page becomes semantically intact but visibly degraded.
- Holdout challenge pages remain green without separate one-off tuning.

### Anti-overfitting rules

- Do not add a page to the challenge set only because it is easy to pass.
- Every challenge page must represent a distinct layout stressor.

---

## Phase 4: Local-to-Staging Comparison and Client-Retest Decision

### Goal

Prove whether this phase produced a real client-visible improvement relative to the old staging implementation.

### Files to inspect

- `docs/pdf-extraction-tier1-baseline.md`
- `staging-tier1-retest-report.json`
- any newly generated local comparison report

### Files to add

- `docs/pdf-extraction-fidelity-phase-results.md`

### Files to edit

- `docs/pdf-extraction-fidelity-next-phase-plan.md`
- `docs/pdf-extraction-fidelity-phase-results.md`

### Required implementation steps

1. Run the full local release gate.
2. Compare before/after on the known problematic pages using:
   - required spans
   - forbidden forms
   - ordered anchors
3. Deploy only if the local gate shows client-visible fidelity improvement.
4. On staging, rerun the same 6 PDFs and capture:
   - chunk counts
   - inspected page snippets
   - forbidden forms still present or removed
5. Produce a concise before/after evidence file.

### Verification commands

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-api-boundary.js
```

### Exit criteria

- The local gate is green.
- The known rendered artifacts are materially reduced.
- A staging rerun shows visible chunk-text improvement, not only stable counts.
- The evidence file states clearly whether the client should retest now.

### Hard stop

Do **not** ask the client to retest if:

- chunk counts are stable but rendered text is still visibly poor
- forbidden artifact strings still dominate the sampled pages
- local improvements do not survive staging deployment

---

## Standard Worker Order

The worker should execute the next phase in this order:

1. Phase 0
2. Critic review
3. Phase 1
4. Critic review
5. Phase 2
6. Critic review
7. Phase 3
8. Critic review
9. Phase 4
10. Final critic review

Do not batch all phases into one large patch before review.

---

## Required Worker Handoff After Each Phase

After each phase, report:

1. files changed
2. commands run
3. exact results
4. what failure classes are now covered
5. what remains intentionally unresolved until the next phase

If a verifier gap remains, say so plainly.

---

## Final Recommendation

Yes, research was necessary before planning this phase.

The research supports a clear direction:

- fix the evaluation gap first
- then fix spacing and rendering at the structure/line layer
- then validate against table/column-sensitive pages
- only then decide whether the client should retest

That is the lowest-risk path to a better product without overfitting the current examples.
