#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");

const fixtureConfig = require("./fixtures/m2-pdf-quality-fixtures.js");

function parseArgs(argv) {
  return {
    baseUrl: process.env.M2_BASE_URL || "http://54.208.102.72",
    email: process.env.M2_EMAIL || "admin@acmetax.com",
    password: process.env.M2_PASSWORD || "FirmAdmin1!",
    pdfDir:
      process.env.M2_PDF_FIXTURE_DIR ||
      path.resolve(__dirname, "..", "..", "client_shared_pdfs"),
    output:
      process.env.M2_EXHAUSTIVE_REPORT ||
      path.resolve(__dirname, "..", "staging-exhaustive-coverage-report.json"),
    limit: Number(process.env.M2_CHUNK_LIMIT || 500),
  };
}

const HARD_FAIL_PATTERNS = [
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

const REVIEW_PATTERNS = [
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

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mergeChunkContents(previousContent, nextContent) {
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

function reconstructPageFromChunks(pageChunks) {
  return pageChunks.reduce((merged, chunk) => {
    if (!merged) {
      return normalizeWhitespace(chunk.content);
    }

    return mergeChunkContents(merged, chunk.content);
  }, "");
}

function snippetAround(text, index, matchLength) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + matchLength + 120);
  return normalizeWhitespace(text.slice(start, end));
}

function findPatternHits(text, patterns) {
  const hits = [];

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of text.matchAll(regex)) {
      const index = match.index || 0;
      hits.push({
        key: pattern.key,
        description: pattern.description,
        match: match[0],
        snippet: snippetAround(text, index, match[0].length),
      });
    }
  }

  return hits;
}

