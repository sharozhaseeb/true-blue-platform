import { z } from "zod";

export const CHAT_OUTPUT_SCHEMA_VERSION = "trueblue.chat.output.v1" as const;
export const DEFAULT_CHAT_OUTPUT_TEMPLATE_ID = "rag_qa.default.v1" as const;
export const DEFAULT_CHAT_OUTPUT_TEMPLATE_VERSION = 1 as const;

export const OutputStatusV1Schema = z.enum([
  "answered",
  "insufficient_evidence",
  "narrowing_required",
  "non_document",
]);

const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeIntegerSchema = z.number().int().min(0);

export const EvidenceCoverageV1Schema = z
  .object({
    version: z.literal(1),
    selectedDocumentIds: z.array(NonEmptyStringSchema),
    retrievedByDocumentId: z.record(z.string(), NonNegativeIntegerSchema),
    finalByDocumentId: z.record(z.string(), NonNegativeIntegerSchema),
    noEvidenceDocumentIds: z.array(NonEmptyStringSchema),
  })
  .superRefine((coverage, ctx) => {
    const selected = new Set(coverage.selectedDocumentIds);
    coverage.selectedDocumentIds.forEach((documentId, index) => {
      if (!(documentId in coverage.finalByDocumentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["selectedDocumentIds", index],
          message: "selected document must appear in finalByDocumentId",
        });
      }

      if (
        coverage.retrievedByDocumentId &&
        !(documentId in coverage.retrievedByDocumentId)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["selectedDocumentIds", index],
          message: "selected document must appear in retrievedByDocumentId",
        });
      }
    });

    for (const documentId of Object.keys(coverage.finalByDocumentId)) {
      if (!selected.has(documentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["finalByDocumentId", documentId],
          message: "finalByDocumentId key must be selected",
        });
      }
    }

    for (const documentId of Object.keys(coverage.retrievedByDocumentId)) {
      if (!selected.has(documentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["retrievedByDocumentId", documentId],
          message: "retrievedByDocumentId key must be selected",
        });
      }
    }

    coverage.noEvidenceDocumentIds.forEach((documentId, index) => {
      if (!selected.has(documentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["noEvidenceDocumentIds", index],
          message: "noEvidenceDocumentIds value must be selected",
        });
      }
    });
  });

export const SourceCitationV1Schema = z
  .object({
    sourceId: z.string().regex(/^S[1-9][0-9]*$/),
    marker: z.string().regex(/^\[S[1-9][0-9]*\]$/),
    rank: z.number().int().min(1),
    chunkId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    filename: NonEmptyStringSchema.optional(),
    pageStart: z.number().int().min(1),
    pageEnd: z.number().int().min(1),
    pageLabel: NonEmptyStringSchema,
    snippet: NonEmptyStringSchema,
    snippetFull: NonEmptyStringSchema.optional(),
    sourceBlockIds: z.array(NonEmptyStringSchema).min(1),
    formType: NonEmptyStringSchema.optional(),
    contentType: z.enum(["prose", "field_group", "table", "mixed"]).optional(),
    sectionPath: NonEmptyStringSchema.optional(),
    tableId: NonEmptyStringSchema.optional(),
    relevanceScore: z.number().finite().optional(),
  })
  .superRefine((source, ctx) => {
    if (source.marker !== `[${source.sourceId}]`) {
      ctx.addIssue({
        code: "custom",
        path: ["marker"],
        message: "marker must match sourceId",
      });
    }

    if (source.pageEnd < source.pageStart) {
      ctx.addIssue({
        code: "custom",
        path: ["pageEnd"],
        message: "pageEnd must be greater than or equal to pageStart",
      });
    }
  });

export const OutputSupportV1Schema = z.object({
  confidenceLabel: z.enum(["high", "medium", "low", "none"]),
  confidenceBasis: NonEmptyStringSchema,
  retrievalMode: z.enum(["local_retrieval_fallback", "vector_retrieval"]),
  scoreThreshold: z.number().finite().min(0).optional(),
  sourceCount: NonNegativeIntegerSchema,
  selectedDocumentCount: NonNegativeIntegerSchema,
  citedDocumentCount: NonNegativeIntegerSchema,
  retrievalWarningCount: NonNegativeIntegerSchema,
});

