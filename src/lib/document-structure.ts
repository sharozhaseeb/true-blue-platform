export interface StructuredTextSpan {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface StructuredTextLine {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  spans: StructuredTextSpan[];
}

export interface StructuredTextBlock {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  lines: StructuredTextLine[];
}

export interface StructuredPage {
  pageNumber: number;
  text: string;
  spans: StructuredTextSpan[];
  lines: StructuredTextLine[];
  blocks: StructuredTextBlock[];
}

export interface StructuredPageExtractionResult {
  pages: StructuredPage[];
  pageCount: number;
}

type TextContentItemLike = {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

type TextContentLike = {
  items?: TextContentItemLike[];
};

interface PositionedSpan {
  index: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  avgCharWidth: number;
}

interface LineAccumulator {
  centerY: number;
  top: number;
  bottom: number;
  minX: number;
  maxRight: number;
  height: number;
  count: number;
  spans: PositionedSpan[];
}

interface BlockAccumulator {
  centerY: number;
  top: number;
  bottom: number;
  minX: number;
  maxRight: number;
  height: number;
  count: number;
  lines: StructuredTextLine[];
}

function normalizeItemText(value: unknown): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getItemX(item: TextContentItemLike): number {
  return Array.isArray(item.transform) ? Number(item.transform[4] || 0) : 0;
}

function getItemY(item: TextContentItemLike): number {
  return Array.isArray(item.transform) ? Number(item.transform[5] || 0) : 0;
}

function getItemWidth(item: TextContentItemLike): number {
  return Math.max(Number(item.width || 0), 0);
}

function getItemHeight(item: TextContentItemLike): number {
  const fromHeight = Number(item.height || 0);
  const fromTransform = Array.isArray(item.transform)
    ? Math.max(
        Math.abs(Number(item.transform[3] || 0)),
        Math.abs(Number(item.transform[0] || 0))
      )
    : 0;

  return Math.max(fromHeight, fromTransform, 0);
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function toStructuredSpan(span: PositionedSpan): StructuredTextSpan {
  return {
    index: span.index,
    text: span.text,
    x: span.x,
    y: span.y,
    width: span.width,
    height: span.height,
    right: span.right,
    bottom: span.bottom,
  };
}

function createPositionedSpans(textContent: TextContentLike): PositionedSpan[] {
  return (textContent.items || [])
    .map((item, index) => {
      const text = normalizeItemText(item.str);
      if (!text) {
        return null;
      }

      const x = getItemX(item);
      const y = getItemY(item);
      const width = getItemWidth(item);
      const height = getItemHeight(item) || 8;
      const right = x + width;
      const bottom = y - height;

      return {
        index,
        text,
        x,
        y,
        width,
        height,
        right,
        bottom,
        avgCharWidth: text.length ? width / text.length : 0,
      };
    })
    .filter((item): item is PositionedSpan => Boolean(item));
}

function lineTolerance(line: LineAccumulator, item: PositionedSpan): number {
  return Math.max(2, Math.min(6, Math.max(line.height, item.height, 8) * 0.45));
}

function groupSpansIntoLines(spans: PositionedSpan[]): LineAccumulator[] {
  const lines: LineAccumulator[] = [];
  const sortedSpans = [...spans].sort((left, right) => {
    if (Math.abs(right.y - left.y) > 0.5) {
      return right.y - left.y;
    }

    if (Math.abs(left.x - right.x) > 0.5) {
      return left.x - right.x;
    }

    return left.index - right.index;
  });

  for (const span of sortedSpans) {
    let matchedLine: LineAccumulator | null = null;

    for (const line of lines) {
      if (Math.abs(line.centerY - span.y) <= lineTolerance(line, span)) {
        matchedLine = line;
        break;
      }
    }

    if (matchedLine) {
      matchedLine.spans.push(span);
      matchedLine.minX = Math.min(matchedLine.minX, span.x);
      matchedLine.maxRight = Math.max(matchedLine.maxRight, span.right);
      matchedLine.height = Math.max(matchedLine.height, span.height);
      matchedLine.top = Math.max(matchedLine.top, span.y);
      matchedLine.bottom = Math.min(matchedLine.bottom, span.bottom);
      matchedLine.centerY =
        (matchedLine.centerY * matchedLine.count + span.y) /
        (matchedLine.count + 1);
      matchedLine.count += 1;
      continue;
    }

    lines.push({
      centerY: span.y,
      top: span.y,
      bottom: span.bottom,
      minX: span.x,
      maxRight: span.right,
      height: span.height,
      count: 1,
      spans: [span],
    });
  }

  return lines.sort((left, right) => {
    if (Math.abs(right.centerY - left.centerY) > 0.5) {
      return right.centerY - left.centerY;
    }

    return left.minX - right.minX;
  });
}

function isAlphaNumeric(value: string): boolean {
  return /^[A-Za-z0-9]$/.test(value);
}

function isOpeningGlue(value: string): boolean {
  return /[\/(\-]$/.test(value);
}

function isClosingGlue(value: string): boolean {
  return /^[,.;:)%\]]/.test(value);
}

function isSemanticLabelBoundary(
  previousText: string,
  currentText: string
): boolean {
  return (
    /^(form|schedule|page|attachment)$/i.test(previousText) &&
    /^\d/.test(currentText)
  );
}

function isShortCitationParenthetical(value: string): boolean {
  return /^\([A-Za-z0-9]{1,3}\)(?![A-Za-z])/.test(value.trim());
}

function shouldInsertSpaceBeforeOpeningParenthesis(
  previousText: string,
  currentText: string
): boolean {
  const trimmedCurrent = currentText.trim();
  if (!trimmedCurrent.startsWith("(") || !/[A-Za-z0-9]$/.test(previousText)) {
    return false;
  }

  // Preserve compact legal/form references like 734(b) and 4(b), but insert
  // spaces for parenthetical phrases such as EIC (If...) or Information
  // (continued).
  if (/\d$/.test(previousText) && isShortCitationParenthetical(trimmedCurrent)) {
    return false;
  }

  return true;
}

function shouldInsertSpaceAfterStandaloneCurrency(
  previousText: string,
  currentText: string
): boolean {
  if (previousText.trim() !== "$") {
    return false;
  }

  const firstChar = currentText.trim().charAt(0);
  return Boolean(firstChar) && !/\d/.test(firstChar);
}

function shouldInsertSemanticSpace(
  previous: StructuredTextSpan,
  current: StructuredTextSpan,
  gap: number,
  baseWidth: number
): boolean {
  const previousText = previous.text.trim();
  const currentText = current.text.trim();
  if (!previousText || !currentText) {
    return false;
  }

  const lastChar = previousText.slice(-1);
  const firstChar = currentText.charAt(0);

  if (shouldInsertSpaceBeforeOpeningParenthesis(previousText, currentText)) {
    return true;
  }

  if (shouldInsertSpaceAfterStandaloneCurrency(previousText, currentText)) {
    return true;
  }

  if (isOpeningGlue(lastChar) || isClosingGlue(firstChar)) {
    return false;
  }

  if (/[,;:]/.test(lastChar) && isAlphaNumeric(firstChar)) {
    return true;
  }

  if (isSemanticLabelBoundary(previousText, currentText)) {
    return true;
  }

  if (!isAlphaNumeric(lastChar) || !isAlphaNumeric(firstChar)) {
    return false;
  }

  // PDF text items often represent separate visible words/labels with zero
  // geometry gap. Insert a semantic boundary unless spans overlap so heavily
  // that they are probably alternate renderings of the same glyph run.
  const toleratedOverlap = -Math.max(0.75, baseWidth * 0.35);
  return gap >= toleratedOverlap;
}

function applyRenderedSentenceBoundaryFixes(value: string): string {
  return value
    .replace(/([A-Za-z0-9][?.:])(?=[A-Z][a-z])/g, "$1 ")
    .replace(/\b(No\.)(?=\d{1,3}\b)/g, "$1 ");
}

function applyRenderedFieldValueBoundaryFixes(value: string): string {
  return value.replace(
    /\b([A-Za-z]*[a-z][A-Za-z]{2,})(\d{1,2}[A-Za-z]?\b)/g,
    (_match, left: string, right: string) => `${left} ${right}`
  );
}

function normalizeRenderedLineText(value: string): string {
  return applyRenderedFieldValueBoundaryFixes(
    applyRenderedSentenceBoundaryFixes(value)
  )
    .replace(/ {3,}/g, "  ")
    .trim();
}

function renderStructuredTextLine(line: { spans: StructuredTextSpan[] }): string {
  let text = "";
  let previous: StructuredTextSpan | null = null;

  for (const span of [...line.spans].sort((left, right) => {
    if (Math.abs(left.x - right.x) > 0.5) {
      return left.x - right.x;
    }

    return left.index - right.index;
  })) {
    if (!previous) {
      text = span.text;
      previous = span;
      continue;
    }

    const gap = span.x - previous.right;
    const baseWidth = Math.max(
      previous.text.length ? previous.width / previous.text.length : 0,
      span.text.length ? span.width / span.text.length : 0,
      1.5
    );
    const smallGap = Math.max(1, Math.min(5, baseWidth * 0.6));
    const largeGap = Math.max(6, baseWidth * 3);
    const lastChar = text.slice(-1);
    const firstChar = span.text.charAt(0);
    const suppressInsertedSpace =
      isOpeningGlue(lastChar) || isClosingGlue(firstChar);
    const forceSemanticSpace = shouldInsertSemanticSpace(
      previous,
      span,
      gap,
      baseWidth
    );

    if ((forceSemanticSpace || gap > smallGap) && !suppressInsertedSpace) {
      text += !forceSemanticSpace && gap > largeGap ? "  " : " ";
    }

    text += span.text;
    previous = span;
  }

  return normalizeRenderedLineText(text);
}

function buildStructuredLines(spans: PositionedSpan[]): StructuredTextLine[] {
  return groupSpansIntoLines(spans).map((line, index) => {
    const structuredSpans = line.spans.map(toStructuredSpan);
    const text = renderStructuredTextLine({ spans: structuredSpans });

    return {
      index,
      x: line.minX,
      y: line.top,
      width: Math.max(line.maxRight - line.minX, 0),
      height: Math.max(line.top - line.bottom, line.height, 0),
      right: line.maxRight,
      bottom: line.bottom,
      spans: structuredSpans,
      text,
    };
  });
}

function buildStructuredBlocks(lines: StructuredTextLine[]): StructuredTextBlock[] {
  if (lines.length === 0) {
    return [];
  }

  const verticalGaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const gap = lines[index - 1].y - lines[index].y;
    if (gap > 0.5) {
      verticalGaps.push(gap);
    }
  }

  const medianGap = median(verticalGaps) || 12;
  const blocks: BlockAccumulator[] = [];

  for (const line of lines) {
    const previousBlock = blocks[blocks.length - 1];
    const previousLine = previousBlock?.lines[previousBlock.lines.length - 1] || null;
    const verticalGap = previousLine ? previousLine.y - line.y : 0;

    if (!previousBlock || verticalGap > medianGap * 1.8) {
      blocks.push({
        centerY: line.y,
        top: line.y,
        bottom: line.bottom,
        minX: line.x,
        maxRight: line.right,
        height: line.height,
        count: 1,
        lines: [line],
      });
      continue;
    }

    previousBlock.lines.push(line);
    previousBlock.minX = Math.min(previousBlock.minX, line.x);
    previousBlock.maxRight = Math.max(previousBlock.maxRight, line.right);
    previousBlock.height = Math.max(previousBlock.height, line.height);
    previousBlock.top = Math.max(previousBlock.top, line.y);
    previousBlock.bottom = Math.min(previousBlock.bottom, line.bottom);
    previousBlock.centerY =
      (previousBlock.centerY * previousBlock.count + line.y) /
      (previousBlock.count + 1);
    previousBlock.count += 1;
  }

  return blocks.map((block, index) => {
    const text = block.lines.map((line) => line.text).join("\n").trim();

    return {
      index,
      x: block.minX,
      y: block.top,
      width: Math.max(block.maxRight - block.minX, 0),
      height: Math.max(block.top - block.bottom, block.height, 0),
      right: block.maxRight,
      bottom: block.bottom,
      lines: block.lines,
      text,
    };
  });
}

export function renderStructuredTextBlock(block: StructuredTextBlock): string {
  return block.lines.map((line) => line.text).join("\n").trim();
}

export function renderStructuredPageText(
  page: Pick<StructuredPage, "blocks">
): string {
  return page.blocks
    .map((block) => (block.text || renderStructuredTextBlock(block)).trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildStructuredPageFromTextContent(
  textContent: TextContentLike,
  pageNumber: number
): StructuredPage {
  const spans = createPositionedSpans(textContent);
  const lines = buildStructuredLines(spans);
  const blocks = buildStructuredBlocks(lines);

  return {
    pageNumber,
    spans: spans.map(toStructuredSpan),
    lines,
    blocks,
    text: renderStructuredPageText({ blocks }),
  };
}
