# PDF Extraction Punctuation Baseline

This file freezes the pre-change baseline for the punctuation-fidelity phase.

Primary source:

- `staging-exhaustive-coverage-report.json`

Use this baseline for before/after comparison. Do not update it during the implementation pass.

## Global Baseline

- documents audited: `6`
- pages audited: `246`
- chunks audited: `231`
- metadata anomalies: `0`
- hard-fail artifact hits: `0`
- review-hit total: `252`

Review-hit counts by class:

- `punctuation-word-join`: `222`
- `numbered-label-join`: `22`
- `field-value-join`: `8`

## Per-Document Baseline

### 2025 Tax Return Documents (Jimenez Julio).pdf

- chunks: `20`
- pages without chunks: `5` (verified blank/non-text pages)
- review counts:
  - `punctuation-word-join`: `26`

Representative exemplars:

- page `2`: `you.If`
- page `2`: `Yes.Complete`
- page `4`: `A.Interview`
- page `4`: `B.Complete`
- page `4`: `C.Submit`
- page `4`: `D.Keep`

### 2025 Tax Return Documents (Whittaker Jordan).pdf

- chunks: `23`
- pages without chunks: `5` (verified blank/non-text pages)
- review counts:
  - `punctuation-word-join`: `10`

Representative exemplars:

- page `2`: `you.If`
- page `2`: `Yes.Complete`
- page `3`: `PIN.Enter`
- page `5`: `contract.If`
- page `5`: `used.Use`

### 2025 Tax Return Documents (ELLINGTON PETER).pdf

- chunks: `41`
- pages without chunks: `6` (verified blank/non-text pages)
- review counts:
  - `punctuation-word-join`: `38`
  - `numbered-label-join`: `4`

Representative exemplars:

- page `2`: `you.If`
- page `2`: `Yes.Complete`
- page `3`: `Sequence No.02`
- page `6`: `Sequence No.72`
- page `7`: `money order.Make`
- page `7`: `payment.Enter`

### 2025 Tax Return Documents (SHOEMAKER JOHNNY and ANNIE).pdf

- chunks: `60`
- pages without chunks: `6` (verified blank/non-text pages)
- review counts:
  - `punctuation-word-join`: `84`
  - `numbered-label-join`: `12`
  - `field-value-join`: `2`

Representative exemplars:

- page `2`: `you.If`
- page `2`: `Yes.Complete`
- page `3`: `income.Enter`
- page `4`: `income.Enter`
- page `12`: `U.S.Territory`
- page `12`: `Sequence No.19`
- page `50`: `COBBLER2`

### 2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf

- chunks: `50`
- pages without chunks: `6` (verified blank/non-text pages)
- review counts:
  - `punctuation-word-join`: `49`
  - `numbered-label-join`: `6`

Representative exemplars:

- page `2`: `you.If`
- page `2`: `Yes.Complete`
- page `3`: `income.Enter`
- page `4`: `income.Enter`
- page `6`: `money order.Make`
- page `6`: `payment.Enter`
- page `7`: `line 1a`

### 2025 Tax Return Documents (Crestline Financial Group LLC).pdf

- chunks: `37`
- pages without chunks: `6` (verified blank/non-text pages)
- review counts:
  - `punctuation-word-join`: `15`
  - `field-value-join`: `6`

Representative exemplars:

- page `1`: `Total deductions.Add`
- page `1`: `Total balance due.Add`
- page `1`: `Tax and Payment31`
- page `1`: `Amount owed.If`
- page `1`: `Overpayment.If`
- page `1`: `below?See`
- page `1`: `Deductions21`

## Counterexample Guardrail Set

These compact forms must remain valid after the phase:

- `734(b)`
- `4(b)`
- `U.S.`
- `P.O.`
- `No.` when not followed by a separated numeric label token
- `box 2a`
- `line 1a`
- `pg01`
- `J.R.`
- `www.irs.gov/Form1040`
- `www.irs.gov/Form1065`
- `12.34`
- `7.5%`

## Promotion Rules Against This Baseline

- targeted classes must go down versus this file
- non-target review classes must not increase materially
- no new review class may appear above a trivial threshold
- hard-fail artifact hits must remain `0`
- metadata anomalies must remain `0`
- any chunk-count delta must be documented per document and justified by green fidelity and boundary checks
