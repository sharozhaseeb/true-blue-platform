export type BaseDocumentProvider = "aws-textract";

export type BaseDocumentSelectionStatus =
  | "SELECTED"
  | "NOT_SELECTED"
  | "UNKNOWN";

export interface BaseDocumentPoint {
  x: number;
  y: number;
}

export interface BaseDocumentGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  rotation?: number | null;
  polygon?: BaseDocumentPoint[];
}

export interface BaseDocumentSourceRef {
  provider: BaseDocumentProvider;
  blockId: string;
  blockType: string;
  pageNumber: number | null;
}

export interface BaseDocumentLine {
  id: string;
  pageNumber: number;
  text: string;
  confidence: number | null;
  geometry: BaseDocumentGeometry | null;
  sourceBlockIds: string[];
}

export interface BaseDocumentField {
  id: string;
  pageNumber: number;
  label: string;
  value: string;
  selectionStatus: BaseDocumentSelectionStatus | null;
  confidence: number | null;
  keyGeometry: BaseDocumentGeometry | null;
  valueGeometry: BaseDocumentGeometry | null;
  sourceBlockIds: string[];
}

export interface BaseDocumentTableCell {
  id: string;
  pageNumber: number;
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
  confidence: number | null;
  geometry: BaseDocumentGeometry | null;
  sourceBlockIds: string[];
}

export interface BaseDocumentMergedCell {
  id: string;
  pageNumber: number;
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  columnSpan: number;
  text: string;
  confidence: number | null;
  geometry: BaseDocumentGeometry | null;
  childCellSourceBlockIds: string[];
  sourceBlockIds: string[];
}

export interface BaseDocumentTable {
  id: string;
  pageNumber: number;
  title: string | null;
  footer: string | null;
  rowCount: number;
  columnCount: number;
  confidence: number | null;
  geometry: BaseDocumentGeometry | null;
  cells: BaseDocumentTableCell[];
  mergedCells: BaseDocumentMergedCell[];
  sourceBlockIds: string[];
}

export interface BaseDocumentSelectionMark {
  id: string;
  pageNumber: number;
  status: BaseDocumentSelectionStatus;
  confidence: number | null;
  geometry: BaseDocumentGeometry | null;
  sourceBlockIds: string[];
}

export interface BaseDocumentLayoutObject {
  id: string;
  pageNumber: number;
  layoutType: string;
  text: string;
  confidence: number | null;
  geometry: BaseDocumentGeometry | null;
  sourceBlockIds: string[];
}

export interface BaseDocumentPage {
  pageNumber: number;
  text: string;
  lines: BaseDocumentLine[];
  fields: BaseDocumentField[];
  tables: BaseDocumentTable[];
  selectionMarks: BaseDocumentSelectionMark[];
  layout: BaseDocumentLayoutObject[];
  sourceBlockIds: string[];
}

export interface BaseDocumentSummary {
  provider: BaseDocumentProvider;
  providerJobId: string | null;
  sourceFilename: string | null;
  pageCount: number;
  rawBlockCount: number;
  fieldCount: number;
  tableCount: number;
  tableCellCount: number;
  selectionMarkCount: number;
  lineCount: number;
  layoutObjectCount: number;
  parserVersion: string;
  featureSet: string[];
  warnings: string[];
}

export interface BaseDocument {
  schemaVersion: "base-document-v1";
  provider: BaseDocumentProvider;
  providerJobId: string | null;
  sourceFilename: string | null;
  parserVersion: string;
  featureSet: string[];
  pages: BaseDocumentPage[];
  summary: BaseDocumentSummary;
}
