import fs from "fs";
import path from "path";
import fixtureConfig from "./fixtures/m2-pdf-quality-fixtures.js";
import { extractStructuredPages } from "@/lib/pdf-processor";
import { cleanPageText } from "@/lib/text-cleaner";
import { chunkDocument } from "@/lib/chunker";

type Pattern = {
  key: string;
  regex: RegExp;
  description: string;
};

type PatternHit = {
  level: "review" | "hard-fail";
  scope: "page";
  pageNumber: number;
  chunkIndex: null;
  key: string;
  description: string;
  match: string;
  snippet: string;
};

const HARD_FAIL_PATTERNS: Pattern[] = [
  {
    key: "collapsed-form-1040",
    regex: /(?<!\/)Form1040\b/g,
    description: "Collapsed Form 1040 token",
  },
  {
    key: "collapsed-form-1065",
    regex: /(?<!\/)Form1065\b/g,
    description: "Collapsed Form 1065 token",
  },
  {
    key: "collapsed-page-marker",
    regex: /\bPage\d+\b/g,
    description: "Collapsed page marker",
  },
  {
    key: "collapsed-attachment-year",
    regex: /\bAttachment\d{4}\b/g,
    description: "Collapsed attachment/year marker",
  },
  {
    key: "collapsed-go-to-url",
    regex: /\bGo towww\./gi,
    description: "Collapsed 'Go to' URL prefix",
  },
  {
    key: "collapsed-signature-phrase",
    regex: /\bbothmust sign\b/gi,
    description: "Collapsed signature phrase",
  },
  {
    key: "collapsed-employer-label",
    regex: /\bbEmployer identification number\b/g,
    description: "Collapsed W-2 employer label",
  },
  {
    key: "collapsed-total-income",
    regex: /\byourtotal income\b/gi,
    description: "Collapsed 'your total income' phrase",
  },
  {
    key: "collapsed-parenthetical-keyword",
    regex: /\b(?:EIC|Information|Taxes)\((?=[A-Za-z])/g,
    description: "Collapsed keyword/parenthetical phrase",
  },
  {
    key: "collapsed-dollar-word",
    regex: /\$and\b/g,
    description: "Collapsed dollar-word join",
  },
];

const REVIEW_PATTERNS: Pattern[] = [
  {
    key: "punctuation-word-join",
    regex: /[A-Za-z0-9][?.:][A-Z][a-z]+/g,
    description: "No-space punctuation to word join",
  },
  {
    key: "numbered-label-join",
    regex: /\bNo\.\d{2}\b/g,
    description: "No-space numbered label join",
  },
  {
    key: "field-value-join",
    regex: /\b[A-Za-z]*[a-z][A-Za-z]{2,}\d{1,2}[A-Za-z]?\b/g,
    description: "No-space field/value label join",
  },
];

function normalizeWhitespace(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mergeChunkContents(previousContent: string, nextContent: string): string {
  const left = normalizeWhitespace(previousContent);
  const right = normalizeWhitespace(nextContent);

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const overlapLimit = Math.min(left.length, right.length);
  for (let overlap = overlapLimit; overlap > 0; overlap -= 1) {
    if (left.slice(-overlap) === right.slice(0, overlap)) {
      return left + right.slice(overlap);
    }
  }

  return `${left}\n${right}`;
}

function reconstructPageFromChunks(pageChunks: Array<{ content: string }>): string {
  return pageChunks.reduce((merged, chunk) => {
    if (!merged) {
      return normalizeWhitespace(chunk.content);
    }

    return mergeChunkContents(merged, chunk.content);
  }, "");
}

function groupChunksByPage(
  chunks: Array<{ pageNumber: number; chunkIndex: number; content: string }>
) {
  const byPage = new Map<
    number,
    Array<{ pageNumber: number; chunkIndex: number; content: string }>
  >();

  for (const chunk of chunks) {
    const list = byPage.get(chunk.pageNumber) || [];
    list.push(chunk);
    byPage.set(chunk.pageNumber, list);
  }

  for (const list of byPage.values()) {
    list.sort((left, right) => left.chunkIndex - right.chunkIndex);
  }

  return byPage;
}

function snippetAround(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + matchLength + 120);
  return normalizeWhitespace(text.slice(start, end));
}

function findPatternHits(text: string, patterns: Pattern[], level: "review" | "hard-fail", pageNumber: number): PatternHit[] {
  const hits: PatternHit[] = [];

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of text.matchAll(regex)) {
      const index = match.index || 0;
      hits.push({
        level,
        scope: "page",
        pageNumber,
        chunkIndex: null,
        key: pattern.key,
        description: pattern.description,
        match: match[0],
        snippet: snippetAround(text, index, match[0].length),
      });
    }
  }

  return hits;
}

