import { hasPermission } from "@/lib/rbac";
import {
  badRequest,
  forbidden,
  internalError,
  tooManyRequests,
  unauthorized,
} from "@/lib/errors";
import { getFirmScopedRequestContext } from "@/lib/tenant";
import {
  appendAssistantMessageToThread,
  appendUserMessageToThread,
  createChatThreadWithUserMessage,
  loadAssistantMessageByRequestKey,
  loadChatThreadForUser,
  MAX_CHAT_HISTORY_MESSAGES,
  type EvidenceCoverageV1,
  type PersistedChatMessage,
} from "@/lib/chat-persistence";
import {
  buildGroundedLocalAnswer,
  parseChatRequestBody,
  stableChatRequestFingerprint,
  type ParsedChatRequest,
} from "@/lib/chat-contract";
import {
  retrievePersistedBaseDocumentChunks,
  type PersistedBaseDocumentRetrievalOutput,
} from "@/lib/persisted-base-document-retrieval";
import type { LocalRetrievalResult } from "@/lib/base-document-retrieval";
import { readM3ProviderConfig } from "@/lib/ai/config";
import {
  M3_RAG_RESPONSE_MODE,
  M3_RAG_SYSTEM_PROMPT,
  buildRagContext,
  buildRagUserPrompt,
  persistedMessagesToModelHistory,
} from "@/lib/ai/prompts";
import { enforceNumericGrounding } from "@/lib/ai/grounding-check";
import {
  retrieveVectorDocumentChunks,
  type VectorDocumentRetrievalOutput,
} from "@/lib/vector/vector-retrieval";
import { checkChatRateLimits } from "@/lib/rate-limit";
import { logger } from "@/lib/server-logger";
import { prisma } from "@/lib/prisma";
import {
  createInsufficientEvidenceAnswer,
  finalizePublicChatOutput,
  isInsufficientEvidenceText,
} from "@/lib/chat-public-output";
import { buildStructuredChatOutputV1 } from "@/lib/chat-output-builder";
import {
  outputTemplateSelectionFromEntry,
  outputTemplateSelectionFromPersisted,
  DEFAULT_CHAT_OUTPUT_TEMPLATE,
  type OutputTemplateSelection,
} from "@/lib/chat-output-templates";
import type {
  OutputStatusV1,
  StructuredChatOutputV1,
} from "@/lib/chat-output-schema";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import crypto from "crypto";

const LOCAL_CHAT_MODEL = "local-retrieval-fallback-v0";
const VECTOR_RETRIEVAL_CHAT_MODEL = "local-grounded-vector-retrieval-v0";
const AI_CHAT_INSUFFICIENT_MODEL = "m3-rag-insufficient-evidence-v0";
const NON_DOCUMENT_CHAT_MODEL = "m3-rag-non-document-message-v0";
const MULTI_SOURCE_NARROWING_MODEL = "m3-rag-narrow-source-scope-v0";
const MAX_MULTI_SOURCE_SYNTHESIS_DOCUMENTS = 8;
const FINAL_CONTEXT_RESULT_LIMIT = 8;
const MAX_FINAL_RESULTS_PER_DOCUMENT = 4;
type ChatRetrievalMode = "local_retrieval_fallback" | "vector_retrieval";
type ChatCitationData = {
  marker?: string;
  rank: number;
  chunkId: string;
  documentId: string;
  filename?: string;
  pageStart: number;
  pageEnd: number;
  snippet: string;
  snippetFull?: string;
  sourceBlockIds: string[];
  formType?: string | null;
  contentType?: "prose" | "field_group" | "table" | "mixed";
  sectionPath?: string | null;
  tableId?: string | null;
  relevanceScore?: number;
  boundingBoxes?: Array<{
    pageNumber: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
};
type TrueBlueChatDataParts = {
  thread: {
    threadId: string;
    responseMode: typeof M3_RAG_RESPONSE_MODE;
    documentFilter?: ParsedChatRequest["documentFilter"] | null;
  };
  citations: { citations: ChatCitationData[] };
  coverage: { coverage: EvidenceCoverageV1 };
  output: { output: StructuredChatOutputV1 };
  usage: { model: string; inputTokens?: number; outputTokens?: number };
  error: { code: string; message: string };
};
type TrueBlueChatMessage = UIMessage<
  { threadId?: string; responseMode?: typeof M3_RAG_RESPONSE_MODE },
  TrueBlueChatDataParts
>;

type ChatEvidenceCoverage = EvidenceCoverageV1;

type ChatEvidenceSelection = {
  finalResults: LocalRetrievalResult[];
  warnings: string[];
  mode: ChatRetrievalMode;
  model: string;
  coverage: ChatEvidenceCoverage;
  narrowingAnswer?: string;
};

function scopedRequestKey(
  requestKey: string | undefined,
  fingerprint: string,
  role: "user" | "assistant"
): string | undefined {
  if (!requestKey) {
    return undefined;
  }

  const digest = crypto
    .createHash("sha256")
    .update(`${requestKey}:${role}:${fingerprint}`)
    .digest("base64url");

  return `${requestKey.slice(0, 32)}:${role}:${digest.slice(0, 43)}`;
}

function isExpectedChatError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Chat message") ||
      error.message.includes("Document filter") ||
      error.message.includes("documentIds") ||
      error.message.includes("formTypes") ||
      error.message.includes("pageRange") ||
      error.message.includes("outputTemplate") ||
      error.message.includes("Unsupported chat output template") ||
      error.message.includes("Chat thread not found") ||
      error.message.includes("Persisted local retrieval exceeded"))
  );
}

function citationsFromMessage(message: PersistedChatMessage): unknown[] {
  return Array.isArray(message.citations) ? message.citations : [];
}

function coverageFromMessage(message: PersistedChatMessage): EvidenceCoverageV1 | null {
  const coverage = message.evidenceCoverage;
  if (
    typeof coverage === "object" &&
    coverage !== null &&
    !Array.isArray(coverage) &&
    "version" in coverage &&
    coverage.version === 1 &&
    Array.isArray((coverage as EvidenceCoverageV1).selectedDocumentIds) &&
    typeof (coverage as EvidenceCoverageV1).finalByDocumentId === "object" &&
    Array.isArray((coverage as EvidenceCoverageV1).noEvidenceDocumentIds)
  ) {
    const parsed = coverage as Partial<EvidenceCoverageV1> & {
      version: 1;
      selectedDocumentIds: string[];
      finalByDocumentId: Record<string, number>;
      noEvidenceDocumentIds: string[];
    };
    return {
      version: 1,
      selectedDocumentIds: parsed.selectedDocumentIds,
      retrievedByDocumentId: Object.fromEntries(
        parsed.selectedDocumentIds.map((documentId) => [
          documentId,
          parsed.retrievedByDocumentId?.[documentId] ??
            parsed.finalByDocumentId[documentId] ??
            0,
        ])
      ),
      finalByDocumentId: Object.fromEntries(
        parsed.selectedDocumentIds.map((documentId) => [
          documentId,
          parsed.finalByDocumentId[documentId] ?? 0,
        ])
      ),
      noEvidenceDocumentIds: parsed.noEvidenceDocumentIds,
    };
  }

  return null;
}

function modeFromModel(model: string | null | undefined): ChatRetrievalMode {
  return model === VECTOR_RETRIEVAL_CHAT_MODEL
    ? "vector_retrieval"
    : "local_retrieval_fallback";
}

function statusHintFromModel(
  model: string | null | undefined
): OutputStatusV1 | undefined {
  if (model === NON_DOCUMENT_CHAT_MODEL) {
    return "non_document";
  }

  if (model === MULTI_SOURCE_NARROWING_MODEL) {
    return "narrowing_required";
  }

  if (model === AI_CHAT_INSUFFICIENT_MODEL) {
    return "insufficient_evidence";
  }

  return undefined;
}

