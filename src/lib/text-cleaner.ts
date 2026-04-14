import { PageText } from "@/lib/pdf-processor";

/**
 * Clean and normalize extracted page text.
 *
 * - Normalize Unicode (curly quotes, em-dashes, NBSP)
 * - Collapse excessive whitespace
 * - Remove control characters
 * - Remove header/footer artifacts
 * - PRESERVE: dollar signs, percentages, commas in numbers, dates, form line numbers
 */
export function cleanPageText(raw: string): string {
  let text = raw;

  // Normalize Unicode characters
  // Curly quotes → straight quotes
  text = text.replace(/[\u2018\u2019\u201A]/g, "'");
  text = text.replace(/[\u201C\u201D\u201E]/g, '"');

  // Em-dash / en-dash → hyphen
  text = text.replace(/[\u2013\u2014]/g, "-");

  // Non-breaking space → regular space
  text = text.replace(/\u00A0/g, " ");

  // Other special spaces (thin, hair, zero-width)
  text = text.replace(/[\u2009\u200A\u200B\uFEFF]/g, " ");

  // Ellipsis character → three dots
  text = text.replace(/\u2026/g, "...");

  // Remove control characters (null, form feed, vertical tab, etc.)
  // Preserve newlines (\n), carriage returns (\r), and tabs (\t)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Collapse excessive spaces (3+ spaces → single space) on the same line
  text = text.replace(/ {3,}/g, " ");

  // Collapse excessive blank lines (3+ newlines → 2 newlines)
  text = text.replace(/\n{3,}/g, "\n\n");

  // Remove header/footer artifacts
  text = text.replace(/Page\s+\d+\s+of\s+\d+/gi, "");
  text = text.replace(/\bDO NOT FILE\b/gi, "");
  text = text.replace(/\bDRAFT\b/gi, "");

  // Trim leading/trailing whitespace
  text = text.trim();

  return text;
}

/**
 * A form is detected only when EVERY pattern in `required` matches the page.
 *
 * Each rule combines three kinds of evidence, all of which must be present:
 *
 * 1. A form-header signature (e.g. `Schedule B (Form 1040)` or the exact
 *    title line) — this is a layout artifact that only appears on the real
 *    form page. Body prose on a neighbouring page will say "from Schedule B"
 *    or "(Amended U.S. Individual Income Tax Return)" but never the bracketed
 *    header notation.
 * 2. The official title in case-sensitive Title Case. Real forms render the
 *    title as a heading; body references embed it in lowercase sentences
 *    (e.g. "credit for child and dependent care expenses from Form 2441").
 * 3. The form-specific OMB control number. Real IRS form pages carry the
 *    "OMB No. 1545-xxxx" marker; worksheets, filing instructions, state
 *    forms and the IRS e-file acknowledgement (Form 9325) do not.
 *
 * This combination is what keeps pages with cross-references — Form 1040
 * page 2 talking about Schedule A, Schedule 3 referencing Form 2441,
 * Schedule 2 referencing Schedule SE — from being falsely tagged.
 */
type FormRule = {
  formType: string;
  required: RegExp[];
};

// Shared OMB markers. Every rule needs at least one so that body references
// on non-form pages (worksheets, filing instructions, diagnostics) cannot
// satisfy the rule.
const OMB_1040 = /OMB No\.?\s*1545-0074/;
const OMB_1065 = /OMB No\.?\s*1545-0123/;
const OMB_1120 = /OMB No\.?\s*1545-0123/;
const OMB_990 = /OMB No\.?\s*1545-0047/;
const OMB_941 = /OMB No\.?\s*1545-0029/;
const OMB_W2 = /OMB No\.?\s*1545-0008/;
const OMB_W9 = /OMB No\.?\s*1545-1621/;
const OMB_1099_MISC = /OMB No\.?\s*1545-0115/;
const OMB_1099_NEC = /OMB No\.?\s*1545-0116/;
const OMB_1099_INT = /OMB No\.?\s*1545-0112/;
const OMB_1099_DIV = /OMB No\.?\s*1545-0110/;
const OMB_1099_R = /OMB No\.?\s*1545-0119/;
const OMB_1099_B = /OMB No\.?\s*1545-0715/;
const OMB_1099_K = /OMB No\.?\s*1545-2205/;
const OMB_4562 = /OMB No\.?\s*1545-0172/;

