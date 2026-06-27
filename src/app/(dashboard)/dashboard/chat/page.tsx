"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowDown,
  BookOpen,
  Check,
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
  Square,
  Trash2,
} from "lucide-react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type MessageState,
  useThread,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { UIMessage } from "ai";
import type { FileRejection } from "react-dropzone";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { fetchWithAuth } from "@/lib/fetch-with-auth";
import { AnswerInsights } from "@/features/chat/components/AnswerInsights";
import { Citation } from "@/features/chat/components/Citation";
import { CitationsProvider } from "@/features/chat/components/CitationsContext";
import {
  UploadPanel,
  type UploadRow,
} from "@/features/chat/components/UploadPanel";
import { remarkCitations } from "@/features/chat/lib/remark-citations";
import {
  uploadFileWithProgress,
  validateUploadFiles,
} from "@/features/chat/lib/upload";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  coverageBadgeClass,
  coverageStatusForDocument,
} from "@/features/chat/lib/coverage";
import {
  citationSnippet,
  formatDate,
  formatPageRange,
  formatSourceCount,
} from "@/features/chat/lib/format";
import {
  documentIdsFromFilter,
  latestAssistantCoverage,
  latestAssistantOutput,
  messageCitations,
  messageCoverage,
  messageOutput,
  messageText,
} from "@/features/chat/lib/parse-output";
import {
  isRecord,
  type ChatCitation,
  type ChatEvidenceCoverageV1,
} from "@/features/chat/lib/types";

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

type ChatUser = {
  id: string;
  firmId: string | null;
  role: string | null;
};

