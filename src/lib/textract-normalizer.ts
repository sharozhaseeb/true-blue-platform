import type {
  BaseDocument,
  BaseDocumentField,
  BaseDocumentGeometry,
  BaseDocumentLayoutObject,
  BaseDocumentLine,
  BaseDocumentMergedCell,
  BaseDocumentPage,
  BaseDocumentSelectionMark,
  BaseDocumentSelectionStatus,
  BaseDocumentTable,
  BaseDocumentTableCell,
} from "@/lib/base-document";

export const TEXTRACT_BASE_DOCUMENT_PARSER_VERSION = "textract-base-v1";

type TextractRelationship = {
  Type?: unknown;
  Ids?: unknown;
};

type TextractBlock = {
  Id?: unknown;
  BlockType?: unknown;
  Text?: unknown;
  Confidence?: unknown;
  Page?: unknown;
  Geometry?: unknown;
  Relationships?: unknown;
  EntityTypes?: unknown;
  SelectionStatus?: unknown;
  RowIndex?: unknown;
  ColumnIndex?: unknown;
  RowSpan?: unknown;
  ColumnSpan?: unknown;
};

export type TextractAnalysisResponse = {
  Blocks?: unknown;
  DocumentMetadata?: {
    Pages?: unknown;
  };
};

export interface NormalizeTextractAnalysisInput {
  responses: TextractAnalysisResponse[];
  providerJobId?: string | null;
  sourceFilename?: string | null;
  expectedPageCount?: number | null;
  featureSet?: string[];
}

