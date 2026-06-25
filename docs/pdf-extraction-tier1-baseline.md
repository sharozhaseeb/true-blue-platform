# Tier 1 Phase 1 Baseline

Captured before any Phase 1 verifier or fixture changes on `2026-04-23`.

## Command

```powershell
node scripts/verify-m2-pdf-quality.js --pdf-dir ..\client_shared_pdfs
```

## Baseline Result

| PDF | Pages | Chunks |
| --- | ---: | ---: |
| `2025 Tax Return Documents (Jimenez Julio).pdf` | 22/22 | 21 |
| `2025 Tax Return Documents (Whittaker Jordan).pdf` | 25/25 | 24 |
| `2025 Tax Return Documents (ELLINGTON PETER).pdf` | 43/43 | 41 |
| `2025 Tax Return Documents (SHOEMAKER JOHNNY and ANNIE).pdf` | 63/63 | 60 |
| `2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf` | 52/52 | 50 |
| `2025 Tax Return Documents (Crestline Financial Group LLC).pdf` | 41/41 | 37 |

All current checks passed:

- page-count assertions passed
- value assertions passed
- page-start and chunk-metadata assertions passed
- form detection was `100.0%` exact accuracy, `100.0%` precision, and `100.0%` recall
- emitted chunk boundary audit found `0` failures across `233` chunks
- heuristic overlap audit found `0` mid-token starts across `10` checks
- paragraph-split reconstruction found `0` failures across `7` synthetic chunks

## Exact Summary Output

```text
Value Assertions
All page-count, value, page-start, and chunk-metadata assertions passed.

Form Detection
Exact page accuracy: 100.0% (60/60)
Precision: 100.0% Recall: 100.0%
All manually labeled pages matched.

Chunk Boundary Audit
Emitted chunks checked: 233
Emitted boundary failures: 0
All emitted chunk boundary checks passed.

Heuristic overlap starts checked: 10
Mid-token starts detected: 0
No mid-token overlap starts detected.

Paragraph Split Integrity
Paragraph-split reconstruction failures: 0
Synthetic paragraph-split chunks checked: 7
All paragraph-split reconstruction checks passed.
```

## Baseline Notes

- This is the frozen pre-Phase-1 quality baseline for the current sample PDFs.
- Phase 1 improvements must be measured against this exact result set.

## Exact Captures

All snippets below are normalized substrings that the Phase 1 verifier now checks directly.