const FORM_RULES: FormRule[] = [
  // Specific 1040 variants — checked before the generic 1040 rule.
  // Titles are case-sensitive so "Amended U.S. Individual Income Tax Return"
  // inside lowercase body text no longer trips the detector on 9325 pages.
  {
    formType: "Form 1040-SR",
    required: [
      /\b1040[-\s]?SR\b/i,
      /U\.S\. Tax Return for Seniors/,
      OMB_1040,
    ],
  },
  {
    formType: "Form 1040-NR",
    required: [
      /\b1040[-\s]?NR\b/i,
      /U\.S\. Nonresident Alien Income Tax Return/,
      OMB_1040,
    ],
  },
  {
    formType: "Form 1040-X",
    required: [
      /\b1040[-\s]?X\b/i,
      /Amended U\.S\. Individual Income Tax Return/,
      OMB_1040,
    ],
  },

  // Main return forms
  {
    formType: "Form 1040",
    required: [
      /\b1040\b/,
      /U\.S\. Individual Income Tax Return/,
      OMB_1040,
    ],
  },
  {
    formType: "Form 1120-S",
    required: [
      /\b1120[-\s]?S\b/i,
      /U\.S\. Income Tax Return for an S Corporation/,
      OMB_1120,
    ],
  },
  {
    formType: "Form 1120",
    required: [
      /\b1120\b/,
      /U\.S\. Corporation Income Tax Return/,
      OMB_1120,
    ],
  },
  {
    formType: "Form 1065",
    required: [
      /\b1065\b/,
      /U\.S\. Return of Partnership Income/,
      OMB_1065,
    ],
  },
  {
    formType: "Form 990",
    required: [
      /\b990\b/,
      /Return of Organization Exempt [Ff]rom Income Tax/,
      OMB_990,
    ],
  },
  {
    formType: "Form 941",
    required: [
      /\b941\b/,
      /Employer['\u2019]?s QUARTERLY Federal Tax Return/,
      OMB_941,
    ],
  },

  // Schedules attached to Form 1040 — all share OMB 1545-0074 with the
  // parent return, so the form-header signature `Schedule X (Form 1040)`
  // is what discriminates the real page from a body reference.
  //
  // K-1 keeps a structural cue ("Final K-1" or "Amended K-1") so that the
  // Schedule K-3 notification page — which mentions Schedule K-1 once in
  // passing — does not false-positive.
  {
    formType: "Schedule K-1",
    required: [
      /Schedule\s+K-?1\s*\(Form\s+1065\)/i,
      /(?:Partner|Shareholder)['\u2019]?s Share/,
      /Final K-?1|Amended K-?1/,
      OMB_1065,
    ],
  },
  {
    formType: "Schedule A",
    required: [
      /Schedule\s+A\s*\(Form\s+1040\)/i,
      /Itemized Deductions/,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule B",
    required: [
      /Schedule\s+B\s*\(Form\s+1040\)/i,
      /Interest and Ordinary Dividends/,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule C",
    required: [
      /Schedule\s+C\s*\(Form\s+1040\)/i,
      /Profit or Loss From Business/,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule D",
    required: [
      /Schedule\s+D\s*\(Form\s+1040\)/i,
      /Capital Gains and Losses/,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule E",
    required: [
      /Schedule\s+E\s*\(Form\s+1040\)/i,
      /Supplemental Income and Loss/,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule F",
    required: [
      /Schedule\s+F\s*\(Form\s+1040\)/i,
      /Profit or Loss From Farming/,
      OMB_1040,
    ],
  },
  {
    formType: "Schedule SE",
    required: [
      /Schedule\s+SE\s*\(Form\s+1040\)/i,
      /Self-Employment Tax/,
      OMB_1040,
    ],
  },

  // Wage and information returns
  {
    formType: "W-2",
    required: [/\bW-?2\b/, /Wage and Tax Statement/, OMB_W2],
  },
  {
    formType: "W-9",
    required: [
      /\bW-?9\b/,
      /Request for Taxpayer Identification Number/,
      OMB_W9,
    ],
  },
  {
    formType: "1099-MISC",
    required: [
      /\b1099[-\s]?MISC\b/i,
      /Miscellaneous (?:Information|Income)/,
      OMB_1099_MISC,
    ],
  },
  {
    formType: "1099-NEC",
    required: [
      /\b1099[-\s]?NEC\b/i,
      /Nonemployee Compensation/,
      OMB_1099_NEC,
    ],
  },
  {
    formType: "1099-INT",
    required: [/\b1099[-\s]?INT\b/i, /Interest Income/, OMB_1099_INT],
  },
  {
    formType: "1099-DIV",
    required: [
      /\b1099[-\s]?DIV\b/i,
      /Dividends and Distributions/,
      OMB_1099_DIV,
    ],
  },
  {
    formType: "1099-R",
    required: [
      /\b1099[-\s]?R\b/i,
      /Distributions [Ff]rom Pensions/,
      OMB_1099_R,
    ],
  },
  {
    formType: "1099-B",
    required: [
      /\b1099[-\s]?B\b/i,
      /Proceeds [Ff]rom Broker/,
      OMB_1099_B,
    ],
  },
  {
    formType: "1099-K",
    required: [
      /\b1099[-\s]?K\b/i,
      /Payment Card and Third Party Network/,
      OMB_1099_K,
    ],
  },

  // Other common forms attached to Form 1040. These all share 1545-0074,
  // so the form-number marker has to appear adjacent to the title — a
  // body reference like "from Form 2441" is filtered because the page
  // will not also contain the official Title-Case title.
  {
    formType: "Form 8829",
    required: [
      /\b8829\b/,
      /Expenses for Business Use of Your Home/,
      OMB_1040,
    ],
  },
  {
    formType: "Form 4562",
    required: [/\b4562\b/, /Depreciation and Amortization/, OMB_4562],
  },
  {
    formType: "Form 8949",
    required: [
      /\b8949\b/,
      /Sales and Other Dispositions of Capital Assets/,
      OMB_1040,
    ],
  },
  {
    formType: "Form 6251",
    required: [/\b6251\b/, /Alternative Minimum Tax/, OMB_1040],
  },
  {
    formType: "Form 2441",
    required: [
      /\b2441\b/,
      /Child and Dependent Care Expenses/,
      OMB_1040,
    ],
  },
  {
    formType: "Form 8812",
    required: [/\b8812\b/, /Credits for Qualifying Children/, OMB_1040],
  },
  {
    formType: "Form 8863",
    required: [/\b8863\b/, /Education Credits/, OMB_1040],
  },
];

/**
 * Detect IRS form types from page text.
 *
 * Returns the first form whose required patterns all match. Body-text
 * mentions of a form on a different form's page do not match because the
 * official IRS title is required alongside the form number.
 */
export function detectFormType(pageText: string): string | null {
  for (const rule of FORM_RULES) {
    if (rule.required.every((re) => re.test(pageText))) {
      return rule.formType;
    }
  }

  return null;
}

/**
 * Remove repeated headers from pages.
 *
 * Identifies text appearing identically at the top of every page (common in
 * tax software output: firm name, preparer info, date headers).
 * Removes from all except the first page.
 */
export function removeRepeatedHeaders(pages: PageText[]): PageText[] {
  if (pages.length < 3) return pages;

  // Extract first N characters from each page as potential header
  const HEADER_CHECK_LENGTH = 150;
  const headerCandidates: string[] = pages.map((p) =>
    p.text.substring(0, HEADER_CHECK_LENGTH).trim()
  );

  // Find common prefix across all pages
  let commonHeader = "";
  if (headerCandidates.length > 0) {
    const first = headerCandidates[0];

    // Check each line of the first page's header area
    const firstLines = first.split("\n");
    let matchingLines: string[] = [];

    for (const line of firstLines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Check if this line appears at the top of every other page
      const appearsInAll = headerCandidates.slice(1).every((header) =>
        header.includes(trimmedLine)
      );

      if (appearsInAll) {
        matchingLines.push(trimmedLine);
      } else {
        break; // Stop at first non-matching line
      }
    }

    if (matchingLines.length > 0) {
      commonHeader = matchingLines.join("\n");
    }
  }

  if (!commonHeader) return pages;

  // Remove the common header from all pages except the first
  return pages.map((page, index) => {
    if (index === 0) return page;

    let text = page.text;
    // Remove each matching header line from the beginning of the page
    const headerLines = commonHeader.split("\n");
    for (const headerLine of headerLines) {
      const escaped = headerLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`^\\s*${escaped}\\s*\n?`), "");
    }

    return { ...page, text: text.trim() };
  });
}