interface BlockIndex {
  byId: Map<string, TextractBlock>;
  byPage: Map<number, TextractBlock[]>;
  warnings: string[];
  rawBlockCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asInteger(value: unknown, fallback: number): number {
  const numberValue = asNumber(value);
  return numberValue === null ? fallback : Math.trunc(numberValue);
}

function getBlockId(block: TextractBlock): string | null {
  return asString(block.Id);
}

function getBlockType(block: TextractBlock): string | null {
  return asString(block.BlockType);
}

function getBlockPage(block: TextractBlock): number | null {
  const page = asNumber(block.Page);
  return page === null || page <= 0 ? null : Math.trunc(page);
}

function getConfidence(block: TextractBlock): number | null {
  return asNumber(block.Confidence);
}

function getRelationships(block: TextractBlock, type: string): string[] {
  if (!Array.isArray(block.Relationships)) {
    return [];
  }

  return block.Relationships.flatMap((relationship: TextractRelationship) => {
    if (!isRecord(relationship) || relationship.Type !== type) {
      return [];
    }

    if (!Array.isArray(relationship.Ids)) {
      return [];
    }

    return relationship.Ids.filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
  });
}

function hasEntityType(block: TextractBlock, entityType: string): boolean {
  return (
    Array.isArray(block.EntityTypes) &&
    block.EntityTypes.some((value) => value === entityType)
  );
}

function normalizeGeometry(value: unknown): BaseDocumentGeometry | null {
  if (!isRecord(value) || !isRecord(value.BoundingBox)) {
    return null;
  }

  const box = value.BoundingBox;
  const left = asNumber(box.Left);
  const top = asNumber(box.Top);
  const width = asNumber(box.Width);
  const height = asNumber(box.Height);

  if (left === null || top === null || width === null || height === null) {
    return null;
  }

  const polygon = Array.isArray(value.Polygon)
    ? value.Polygon
        .filter(isRecord)
        .map((point) => ({
          x: asNumber(point.X) ?? 0,
          y: asNumber(point.Y) ?? 0,
        }))
    : undefined;

  return {
    left,
    top,
    width,
    height,
    rotation: asNumber(value.RotationAngle),
    ...(polygon && polygon.length > 0 ? { polygon } : {}),
  };
}

function normalizeBlockGeometry(
  block: TextractBlock,
  index: BlockIndex,
  context: string
): BaseDocumentGeometry | null {
  const geometry = normalizeGeometry(block.Geometry);
  if (!geometry) {
    index.warnings.push(`${context} is missing valid geometry.`);
  }

  return geometry;
}

function requireBlockId(
  block: TextractBlock,
  index: BlockIndex,
  context: string
): string | null {
  const id = getBlockId(block);
  if (!id) {
    index.warnings.push(`${context} is missing provider block ID and was skipped.`);
    return null;
  }

  return id;
}

function textFromBlock(block: TextractBlock): string {
  const blockType = getBlockType(block);

  if (blockType === "SELECTION_ELEMENT") {
    return normalizeSelectionStatus(block.SelectionStatus);
  }

  return asString(block.Text) ?? "";
}

function normalizeSelectionStatus(value: unknown): BaseDocumentSelectionStatus {
  if (value === "SELECTED" || value === "NOT_SELECTED") {
    return value;
  }

  return "UNKNOWN";
}

function renderChildText(block: TextractBlock, index: BlockIndex): string {
  return getRelationships(block, "CHILD")
    .map((id) => index.byId.get(id))
    .filter((child): child is TextractBlock => Boolean(child))
    .map((child) => textFromBlock(child) || renderChildText(child, index))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceIdsForBlock(block: TextractBlock, index: BlockIndex): string[] {
  const ids = new Set<string>();
  const blockId = getBlockId(block);

  if (blockId) {
    ids.add(blockId);
  }

  for (const childId of getRelationships(block, "CHILD")) {
    ids.add(childId);
  }

  for (const valueId of getRelationships(block, "VALUE")) {
    ids.add(valueId);
    const valueBlock = index.byId.get(valueId);
    if (valueBlock) {
      for (const childId of getRelationships(valueBlock, "CHILD")) {
        ids.add(childId);
      }
    }
  }

  return [...ids];
}

function buildBlockIndex(responses: TextractAnalysisResponse[]): BlockIndex {
  const byId = new Map<string, TextractBlock>();
  const byPage = new Map<number, TextractBlock[]>();
  const warnings: string[] = [];
  let rawBlockCount = 0;

  for (const response of responses) {
    if (!Array.isArray(response.Blocks)) {
      warnings.push("Textract response did not contain a Blocks array.");
      continue;
    }

    for (const rawBlock of response.Blocks) {
      rawBlockCount += 1;
      if (!isRecord(rawBlock)) {
        warnings.push("Ignored non-object Textract block.");
        continue;
      }

      const block = rawBlock as TextractBlock;
      const blockId = getBlockId(block);
      const blockType = getBlockType(block);

      if (!blockType) {
        warnings.push(`Ignored Textract block without BlockType: ${blockId ?? "unknown-id"}.`);
        continue;
      }

      if (blockId) {
        byId.set(blockId, block);
      }

      const page = getBlockPage(block);
      if (page !== null) {
        const pageBlocks = byPage.get(page) ?? [];
        pageBlocks.push(block);
        byPage.set(page, pageBlocks);
      }
    }
  }

  return { byId, byPage, warnings, rawBlockCount };
}

function sortByPagePosition<T extends { geometry: BaseDocumentGeometry | null; id: string }>(
  left: T,
  right: T
): number {
  const leftGeometry = left.geometry;
  const rightGeometry = right.geometry;

  if (leftGeometry && rightGeometry) {
    if (Math.abs(leftGeometry.top - rightGeometry.top) > 0.0001) {
      return leftGeometry.top - rightGeometry.top;
    }

    if (Math.abs(leftGeometry.left - rightGeometry.left) > 0.0001) {
      return leftGeometry.left - rightGeometry.left;
    }
  }

  return left.id.localeCompare(right.id);
}

function normalizeLines(
  pageNumber: number,
  blocks: TextractBlock[],
  index: BlockIndex
): BaseDocumentLine[] {
  return blocks
    .filter((block) => getBlockType(block) === "LINE")
    .flatMap((block) => {
      const id = requireBlockId(block, index, `LINE on page ${pageNumber}`);
      if (!id) {
        return [];
      }

      return [{
        id,
        pageNumber,
        text: textFromBlock(block),
        confidence: getConfidence(block),
        geometry: normalizeBlockGeometry(block, index, `LINE ${id}`),
        sourceBlockIds: [id],
      }];
    })
    .sort(sortByPagePosition);
}

function normalizeFields(
  pageNumber: number,
  blocks: TextractBlock[],
  index: BlockIndex,
  representedSelectionIds: Set<string>
): BaseDocumentField[] {
  return blocks
    .filter(
      (block) =>
        getBlockType(block) === "KEY_VALUE_SET" && hasEntityType(block, "KEY")
    )
    .flatMap((keyBlock) => {
      const id = requireBlockId(
        keyBlock,
        index,
        `KEY_VALUE_SET KEY on page ${pageNumber}`
      );
      if (!id) {
        return [];
      }
      const valueIds = getRelationships(keyBlock, "VALUE");
      const valueBlocks = valueIds
        .map((valueId) => index.byId.get(valueId))
        .filter((block): block is TextractBlock => Boolean(block));
      const valueChildIds = valueBlocks.flatMap((block) =>
        getRelationships(block, "CHILD")
      );
      const selectionStatuses = valueChildIds
        .map((childId) => index.byId.get(childId))
        .filter(
          (block): block is TextractBlock =>
            block !== undefined && getBlockType(block) === "SELECTION_ELEMENT"
        )
        .map((block) => {
          const selectionId = getBlockId(block);
          if (selectionId) {
            representedSelectionIds.add(selectionId);
          }
          return normalizeSelectionStatus(block.SelectionStatus);
        });
      const valueText = valueBlocks
        .map((valueBlock) => renderChildText(valueBlock, index))
        .filter(Boolean)
        .join(" ")
        .trim();
      const selectionStatus =
        selectionStatuses.length === 1 ? selectionStatuses[0] : null;

      return [{
        id,
        pageNumber,
        label: renderChildText(keyBlock, index),
        value: valueText,
        selectionStatus,
        confidence: getConfidence(keyBlock),
        keyGeometry: normalizeBlockGeometry(keyBlock, index, `field key ${id}`),
        valueGeometry:
          valueBlocks.length > 0
            ? normalizeBlockGeometry(valueBlocks[0], index, `field value for ${id}`)
            : null,
        sourceBlockIds: sourceIdsForBlock(keyBlock, index),
      }];
    })
    .sort((left, right) => {
      const leftGeometry = left.keyGeometry;
      const rightGeometry = right.keyGeometry;

      if (leftGeometry && rightGeometry) {
        if (Math.abs(leftGeometry.top - rightGeometry.top) > 0.0001) {
          return leftGeometry.top - rightGeometry.top;
        }

        if (Math.abs(leftGeometry.left - rightGeometry.left) > 0.0001) {
          return leftGeometry.left - rightGeometry.left;
        }
      }

      return left.id.localeCompare(right.id);
    });
}

function normalizeTableCell(
  block: TextractBlock,
  pageNumber: number,
  index: BlockIndex
): BaseDocumentTableCell | null {
  const id = requireBlockId(block, index, `CELL on page ${pageNumber}`);
  if (!id) {
    return null;
  }

  return {
    id,
    pageNumber,
    rowIndex: asInteger(block.RowIndex, 0),
    columnIndex: asInteger(block.ColumnIndex, 0),
    rowSpan: asInteger(block.RowSpan, 1),
    columnSpan: asInteger(block.ColumnSpan, 1),
    text: renderChildText(block, index),
    confidence: getConfidence(block),
    geometry: normalizeBlockGeometry(block, index, `table cell ${id}`),
    sourceBlockIds: sourceIdsForBlock(block, index),
  };
}

function normalizeMergedCell(
  block: TextractBlock,
  pageNumber: number,
  index: BlockIndex
): BaseDocumentMergedCell | null {
  const id = requireBlockId(block, index, `MERGED_CELL on page ${pageNumber}`);
  if (!id) {
    return null;
  }

  const childCellSourceBlockIds = getRelationships(block, "CHILD");
  const childCellBlocks = childCellSourceBlockIds
    .map((childId) => index.byId.get(childId))
    .filter((child): child is TextractBlock => Boolean(child));

  return {
    id,
    pageNumber,
    rowIndex: asInteger(block.RowIndex, 0),
    columnIndex: asInteger(block.ColumnIndex, 0),
    rowSpan: asInteger(block.RowSpan, 1),
    columnSpan: asInteger(block.ColumnSpan, 1),
    text: renderChildText(block, index),
    confidence: getConfidence(block),
    geometry: normalizeBlockGeometry(block, index, `merged cell ${id}`),
    childCellSourceBlockIds,
    sourceBlockIds: [
      id,
      ...childCellBlocks.flatMap((childCell) => sourceIdsForBlock(childCell, index)),
    ],
  };
}

function normalizeTables(
  pageNumber: number,
  blocks: TextractBlock[],
  index: BlockIndex
): BaseDocumentTable[] {
  return blocks
    .filter((block) => getBlockType(block) === "TABLE")
    .flatMap((tableBlock) => {
      const id = requireBlockId(tableBlock, index, `TABLE on page ${pageNumber}`);
      if (!id) {
        return [];
      }

      const childBlocks = getRelationships(tableBlock, "CHILD")
        .map((childId) => index.byId.get(childId))
        .filter((block): block is TextractBlock => Boolean(block));
      const cells = childBlocks
        .filter((block) => getBlockType(block) === "CELL")
        .map((cell) => normalizeTableCell(cell, pageNumber, index))
        .filter((cell): cell is BaseDocumentTableCell => Boolean(cell))
        .sort((left, right) => {
          if (left.rowIndex !== right.rowIndex) {
            return left.rowIndex - right.rowIndex;
          }

          return left.columnIndex - right.columnIndex;
        });
      const titleBlocks = getRelationships(tableBlock, "TABLE_TITLE")
        .map((blockId) => index.byId.get(blockId))
        .filter((block): block is TextractBlock => Boolean(block));
      const footerBlocks = getRelationships(tableBlock, "TABLE_FOOTER")
        .map((blockId) => index.byId.get(blockId))
        .filter((block): block is TextractBlock => Boolean(block));
      const title = titleBlocks
        .map((block) => textFromBlock(block) || renderChildText(block, index))
        .filter(Boolean)
        .join(" ")
        .trim();
      const footer = footerBlocks
        .map((block) => textFromBlock(block) || renderChildText(block, index))
        .filter(Boolean)
        .join(" ")
        .trim();
      const mergedCells = getRelationships(tableBlock, "MERGED_CELL")
        .map((blockId) => index.byId.get(blockId))
        .filter((block): block is TextractBlock => Boolean(block))
        .map((block) => normalizeMergedCell(block, pageNumber, index))
        .filter((cell): cell is BaseDocumentMergedCell => Boolean(cell));

      return [{
        id,
        pageNumber,
        title: title || null,
        footer: footer || null,
        rowCount: Math.max(0, ...cells.map((cell) => cell.rowIndex)),
        columnCount: Math.max(0, ...cells.map((cell) => cell.columnIndex)),
        confidence: getConfidence(tableBlock),
        geometry: normalizeBlockGeometry(tableBlock, index, `table ${id}`),
        cells,
        mergedCells,
        sourceBlockIds: [
          id,
          ...cells.flatMap((cell) => cell.sourceBlockIds),
          ...titleBlocks.flatMap((block) => sourceIdsForBlock(block, index)),
          ...footerBlocks.flatMap((block) => sourceIdsForBlock(block, index)),
          ...mergedCells.flatMap((cell) => cell.sourceBlockIds),
        ],
      }];
    })
    .sort(sortByPagePosition);
}

function normalizeSelectionMarks(
  pageNumber: number,
  blocks: TextractBlock[],
  index: BlockIndex,
  representedSelectionIds: Set<string>
): BaseDocumentSelectionMark[] {
  return blocks
    .filter((block) => getBlockType(block) === "SELECTION_ELEMENT")
    .filter((block) => {
      const id = getBlockId(block);
      return id ? !representedSelectionIds.has(id) : true;
    })
    .flatMap((block) => {
      const id = requireBlockId(
        block,
        index,
        `SELECTION_ELEMENT on page ${pageNumber}`
      );
      if (!id) {
        return [];
      }

      return [{
        id,
        pageNumber,
        status: normalizeSelectionStatus(block.SelectionStatus),
        confidence: getConfidence(block),
        geometry: normalizeBlockGeometry(block, index, `selection mark ${id}`),
        sourceBlockIds: [id],
      }];
    })
    .sort(sortByPagePosition);
}

function normalizeLayoutObjects(
  pageNumber: number,
  blocks: TextractBlock[],
  index: BlockIndex
): BaseDocumentLayoutObject[] {
  return blocks
    .filter((block) => getBlockType(block)?.startsWith("LAYOUT_"))
    .flatMap((block) => {
      const id = requireBlockId(block, index, `LAYOUT block on page ${pageNumber}`);
      if (!id) {
        return [];
      }

      const layoutType = getBlockType(block) ?? "LAYOUT_UNKNOWN";
      const text = textFromBlock(block) || renderChildText(block, index);

      return [{
        id,
        pageNumber,
        layoutType,
        text,
        confidence: getConfidence(block),
        geometry: normalizeBlockGeometry(block, index, `layout block ${id}`),
        sourceBlockIds: sourceIdsForBlock(block, index),
      }];
    })
    .sort(sortByPagePosition);
}

function buildPage(
  pageNumber: number,
  index: BlockIndex,
  representedSelectionIds: Set<string>
): BaseDocumentPage {
  const blocks = index.byPage.get(pageNumber) ?? [];
  const pageBlockIds = blocks
    .filter((block) => getBlockType(block) === "PAGE")
    .map(getBlockId)
    .filter((id): id is string => Boolean(id));
  if (pageBlockIds.length === 0) {
    index.warnings.push(`Page ${pageNumber} is missing PAGE block provenance.`);
  }

  const lines = normalizeLines(pageNumber, blocks, index);
  const fields = normalizeFields(pageNumber, blocks, index, representedSelectionIds);
  const tables = normalizeTables(pageNumber, blocks, index);
  const selectionMarks = normalizeSelectionMarks(
    pageNumber,
    blocks,
    index,
    representedSelectionIds
  );
  const layout = normalizeLayoutObjects(pageNumber, blocks, index);

  return {
    pageNumber,
    text: lines.map((line) => line.text).filter(Boolean).join("\n").trim(),
    lines,
    fields,
    tables,
    selectionMarks,
    layout,
    sourceBlockIds: pageBlockIds,
  };
}

function inferPageCount(
  responses: TextractAnalysisResponse[],
  index: BlockIndex,
  expectedPageCount?: number | null
): number {
  if (expectedPageCount && expectedPageCount > 0) {
    return expectedPageCount;
  }

  const metadataPageCounts = responses
    .map((response) => asNumber(response.DocumentMetadata?.Pages))
    .filter((value): value is number => value !== null && value > 0);

  if (metadataPageCounts.length > 0) {
    return Math.max(...metadataPageCounts);
  }

  if (index.byPage.size > 0) {
    return Math.max(...index.byPage.keys());
  }

  return 0;
}

function collectSummary(document: Omit<BaseDocument, "summary">, rawBlockCount: number, warnings: string[]) {
  const fieldCount = document.pages.reduce(
    (sum, page) => sum + page.fields.length,
    0
  );
  const tableCount = document.pages.reduce(
    (sum, page) => sum + page.tables.length,
    0
  );
  const tableCellCount = document.pages.reduce(
    (sum, page) =>
      sum + page.tables.reduce((cellSum, table) => cellSum + table.cells.length, 0),
    0
  );
  const selectionMarkCount = document.pages.reduce(
    (sum, page) => sum + page.selectionMarks.length,
    0
  );
  const lineCount = document.pages.reduce(
    (sum, page) => sum + page.lines.length,
    0
  );
  const layoutObjectCount = document.pages.reduce(
    (sum, page) => sum + page.layout.length,
    0
  );

  return {
    provider: document.provider,
    providerJobId: document.providerJobId,
    sourceFilename: document.sourceFilename,
    pageCount: document.pages.length,
    rawBlockCount,
    fieldCount,
    tableCount,
    tableCellCount,
    selectionMarkCount,
    lineCount,
    layoutObjectCount,
    parserVersion: document.parserVersion,
    featureSet: document.featureSet,
    warnings,
  };
}

export function normalizeTextractAnalysis(
  input: NormalizeTextractAnalysisInput
): BaseDocument {
  const index = buildBlockIndex(input.responses);
  const pageCount = inferPageCount(
    input.responses,
    index,
    input.expectedPageCount
  );
  const representedSelectionIds = new Set<string>();
  const pages = Array.from({ length: pageCount }, (_value, indexOffset) =>
    buildPage(indexOffset + 1, index, representedSelectionIds)
  );
  const documentWithoutSummary = {
    schemaVersion: "base-document-v1" as const,
    provider: "aws-textract" as const,
    providerJobId: input.providerJobId ?? null,
    sourceFilename: input.sourceFilename ?? null,
    parserVersion: TEXTRACT_BASE_DOCUMENT_PARSER_VERSION,
    featureSet: input.featureSet ?? ["FORMS", "TABLES", "LAYOUT"],
    pages,
  };

  return {
    ...documentWithoutSummary,
    summary: collectSummary(
      documentWithoutSummary,
      index.rawBlockCount,
      index.warnings
    ),
  };
}
