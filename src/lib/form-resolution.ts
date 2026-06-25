import type { PageText } from "@/lib/pdf-processor";

export type FormTypeSource = "explicit" | "propagated";

export interface ResolvedPageForm {
  pageNumber: number;
  explicitFormType: string | null;
  resolvedFormType: string | null;
  formTypeSource: FormTypeSource | null;
  formTypeOriginPage: number | null;
}

type FormRule = {
  formType: string;
  required: RegExp[];
  continuation?: RegExp[];
  minimumContinuationMatches?: number;
  topOfPageHints?: RegExp[];
};

const OMB_1040 = /OMB No\.?\s*1545-0074/i;
const OMB_1065 = /OMB No\.?\s*1545-0123/i;
const OMB_1120 = /OMB No\.?\s*1545-0123/i;
const OMB_990 = /OMB No\.?\s*1545-0047/i;
const OMB_941 = /OMB No\.?\s*1545-0029/i;
const OMB_W2 = /OMB No\.?\s*1545-0008/i;
const OMB_W9 = /OMB No\.?\s*1545-1621/i;
const OMB_1099_MISC = /OMB No\.?\s*1545-0115/i;
const OMB_1099_NEC = /OMB No\.?\s*1545-0116/i;
const OMB_1099_INT = /OMB No\.?\s*1545-0112/i;
const OMB_1099_DIV = /OMB No\.?\s*1545-0110/i;
const OMB_1099_R = /OMB No\.?\s*1545-0119/i;
const OMB_1099_B = /OMB No\.?\s*1545-0715/i;
const OMB_1099_K = /OMB No\.?\s*1545-2205/i;
const OMB_4562 = /OMB No\.?\s*1545-0172/i;

const NON_FORM_PAGE_PATTERNS: RegExp[] = [
  /\bworksheet\b/i,
  /\bfiling instructions\b/i,
  /\bsupporting statements?\b/i,
  /\bsupporting information\b/i,
  /\bsupplemental information\b/i,
  /\bsupplemental statements?\b/i,
  /\bdiagnostic\b/i,
  /\bassistant\b/i,
  /\brecords only\b/i,
  /\bnot filed with the return\b/i,
  /\bnotification\b/i,
  /\backnowledgement\b/i,
  /\bpayment voucher\b/i,
  /\bestimated tax worksheet\b/i,
  /\bcarryover worksheet\b/i,
  /\bstate return\b/i,
  /\bFILEINST\.LD\b/i,
  /\bSTATMENT\.LD\b/i,
];

