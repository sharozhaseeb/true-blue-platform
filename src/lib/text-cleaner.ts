import type { PageText } from "@/lib/pdf-processor";
import type {
  StructuredPage,
  StructuredTextBlock,
  StructuredTextLine,
  StructuredTextSpan,
} from "@/lib/document-structure";

function normalizeVisibleText(raw: string): string {
  let text = raw;

  text = text.replace(/[\u2018\u2019\u201A]/g, "'");
  text = text.replace(/[\u201C\u201D\u201E]/g, '"');
  text = text.replace(/[\u2013\u2014]/g, "-");
  text = text.replace(/\u00A0/g, " ");
  text = text.replace(/[\u2009\u200A\u200B\uFEFF]/g, " ");
  text = text.replace(/\u2026/g, "...");
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Preserve line structure from layout-aware extraction while normalizing noisy spacing.
  text = text.replace(/[ \t]{3,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Clean and normalize extracted page text.
 *
 * - Normalize Unicode (curly quotes, em-dashes, NBSP)
 * - Collapse excessive whitespace
 * - Remove control characters
 * - Preserve visible footer-style text unless it is clearly non-selectable noise
 * - PRESERVE: page starts, line breaks, form titles, taxpayer identifiers
 */
export function cleanPageText(raw: string): string {
  return normalizeVisibleText(raw);
}

export function normalizeStructuredSpanText(span: Pick<StructuredTextSpan, "text">): string {
  return normalizeVisibleText(span.text);
}

export function normalizeStructuredLineText(
  line: Pick<StructuredTextLine, "text" | "spans">
): string {
  const renderedText =
    line.text && line.text.trim().length > 0
      ? line.text
      : line.spans.map((span) => normalizeStructuredSpanText(span)).join(" ");

  return normalizeVisibleText(renderedText);
}

export function normalizeStructuredBlockText(
  block: Pick<StructuredTextBlock, "text" | "lines">
): string {
  if (block.lines.length === 0) {
    return normalizeVisibleText(block.text);
  }

  return block.lines
    .map((line) => normalizeStructuredLineText(line))
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeStructuredPageText(
  page: Pick<StructuredPage, "text" | "blocks">
): string {
  if (page.blocks.length === 0) {
    return normalizeVisibleText(page.text);
  }

  return page.blocks
    .map((block) => normalizeStructuredBlockText(block))
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeStructuredPages(
  pages: StructuredPage[]
): PageText[] {
  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: normalizeStructuredPageText(page),
  }));
}

/**
 * Header stripping is intentionally disabled for this remediation.
 *
 * The post-fix priority is preserving top-of-page text and form-identifying
 * lines. Until a safer heuristic is proven, preserving text is preferable to
 * aggressive cleanup that can reintroduce missing-text regressions.
 */
export function removeRepeatedHeaders(pages: PageText[]): PageText[] {
  return pages;
}