const MAX_CHAT_SOURCE_SELECTION = 25;

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm, remarkCitations]}
      components={{ citation: Citation }}
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
  highlightedMarker,
  registerSourceRef,
}: {
  coverage: ChatEvidenceCoverageV1 | null;
  citations: ChatCitation[];
  highlightedMarker: string | null;
  registerSourceRef: (
    marker: string,
    node: HTMLDivElement | null
  ) => void;
}) {
  // Evidence-first product: surface the source list expanded by default (F28).
  const [expanded, setExpanded] = useState(true);
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
      className="rounded-lg border border-slate-200 bg-slate-50"
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
          {citations.map((citation, index) => {
            const marker = citation.marker ?? `[S${index + 1}]`;
            const highlighted = highlightedMarker === marker;
            return (
            <div
              key={`${citation.chunkId}-${citation.pageStart}-${index}`}
              ref={(node) => registerSourceRef(marker, node)}
              className={`scroll-mt-4 rounded-lg border bg-white px-3 py-2 transition ${
                highlighted
                  ? "border-blue-500 ring-2 ring-blue-500/25"
                  : "border-slate-200"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-700">
                <span className="rounded-full bg-blue-600 px-2 py-0.5 text-white">
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
            );
          })}
        </div>
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
    (output?.status === "insufficient_evidence" ||
      output?.warnings.some(
        (warning) => warning.code === "INSUFFICIENT_EVIDENCE"
      ) === true);

  // Inline citations (B3): resolve markers against this message's sources.
  const citationSources = output?.sources ?? citations;
  const [highlightedMarker, setHighlightedMarker] = useState<string | null>(
    null
  );
  const sourceRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const highlightTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (highlightTimeout.current !== null) {
        window.clearTimeout(highlightTimeout.current);
      }
    };
  }, []);

  const registerSourceRef = (marker: string, node: HTMLDivElement | null) => {
    if (node) {
      sourceRefs.current.set(marker, node);
    } else {
      sourceRefs.current.delete(marker);
    }
  };

  const handleJumpToSource = (marker: string) => {
    const node = sourceRefs.current.get(marker);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    setHighlightedMarker(marker);
    if (highlightTimeout.current !== null) {
      window.clearTimeout(highlightTimeout.current);
    }
    highlightTimeout.current = window.setTimeout(
      () => setHighlightedMarker(null),
      2000
    );
  };

  return (
    <MessagePrimitive.Root
      className={`animate-fade-in-up rounded-2xl px-4 py-3 ${
        message.role === "user"
          ? "ml-auto max-w-2xl bg-blue-600 text-white"
          : "mr-auto max-w-3xl border border-slate-200 bg-white text-slate-900 shadow-sm"
      }`}
    >
      <CitationsProvider
        sources={citationSources}
        onJumpToSource={handleJumpToSource}
      >
      <div
        className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6"
        aria-live={isRunning ? "polite" : undefined}
        aria-busy={isAssistant ? isRunning : undefined}
      >
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            data: { Fallback: () => null },
          }}
        />
        {isRunning && !text ? (
          <span className="inline-flex items-center gap-2 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="animate-pulse">
              Searching documents and grounding the answer…
            </span>
          </span>
        ) : null}
      </div>

      {isAssistant ? (
        <div className="mt-4 space-y-3">
          {insufficientEvidence ? (
            <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              <AlertCircle className="h-4 w-4" />
              Insufficient evidence from the selected sources.
            </div>
          ) : null}
          {output ? <AnswerInsights output={output} /> : null}
          <CitationPanel
            coverage={coverage}
            citations={citations}
            highlightedMarker={highlightedMarker}
            registerSourceRef={registerSourceRef}
          />
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="never"
            className="flex items-center gap-1"
          >
            <ActionBarPrimitive.Copy
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 data-[copied]:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Copy answer"
            >
              <Clipboard className="h-3.5 w-3.5" />
              Copy
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Regenerate answer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Regenerate
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        </div>
      ) : null}
      </CitationsProvider>
    </MessagePrimitive.Root>
  );
}

function SourceSidebar({
  canDeleteDocument,
  deleteDocument,
  deletingDocumentIds,
  documents,
  loadingDocuments,
  onFilesAccepted,
  onFilesRejected,
  onDismissUploadRow,
  uploadRows,
  selectedDocumentIds,
  sourceLabel,
  threadLocked,
  toggleDocument,
  uploadDisabled,
  uploadDisabledReason,
}: {
  canDeleteDocument: (document: DashboardDocument) => boolean;
  deleteDocument: (document: DashboardDocument) => void;
  deletingDocumentIds: string[];
  documents: DashboardDocument[];
  loadingDocuments: boolean;
  onFilesAccepted: (files: File[]) => void;
  onFilesRejected: (rejections: FileRejection[]) => void;
  onDismissUploadRow: (id: string) => void;
  uploadRows: UploadRow[];
  selectedDocumentIds: string[];
  sourceLabel: string;
  threadLocked: boolean;
  toggleDocument: (documentId: string) => void;
  uploadDisabled: boolean;
  uploadDisabledReason: string | null;
}) {
  const messages = useThread((state) => state.messages);
  const latestCoverage = useMemo(() => latestAssistantCoverage(messages), [messages]);
  const latestOutput = useMemo(() => latestAssistantOutput(messages), [messages]);
  const documentIds = new Set(documents.map((document) => document.id));
  const coverageSelectedIds = new Set(
    latestOutput?.coverage.selectedDocumentIds ?? latestCoverage?.selectedDocumentIds ?? []
  );
  const unavailableDocumentIds = latestCoverage
    ? [...coverageSelectedIds].filter((documentId) => !documentIds.has(documentId))
    : [];
  // F30: resolve a last-known filename for unavailable sources from the latest
  // assistant output's sources[] (matched by documentId).
  const filenameByDocumentId = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of latestOutput?.sources ?? []) {
      if (source.filename) {
        map.set(source.documentId, source.filename);
      }
    }
    return map;
  }, [latestOutput]);
  const hasSourceRows = documents.length > 0 || unavailableDocumentIds.length > 0;
  const mustSelectExplicitSources =
    !threadLocked &&
    selectedDocumentIds.length === 0 &&
    documents.length > MAX_CHAT_SOURCE_SELECTION;

  return (
    <aside className="order-3 flex min-h-0 flex-col overflow-hidden border-t border-slate-200 bg-slate-50/60 lg:order-none lg:border-l lg:border-t-0">
      <div className="shrink-0 border-b border-slate-200/80 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Sources
            </p>
            <h2 className="mt-1 text-base font-semibold text-slate-900">
              {sourceLabel}
            </h2>
          </div>
          {threadLocked ? (
            <LockKeyhole className="mt-0.5 h-4 w-4 text-slate-500" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
          )}
        </div>

        <p className="mt-2 text-xs leading-5 text-slate-500">
          {threadLocked
            ? "This thread is locked to the sources selected when it started."
            : mustSelectExplicitSources
              ? `Select up to ${MAX_CHAT_SOURCE_SELECTION} sources before sending.`
            : "Choose sources for the next thread. If none are selected, all currently completed documents are snapshotted on send."}
        </p>

        <div className="mt-3 space-y-2">
          <UploadPanel
            rows={uploadRows}
            disabled={uploadDisabled}
            disabledReason={uploadDisabledReason}
            onFilesAccepted={onFilesAccepted}
            onFilesRejected={onFilesRejected}
            onDismissRow={onDismissUploadRow}
          />
          {mustSelectExplicitSources ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              Select up to {MAX_CHAT_SOURCE_SELECTION} sources before sending. This
              firm has more completed documents than the implicit all-source limit.
            </p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
        {loadingDocuments ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading completed documents
          </div>
        ) : !hasSourceRows ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-sm leading-6 text-slate-500">
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
                  className={`group flex w-full items-stretch overflow-hidden rounded-lg border transition ${
                    selected
                      ? "border-blue-600 bg-blue-50 text-slate-900 ring-1 ring-blue-600/15"
                      : "border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50"
                  } ${threadLocked ? "cursor-not-allowed opacity-70" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleDocument(document.id)}
                    disabled={threadLocked || deleting}
                    aria-pressed={selected}
                    className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed"
                  >
                    {selected ? (
                      <Check className="mt-0.5 h-4 w-4 text-blue-600" />
                    ) : (
                      <FileText className="mt-0.5 h-4 w-4 text-slate-400" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {document.originalName || document.filename}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span
                          className={`text-xs ${
                            selected ? "text-blue-700" : "text-slate-500"
                          }`}
                        >
                          {document.pageCount ?? "Unknown"} pages
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
                  </button>
                  {deletable ? (
                    <button
                      type="button"
                      onClick={() => deleteDocument(document)}
                      disabled={deleting}
                      className="grid w-10 shrink-0 place-items-center border-l border-slate-200 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
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
              // F30: prefer the last-known filename; fall back to the id.
              const knownFilename = filenameByDocumentId.get(documentId);

              return (
                <div
                  key={`unavailable-${documentId}`}
                  className="flex w-full items-start gap-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-3 py-2.5 text-slate-600"
                >
                  <FileText className="mt-0.5 h-4 w-4 text-slate-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {knownFilename ?? "Source no longer available"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs text-slate-500">
                        {knownFilename
                          ? "No longer available"
                          : documentId}
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
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const [user, setUser] = useState<ChatUser | null>(null);
  const [firmAccessDenied, setFirmAccessDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F20: destructive-confirmation dialog targets (null = closed).
  const [threadPendingDelete, setThreadPendingDelete] =
    useState<ChatThreadSummary | null>(null);
  const [documentPendingDelete, setDocumentPendingDelete] =
    useState<DashboardDocument | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const deletingThreadIdsRef = useRef<Set<string>>(new Set());
  const deletingDocumentIdsRef = useRef<Set<string>>(new Set());
  const uploadProcessingRef = useRef(false);
  const uploadQueueRef = useRef<Array<{ id: string; file: File }>>([]);
  // Abort/unmount cleanup for the upload queue: aborts the in-flight XHR and
  // stops the waitForDocumentCompletion poll loop on navigate-away.
  const uploadAbortRef = useRef<AbortController>(new AbortController());
  const uploadCancelledRef = useRef(false);
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

  function updateUploadRow(id: string, patch: Partial<UploadRow>) {
    setUploadRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
  }

  async function waitForDocumentCompletion(
    rowId: string,
    documentId: string,
    signal: AbortSignal
  ) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new DOMException("Upload aborted", "AbortError");
      }
      const response = await fetchWithAuth(`/api/documents/${documentId}`);
      if (signal.aborted) {
        throw new DOMException("Upload aborted", "AbortError");
      }
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

      updateUploadRow(rowId, { phase: "processing" });
      // Poll on an interval but stop promptly when aborted.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 5000);
        const onAbort = () => {
          window.clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    throw new Error("Document processing did not finish within five minutes");
  }

  function selectUploadedDocument(documentId: string) {
    setSelectedDocumentIds((current) => {
      if (
        current.includes(documentId) ||
        current.length >= MAX_CHAT_SOURCE_SELECTION
      ) {
        return current;
      }
      return [...current, documentId];
    });
  }

  async function processOneUpload(item: { id: string; file: File }) {
    const { id, file } = item;
    const signal = uploadAbortRef.current.signal;
    try {
      updateUploadRow(id, { phase: "uploading", percent: 0 });
      const result = await uploadFileWithProgress({
        file,
        url: "/api/documents/upload",
        onProgress: (percent) => {
          if (!uploadCancelledRef.current) {
            updateUploadRow(id, { percent });
          }
        },
        signal,
      });

      if (uploadCancelledRef.current) {
        return;
      }
      if (result.status === 401) {
        router.push("/login");
        throw new Error("Your session expired. Please sign in again.");
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(result.message ?? "Upload failed");
      }

      const uploaded = result.document;
      if (!uploaded?.id) {
        throw new Error("Upload response did not include a document ID");
      }

      updateUploadRow(id, { phase: "processing", percent: 100 });
      // Narrow read: the full document is refetched via loadCompletedDocuments().
      const completed: { id: string; status?: string; originalName?: string } | null =
        uploaded.status === "COMPLETED"
          ? uploaded
          : await waitForDocumentCompletion(id, uploaded.id, signal);

      if (uploadCancelledRef.current) {
        return;
      }
      await loadCompletedDocuments();
      if (uploadCancelledRef.current) {
        return;
      }
      if (completed) {
        selectUploadedDocument(completed.id);
      }
      updateUploadRow(id, { phase: "completed", percent: 100 });
      toast.success(`${file.name} is ready for retrieval.`);
    } catch (uploadError) {
      // Aborting (navigate-away/unmount) is a silent cancel, not an error.
      if (
        uploadCancelledRef.current ||
        (uploadError instanceof DOMException && uploadError.name === "AbortError")
      ) {
        return;
      }
      const message =
        uploadError instanceof Error
          ? uploadError.message
          : "Could not upload and process the PDF.";
      updateUploadRow(id, { phase: "error", error: message });
      toast.error(`Upload failed: ${file.name}`, { description: message });
    }
  }

  async function processUploadQueue() {
    if (uploadProcessingRef.current) {
      return;
    }
    uploadProcessingRef.current = true;
    try {
      while (!uploadCancelledRef.current && uploadQueueRef.current.length > 0) {
        const next = uploadQueueRef.current.shift();
        if (next) {
          await processOneUpload(next);
        }
      }
    } finally {
      uploadProcessingRef.current = false;
    }
  }

  function enqueueUploads(files: File[]) {
    if (threadLocked) {
      // No upload into a locked thread.
      toast.error("Start a new thread before uploading another source.");
      return;
    }
    if (!user?.firmId) {
      toast.error("A firm workspace is required to upload sources.");
      return;
    }

    const { accepted, rejected } = validateUploadFiles(files);
    for (const rejection of rejected) {
      toast.error(`Cannot upload ${rejection.file.name}`, {
        description: rejection.reason,
      });
    }
    if (accepted.length === 0) {
      return;
    }

    setError(null);
    const newRows: UploadRow[] = accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      phase: "uploading",
      percent: 0,
    }));
    setUploadRows((current) => [...current, ...newRows]);
    accepted.forEach((file, index) => {
      uploadQueueRef.current.push({ id: newRows[index].id, file });
    });
    void processUploadQueue();
  }

  function handleUploadRejections(rejections: FileRejection[]) {
    for (const rejection of rejections) {
      toast.error(`Cannot upload ${rejection.file.name}`, {
        description:
          rejection.errors[0]?.message ?? "File rejected by validation.",
      });
    }
  }

  function dismissUploadRow(id: string) {
    setUploadRows((current) => current.filter((row) => row.id !== id));
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

  // Fix 1: on unmount, stop the upload queue and abort in-flight work so no
  // setState/toast/router.push fires after navigate-away.
  useEffect(() => {
    const abortController = uploadAbortRef.current;
    return () => {
      uploadCancelledRef.current = true;
      uploadQueueRef.current = [];
      abortController.abort();
    };
  }, []);

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
    // Dedupe-by-ref: ignore a second delete for the same thread in flight.
    if (deletingThreadIdsRef.current.has(targetThreadId)) {
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
      // F21: transient failure -> toast, not a blocking banner.
      toast.error("Could not delete the selected chat.");
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
    // Dedupe-by-ref: ignore a second delete for the same document in flight.
    if (deletingDocumentIdsRef.current.has(document.id)) {
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
      // F21: transient failure -> toast, not a blocking banner.
      toast.error(
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
      <div className="lg:mx-auto lg:max-w-3xl lg:px-4 lg:py-8">
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-8 py-10 text-amber-950">
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
      <div className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-card text-slate-900 shadow-sm lg:h-[calc(100dvh-3.5rem-1px)] lg:rounded-none lg:border-0 lg:shadow-none">
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(16rem,18rem)_minmax(0,1fr)_minmax(19rem,23rem)]">
          <aside className="order-2 flex min-h-0 flex-col overflow-hidden border-b border-slate-200 bg-slate-50/60 lg:order-none lg:border-b-0 lg:border-r">
            <div className="shrink-0 border-b border-slate-200/80 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    History
                  </p>
                  <h2 className="mt-1 text-base font-semibold text-slate-900">
                    Chats
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={clearThread}
                  className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600"
                  aria-label="New chat"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              <p className="mt-2 text-xs leading-5 text-slate-500">
                Previous chats are private to your user account and keep their original
                source scope.
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="space-y-2">
                {loadingThreads ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading chat history
                  </div>
                ) : threads.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 px-4 py-5 text-sm leading-6 text-slate-500">
                    No saved chats yet.
                  </div>
                ) : (
                  threads.map((thread) => {
                    const active = thread.id === threadId;
                    const deleting = deletingThreadIds.includes(thread.id);
                    return (
                      <div
                        key={thread.id}
                        className={`group flex w-full items-stretch overflow-hidden rounded-lg border transition ${
                          active
                            ? "border-blue-600 bg-blue-50 text-slate-900 ring-1 ring-blue-600/15"
                            : "border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => selectThread(thread.id)}
                          disabled={deleting}
                          aria-current={active ? "true" : undefined}
                          className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {loadingThreadId === thread.id || deleting ? (
                            <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-blue-600" />
                          ) : (
                            <History
                              className={`mt-0.5 h-4 w-4 ${
                                active ? "text-blue-600" : "text-slate-400"
                              }`}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm font-medium leading-5">
                              {thread.title || "Document chat"}
                            </p>
                            <p
                              className={`mt-1.5 text-xs ${
                                active ? "text-blue-700" : "text-slate-500"
                              }`}
                            >
                              {formatSourceCount(thread.sourceCount)} /{" "}
                              {thread.messageCount} messages
                            </p>
                            <p
                              className={`mt-0.5 text-xs ${
                                active ? "text-blue-600/70" : "text-slate-500"
                              }`}
                            >
                              {formatDate(thread.updatedAt)}
                            </p>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => setThreadPendingDelete(thread)}
                          disabled={deleting}
                          className="grid w-10 shrink-0 place-items-center border-l border-slate-200 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
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
                      () => toast.error("Could not load more chat history.")
                    )
                  }
                  className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                >
                  Load more
                </button>
              ) : null}
            </div>
          </aside>

          <ThreadPrimitive.Root className="order-first flex min-h-[28rem] flex-col bg-white lg:order-none lg:min-h-0">
            <header className="shrink-0 border-b border-slate-200 px-6 py-4 sm:px-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Document Q&A
                  </p>
                  <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
                    Ask against extracted evidence
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm leading-5 text-slate-500">
                    Answers stream from retrieved document evidence. If support is weak,
                    the assistant says so instead of guessing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearThread}
                  className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 sm:self-auto"
                >
                  <Plus className="h-4 w-4" />
                  New chat
                </button>
              </div>
            </header>

            <ThreadPrimitive.Viewport className="relative min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
              <ThreadPrimitive.Empty>
                <div className="grid min-h-[18rem] place-items-center">
                  <div className="max-w-2xl text-center">
                    <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-blue-600 text-white">
                      <MessageSquareText className="h-5 w-5" />
                    </div>
                    <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">
                      Start with a question answerable from the uploads.
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Pick specific sources or search all completed documents. The chosen
                      source set is snapshotted when the thread starts.
                    </p>
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      {[
                        "What filing status appears in this return?",
                        "Which pages contain W-2 wage details?",
                        "Summarize Schedule C income evidence.",
                      ].map((prompt) => (
                        <ThreadPrimitive.Suggestion
                          key={prompt}
                          prompt={prompt}
                          method="replace"
                          send
                          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {prompt}
                        </ThreadPrimitive.Suggestion>
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

              <div className="pointer-events-none sticky bottom-2 z-10 flex justify-center">
                <ThreadPrimitive.ScrollToBottom
                  className="pointer-events-auto grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-md transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-0"
                  aria-label="Scroll to latest message"
                >
                  <ArrowDown className="h-4 w-4" />
                </ThreadPrimitive.ScrollToBottom>
              </div>
            </ThreadPrimitive.Viewport>

            <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-8">
              <div className="mx-auto w-full max-w-4xl">
              {error ? (
                <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              ) : null}
              <ComposerPrimitive.Root className="flex items-end gap-2">
                <ComposerPrimitive.Input
                  placeholder={
                    implicitSourceScopeBlocked
                      ? "Ask a question about your documents…"
                      : `Ask using ${sourceLabel.toLowerCase()}...`
                  }
                  className="min-h-11 flex-1 resize-none rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                  rows={1}
                />
                <ThreadPrimitive.If running={false}>
                  <ComposerPrimitive.Send
                    disabled={
                      loadingDocuments || !user?.firmId || implicitSourceScopeBlocked
                    }
                    className="inline-flex h-11 items-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    <Send className="h-4 w-4" />
                    Send
                  </ComposerPrimitive.Send>
                </ThreadPrimitive.If>
                <ThreadPrimitive.If running>
                  <ComposerPrimitive.Cancel
                    className="inline-flex h-11 items-center gap-2 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    aria-label="Stop generating"
                  >
                    <Square className="h-4 w-4" />
                    Stop
                  </ComposerPrimitive.Cancel>
                </ThreadPrimitive.If>
              </ComposerPrimitive.Root>
              </div>
            </div>
          </ThreadPrimitive.Root>

          <SourceSidebar
            canDeleteDocument={canDeleteDocument}
            deleteDocument={setDocumentPendingDelete}
            deletingDocumentIds={deletingDocumentIds}
            documents={documents}
            loadingDocuments={loadingDocuments}
            onFilesAccepted={enqueueUploads}
            onFilesRejected={handleUploadRejections}
            onDismissUploadRow={dismissUploadRow}
            uploadRows={uploadRows}
            selectedDocumentIds={selectedDocumentIds}
            sourceLabel={sourceLabel}
            threadLocked={threadLocked}
            toggleDocument={toggleDocument}
            uploadDisabled={threadLocked || !user?.firmId}
            uploadDisabledReason={
              threadLocked
                ? "This thread is locked. Start a new chat to upload sources."
                : !user?.firmId
                  ? "A firm workspace is required to upload sources."
                  : null
            }
          />
        </div>
      </div>

      {/* F20: destructive confirmation dialogs (focus-trapped, on-brand). */}
      <AlertDialog
        open={threadPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setThreadPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete this chat from your history? The source documents will not be
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = threadPendingDelete;
                setThreadPendingDelete(null);
                if (target) {
                  void deleteThread(target.id);
                }
              }}
            >
              Delete chat
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={documentPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDocumentPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &quot;
              {documentPendingDelete
                ? documentPendingDelete.originalName ||
                  documentPendingDelete.filename
                : ""}
              &quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the source file, extracted artifacts, and vectors.
              Existing chats may still show historical answers, but this document
              will no longer be available for retrieval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = documentPendingDelete;
                setDocumentPendingDelete(null);
                if (target) {
                  void deleteDocument(target);
                }
              }}
            >
              Delete source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ChatRuntimeShell>
  );
}
