"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  FileText,
  History,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type MessageState,
  type ThreadMessage,
  useThread,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { UIMessage } from "ai";
import remarkGfm from "remark-gfm";
import { fetchWithAuth } from "@/lib/fetch-with-auth";

type DashboardDocument = {
  id: string;
  originalName: string;
  filename: string;
  status: string;
  pageCount: number | null;
  uploadedById: string;
  updatedAt: string;
};

type ChatDocumentFilter = {
  documentIds?: string[];
  formTypes?: string[];
  pageRange?: {
    start: number;
    end: number;
  };
};

type ChatThreadSummary = {
  id: string;
  title: string;
  documentFilter: ChatDocumentFilter | null;
  sourceCount: number | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

type LoadedChatThread = {
  thread: ChatThreadSummary;
  messages: UIMessage[];
};

type ChatCitation = {
  marker?: string;
  sourceId?: string;
  chunkId: string;
  documentId: string;
  filename?: string;
  pageStart: number;
  pageEnd: number;
  pageLabel?: string;
  snippet: string;
  snippetFull?: string;
  sourceBlockIds: string[];
};

type ChatUser = {
  id: string;
  firmId: string | null;
  role: string | null;
};

type ChatEvidenceCoverageV1 = {
  version: 1;
  selectedDocumentIds: string[];
  retrievedByDocumentId?: Record<string, number>;
  finalByDocumentId: Record<string, number>;
  noEvidenceDocumentIds: string[];
};

type StructuredChatOutputV1 = {
  schemaVersion: "trueblue.chat.output.v1";
  templateId: string;
  templateVersion: number;
  status:
    | "answered"
    | "insufficient_evidence"
    | "narrowing_required"
    | "non_document";
  responseText: string;
  sources: ChatCitation[];
  coverage: ChatEvidenceCoverageV1;
  support: {
    confidenceLabel: "high" | "medium" | "low" | "none";
    confidenceBasis: string;
    retrievalMode: "local_retrieval_fallback" | "vector_retrieval";
    scoreThreshold?: number;
    sourceCount: number;
    selectedDocumentCount: number;
    citedDocumentCount: number;
    retrievalWarningCount: number;
  };
  warnings: Array<{
    code: string;
    message?: string;
    severity: "info" | "warning" | "error";
  }>;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type SourceCoverageStatus = {
  label: "Used" | "No evidence used" | "Selected" | "Unavailable";
  tone: "used" | "noEvidence" | "selected" | "unavailable";
};

const MAX_CHAT_SOURCE_SELECTION = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

function numberRecordFrom(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

function documentIdsFromFilter(filter: unknown): string[] {
  if (!isRecord(filter) || !Array.isArray(filter.documentIds)) {
    return [];
  }

  return filter.documentIds.filter(
    (documentId): documentId is string =>
      typeof documentId === "string" && documentId.length > 0
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPageRange(citation: ChatCitation) {
  if (citation.pageStart === citation.pageEnd) {
    return `Page ${citation.pageStart}`;
  }

  return `Pages ${citation.pageStart}-${citation.pageEnd}`;
}

function formatSourceCount(count: number | null): string {
  if (count === null) {
    return "All sources";
  }

  return `${count} source${count === 1 ? "" : "s"}`;
}

function messageText(message: MessageState): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function messageCitations(message: MessageState): ChatCitation[] {
  return message.content.flatMap((part) => {
    if (part.type !== "data" || part.name !== "citations" || !isRecord(part.data)) {
      return [];
    }

    const citations = part.data.citations;
    return Array.isArray(citations) ? (citations as ChatCitation[]) : [];
  });
}

function parseCoverage(value: unknown): ChatEvidenceCoverageV1 | null {
  const coverage = isRecord(value) && isRecord(value.coverage) ? value.coverage : value;
  if (!isRecord(coverage) || coverage.version !== 1) {
    return null;
  }

  const selectedDocumentIds = stringArrayFrom(coverage.selectedDocumentIds);
  const finalByDocumentId = numberRecordFrom(coverage.finalByDocumentId);
  const noEvidenceDocumentIds = stringArrayFrom(coverage.noEvidenceDocumentIds);
  const retrievedByDocumentId =
    coverage.retrievedByDocumentId === undefined
      ? undefined
      : numberRecordFrom(coverage.retrievedByDocumentId);

  if (
    !selectedDocumentIds ||
    !finalByDocumentId ||
    !noEvidenceDocumentIds ||
    retrievedByDocumentId === null
  ) {
    return null;
  }

  return {
    version: 1,
    selectedDocumentIds,
    retrievedByDocumentId,
    finalByDocumentId,
    noEvidenceDocumentIds,
  };
}

function messageCoverage(
  message: Pick<ThreadMessage, "content"> | Pick<MessageState, "content">
): ChatEvidenceCoverageV1 | null {
  for (const part of message.content) {
    if (part.type !== "data") {
      continue;
    }

    const coverage = parseCoverage(part.data);
    if (coverage) {
      return coverage;
    }
  }

  return null;
}

function parseStructuredOutput(value: unknown): StructuredChatOutputV1 | null {
  const output = isRecord(value) && isRecord(value.output) ? value.output : value;
  if (
    !isRecord(output) ||
    output.schemaVersion !== "trueblue.chat.output.v1" ||
    typeof output.templateId !== "string" ||
    typeof output.templateVersion !== "number" ||
    typeof output.status !== "string" ||
    !isRecord(output.support)
  ) {
    return null;
  }

  const coverage = parseCoverage(output.coverage);
  if (!coverage) {
    return null;
  }

  const sourceCount = output.support.sourceCount;
  const selectedDocumentCount = output.support.selectedDocumentCount;
  const citedDocumentCount = output.support.citedDocumentCount;
  const retrievalWarningCount = output.support.retrievalWarningCount;
  const confidenceLabel = output.support.confidenceLabel;
  const confidenceBasis = output.support.confidenceBasis;
  const retrievalMode = output.support.retrievalMode;
  const scoreThreshold = output.support.scoreThreshold;
  if (
    typeof sourceCount !== "number" ||
    typeof selectedDocumentCount !== "number" ||
    typeof citedDocumentCount !== "number" ||
    typeof retrievalWarningCount !== "number" ||
    typeof confidenceBasis !== "string" ||
    (retrievalMode !== "local_retrieval_fallback" &&
      retrievalMode !== "vector_retrieval") ||
    (scoreThreshold !== undefined && typeof scoreThreshold !== "number") ||
    !["high", "medium", "low", "none"].includes(String(confidenceLabel))
  ) {
    return null;
  }

  const warnings: StructuredChatOutputV1["warnings"] = Array.isArray(output.warnings)
    ? output.warnings.flatMap((warning) =>
        isRecord(warning) && typeof warning.code === "string"
          ? [
              {
                code: warning.code,
                message:
                  typeof warning.message === "string" ? warning.message : undefined,
                severity:
                  warning.severity === "error" ||
                  warning.severity === "warning" ||
                  warning.severity === "info"
                    ? warning.severity
                    : "info",
              },
            ]
          : []
      )
    : [];

  return {
    schemaVersion: "trueblue.chat.output.v1",
    templateId: output.templateId,
    templateVersion: output.templateVersion,
    status: output.status as StructuredChatOutputV1["status"],
    responseText: typeof output.responseText === "string" ? output.responseText : "",
    sources: Array.isArray(output.sources) ? (output.sources as ChatCitation[]) : [],
    coverage,
    support: {
      confidenceLabel: confidenceLabel as StructuredChatOutputV1["support"]["confidenceLabel"],
      confidenceBasis,
      retrievalMode,
      ...(scoreThreshold !== undefined ? { scoreThreshold } : {}),
      sourceCount,
      selectedDocumentCount,
      citedDocumentCount,
      retrievalWarningCount,
    },
    warnings,
    metadata: isRecord(output.metadata) ? output.metadata : {},
    raw: output,
  };
}

function messageOutput(
  message: Pick<ThreadMessage, "content"> | Pick<MessageState, "content">
): StructuredChatOutputV1 | null {
  for (const part of message.content) {
    if (part.type !== "data" || part.name !== "output") {
      continue;
    }

    const output = parseStructuredOutput(part.data);
    if (output) {
      return output;
    }
  }

  return null;
}

function latestAssistantOutput(
  messages: readonly ThreadMessage[]
): StructuredChatOutputV1 | null {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return latestAssistantMessage ? messageOutput(latestAssistantMessage) : null;
}

function latestAssistantCoverage(
  messages: readonly ThreadMessage[]
): ChatEvidenceCoverageV1 | null {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return latestAssistantMessage ? messageCoverage(latestAssistantMessage) : null;
}

function coverageStatusForDocument(input: {
  coverage: ChatEvidenceCoverageV1 | null;
  documentId: string;
  available: boolean;
}): SourceCoverageStatus | null {
  const { coverage, documentId, available } = input;
  if (!coverage || !coverage.selectedDocumentIds.includes(documentId)) {
    return null;
  }

  if (!available) {
    return { label: "Unavailable", tone: "unavailable" };
  }

  if ((coverage.finalByDocumentId[documentId] ?? 0) > 0) {
    return { label: "Used", tone: "used" };
  }

  if (coverage.noEvidenceDocumentIds.includes(documentId)) {
    return { label: "No evidence used", tone: "noEvidence" };
  }

  return { label: "Selected", tone: "selected" };
}

function coverageBadgeClass(status: SourceCoverageStatus, selected: boolean): string {
  if (selected) {
    return {
      used: "bg-emerald-400/15 text-emerald-100 ring-emerald-300/25",
      noEvidence: "bg-amber-400/15 text-amber-100 ring-amber-300/25",
      selected: "bg-white/10 text-slate-200 ring-white/15",
      unavailable: "bg-rose-400/15 text-rose-100 ring-rose-300/25",
    }[status.tone];
  }

  return {
    used: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    noEvidence: "bg-amber-50 text-amber-700 ring-amber-200",
    selected: "bg-slate-100 text-slate-600 ring-slate-200",
    unavailable: "bg-rose-50 text-rose-700 ring-rose-200",
  }[status.tone];
}

function citationSnippet(citation: ChatCitation): string {
  return citation.snippetFull?.trim() ? citation.snippetFull : citation.snippet;
}

function isInsufficientAnswer(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("could not find enough support") ||
    normalized.includes("insufficient evidence") ||
    normalized.includes("insufficient information")
  );
}

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md text-sm leading-6"
    />
  );
}

function useTrueBlueTransport(input: {
  threadId: string | null;
  selectedDocumentIds: string[];
}) {
  const { threadId, selectedDocumentIds } = input;

  return useMemo(
    () =>
      new AssistantChatTransport<UIMessage>({
        api: "/api/chat",
        credentials: "include",
        fetch: async (requestInput, init) => {
          const url =
            typeof requestInput === "string" || requestInput instanceof URL
              ? requestInput.toString()
              : requestInput.url;
          return fetchWithAuth(url, init);
        },
        prepareSendMessagesRequest: async (options) => {
          const documentFilter =
            threadId || selectedDocumentIds.length === 0
              ? undefined
              : { documentIds: selectedDocumentIds };

          return {
            body: {
              ...options.body,
              id: options.id,
              messages: options.messages,
              trigger: options.trigger,
              messageId: options.messageId,
              metadata: {
                ...(isRecord(options.requestMetadata)
                  ? options.requestMetadata
                  : {}),
                ...(threadId ? { threadId } : {}),
                ...(documentFilter ? { documentFilter } : {}),
              },
            },
          };
        },
      }),
    [selectedDocumentIds, threadId]
  );
}

function ChatRuntimeShell({
  children,
  initialMessages,
  selectedDocumentIds,
  threadId,
  setThreadId,
  onThreadStarted,
  setError,
}: {
  children: React.ReactNode;
  initialMessages: UIMessage[];
  selectedDocumentIds: string[];
  threadId: string | null;
  setThreadId: (threadId: string | null) => void;
  onThreadStarted: (threadId: string, documentFilter?: unknown) => void;
  setError: (error: string | null) => void;
}) {
  const transport = useTrueBlueTransport({
    threadId,
    selectedDocumentIds,
  });
  const runtime = useChatRuntime<UIMessage>({
    transport,
    messages: initialMessages,
    onData: (part) => {
      if (part.type === "data-thread" && isRecord(part.data)) {
        const nextThreadId = part.data.threadId;
        if (typeof nextThreadId === "string" && nextThreadId.length > 0) {
          setThreadId(nextThreadId);
          onThreadStarted(nextThreadId, part.data.documentFilter);
        }
      }
    },
    onError: (error) => {
      setError(error.message || "Chat request failed");
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
  );
}

function CitationPanel({
  coverage,
  citations,
}: {
  coverage: ChatEvidenceCoverageV1 | null;
  citations: ChatCitation[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) {
    return null;
  }

  const citedDocumentCount = new Set(
    citations
      .map((citation) => citation.documentId)
      .filter((documentId) => documentId.length > 0)
  ).size;
  const selectedDocumentCount = coverage
    ? new Set(coverage.selectedDocumentIds).size
    : 0;
  const sourceLabel = coverage
    ? `Sources used: ${citedDocumentCount} of ${selectedDocumentCount} selected`
    : `Sources used: ${citations.length}`;

  return (
    <Collapsible.Root
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded-2xl border border-slate-200 bg-slate-50/80"
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold text-slate-700 transition hover:text-slate-950"
        >
          <span className="inline-flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-slate-500" />
            {sourceLabel}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-slate-500 transition ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div className="space-y-2 border-t border-slate-200 px-3 py-3">
          {citations.map((citation, index) => (
            <div
              key={`${citation.chunkId}-${citation.pageStart}-${index}`}
              className="rounded-2xl border border-slate-200 bg-white px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-700">
                <span className="rounded-full bg-slate-950 px-2 py-0.5 text-white">
                  {citation.marker ?? `S${index + 1}`}
                </span>
                <span>{citation.filename ?? "Source document"}</span>
                <span className="text-slate-300">/</span>
                <span>{formatPageRange(citation)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">
                {citationSnippet(citation)}
              </p>
            </div>
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function StructuredOutputPanel({ output }: { output: StructuredChatOutputV1 | null }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!output) {
    return null;
  }

  const warningCodes = output.warnings.map((warning) => warning.code);
  const json = JSON.stringify(output.raw, null, 2);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Collapsible.Root
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded-2xl border border-slate-200 bg-slate-50 text-xs text-slate-700"
    >
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          <span className="rounded-full bg-white px-2 py-0.5 ring-1 ring-slate-200">
            {output.status.replace(/_/g, " ")}
          </span>
          <span>{output.support.confidenceLabel} support</span>
          <span className="text-slate-300">/</span>
          <span>{output.support.sourceCount} used</span>
          <span className="text-slate-300">/</span>
          <span>{output.support.selectedDocumentCount} selected</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-slate-500">
          <span>{output.schemaVersion}</span>
          <span>{output.templateId}</span>
          <span>{output.support.retrievalMode}</span>
          <span>
            {output.warnings.length} warning{output.warnings.length === 1 ? "" : "s"}
          </span>
          {warningCodes.length > 0 ? <span>{warningCodes.join(", ")}</span> : null}
        </div>
        <p className="mt-2 text-[0.72rem] leading-5 text-slate-600">
          {output.support.confidenceBasis}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-3 py-2">
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-[0.72rem] font-semibold text-slate-600 transition hover:text-slate-950"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition ${expanded ? "rotate-180" : ""}`}
            />
            Structured JSON
          </button>
        </Collapsible.Trigger>
        <button
          type="button"
          onClick={copyJson}
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[0.7rem] font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:text-slate-950"
        >
          <Clipboard className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <Collapsible.Content>
        <pre className="max-h-72 overflow-auto border-t border-slate-200 bg-slate-950 px-3 py-3 text-[0.68rem] leading-5 text-slate-100">
          {json}
        </pre>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ChatBubble({ message }: { message: MessageState }) {
  const citations = messageCitations(message);
  const coverage = messageCoverage(message);
  const output = messageOutput(message);
  const text = messageText(message);
  const isAssistant = message.role === "assistant";
  const isRunning = message.status?.type === "running";
  const insufficientEvidence =
    isAssistant &&
    (output?.status === "insufficient_evidence" || isInsufficientAnswer(text));

  return (
    <MessagePrimitive.Root
      className={`animate-fade-in-up rounded-3xl px-5 py-4 ${
        message.role === "user"
          ? "ml-auto max-w-2xl bg-slate-950 text-white"
          : "mr-auto max-w-3xl border border-slate-200 bg-white/90 text-slate-900 shadow-sm backdrop-blur"
      }`}
    >
      <div className="whitespace-pre-wrap text-sm leading-6">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            data: { Fallback: () => null },
          }}
        />
        {isRunning && !text ? (
          <span className="inline-flex items-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Drafting answer
          </span>
        ) : null}
      </div>

      {isAssistant ? (
        <div className="mt-4 space-y-3">
          {insufficientEvidence ? (
            <div className="flex items-center gap-2 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              <AlertCircle className="h-4 w-4" />
              Insufficient evidence from the selected sources.
            </div>
          ) : null}
          <CitationPanel
            coverage={coverage}
            citations={citations}
          />
          <StructuredOutputPanel output={output} />
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function SourceSidebar({
  canDeleteDocument,
  deleteDocument,
  deletingDocumentIds,
  documents,
  loadingDocuments,
  onUploadFile,
  selectedDocumentIds,
  sourceLabel,
  threadLocked,
  toggleDocument,
  uploadBusy,
  uploadDisabled,
  uploadStatus,
}: {
  canDeleteDocument: (document: DashboardDocument) => boolean;
  deleteDocument: (document: DashboardDocument) => void;
  deletingDocumentIds: string[];
  documents: DashboardDocument[];
  loadingDocuments: boolean;
  onUploadFile: (file: File) => void;
  selectedDocumentIds: string[];
  sourceLabel: string;
  threadLocked: boolean;
  toggleDocument: (documentId: string) => void;
  uploadBusy: boolean;
  uploadDisabled: boolean;
  uploadStatus: string | null;
}) {
  const messages = useThread((state) => state.messages);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const latestCoverage = useMemo(() => latestAssistantCoverage(messages), [messages]);
  const latestOutput = useMemo(() => latestAssistantOutput(messages), [messages]);
  const documentIds = new Set(documents.map((document) => document.id));
  const coverageSelectedIds = new Set(
    latestOutput?.coverage.selectedDocumentIds ?? latestCoverage?.selectedDocumentIds ?? []
  );
  const unavailableDocumentIds = latestCoverage
    ? [...coverageSelectedIds].filter((documentId) => !documentIds.has(documentId))
    : [];
  const hasSourceRows = documents.length > 0 || unavailableDocumentIds.length > 0;
  const mustSelectExplicitSources =
    !threadLocked &&
    selectedDocumentIds.length === 0 &&
    documents.length > MAX_CHAT_SOURCE_SELECTION;

  return (
    <aside className="border-t border-slate-200 bg-white px-5 py-6 lg:border-l lg:border-t-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Sources
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            {sourceLabel}
          </h2>
        </div>
        {threadLocked ? (
          <LockKeyhole className="mt-1 h-5 w-5 text-slate-500" />
        ) : (
          <CheckCircle2 className="mt-1 h-5 w-5 text-emerald-600" />
        )}
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-600">
        {threadLocked
          ? "This thread is locked to the sources selected when it started."
          : mustSelectExplicitSources
            ? `Select up to ${MAX_CHAT_SOURCE_SELECTION} sources before sending.`
          : "Choose sources for the next thread. If none are selected, all currently completed documents are snapshotted on send."}
      </p>

      <input
        ref={uploadInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = "";
          if (file) {
            onUploadFile(file);
          }
        }}
      />
      <div className="mt-5 space-y-2">
        <button
          type="button"
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploadDisabled}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {uploadBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload PDF
        </button>
        {uploadStatus ? (
          <p className="text-xs leading-5 text-slate-600">{uploadStatus}</p>
        ) : null}
        {mustSelectExplicitSources ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            Select up to {MAX_CHAT_SOURCE_SELECTION} sources before sending. This
            firm has more completed documents than the implicit all-source limit.
          </p>
        ) : null}
      </div>

      <div className="mt-6 space-y-3">
        {loadingDocuments ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading completed documents
          </div>
        ) : !hasSourceRows ? (
          <div className="rounded-3xl border border-dashed border-slate-300 px-4 py-6 text-sm leading-6 text-slate-600">
            No completed documents are available yet. Upload and process a document
            before using document Q&A.
          </div>
        ) : (
          <>
            {documents.map((document) => {
              const selected =
                selectedDocumentIds.includes(document.id) ||
                coverageSelectedIds.has(document.id);
              const deleting = deletingDocumentIds.includes(document.id);
              const deletable = canDeleteDocument(document);
              const coverageStatus = coverageStatusForDocument({
                coverage: latestCoverage,
                documentId: document.id,
                available: true,
              });

              return (
                <div
                  key={document.id}
                  className={`group flex w-full items-stretch overflow-hidden rounded-3xl border transition ${
                    selected
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-200 bg-slate-50 text-slate-900 hover:border-slate-400"
                  } ${threadLocked ? "cursor-not-allowed opacity-70" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleDocument(document.id)}
                    disabled={threadLocked || deleting}
                    className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
                  >
                    <FileText
                      className={`mt-0.5 h-4 w-4 ${
                        selected ? "text-white" : "text-slate-500"
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {document.originalName || document.filename}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span
                          className={`text-xs ${
                            selected ? "text-slate-300" : "text-slate-500"
                          }`}
                        >
                          {document.pageCount ?? "Unknown"} pages
                        </span>
                        {coverageStatus ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[0.68rem] font-semibold ring-1 ${coverageBadgeClass(
                              coverageStatus,
                              selected
                            )}`}
                          >
                            {coverageStatus.label}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                  {deletable ? (
                    <button
                      type="button"
                      onClick={() => deleteDocument(document)}
                      disabled={deleting}
                      className={`grid w-11 shrink-0 place-items-center border-l transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        selected
                          ? "border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
                          : "border-slate-200 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      }`}
                      aria-label={`Delete source file ${
                        document.originalName || document.filename
                      }`}
                    >
                      {deleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  ) : null}
                </div>
              );
            })}

            {unavailableDocumentIds.map((documentId) => {
              const coverageStatus = coverageStatusForDocument({
                coverage: latestCoverage,
                documentId,
                available: false,
              });

              return (
                <div
                  key={`unavailable-${documentId}`}
                  className="flex w-full items-start gap-3 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-slate-600"
                >
                  <FileText className="mt-0.5 h-4 w-4 text-slate-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      Source no longer available
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs text-slate-500">
                        {documentId}
                      </span>
                      {coverageStatus ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.68rem] font-semibold ring-1 ${coverageBadgeClass(
                            coverageStatus,
                            false
                          )}`}
                        >
                          {coverageStatus.label}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

export default function DocumentChatPage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DashboardDocument[]>([]);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [nextThreadCursor, setNextThreadCursor] = useState<string | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [deletingThreadIds, setDeletingThreadIds] = useState<string[]>([]);
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<string[]>([]);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [user, setUser] = useState<ChatUser | null>(null);
  const [firmAccessDenied, setFirmAccessDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const deletingThreadIdsRef = useRef<Set<string>>(new Set());
  const deletingDocumentIdsRef = useRef<Set<string>>(new Set());
  const selectedCount = selectedDocumentIds.length;
  const threadLocked = Boolean(threadId);
  const implicitSourceScopeBlocked =
    !threadLocked &&
    selectedCount === 0 &&
    documents.length > MAX_CHAT_SOURCE_SELECTION;
  const sourceLabel = threadLocked
    ? selectedCount === 0
      ? "All locked sources"
      : `${selectedCount} locked source${selectedCount === 1 ? "" : "s"}`
    : implicitSourceScopeBlocked
      ? `Select up to ${MAX_CHAT_SOURCE_SELECTION} sources`
      : selectedCount === 0
        ? "All completed documents"
        : `${selectedCount} selected source${selectedCount === 1 ? "" : "s"}`;
  const runtimeKey = `chat-${runtimeRevision}`;

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  async function loadThreadList(input?: { append?: boolean; cursor?: string | null }) {
    const response = await fetchWithAuth(
      `/api/chat/threads?limit=30${
        input?.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ""
      }`
    );
    if (!response.ok) {
      throw new Error("Unable to load chat history");
    }

    const data = await response.json();
    setThreads((current) =>
      input?.append ? [...current, ...(data.threads ?? [])] : data.threads ?? []
    );
    setNextThreadCursor(data.nextCursor ?? null);
  }

  async function loadCompletedDocuments() {
    const documentsResponse = await fetchWithAuth(
      "/api/documents?status=COMPLETED&limit=100"
    );
    if (documentsResponse.status === 401) {
      router.push("/login");
      return null;
    }
    if (!documentsResponse.ok) {
      throw new Error("Unable to load completed documents");
    }

    const documentsData = await documentsResponse.json();
    const nextDocuments = (documentsData.documents ?? []) as DashboardDocument[];
    setDocuments(nextDocuments);
    return nextDocuments;
  }

  async function waitForDocumentCompletion(documentId: string) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await fetchWithAuth(`/api/documents/${documentId}`);
      if (response.status === 401) {
        router.push("/login");
        return null;
      }
      if (!response.ok) {
        throw new Error("Unable to check document status");
      }

      const data = await response.json();
      const document = data.document as DashboardDocument & {
        errorMessage?: string | null;
      };
      if (document.status === "COMPLETED") {
        return document;
      }
      if (document.status === "FAILED") {
        throw new Error(document.errorMessage || "Document processing failed");
      }

      setUploadStatus(`Processing ${document.originalName || document.filename}...`);
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
    }

    throw new Error("Document processing did not finish within five minutes");
  }

  async function uploadDocument(file: File) {
    if (threadLocked) {
      setError("Start a new thread before uploading another source.");
      return;
    }

    try {
      setError(null);
      setUploadingDocument(true);
      setUploadStatus(`Uploading ${file.name}...`);
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetchWithAuth("/api/documents/upload", {
        method: "POST",
        body: formData,
      });
      if (response.status === 401) {
        router.push("/login");
        return;
      }
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          isRecord(data) && typeof data.message === "string"
            ? data.message
            : "Upload failed"
        );
      }

      const uploaded = data?.document as
        | (DashboardDocument & { chunkCount?: number })
        | undefined;
      if (!uploaded?.id) {
        throw new Error("Upload response did not include a document ID");
      }

      setUploadStatus(`Processing ${uploaded.originalName || file.name}...`);
      const completed =
        uploaded.status === "COMPLETED"
          ? uploaded
          : await waitForDocumentCompletion(uploaded.id);
      const completedDocuments = await loadCompletedDocuments();
      if (completed) {
        setSelectedDocumentIds((current) => {
          if (current.includes(completed.id)) {
            return current;
          }
          if (current.length >= MAX_CHAT_SOURCE_SELECTION) {
            return current;
          }
          return [...current, completed.id];
        });
      } else if (completedDocuments?.[0]) {
        setSelectedDocumentIds((current) => {
          if (current.includes(completedDocuments[0].id)) {
            return current;
          }
          if (current.length >= MAX_CHAT_SOURCE_SELECTION) {
            return current;
          }
          return [...current, completedDocuments[0].id];
        });
      }
      setUploadStatus("Upload complete. The source list has been refreshed.");
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Could not upload and process the PDF."
      );
      setUploadStatus(null);
    } finally {
      setUploadingDocument(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      try {
        const userResponse = await fetchWithAuth("/api/auth/me");
        if (userResponse.status === 401) {
          router.push("/login");
          return;
        }
        if (!userResponse.ok) {
          throw new Error("Unable to load your session");
        }

        const userData = await userResponse.json();
        const nextUser = {
          id: userData.user?.id ?? "",
          firmId: userData.user?.firmId ?? null,
          role: userData.user?.role ?? null,
        };
        if (!cancelled) {
          setUser(nextUser);
        }
        if (!nextUser.firmId) {
          if (!cancelled) {
            setFirmAccessDenied(true);
          }
          return;
        }

        const [documentsResponse, threadsResponse] = await Promise.all([
          fetchWithAuth("/api/documents?status=COMPLETED&limit=100"),
          fetchWithAuth("/api/chat/threads?limit=30"),
        ]);
        if (documentsResponse.status === 401 || threadsResponse.status === 401) {
          router.push("/login");
          return;
        }
        if (!documentsResponse.ok || !threadsResponse.ok) {
          throw new Error("Unable to load chat workspace");
        }

        const documentsData = await documentsResponse.json();
        const threadsData = await threadsResponse.json();
        if (!cancelled) {
          setDocuments(documentsData.documents ?? []);
          setThreads(threadsData.threads ?? []);
          setNextThreadCursor(threadsData.nextCursor ?? null);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load the document chat workspace.");
        }
      } finally {
        if (!cancelled) {
          setLoadingDocuments(false);
          setLoadingThreads(false);
        }
      }
    }

    loadInitialData();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function toggleDocument(documentId: string) {
    if (threadLocked) {
      return;
    }

    setSelectedDocumentIds((current) => {
      if (current.includes(documentId)) {
        return current.filter((id) => id !== documentId);
      }

      if (current.length >= MAX_CHAT_SOURCE_SELECTION) {
        setError(`Select no more than ${MAX_CHAT_SOURCE_SELECTION} sources.`);
        return current;
      }

      setError(null);
      return [...current, documentId];
    });
  }

  function clearThread() {
    setThreadId(null);
    setSelectedDocumentIds([]);
    setInitialMessages([]);
    setRuntimeRevision((current) => current + 1);
    setError(null);
  }

  function handleThreadStarted(nextThreadId: string, documentFilter?: unknown) {
    if (threadId !== nextThreadId && selectedDocumentIds.length === 0) {
      const lockedDocumentIds =
        documentFilter !== undefined
          ? documentIdsFromFilter(documentFilter)
          : [];
      setSelectedDocumentIds(lockedDocumentIds);
    }
    loadThreadList().catch(() => undefined);
  }

  async function selectThread(nextThreadId: string) {
    try {
      setError(null);
      setLoadingThreadId(nextThreadId);
      const response = await fetchWithAuth(`/api/chat/threads/${nextThreadId}`);
      if (!response.ok) {
        throw new Error("Unable to load selected chat");
      }

      const data = (await response.json()) as LoadedChatThread;
      setThreadId(data.thread.id);
      setSelectedDocumentIds(documentIdsFromFilter(data.thread.documentFilter));
      setInitialMessages(data.messages ?? []);
      setRuntimeRevision((current) => current + 1);
    } catch {
      setError("Could not load the selected chat thread.");
    } finally {
      setLoadingThreadId(null);
    }
  }

  async function deleteThread(targetThreadId: string) {
    if (deletingThreadIdsRef.current.has(targetThreadId)) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this chat from your history? The source documents will not be deleted."
    );
    if (!confirmed) {
      return;
    }

    try {
      setError(null);
      deletingThreadIdsRef.current.add(targetThreadId);
      setDeletingThreadIds((current) => [...current, targetThreadId]);
      const response = await fetchWithAuth(`/api/chat/threads/${targetThreadId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Unable to delete chat");
      }

      setThreads((current) =>
        current.filter((thread) => thread.id !== targetThreadId)
      );
      if (threadIdRef.current === targetThreadId) {
        clearThread();
      }
    } catch {
      setError("Could not delete the selected chat.");
    } finally {
      deletingThreadIdsRef.current.delete(targetThreadId);
      setDeletingThreadIds((current) =>
        current.filter((id) => id !== targetThreadId)
      );
    }
  }

  function canDeleteDocument(document: DashboardDocument) {
    if (!user || threadLocked) {
      return false;
    }

    return (
      document.uploadedById === user.id ||
      user.role === "FIRM_ADMIN" ||
      user.role === "PLATFORM_ADMIN"
    );
  }

  async function deleteDocument(document: DashboardDocument) {
    if (deletingDocumentIdsRef.current.has(document.id)) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${document.originalName || document.filename}"?\n\nThis removes the source file, extracted artifacts, and vectors. Existing chats may still show historical answers, but this document will no longer be available for retrieval.`
    );
    if (!confirmed) {
      return;
    }

    try {
      setError(null);
      deletingDocumentIdsRef.current.add(document.id);
      setDeletingDocumentIds((current) => [...current, document.id]);
      const response = await fetchWithAuth(`/api/documents/${document.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const message =
          response.status === 409
            ? "This document is still processing and cannot be deleted yet."
            : response.status === 403
              ? "You do not have permission to delete this source file."
              : "Unable to delete source file.";
        throw new Error(message);
      }

      setDocuments((current) =>
        current.filter((candidate) => candidate.id !== document.id)
      );
      setSelectedDocumentIds((current) =>
        current.filter((documentId) => documentId !== document.id)
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Could not delete the selected source file."
      );
    } finally {
      deletingDocumentIdsRef.current.delete(document.id);
      setDeletingDocumentIds((current) =>
        current.filter((id) => id !== document.id)
      );
    }
  }

  if (firmAccessDenied) {
    return (
      <div className="rounded-[2rem] border border-amber-200 bg-amber-50 px-8 py-10 text-amber-950">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
          Firm context required
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Document Q&A is available inside a firm workspace.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-amber-900">
          This chat route is intentionally firm-scoped so retrieval, citations, and
          persisted threads cannot cross tenant boundaries.
        </p>
      </div>
    );
  }

  return (
    <ChatRuntimeShell
      key={runtimeKey}
      initialMessages={initialMessages}
      selectedDocumentIds={selectedDocumentIds}
      threadId={threadId}
      setThreadId={setThreadId}
      onThreadStarted={handleThreadStarted}
      setError={setError}
    >
      <div className="min-h-[calc(100vh-7rem)] overflow-hidden rounded-[2rem] border border-slate-200 bg-[#f7f4ec] text-slate-950 shadow-sm">
        <div className="grid min-h-[calc(100vh-7rem)] lg:grid-cols-[280px_minmax(0,1fr)_360px]">
          <aside className="border-b border-slate-200 bg-[#fbf8f1] px-4 py-5 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  History
                </p>
                <h2 className="mt-2 text-lg font-semibold text-slate-950">
                  Chats
                </h2>
              </div>
              <button
                type="button"
                onClick={clearThread}
                className="grid h-9 w-9 place-items-center rounded-full bg-slate-950 text-white transition hover:bg-slate-800"
                aria-label="Start new chat"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-3 text-xs leading-5 text-slate-600">
              Previous chats are private to your user account and keep their original
              source scope.
            </p>

            <div className="mt-5 space-y-2">
              {loadingThreads ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading chat history
                </div>
              ) : threads.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-5 text-sm leading-6 text-slate-600">
                  No saved chats yet.
                </div>
              ) : (
                threads.map((thread) => {
                  const active = thread.id === threadId;
                  const deleting = deletingThreadIds.includes(thread.id);
                  return (
                    <div
                      key={thread.id}
                      className={`group flex w-full items-stretch overflow-hidden rounded-2xl border transition ${
                        active
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-slate-200 bg-white/75 text-slate-900 hover:border-slate-400"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectThread(thread.id)}
                        disabled={deleting}
                        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {loadingThreadId === thread.id || deleting ? (
                          <Loader2 className="mt-0.5 h-4 w-4 animate-spin" />
                        ) : (
                          <History className="mt-0.5 h-4 w-4 opacity-70" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-sm font-semibold leading-5">
                            {thread.title || "Document chat"}
                          </p>
                          <p
                            className={`mt-2 text-xs ${
                              active ? "text-slate-300" : "text-slate-500"
                            }`}
                          >
                            {formatSourceCount(thread.sourceCount)} /{" "}
                            {thread.messageCount} messages
                          </p>
                          <p
                            className={`mt-1 text-xs ${
                              active ? "text-slate-400" : "text-slate-500"
                            }`}
                          >
                            {formatDate(thread.updatedAt)}
                          </p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteThread(thread.id)}
                        disabled={deleting}
                        className={`grid w-10 shrink-0 place-items-center border-l transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          active
                            ? "border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
                            : "border-slate-200 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        }`}
                        aria-label={`Delete chat ${thread.title || "Document chat"}`}
                      >
                        {deleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {nextThreadCursor ? (
              <button
                type="button"
                onClick={() =>
                  loadThreadList({ append: true, cursor: nextThreadCursor }).catch(
                    () => setError("Could not load more chat history.")
                  )
                }
                className="mt-4 w-full rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
              >
                Load more
              </button>
            ) : null}
          </aside>

          <ThreadPrimitive.Root className="flex min-h-[620px] flex-col bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.14),_transparent_32%),linear-gradient(135deg,_#fffaf0_0%,_#f8fafc_55%,_#edf2f7_100%)]">
            <header className="border-b border-slate-200/80 px-6 py-5 sm:px-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                    Document Q&A
                  </p>
                  <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                    Ask against extracted evidence.
                  </h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                    Answers stream from retrieved document evidence. If support is weak,
                    the assistant must say so instead of guessing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearThread}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
                >
                  <RotateCcw className="h-4 w-4" />
                  New thread
                </button>
              </div>
            </header>

            <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
              <ThreadPrimitive.Empty>
                <div className="grid min-h-[420px] place-items-center">
                  <div className="max-w-2xl text-center">
                    <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-slate-950 text-white">
                      <MessageSquareText className="h-6 w-6" />
                    </div>
                    <h2 className="mt-6 text-2xl font-semibold tracking-tight">
                      Start with a question answerable from the uploads.
                    </h2>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Pick specific sources or search all completed documents. The chosen
                      source set is snapshotted when the thread starts.
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-2">
                      {[
                        "What filing status appears in this return?",
                        "Which pages contain W-2 wage details?",
                        "Summarize Schedule C income evidence.",
                      ].map((prompt) => (
                        <span
                          key={prompt}
                          className="rounded-full border border-slate-200 bg-white/80 px-4 py-2 text-xs font-medium text-slate-600"
                        >
                          {prompt}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </ThreadPrimitive.Empty>

              <div className="mx-auto flex max-w-4xl flex-col gap-5">
                <ThreadPrimitive.Messages>
                  {({ message }) => <ChatBubble message={message} />}
                </ThreadPrimitive.Messages>
              </div>
            </ThreadPrimitive.Viewport>

            <div className="border-t border-slate-200/80 bg-white/75 px-4 py-4 backdrop-blur sm:px-8">
              {error ? (
                <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ) : null}
              <ComposerPrimitive.Root className="flex gap-3">
                <ComposerPrimitive.Input
                  placeholder={`Ask using ${sourceLabel.toLowerCase()}...`}
                  className="min-h-12 flex-1 resize-none rounded-3xl border border-slate-300 bg-white px-5 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-slate-950"
                  rows={1}
                />
                <ComposerPrimitive.Send
                  disabled={
                    loadingDocuments || !user?.firmId || implicitSourceScopeBlocked
                  }
                  className="inline-flex h-12 items-center gap-2 rounded-full bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  <Send className="h-4 w-4" />
                  Send
                </ComposerPrimitive.Send>
              </ComposerPrimitive.Root>
            </div>
          </ThreadPrimitive.Root>

          <SourceSidebar
            canDeleteDocument={canDeleteDocument}
            deleteDocument={deleteDocument}
            deletingDocumentIds={deletingDocumentIds}
            documents={documents}
            loadingDocuments={loadingDocuments}
            onUploadFile={uploadDocument}
            selectedDocumentIds={selectedDocumentIds}
            sourceLabel={sourceLabel}
            threadLocked={threadLocked}
            toggleDocument={toggleDocument}
            uploadBusy={uploadingDocument}
            uploadDisabled={threadLocked || uploadingDocument || !user?.firmId}
            uploadStatus={uploadStatus}
          />
        </div>
      </div>
    </ChatRuntimeShell>
  );
}