export const OutputWarningV1Schema = z.object({
  code: z.enum([
    "INSUFFICIENT_EVIDENCE",
    "PARTIAL_SOURCE_COVERAGE",
    "NO_EVIDENCE_FOR_SELECTED_DOCUMENT",
    "RETRIEVAL_WARNING",
    "NARROWING_REQUIRED",
    "NON_DOCUMENT_MESSAGE",
    "TEMPLATE_DEFAULTED",
    "TEMPLATE_UNSUPPORTED",
  ]),
  message: NonEmptyStringSchema,
  severity: z.enum(["info", "warning", "error"]),
  documentIds: z.array(NonEmptyStringSchema).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const OutputMetadataV1Schema = z.object({
  threadId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema.optional(),
  requestKey: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema.optional(),
  generatedAt: NonEmptyStringSchema.refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "generatedAt must be an ISO timestamp"
  ),
  responseMode: z.literal("rag_qa"),
  inputTokens: NonNegativeIntegerSchema.optional(),
  outputTokens: NonNegativeIntegerSchema.optional(),
});

export const StructuredChatOutputV1Schema = z
  .object({
    schemaVersion: z.literal(CHAT_OUTPUT_SCHEMA_VERSION),
    templateId: NonEmptyStringSchema,
    templateVersion: z.number().int().min(1),
    status: OutputStatusV1Schema,
    responseText: z.string(),
    sources: z.array(SourceCitationV1Schema),
    coverage: EvidenceCoverageV1Schema,
    support: OutputSupportV1Schema,
    warnings: z.array(OutputWarningV1Schema),
    metadata: OutputMetadataV1Schema,
  })
  .superRefine((output, ctx) => {
    const selectedDocumentIds = new Set(output.coverage.selectedDocumentIds);
    const citedDocumentIds = new Set<string>();

    output.sources.forEach((source, index) => {
      citedDocumentIds.add(source.documentId);
      if (!selectedDocumentIds.has(source.documentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", index, "documentId"],
          message: "source documentId must be selected in coverage",
        });
      }
    });

    if (output.support.sourceCount !== output.sources.length) {
      ctx.addIssue({
        code: "custom",
        path: ["support", "sourceCount"],
        message: "support.sourceCount must equal sources.length",
      });
    }

    if (
      output.support.selectedDocumentCount !==
      output.coverage.selectedDocumentIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["support", "selectedDocumentCount"],
        message:
          "support.selectedDocumentCount must equal coverage.selectedDocumentIds.length",
      });
    }

    if (output.support.citedDocumentCount !== citedDocumentIds.size) {
      ctx.addIssue({
        code: "custom",
        path: ["support", "citedDocumentCount"],
        message: "support.citedDocumentCount must equal unique source document count",
      });
    }
  });

export type OutputStatusV1 = z.infer<typeof OutputStatusV1Schema>;
export type StructuredOutputStatusV1 = OutputStatusV1;
export type EvidenceCoverageV1 = z.infer<typeof EvidenceCoverageV1Schema>;
export type SourceCitationV1 = z.infer<typeof SourceCitationV1Schema>;
export type OutputSupportV1 = z.infer<typeof OutputSupportV1Schema>;
export type OutputWarningV1 = z.infer<typeof OutputWarningV1Schema>;
export type OutputMetadataV1 = z.infer<typeof OutputMetadataV1Schema>;
export type StructuredChatOutputV1 = z.infer<typeof StructuredChatOutputV1Schema>;

export function parseStructuredChatOutputV1(value: unknown): StructuredChatOutputV1 {
  return StructuredChatOutputV1Schema.parse(value);
}

export function isStructuredChatOutputV1(
  value: unknown
): value is StructuredChatOutputV1 {
  return StructuredChatOutputV1Schema.safeParse(value).success;
}
