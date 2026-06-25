#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const fixtureConfig = require("./fixtures/m2-pdf-quality-fixtures.js");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(
  request,
  parent,
  isMain,
  options
) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const tsNode = require(path.join(repoRoot, "node_modules", "ts-node"));
tsNode.register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

const {
  extractStructuredPages,
} = require(path.join(repoRoot, "src/lib/pdf-processor.ts"));
const {
  cleanPageText,
  removeRepeatedHeaders,
} = require(path.join(repoRoot, "src/lib/text-cleaner.ts"));
const { detectFormType } = require(path.join(
  repoRoot,
  "src/lib/form-resolution.ts"
));
const {
  chunkDocument,
  estimateTokens,
  MAX_TOKENS_PER_CHUNK,
  OVERLAP_TOKENS,
} = require(path.join(repoRoot, "src/lib/chunker.ts"));
const DEFAULT_START_WINDOW = 320;
const TOKEN_CHAR = /[A-Za-z0-9$,%.-]/;
const WHITESPACE_RE = /\s/;
const FAILURE_CLASSES = {
  DOCUMENT_COVERAGE: "document coverage",
  MISSING_SPAN: "missing-span fidelity",
  PAGE_START: "page-start fidelity",
  RENDERED_SPACING: "rendered spacing fidelity",
  ORDERED_ANCHOR: "ordered-anchor fidelity",
  TABLE_COLUMN: "table/column-sensitive anchor order",
  CHUNK_COHERENCE: "chunk coherence",
  EXPLICIT_FORM: "explicit form detection",
  RESOLVED_FORM: "resolved form ownership",
  CHUNK_BOUNDARY: "chunk-boundary integrity",
  PARAGRAPH_SPLIT: "paragraph-split integrity",
};
const EVALUATION_SETS = {
  TUNING: "tuning",
  HOLDOUT: "holdout",
  UNSCOPED: "unscoped",
};
const DEFAULT_EVALUATION_SET = EVALUATION_SETS.TUNING;
const FAILURE_CLASS_ORDER = [
  FAILURE_CLASSES.DOCUMENT_COVERAGE,
  FAILURE_CLASSES.MISSING_SPAN,
  FAILURE_CLASSES.PAGE_START,
  FAILURE_CLASSES.RENDERED_SPACING,
  FAILURE_CLASSES.ORDERED_ANCHOR,
  FAILURE_CLASSES.TABLE_COLUMN,
  FAILURE_CLASSES.CHUNK_COHERENCE,
  FAILURE_CLASSES.EXPLICIT_FORM,
  FAILURE_CLASSES.RESOLVED_FORM,
  FAILURE_CLASSES.CHUNK_BOUNDARY,
  FAILURE_CLASSES.PARAGRAPH_SPLIT,
];

