#!/usr/bin/env node

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
  extractTextByPage,
} = require(path.join(repoRoot, "src/lib/pdf-processor.ts"));
const {
  cleanPageText,
  detectFormType,
  removeRepeatedHeaders,
} = require(path.join(repoRoot, "src/lib/text-cleaner.ts"));
const {
  chunkDocument,
  estimateTokens,
} = require(path.join(repoRoot, "src/lib/chunker.ts"));

const MAX_TOKENS_PER_CHUNK = 1200;
const OVERLAP_TOKENS = 100;
const TOKEN_CHAR = /[A-Za-z0-9$,%.-]/;

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
  return value
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
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

const WHITESPACE_RE = /\s/;

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pdfDir = options.pdfDir;

  if (!fs.existsSync(pdfDir)) {
    console.error(
      `PDF fixture directory not found: ${pdfDir}\n` +
        "Set M2_PDF_FIXTURE_DIR or pass --pdf-dir to point at the sample PDFs."
    );
    process.exit(1);
  }

  const missingFiles = [];
  const valueFailures = [];
  const formResults = [];
  const boundaryResults = [];

  printHeader("M2 PDF Quality Verification");
  console.log(`PDF directory: ${pdfDir}`);

  for (const documentFixture of fixtureConfig.documents) {
    const pdfPath = path.join(pdfDir, documentFixture.filename);
    if (!fs.existsSync(pdfPath)) {
      missingFiles.push(documentFixture.filename);
      continue;
    }

    const fileBuffer = fs.readFileSync(pdfPath);
    const { pages, pageCount } = await extractTextByPage(
      fileBuffer,
      sanitizeDocumentId(documentFixture.filename)
    );
    const cleanedPages = pages.map((page) => ({
      ...page,
      text: cleanPageText(page.text),
    }));
    const processedPages = removeRepeatedHeaders(cleanedPages);
    const chunks = chunkDocument(processedPages, documentFixture.filename);

    console.log(`\n${documentFixture.filename}`);
    console.log(
      `  page count ${pageCount}/${documentFixture.expectedPageCount}, chunks ${chunks.length}`
    );

    if (pageCount !== documentFixture.expectedPageCount) {
      valueFailures.push({
        filename: documentFixture.filename,
        label: "page count",
        expected: `${documentFixture.expectedPageCount}`,
        actual: `${pageCount}`,
      });
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
        valueFailures.push({
          filename: documentFixture.filename,
          label: assertion.label,
          expected: assertion.mustContain.join(" + "),
          actual: `no chunk for page ${assertion.page} contained every expected token`,
        });
      }
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

    boundaryResults.push(...analyzeBoundaryRisks(documentFixture.filename, processedPages));
  }

  if (missingFiles.length > 0) {
    printHeader("Missing PDFs");
    for (const filename of missingFiles) {
      console.log(`- ${filename}`);
    }
  }

  printHeader("Value Assertions");
  if (valueFailures.length === 0 && missingFiles.length === 0) {
    console.log("All page-count and value assertions passed.");
  } else {
    if (valueFailures.length === 0) {
      console.log("No assertion failures, but some sample PDFs were missing.");
    }
    for (const failure of valueFailures) {
      console.log(
        `- ${failure.filename} :: ${failure.label}\n` +
          `  expected: ${failure.expected}\n` +
          `  actual: ${failure.actual}`
      );
    }
  }

  const formMetrics = computeFormMetrics(formResults);
  const formMismatches = formResults.filter(
    (entry) => entry.expected !== entry.actual
  );

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

  const boundaryRiskCount = boundaryResults.filter(
    (result) => result.midTokenStart
  ).length;

  printHeader("Chunk Boundary Audit");
  console.log(
    `Forced-overlap starts checked: ${boundaryResults.length}\n` +
      `Mid-token starts detected: ${boundaryRiskCount}`
  );

  if (boundaryRiskCount === 0) {
    console.log("No mid-token overlap starts detected.");
  } else {
    for (const result of boundaryResults.filter((entry) => entry.midTokenStart).slice(0, 8)) {
      console.log(
        `- ${result.filename} page ${result.pageNumber} split ${result.splitIndex}\n` +
          `  context: ${result.context}`
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

  if (boundaryRiskCount > 0 && !options.enforceBoundaryClean) {
    console.log(
      "\nChunk boundary findings are report-only until you pass --enforce-boundary-clean."
    );
  }

  const shouldFail =
    missingFiles.length > 0 ||
    valueFailures.length > 0 ||
    (options.enforceFormThreshold && belowRecommendedFormThreshold) ||
    (options.enforceBoundaryClean && boundaryRiskCount > 0);

  process.exit(shouldFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
