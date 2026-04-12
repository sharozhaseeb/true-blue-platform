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
 * Detect IRS form types from page text.
 * Returns the detected form type or null if none found.
 */
export function detectFormType(pageText: string): string | null {
  // Order matters: check more specific patterns first
  const formPatterns: [RegExp, string][] = [
    // Schedules (check before generic "Form 1040")
    [/Schedule\s+A\b/i, "Schedule A"],
    [/Schedule\s+B\b/i, "Schedule B"],
    [/Schedule\s+C\b/i, "Schedule C"],
    [/Schedule\s+D\b/i, "Schedule D"],
    [/Schedule\s+E\b/i, "Schedule E"],
    [/Schedule\s+F\b/i, "Schedule F"],
    [/Schedule\s+K-?1\b/i, "Schedule K-1"],
    [/Schedule\s+SE\b/i, "Schedule SE"],

    // Specific 1040 variants
    [/Form\s+1040[-\s]?SR\b/i, "Form 1040-SR"],
    [/Form\s+1040[-\s]?NR\b/i, "Form 1040-NR"],
    [/Form\s+1040[-\s]?X\b/i, "Form 1040-X"],

    // Main forms
    [/Form\s+1040\b/i, "Form 1040"],
    [/Form\s+1120[-\s]?S\b/i, "Form 1120-S"],
    [/Form\s+1120\b/i, "Form 1120"],
    [/Form\s+1065\b/i, "Form 1065"],
    [/Form\s+990\b/i, "Form 990"],
    [/Form\s+941\b/i, "Form 941"],

    // Information returns
    [/Form\s+W-?2\b/i, "W-2"],
    [/Form\s+W-?9\b/i, "W-9"],
    [/\bW-?2\b(?:\s+Wage)/i, "W-2"],
    [/Form\s+1099[-\s]?MISC\b/i, "1099-MISC"],
    [/Form\s+1099[-\s]?NEC\b/i, "1099-NEC"],
    [/Form\s+1099[-\s]?INT\b/i, "1099-INT"],
    [/Form\s+1099[-\s]?DIV\b/i, "1099-DIV"],
    [/Form\s+1099[-\s]?R\b/i, "1099-R"],
    [/Form\s+1099[-\s]?B\b/i, "1099-B"],
    [/Form\s+1099[-\s]?K\b/i, "1099-K"],
    [/Form\s+1099\b/i, "1099"],

    // K-1 variants
    [/Schedule\s+K-?1\s*\(Form\s+1065\)/i, "Schedule K-1 (Form 1065)"],
    [/Schedule\s+K-?1\s*\(Form\s+1120[-\s]?S\)/i, "Schedule K-1 (Form 1120-S)"],

    // Other common forms
    [/Form\s+8829\b/i, "Form 8829"],
    [/Form\s+4562\b/i, "Form 4562"],
    [/Form\s+8949\b/i, "Form 8949"],
    [/Form\s+6251\b/i, "Form 6251"],
    [/Form\s+2441\b/i, "Form 2441"],
    [/Form\s+8812\b/i, "Form 8812"],
    [/Form\s+8863\b/i, "Form 8863"],
  ];

  for (const [pattern, formType] of formPatterns) {
    if (pattern.test(pageText)) {
      return formType;
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
