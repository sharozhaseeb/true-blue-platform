# M2 PDF Quality Verification

This verifier adds regression coverage for the sample PDFs in `../client_shared_pdfs` before Milestone 3 relies on M2 chunks for retrieval and answer generation.

## What It Checks

- Page count matches the known sample PDF baseline
- Known values from the sample PDFs still appear in the extracted chunks
- Manually labeled pages report form types accurately enough to be usable
- Oversized pages are audited for overlap-based chunk starts that land mid-token

## Run It

```bash
npm run verify:m2-quality
```

Optional quality-gate flags:

```bash
npm run verify:m2-quality -- --enforce-form-threshold --enforce-boundary-clean
```

If the sample PDFs live somewhere else, point the script at them:

```powershell
$env:M2_PDF_FIXTURE_DIR="C:\path\to\client_shared_pdfs"
npm run verify:m2-quality
```

Or:

```bash
npm run verify:m2-quality -- --pdf-dir ../client_shared_pdfs
```

## Ground Truth Workflow

The committed fixtures are intentionally small and human-reviewed. When you add or update assertions:

1. Open the source PDF directly and verify the value on the page.
2. Prefer short, stable phrases or values that should survive normalization.
3. For form labels, treat support pages, filing instructions, worksheets, and summaries as `null` unless the page is actually that IRS form.
4. Expand the fixture file in `scripts/fixtures/m2-pdf-quality-fixtures.js`.

`pdftotext -layout` is useful for reviewing page text without relying on the application pipeline:

```bash
pdftotext -f 8 -l 8 -layout "../client_shared_pdfs/2025 Tax Return Documents (Crestline Financial Group LLC).pdf" -
```

## Current Risk Signals

The verifier is meant to expose issues before M3, not hide them:

- Form detection now requires three pieces of evidence together — a
  form-header signature (e.g. `Schedule B (Form 1040)`), the official title
  in Title Case, and the form-specific `OMB No. 1545-xxxx` marker — so that
  body-text mentions on worksheets, Form 1040 page 2, Schedule 1/2/3, and
  the Form 9325 e-file acknowledgement no longer trip the detector.
- The current extractor still flattens page text into space-separated runs,
  so paragraph-aware splitting never activates on these samples; force-split
  overlap starts are audited by the boundary gate.
- Against the expanded fixture (52 labels across the 6 sample PDFs, including
  explicit negative labels for the known false-positive classes) the detector
  reaches 100% precision and 100% recall, and both `--enforce-boundary-clean`
  and `--enforce-form-threshold` pass. Form detection only covers pages that
  carry their own full IRS header (so multi-page forms like Form 1040 p2 are
  still labeled `null` — they cannot be identified from page text alone
  without document-level context).
