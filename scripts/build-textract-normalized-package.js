const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_DIR = path.join(
  WORKSPACE_ROOT,
  "textract-client-evidence-pdf-pages-20260509"
);
const OUTPUT_DIR = path.join(
  WORKSPACE_ROOT,
  "textract-client-evidence-normalized-20260509"
);

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EIN_RE = /\b\d{2}-\d{7}\b/g;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function round(value) {
  return typeof value === "number" ? Number(value.toFixed(6)) : value;
}

function normalizeBox(geometry) {
  const box = geometry && geometry.BoundingBox ? geometry.BoundingBox : {};
  return {
    left: round(box.Left ?? 0),
    top: round(box.Top ?? 0),
    width: round(box.Width ?? 0),
    height: round(box.Height ?? 0),
  };
}

function getRelationshipIds(block, type) {
  const relationships = Array.isArray(block.Relationships)
    ? block.Relationships
    : [];
  const relationship = relationships.find((item) => item.Type === type);
  return relationship && Array.isArray(relationship.Ids) ? relationship.Ids : [];
}

function childBlocks(block, blocksById, type) {
  return getRelationshipIds(block, type)
    .map((id) => blocksById.get(id))
    .filter(Boolean);
}

function blockText(block, blocksById) {
  if (!block) return "";
  if (block.Text) return block.Text;

  const children = childBlocks(block, blocksById, "CHILD");
  const parts = [];

  for (const child of children) {
    if (child.BlockType === "WORD" && child.Text) {
      parts.push(child.Text);
    }

    if (child.BlockType === "SELECTION_ELEMENT") {
      parts.push(`[${child.SelectionStatus || "UNKNOWN"}]`);
    }
  }

  return parts.join(" ").trim();
}

function meanConfidence(blocks) {
  const values = blocks
    .map((block) => block.Confidence)
    .filter((value) => typeof value === "number");

  if (values.length === 0) return null;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return round(avg);
}

function redactString(value) {
  return value.replace(SSN_RE, "[REDACTED-SSN]").replace(EIN_RE, "[REDACTED-EIN]");
}

function redactValue(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, redactValue(entryValue)])
    );
  }
  return value;
}

function normalizeKeyValueBlocks(blocks, blocksById, pageNumber) {
  return blocks
    .filter(
      (block) =>
        block.BlockType === "KEY_VALUE_SET" &&
        Array.isArray(block.EntityTypes) &&
        block.EntityTypes.includes("KEY")
    )
    .map((keyBlock) => {
      const valueBlock = childBlocks(keyBlock, blocksById, "VALUE")[0] || null;
      const keyChildren = childBlocks(keyBlock, blocksById, "CHILD");
      const valueChildren = valueBlock ? childBlocks(valueBlock, blocksById, "CHILD") : [];
      const valueSelection = valueChildren.find(
        (child) => child.BlockType === "SELECTION_ELEMENT"
      );
      const valueText = blockText(valueBlock, blocksById);

      return {
        pageNumber,
        label: blockText(keyBlock, blocksById),
        value: valueSelection
          ? `[${valueSelection.SelectionStatus || "UNKNOWN"}]`
          : valueText,
        confidence: meanConfidence([
          keyBlock,
          ...(valueBlock ? [valueBlock] : []),
          ...keyChildren,
          ...valueChildren,
        ]),
        boundingBox: normalizeBox(keyBlock.Geometry),
        valueBoundingBox: valueBlock ? normalizeBox(valueBlock.Geometry) : null,
        textract: {
          keyBlockId: keyBlock.Id,
          valueBlockId: valueBlock ? valueBlock.Id : null,
        },
      };
    })
    .filter((field) => field.label || field.value);
}

function normalizeSelectionMarks(blocks, blocksById, pageNumber) {
  const keyValueSelections = new Set();
  for (const block of blocks) {
    if (block.BlockType !== "KEY_VALUE_SET") continue;
    for (const child of childBlocks(block, blocksById, "CHILD")) {
      if (child.BlockType === "SELECTION_ELEMENT") {
        keyValueSelections.add(child.Id);
      }
    }
  }

  return blocks
    .filter(
      (block) =>
        block.BlockType === "SELECTION_ELEMENT" &&
        !keyValueSelections.has(block.Id)
    )
    .map((block) => ({
      pageNumber,
      selected: block.SelectionStatus === "SELECTED",
      status: block.SelectionStatus || "UNKNOWN",
      confidence: round(block.Confidence),
      boundingBox: normalizeBox(block.Geometry),
      textract: {
        blockId: block.Id,
      },
    }));
}