function parseArgs(argv) {
  const args = {
    pdfDir:
      process.env.M2_PDF_FIXTURE_DIR ||
      path.resolve(repoRoot, "..", "client_shared_pdfs"),
    enforceFormThreshold: false,
    enforceBoundaryClean: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--pdf-dir") {
      args.pdfDir = path.resolve(argv[i + 1] || "");
      i++;
      continue;
    }

    if (arg === "--enforce-form-threshold") {
      args.enforceFormThreshold = true;
      continue;
    }

    if (arg === "--enforce-boundary-clean") {
      args.enforceBoundaryClean = true;
    }
  }

  return args;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRenderedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSnippet(value, length = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

function parsePageRange(pageRange) {
  if (!pageRange) {
    return null;
  }

  const match = /^(\d+)-(\d+)$/.exec(pageRange);
  if (!match) {
    return null;
  }

  return { start: Number(match[1]), end: Number(match[2]) };
}

function chunkIncludesPage(chunk, pageNumber) {
  if (chunk.pageNumber === pageNumber) {
    return true;
  }

  const range = parsePageRange(chunk.metadata?.pageRange);
  if (!range) {
    return false;
  }

  return pageNumber >= range.start && pageNumber <= range.end;
}

function sanitizeDocumentId(filename) {
  const digest = crypto
    .createHash("sha1")
    .update(filename)
    .digest("hex")
    .slice(0, 10);

  return `m2-quality-${digest}`;
}

function normalizeFailureClass(value) {
  return FAILURE_CLASS_ORDER.includes(value) ? value : "uncategorized";
}

function normalizeEvaluationSet(value) {
  if (value === EVALUATION_SETS.HOLDOUT) {
    return EVALUATION_SETS.HOLDOUT;
  }

  if (value === EVALUATION_SETS.TUNING) {
    return EVALUATION_SETS.TUNING;
  }

  return EVALUATION_SETS.UNSCOPED;
}

function groupFailuresByClass(failures) {
  const grouped = new Map();

  for (const failure of failures) {
    const failureClass = normalizeFailureClass(failure.failureClass);
    const list = grouped.get(failureClass) || [];
    list.push(failure);
    grouped.set(failureClass, list);
  }

  return grouped;
}

function pushFailure(target, failureClass, filename, label, expected, actual) {
  target.push({ failureClass, filename, label, expected, actual });
}

function pushPageExpectationFailure(
  target,
  expectation,
  context,
  failureClass,
  label,
  expected,
  actual
) {
  target.push({
    failureClass,
    filename: context.filename,
    label,
    expected,
    actual,
    evaluationSet: normalizeEvaluationSet(
      expectation.evaluationSet || DEFAULT_EVALUATION_SET
    ),
    expectationKey: buildExpectationKey(context.filename, expectation),
  });
}

function printGroupedFailures(title, failures) {
  printHeader(title);

  if (failures.length === 0) {
    console.log("No failures.");
    return;
  }

  const grouped = groupFailuresByClass(failures);
  const orderedClasses = [
    ...FAILURE_CLASS_ORDER.filter((className) => grouped.has(className)),
    ...[...grouped.keys()]
      .filter((className) => !FAILURE_CLASS_ORDER.includes(className))
      .sort(),
  ];

  console.log("Failure class summary:");
  for (const className of FAILURE_CLASS_ORDER) {
    console.log(`- ${className}: ${grouped.get(className)?.length || 0}`);
  }
  if (grouped.has("uncategorized")) {
    console.log(`- uncategorized: ${grouped.get("uncategorized").length}`);
  }

  for (const className of orderedClasses) {
    const classFailures = grouped.get(className) || [];
    console.log(`\n${className}`);

    for (const failure of classFailures) {
      console.log(
        `- ${failure.filename} :: ${failure.label}\n` +
          `  expected: ${failure.expected}\n` +
          `  actual: ${failure.actual}`
      );
    }
  }
}

function summarizeEvaluationSetResults(expectations, failures) {
  const expectationMap = new Map();

  for (const entry of expectations) {
    const evaluationSet = normalizeEvaluationSet(entry.evaluationSet);
    const current = expectationMap.get(evaluationSet) || new Set();
    current.add(entry.expectationKey);
    expectationMap.set(evaluationSet, current);
  }

  const failureMap = new Map();
  for (const failure of failures) {
    const evaluationSet = normalizeEvaluationSet(failure.evaluationSet);
    if (evaluationSet === EVALUATION_SETS.UNSCOPED || !failure.expectationKey) {
      continue;
    }

    const current = failureMap.get(evaluationSet) || new Set();
    current.add(failure.expectationKey);
    failureMap.set(evaluationSet, current);
  }

  return [EVALUATION_SETS.TUNING, EVALUATION_SETS.HOLDOUT].map(
    (evaluationSet) => {
      const total = expectationMap.get(evaluationSet)?.size || 0;
      const failed = failureMap.get(evaluationSet)?.size || 0;
      return {
        evaluationSet,
        total,
        failed,
        passed: Math.max(total - failed, 0),
      };
    }
  );
}

function printEvaluationSetSummary(expectations, failures) {
  printHeader("Fidelity Evaluation Sets (same-family holdout)");

  const summary = summarizeEvaluationSetResults(expectations, failures);
  for (const entry of summary) {
    const displayName =
      entry.evaluationSet === EVALUATION_SETS.HOLDOUT
        ? "holdout (same-family)"
        : entry.evaluationSet;
    console.log(
      `- ${displayName}: ${entry.passed}/${entry.total} expectations passed`
    );

    const classCounts = new Map();
    for (const failure of failures) {
      if (normalizeEvaluationSet(failure.evaluationSet) !== entry.evaluationSet) {
        continue;
      }

      const failureClass = normalizeFailureClass(failure.failureClass);
      classCounts.set(failureClass, (classCounts.get(failureClass) || 0) + 1);
    }

    const classSummary = FAILURE_CLASS_ORDER.filter((failureClass) =>
      classCounts.has(failureClass)
    )
      .map((failureClass) => `${failureClass}=${classCounts.get(failureClass)}`)
      .join(", ");

    console.log(
      `  assertion failures by class: ${classSummary || "none"}`
    );
  }

  console.log(
    "  note: current holdout measures same-template drift, not fully family-disjoint generalization."
  );
}

function collectFixtureValidationFailures() {
  const failures = [];

  for (const documentFixture of fixtureConfig.documents) {
    for (const expectation of
      documentFixture.fidelityAssertions ||
      documentFixture.pageExpectations ||
      []) {
      if (!expectation.evaluationSet) {
        failures.push({
          filename: documentFixture.filename,
          label: expectation.label,
          issue: "missing evaluationSet",
        });
      }
    }
  }

  return failures;
}

// Mirrors src/lib/chunker.ts walkToTokenBoundary so the boundary audit reflects
// the actual chunker logic when force-splitting flat pages.
function walkToTokenBoundary(text, position, lowerBound, upperBound, direction) {
  const cap = Math.min(upperBound, text.length);
  if (direction === "backward") {
    for (let i = Math.min(position, cap); i > lowerBound; i--) {
      if (WHITESPACE_RE.test(text[i])) return i;
    }
    for (let i = Math.min(position, cap) + 1; i < cap; i++) {
      if (WHITESPACE_RE.test(text[i])) return i;
    }
    return position;
  }

  let i = Math.max(lowerBound, position);
  if (i >= cap) return cap;

  if (WHITESPACE_RE.test(text[i])) {
    while (i < cap && WHITESPACE_RE.test(text[i])) i++;
    return i;
  }

  while (i < cap && !WHITESPACE_RE.test(text[i])) i++;
  while (i < cap && WHITESPACE_RE.test(text[i])) i++;
  return i;
}

function forceSplitByLengthWithOffsets(text, maxTokens, overlapTokens) {
  const maxChars = maxTokens * 4;
  const overlapChars = Math.min(overlapTokens * 4, maxChars - 100);
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      end = walkToTokenBoundary(text, end, start + 1, text.length, "backward");
    }

    chunks.push({
      start,
      end,
      text: text.substring(start, end).trim(),
    });

    if (end >= text.length) {
      break;
    }

    const overlapTarget = end - overlapChars;
    let nextStart = walkToTokenBoundary(
      text,
      overlapTarget,
      start + 1,
      end,
      "forward"
    );
    if (nextStart >= end) {
      nextStart = end;
    }

    start = Math.max(nextStart, start + 1);
  }

  return chunks;
}

