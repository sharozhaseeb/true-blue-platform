import type {
  BaseDocument,
  BaseDocumentField,
  BaseDocumentPage,
  BaseDocumentTable,
} from "@/lib/base-document";

export type BaseDocumentChunkContentType =
  | "prose"
  | "field_group"
  | "table"
  | "mixed";

export interface BaseDocumentRetrievalChunk {
  chunkId: string;
  documentId: string;
  firmId: string;
  baseArtifactId: string;
  vectorGeneration: number;
  content: string;
  contentType: BaseDocumentChunkContentType;
  pageStart: number;
  pageEnd: number;
  formType: string | null;
  sectionPath: string | null;
  tableId: string | null;
  sourceBlockIds: string[];
  parserVersion: string;
  chunkStrategy: string;
}

export interface ChunkBaseDocumentOptions {
  documentId: string;
  firmId: string;
  baseArtifactId: string;
  vectorGeneration?: number;
  chunkStrategy?: string;
}

export const DEFAULT_CHUNK_STRATEGY = "base-document-structure-v1";
const MAX_SOURCE_BLOCK_IDS = 256;

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function detectPageFormType(page: BaseDocumentPage): string | null {
  const headerText = [
    ...page.layout.map((layout) => layout.text),
    ...page.lines.slice(0, 8).map((line) => line.text),
  ].join(" ");
  const formMatch = headerText.match(/\b(Form|Schedule)\s+([A-Z0-9-]+)/i);

  return formMatch ? `${formMatch[1]} ${formMatch[2]}` : null;
}

function createChunkId(
  options: Required<Pick<ChunkBaseDocumentOptions, "documentId" | "firmId">> &
    Pick<ChunkBaseDocumentOptions, "baseArtifactId">,
  parserVersion: string,
  chunkStrategy: string,
  vectorGeneration: number,
  chunkIndex: number
): string {
  return [
    options.firmId,
    options.documentId,
    options.baseArtifactId,
    parserVersion,
    chunkStrategy,
    `g${vectorGeneration}`,
    chunkIndex,
  ].join(":");
}

function formatFields(fields: BaseDocumentField[]): string {
  return fields
    .map((field) => {
      const value = field.selectionStatus ?? field.value;
      if (field.label && value) {
        return `${field.label}: ${value}`;
      }

      return field.label || value || "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatTable(table: BaseDocumentTable): string {
  const lines: string[] = [];

  if (table.title) {
    lines.push(table.title);
  }

  for (const cell of table.cells) {
    lines.push(`R${cell.rowIndex}C${cell.columnIndex}: ${cell.text}`);
  }

  for (const mergedCell of table.mergedCells) {
    lines.push(
      `Merged R${mergedCell.rowIndex}C${mergedCell.columnIndex} span ${mergedCell.rowSpan}x${mergedCell.columnSpan}: ${mergedCell.text}`
    );
  }

  if (table.footer) {
    lines.push(table.footer);
  }

  return normalizeWhitespace(lines.join("\n"));
}

export function chunkBaseDocument(
  baseDocument: BaseDocument,
  options: ChunkBaseDocumentOptions
): BaseDocumentRetrievalChunk[] {
  const vectorGeneration = options.vectorGeneration ?? 1;
  const chunkStrategy = options.chunkStrategy ?? DEFAULT_CHUNK_STRATEGY;
  const chunks: BaseDocumentRetrievalChunk[] = [];
  let chunkIndex = 0;

  function pushChunk(
    page: BaseDocumentPage,
    contentType: BaseDocumentChunkContentType,
    content: string,
    sourceBlockIds: string[],
    sectionPath: string | null,
    tableId: string | null
  ) {
    const normalizedContent = normalizeWhitespace(content);
    if (!normalizedContent) {
      return;
    }

    chunks.push({
      chunkId: createChunkId(
        {
          documentId: options.documentId,
          firmId: options.firmId,
          baseArtifactId: options.baseArtifactId,
        },
        baseDocument.parserVersion,
        chunkStrategy,
        vectorGeneration,
        chunkIndex
      ),
      documentId: options.documentId,
      firmId: options.firmId,
      baseArtifactId: options.baseArtifactId,
      vectorGeneration,
      content: normalizedContent,
      contentType,
      pageStart: page.pageNumber,
      pageEnd: page.pageNumber,
      formType: detectPageFormType(page),
      sectionPath,
      tableId,
      sourceBlockIds: uniq(sourceBlockIds).slice(0, MAX_SOURCE_BLOCK_IDS),
      parserVersion: baseDocument.parserVersion,
      chunkStrategy,
    });
    chunkIndex += 1;
  }

  for (const page of baseDocument.pages) {
    pushChunk(
      page,
      "mixed",
      page.layout
        .map((layout) => `${layout.layoutType}: ${layout.text}`)
        .filter(Boolean)
        .join("\n"),
      page.layout.flatMap((layout) => layout.sourceBlockIds),
      `page/${page.pageNumber}/layout`,
      null
    );

    pushChunk(
      page,
      "prose",
      page.text,
      page.lines.flatMap((line) => line.sourceBlockIds),
      `page/${page.pageNumber}/text`,
      null
    );

    pushChunk(
      page,
      "field_group",
      formatFields(page.fields),
      page.fields.flatMap((field) => field.sourceBlockIds),
      `page/${page.pageNumber}/fields`,
      null
    );

    for (const table of page.tables) {
      pushChunk(
        page,
        "table",
        formatTable(table),
        table.sourceBlockIds,
        `page/${page.pageNumber}/tables/${table.id}`,
        table.id
      );
    }
  }

  return chunks;
}