function normalizeTables(blocks, blocksById, pageNumber) {
  return blocks
    .filter((block) => block.BlockType === "TABLE")
    .map((tableBlock, tableIndex) => {
      const cells = childBlocks(tableBlock, blocksById, "CHILD")
        .filter((block) => block.BlockType === "CELL")
        .map((cell) => ({
          rowIndex: cell.RowIndex,
          columnIndex: cell.ColumnIndex,
          rowSpan: cell.RowSpan || 1,
          columnSpan: cell.ColumnSpan || 1,
          text: blockText(cell, blocksById),
          confidence: round(cell.Confidence),
          boundingBox: normalizeBox(cell.Geometry),
          textract: {
            blockId: cell.Id,
          },
        }))
        .sort((left, right) => {
          if (left.rowIndex !== right.rowIndex) return left.rowIndex - right.rowIndex;
          return left.columnIndex - right.columnIndex;
        });

      const rowCount = cells.reduce(
        (max, cell) => Math.max(max, cell.rowIndex || 0),
        0
      );
      const columnCount = cells.reduce(
        (max, cell) => Math.max(max, cell.columnIndex || 0),
        0
      );

      return {
        pageNumber,
        tableIndex,
        rowCount,
        columnCount,
        confidence: round(tableBlock.Confidence),
        boundingBox: normalizeBox(tableBlock.Geometry),
        cells,
        textract: {
          tableBlockId: tableBlock.Id,
        },
      };
    });
}

function normalizePage(pageJson) {
  const blocks = Array.isArray(pageJson.blocks) ? pageJson.blocks : [];
  const blocksById = new Map(blocks.map((block) => [block.Id, block]));
  const pageNumber = pageJson.pageNumber;
  const lines = blocks
    .filter((block) => block.BlockType === "LINE")
    .map((block) => ({
      pageNumber,
      text: block.Text || "",
      confidence: round(block.Confidence),
      boundingBox: normalizeBox(block.Geometry),
      textract: {
        blockId: block.Id,
      },
    }));

  const fields = normalizeKeyValueBlocks(blocks, blocksById, pageNumber);
  const tables = normalizeTables(blocks, blocksById, pageNumber);
  const selectionMarks = normalizeSelectionMarks(blocks, blocksById, pageNumber);

  return {
    pageNumber,
    sourcePdf: pageJson.sourcePdf,
    provider: pageJson.provider,
    rawBlockCount: pageJson.blockCount,
    blockTypeCounts: pageJson.blockTypeCounts,
    textPreview: lines
      .slice(0, 20)
      .map((line) => line.text)
      .join("\n"),
    lines,
    fields,
    tables,
    selectionMarks,
  };
}

function summarizeDocument(folderName, summary, pages) {
  const fields = pages.flatMap((page) => page.fields);
  const tables = pages.flatMap((page) => page.tables);
  const selectionMarks = pages.flatMap((page) => page.selectionMarks);

  return {
    documentId: folderName,
    sourcePdf: summary.pdf,
    provider: "aws-textract",
    region: summary.region || "us-east-1",
    pageCount: summary.pageCount,
    rawBlockCount: summary.blockCount,
    averageConfidence: summary.confidence ? summary.confidence.avg : null,
    counts: {
      pages: pages.length,
      fields: fields.length,
      tables: tables.length,
      tableCells: tables.reduce((sum, table) => sum + table.cells.length, 0),
      selectionMarks: selectionMarks.length,
      lines: pages.reduce((sum, page) => sum + page.lines.length, 0),
    },
    sampleFields: fields.slice(0, 25),
    sampleTables: tables.slice(0, 3).map((table) => ({
      pageNumber: table.pageNumber,
      tableIndex: table.tableIndex,
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      confidence: table.confidence,
      boundingBox: table.boundingBox,
      sampleCells: table.cells.slice(0, 12),
    })),
    sampleSelectionMarks: selectionMarks.slice(0, 25),
  };
}

