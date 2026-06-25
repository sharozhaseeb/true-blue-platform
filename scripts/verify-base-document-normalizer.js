#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const defaultFixtureFolders = [
  path.join(
    repoRoot,
    "scripts",
    "fixtures",
    "textract-base-document",
    "redacted-mini"
  ),
  path.join(
    repoRoot,
    "scripts",
    "fixtures",
    "textract-base-document",
    "redacted-multipage"
  ),
];

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

const { textractFixtureBaseDocumentSource } = require(path.join(
  repoRoot,
  "src/lib/base-document-source.ts"
));
const { chunkBaseDocument } = require(path.join(
  repoRoot,
  "src/lib/base-document-chunker.ts"
));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : null;
}

function chunkNumber(filename) {
  const match = filename.match(/page-(\d+)\.json$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function getInputFolders() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (args.length > 0) {
    return args;
  }

  if (process.env.TEXTRACT_FIXTURE_DIRS) {
    return process.env.TEXTRACT_FIXTURE_DIRS.split(path.delimiter).filter(Boolean);
  }

  return defaultFixtureFolders;
}

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function validateBaseDocument(baseDocument, expectedSummary) {
  const failures = [];
  const summary = baseDocument.summary;

  assertCondition(baseDocument.schemaVersion === "base-document-v1", "invalid schemaVersion", failures);
  assertCondition(baseDocument.provider === "aws-textract", "invalid provider", failures);
  assertCondition(baseDocument.pages.length > 0, "no pages normalized", failures);
  assertCondition(summary.lineCount > 0, "no lines normalized", failures);
  assertCondition(summary.fieldCount > 0, "no fields normalized", failures);
  assertCondition(summary.tableCount > 0, "no tables normalized", failures);

  if (expectedSummary.pageCount) {
    assertCondition(
      summary.pageCount === expectedSummary.pageCount,
      `page count mismatch: expected ${expectedSummary.pageCount}, got ${summary.pageCount}`,
      failures
    );
  }

  if (expectedSummary.blockCount) {
    assertCondition(
      summary.rawBlockCount === expectedSummary.blockCount,
      `raw block count mismatch: expected ${expectedSummary.blockCount}, got ${summary.rawBlockCount}`,
      failures
    );
  }

  for (const page of baseDocument.pages) {
    assertCondition(
      page.sourceBlockIds.length > 0,
      `page ${page.pageNumber} is missing PAGE provenance`,
      failures
    );
    assertCondition(
      page.lines.length > 0,
      `page ${page.pageNumber} has no lines`,
      failures
    );

    for (const line of page.lines) {
      assertCondition(
        line.sourceBlockIds.length > 0,
        `line ${line.id} is missing source provenance`,
        failures
      );
    }

    for (const field of page.fields) {
      assertCondition(
        field.sourceBlockIds.length > 0,
        `field ${field.id} is missing source provenance`,
        failures
      );
      assertCondition(
        Boolean(field.label || field.value || field.selectionStatus),
        `field ${field.id} has no normalized label/value/selection`,
        failures
      );
    }

    for (const table of page.tables) {
      assertCondition(
        table.sourceBlockIds.length > 0,
        `table ${table.id} is missing source provenance`,
        failures
      );

      for (const cell of table.cells) {
        assertCondition(
          cell.rowIndex > 0 && cell.columnIndex > 0,
          `table cell ${cell.id} has invalid row/column indexes`,
          failures
        );
        assertCondition(
          cell.sourceBlockIds.length > 0,
          `table cell ${cell.id} is missing source provenance`,
          failures
        );
      }

      for (const mergedCell of table.mergedCells || []) {
        assertCondition(
          mergedCell.rowIndex > 0 && mergedCell.columnIndex > 0,
          `merged cell ${mergedCell.id} has invalid row/column indexes`,
          failures
        );
        assertCondition(
          mergedCell.sourceBlockIds.length > 0,
          `merged cell ${mergedCell.id} is missing source provenance`,
          failures
        );
        assertCondition(
          mergedCell.childCellSourceBlockIds.length > 0,
          `merged cell ${mergedCell.id} is missing child cell relationships`,
          failures
        );
      }
    }

    for (const selectionMark of page.selectionMarks) {
      assertCondition(
        selectionMark.status !== "UNKNOWN",
        `selection mark ${selectionMark.id} has unknown status`,
        failures
      );
      assertCondition(
        selectionMark.sourceBlockIds.length > 0,
        `selection mark ${selectionMark.id} is missing source provenance`,
        failures
      );
    }
  }

  return failures;
}

function validateRedactedMiniFixture(baseDocument) {
  const failures = [];
  const page = baseDocument.pages[0];
  const table = page?.tables[0];
  const field = page?.fields[0];
  const selectionMark = page?.selectionMarks[0];
  const layout = page?.layout[0];
  const mergedCell = table?.mergedCells[0];

  assertCondition(baseDocument.summary.warnings.length === 0, "redacted fixture should have zero warnings", failures);
  assertCondition(baseDocument.summary.lineCount === 1, "redacted fixture line count changed", failures);
  assertCondition(baseDocument.summary.fieldCount === 1, "redacted fixture field count changed", failures);
  assertCondition(baseDocument.summary.tableCount === 1, "redacted fixture table count changed", failures);
  assertCondition(baseDocument.summary.tableCellCount === 2, "redacted fixture table cell count changed", failures);
  assertCondition(baseDocument.summary.selectionMarkCount === 1, "redacted fixture selection mark count changed", failures);
  assertCondition(baseDocument.summary.layoutObjectCount === 1, "redacted fixture layout count changed", failures);

  assertCondition(field?.label === "Filing status", "redacted fixture field label changed", failures);
  assertCondition(field?.value === "Single", "redacted fixture field value changed", failures);
  assertCondition(Boolean(field?.keyGeometry), "redacted fixture field key geometry missing", failures);
  assertCondition(Boolean(field?.valueGeometry), "redacted fixture field value geometry missing", failures);

  assertCondition(table?.title === "Income Summary", "redacted fixture table title changed", failures);
  assertCondition(table?.footer === "All values redacted", "redacted fixture table footer changed", failures);
  assertCondition(Boolean(table?.geometry), "redacted fixture table geometry missing", failures);
  assertCondition(
    Boolean(table?.sourceBlockIds.includes("table-title-1")),
    "redacted fixture table title provenance missing",
    failures
  );
  assertCondition(
    Boolean(table?.sourceBlockIds.includes("table-footer-1")),
    "redacted fixture table footer provenance missing",
    failures
  );

  assertCondition(table?.mergedCells.length === 1, "redacted fixture merged cell count changed", failures);
  assertCondition(mergedCell?.rowIndex === 1, "redacted fixture merged cell row changed", failures);
  assertCondition(mergedCell?.columnIndex === 1, "redacted fixture merged cell column changed", failures);
  assertCondition(mergedCell?.rowSpan === 1, "redacted fixture merged cell row span changed", failures);
  assertCondition(mergedCell?.columnSpan === 2, "redacted fixture merged cell column span changed", failures);
  assertCondition(
    mergedCell?.text === "Wages REDACTED_AMOUNT",
    "redacted fixture merged cell text changed",
    failures
  );
  assertCondition(
    Boolean(mergedCell?.childCellSourceBlockIds.includes("cell-1")),
    "redacted fixture merged cell child cell-1 missing",
    failures
  );
  assertCondition(
    Boolean(mergedCell?.childCellSourceBlockIds.includes("cell-2")),
    "redacted fixture merged cell child cell-2 missing",
    failures
  );
  assertCondition(Boolean(mergedCell?.geometry), "redacted fixture merged cell geometry missing", failures);

  assertCondition(
    selectionMark?.status === "NOT_SELECTED",
    "redacted fixture selection status changed",
    failures
  );
  assertCondition(Boolean(selectionMark?.geometry), "redacted fixture selection geometry missing", failures);

  assertCondition(layout?.layoutType === "LAYOUT_TITLE", "redacted fixture layout type changed", failures);
  assertCondition(
    layout?.text === "Form 1040 Redacted Sample",
    "redacted fixture layout text changed",
    failures
  );
  assertCondition(Boolean(layout?.geometry), "redacted fixture layout geometry missing", failures);

  return failures;
}

function validateRetrievalChunks(baseDocument, artifact) {
  const failures = [];
  const chunks = chunkBaseDocument(baseDocument, {
    documentId: artifact.documentId,
    firmId: artifact.firmId || "fixture-firm",
    baseArtifactId: artifact.id,
    vectorGeneration: artifact.generation,
  });

  assertCondition(
    artifact.status === "READY_FOR_INDEXING",
    "artifact is not READY_FOR_INDEXING after local validation",
    failures
  );
  assertCondition(
    artifact.parserVersion === baseDocument.parserVersion,
    "artifact parserVersion does not match BaseDocument",
    failures
  );
  assertCondition(
    JSON.stringify(artifact.featureSet) === JSON.stringify(baseDocument.featureSet),
    "artifact featureSet does not match BaseDocument",
    failures
  );

  assertCondition(chunks.length > 0, "no BaseDocument retrieval chunks produced", failures);

  for (const chunk of chunks) {
    assertCondition(chunk.baseArtifactId === artifact.id, `chunk ${chunk.chunkId} has wrong artifact ID`, failures);
    assertCondition(chunk.vectorGeneration === artifact.generation, `chunk ${chunk.chunkId} has wrong vector generation`, failures);
    assertCondition(chunk.sourceBlockIds.length > 0, `chunk ${chunk.chunkId} has no source block provenance`, failures);
    assertCondition(Boolean(chunk.content), `chunk ${chunk.chunkId} has empty content`, failures);
    assertCondition(chunk.parserVersion === baseDocument.parserVersion, `chunk ${chunk.chunkId} has wrong parser version`, failures);
    assertCondition(Boolean(chunk.chunkStrategy), `chunk ${chunk.chunkId} has no chunk strategy`, failures);
    assertCondition(chunk.pageStart > 0 && chunk.pageEnd >= chunk.pageStart, `chunk ${chunk.chunkId} has invalid page span`, failures);
  }

  const tableChunks = chunks.filter((chunk) => chunk.contentType === "table");
  const fieldChunks = chunks.filter((chunk) => chunk.contentType === "field_group");
  const layoutChunks = chunks.filter((chunk) => chunk.contentType === "mixed");
  const proseChunks = chunks.filter((chunk) => chunk.contentType === "prose");

  if (baseDocument.summary.tableCount > 0) {
    assertCondition(tableChunks.length > 0, "document has tables but no table chunks", failures);
    assertCondition(
      tableChunks.every((chunk) => Boolean(chunk.tableId)),
      "one or more table chunks are missing tableId",
      failures
    );
  }

  for (const page of baseDocument.pages) {
    const pageProseChunks = proseChunks.filter(
      (chunk) => chunk.pageStart === page.pageNumber && chunk.pageEnd === page.pageNumber
    );
    const pageFieldChunks = fieldChunks.filter(
      (chunk) => chunk.pageStart === page.pageNumber && chunk.pageEnd === page.pageNumber
    );
    const pageLayoutChunks = layoutChunks.filter(
      (chunk) =>
        chunk.pageStart === page.pageNumber &&
        chunk.pageEnd === page.pageNumber &&
        chunk.sectionPath === `page/${page.pageNumber}/layout`
    );

    if (page.lines.length > 0) {
      assertCondition(pageProseChunks.length > 0, `page ${page.pageNumber} has lines but no prose chunk`, failures);
    }

    if (page.fields.length > 0) {
      assertCondition(pageFieldChunks.length > 0, `page ${page.pageNumber} has fields but no field_group chunk`, failures);
    }

    if (page.layout.length > 0) {
      assertCondition(pageLayoutChunks.length > 0, `page ${page.pageNumber} has layout but no layout chunk`, failures);
    }

    for (const lineSourceBlockId of page.lines.flatMap((line) => line.sourceBlockIds)) {
      assertCondition(
        pageProseChunks.some((chunk) => chunk.sourceBlockIds.includes(lineSourceBlockId)),
        `line source block ${lineSourceBlockId} is missing from page ${page.pageNumber} prose chunks`,
        failures
      );
    }

    for (const fieldSourceBlockId of page.fields.flatMap((field) => field.sourceBlockIds)) {
      assertCondition(
        pageFieldChunks.some((chunk) => chunk.sourceBlockIds.includes(fieldSourceBlockId)),
        `field source block ${fieldSourceBlockId} is missing from page ${page.pageNumber} field chunks`,
        failures
      );
    }

    for (const layoutSourceBlockId of page.layout.flatMap((layout) => layout.sourceBlockIds)) {
      assertCondition(
        pageLayoutChunks.some((chunk) => chunk.sourceBlockIds.includes(layoutSourceBlockId)),
        `layout source block ${layoutSourceBlockId} is missing from page ${page.pageNumber} layout chunks`,
        failures
      );
    }

    for (const table of page.tables) {
      const matchingTableChunks = tableChunks.filter((chunk) => chunk.tableId === table.id);
      assertCondition(matchingTableChunks.length > 0, `table ${table.id} has no table chunk`, failures);

      for (const tableSourceBlockId of table.sourceBlockIds) {
        assertCondition(
          matchingTableChunks.some((chunk) => chunk.sourceBlockIds.includes(tableSourceBlockId)),
          `table source block ${tableSourceBlockId} is missing from table ${table.id} chunks`,
          failures
        );
      }
    }
  }

  return failures;
}

async function normalizeFolder(folderPath, outputRoot) {
  const summaryPath = path.join(folderPath, "summary.json");
  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : {};
  const jobId = readTextIfExists(path.join(folderPath, "job-id.txt")) || summary.jobId || null;
  const responseFiles = fs
    .readdirSync(folderPath)
    .filter((filename) => /^page-\d+\.json$/.test(filename))
    .sort((left, right) => chunkNumber(left) - chunkNumber(right));

  if (responseFiles.length === 0) {
    throw new Error(`No Textract page-*.json files found in ${folderPath}`);
  }

  const responses = responseFiles.map((filename) =>
    readJson(path.join(folderPath, filename))
  );
  const safeName = String(summary.pdf || path.basename(folderPath))
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const artifact = await textractFixtureBaseDocumentSource.load({
    artifactId: `fixture-${safeName || path.basename(folderPath)}`,
    documentId: `document-${safeName || path.basename(folderPath)}`,
    firmId: "fixture-firm",
    generation: 1,
    responses,
    providerJobId: jobId,
    sourceFilename: summary.pdf || path.basename(folderPath),
    expectedPageCount: summary.pageCount || null,
    featureSet: ["FORMS", "TABLES", "LAYOUT"],
  });
  const baseDocument = artifact.baseDocument;
  const failures = validateBaseDocument(baseDocument, summary);
  failures.push(...validateRetrievalChunks(baseDocument, artifact));
  if (path.basename(folderPath) === "redacted-mini") {
    failures.push(...validateRedactedMiniFixture(baseDocument));
  }
  const outputPath = path.join(outputRoot, `${safeName || "document"}.base-document.json`);

  fs.writeFileSync(outputPath, JSON.stringify(baseDocument, null, 2));

  return {
    folderPath,
    outputPath,
    failures,
    summary: baseDocument.summary,
  };
}

async function main() {
  const outputRoot = path.join(
    repoRoot,
    `base-document-output-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  fs.mkdirSync(outputRoot, { recursive: true });

  const results = await Promise.all(
    getInputFolders().map((folderPath) => normalizeFolder(folderPath, outputRoot))
  );
  const failedResults = results.filter((result) => result.failures.length > 0);

  for (const result of results) {
    const summary = result.summary;
    console.log(
      [
        path.basename(result.folderPath),
        `pages=${summary.pageCount}`,
        `blocks=${summary.rawBlockCount}`,
        `lines=${summary.lineCount}`,
        `fields=${summary.fieldCount}`,
        `tables=${summary.tableCount}`,
        `cells=${summary.tableCellCount}`,
        `selectionMarks=${summary.selectionMarkCount}`,
        `layout=${summary.layoutObjectCount}`,
        `warnings=${summary.warnings.length}`,
      ].join(" ")
    );

    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        console.error(`  FAIL ${failure}`);
      }
    }
  }

  console.log(`Wrote normalized BaseDocument outputs to ${outputRoot}`);

  if (failedResults.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