function analyzeBoundaryRisks(filename, pages) {
  const results = [];

  for (const page of pages) {
    if (estimateTokens(page.text) <= MAX_TOKENS_PER_CHUNK) {
      continue;
    }

    if (/\n\n+/.test(page.text)) {
      continue;
    }

    const splits = forceSplitByLengthWithOffsets(
      page.text,
      MAX_TOKENS_PER_CHUNK,
      OVERLAP_TOKENS
    );

    for (let i = 1; i < splits.length; i++) {
      const start = splits[i].start;
      const before = page.text[start - 1] || "";
      const current = page.text[start] || "";
      const midTokenStart = TOKEN_CHAR.test(before) && TOKEN_CHAR.test(current);

      results.push({
        filename,
        pageNumber: page.pageNumber,
        splitIndex: i,
        midTokenStart,
        context: page.text
          .slice(Math.max(0, start - 40), Math.min(page.text.length, start + 80))
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
  }

  return results;
}

function mergeChunkContents(previousContent, nextContent) {
  const left = String(previousContent || "").trim();
  const right = String(nextContent || "").trim();

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const overlapLimit = Math.min(left.length, right.length);
  for (let overlap = overlapLimit; overlap > 0; overlap--) {
    if (left.slice(-overlap) === right.slice(0, overlap)) {
      return left + right.slice(overlap);
    }
  }

  return `${left}\n${right}`;
}

function reconstructPageFromChunks(pageChunks) {
  if (pageChunks.length === 0) {
    return "";
  }

  return pageChunks.reduce((merged, chunk) => {
    if (!merged) {
      return String(chunk.content || "").trim();
    }

    return mergeChunkContents(merged, chunk.content);
  }, "");
}

function analyzeParagraphSplitIntegrity(filename, processedPages, chunks) {
  const results = [];
  const byPage = new Map();

  for (const chunk of chunks) {
    const list = byPage.get(chunk.pageNumber) || [];
    list.push(chunk);
    byPage.set(chunk.pageNumber, list);
  }

  for (const page of processedPages) {
    const pageChunks = byPage.get(page.pageNumber) || [];
    if (pageChunks.length <= 1) {
      continue;
    }

    const sorted = [...pageChunks].sort(
      (left, right) => left.chunkIndex - right.chunkIndex
    );
    const reconstructed = reconstructPageFromChunks(sorted);

    if (normalizeText(reconstructed) !== normalizeText(page.text)) {
      results.push({
        failureClass: FAILURE_CLASSES.PARAGRAPH_SPLIT,
        filename,
        label: `page ${page.pageNumber} paragraph-split reconstruction`,
        expected: formatSnippet(page.text, 220),
        actual: formatSnippet(reconstructed, 220),
      });
    }
  }

  return results;
}

function buildSyntheticParagraphSplitPages() {
  const intro = Array.from({ length: 28 }, (_, index) =>
    `intro${String(index).padStart(3, "0")}`
  ).join(" ");
  const middle = Array.from({ length: 1700 }, (_, index) =>
    `middle${String(index).padStart(4, "0")}`
  ).join(" ");
  const tail = Array.from({ length: 28 }, (_, index) =>
    `tail${String(index).padStart(3, "0")}`
  ).join(" ");

  return [
    {
      pageNumber: 1,
      text: `${intro}\n\n${middle}\n\n${tail}`,
    },
  ];
}

function runSyntheticParagraphSplitAudit() {
  const pages = buildSyntheticParagraphSplitPages();
  const cleanedPages = pages.map((page) => ({
    ...page,
    text: cleanPageText(page.text),
  }));
  const processedPages = removeRepeatedHeaders(cleanedPages);
  const chunks = chunkDocument(processedPages, "synthetic-paragraph-split.pdf");

  return {
    chunkCount: chunks.length,
    reconstructionFailures: analyzeParagraphSplitIntegrity(
      "synthetic-paragraph-split.pdf",
      processedPages,
      chunks
    ),
    boundaryFailures: analyzeEmittedChunkBoundaries(
      "synthetic-paragraph-split.pdf",
      chunks
    ),
  };
}

function computeFormMetrics(entries) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let exactMatches = 0;

  for (const entry of entries) {
    if (entry.expected === entry.actual) {
      exactMatches += 1;
      if (entry.expected !== null) {
        truePositive += 1;
      }
      continue;
    }

    if (entry.expected === null && entry.actual !== null) {
      falsePositive += 1;
      continue;
    }

    if (entry.expected !== null && entry.actual === null) {
      falseNegative += 1;
      continue;
    }

    falsePositive += 1;
    falseNegative += 1;
  }

  const precisionDenominator = truePositive + falsePositive;
  const recallDenominator = truePositive + falseNegative;

  return {
    total: entries.length,
    exactMatches,
    truePositive,
    falsePositive,
    falseNegative,
    exactAccuracy: entries.length ? exactMatches / entries.length : 0,
    precision: precisionDenominator
      ? truePositive / precisionDenominator
      : 1,
    recall: recallDenominator ? truePositive / recallDenominator : 1,
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function printHeader(title) {
  console.log(`\n${title}`);
}

function valueOrNull(value) {
  return value == null ? null : value;
}

function buildExpectationKey(filename, expectation) {
  return `${filename}::${expectation.page}::${expectation.label}`;
}

function getStartWindow(text, size) {
  return normalizeText(String(text || "").slice(0, size || DEFAULT_START_WINDOW));
}

function getRenderedStartWindow(text, size) {
  return normalizeRenderedText(
    String(text || "").slice(0, size || DEFAULT_START_WINDOW)
  );
}

function matchesNormalizedSubstring(source, needle) {
  const normalizedSource = normalizeText(source);
  const normalizedNeedle = normalizeText(needle);
  return normalizedSource.includes(normalizedNeedle);
}

function matchesRenderedSubstring(source, needle) {
  const normalizedSource = normalizeRenderedText(source);
  const normalizedNeedle = normalizeRenderedText(needle);
  return normalizedSource.includes(normalizedNeedle);
}

function renderChunkMetadataSummary(chunk) {
  const metadata = chunk.metadata || {};
  const sourcePages = Array.isArray(metadata.sourcePageNumbers)
    ? metadata.sourcePageNumbers.join(",")
    : String(chunk.pageNumber);

  return normalizeText(
    [
      `explicit=${metadata.explicitFormType ?? "null"}`,
      `resolved=${metadata.resolvedFormType ?? metadata.formType ?? "null"}`,
      `source=${metadata.formTypeSource ?? "null"}`,
      `origin=${metadata.formTypeOriginPage ?? "null"}`,
      `pages=${sourcePages}`,
      `range=${metadata.pageRange ?? "-"}`,
      `start=${metadata.coversPageStart ? "true" : "false"}`,
      `end=${metadata.coversPageEnd ? "true" : "false"}`,
      `partial=${metadata.isPartialPage ? "true" : "false"}`,
      `part=${metadata.partIndex ?? "null"}`,
    ].join(" | ")
  );
}

function getSourcePageNumbers(chunk) {
  const value = chunk.metadata?.sourcePageNumbers;
  return Array.isArray(value) ? value.map(Number) : [chunk.pageNumber];
}

function getExplicitFormType(chunk) {
  return valueOrNull(chunk.metadata?.explicitFormType);
}

function getResolvedFormType(chunk) {
  return valueOrNull(chunk.metadata?.resolvedFormType ?? chunk.metadata?.formType);
}

function getPublicFormType(chunk) {
  return valueOrNull(chunk.metadata?.formType);
}

function getFormTypeSource(chunk) {
  return valueOrNull(chunk.metadata?.formTypeSource);
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => Number(value) === Number(right[index]));
}

function matchesOrderedNeedles(source, needles) {
  let cursor = 0;

  for (const needle of needles) {
    const normalizedNeedle = normalizeText(needle);
    const index = source.indexOf(normalizedNeedle, cursor);
    if (index === -1) {
      return false;
    }

    cursor = index + normalizedNeedle.length;
  }

  return true;
}

function matchesRenderedOrderedNeedles(source, needles) {
  let cursor = 0;
  const renderedSource = normalizeRenderedText(source);

  for (const needle of needles) {
    const renderedNeedle = normalizeRenderedText(needle);
    const index = renderedSource.indexOf(renderedNeedle, cursor);
    if (index === -1) {
      return false;
    }

    cursor = index + renderedNeedle.length;
  }

  return true;
}

function findArtifactHits(source, artifacts) {
  if (!artifacts?.length) {
    return [];
  }

  const renderedSource = normalizeRenderedText(source);
  return artifacts
    .map((artifact) => {
      const normalizedArtifact = normalizeRenderedText(artifact);
      const index = renderedSource.indexOf(normalizedArtifact);
      if (index === -1) {
        return null;
      }

      return {
        artifact,
        context: renderedSource.slice(
          Math.max(0, index - 40),
          Math.min(renderedSource.length, index + normalizedArtifact.length + 80)
        ),
      };
    })
    .filter(Boolean);
}

function formatArtifactHits(hits) {
  return hits
    .map((hit) => `${hit.artifact} [${hit.context}]`)
    .join(", ");
}

function evaluatePageExpectation(expectation, context, failures) {
  const { filename, processedPages, chunks } = context;
  const expectationLabel = expectation.label;
  const page = processedPages.find((entry) => entry.pageNumber === expectation.page);

  if (!page) {
    pushPageExpectationFailure(
      failures,
      expectation,
      context,
      FAILURE_CLASSES.DOCUMENT_COVERAGE,
      expectationLabel,
      `page ${expectation.page} to exist`,
      "page missing after processing"
    );
    return;
  }

  if (expectation.pageStartMustContain?.length) {
    const actualStart = getStartWindow(page.text, expectation.pageStartWindow);
    if (!matchesOrderedNeedles(actualStart, expectation.pageStartMustContain)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.PAGE_START,
        `${expectationLabel} :: page start`,
        expectation.pageStartMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.renderedPageStartMustContain?.length) {
    const actualRenderedStart = getRenderedStartWindow(
      page.text,
      expectation.pageStartWindow
    );
    if (
      !matchesRenderedOrderedNeedles(
        actualRenderedStart,
        expectation.renderedPageStartMustContain
      )
    ) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RENDERED_SPACING,
        `${expectationLabel} :: rendered page start`,
        expectation.renderedPageStartMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.expectedPageStartSnippet) {
    const actualStart = getStartWindow(page.text, expectation.pageStartWindow);
    if (!matchesNormalizedSubstring(actualStart, expectation.expectedPageStartSnippet)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.PAGE_START,
        `${expectationLabel} :: page start snippet`,
        expectation.expectedPageStartSnippet,
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.pageMustContain?.length) {
    const normalizedPage = normalizeText(page.text);
    const missing = expectation.pageMustContain.filter(
      (needle) => !normalizedPage.includes(normalizeText(needle))
    );

    if (missing.length > 0) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.MISSING_SPAN,
        `${expectationLabel} :: page text`,
        expectation.pageMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.renderedPageMustContain?.length) {
    const missing = expectation.renderedPageMustContain.filter(
      (needle) => !matchesRenderedSubstring(page.text, needle)
    );

    if (missing.length > 0) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RENDERED_SPACING,
        `${expectationLabel} :: rendered page text`,
        expectation.renderedPageMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.expectedMidPageSnippet) {
    if (!matchesNormalizedSubstring(page.text, expectation.expectedMidPageSnippet)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.MISSING_SPAN,
        `${expectationLabel} :: mid-page snippet`,
        expectation.expectedMidPageSnippet,
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.expectedRenderedMidPageSnippet) {
    if (!matchesRenderedSubstring(page.text, expectation.expectedRenderedMidPageSnippet)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RENDERED_SPACING,
        `${expectationLabel} :: rendered mid-page snippet`,
        expectation.expectedRenderedMidPageSnippet,
        formatSnippet(page.text)
      );
    }
  }

  const pageArtifactHits = findArtifactHits(page.text, expectation.forbiddenPageArtifacts);
  if (pageArtifactHits.length > 0) {
    pushPageExpectationFailure(
      failures,
      expectation,
      context,
      FAILURE_CLASSES.RENDERED_SPACING,
      `${expectationLabel} :: forbidden page artifacts`,
      "no forbidden rendered artifacts",
      formatArtifactHits(pageArtifactHits)
    );
  }

  const coveringChunks = chunks
    .filter((chunk) => chunkIncludesPage(chunk, expectation.page))
    .sort((left, right) => left.chunkIndex - right.chunkIndex);

  if (coveringChunks.length === 0) {
    pushPageExpectationFailure(
      failures,
      expectation,
      context,
      FAILURE_CLASSES.CHUNK_BOUNDARY,
      `${expectationLabel} :: chunk coverage`,
      `chunk covering page ${expectation.page}`,
      "no chunk covered the page"
    );
    return;
  }

  const firstChunk = coveringChunks[0];
  const lastChunk = coveringChunks[coveringChunks.length - 1];

  if (expectation.firstChunkStartMustContain?.length) {
    const actualStart = getStartWindow(
      firstChunk.content,
      expectation.firstChunkStartWindow
    );
    if (!matchesOrderedNeedles(actualStart, expectation.firstChunkStartMustContain)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.PAGE_START,
        `${expectationLabel} :: first chunk start`,
        expectation.firstChunkStartMustContain.join(" + "),
        formatSnippet(firstChunk.content)
      );
    }
  }

  if (expectation.renderedFirstChunkStartMustContain?.length) {
    const actualRenderedStart = getRenderedStartWindow(
      firstChunk.content,
      expectation.firstChunkStartWindow
    );
    if (
      !matchesRenderedOrderedNeedles(
        actualRenderedStart,
        expectation.renderedFirstChunkStartMustContain
      )
    ) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RENDERED_SPACING,
        `${expectationLabel} :: rendered first chunk start`,
        expectation.renderedFirstChunkStartMustContain.join(" + "),
        formatSnippet(firstChunk.content)
      );
    }
  }

  if (expectation.expectedFirstChunkStartSnippet) {
    const actualStart = getStartWindow(
      firstChunk.content,
      expectation.firstChunkStartWindow
    );
    if (!matchesNormalizedSubstring(actualStart, expectation.expectedFirstChunkStartSnippet)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.PAGE_START,
        `${expectationLabel} :: first chunk start snippet`,
        expectation.expectedFirstChunkStartSnippet,
        formatSnippet(firstChunk.content)
      );
    }
  }

  if (expectation.expectedFirstChunkMetadataSnippet) {
    const actualMetadata = renderChunkMetadataSummary(firstChunk);
    if (!matchesNormalizedSubstring(actualMetadata, expectation.expectedFirstChunkMetadataSnippet)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_BOUNDARY,
        `${expectationLabel} :: first chunk metadata`,
        expectation.expectedFirstChunkMetadataSnippet,
        actualMetadata
      );
    }
  }

  const firstChunkArtifactHits = findArtifactHits(
    firstChunk.content,
    expectation.forbiddenFirstChunkArtifacts
  );
  if (firstChunkArtifactHits.length > 0) {
    pushPageExpectationFailure(
      failures,
      expectation,
      context,
      FAILURE_CLASSES.RENDERED_SPACING,
      `${expectationLabel} :: forbidden first chunk artifacts`,
      "no forbidden rendered artifacts",
      formatArtifactHits(firstChunkArtifactHits)
    );
  }

  if ("expectedChunkCount" in expectation) {
    if (coveringChunks.length !== expectation.expectedChunkCount) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_COHERENCE,
        `${expectationLabel} :: chunk count`,
        `${expectation.expectedChunkCount}`,
        `${coveringChunks.length}`
      );
    }
  }

  if (expectation.forbiddenAnyChunkArtifacts?.length) {
    const artifactHits = coveringChunks.flatMap((chunk) =>
      findArtifactHits(chunk.content, expectation.forbiddenAnyChunkArtifacts).map(
        (hit) => `${chunk.chunkIndex}:${hit.artifact} [${hit.context}]`
      )
    );

    if (artifactHits.length > 0) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_COHERENCE,
        `${expectationLabel} :: forbidden chunk artifacts`,
        "no forbidden rendered artifacts in page chunks",
        artifactHits.join(", ")
      );
    }
  }

  if ("expectedExplicitFormType" in expectation) {
    const actual = getExplicitFormType(firstChunk);
    if (actual !== expectation.expectedExplicitFormType) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.EXPLICIT_FORM,
        `${expectationLabel} :: explicit form type`,
        expectation.expectedExplicitFormType ?? "null",
        actual ?? "null"
      );
    }
  }

  if ("expectedResolvedFormType" in expectation) {
    const actual = getResolvedFormType(firstChunk);
    if (actual !== expectation.expectedResolvedFormType) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RESOLVED_FORM,
        `${expectationLabel} :: resolved form type`,
        expectation.expectedResolvedFormType ?? "null",
        actual ?? "null"
      );
    }
  }

  if ("expectedFormTypeSource" in expectation) {
    const actual = getFormTypeSource(firstChunk);
    if (actual !== expectation.expectedFormTypeSource) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RESOLVED_FORM,
        `${expectationLabel} :: form type source`,
        expectation.expectedFormTypeSource ?? "null",
        actual ?? "null"
      );
    }
  }

  if ("allChunksResolvedFormType" in expectation) {
    const mismatched = coveringChunks.find(
      (chunk) => getResolvedFormType(chunk) !== expectation.allChunksResolvedFormType
    );

    if (mismatched) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RESOLVED_FORM,
        `${expectationLabel} :: all chunk resolved form types`,
        expectation.allChunksResolvedFormType ?? "null",
        `${mismatched.chunkIndex}:${getResolvedFormType(mismatched) ?? "null"}`
      );
    }
  }

  if ("allChunksFormTypeSource" in expectation) {
    const mismatched = coveringChunks.find(
      (chunk) => getFormTypeSource(chunk) !== expectation.allChunksFormTypeSource
    );

    if (mismatched) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RESOLVED_FORM,
        `${expectationLabel} :: all chunk form type sources`,
        expectation.allChunksFormTypeSource ?? "null",
        `${mismatched.chunkIndex}:${getFormTypeSource(mismatched) ?? "null"}`
      );
    }
  }

  if (expectation.orderedAnchorMustContain?.length) {
    const normalizedPage = normalizeText(page.text);
    if (!matchesOrderedNeedles(normalizedPage, expectation.orderedAnchorMustContain)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.ORDERED_ANCHOR,
        `${expectationLabel} :: ordered anchors`,
        expectation.orderedAnchorMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.renderedOrderedAnchorMustContain?.length) {
    if (
      !matchesRenderedOrderedNeedles(
        page.text,
        expectation.renderedOrderedAnchorMustContain
      )
    ) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.RENDERED_SPACING,
        `${expectationLabel} :: rendered ordered anchors`,
        expectation.renderedOrderedAnchorMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if (expectation.tableColumnOrderedMustContain?.length) {
    const normalizedPage = normalizeText(page.text);
    if (!matchesOrderedNeedles(normalizedPage, expectation.tableColumnOrderedMustContain)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.TABLE_COLUMN,
        `${expectationLabel} :: table/column order`,
        expectation.tableColumnOrderedMustContain.join(" + "),
        formatSnippet(page.text)
      );
    }
  }

  if ("expectStandaloneFirstChunk" in expectation && expectation.expectStandaloneFirstChunk) {
    const actualRange = firstChunk.metadata?.pageRange ?? null;
    const sourcePages = getSourcePageNumbers(firstChunk);
    const standalone =
      firstChunk.pageNumber === expectation.page &&
      !actualRange &&
      arraysEqual(sourcePages, [expectation.page]);

    if (!standalone) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_BOUNDARY,
        `${expectationLabel} :: standalone first chunk`,
        `page ${expectation.page} only`,
        `pageNumber=${firstChunk.pageNumber}, pageRange=${actualRange ?? "-"}, sourcePageNumbers=${sourcePages.join(",")}`
      );
    }
  }

  if ("expectSourcePageNumbers" in expectation) {
    const actual = getSourcePageNumbers(firstChunk);
    if (!arraysEqual(actual, expectation.expectSourcePageNumbers)) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_BOUNDARY,
        `${expectationLabel} :: source page numbers`,
        expectation.expectSourcePageNumbers.join(","),
        actual.join(",")
      );
    }
  }

  if ("expectFirstChunkCoversPageStart" in expectation) {
    const actual = Boolean(firstChunk.metadata?.coversPageStart);
    if (actual !== expectation.expectFirstChunkCoversPageStart) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_BOUNDARY,
        `${expectationLabel} :: first chunk page start coverage`,
        String(expectation.expectFirstChunkCoversPageStart),
        String(actual)
      );
    }
  }

  if ("expectLastChunkCoversPageEnd" in expectation) {
    const actual = Boolean(lastChunk.metadata?.coversPageEnd);
    if (actual !== expectation.expectLastChunkCoversPageEnd) {
      pushPageExpectationFailure(
        failures,
        expectation,
        context,
        FAILURE_CLASSES.CHUNK_BOUNDARY,
        `${expectationLabel} :: last chunk page end coverage`,
        String(expectation.expectLastChunkCoversPageEnd),
        String(actual)
      );
    }
  }
}