function groupChunksByPage(chunks) {
  const byPage = new Map();

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

function analyzeMetadata(documentFixture, payload) {
  const anomalies = [];
  const pagesWithoutChunks = [];
  const byPage = groupChunksByPage(payload.chunks);

  for (let pageNumber = 1; pageNumber <= payload.document.pageCount; pageNumber += 1) {
    const pageChunks = byPage.get(pageNumber) || [];
    if (pageChunks.length === 0) {
      pagesWithoutChunks.push(pageNumber);
      continue;
    }

    const firstChunk = pageChunks[0];
    const lastChunk = pageChunks[pageChunks.length - 1];

    if (!firstChunk.metadata?.coversPageStart) {
      anomalies.push({
        class: "page-start-coverage",
        pageNumber,
        expected: "coversPageStart=true on first chunk",
        actual: `chunk ${firstChunk.chunkIndex} coversPageStart=${Boolean(
          firstChunk.metadata?.coversPageStart
        )}`,
      });
    }

    if (!lastChunk.metadata?.coversPageEnd) {
      anomalies.push({
        class: "page-end-coverage",
        pageNumber,
        expected: "coversPageEnd=true on last chunk",
        actual: `chunk ${lastChunk.chunkIndex} coversPageEnd=${Boolean(
          lastChunk.metadata?.coversPageEnd
        )}`,
      });
    }

    if (pageChunks.length > 1) {
      for (let index = 0; index < pageChunks.length; index += 1) {
        const chunk = pageChunks[index];
        if (!chunk.metadata?.isPartialPage) {
          anomalies.push({
            class: "partial-page-flag",
            pageNumber,
            expected: "all multi-chunk page chunks marked partial",
            actual: `chunk ${chunk.chunkIndex} isPartialPage=${Boolean(
              chunk.metadata?.isPartialPage
            )}`,
          });
        }

        if ((chunk.metadata?.partIndex ?? null) !== index) {
          anomalies.push({
            class: "part-index-sequence",
            pageNumber,
            expected: `partIndex=${index}`,
            actual: `chunk ${chunk.chunkIndex} partIndex=${
              chunk.metadata?.partIndex ?? "null"
            }`,
          });
        }
      }
    }

    const resolvedFormType = pageChunks[0].metadata?.resolvedFormType ?? null;
    const formTypeSource = pageChunks[0].metadata?.formTypeSource ?? null;
    const formTypeOriginPage = pageChunks[0].metadata?.formTypeOriginPage ?? null;

    for (const chunk of pageChunks) {
      const publicFormType = chunk.metadata?.formType ?? null;
      if (publicFormType !== (chunk.metadata?.resolvedFormType ?? null)) {
        anomalies.push({
          class: "public-form-alias",
          pageNumber,
          expected: `${chunk.metadata?.resolvedFormType ?? "null"}`,
          actual: `chunk ${chunk.chunkIndex} public=${publicFormType ?? "null"}`,
        });
      }

      if ((chunk.metadata?.resolvedFormType ?? null) !== resolvedFormType) {
        anomalies.push({
          class: "resolved-form-consistency",
          pageNumber,
          expected: `${resolvedFormType ?? "null"}`,
          actual: `chunk ${chunk.chunkIndex} resolved=${
            chunk.metadata?.resolvedFormType ?? "null"
          }`,
        });
      }

      if ((chunk.metadata?.formTypeSource ?? null) !== formTypeSource) {
        anomalies.push({
          class: "form-source-consistency",
          pageNumber,
          expected: `${formTypeSource ?? "null"}`,
          actual: `chunk ${chunk.chunkIndex} source=${
            chunk.metadata?.formTypeSource ?? "null"
          }`,
        });
      }

      if ((chunk.metadata?.formTypeOriginPage ?? null) !== formTypeOriginPage) {
        anomalies.push({
          class: "form-origin-consistency",
          pageNumber,
          expected: `${formTypeOriginPage ?? "null"}`,
          actual: `chunk ${chunk.chunkIndex} origin=${
            chunk.metadata?.formTypeOriginPage ?? "null"
          }`,
        });
      }
    }
  }

  if (payload.document.pageCount !== documentFixture.expectedPageCount) {
    anomalies.push({
      class: "page-count",
      pageNumber: null,
      expected: `${documentFixture.expectedPageCount}`,
      actual: `${payload.document.pageCount}`,
    });
  }

  return { anomalies, pagesWithoutChunks };
}

function analyzeArtifacts(payload) {
  const byPage = groupChunksByPage(payload.chunks);
  const hardFailures = [];
  const reviewHits = [];

  for (const [pageNumber, pageChunks] of byPage.entries()) {
    const pageText = reconstructPageFromChunks(pageChunks);
    for (const hit of findPatternHits(pageText, HARD_FAIL_PATTERNS)) {
      hardFailures.push({
        level: "hard-fail",
        scope: "page",
        pageNumber,
        chunkIndex: null,
        ...hit,
      });
    }

    for (const hit of findPatternHits(pageText, REVIEW_PATTERNS)) {
      reviewHits.push({
        level: "review",
        scope: "page",
        pageNumber,
        chunkIndex: null,
        ...hit,
      });
    }

    for (const chunk of pageChunks) {
      const chunkText = normalizeWhitespace(chunk.content);
      for (const hit of findPatternHits(chunkText, HARD_FAIL_PATTERNS)) {
        hardFailures.push({
          level: "hard-fail",
          scope: "chunk",
          pageNumber,
          chunkIndex: chunk.chunkIndex,
          ...hit,
        });
      }

      for (const hit of findPatternHits(chunkText, REVIEW_PATTERNS)) {
        reviewHits.push({
          level: "review",
          scope: "chunk",
          pageNumber,
          chunkIndex: chunk.chunkIndex,
          ...hit,
        });
      }
    }
  }

  return { hardFailures, reviewHits };
}

function summarizeHits(hits) {
  const summary = {};
  for (const hit of hits) {
    summary[hit.key] = (summary[hit.key] || 0) + 1;
  }
  return summary;
}

async function login(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.get("set-cookie");
  if (!response.ok || !cookie) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`);
  }
  return cookie;
}

async function uploadPdf(baseUrl, cookie, pdfPath, filename) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([fs.readFileSync(pdfPath)], { type: "application/pdf" }),
    filename
  );

  const response = await fetch(`${baseUrl}/api/documents/upload`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `upload failed for ${filename}: ${response.status} ${JSON.stringify(payload)}`
    );
  }

  return payload.document;
}

async function fetchChunks(baseUrl, cookie, documentId, limit) {
  const response = await fetch(
    `${baseUrl}/api/documents/${documentId}?chunks=true&limit=${limit}`,
    { headers: { cookie } }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      `chunk fetch failed for ${documentId}: ${response.status} ${JSON.stringify(
        payload
      )}`
    );
  }
  return payload;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.pdfDir)) {
    throw new Error(`pdf directory not found: ${options.pdfDir}`);
  }

  const cookie = await login(options.baseUrl, options.email, options.password);
  const report = {
    baseUrl: options.baseUrl,
    generatedAt: new Date().toISOString(),
    documents: [],
    summary: {
      totalDocuments: 0,
      totalPages: 0,
      totalChunks: 0,
      hardFailureCount: 0,
      reviewHitCount: 0,
      metadataAnomalyCount: 0,
      hardFailureClasses: {},
      reviewClasses: {},
      metadataAnomalyClasses: {},
    },
  };

  for (const documentFixture of fixtureConfig.documents) {
    const pdfPath = path.join(options.pdfDir, documentFixture.filename);
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`missing pdf fixture: ${documentFixture.filename}`);
    }

    const uploaded = await uploadPdf(
      options.baseUrl,
      cookie,
      pdfPath,
      documentFixture.filename
    );
    const payload = await fetchChunks(
      options.baseUrl,
      cookie,
      uploaded.id,
      options.limit
    );

    const metadataAudit = analyzeMetadata(documentFixture, payload);
    const artifacts = analyzeArtifacts(payload);
    const byPage = groupChunksByPage(payload.chunks);
    const pagesWithMultipleChunks = [...byPage.entries()]
      .filter(([, chunks]) => chunks.length > 1)
      .map(([pageNumber, chunks]) => ({ pageNumber, chunkCount: chunks.length }));

    report.documents.push({
      filename: documentFixture.filename,
      documentId: uploaded.id,
      pageCount: payload.document.pageCount,
      chunkCount: payload.chunkTotal,
      pagesWithMultipleChunks,
      metadataAnomalies: metadataAudit.anomalies,
      pagesWithoutChunks: metadataAudit.pagesWithoutChunks,
      hardFailures: artifacts.hardFailures,
      reviewHits: artifacts.reviewHits,
      hardFailureSummary: summarizeHits(artifacts.hardFailures),
      reviewSummary: summarizeHits(artifacts.reviewHits),
      firstChunkSnippet: normalizeWhitespace(payload.chunks[0]?.content || "").slice(
        0,
        360
      ),
    });

    report.summary.totalDocuments += 1;
    report.summary.totalPages += payload.document.pageCount;
    report.summary.totalChunks += payload.chunkTotal;
    report.summary.hardFailureCount += artifacts.hardFailures.length;
    report.summary.reviewHitCount += artifacts.reviewHits.length;
    report.summary.metadataAnomalyCount += metadataAudit.anomalies.length;

    for (const anomaly of metadataAudit.anomalies) {
      report.summary.metadataAnomalyClasses[anomaly.class] =
        (report.summary.metadataAnomalyClasses[anomaly.class] || 0) + 1;
    }

    for (const hit of artifacts.hardFailures) {
      report.summary.hardFailureClasses[hit.key] =
        (report.summary.hardFailureClasses[hit.key] || 0) + 1;
    }

    for (const hit of artifacts.reviewHits) {
      report.summary.reviewClasses[hit.key] =
        (report.summary.reviewClasses[hit.key] || 0) + 1;
    }
  }

  fs.writeFileSync(options.output, JSON.stringify(report, null, 2));

  console.log("M2 staging exhaustive coverage");
  console.log(`Base URL: ${options.baseUrl}`);
  console.log(`Output: ${options.output}`);
  console.log(`Documents: ${report.summary.totalDocuments}`);
  console.log(`Pages: ${report.summary.totalPages}`);
  console.log(`Chunks: ${report.summary.totalChunks}`);
  console.log(`Metadata anomalies: ${report.summary.metadataAnomalyCount}`);
  console.log(`Hard-fail artifact hits: ${report.summary.hardFailureCount}`);
  console.log(`Review artifact hits: ${report.summary.reviewHitCount}`);

  for (const document of report.documents) {
    console.log(`\n${document.filename}`);
    console.log(`- pages=${document.pageCount}, chunks=${document.chunkCount}`);
    console.log(
      `- metadata anomalies=${document.metadataAnomalies.length}, pages without chunks=${document.pagesWithoutChunks.length}, hard-fail artifacts=${document.hardFailures.length}, review hits=${document.reviewHits.length}`
    );
    if (document.pagesWithoutChunks.length > 0) {
      console.log(`  pages without chunks :: ${document.pagesWithoutChunks.join(", ")}`);
    }
    if (document.hardFailures.length > 0) {
      const sample = document.hardFailures.slice(0, 3);
      for (const hit of sample) {
        console.log(
          `  hard-fail :: page ${hit.pageNumber}${hit.chunkIndex == null ? "" : ` chunk ${hit.chunkIndex}`}\n` +
            `    ${hit.key}: ${hit.snippet}`
        );
      }
    }
    if (document.reviewHits.length > 0) {
      const sample = document.reviewHits.slice(0, 3);
      for (const hit of sample) {
        console.log(
          `  review :: page ${hit.pageNumber}${hit.chunkIndex == null ? "" : ` chunk ${hit.chunkIndex}`}\n` +
            `    ${hit.key}: ${hit.snippet}`
        );
      }
    }
  }

  const shouldFail =
    report.summary.metadataAnomalyCount > 0 || report.summary.hardFailureCount > 0;
  process.exit(shouldFail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
