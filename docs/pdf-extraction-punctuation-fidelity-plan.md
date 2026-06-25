# PDF Extraction Punctuation Fidelity Plan

## Purpose

This plan covers the next extraction phase after:

- Tier 1 structure-first extraction
- spacing reconstruction
- parenthetical and standalone-currency rendering fixes
- exhaustive staging coverage of all 6 client PDFs

Current staging is materially better than the old implementation, but the exhaustive audit still shows visible renderer defects that a strict client can notice during side-by-side review.

This phase is intentionally narrow. It is **not** a general extraction rewrite. It is a renderer-fidelity pass for the remaining text-joining classes that still survive on staging.

Frozen baseline for this phase:

- `docs/pdf-extraction-punctuation-baseline.md`
- `staging-exhaustive-coverage-report.json`

## Current Evidence

Primary evidence file:

- `staging-exhaustive-coverage-report.json`

What is already proven clean:

- `0` metadata anomalies
- `0` hard-fail artifact hits
- no hidden dropped-text pages in the reported `pagesWithoutChunks` ranges; those pages are actually zero-text pages in the source PDFs
- no current chunk-start or form-propagation blocker

What still survives:

- `222` punctuation-word join review hits
- `22` numbered-label join review hits

Examples pulled from the exhaustive report:

- `you.If`
- `Yes.Complete`
- `A.Interview`
- `B.Complete`
- `C.Submit`
- `D.Keep`
- `below?See`
- `PIN.Enter`
- `Total deductions.Add`
- `Amount owed.If`
- `Overpayment.If`
- `Sequence No.02`
- `Payment31`

## Architectural Goal

Fix the remaining issues at the **renderer rule level**, not with page-specific replacements.

The intended result is:

- better sentence and label readability in chunk text
- no regression in chunk boundaries or form ownership
- preserved compact legal/tax citations such as `734(b)`
- preserved URLs such as `www.irs.gov/Form1040`
- preserved valid punctuation-bound forms such as decimals, percentages, and account/routing formats unless geometry clearly indicates a visible space

## Non-Goals

This phase does **not**:

- change chunk sizing policy
- change form detection logic
- add OCR or third-party parsers
- change API metadata shape
- tune only for the six PDFs by literal replacements

## Issue Classes To Fix

### Class 1: Sentence punctuation joins

Visible text is missing a space after sentence-like punctuation where the next span clearly starts a new sentence or directive.

Examples:

- `you.If`
- `Yes.Complete`
- `A.Interview`
- `B.Complete`
- `C.Submit`
- `D.Keep`
- `below?See`
- `PIN.Enter`

### Class 2: Numbered-label joins

Rendered labels like `Sequence No.02` should be `Sequence No. 02` when geometry shows the number is a distinct visible token.

Examples:

- `Sequence No.02`
- `Sequence No.03`
- `Sequence No.12`
- `Sequence No.17`
- `Sequence No.55`
- `Sequence No.72`

### Class 3: Compact field/value joins

Adjacent labels and values are still missing a visual space in some dense form regions.

Examples:

- `Payment31`
- `deductions.Add`
- `owed.If`
- `overpayment.If`

## Counterexamples That Must Not Break

These must remain valid after the fix:

- `734(b)`
- `4(b)`
- `U.S.`
- `P.O.`
- `No.` when it is part of a true abbreviation rather than a label-number boundary
- `box 2a`
- `line 1a`
- `pg01`
- initials such as `J.R.`
- `www.irs.gov/Form1040`
- `www.irs.gov/Form1065`
- decimals like `12.34`
- percentages like `7.5%`
- currency/negative forms that are intentionally compact in the source geometry

## Files To Inspect

- `src/lib/document-structure.ts`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-pdf-quality.js`
- `scripts/verify-m2-staging-exhaustive-coverage.js`
- `staging-exhaustive-coverage-report.json`

## Files Expected To Change

- `src/lib/document-structure.ts`
- `scripts/fixtures/m2-pdf-quality-fixtures.js`
- `scripts/verify-m2-staging-exhaustive-coverage.js`
- `docs/pdf-extraction-punctuation-fidelity-plan.md`
- `docs/pdf-extraction-punctuation-baseline.md`

`scripts/verify-m2-pdf-quality.js` must change if the current fixture vocabulary does not yet contain:

- one positive example that should gain a space for each new renderer rule class
- one counterexample that must stay compact for each new renderer rule class

## Phase Breakdown

### Phase 0: Tighten The Audit Before The Fix

#### Goal

Make sure the exhaustive audit distinguishes:

- real remaining renderer issues
- legitimate compact tokens and URLs
- blank-page expectations

#### Required edits

- freeze the pre-change baseline in `docs/pdf-extraction-punctuation-baseline.md` with:
  - global counts by class
  - per-document counts by class
  - representative page/snippet exemplars for each remaining class
- refine review classes in `scripts/verify-m2-staging-exhaustive-coverage.js`
- expand local fixtures so each targeted renderer rule has:
  - one positive example that should gain a space
  - one negative counterexample that must remain compact

#### Required checks

Run:

```powershell
node scripts/verify-m2-staging-exhaustive-coverage.js
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
```

#### Exit criteria

- no hard-fail artifact noise from URLs or legal citations
- review hits are concentrated in the real remaining classes
- frozen baseline exists and is specific enough to support before/after comparison
- local quality verifier stays green

### Phase 1: Sentence-Punctuation Rendering

#### Goal

Insert visible spaces after sentence-like punctuation when the following span clearly starts a new sentence, instruction, or enumerated item.

#### Target code

- `src/lib/document-structure.ts`

#### Required implementation rules

1. Use span geometry and token shape, not literal text replacement.
2. Allow spaces after punctuation only when the next token looks like a new sentence/directive:
   - uppercase word
   - enumerated instruction token
   - explicit yes/no directive token
3. Do not insert spaces inside:
   - decimals
   - URLs
   - compact abbreviations that are genuinely one visible token
4. Preserve compact citations already protected by earlier fixes.
5. Add local positive and negative fixture assertions for every new punctuation rule before treating the phase as complete.

#### Verification commands

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
node scripts/verify-m2-staging-exhaustive-coverage.js
```

