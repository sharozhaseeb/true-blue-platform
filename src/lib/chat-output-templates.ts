import {
  CHAT_OUTPUT_SCHEMA_VERSION,
  DEFAULT_CHAT_OUTPUT_TEMPLATE_ID,
  DEFAULT_CHAT_OUTPUT_TEMPLATE_VERSION,
} from "@/lib/chat-output-schema";

export type OutputTemplateRegistryEntry = {
  templateId: string;
  templateVersion: number;
  schemaVersion: typeof CHAT_OUTPUT_SCHEMA_VERSION;
  label: string;
  description: string;
  responseMode: "rag_qa";
  includeSources: boolean;
  includeCoverage: boolean;
  includeSupport: boolean;
  maxSources?: number;
};

export const CHAT_OUTPUT_TEMPLATES = [
  {
    templateId: DEFAULT_CHAT_OUTPUT_TEMPLATE_ID,
    templateVersion: DEFAULT_CHAT_OUTPUT_TEMPLATE_VERSION,
    schemaVersion: CHAT_OUTPUT_SCHEMA_VERSION,
    label: "RAG Q&A Default",
    description: "Full True Blue structured output envelope for document Q&A.",
    responseMode: "rag_qa",
    includeSources: true,
    includeCoverage: true,
    includeSupport: true,
  },
  {
    templateId: "rag_qa.compact.v1",
    templateVersion: 1,
    schemaVersion: CHAT_OUTPUT_SCHEMA_VERSION,
    label: "RAG Q&A Compact",
    description: "Compact True Blue structured output envelope with reduced source payloads.",
    responseMode: "rag_qa",
    includeSources: true,
    includeCoverage: true,
    includeSupport: true,
    maxSources: 8,
  },
] as const satisfies readonly OutputTemplateRegistryEntry[];

export type OutputTemplateId = (typeof CHAT_OUTPUT_TEMPLATES)[number]["templateId"];

export type OutputTemplateSelection = {
  templateId: OutputTemplateId;
  templateVersion: number;
};

export class UnsupportedChatOutputTemplateError extends Error {
  constructor(templateId: string) {
    super(`Unsupported chat output template: ${templateId}`);
    this.name = "UnsupportedChatOutputTemplateError";
  }
}

export const DEFAULT_CHAT_OUTPUT_TEMPLATE = CHAT_OUTPUT_TEMPLATES[0];

export function getChatOutputTemplate(
  templateId?: string
): OutputTemplateRegistryEntry {
  const normalizedTemplateId = templateId?.trim() || DEFAULT_CHAT_OUTPUT_TEMPLATE_ID;
  const template = CHAT_OUTPUT_TEMPLATES.find(
    (candidate) => candidate.templateId === normalizedTemplateId
  );
  if (!template) {
    throw new UnsupportedChatOutputTemplateError(normalizedTemplateId);
  }

  return template;
}

export function outputTemplateSelectionFromEntry(
  template: OutputTemplateRegistryEntry
): OutputTemplateSelection {
  return {
    templateId: template.templateId as OutputTemplateId,
    templateVersion: template.templateVersion,
  };
}

export function normalizeOutputTemplateSelection(
  value?: { templateId?: string | null } | null
): OutputTemplateSelection {
  return outputTemplateSelectionFromEntry(getChatOutputTemplate(value?.templateId ?? undefined));
}

export function outputTemplateSelectionFromPersisted(
  value: unknown
): OutputTemplateSelection {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "templateId" in value &&
    typeof (value as { templateId?: unknown }).templateId === "string"
  ) {
    try {
      return normalizeOutputTemplateSelection({
        templateId: (value as { templateId: string }).templateId,
      });
    } catch {
      return outputTemplateSelectionFromEntry(DEFAULT_CHAT_OUTPUT_TEMPLATE);
    }
  }

  return outputTemplateSelectionFromEntry(DEFAULT_CHAT_OUTPUT_TEMPLATE);
}