const FORM_RULES: FormRule[] = [
  {
    formType: "Form 1040-SR",
    required: [
      /\b1040[-\s]?SR\b/i,
      /U\.S\.\s+Tax Return for Seniors/i,
      OMB_1040,
    ],
  },
  {
    formType: "Form 1040-NR",
    required: [
      /\b1040[-\s]?NR\b/i,
      /U\.S\.\s+Nonresident Alien Income Tax Return/i,
      OMB_1040,
    ],
  },
  {
    formType: "Form 1040-X",
    required: [
      /\b1040[-\s]?X\b/i,
      /Amended U\.S\.\s+Individual Income Tax Return/i,
      OMB_1040,
    ],
  },
  {
    formType: "Form 1040",
    required: [
      /\b1040\b/i,
      /U\.S\.\s+Individual Income Tax Return/i,
      OMB_1040,
    ],
    continuation: [
      /Form\s*1040\s*\(\d{4}\)/i,
      /Tax\s+and/i,
      /\bCredits\b/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Tax\s+and/i, /\bCredits\b/i],
  },
  {
    formType: "Form 1120-S",
    required: [
      /\b1120[-\s]?S\b/i,
      /U\.S\.\s+Income Tax Return for an S Corporation/i,
      OMB_1120,
    ],
  },
  {
    formType: "Form 1120",
    required: [
      /\b1120\b/i,
      /U\.S\.\s+Corporation Income Tax Return/i,
      OMB_1120,
    ],
  },
  {
    formType: "Form 1065",
    required: [
      /\b1065\b/i,
      /U\.S\.\s+Return of Partnership Income/i,
      OMB_1065,
    ],
    continuation: [
      /Form\s*1065\s*\(\d{4}\)/i,
      /Other\s+Information/i,
    ],
    topOfPageHints: [/Other\s+Information/i],
  },
  {
    formType: "Form 990",
    required: [
      /\b990\b/i,
      /Return of Organization Exempt\s+From Income Tax/i,
      OMB_990,
    ],
  },
  {
    formType: "Form 941",
    required: [
      /\b941\b/i,
      /Employer['\u2019]?s\s+QUARTERLY Federal Tax Return/i,
      OMB_941,
    ],
  },
  {
    formType: "Form 8867",
    required: [
      /\b8867\s+Form\b|\bForm\s*8867\b/i,
      /Paid Preparer['\u2019]?s Due Diligence Checklist/i,
      OMB_1040,
    ],
    continuation: [
      /\bForm\s*8867\b/i,
      /Part II/i,
      /Due Diligence Questions/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Part II/i, /Due Diligence Questions/i],
  },
  {
    formType: "Schedule 1",
    required: [
      /Schedule\s+1\s*\(Form\s+1040\)|SCHEDULE\s+1/i,
      /Additional Income and Adjustments to Income/i,
      OMB_1040,
    ],
    continuation: [
      /Schedule\s+1\s*\(Form\s+1040\)\s*\d{4}/i,
      /Part II/i,
      /Adjustments to Income/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Part II/i, /Adjustments to Income/i],
  },
  {
    formType: "Schedule 2",
    required: [
      /Schedule\s+2\s*\(Form\s+1040\)|SCHEDULE\s+2/i,
      /Additional Taxes/i,
      OMB_1040,
    ],
    continuation: [
      /Schedule\s+2\s*\(Form\s+1040\)\s*\d{4}/i,
      /Part II/i,
      /Other Taxes/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Part II/i, /Other Taxes/i],
  },
  {
    formType: "Schedule 3",
    required: [
      /Schedule\s+3\s*\(Form\s+1040\)|SCHEDULE\s+3/i,
      /Additional Credits and Payments/i,
      OMB_1040,
    ],
    continuation: [
      /Schedule\s+3\s*\(Form\s+1040\)\s*\d{4}/i,
      /Part II/i,
      /Other Payments/i,
      /Refundable Credits/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Part II/i, /Other Payments/i, /Refundable Credits/i],
  },
  {
    formType: "Schedule K-1",
    required: [
      /Schedule\s+K-?1\s*\(Form\s+1065\)/i,
      /(?:Partner|Shareholder)['\u2019]?s Share/i,
      /Final K-?1|Amended K-?1/i,
      OMB_1065,
    ],
  },
  {
    formType: "Schedule A",
    required: [
      /Schedule\s+A\s*\(Form\s+1040\)/i,
      /Itemized Deductions/i,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule B",
    required: [
      /Schedule\s+B\s*\(Form\s+1040\)/i,
      /Interest and Ordinary Dividends/i,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule C",
    required: [
      /Schedule\s+C\s*\(Form\s+1040\)/i,
      /Profit or Loss From Business/i,
      OMB_1040,
    ],
    continuation: [
      /Schedule\s+C\s*\(Form\s+1040\)\s*\d{4}/i,
      /Cost of Goods Sold|Information on Your Vehicle/i,
    ],
    topOfPageHints: [/Cost of Goods Sold/i, /Information on Your Vehicle/i],
  },
  {
    formType: "Schedule D",
    required: [
      /Schedule\s+D\s*\(Form\s+1040\)|SCHEDULE\s+D/i,
      /Capital Gains and Losses/i,
      OMB_1040,
    ],
    continuation: [
      /Schedule\s+D\s*\(Form\s+1040\)\s*\d{4}/i,
      /Part III/i,
      /Summary/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Part III/i, /Summary/i],
  },
  {
    formType: "Schedule E",
    required: [
      /Schedule\s+E\s*\(Form\s+1040\)/i,
      /Supplemental Income and Loss/i,
      OMB_1040,
    ],
    continuation: [
      /Schedule\s+E\s*\(Form\s+1040\)\s*\d{4}/i,
      /Part II/i,
      /Income or Loss From Partnerships/i,
    ],
    minimumContinuationMatches: 2,
    topOfPageHints: [/Part II/i, /Income or Loss From Partnerships/i],
  },
  {
    formType: "Schedule F",
    required: [
      /Schedule\s+F\s*\(Form\s+1040\)/i,
      /Profit or Loss From Farming/i,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule SE",
    required: [
      /Schedule\s+SE\s*\(Form\s+1040\)/i,
      /Self-Employment Tax/i,
      OMB_1040,
    ],
  },
  {
    formType: "W-2",
    required: [/\bW-?2\b/i, /Wage and Tax Statement/i, OMB_W2],
  },
  {
    formType: "W-9",
    required: [
      /\bW-?9\b/i,
      /Request for Taxpayer Identification Number/i,
      OMB_W9,
    ],
  },
  {
    formType: "1099-MISC",
    required: [
      /\b1099[-\s]?MISC\b/i,
      /Miscellaneous (?:Information|Income)/i,
      OMB_1099_MISC,
    ],
  },
  {
    formType: "1099-NEC",
    required: [
      /\b1099[-\s]?NEC\b/i,
      /Nonemployee Compensation/i,
      OMB_1099_NEC,
    ],
  },
  {
    formType: "1099-INT",
    required: [/\b1099[-\s]?INT\b/i, /Interest Income/i, OMB_1099_INT],
  },
  {
    formType: "1099-DIV",
    required: [
      /\b1099[-\s]?DIV\b/i,
      /Dividends and Distributions/i,
      OMB_1099_DIV,
    ],
  },
  {
    formType: "1099-R",
    required: [
      /\b1099[-\s]?R\b|Gross distribution/i,
      /Distributions\s+From Pensions|Pensions,\s+Annuities/i,
      OMB_1099_R,
    ],
  },
  {
    formType: "1099-B",
    required: [
      /\b1099[-\s]?B\b/i,
      /Proceeds\s+From Broker/i,
      OMB_1099_B,
    ],
  },
  {
    formType: "1099-K",
    required: [
      /\b1099[-\s]?K\b/i,
      /Payment Card and Third Party Network/i,
      OMB_1099_K,
    ],
  },
  {
    formType: "Form 8829",
    required: [
      /\b8829\b/i,
      /Expenses for Business Use of Your Home/i,
      OMB_1040,
    ],
  },
  {
    formType: "Form 4562",
    required: [/\b4562\b/i, /Depreciation and Amortization/i, OMB_4562],
  },
  {
    formType: "Form 8949",
    required: [
      /\b8949\b/i,
      /Sales and Other Dispositions of Capital Assets/i,
      OMB_1040,
    ],
  },
  {
    formType: "Form 6251",
    required: [/\b6251\b/i, /Alternative Minimum Tax/i, OMB_1040],
  },
  {
    formType: "Form 2441",
    required: [
      /\b2441\b/i,
      /Child and Dependent Care Expenses/i,
      OMB_1040,
    ],
  },
  {
    formType: "Form 8812",
    required: [/\b8812\b/i, /Credits for Qualifying Children/i, OMB_1040],
  },
  {
    formType: "Form 8863",
    required: [/\b8863\b/i, /Education Credits/i, OMB_1040],
  },
];

const FORM_RULE_MAP = new Map(FORM_RULES.map((rule) => [rule.formType, rule]));

function normalizeDetectionText(pageText: string): string {
  return pageText
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFormHeaderLabel(formType: string): string {
  return formType.toLowerCase().replace(/\s+/g, " ").trim();
}

function isGenericHeaderContinuation(
  normalizedText: string,
  rule: FormRule
): boolean {
  const topWindow = normalizedText.slice(0, 420);
  const label = normalizeFormHeaderLabel(rule.formType);
  const headerIndex = topWindow.toLowerCase().indexOf(label);

  if (headerIndex === -1 || headerIndex > 80) {
    return false;
  }

  if (!/page\s*\d+/i.test(topWindow)) {
    return false;
  }

  if (rule.topOfPageHints?.some((pattern) => pattern.test(topWindow))) {
    return true;
  }

  return /part\s+[ivx]+|continued/i.test(topWindow);
}

function startsWithResolvedFormHeader(
  pageText: string,
  formType: string
): boolean {
  const topWindow = normalizeDetectionText(pageText).slice(0, 260).toLowerCase();
  const label = normalizeFormHeaderLabel(formType);
  const headerIndex = topWindow.indexOf(label);

  return headerIndex !== -1 && headerIndex <= 40 && /page\s*\d+/i.test(topWindow);
}

function hasNegativeSupportEvidence(normalizedText: string): boolean {
  const supportWindow = normalizedText.slice(0, 420);
  return NON_FORM_PAGE_PATTERNS.some((pattern) => pattern.test(supportWindow));
}

function isLikelyContinuationPage(
  pageText: string,
  formType: string
): boolean {
  const normalizedText = normalizeDetectionText(pageText);

  if (hasNegativeSupportEvidence(normalizedText)) {
    return false;
  }

  const rule = FORM_RULE_MAP.get(formType);
  if (!rule?.continuation?.length) {
    return false;
  }

  const matches = rule.continuation.filter((pattern) =>
    pattern.test(normalizedText)
  ).length;
  const minimumMatches =
    rule.minimumContinuationMatches ?? rule.continuation.length;

  return matches >= minimumMatches || isGenericHeaderContinuation(normalizedText, rule);
}

function isResetBoundaryPage(pageText: string, activeFormType: string): boolean {
  const normalizedText = normalizeDetectionText(pageText);
  const explicitFormType = detectFormType(pageText);

  if (hasNegativeSupportEvidence(normalizedText)) {
    return true;
  }

  if (explicitFormType && explicitFormType !== activeFormType) {
    return true;
  }

  return (
    !startsWithResolvedFormHeader(pageText, activeFormType) &&
    !isLikelyContinuationPage(pageText, activeFormType)
  );
}

/**
 * Detect explicit IRS form types from page text.
 *
 * The detector is intentionally conservative: it only returns a match when the
 * page carries the real form header/title combination, not a body reference or
 * a continuation-page header that needs propagation.
 */
export function detectFormType(pageText: string): string | null {
  const normalizedText = normalizeDetectionText(pageText);

  for (const rule of FORM_RULES) {
    if (rule.required.every((re) => re.test(normalizedText))) {
      return rule.formType;
    }
  }

  return null;
}

/**
 * Resolve explicit-vs-propagated form ownership across a document.
 */
export function resolvePageFormTypes(pages: PageText[]): ResolvedPageForm[] {
  const resolved: ResolvedPageForm[] = [];
  let activeForm: { formType: string; originPage: number } | null = null;

  for (const page of pages) {
    const explicitFormType = detectFormType(page.text);

    if (explicitFormType) {
      activeForm = {
        formType: explicitFormType,
        originPage: page.pageNumber,
      };

      resolved.push({
        pageNumber: page.pageNumber,
        explicitFormType,
        resolvedFormType: explicitFormType,
        formTypeSource: "explicit",
        formTypeOriginPage: page.pageNumber,
      });
      continue;
    }

    if (
      activeForm &&
      !isResetBoundaryPage(page.text, activeForm.formType) &&
      (startsWithResolvedFormHeader(page.text, activeForm.formType) ||
        isLikelyContinuationPage(page.text, activeForm.formType))
    ) {
      resolved.push({
        pageNumber: page.pageNumber,
        explicitFormType: null,
        resolvedFormType: activeForm.formType,
        formTypeSource: "propagated",
        formTypeOriginPage: activeForm.originPage,
      });
      continue;
    }

    activeForm = null;
    resolved.push({
      pageNumber: page.pageNumber,
      explicitFormType: null,
      resolvedFormType: null,
      formTypeSource: null,
      formTypeOriginPage: null,
    });
  }

  return resolved;
}