#### Exit criteria

- sentence-punctuation review hits drop versus the frozen baseline
- no increase in non-target review classes
- no new review class appears above a trivial threshold
- no new hard-fail artifacts appear
- no regression in metadata or current rendered fixes
- any chunk-count delta is small, explained per document, and accompanied by green boundary/fidelity checks

### Phase 2: Numbered Labels And Compact Field/Value Boundaries

#### Goal

Fix label-number and label-value joins without harming compact tax notation.

#### Target code

- `src/lib/document-structure.ts`
- fixture additions in `scripts/fixtures/m2-pdf-quality-fixtures.js`

#### Required implementation rules

1. Add a renderer rule for labels like `No.` followed by a distinct numeric token.
2. Add a renderer rule for compact field/value joins like `Payment31` only when geometry indicates separate tokens.
3. Preserve:
   - `734(b)`
   - `4(b)`
   - `U.S.`
   - `P.O.`
   - `line 1a`
   - `box 2a`
   - `pg01`
   - URL paths
   - tightly packed numeric forms that are visibly single-token
4. Add local positive and negative fixture assertions for each label/value rule class before treating the phase as complete.

#### Verification commands

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
node scripts/verify-m2-staging-exhaustive-coverage.js
```

#### Exit criteria

- numbered-label review hits drop versus the frozen baseline
- compact field/value joins drop versus the frozen baseline
- no increase in non-target review classes
- no new review class appears above a trivial threshold
- legal citations and URLs remain clean
- any chunk-count delta is small, explained per document, and accompanied by green boundary/fidelity checks

### Phase 3: Local Release Gate And Staging Promotion

#### Goal

Only promote if local and exhaustive gates show that the remaining renderer classes improved without new regressions.

#### Required local commands

```powershell
npx tsc --noEmit
npm run build
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs --enforce-form-threshold --enforce-boundary-clean
node scripts/verify-m2-completeness-gating.js
node scripts/verify-m2-api-boundary.js
node scripts/verify-m2-staging-exhaustive-coverage.js
```

#### Promotion criteria

- local verifier green
- exhaustive audit: `0` metadata anomalies
- exhaustive audit: `0` hard-fail artifact hits
- targeted review-hit counts reduced versus the frozen baseline
- no increase in non-target review classes outside a trivial threshold
- no new review class above a trivial threshold
- no unexplained large chunk-count delta on the 6 PDFs

### Phase 4: Staging Retest

#### Goal

Deploy only after the local gates are green, then rerun the exhaustive staging audit and compare counts against the pre-deploy baseline.

#### Required staging checks

1. deploy new image
2. rerun:

```powershell
node scripts/verify-m2-staging-exhaustive-coverage.js
```

3. compare:
   - metadata anomalies
   - hard-fail artifact hits
   - review-hit totals by class
   - review-hit totals by document and class
   - top recurring exemplars before/after for each surviving class
   - chunk counts by document

#### Exit criteria

- staging remains at `0` metadata anomalies
- staging remains at `0` hard-fail artifact hits
- punctuation-word joins and numbered-label joins are reduced versus the frozen baseline
- no increase in non-target review classes outside a trivial threshold
- no new severe review class appears above a trivial threshold
- no new severe artifact class appears

## Anti-Overfitting Rules

1. No literal page-specific replacements such as:
   - `replace("Yes.Complete", "Yes. Complete")`
   - `replace("No.02", "No. 02")`
2. Every renderer change must be explainable as a generic punctuation or label-boundary rule.
3. Every new fixture should represent a class, not a single screenshot artifact.
4. Any newly added rule must have at least one counterexample asserting what must **not** change.
5. Do not accept “same total, different page” drift without a document-level explanation.

## Hard Stop Conditions

Do not deploy if:

- a fix depends on literal page-specific text substitution
- URLs or compact tax citations regress
- hard-fail artifact count rises above `0`
- metadata anomalies appear
- a non-target review class increases without explanation
- a new review class appears above a trivial threshold
- chunk counts regress materially on the 6 PDFs without a documented per-document explanation

## Expected Outcome

If this phase succeeds, the system should move from:

- structurally correct but still visibly awkward

to:

- structurally correct and materially cleaner for client side-by-side review

without pretending the system is universally perfect on unseen PDF families.