| Capture | Page-start snippet | Mid-page snippet | Explicit | Resolved | First-chunk metadata | First-chunk start snippet |
| --- | --- | --- | --- | --- | --- | --- |
| Jimenez p1 | `department of the treasury-internal revenue service form 1040 u.s. individual income tax return 2025` | `-` | `Form 1040` | `Form 1040` | `explicit=form 1040 \| resolved=form 1040 \| source=explicit \| origin=1 \| pages=1 \| range=- \| start=true \| end=false \| partial=true \| part=0` | `department of the treasury-internal revenue service form 1040 u.s. individual income tax return 2025` |
| Jimenez p2 | `form 1040 (2025) julio jimenez 500-00-1003 page 2 tax and 11 b amount from line 11 a (adjusted gross income)` | `-` | `null` | `Form 1040` | `explicit=null \| resolved=form 1040 \| source=propagated \| origin=1 \| pages=2 \| range=- \| start=true \| end=false \| partial=true \| part=0` | `form 1040 (2025) julio jimenez 500-00-1003 page 2 tax and 11 b amount from line 11 a (adjusted gross income)` |
| Jimenez p3 | `form 8867 paid preparer's due diligence checklist omb no. 1545-0074 earned income credit (eic), american opportunity tax credit (aotc)` | `-` | `Form 8867` | `Form 8867` | `explicit=form 8867 \| resolved=form 8867 \| source=explicit \| origin=3 \| pages=3 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `form 8867 paid preparer's due diligence checklist omb no. 1545-0074 earned income credit (eic), american opportunity tax credit (aotc)` |
| Jimenez p4 | `form 8867 (rev. 11-2024) julio jimenez 500-00-1003 page 2 part ii due diligence questions for returns claiming eic` | `-` | `null` | `Form 8867` | `explicit=null \| resolved=form 8867 \| source=propagated \| origin=3 \| pages=4 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `form 8867 (rev. 11-2024) julio jimenez 500-00-1003 page 2 part ii due diligence questions for returns claiming eic` |
| Jimenez p11 | `a employee's social security number safe, accurate, visit the irs website at 500-00-1003 omb no. 1545-0008 fast! use irs e-file www.irs.gov/efile bemployer identification number (ein) 1 wages, tips, other compensation 2` | `1 wages, tips, other compensation 2 federal income tax withheld 54-0455395 6,938 56 c employer's name, address, and zip code 3 social security wages 4 social security tax withheld goodwill of central and coastal` | `W-2` | `W-2` | `explicit=w-2 \| resolved=w-2 \| source=explicit \| origin=11 \| pages=11 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `a employee's social security number safe, accurate, visit the irs website at 500-00-1003 omb no. 1545-0008 fast! use irs e-file www.irs.gov/efile bemployer identification number (ein) 1 wages, tips, other compensation 2` |
| Jimenez p12 | `earned income credit worksheet - form 1040 or 1040-sr, line 27 a (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003 1. enter the` | `2. enter any amount from schedule 1 (form 1040), line 8 s, that is a medicaid waiver payment that you exclude from income, unless you choose to include this amount in earned income` | `null` | `null` | `explicit=null \| resolved=null \| source=null \| origin=null \| pages=12 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `earned income credit worksheet - form 1040 or 1040-sr, line 27 a (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003 1. enter the` |
| Jimenez p13 | `carryover worksheet list of items that will carryover to the 2026 tax return (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003` | `itemized deductions carryover amount` | `null` | `null` | `explicit=null \| resolved=null \| source=null \| origin=null \| pages=13 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `carryover worksheet list of items that will carryover to the 2026 tax return (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003` |
| Jimenez p15 | `2025 filing instructions julio jimenez form filed: form 1040 and supplemental forms and schedules filing method: your return will be e-filed once your signed and dated form 8879 has been received by this office. do not m` | `due date: 04-15-2026 refund: $586 transaction method: your refund will be sent as a check from the irs` | `null` | `null` | `explicit=null \| resolved=null \| source=null \| origin=null \| pages=15 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `2025 filing instructions julio jimenez form filed: form 1040 and supplemental forms and schedules filing method: your return will be e-filed once your signed and dated form 8879 has been received by this office. do not m` |
| Ellington p21 | `9898 void corrected payer's name, street address, city or town, state or province, 1 gross distribution omb no. 1545-0119 distributions from country, zip or foreign postal code, and telephone no. pensions, annuities` | `2 b taxable amount total not determined distribution copy a for payer's tin recipient's tin 3 capital gain (included in 4 federal income tax box 2 a) withheld internal revenue service center 23-2186884 500-00-1005` | `1099-R` | `1099-R` | `explicit=1099-r \| resolved=1099-r \| source=explicit \| origin=21 \| pages=21 \| range=- \| start=true \| end=true \| partial=false \| part=null` | `9898 void corrected payer's name, street address, city or town, state or province, 1 gross distribution omb no. 1545-0119 distributions from country, zip or foreign postal code, and telephone no. pensions, annuities` |

## Phase 6 Comparison

This section is intentionally separate from the frozen baseline above. It records
baseline versus current values for every frozen capture represented in this
document. All captures below stayed stable in the Phase 6 gate runs; no visible
page-level regression was observed.

| Page | Baseline | Current | Status |
| --- | --- | --- | --- |
| Jimenez p1 | page-start `department of the treasury-internal revenue service form 1040 u.s. individual income tax return 2025`; mid/chunk `-`; explicit `Form 1040`; resolved `Form 1040`; first-chunk metadata `explicit=form 1040 \| resolved=form 1040 \| source=explicit \| origin=1 \| pages=1 \| range=- \| start=true \| end=false \| partial=true \| part=0` | page-start `department of the treasury-internal revenue service form 1040 u.s. individual income tax return 2025`; mid/chunk `-`; explicit `Form 1040`; resolved `Form 1040`; first-chunk metadata `explicit=form 1040 \| resolved=form 1040 \| source=explicit \| origin=1 \| pages=1 \| range=- \| start=true \| end=false \| partial=true \| part=0` | stable |
| Jimenez p2 | page-start `form 1040 (2025) julio jimenez 500-00-1003 page 2 tax and 11 b amount from line 11 a (adjusted gross income)`; mid/chunk `-`; explicit `null`; resolved `Form 1040`; first-chunk metadata `explicit=null \| resolved=form 1040 \| source=propagated \| origin=1 \| pages=2 \| range=- \| start=true \| end=false \| partial=true \| part=0` | page-start `form 1040 (2025) julio jimenez 500-00-1003 page 2 tax and 11 b amount from line 11 a (adjusted gross income)`; mid/chunk `-`; explicit `null`; resolved `Form 1040`; first-chunk metadata `explicit=null \| resolved=form 1040 \| source=propagated \| origin=1 \| pages=2 \| range=- \| start=true \| end=false \| partial=true \| part=0` | stable |
| Jimenez p3 | page-start `form 8867 paid preparer's due diligence checklist omb no. 1545-0074 earned income credit (eic), american opportunity tax credit (aotc)`; mid/chunk `-`; explicit `Form 8867`; resolved `Form 8867`; first-chunk metadata `explicit=form 8867 \| resolved=form 8867 \| source=explicit \| origin=3 \| pages=3 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `form 8867 paid preparer's due diligence checklist omb no. 1545-0074 earned income credit (eic), american opportunity tax credit (aotc)`; mid/chunk `-`; explicit `Form 8867`; resolved `Form 8867`; first-chunk metadata `explicit=form 8867 \| resolved=form 8867 \| source=explicit \| origin=3 \| pages=3 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |
| Jimenez p4 | page-start `form 8867 (rev. 11-2024) julio jimenez 500-00-1003 page 2 part ii due diligence questions for returns claiming eic`; mid/chunk `-`; explicit `null`; resolved `Form 8867`; first-chunk metadata `explicit=null \| resolved=form 8867 \| source=propagated \| origin=3 \| pages=4 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `form 8867 (rev. 11-2024) julio jimenez 500-00-1003 page 2 part ii due diligence questions for returns claiming eic`; mid/chunk `-`; explicit `null`; resolved `Form 8867`; first-chunk metadata `explicit=null \| resolved=form 8867 \| source=propagated \| origin=3 \| pages=4 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |
| Jimenez p11 | page-start `a employee's social security number safe, accurate, visit the irs website at 500-00-1003 omb no. 1545-0008 fast! use irs e-file www.irs.gov/efile bemployer identification number (ein) 1 wages, tips, other compensation 2`; mid/chunk `1 wages, tips, other compensation 2 federal income tax withheld 54-0455395 6,938 56 c employer's name, address, and zip code 3 social security wages 4 social security tax withheld goodwill of central and coastal`; explicit `W-2`; resolved `W-2`; first-chunk metadata `explicit=w-2 \| resolved=w-2 \| source=explicit \| origin=11 \| pages=11 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `a employee's social security number safe, accurate, visit the irs website at 500-00-1003 omb no. 1545-0008 fast! use irs e-file www.irs.gov/efile bemployer identification number (ein) 1 wages, tips, other compensation 2`; mid/chunk `1 wages, tips, other compensation 2 federal income tax withheld 54-0455395 6,938 56 c employer's name, address, and zip code 3 social security wages 4 social security tax withheld goodwill of central and coastal`; explicit `W-2`; resolved `W-2`; first-chunk metadata `explicit=w-2 \| resolved=w-2 \| source=explicit \| origin=11 \| pages=11 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |
| Jimenez p12 | page-start `earned income credit worksheet - form 1040 or 1040-sr, line 27 a (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003 1. enter the`; mid/chunk `2. enter any amount from schedule 1 (form 1040), line 8 s, that is a medicaid waiver payment that you exclude from income, unless you choose to include this amount in earned income`; explicit `null`; resolved `null`; first-chunk metadata `explicit=null \| resolved=null \| source=null \| origin=null \| pages=12 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `earned income credit worksheet - form 1040 or 1040-sr, line 27 a (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003 1. enter the`; mid/chunk `2. enter any amount from schedule 1 (form 1040), line 8 s, that is a medicaid waiver payment that you exclude from income, unless you choose to include this amount in earned income`; explicit `null`; resolved `null`; first-chunk metadata `explicit=null \| resolved=null \| source=null \| origin=null \| pages=12 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |
| Jimenez p13 | page-start `carryover worksheet list of items that will carryover to the 2026 tax return (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003`; mid/chunk `itemized deductions carryover amount`; explicit `null`; resolved `null`; first-chunk metadata `explicit=null \| resolved=null \| source=null \| origin=null \| pages=13 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `carryover worksheet list of items that will carryover to the 2026 tax return (this page is not filed with the return. it is for your records only.) 2025 name(s) as shown on return tax id number julio jimenez 500-00-1003`; mid/chunk `itemized deductions carryover amount`; explicit `null`; resolved `null`; first-chunk metadata `explicit=null \| resolved=null \| source=null \| origin=null \| pages=13 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |
| Jimenez p15 | page-start `2025 filing instructions julio jimenez form filed: form 1040 and supplemental forms and schedules filing method: your return will be e-filed once your signed and dated form 8879 has been received by this office. do not m`; mid/chunk `due date: 04-15-2026 refund: $586 transaction method: your refund will be sent as a check from the irs`; explicit `null`; resolved `null`; first-chunk metadata `explicit=null \| resolved=null \| source=null \| origin=null \| pages=15 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `2025 filing instructions julio jimenez form filed: form 1040 and supplemental forms and schedules filing method: your return will be e-filed once your signed and dated form 8879 has been received by this office. do not m`; mid/chunk `due date: 04-15-2026 refund: $586 transaction method: your refund will be sent as a check from the irs`; explicit `null`; resolved `null`; first-chunk metadata `explicit=null \| resolved=null \| source=null \| origin=null \| pages=15 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |
| Ellington p21 | page-start `9898 void corrected payer's name, street address, city or town, state or province, 1 gross distribution omb no. 1545-0119 distributions from country, zip or foreign postal code, and telephone no. pensions, annuities`; mid/chunk `2 b taxable amount total not determined distribution copy a for payer's tin recipient's tin 3 capital gain (included in 4 federal income tax box 2 a) withheld internal revenue service center 23-2186884 500-00-1005`; explicit `1099-R`; resolved `1099-R`; first-chunk metadata `explicit=1099-r \| resolved=1099-r \| source=explicit \| origin=21 \| pages=21 \| range=- \| start=true \| end=true \| partial=false \| part=null` | page-start `9898 void corrected payer's name, street address, city or town, state or province, 1 gross distribution omb no. 1545-0119 distributions from country, zip or foreign postal code, and telephone no. pensions, annuities`; mid/chunk `2 b taxable amount total not determined distribution copy a for payer's tin recipient's tin 3 capital gain (included in 4 federal income tax box 2 a) withheld internal revenue service center 23-2186884 500-00-1005`; explicit `1099-R`; resolved `1099-R`; first-chunk metadata `explicit=1099-r \| resolved=1099-r \| source=explicit \| origin=21 \| pages=21 \| range=- \| start=true \| end=true \| partial=false \| part=null` | stable |

Phase 6 changes are therefore gate-strengthening rather than visible fidelity changes on the frozen sample pages:

- under-extracted synthetic cases still fail
- healthy sample PDFs still complete
- the local release gate now runs with structured extraction, boundary enforcement, and completeness verification together