function defaultOutputTemplate(): OutputTemplateSelection {
  return outputTemplateSelectionFromEntry(DEFAULT_CHAT_OUTPUT_TEMPLATE);
}

function buildOutputForFinalResponse(input: {
  threadId: string;
  messageId?: string;
  requestKey?: string | null;
  answer: string;
  citations: ChatCitationData[];
  coverage: EvidenceCoverageV1 | null;
  retrievalWarnings: string[];
  mode: ChatRetrievalMode;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  generatedAt: Date;
  outputTemplate: OutputTemplateSelection;
  scoreThreshold?: number;
  statusHint?: OutputStatusV1;
}): StructuredChatOutputV1 {
  return buildStructuredChatOutputV1({
    threadId: input.threadId,
    messageId: input.messageId,
    requestKey: input.requestKey,
    answer: input.answer,
    citations: input.citations,
    coverage: input.coverage,
    retrievalWarnings: input.retrievalWarnings,
    mode: input.mode,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    responseMode: M3_RAG_RESPONSE_MODE,
    outputTemplate: input.outputTemplate,
    scoreThreshold: input.scoreThreshold,
    statusHint: input.statusHint,
    generatedAt: input.generatedAt,
  });
}

async function enrichCitationsWithFilenames(
  citations: ChatCitationData[],
  firmId: string
): Promise<ChatCitationData[]> {
  const documentIds = [...new Set(citations.map((citation) => citation.documentId))];
  if (documentIds.length === 0) {
    return citations;
  }

  const documents = await prisma.document.findMany({
    where: {
      id: { in: documentIds },
      firmId,
    },
    select: {
      id: true,
      originalName: true,
      filename: true,
    },
  });
  const filenameById = new Map(
    documents.map((document) => [
      document.id,
      document.originalName || document.filename,
    ])
  );

  return citations.map((citation) => ({
    ...citation,
    filename: filenameById.get(citation.documentId),
  }));
}

function isSimpleNonDocumentMessage(message: string): boolean {
  const normalized = message
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");

  const exactConversationalMessages = [
    "hi",
    "hi everyone",
    "hello",
    "hey",
    "yo",
    "hola",
    "hi there",
    "hello there",
    "good morning",
    "good afternoon",
    "good evening",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "help",
    "what can you do",
    "what can you help me with",
    "how can you help",
  ];
  if (exactConversationalMessages.includes(normalized)) {
    return true;
  }

  const hasDocumentIntentHint =
    /\b(?:document|documents|source|sources|file|files|pdf|return|returns|tax|taxpayer|form|forms|wage|wages|income|deduction|refund|credit|irs|1040|w-?2)\b/.test(
      normalized
    );
  const generalHelpPrompt =
    /^(?:can you |could you |please )?(?:help|what can you help|what can you do|how can you help)\b/.test(
      normalized
    );

  return generalHelpPrompt && !hasDocumentIntentHint;
}

function createNonDocumentAnswer(): string {
  return "Hi. Ask a question about the selected documents, and I will answer using only the uploaded evidence.";
}

function isBroadMultiSourceQuestion(message: string): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  const explicitBroadPhrase = [
    "compare",
    "comparison",
    "summarize these",
    "summarize the selected",
    "summarize selected",
    "summarize all",
    "all selected",
    "each selected",
    "for each",
    "across all",
    "between these",
    "list for each",
  ].some((phrase) => normalized.includes(phrase));
  const selectedPluralScope =
    /\b(?:selected|these|all)\s+(?:source|sources|document|documents|return|returns|pdf|pdfs)\b/.test(
      normalized
    ) ||
    /\b(?:source|sources|document|documents|return|returns|pdf|pdfs)\s+(?:selected|chosen)\b/.test(
      normalized
    );
  const broadAction =
    /\b(?:summarize|summary|overview|compare|comparison|list|give me|show me|what are|names|taxpayer names|wages|filing status|amounts|values)\b/.test(
      normalized
    );

  return explicitBroadPhrase || (selectedPluralScope && broadAction);
}

function createNarrowingAnswer(selectedCount: number): string {
  return [
    `You currently have ${selectedCount} documents selected.`,
    `For a reliable comparison or per-document summary, please select up to ${MAX_MULTI_SOURCE_SYNTHESIS_DOCUMENTS} documents or ask a narrower question about a specific return, taxpayer, form, page, or field.`,
  ].join(" ");
}

function emptyCoverage(documentIds: string[] = []): ChatEvidenceCoverage {
  return {
    version: 1,
    selectedDocumentIds: documentIds,
    retrievedByDocumentId: Object.fromEntries(documentIds.map((id) => [id, 0])),
    finalByDocumentId: Object.fromEntries(documentIds.map((id) => [id, 0])),
    noEvidenceDocumentIds: [...documentIds],
  };
}

function coverageForFinalCitations(
  coverage: ChatEvidenceCoverage,
  citations: ChatCitationData[]
): ChatEvidenceCoverage {
  const finalCounts = new Map(
    coverage.selectedDocumentIds.map((documentId) => [documentId, 0])
  );
  for (const citation of citations) {
    if (finalCounts.has(citation.documentId)) {
      finalCounts.set(
        citation.documentId,
        (finalCounts.get(citation.documentId) ?? 0) + 1
      );
    }
  }

  const finalByDocumentId = Object.fromEntries(finalCounts);
  return {
    ...coverage,
    finalByDocumentId,
    noEvidenceDocumentIds: coverage.selectedDocumentIds.filter(
      (documentId) => (finalCounts.get(documentId) ?? 0) === 0
    ),
  };
}

function appendNoEvidenceCoverageNote(input: {
  answer: string;
  coverage: ChatEvidenceCoverage;
  documentLabelsById: Map<string, string>;
}): string {
  if (
    input.coverage.selectedDocumentIds.length < 2 ||
    input.coverage.noEvidenceDocumentIds.length === 0 ||
    isInsufficientEvidenceText(input.answer)
  ) {
    return input.answer;
  }

  const missingLabels = input.coverage.noEvidenceDocumentIds.map(
    (documentId) => input.documentLabelsById.get(documentId) ?? documentId
  );
  const note = `No supporting evidence for the requested field was found in: ${missingLabels.join(", ")}.`;
  if (input.answer.includes(note)) {
    return input.answer;
  }

  return `${input.answer.trim()}\n\n${note}`;
}

function supportedResultsForMode(input: {
  results: LocalRetrievalResult[];
  mode: ChatRetrievalMode;
  minScore: number;
}): LocalRetrievalResult[] {
  return input.mode === "vector_retrieval"
    ? input.results.filter((result) => result.score >= input.minScore)
    : input.results;
}

function uniqueByChunkId(results: LocalRetrievalResult[]): LocalRetrievalResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.chunk.chunkId)) {
      return false;
    }
    seen.add(result.chunk.chunkId);
    return true;
  });
}