async function main() {
  const pdfDir =
    process.env.M2_PDF_FIXTURE_DIR ||
    path.resolve(__dirname, "..", "..", "client_shared_pdfs");
  const output =
    process.env.M2_LOCAL_EXHAUSTIVE_REPORT ||
    path.resolve(__dirname, "..", "local-exhaustive-coverage-report.json");

  const documents = [];

  for (const fixture of fixtureConfig.documents) {
    const pdfPath = path.join(pdfDir, fixture.filename);
    const buffer = fs.readFileSync(pdfPath);
    const documentId = `local-audit-${fixture.filename
      .replace(/[^A-Za-z0-9]+/g, "-")
      .toLowerCase()}`;
    const extracted = await extractStructuredPages(buffer, documentId);
    const pages = extracted.pages.map((page) => ({
      ...page,
      text: cleanPageText(page.text),
    }));
    const chunks = chunkDocument(pages, fixture.filename);
    const byPage = groupChunksByPage(chunks);
    const hardFailures: PatternHit[] = [];
    const reviewHits: PatternHit[] = [];
    const pagesWithoutChunks: number[] = [];

    for (let pageNumber = 1; pageNumber <= extracted.pageCount; pageNumber += 1) {
      const pageChunks = byPage.get(pageNumber) || [];
      if (pageChunks.length === 0) {
        pagesWithoutChunks.push(pageNumber);
        continue;
      }

      const reconstructed = reconstructPageFromChunks(pageChunks);
      hardFailures.push(
        ...findPatternHits(reconstructed, HARD_FAIL_PATTERNS, "hard-fail", pageNumber)
      );
      reviewHits.push(
        ...findPatternHits(reconstructed, REVIEW_PATTERNS, "review", pageNumber)
      );
    }

    const hardFailureSummary: Record<string, number> = {};
    const reviewSummary: Record<string, number> = {};

    for (const hit of hardFailures) {
      hardFailureSummary[hit.key] = (hardFailureSummary[hit.key] || 0) + 1;
    }

    for (const hit of reviewHits) {
      reviewSummary[hit.key] = (reviewSummary[hit.key] || 0) + 1;
    }

    documents.push({
      filename: fixture.filename,
      pageCount: extracted.pageCount,
      chunkCount: chunks.length,
      pagesWithoutChunks,
      hardFailures,
      reviewHits,
      hardFailureSummary,
      reviewSummary,
    });
  }

  const summary = {
    totalDocuments: documents.length,
    totalPages: documents.reduce((sum, document) => sum + document.pageCount, 0),
    totalChunks: documents.reduce((sum, document) => sum + document.chunkCount, 0),
    hardFailureCount: documents.reduce(
      (sum, document) => sum + document.hardFailures.length,
      0
    ),
    reviewHitCount: documents.reduce(
      (sum, document) => sum + document.reviewHits.length,
      0
    ),
    hardFailureClasses: {} as Record<string, number>,
    reviewClasses: {} as Record<string, number>,
  };

  for (const document of documents) {
    for (const [key, value] of Object.entries(document.hardFailureSummary)) {
      summary.hardFailureClasses[key] =
        (summary.hardFailureClasses[key] || 0) + value;
    }

    for (const [key, value] of Object.entries(document.reviewSummary)) {
      summary.reviewClasses[key] = (summary.reviewClasses[key] || 0) + value;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    documents,
  };

  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
