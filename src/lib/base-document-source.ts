import type { BaseDocument } from "@/lib/base-document";
import {
  normalizeTextractAnalysis,
  type TextractAnalysisResponse,
} from "@/lib/textract-normalizer";

export type BaseDocumentSourceMode =
  | "base-document-json"
  | "textract-response-fixture"
  | "live-textract";

export type BaseDocumentArtifactStatus =
  | "QUEUED"
  | "NORMALIZING"
  | "READY_FOR_INDEXING"
  | "FAILED";

export interface BaseDocumentArtifact {
  id: string;
  documentId: string;
  firmId: string | null;
  generation: number;
  isCurrent: boolean;
  sourceMode: BaseDocumentSourceMode;
  status: BaseDocumentArtifactStatus;
  parserVersion: string;
  featureSet: string[];
  baseDocument: BaseDocument;
}

export interface BaseDocumentSourceInput {
  artifactId: string;
  documentId: string;
  firmId?: string | null;
  generation?: number;
  sourceFilename?: string | null;
}

export interface TextractFixtureSourceInput extends BaseDocumentSourceInput {
  responses: TextractAnalysisResponse[];
  providerJobId?: string | null;
  expectedPageCount?: number | null;
  featureSet?: string[];
}

export interface BaseDocumentJsonSourceInput extends BaseDocumentSourceInput {
  baseDocument: BaseDocument;
}

export interface BaseDocumentSource<TInput extends BaseDocumentSourceInput> {
  sourceMode: BaseDocumentSourceMode;
  load(input: TInput): Promise<BaseDocumentArtifact>;
}

export function validateBaseDocumentReadiness(baseDocument: BaseDocument): string[] {
  const errors: string[] = [];

  if (baseDocument.parserVersion.length === 0) {
    errors.push("parserVersion is missing");
  }

  if (baseDocument.featureSet.length === 0) {
    errors.push("featureSet is missing");
  }

  if (baseDocument.pages.length === 0) {
    errors.push("no pages normalized");
  }

  if (baseDocument.summary.rawBlockCount <= 0) {
    errors.push("rawBlockCount is zero");
  }

  if (baseDocument.summary.lineCount <= 0) {
    errors.push("lineCount is zero");
  }

  if (baseDocument.summary.fieldCount <= 0) {
    errors.push("fieldCount is zero");
  }

  if (baseDocument.summary.tableCount <= 0) {
    errors.push("tableCount is zero");
  }

  for (const warning of baseDocument.summary.warnings) {
    errors.push(`normalizer warning: ${warning}`);
  }

  for (const page of baseDocument.pages) {
    if (page.sourceBlockIds.length === 0) {
      errors.push(`page ${page.pageNumber} missing source provenance`);
    }

    for (const line of page.lines) {
      if (line.sourceBlockIds.length === 0) {
        errors.push(`line ${line.id} missing source provenance`);
      }
    }

    for (const field of page.fields) {
      if (field.sourceBlockIds.length === 0) {
        errors.push(`field ${field.id} missing source provenance`);
      }
    }

    for (const table of page.tables) {
      if (table.sourceBlockIds.length === 0) {
        errors.push(`table ${table.id} missing source provenance`);
      }

      for (const cell of table.cells) {
        if (cell.rowIndex <= 0 || cell.columnIndex <= 0) {
          errors.push(`table cell ${cell.id} has invalid row/column indexes`);
        }

        if (cell.sourceBlockIds.length === 0) {
          errors.push(`table cell ${cell.id} missing source provenance`);
        }
      }

      for (const mergedCell of table.mergedCells) {
        if (mergedCell.rowIndex <= 0 || mergedCell.columnIndex <= 0) {
          errors.push(`merged cell ${mergedCell.id} has invalid row/column indexes`);
        }

        if (mergedCell.sourceBlockIds.length === 0) {
          errors.push(`merged cell ${mergedCell.id} missing source provenance`);
        }

        if (mergedCell.childCellSourceBlockIds.length === 0) {
          errors.push(`merged cell ${mergedCell.id} missing child cell relationships`);
        }
      }
    }

    for (const selectionMark of page.selectionMarks) {
      if (selectionMark.status === "UNKNOWN") {
        errors.push(`selection mark ${selectionMark.id} has unknown status`);
      }

      if (selectionMark.sourceBlockIds.length === 0) {
        errors.push(`selection mark ${selectionMark.id} missing source provenance`);
      }
    }

    for (const layout of page.layout) {
      if (layout.sourceBlockIds.length === 0) {
        errors.push(`layout block ${layout.id} missing source provenance`);
      }
    }
  }

  return errors;
}

function createArtifact(
  input: BaseDocumentSourceInput,
  sourceMode: BaseDocumentSourceMode,
  baseDocument: BaseDocument
): BaseDocumentArtifact {
  return {
    id: input.artifactId,
    documentId: input.documentId,
    firmId: input.firmId ?? null,
    generation: input.generation ?? 1,
    isCurrent: true,
    sourceMode,
    status:
      validateBaseDocumentReadiness(baseDocument).length === 0
        ? "READY_FOR_INDEXING"
        : "FAILED",
    parserVersion: baseDocument.parserVersion,
    featureSet: baseDocument.featureSet,
    baseDocument,
  };
}

export const textractFixtureBaseDocumentSource: BaseDocumentSource<TextractFixtureSourceInput> = {
  sourceMode: "textract-response-fixture",
  async load(input) {
    return createArtifact(
      input,
      "textract-response-fixture",
      normalizeTextractAnalysis({
        responses: input.responses,
        providerJobId: input.providerJobId ?? null,
        sourceFilename: input.sourceFilename ?? null,
        expectedPageCount: input.expectedPageCount ?? null,
        featureSet: input.featureSet,
      })
    );
  },
};

export const liveTextractBaseDocumentSource: BaseDocumentSource<TextractFixtureSourceInput> = {
  sourceMode: "live-textract",
  async load(input) {
    return createArtifact(
      input,
      "live-textract",
      normalizeTextractAnalysis({
        responses: input.responses,
        providerJobId: input.providerJobId ?? null,
        sourceFilename: input.sourceFilename ?? null,
        expectedPageCount: input.expectedPageCount ?? null,
        featureSet: input.featureSet,
      })
    );
  },
};

export const baseDocumentJsonSource: BaseDocumentSource<BaseDocumentJsonSourceInput> = {
  sourceMode: "base-document-json",
  async load(input) {
    return createArtifact(input, "base-document-json", input.baseDocument);
  },
};