function selectFinalMultiDocumentResults(input: {
  documentIds: string[];
  perDocument: Array<{
    documentId: string;
    mode: ChatRetrievalMode;
    results: LocalRetrievalResult[];
    supportedResults: LocalRetrievalResult[];
  }>;
  broadQuestion: boolean;
}): {
  finalResults: LocalRetrievalResult[];
  coverage: ChatEvidenceCoverage;
} {
  const finalResults: LocalRetrievalResult[] = [];
  const finalCountByDocument = new Map(input.documentIds.map((id) => [id, 0]));
  const retrievedByDocumentId = Object.fromEntries(
    input.perDocument.map((doc) => [doc.documentId, doc.results.length])
  );
  function addResult(result: LocalRetrievalResult): void {
    if (finalResults.some((item) => item.chunk.chunkId === result.chunk.chunkId)) {
      return;
    }
    const currentCount = finalCountByDocument.get(result.chunk.documentId) ?? 0;
    if (currentCount >= MAX_FINAL_RESULTS_PER_DOCUMENT) {
      return;
    }
    if (finalResults.length >= FINAL_CONTEXT_RESULT_LIMIT) {
      return;
    }

    finalResults.push(result);
    finalCountByDocument.set(result.chunk.documentId, currentCount + 1);
  }

  for (const doc of input.perDocument) {
    const primary =
      doc.supportedResults[0] ??
      (input.broadQuestion ? doc.results[0] : undefined);
    if (primary) {
      addResult(primary);
    }
  }

  if (input.broadQuestion) {
    const candidateLists = input.perDocument.map((doc) =>
      uniqueByChunkId([...doc.supportedResults, ...doc.results])
    );
    const maxCandidateLength = Math.max(
      0,
      ...candidateLists.map((candidates) => candidates.length)
    );
    for (let index = 1; index < maxCandidateLength; index += 1) {
      for (const candidates of candidateLists) {
        const result = candidates[index];
        if (result) {
          addResult(result);
        }
      }
    }
  } else {
    const remainingSupported = uniqueByChunkId(
      input.perDocument.flatMap((doc) => doc.supportedResults.slice(1))
    ).sort((left, right) => right.score - left.score);
    for (const result of remainingSupported) {
      addResult(result);
    }
  }

  const finalByDocumentId = Object.fromEntries(
    input.documentIds.map((id) => [id, finalCountByDocument.get(id) ?? 0])
  );

  return {
    finalResults,
    coverage: {
      version: 1,
      selectedDocumentIds: input.documentIds,
      retrievedByDocumentId,
      finalByDocumentId,
      noEvidenceDocumentIds: input.documentIds.filter(
        (id) => (finalCountByDocument.get(id) ?? 0) === 0
      ),
    },
  };
}

// Only sub-split a single sentence/line when it is unusually long, so a whole
// sentence (and any "Label: value" or "[S1]" marker inside it) is replayed as
// one delta in the common case.
const REPLAY_LONG_SEGMENT_CHARS = 180;

/**
 * Split an already-validated answer into ordered chunks for progressive
 * "streaming" replay. This never alters content — `chunks.join("") === answer`.
 *
 * Boundaries are chosen so markdown and grounding stay intact: fenced code
 * blocks are kept atomic; otherwise we break on sentence terminators and line
 * breaks (whole sentences/lines stay together), and only sub-split an
 * over-long segment on whitespace runs (never mid-word, never inside a `[S1]`
 * citation marker). Trailing whitespace stays attached to the preceding token
 * so concatenation reproduces the original text exactly.
 */
function chunkForReplay(answer: string): string[] {
  if (answer.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  const flushSegment = (segment: string): void => {
    if (segment.length === 0) {
      return;
    }
    if (segment.length <= REPLAY_LONG_SEGMENT_CHARS) {
      chunks.push(segment);
      return;
    }

    // Over-long segment: group whole words up to the budget without splitting
    // words or citation markers.
    const tokens = segment.match(/\S+\s*|\s+/g) ?? [segment];
    let current = "";
    for (const token of tokens) {
      if (
        current.length > 0 &&
        current.length + token.length > REPLAY_LONG_SEGMENT_CHARS
      ) {
        chunks.push(current);
        current = "";
      }
      current += token;
    }
    if (current.length > 0) {
      chunks.push(current);
    }
  };

  // Segment into fenced code blocks (atomic) and prose runs.
  const segments = answer.split(/(```[\s\S]*?```)/g).filter((part) => part.length > 0);
  for (const segment of segments) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      chunks.push(segment);
      continue;
    }

    // Break prose on sentence terminators and line breaks, keeping the
    // delimiter (and trailing whitespace) attached to the preceding text.
    const pieces = segment.match(/[\s\S]*?(?:[.!?]+(?=\s|$)|\n|$)\s*/g) ?? [segment];
    for (const piece of pieces) {
      flushSegment(piece);
    }
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function buildCitationRepairPrompt(input: {
  question: string;
  context: string;
  draftAnswer: string;
}): string {
  return [
    "Rewrite the draft answer so it follows the citation contract exactly.",
    "",
    "Rules:",
    "- Use only the retrieved context below.",
    "- Every factual claim from the documents must include one or more valid source markers such as [S1].",
    "- Use only source markers that appear in the retrieved context.",
    "- If the context does not support the answer, respond exactly: I could not find enough support in the uploaded documents to answer that question.",
    "",
    "Retrieved context:",
    input.context,
    "",
    `Question: ${input.question}`,
    "",
    "Draft answer:",
    input.draftAnswer,
  ].join("\n");
}

const LOCAL_RETRIEVAL_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "did",
  "does",
  "do",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "appears",
  "appear",
  "about",
  "against",
  "all",
  "across",
  "compare",
  "comparison",
  "each",
  "give",
  "have",
  "into",
  "me",
  "return",
  "returns",
  "selected",
  "that",
  "these",
  "those",
  "this",
  "which",
  "with",
]);

function significantQueryTerms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9$]+/g)
    .map((term) => term.trim())
    .filter(
      (term) =>
        term.length >= 3 &&
        !LOCAL_RETRIEVAL_STOP_WORDS.has(term) &&
        !/^\d+$/.test(term)
    );
}

function hasLocalRetrievalSupport(input: {
  question: string;
  results: NonNullable<PersistedBaseDocumentRetrievalOutput["results"]>;
}): boolean {
  const terms = significantQueryTerms(input.question);
  if (terms.length === 0) {
    return false;
  }

  const evidenceText = input.results
    .map((result) => `${result.snippet} ${result.snippetFull ?? result.chunk.content}`)
    .join(" ")
    .toLowerCase();
  const matchedTerms = terms.filter((term) => evidenceText.includes(term));

  if (terms.length === 1) {
    return matchedTerms.length === 1;
  }

  return matchedTerms.length >= 2 || matchedTerms.length / terms.length >= 0.5;
}

function chatResponse(input: {
  threadId: string;
  userMessage: PersistedChatMessage;
  assistantMessage: PersistedChatMessage;
  retrievalWarnings: string[];
  mode?: ChatRetrievalMode;
  outputTemplate: OutputTemplateSelection;
  scoreThreshold?: number;
  statusHint?: OutputStatusV1;
}) {
  const coverage = coverageFromMessage(input.assistantMessage);
  const publicOutput = finalizePublicChatOutput(
    input.assistantMessage.content,
    citationsFromMessage(input.assistantMessage) as ChatCitationData[]
  );
  const mode = input.mode ?? modeFromModel(input.assistantMessage.model);
  const assistantMessage = {
    ...input.assistantMessage,
    content: publicOutput.answer,
    citations: publicOutput.citations,
  };
  const output = buildOutputForFinalResponse({
    threadId: input.threadId,
    messageId: assistantMessage.id,
    requestKey: assistantMessage.requestKey,
    answer: publicOutput.answer,
    citations: publicOutput.citations,
    coverage,
    retrievalWarnings: input.retrievalWarnings,
    mode,
    model: assistantMessage.model,
    inputTokens: assistantMessage.inputTokens,
    outputTokens: assistantMessage.outputTokens,
    generatedAt: assistantMessage.createdAt,
    outputTemplate: input.outputTemplate,
    scoreThreshold: input.scoreThreshold,
    statusHint: input.statusHint ?? statusHintFromModel(assistantMessage.model),
  });

  return Response.json({
    threadId: input.threadId,
    userMessage: input.userMessage,
    assistantMessage,
    answer: publicOutput.answer,
    citations: publicOutput.citations,
    coverage,
    retrievalWarnings: input.retrievalWarnings,
    mode,
    insufficientEvidence:
      output.status === "insufficient_evidence" || publicOutput.citations.length === 0,
    output,
  });
}