function buildPackage() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Missing source directory: ${SOURCE_DIR}`);
  }

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const sourceManifest = readJson(path.join(SOURCE_DIR, "manifest.json"));
  const outputManifest = [];

  for (const entry of sourceManifest) {
    const sourceFolder = path.join(SOURCE_DIR, entry.folder);
    const targetFolder = path.join(OUTPUT_DIR, entry.folder);
    const rawTargetFolder = path.join(targetFolder, "raw-textract-pages");
    const pageTargetFolder = path.join(targetFolder, "normalized-pages");
    const summary = readJson(path.join(sourceFolder, "summary.json"));
    const pageFiles = fs
      .readdirSync(sourceFolder)
      .filter((name) => /^pdf-page-\d+\.json$/.test(name))
      .sort();
    const pages = [];

    fs.mkdirSync(rawTargetFolder, { recursive: true });
    fs.mkdirSync(pageTargetFolder, { recursive: true });
    copyFile(path.join(sourceFolder, "summary.json"), path.join(targetFolder, "textract-summary.json"));

    for (const pageFile of pageFiles) {
      const sourcePagePath = path.join(sourceFolder, pageFile);
      const page = normalizePage(readJson(sourcePagePath));
      const pageName = pageFile.replace("pdf-page-", "page-").replace(".json", ".normalized.json");
      pages.push(page);
      writeJson(path.join(pageTargetFolder, pageName), page);
      writeJson(path.join(pageTargetFolder, pageName.replace(".json", ".redacted.json")), redactValue(page));
      copyFile(sourcePagePath, path.join(rawTargetFolder, pageFile));
    }

    const normalizedDocument = {
      document: summarizeDocument(entry.folder, summary, pages),
      pages,
    };
    const redactedDocument = redactValue(normalizedDocument);
    writeJson(path.join(targetFolder, "normalized-document.json"), normalizedDocument);
    writeJson(path.join(targetFolder, "normalized-document-redacted.json"), redactedDocument);

    outputManifest.push({
      folder: entry.folder,
      pdf: entry.pdf,
      pageCount: entry.pageCount,
      rawBlockCount: entry.blockCount,
      normalizedFiles: {
        full: `${entry.folder}/normalized-document.json`,
        redacted: `${entry.folder}/normalized-document-redacted.json`,
        pages: `${entry.folder}/normalized-pages/`,
        rawTextractPages: `${entry.folder}/raw-textract-pages/`,
      },
      counts: normalizedDocument.document.counts,
      averageConfidence: normalizedDocument.document.averageConfidence,
    });
  }

  const readme = `# Textract Evidence Package With Normalized JSON

Generated from the existing AWS Textract page-level output.

## How to review

- Start with \`manifest.json\` for the document list and counts.
- Open \`<document>/normalized-document-redacted.json\` for a client-friendly view with SSN/EIN-like values redacted.
- Open \`<document>/normalized-document.json\` for the same normalized structure with the original sample values.
- Open \`<document>/normalized-pages/page-###.normalized.json\` to inspect one page at a time.
- Raw AWS Textract page JSON is included under \`<document>/raw-textract-pages/\` for engineering reference.

## Normalized shape

Each normalized document includes:

- \`document.counts\`: field, table, selection-mark, line, and page totals
- \`document.sampleFields\`: sample key-value pairs
- \`document.sampleTables\`: sample table summaries and cells
- \`document.sampleSelectionMarks\`: sample checkbox / selection elements
- \`pages[].lines\`: readable text lines with page number, confidence, and bounding boxes
- \`pages[].fields\`: key-value relationships with confidence and bounding boxes
- \`pages[].tables[].cells\`: table cell structure with row/column coordinates
- \`pages[].selectionMarks\`: selected / not-selected marks with bounding boxes

## Important caveat

The normalized JSON is a review artifact. It demonstrates the product-facing API shape we could build on top of Textract. It is not the raw Textract response, and it is not yet wired into the True Blue application pipeline.
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, "README.md"), readme, "utf8");
  writeJson(path.join(OUTPUT_DIR, "manifest.json"), outputManifest);
}

buildPackage();