function analyzeEmittedChunkBoundaries(filename, chunks) {
  const results = [];
  const byPage = new Map();

  for (const chunk of chunks) {
    const actualTokenEstimate = estimateTokens(chunk.content);
    if (actualTokenEstimate !== chunk.tokenEstimate) {
      results.push({
        failureClass: FAILURE_CLASSES.CHUNK_BOUNDARY,
        filename,
        label: `page ${chunk.pageNumber} chunk ${chunk.chunkIndex} token estimate`,
        expected: `${actualTokenEstimate}`,
        actual: `${chunk.tokenEstimate}`,
      });
    }

    if (actualTokenEstimate > MAX_TOKENS_PER_CHUNK) {
      results.push({
        failureClass: FAILURE_CLASSES.CHUNK_BOUNDARY,
        filename,
        label: `page ${chunk.pageNumber} chunk ${chunk.chunkIndex} token limit`,
        expected: `<= ${MAX_TOKENS_PER_CHUNK}`,
        actual: `${actualTokenEstimate}`,
      });
    }

    const list = byPage.get(chunk.pageNumber) || [];
    list.push(chunk);
    byPage.set(chunk.pageNumber, list);
  }

  for (const [pageNumber, pageChunks] of byPage.entries()) {
    const sorted = [...pageChunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
    if (sorted.length <= 1) {
      continue;
    }

    if (sorted.some((chunk) => !chunk.metadata?.isPartialPage)) {
      results.push({
        failureClass: FAILURE_CLASSES.CHUNK_BOUNDARY,
        filename,
        label: `page ${pageNumber} partial-page flag`,
        expected: "all emitted chunks to be marked partial",
        actual: "at least one emitted chunk was not marked partial",
      });
    }

    for (let index = 0; index < sorted.length; index++) {
      const chunk = sorted[index];
      if (chunk.metadata?.partIndex !== index) {
        results.push({
          failureClass: FAILURE_CLASSES.CHUNK_BOUNDARY,
          filename,
          label: `page ${pageNumber} part index ${index}`,
          expected: `${index}`,
          actual: `${chunk.metadata?.partIndex ?? "null"}`,
        });
        break;
      }
    }

    const firstChunk = sorted[0];
    const lastChunk = sorted[sorted.length - 1];
    const resolvedFormType = firstChunk.metadata?.resolvedFormType ?? null;
    const formTypeSource = firstChunk.metadata?.formTypeSource ?? null;
    const formTypeOriginPage = firstChunk.metadata?.formTypeOriginPage ?? null;

    for (const chunk of sorted) {
      if ((chunk.metadata?.resolvedFormType ?? null) !== resolvedFormType) {
        results.push({
          failureClass: FAILURE_CLASSES.RESOLVED_FORM,
          filename,
          label: `page ${pageNumber} resolved form type consistency`,
          expected: resolvedFormType ?? "null",
          actual: `${chunk.chunkIndex}:${chunk.metadata?.resolvedFormType ?? "null"}`,
        });
        break;
      }
    }

    for (const chunk of sorted) {
      if (getPublicFormType(chunk) !== (chunk.metadata?.resolvedFormType ?? null)) {
        results.push({
          failureClass: FAILURE_CLASSES.RESOLVED_FORM,
          filename,
          label: `page ${pageNumber} public form alias consistency`,
          expected: resolvedFormType ?? "null",
          actual: `${chunk.chunkIndex}:${getPublicFormType(chunk) ?? "null"}`,
        });
        break;
      }
    }

    for (const chunk of sorted) {
      if ((chunk.metadata?.formTypeSource ?? null) !== formTypeSource) {
        results.push({
          failureClass: FAILURE_CLASSES.RESOLVED_FORM,
          filename,
          label: `page ${pageNumber} form type source consistency`,
          expected: formTypeSource ?? "null",
          actual: `${chunk.chunkIndex}:${chunk.metadata?.formTypeSource ?? "null"}`,
        });
        break;
      }
    }

    for (const chunk of sorted) {
      if ((chunk.metadata?.formTypeOriginPage ?? null) !== formTypeOriginPage) {
        results.push({
          failureClass: FAILURE_CLASSES.RESOLVED_FORM,
          filename,
          label: `page ${pageNumber} form type origin consistency`,
          expected: formTypeOriginPage == null ? "null" : `${formTypeOriginPage}`,
          actual: `${chunk.chunkIndex}:${chunk.metadata?.formTypeOriginPage ?? "null"}`,
        });
        break;
      }
    }

    if (!firstChunk.metadata?.coversPageStart) {
      results.push({
        failureClass: FAILURE_CLASSES.CHUNK_BOUNDARY,
        filename,
        label: `page ${pageNumber} first chunk start coverage`,
        expected: "true",
        actual: "false",
      });
    }

    if (!lastChunk.metadata?.coversPageEnd) {
      results.push({
        failureClass: FAILURE_CLASSES.CHUNK_BOUNDARY,
        filename,
        label: `page ${pageNumber} last chunk end coverage`,
        expected: "true",
        actual: "false",
      });
    }
  }

  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pdfDir = options.pdfDir;
  const fixtureValidationFailures = collectFixtureValidationFailures();

  if (fixtureValidationFailures.length > 0) {
    printHeader("Fixture Validation");
    for (const failure of fixtureValidationFailures) {
      console.log(
        `- ${failure.filename} :: ${failure.label}\n` +
          `  issue: ${failure.issue}`
      );
    }
    process.exit(1);
  }

  if (!fs.existsSync(pdfDir)) {
    console.error(
      `PDF fixture directory not found: ${pdfDir}\n` +
        "Set M2_PDF_FIXTURE_DIR or pass --pdf-dir to point at the sample PDFs."
    );
    process.exit(1);
  }

  const missingFiles = [];
  const documentCoverageFailures = [];
  const valueFailures = [];
  const pageExpectationFailures = [];
  const pageExpectationCatalog = [];
  const formResults = [];
  const emittedBoundaryFailures = [];
  const paragraphSplitFailures = [];
  const heuristicBoundaryResults = [];
  let totalEmittedChunks = 0;

  printHeader("M2 PDF Quality Verification");
  console.log(`PDF directory: ${pdfDir}`);

  for (const documentFixture of fixtureConfig.documents) {
    const pdfPath = path.join(pdfDir, documentFixture.filename);
    if (!fs.existsSync(pdfPath)) {
      missingFiles.push(documentFixture.filename);
      pushFailure(
        documentCoverageFailures,
        FAILURE_CLASSES.DOCUMENT_COVERAGE,
        documentFixture.filename,
        "missing PDF",
        "PDF fixture to exist",
        "file missing from pdf directory"
      );
      continue;
    }

    const fileBuffer = fs.readFileSync(pdfPath);
    const { pages, pageCount } = await extractStructuredPages(
      fileBuffer,
      sanitizeDocumentId(documentFixture.filename)
    );
    const cleanedPages = pages.map((page) => ({
      ...page,
      text: cleanPageText(page.text),
    }));
    const processedPages = removeRepeatedHeaders(cleanedPages);
    const chunks = chunkDocument(processedPages, documentFixture.filename);
    totalEmittedChunks += chunks.length;

    console.log(`\n${documentFixture.filename}`);
    console.log(
      `  page count ${pageCount}/${documentFixture.expectedPageCount}, chunks ${chunks.length}`
    );

    if ("expectedChunkCount" in documentFixture) {
      const delta = chunks.length - Number(documentFixture.expectedChunkCount);
      const deltaPrefix = delta === 0 ? "stable" : delta > 0 ? "+" : "";
      console.log(
        `  chunk baseline ${documentFixture.expectedChunkCount} -> ${chunks.length} (${deltaPrefix}${delta})`
      );
    }

    if (pageCount !== documentFixture.expectedPageCount) {
      pushFailure(
        valueFailures,
        FAILURE_CLASSES.DOCUMENT_COVERAGE,
        documentFixture.filename,
        "page count",
        `${documentFixture.expectedPageCount}`,
        `${pageCount}`
      );
    }

    for (const assertion of documentFixture.valueAssertions) {
      const candidateChunks = chunks.filter((chunk) =>
        chunkIncludesPage(chunk, assertion.page)
      );
      const matchingChunk = candidateChunks.find((chunk) => {
        const normalizedChunk = normalizeText(chunk.content);
        return assertion.mustContain.every((needle) =>
          normalizedChunk.includes(normalizeText(needle))
        );
      });

      if (!matchingChunk) {
        pushFailure(
          valueFailures,
          FAILURE_CLASSES.MISSING_SPAN,
          documentFixture.filename,
          assertion.label,
          assertion.mustContain.join(" + "),
          `no chunk for page ${assertion.page} contained every expected token`
        );
      }
    }

    for (const expectation of
      documentFixture.fidelityAssertions ||
      documentFixture.pageExpectations ||
      []) {
      pageExpectationCatalog.push({
        expectationKey: buildExpectationKey(documentFixture.filename, expectation),
        evaluationSet: normalizeEvaluationSet(
          expectation.evaluationSet || DEFAULT_EVALUATION_SET
        ),
      });
      evaluatePageExpectation(
        expectation,
        {
          filename: documentFixture.filename,
          processedPages,
          chunks,
        },
        pageExpectationFailures
      );
    }

    for (const label of documentFixture.formLabels) {
      const page = processedPages.find((entry) => entry.pageNumber === label.page);
      const actual = page ? detectFormType(page.text) : null;

      formResults.push({
        filename: documentFixture.filename,
        page: label.page,
        label: label.label,
        expected: label.expected,
        actual,
      });
    }

    emittedBoundaryFailures.push(
      ...analyzeEmittedChunkBoundaries(documentFixture.filename, chunks)
    );
    paragraphSplitFailures.push(
      ...analyzeParagraphSplitIntegrity(
        documentFixture.filename,
        processedPages,
        chunks
      )
    );
    heuristicBoundaryResults.push(
      ...analyzeBoundaryRisks(documentFixture.filename, processedPages)
    );
  }

  const syntheticParagraphSplitAudit = runSyntheticParagraphSplitAudit();
  paragraphSplitFailures.push(...syntheticParagraphSplitAudit.reconstructionFailures);
  emittedBoundaryFailures.push(...syntheticParagraphSplitAudit.boundaryFailures);

  if (missingFiles.length > 0) {
    printHeader("Missing PDFs");
    for (const filename of missingFiles) {
      console.log(`- ${filename}`);
    }
  }

  const formMetrics = computeFormMetrics(formResults);
  const formMismatches = formResults.filter(
    (entry) => entry.expected !== entry.actual
  );
  const explicitFormFailures = formMismatches.map((mismatch) => ({
    failureClass: FAILURE_CLASSES.EXPLICIT_FORM,
    filename: mismatch.filename,
    label: `page ${mismatch.page} (${mismatch.label})`,
    expected: mismatch.expected ?? "null",
    actual: mismatch.actual ?? "null",
  }));
  const fidelityFailures = [
    ...documentCoverageFailures,
    ...valueFailures,
    ...pageExpectationFailures,
    ...explicitFormFailures,
    ...emittedBoundaryFailures,
    ...paragraphSplitFailures,
  ];

  if (fidelityFailures.length === 0) {
    printHeader("Fidelity Assertions");
    console.log("All fidelity assertions passed.");
  } else {
    printGroupedFailures("Fidelity Assertions", fidelityFailures);
  }

  printEvaluationSetSummary(pageExpectationCatalog, pageExpectationFailures);

  printHeader("Form Detection");
  console.log(
    `Exact page accuracy: ${formatPercent(formMetrics.exactAccuracy)} ` +
      `(${formMetrics.exactMatches}/${formMetrics.total})`
  );
  console.log(
    `Precision: ${formatPercent(formMetrics.precision)} ` +
      `Recall: ${formatPercent(formMetrics.recall)}`
  );

  if (formMismatches.length === 0) {
    console.log("All manually labeled pages matched.");
  } else {
    for (const mismatch of formMismatches) {
      console.log(
        `- ${mismatch.filename} page ${mismatch.page} (${mismatch.label})\n` +
          `  expected: ${mismatch.expected ?? "null"}\n` +
          `  actual: ${mismatch.actual ?? "null"}`
      );
    }
  }

  const heuristicBoundaryCount = heuristicBoundaryResults.filter(
    (result) => result.midTokenStart
  ).length;
  printHeader("Chunk Boundary Audit");
  console.log(
    `Emitted chunks checked: ${totalEmittedChunks}\n` +
      `Emitted boundary failures: ${emittedBoundaryFailures.length}`
  );

  if (emittedBoundaryFailures.length === 0) {
    console.log("All emitted chunk boundary checks passed.");
  } else {
    for (const failure of emittedBoundaryFailures.slice(0, 8)) {
      console.log(
        `- ${failure.filename} :: ${failure.label}\n` +
          `  expected: ${failure.expected}\n` +
          `  actual: ${failure.actual}`
      );
    }
  }

  if (heuristicBoundaryResults.length > 0) {
    console.log(
      `\nHeuristic overlap starts checked: ${heuristicBoundaryResults.length}\n` +
        `Mid-token starts detected: ${heuristicBoundaryCount}`
    );

    if (heuristicBoundaryCount === 0) {
      console.log("No mid-token overlap starts detected.");
    } else {
      for (const result of heuristicBoundaryResults
        .filter((entry) => entry.midTokenStart)
        .slice(0, 8)) {
        console.log(
          `- ${result.filename} page ${result.pageNumber} split ${result.splitIndex}\n` +
            `  context: ${result.context}`
        );
      }
    }
  }

  printHeader("Paragraph Split Integrity");
  console.log(
    `Paragraph-split reconstruction failures: ${paragraphSplitFailures.length}\n` +
      `Synthetic paragraph-split chunks checked: ${syntheticParagraphSplitAudit.chunkCount}`
  );

  if (paragraphSplitFailures.length === 0) {
    console.log("All paragraph-split reconstruction checks passed.");
  } else {
    for (const failure of paragraphSplitFailures.slice(0, 8)) {
      console.log(
        `- ${failure.filename} :: ${failure.label}\n` +
          `  expected: ${failure.expected}\n` +
          `  actual: ${failure.actual}`
      );
    }
  }

  const belowRecommendedFormThreshold =
    formMetrics.precision < fixtureConfig.recommendedThresholds.formPrecision ||
    formMetrics.recall < fixtureConfig.recommendedThresholds.formRecall;

  if (belowRecommendedFormThreshold && !options.enforceFormThreshold) {
    console.log(
      `\nForm metrics are below the recommended threshold ` +
        `(${formatPercent(fixtureConfig.recommendedThresholds.formPrecision)} precision / ` +
        `${formatPercent(fixtureConfig.recommendedThresholds.formRecall)} recall), ` +
        "but the threshold is report-only until you pass --enforce-form-threshold."
    );
  }

  if (heuristicBoundaryResults.length > 0 && !options.enforceBoundaryClean) {
    console.log(
      "\nChunk boundary findings are report-only until you pass --enforce-boundary-clean."
    );
  }

  const shouldFail =
    missingFiles.length > 0 ||
    valueFailures.length > 0 ||
    pageExpectationFailures.length > 0 ||
    formMismatches.length > 0 ||
    emittedBoundaryFailures.length > 0 ||
    paragraphSplitFailures.length > 0 ||
    (options.enforceFormThreshold && belowRecommendedFormThreshold) ||
    (options.enforceBoundaryClean && heuristicBoundaryCount > 0);

  process.exit(shouldFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