async function retrieveChatEvidence(input: {
  firmId: string;
  userId: string;
  query: string;
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: { start: number; end: number };
  keepLowScoreVectorMatches?: boolean;
}): Promise<{
  retrieval: PersistedBaseDocumentRetrievalOutput | VectorDocumentRetrievalOutput;
  mode: ChatRetrievalMode;
  model: string;
}> {
  const providerConfig = readM3ProviderConfig();

  if (providerConfig.vectorRetrievalEnabled) {
    if (providerConfig.validationErrors.length > 0) {
      throw new Error(
        `Invalid M3 provider config: ${providerConfig.validationErrors.join("; ")}`
      );
    }

    try {
      const retrieval = await retrieveVectorDocumentChunks({
        firmId: input.firmId,
        query: input.query,
        documentIds: input.documentIds,
        formTypes: input.formTypes,
        pageRange: input.pageRange,
        topK: 30,
        config: providerConfig,
        userId: input.userId,
      });
      const minScore = providerConfig.vectorMinScore ?? 0.25;
      const hasSupportedMatch = retrieval.results.some(
        (result) => result.score >= minScore
      );
      if (!hasSupportedMatch) {
        logger.warn("chat.vector_retrieval_no_supported_matches_fallback", {
          firmId: input.firmId,
          userId: input.userId,
          retrievedCount: retrieval.results.length,
          minScore,
          keepLowScoreVectorMatches: input.keepLowScoreVectorMatches === true,
        });
        if (input.keepLowScoreVectorMatches && retrieval.results.length > 0) {
          return {
            retrieval,
            mode: "vector_retrieval",
            model: VECTOR_RETRIEVAL_CHAT_MODEL,
          };
        }
      } else {
        return {
          retrieval,
          mode: "vector_retrieval",
          model: VECTOR_RETRIEVAL_CHAT_MODEL,
        };
      }
    } catch (error) {
      logger.warn("chat.vector_retrieval_failed_fallback", {
        firmId: input.firmId,
        userId: input.userId,
        error,
      });
    }
  }

  return {
    retrieval: await retrievePersistedBaseDocumentChunks({
      firmId: input.firmId,
      query: input.query,
      documentIds: input.documentIds,
      formTypes: input.formTypes,
      pageRange: input.pageRange,
      topK: 30,
      maxCandidateChunks: 5000,
    }),
    mode: "local_retrieval_fallback",
    model: LOCAL_CHAT_MODEL,
  };
}

async function selectChatEvidence(input: {
  firmId: string;
  userId: string;
  query: string;
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: { start: number; end: number };
  minScore: number;
}): Promise<ChatEvidenceSelection> {
  const selectedDocumentIds = [...new Set(input.documentIds ?? [])];
  const broadQuestion = isBroadMultiSourceQuestion(input.query);

  if (
    selectedDocumentIds.length > MAX_MULTI_SOURCE_SYNTHESIS_DOCUMENTS &&
    broadQuestion
  ) {
    return {
      finalResults: [],
      warnings: [],
      mode: "local_retrieval_fallback",
      model: MULTI_SOURCE_NARROWING_MODEL,
      coverage: emptyCoverage(selectedDocumentIds),
      narrowingAnswer: createNarrowingAnswer(selectedDocumentIds.length),
    };
  }

  if (selectedDocumentIds.length >= 2) {
    const perDocumentEvidence = await Promise.all(
      selectedDocumentIds.map(async (documentId) => {
        const evidence = await retrieveChatEvidence({
          firmId: input.firmId,
          userId: input.userId,
          query: input.query,
          documentIds: [documentId],
          formTypes: input.formTypes,
          pageRange: input.pageRange,
          keepLowScoreVectorMatches: broadQuestion,
        });
        const results = evidence.retrieval.results;
        return {
          documentId,
          mode: evidence.mode,
          model: evidence.model,
          warnings: evidence.retrieval.warnings,
          results,
          supportedResults: supportedResultsForMode({
            results,
            mode: evidence.mode,
            minScore: input.minScore,
          }),
        };
      })
    );
    const selected = selectFinalMultiDocumentResults({
      documentIds: selectedDocumentIds,
      perDocument: perDocumentEvidence,
      broadQuestion,
    });
    const usesVector = perDocumentEvidence.some(
      (item) => item.mode === "vector_retrieval"
    );

    return {
      finalResults: selected.finalResults,
      warnings: perDocumentEvidence.flatMap((item) => item.warnings),
      mode: usesVector ? "vector_retrieval" : "local_retrieval_fallback",
      model: usesVector ? VECTOR_RETRIEVAL_CHAT_MODEL : LOCAL_CHAT_MODEL,
      coverage: selected.coverage,
    };
  }

  const evidence = await retrieveChatEvidence({
    firmId: input.firmId,
    userId: input.userId,
    query: input.query,
    documentIds: input.documentIds,
    formTypes: input.formTypes,
    pageRange: input.pageRange,
  });
  const supportedResults = supportedResultsForMode({
    results: evidence.retrieval.results,
    mode: evidence.mode,
    minScore: input.minScore,
  });
  const finalResults = supportedResults.slice(0, FINAL_CONTEXT_RESULT_LIMIT);
  const inferredDocumentIds =
    selectedDocumentIds.length > 0
      ? selectedDocumentIds
      : [...new Set(finalResults.map((result) => result.chunk.documentId))];

  return {
    finalResults,
    warnings: evidence.retrieval.warnings,
    mode: evidence.mode,
    model: evidence.model,
    coverage: {
      version: 1,
      selectedDocumentIds: inferredDocumentIds,
      retrievedByDocumentId: Object.fromEntries(
        inferredDocumentIds.map((id) => [
          id,
          evidence.retrieval.results.filter(
            (result) => result.chunk.documentId === id
          ).length,
        ])
      ),
      finalByDocumentId: Object.fromEntries(
        inferredDocumentIds.map((id) => [
          id,
          finalResults.filter((result) => result.chunk.documentId === id).length,
        ])
      ),
      noEvidenceDocumentIds: inferredDocumentIds.filter(
        (id) => !finalResults.some((result) => result.chunk.documentId === id)
      ),
    },
  };
}

function streamPersistedText(input: {
  text: string;
  threadId: string;
  messageId?: string;
  requestKey?: string | null;
  citations: ChatCitationData[];
  model: string;
  coverage?: EvidenceCoverageV1 | null;
  mode: ChatRetrievalMode;
  retrievalWarnings: string[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  generatedAt: Date;
  outputTemplate: OutputTemplateSelection;
  scoreThreshold?: number;
  statusHint?: OutputStatusV1;
  documentFilter?: ParsedChatRequest["documentFilter"] | null;
}): Response {
  const publicOutput = finalizePublicChatOutput(input.text, input.citations);
  const output = buildOutputForFinalResponse({
    threadId: input.threadId,
    messageId: input.messageId,
    requestKey: input.requestKey,
    answer: publicOutput.answer,
    citations: publicOutput.citations,
    coverage: input.coverage ?? null,
    retrievalWarnings: input.retrievalWarnings,
    mode: input.mode,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    generatedAt: input.generatedAt,
    outputTemplate: input.outputTemplate,
    scoreThreshold: input.scoreThreshold,
    statusHint: input.statusHint,
  });
  const textId = `text-${crypto.randomUUID()}`;
  const stream = createUIMessageStream<TrueBlueChatMessage>({
    execute({ writer }) {
      writer.write({
        type: "data-thread",
        data: {
          threadId: input.threadId,
          responseMode: M3_RAG_RESPONSE_MODE,
          documentFilter: input.documentFilter ?? null,
        },
      });
      writer.write({
        type: "data-citations",
        data: { citations: publicOutput.citations },
      });
      if (input.coverage?.version === 1) {
        writer.write({
          type: "data-coverage",
          data: { coverage: input.coverage },
        });
      }
      writer.write({
        type: "data-output",
        data: { output },
      });
      writer.write({
        type: "text-start",
        id: textId,
      });
      // Chunk-replay the already-validated answer so the client renders it
      // progressively. Only validated content is ever emitted — the entire
      // grounding/validation pipeline ran before this point.
      for (const delta of chunkForReplay(publicOutput.answer)) {
        writer.write({
          type: "text-delta",
          id: textId,
          delta,
        });
      }
      writer.write({
        type: "text-end",
        id: textId,
      });
      writer.write({
        type: "data-usage",
        data: {
          model: input.model,
          ...(input.inputTokens !== null && input.inputTokens !== undefined
            ? { inputTokens: input.inputTokens }
            : {}),
          ...(input.outputTokens !== null && input.outputTokens !== undefined
            ? { outputTokens: input.outputTokens }
            : {}),
        },
      });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

async function streamAiChatResponse(input: {
  threadId: string;
  userId: string;
  firmId: string;
  userMessage: PersistedChatMessage;
  question: string;
  history: PersistedChatMessage[];
  finalResults: NonNullable<
    PersistedBaseDocumentRetrievalOutput["results"]
  >;
  citations: ChatCitationData[];
  coverage: ChatEvidenceCoverage;
  model: string;
  requestKey?: string;
  retrievalWarnings: string[];
  mode: ChatRetrievalMode;
  outputTemplate: OutputTemplateSelection;
  scoreThreshold?: number;
  startedAt: number;
  documentFilterCount: number;
  documentFilter?: ParsedChatRequest["documentFilter"] | null;
  stream: boolean;
}): Promise<Response> {
  const providerConfig = readM3ProviderConfig();
  if (providerConfig.validationErrors.length > 0) {
    throw new Error(`Invalid M3 provider config: ${providerConfig.validationErrors.join("; ")}`);
  }
  if (!providerConfig.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required when AI chat is enabled");
  }

  const openai = createOpenAI({ apiKey: providerConfig.openAiApiKey });
  const maxOutputTokens =
    input.coverage.selectedDocumentIds.length > 1 ||
    isBroadMultiSourceQuestion(input.question)
      ? 2500
      : 1200;
  const documentLabelsById = new Map(
    input.citations
      .filter((citation) => citation.filename)
      .map((citation) => [citation.documentId, citation.filename as string])
  );
  const ragContext = buildRagContext(input.finalResults, { documentLabelsById });
  const messages = [
    ...persistedMessagesToModelHistory(input.history),
    {
      role: "user" as const,
      content: buildRagUserPrompt({
        question: input.question,
        context: ragContext.context,
        noEvidenceDocumentIds: input.coverage.noEvidenceDocumentIds,
      }),
    },
  ];
  const result = await generateText({
    model: openai(providerConfig.aiModel),
    system: M3_RAG_SYSTEM_PROMPT,
    messages,
    maxOutputTokens,
    temperature: 0,
    seed: 7,
  });

  let finalOutput = finalizePublicChatOutput(result.text.trim(), input.citations);
  let repairUsage:
    | {
        inputTokens?: number;
        outputTokens?: number;
      }
    | undefined;
  if (
    input.citations.length > 0 &&
    finalOutput.usedMarkerCount === 0 &&
    !isInsufficientEvidenceText(finalOutput.answer)
  ) {
    logger.warn("chat.ai_missing_citation_markers", {
      firmId: input.firmId,
      userId: input.userId,
      threadId: input.threadId,
      retrievedCount: input.finalResults.length,
    });

    try {
      const repair = await generateText({
        model: openai(providerConfig.aiModel),
        system: M3_RAG_SYSTEM_PROMPT,
        prompt: buildCitationRepairPrompt({
          question: input.question,
          context: ragContext.context,
          draftAnswer: finalOutput.answer || result.text,
        }),
        maxOutputTokens,
        temperature: 0,
        seed: 7,
      });
      repairUsage = repair.usage;
      finalOutput = finalizePublicChatOutput(repair.text.trim(), input.citations);
    } catch (error) {
      logger.warn("chat.ai_citation_repair_failed", {
        firmId: input.firmId,
        userId: input.userId,
        threadId: input.threadId,
        error,
      });
      finalOutput = {
        answer: createInsufficientEvidenceAnswer(),
        citations: [],
        markerCount: 0,
        invalidMarkerCount: 0,
        usedMarkerCount: 0,
      };
    }
  }

  if (finalOutput.invalidMarkerCount > 0) {
    logger.warn("chat.ai_invalid_citation_markers", {
      firmId: input.firmId,
      userId: input.userId,
      threadId: input.threadId,
      invalidMarkerCount: finalOutput.invalidMarkerCount,
    });
  }

  const sourceContentByMarker = new Map(
    input.finalResults.map((resultItem, index) => [
      `[S${index + 1}]`,
      resultItem.chunk.content,
    ])
  );
  const groundedOutput = enforceNumericGrounding({
    answer: finalOutput.answer,
    citations: finalOutput.citations,
    sourceContentByMarker,
  });
  if (groundedOutput.removedUnsupportedNumericClaims) {
    logger.warn("chat.ai_numeric_grounding_removed_claims", {
      firmId: input.firmId,
      userId: input.userId,
      threadId: input.threadId,
      retrievedCount: input.finalResults.length,
    });
    finalOutput = finalizePublicChatOutput(
      groundedOutput.answer,
      groundedOutput.citations
    );
  }

  let finalAnswer = finalOutput.answer || createInsufficientEvidenceAnswer();
  let finalCitations = finalOutput.citations;
  const failedCitationValidation =
    input.citations.length > 0 &&
    finalOutput.usedMarkerCount === 0 &&
    !isInsufficientEvidenceText(finalAnswer);
  if (failedCitationValidation) {
    logger.warn("chat.ai_citation_validation_failed_closed", {
      firmId: input.firmId,
      userId: input.userId,
      threadId: input.threadId,
      retrievedCount: input.finalResults.length,
    });
    finalAnswer = createInsufficientEvidenceAnswer();
    finalCitations = [];
  } else if (isInsufficientEvidenceText(finalAnswer)) {
    finalAnswer = createInsufficientEvidenceAnswer();
    finalCitations = [];
  }

  const usage = result.usage;
  const inputTokens =
    (usage?.inputTokens ?? 0) + (repairUsage?.inputTokens ?? 0) || null;
  const outputTokens =
    (usage?.outputTokens ?? 0) + (repairUsage?.outputTokens ?? 0) || null;
  const finalCoverage = coverageForFinalCitations(input.coverage, finalCitations);
  finalAnswer = appendNoEvidenceCoverageNote({
    answer: finalAnswer,
    coverage: finalCoverage,
    documentLabelsById,
  });
  const assistantMessage = await appendAssistantMessageToThread({
    firmId: input.firmId,
    userId: input.userId,
    threadId: input.threadId,
    content: finalAnswer,
    retrievedChunkIds: input.finalResults.map((resultItem) => resultItem.chunk.chunkId),
    citations: finalCitations,
    evidenceCoverage: finalCoverage,
    model: input.model,
    inputTokens,
    outputTokens,
    requestKey: input.requestKey,
  });
  const output = buildOutputForFinalResponse({
    threadId: input.threadId,
    messageId: assistantMessage.id,
    requestKey: assistantMessage.requestKey,
    answer: finalAnswer,
    citations: finalCitations,
    coverage: finalCoverage,
    retrievalWarnings: input.retrievalWarnings,
    mode: input.mode,
    model: assistantMessage.model ?? input.model,
    inputTokens: assistantMessage.inputTokens,
    outputTokens: assistantMessage.outputTokens,
    generatedAt: assistantMessage.createdAt,
    outputTemplate: input.outputTemplate,
    scoreThreshold: input.scoreThreshold,
    statusHint: statusHintFromModel(assistantMessage.model),
  });

  logger.info("chat.completed", {
    firmId: input.firmId,
    userId: input.userId,
    threadId: input.threadId,
    hasDocumentFilter: input.documentFilterCount > 0,
    documentFilterCount: input.documentFilterCount,
    retrievedCount: input.finalResults.length,
    citedCount: finalCitations.length,
    insufficientEvidence: output.status === "insufficient_evidence",
    warningCount: input.retrievalWarnings.length,
    durationMs: Date.now() - input.startedAt,
    mode: input.mode,
    model: assistantMessage.model ?? input.model,
    responseMode: M3_RAG_RESPONSE_MODE,
    evidenceCoverage: finalCoverage,
    outputStatus: output.status,
    outputSchemaVersion: output.schemaVersion,
    templateId: output.templateId,
  });

  if (input.stream) {
    return streamPersistedText({
      text: finalAnswer,
      threadId: input.threadId,
      messageId: assistantMessage.id,
      requestKey: assistantMessage.requestKey,
      citations: finalCitations,
      model: assistantMessage.model ?? input.model,
      coverage: finalCoverage,
      mode: input.mode,
      retrievalWarnings: input.retrievalWarnings,
      inputTokens: assistantMessage.inputTokens,
      outputTokens: assistantMessage.outputTokens,
      generatedAt: assistantMessage.createdAt,
      outputTemplate: input.outputTemplate,
      scoreThreshold: input.scoreThreshold,
      statusHint: output.status,
      documentFilter: input.documentFilter,
    });
  }

  return chatResponse({
    threadId: input.threadId,
    userMessage: input.userMessage,
    assistantMessage,
    retrievalWarnings: input.retrievalWarnings,
    mode: input.mode,
    outputTemplate: input.outputTemplate,
    scoreThreshold: input.scoreThreshold,
    statusHint: output.status,
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const ctx = await getFirmScopedRequestContext();
    if (!ctx) {
      return unauthorized();
    }

    if (!hasPermission(ctx.role, "query_documents")) {
      return forbidden("You do not have permission to query documents");
    }

    const rateLimit = checkChatRateLimits({
      firmId: ctx.firmId,
      userId: ctx.userId,
    });
    if (!rateLimit.allowed) {
      logger.warn("chat.rate_limited", {
        firmId: ctx.firmId,
        userId: ctx.userId,
        limit: rateLimit.limit,
        resetAt: new Date(rateLimit.resetAt).toISOString(),
      });
      return tooManyRequests("Chat rate limit exceeded. Please try again shortly.");
    }

    let parsed;
    try {
      parsed = parseChatRequestBody(await request.json());
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : "Invalid chat request");
    }
    const loadedThread = parsed.threadId
      ? await loadChatThreadForUser({
          firmId: ctx.firmId,
          userId: ctx.userId,
          threadId: parsed.threadId,
          messageLimit: MAX_CHAT_HISTORY_MESSAGES,
        })
      : null;

    if (parsed.threadId && !loadedThread) {
      return badRequest("Chat thread not found");
    }

    const initialOutputTemplate = parsed.threadId
      ? outputTemplateSelectionFromPersisted(loadedThread?.outputTemplate)
      : (parsed.outputTemplate ?? defaultOutputTemplate());
    let activeFilter = parsed.threadId
      ? ((loadedThread?.documentFilter as ParsedChatRequest["documentFilter"]) ??
        null)
      : (parsed.documentFilter ?? null);
    const requestFingerprint = stableChatRequestFingerprint({
      threadId: parsed.threadId,
      content: parsed.message.content,
      documentFilter: activeFilter,
      fingerprintOutputTemplate:
        !parsed.threadId &&
        parsed.outputTemplate?.templateId !== defaultOutputTemplate().templateId
          ? parsed.outputTemplate
          : undefined,
    });
    const userRequestKey = scopedRequestKey(
      parsed.requestKey,
      requestFingerprint,
      "user"
    );

    const thread =
      loadedThread ??
      (await createChatThreadWithUserMessage({
        firmId: ctx.firmId,
        userId: ctx.userId,
        messageContent: parsed.message.content,
        documentFilter: activeFilter,
        outputTemplate: initialOutputTemplate,
        requestKey: userRequestKey,
      }));

    if (!thread) {
      return badRequest("Chat thread not found");
    }
    activeFilter =
      (thread.documentFilter as ParsedChatRequest["documentFilter"]) ?? activeFilter;
    const activeOutputTemplate = outputTemplateSelectionFromPersisted(
      thread.outputTemplate ?? initialOutputTemplate
    );

    const userMessage = parsed.threadId
      ? await appendUserMessageToThread({
          firmId: ctx.firmId,
          userId: ctx.userId,
          threadId: thread.id,
          messageContent: parsed.message.content,
          requestKey: userRequestKey,
        })
      : thread.messages[0];
    const assistantRequestKey = scopedRequestKey(
      parsed.requestKey,
      requestFingerprint,
      "assistant"
    );

    const existingAssistantMessage = await loadAssistantMessageByRequestKey({
      firmId: ctx.firmId,
      userId: ctx.userId,
      threadId: thread.id,
      requestKey: assistantRequestKey,
    });
    if (existingAssistantMessage) {
      const providerConfig = readM3ProviderConfig();
      if (parsed.transport === "assistant_ui") {
        return streamPersistedText({
          text: existingAssistantMessage.content,
          threadId: thread.id,
          messageId: existingAssistantMessage.id,
          requestKey: existingAssistantMessage.requestKey,
          citations: citationsFromMessage(existingAssistantMessage) as ChatCitationData[],
          model: existingAssistantMessage.model ?? providerConfig.aiModel,
          coverage: coverageFromMessage(existingAssistantMessage),
          mode: modeFromModel(existingAssistantMessage.model),
          retrievalWarnings: [],
          inputTokens: existingAssistantMessage.inputTokens,
          outputTokens: existingAssistantMessage.outputTokens,
          generatedAt: existingAssistantMessage.createdAt,
          outputTemplate: activeOutputTemplate,
          scoreThreshold: providerConfig.vectorMinScore,
          statusHint: statusHintFromModel(existingAssistantMessage.model),
          documentFilter: activeFilter,
        });
      }

      return chatResponse({
        threadId: thread.id,
        userMessage,
        assistantMessage: existingAssistantMessage,
        retrievalWarnings: [],
        mode: modeFromModel(existingAssistantMessage.model),
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        statusHint: statusHintFromModel(existingAssistantMessage.model),
      });
    }

    let evidenceSelection: ChatEvidenceSelection;
    const providerConfig = readM3ProviderConfig();
    const shouldStreamResponse = parsed.transport === "assistant_ui";

    if (isSimpleNonDocumentMessage(parsed.message.content)) {
      const answer = createNonDocumentAnswer();
      const nonDocumentCoverage = emptyCoverage(activeFilter?.documentIds ?? []);
      const assistantMessage = await appendAssistantMessageToThread({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        content: answer,
        retrievedChunkIds: [],
        citations: [],
        evidenceCoverage: nonDocumentCoverage,
        model: NON_DOCUMENT_CHAT_MODEL,
        requestKey: assistantRequestKey,
      });
      const nonDocumentOutput = buildOutputForFinalResponse({
        threadId: thread.id,
        messageId: assistantMessage.id,
        requestKey: assistantMessage.requestKey,
        answer,
        citations: [],
        coverage: nonDocumentCoverage,
        retrievalWarnings: [],
        mode: "local_retrieval_fallback",
        model: assistantMessage.model ?? NON_DOCUMENT_CHAT_MODEL,
        inputTokens: assistantMessage.inputTokens,
        outputTokens: assistantMessage.outputTokens,
        generatedAt: assistantMessage.createdAt,
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        statusHint: "non_document",
      });

      logger.info("chat.completed", {
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        hasDocumentFilter: Boolean(activeFilter),
        documentFilterCount: activeFilter?.documentIds?.length ?? 0,
        retrievedCount: 0,
        citedCount: 0,
        insufficientEvidence: true,
        warningCount: 0,
        durationMs: Date.now() - startedAt,
        mode: "local_retrieval_fallback",
        model: NON_DOCUMENT_CHAT_MODEL,
        responseMode: M3_RAG_RESPONSE_MODE,
        outputStatus: nonDocumentOutput.status,
        outputSchemaVersion: nonDocumentOutput.schemaVersion,
        templateId: nonDocumentOutput.templateId,
      });

      if (shouldStreamResponse) {
        return streamPersistedText({
          text: answer,
          threadId: thread.id,
          messageId: assistantMessage.id,
          requestKey: assistantMessage.requestKey,
          citations: [],
          model: assistantMessage.model ?? NON_DOCUMENT_CHAT_MODEL,
          coverage: nonDocumentCoverage,
          mode: "local_retrieval_fallback",
          retrievalWarnings: [],
          inputTokens: assistantMessage.inputTokens,
          outputTokens: assistantMessage.outputTokens,
          generatedAt: assistantMessage.createdAt,
          outputTemplate: activeOutputTemplate,
          scoreThreshold: providerConfig.vectorMinScore,
          statusHint: "non_document",
          documentFilter: activeFilter,
        });
      }

      return chatResponse({
        threadId: thread.id,
        userMessage,
        assistantMessage,
        retrievalWarnings: [],
        mode: "local_retrieval_fallback",
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        statusHint: "non_document",
      });
    }

    try {
      evidenceSelection = await selectChatEvidence({
        firmId: ctx.firmId,
        userId: ctx.userId,
        query: parsed.message.content,
        documentIds: activeFilter?.documentIds,
        formTypes: activeFilter?.formTypes,
        pageRange: activeFilter?.pageRange,
        minScore: providerConfig.vectorMinScore ?? 0.25,
      });
    } catch (error) {
      const completedRetryMessage = await loadAssistantMessageByRequestKey({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        requestKey: assistantRequestKey,
      });
      if (completedRetryMessage) {
        return chatResponse({
          threadId: thread.id,
          userMessage,
          assistantMessage: completedRetryMessage,
          retrievalWarnings: [],
          mode: modeFromModel(completedRetryMessage.model),
          outputTemplate: activeOutputTemplate,
          scoreThreshold: providerConfig.vectorMinScore,
          statusHint: statusHintFromModel(completedRetryMessage.model),
        });
      }

      throw error;
    }
    const finalResults = evidenceSelection.finalResults;
    const citations = await enrichCitationsWithFilenames(finalResults.map((result, index) => ({
      marker: `[S${index + 1}]`,
      rank: index + 1,
      chunkId: result.chunk.chunkId,
      documentId: result.chunk.documentId,
      pageStart: result.chunk.pageStart,
      pageEnd: result.chunk.pageEnd,
      snippet: result.snippet,
      snippetFull: result.snippetFull ?? result.chunk.content,
      sourceBlockIds: result.chunk.sourceBlockIds,
      formType: result.chunk.formType,
      contentType: result.chunk.contentType,
      sectionPath: result.chunk.sectionPath,
      tableId: result.chunk.tableId,
      relevanceScore: result.score,
    })), ctx.firmId);
    const localFallbackUnsupported =
      !providerConfig.aiChatEnabled &&
      evidenceSelection.mode === "local_retrieval_fallback" &&
      citations.length > 0 &&
      !hasLocalRetrievalSupport({
        question: parsed.message.content,
        results: finalResults,
      });
    const insufficientEvidence =
      !evidenceSelection.narrowingAnswer &&
      (citations.length === 0 || localFallbackUnsupported);
    if (localFallbackUnsupported) {
      logger.warn("chat.local_retrieval_without_query_overlap", {
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        retrievedCount: finalResults.length,
        mode: evidenceSelection.mode,
      });
    }
    const answer = insufficientEvidence
      ? createInsufficientEvidenceAnswer()
      : evidenceSelection.narrowingAnswer
        ? evidenceSelection.narrowingAnswer
      : buildGroundedLocalAnswer(
          parsed.message.content,
          finalResults.map((result) => result.snippet),
          evidenceSelection.coverage.noEvidenceDocumentIds
        );

    if (evidenceSelection.narrowingAnswer) {
      const narrowingCoverage = coverageForFinalCitations(
        evidenceSelection.coverage,
        []
      );
      const assistantMessage = await appendAssistantMessageToThread({
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        content: answer,
        retrievedChunkIds: [],
        citations: [],
        evidenceCoverage: narrowingCoverage,
        model: MULTI_SOURCE_NARROWING_MODEL,
        requestKey: assistantRequestKey,
      });
      const narrowingOutput = buildOutputForFinalResponse({
        threadId: thread.id,
        messageId: assistantMessage.id,
        requestKey: assistantMessage.requestKey,
        answer,
        citations: [],
        coverage: narrowingCoverage,
        retrievalWarnings: evidenceSelection.warnings,
        mode: evidenceSelection.mode,
        model: assistantMessage.model ?? MULTI_SOURCE_NARROWING_MODEL,
        inputTokens: assistantMessage.inputTokens,
        outputTokens: assistantMessage.outputTokens,
        generatedAt: assistantMessage.createdAt,
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        statusHint: "narrowing_required",
      });

      logger.info("chat.completed", {
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        hasDocumentFilter: Boolean(activeFilter),
        documentFilterCount: activeFilter?.documentIds?.length ?? 0,
        retrievedCount: 0,
        citedCount: 0,
        insufficientEvidence: false,
        warningCount: 0,
        durationMs: Date.now() - startedAt,
        mode: evidenceSelection.mode,
        model: MULTI_SOURCE_NARROWING_MODEL,
        responseMode: M3_RAG_RESPONSE_MODE,
        evidenceCoverage: narrowingCoverage,
        outputStatus: narrowingOutput.status,
        outputSchemaVersion: narrowingOutput.schemaVersion,
        templateId: narrowingOutput.templateId,
      });

      if (shouldStreamResponse) {
        return streamPersistedText({
          text: answer,
          threadId: thread.id,
          messageId: assistantMessage.id,
          requestKey: assistantMessage.requestKey,
          citations: [],
          model: assistantMessage.model ?? MULTI_SOURCE_NARROWING_MODEL,
          coverage: narrowingCoverage,
          mode: evidenceSelection.mode,
          retrievalWarnings: evidenceSelection.warnings,
          inputTokens: assistantMessage.inputTokens,
          outputTokens: assistantMessage.outputTokens,
          generatedAt: assistantMessage.createdAt,
          outputTemplate: activeOutputTemplate,
          scoreThreshold: providerConfig.vectorMinScore,
          statusHint: "narrowing_required",
          documentFilter: activeFilter,
        });
      }

      return chatResponse({
        threadId: thread.id,
        userMessage,
        assistantMessage,
        retrievalWarnings: evidenceSelection.warnings,
        mode: evidenceSelection.mode,
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        statusHint: "narrowing_required",
      });
    }

    if (providerConfig.aiChatEnabled) {
      if (insufficientEvidence) {
        const insufficientCoverage = coverageForFinalCitations(
          evidenceSelection.coverage,
          []
        );
        const assistantMessage = await appendAssistantMessageToThread({
          firmId: ctx.firmId,
          userId: ctx.userId,
          threadId: thread.id,
          content: answer,
          retrievedChunkIds: [],
          citations: [],
          evidenceCoverage: insufficientCoverage,
          model: AI_CHAT_INSUFFICIENT_MODEL,
          requestKey: assistantRequestKey,
        });
        const insufficientOutput = buildOutputForFinalResponse({
          threadId: thread.id,
          messageId: assistantMessage.id,
          requestKey: assistantMessage.requestKey,
          answer,
          citations: [],
          coverage: insufficientCoverage,
          retrievalWarnings: evidenceSelection.warnings,
          mode: evidenceSelection.mode,
          model: assistantMessage.model ?? AI_CHAT_INSUFFICIENT_MODEL,
          inputTokens: assistantMessage.inputTokens,
          outputTokens: assistantMessage.outputTokens,
          generatedAt: assistantMessage.createdAt,
          outputTemplate: activeOutputTemplate,
          scoreThreshold: providerConfig.vectorMinScore,
          statusHint: "insufficient_evidence",
        });

        logger.info("chat.completed", {
          firmId: ctx.firmId,
          userId: ctx.userId,
          threadId: thread.id,
          hasDocumentFilter: Boolean(activeFilter),
          documentFilterCount: activeFilter?.documentIds?.length ?? 0,
          retrievedCount: finalResults.length,
          citedCount: 0,
          insufficientEvidence: true,
          warningCount: evidenceSelection.warnings.length,
          durationMs: Date.now() - startedAt,
          mode: evidenceSelection.mode,
          model: assistantMessage.model,
          responseMode: M3_RAG_RESPONSE_MODE,
          evidenceCoverage: insufficientCoverage,
          outputStatus: insufficientOutput.status,
          outputSchemaVersion: insufficientOutput.schemaVersion,
          templateId: insufficientOutput.templateId,
        });

        if (shouldStreamResponse) {
          return streamPersistedText({
            text: answer,
            threadId: thread.id,
            messageId: assistantMessage.id,
            requestKey: assistantMessage.requestKey,
            citations: [],
            model: AI_CHAT_INSUFFICIENT_MODEL,
            coverage: insufficientCoverage,
            mode: evidenceSelection.mode,
            retrievalWarnings: evidenceSelection.warnings,
            inputTokens: assistantMessage.inputTokens,
            outputTokens: assistantMessage.outputTokens,
            generatedAt: assistantMessage.createdAt,
            outputTemplate: activeOutputTemplate,
            scoreThreshold: providerConfig.vectorMinScore,
            statusHint: "insufficient_evidence",
            documentFilter: activeFilter,
          });
        }

        return chatResponse({
          threadId: thread.id,
          userMessage,
          assistantMessage,
          retrievalWarnings: evidenceSelection.warnings,
          mode: evidenceSelection.mode,
          outputTemplate: activeOutputTemplate,
          scoreThreshold: providerConfig.vectorMinScore,
          statusHint: "insufficient_evidence",
        });
      }

      logger.info("chat.streaming_started", {
        firmId: ctx.firmId,
        userId: ctx.userId,
        threadId: thread.id,
        hasDocumentFilter: Boolean(activeFilter),
        documentFilterCount: activeFilter?.documentIds?.length ?? 0,
        retrievedCount: finalResults.length,
        citedCount: citations.length,
        warningCount: evidenceSelection.warnings.length,
        mode: evidenceSelection.mode,
        model: providerConfig.aiModel,
        responseMode: M3_RAG_RESPONSE_MODE,
        evidenceCoverage: evidenceSelection.coverage,
      });

      return await streamAiChatResponse({
        threadId: thread.id,
        userId: ctx.userId,
        firmId: ctx.firmId,
        userMessage,
        question: parsed.message.content,
        history: loadedThread?.messages ?? [],
        finalResults,
        citations,
        coverage: evidenceSelection.coverage,
        model: providerConfig.aiModel,
        requestKey: assistantRequestKey,
        retrievalWarnings: evidenceSelection.warnings,
        mode: evidenceSelection.mode,
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        startedAt,
        documentFilterCount: activeFilter?.documentIds?.length ?? 0,
        documentFilter: activeFilter,
        stream: shouldStreamResponse,
      });
    }

    const finalizedLocalOutput = insufficientEvidence
      ? {
          answer,
          citations: [] as ChatCitationData[],
          usedMarkerCount: 0,
        }
      : finalizePublicChatOutput(answer, citations);
    const finalLocalAnswer =
      finalizedLocalOutput.citations.length > 0 ||
      isInsufficientEvidenceText(finalizedLocalOutput.answer)
        ? finalizedLocalOutput.answer
        : createInsufficientEvidenceAnswer();
    const finalLocalCitations = isInsufficientEvidenceText(finalLocalAnswer)
      ? []
      : finalizedLocalOutput.citations;
    const finalLocalCoverage = coverageForFinalCitations(
      evidenceSelection.coverage,
      finalLocalCitations
    );

    const assistantMessage = await appendAssistantMessageToThread({
      firmId: ctx.firmId,
      userId: ctx.userId,
      threadId: thread.id,
      content: finalLocalAnswer,
      retrievedChunkIds: finalResults.map((result) => result.chunk.chunkId),
      citations: finalLocalCitations,
      evidenceCoverage: finalLocalCoverage,
      model: evidenceSelection.model,
      requestKey: assistantRequestKey,
    });
    const localOutput = buildOutputForFinalResponse({
      threadId: thread.id,
      messageId: assistantMessage.id,
      requestKey: assistantMessage.requestKey,
      answer: finalLocalAnswer,
      citations: finalLocalCitations,
      coverage: finalLocalCoverage,
      retrievalWarnings: evidenceSelection.warnings,
      mode: evidenceSelection.mode,
      model: assistantMessage.model ?? evidenceSelection.model,
      inputTokens: assistantMessage.inputTokens,
      outputTokens: assistantMessage.outputTokens,
      generatedAt: assistantMessage.createdAt,
      outputTemplate: activeOutputTemplate,
      scoreThreshold: providerConfig.vectorMinScore,
      statusHint: isInsufficientEvidenceText(finalLocalAnswer)
        ? "insufficient_evidence"
        : undefined,
    });

    logger.info("chat.completed", {
      firmId: ctx.firmId,
      userId: ctx.userId,
      threadId: thread.id,
      hasDocumentFilter: Boolean(activeFilter),
      documentFilterCount: activeFilter?.documentIds?.length ?? 0,
      retrievedCount: finalResults.length,
      citedCount: finalLocalCitations.length,
      insufficientEvidence: localOutput.status === "insufficient_evidence",
      warningCount: evidenceSelection.warnings.length,
      durationMs: Date.now() - startedAt,
      mode: evidenceSelection.mode,
      model: evidenceSelection.model,
      evidenceCoverage: finalLocalCoverage,
      outputStatus: localOutput.status,
      outputSchemaVersion: localOutput.schemaVersion,
      templateId: localOutput.templateId,
    });

    if (shouldStreamResponse) {
      return streamPersistedText({
        text: finalLocalAnswer,
        threadId: thread.id,
        messageId: assistantMessage.id,
        requestKey: assistantMessage.requestKey,
        citations: finalLocalCitations,
        model: assistantMessage.model ?? evidenceSelection.model,
        coverage: finalLocalCoverage,
        mode: evidenceSelection.mode,
        retrievalWarnings: evidenceSelection.warnings,
        inputTokens: assistantMessage.inputTokens,
        outputTokens: assistantMessage.outputTokens,
        generatedAt: assistantMessage.createdAt,
        outputTemplate: activeOutputTemplate,
        scoreThreshold: providerConfig.vectorMinScore,
        statusHint: localOutput.status,
        documentFilter: activeFilter,
      });
    }

    return chatResponse({
      threadId: thread.id,
      userMessage,
      assistantMessage,
      retrievalWarnings: evidenceSelection.warnings,
      mode: evidenceSelection.mode,
      outputTemplate: activeOutputTemplate,
      scoreThreshold: providerConfig.vectorMinScore,
      statusHint: localOutput.status,
    });
  } catch (error) {
    if (isExpectedChatError(error)) {
      logger.warn("chat.expected_error", {
        error,
        durationMs: Date.now() - startedAt,
      });
      return badRequest(error instanceof Error ? error.message : "Invalid chat request");
    }

    logger.error("chat.failed", {
      error,
      durationMs: Date.now() - startedAt,
    });
    return internalError("Failed to process chat request");
  }
}
