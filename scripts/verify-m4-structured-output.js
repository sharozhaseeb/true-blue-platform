#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
const fs = require("fs");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(
  request,
  parent,
  isMain,
  options
) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const tsNode = require(path.join(repoRoot, "node_modules", "ts-node"));
tsNode.register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function makeJsonRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

async function json(response) {
  return {
    status: response.status,
    body: await response.json(),
  };
}

function parseSseData(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line));
}

function partIndex(parts, type) {
  return parts.findIndex((part) => part.type === type);
}

function retrievalResult(input, documentId, label, index = 1) {
  return {
    chunk: {
      chunkId: `chunk_${documentId}_${index}`,
      documentId,
      firmId: input.firmId,
      baseArtifactId: `artifact_${documentId}`,
      vectorGeneration: 1,
      content: `${label}\nExtra source text should not appear in warnings.`,
      contentType: index === 2 ? "table" : "field_group",
      pageStart: index,
      pageEnd: index,
      formType: "Form 1040",
      sectionPath: index === 2 ? "page/2/tables/table_status" : "page/1/fields",
      tableId: index === 2 ? "table_status" : null,
      sourceBlockIds: [`field_${documentId}_${index}`, `value_${documentId}_${index}`],
      parserVersion: "textract-base-v1",
      chunkStrategy: "base-document-structure-v1",
    },
    metadata: {
      chunkId: `chunk_${documentId}_${index}`,
      documentId,
      firmId: input.firmId,
      pageStart: index,
      pageEnd: index,
      formType: "Form 1040",
      parserVersion: "textract-base-v1",
      chunkStrategy: "base-document-structure-v1",
      contentType: index === 2 ? "table" : "field_group",
    },
    score: index === 2 ? 0.88 : 0.94,
    snippet: label,
    snippetFull: `${label}\nTaxpayer name: Example ${documentId}`,
  };
}

async function main() {
  const failures = [];
  const calls = [];
  const assistantMessagesByThreadKey = new Map();

  const tenant = require(path.join(repoRoot, "src/lib/tenant.ts"));
  const persistence = require(path.join(repoRoot, "src/lib/chat-persistence.ts"));
  const retrieval = require(path.join(
    repoRoot,
    "src/lib/persisted-base-document-retrieval.ts"
  ));
  const aiConfig = require(path.join(repoRoot, "src/lib/ai/config.ts"));
  const prismaModule = require(path.join(repoRoot, "src/lib/prisma.ts"));
  const {
    StructuredChatOutputV1Schema,
  } = require(path.join(repoRoot, "src/lib/chat-output-schema.ts"));
  const {
    DEFAULT_CHAT_OUTPUT_TEMPLATE,
  } = require(path.join(repoRoot, "src/lib/chat-output-templates.ts"));
  const chatRouteSource = fs.readFileSync(
    path.join(repoRoot, "src/app/api/chat/route.ts"),
    "utf8"
  );
  assertCondition(
    chatRouteSource.includes(
      'const shouldStreamResponse = parsed.transport === "assistant_ui";'
    ) &&
      !chatRouteSource.includes(
        'providerConfig.aiChatEnabled || parsed.transport === "assistant_ui"'
      ),
    "legacy JSON /api/chat requests must not switch to SSE when ENABLE_AI_CHAT=true",
    failures
  );

  let threadCounter = 0;

  tenant.getFirmScopedRequestContext = async () => ({
    userId: "user_a",
    role: "FIRM_USER",
    firmId: "firm_a",
    isAuthenticated: true,
  });

  persistence.createChatThreadWithUserMessage = async (input) => {
    calls.push({ type: "createThread", input });
    const id = `thread_${++threadCounter}`;
    return {
      id,
      firmId: input.firmId,
      userId: input.userId,
      requestKey: input.requestKey ?? null,
      title: input.messageContent,
      status: "ACTIVE",
      documentFilter: input.documentFilter ?? null,
      outputTemplate: input.outputTemplate ?? {
        templateId: DEFAULT_CHAT_OUTPUT_TEMPLATE.templateId,
        templateVersion: DEFAULT_CHAT_OUTPUT_TEMPLATE.templateVersion,
      },
      nextMessageSequence: 1,
      createdAt: new Date("2026-06-23T09:00:00.000Z"),
      updatedAt: new Date("2026-06-23T09:00:00.000Z"),
      messages: [
        {
          id: `${id}_user_0`,
          role: "USER",
          sequence: 0,
          requestKey: input.requestKey ?? null,
          content: input.messageContent,
          uiMessage: { role: "user", content: input.messageContent },
          retrievedChunkIds: null,
          citations: null,
          evidenceCoverage: null,
          model: null,
          inputTokens: null,
          outputTokens: null,
          createdAt: new Date("2026-06-23T09:00:00.000Z"),
        },
      ],
    };
  };

  persistence.loadChatThreadForUser = async (input) => {
    calls.push({ type: "loadThread", input });
    if (input.threadId !== "thread_existing") return null;
    return {
      id: "thread_existing",
      firmId: input.firmId,
      userId: input.userId,
      requestKey: "existing_key",
      title: "Existing compact thread",
      status: "ACTIVE",
      documentFilter: { documentIds: ["doc_a"] },
      outputTemplate: { templateId: "rag_qa.compact.v1", templateVersion: 1 },
      nextMessageSequence: 2,
      createdAt: new Date("2026-06-23T09:00:00.000Z"),
      updatedAt: new Date("2026-06-23T09:00:00.000Z"),
      messages: [],
    };
  };

  persistence.appendUserMessageToThread = async (input) => {
    calls.push({ type: "appendUser", input });
    return {
      id: "message_user_existing",
      role: "USER",
      sequence: 2,
      requestKey: input.requestKey ?? null,
      content: input.messageContent,
      uiMessage: { role: "user", content: input.messageContent },
      retrievedChunkIds: null,
      citations: null,
      evidenceCoverage: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      createdAt: new Date("2026-06-23T09:01:00.000Z"),
    };
  };

  persistence.appendAssistantMessageToThread = async (input) => {
    calls.push({ type: "appendAssistant", input });
    const key = `${input.threadId}:${input.requestKey ?? ""}`;
    if (input.requestKey && assistantMessagesByThreadKey.has(key)) {
      return assistantMessagesByThreadKey.get(key);
    }

    const message = {
      id: `message_assistant_${calls.filter((call) => call.type === "appendAssistant").length}`,
      role: "ASSISTANT",
      sequence: 3,
      requestKey: input.requestKey ?? null,
      content: input.content,
      uiMessage: { role: "assistant", content: input.content },
      retrievedChunkIds: input.retrievedChunkIds,
      citations: input.citations,
      evidenceCoverage: input.evidenceCoverage ?? null,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? 101,
      outputTokens: input.outputTokens ?? 29,
      createdAt: new Date("2026-06-23T09:02:00.000Z"),
    };
    if (input.requestKey) {
      assistantMessagesByThreadKey.set(key, message);
    }

    return message;
  };

  persistence.loadAssistantMessageByRequestKey = async (input) => {
    calls.push({ type: "loadAssistantByRequestKey", input });
    if (!input.requestKey) return null;
    return assistantMessagesByThreadKey.get(`${input.threadId}:${input.requestKey}`) ?? null;
  };

  aiConfig.readM3ProviderConfig = () => ({
    aiChatEnabled: false,
    vectorIndexingEnabled: false,
    vectorRetrievalEnabled: false,
    vectorMinScore: 0.25,
    openAiApiKey: "sk-redacted",
    aiModel: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 1536,
    pineconeNamespacePrefix: "trueblue",
    validationErrors: [],
  });

  retrieval.retrievePersistedBaseDocumentChunks = async (input) => {
    calls.push({ type: "retrieve", input });
    if (input.query.includes("unsupported")) {
      return {
        results: [],
        citations: [],
        warnings: ["retrieval returned no supported chunks"],
      };
    }

    const labels = {
      doc_a: "Filing status: Single",
      doc_b: "Taxpayer name: Beta Smith",
      doc_c: null,
      doc_d: "Total wages: $40,000",
      doc_e: "Total wages: $55,000",
      doc_f: "Total wages: $72,000",
      doc_g: "Total wages: $81,000",
      doc_h: "Total wages: $93,000",
    };
    const documentIds = input.documentIds?.length ? input.documentIds : ["doc_a"];
    const results = documentIds.flatMap((documentId) => {
      const label = labels[documentId];
      if (!label) return [];
      if (input.query.includes("metadata")) {
        return [retrievalResult(input, documentId, `${label} metadata`, 2)];
      }
      return [retrievalResult(input, documentId, label, 1)];
    });

    return {
      results,
      citations: [],
      warnings: input.query.includes("warning")
        ? ["retrieval provider degraded; no snippets included here"]
        : [],
    };
  };

  prismaModule.prisma.document.findMany = async (input) => {
    calls.push({ type: "documentFindMany", input });
    return (input.where.id.in ?? []).map((id) => ({
      id,
      originalName: `${id}.pdf`,
      filename: `${id}.pdf`,
    }));
  };

  const route = require(path.join(repoRoot, "src/app/api/chat/route.ts"));

  const legacy = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_legacy",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(legacy.status === 200, "legacy answered request failed", failures);
  assertCondition(
    legacy.body.output?.schemaVersion === "trueblue.chat.output.v1" &&
      legacy.body.output.status === "answered" &&
      legacy.body.output.responseText === legacy.body.answer &&
      legacy.body.output.sources.length === legacy.body.citations.length &&
      legacy.body.output.sources[0].marker === "[S1]" &&
      legacy.body.output.sources[0].sourceId === "S1" &&
      legacy.body.output.support.sourceCount === 1 &&
      legacy.body.output.metadata.messageId === legacy.body.assistantMessage.id &&
      legacy.body.output.metadata.requestKey === legacy.body.assistantMessage.requestKey &&
      legacy.body.output.metadata.generatedAt === "2026-06-23T09:02:00.000Z",
    "legacy JSON output did not include the expected structured envelope",
    failures
  );
  assertCondition(
    StructuredChatOutputV1Schema.safeParse(legacy.body.output).success,
    "legacy JSON output failed schema validation",
    failures
  );

  const streamResponse = await route.POST(
    makeJsonRequest({
      id: "assistant-ui-thread",
      messageId: "message_stream_user",
      messages: [
        {
          id: "message_stream_user",
          role: "user",
          parts: [{ type: "text", text: "What metadata is available?" }],
        },
      ],
      metadata: {
        documentFilter: { documentIds: ["doc_a"] },
      },
    })
  );
  const streamParts = parseSseData(await streamResponse.text());
  const outputPart = streamParts.find((part) => part.type === "data-output");
  const citationPart = streamParts.find((part) => part.type === "data-citations");
  assertCondition(streamResponse.status === 200, "assistant-ui stream failed", failures);
  assertCondition(Boolean(outputPart), "assistant-ui stream did not include data-output", failures);
  assertCondition(
    partIndex(streamParts, "data-thread") < partIndex(streamParts, "data-citations") &&
      partIndex(streamParts, "data-citations") < partIndex(streamParts, "data-coverage") &&
      partIndex(streamParts, "data-coverage") < partIndex(streamParts, "data-output") &&
      partIndex(streamParts, "data-output") < partIndex(streamParts, "text-start") &&
      partIndex(streamParts, "text-end") < partIndex(streamParts, "data-usage"),
    "assistant-ui stream part order changed",
    failures
  );
  assertCondition(
    StructuredChatOutputV1Schema.safeParse(outputPart?.data?.output).success &&
      outputPart.data.output.metadata.messageId &&
      outputPart.data.output.metadata.inputTokens === 101 &&
      outputPart.data.output.sources[0].chunkId ===
        citationPart?.data?.citations?.[0]?.chunkId,
    "assistant-ui stream output did not validate or match citations/metadata",
    failures
  );
  assertCondition(
    outputPart.data.output.sources[0].rank === 1 &&
      outputPart.data.output.sources[0].sectionPath === "page/2/tables/table_status" &&
      outputPart.data.output.sources[0].contentType === "table" &&
      outputPart.data.output.sources[0].tableId === "table_status" &&
      outputPart.data.output.sources[0].relevanceScore === 0.88,
    "stream output did not preserve source rank/section/content metadata",
    failures
  );

  const unsupported = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_unsupported",
        message: { role: "user", content: "unsupported question" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(
    unsupported.body.output.status === "insufficient_evidence" &&
      unsupported.body.output.sources.length === 0 &&
      unsupported.body.output.warnings.some(
        (warning) => warning.code === "INSUFFICIENT_EVIDENCE"
      ) &&
      unsupported.body.output.warnings.some(
        (warning) => warning.code === "RETRIEVAL_WARNING"
      ),
    "insufficient evidence output did not preserve status and retrieval warning",
    failures
  );

  const retrieveCountBeforeGreeting = calls.filter((call) => call.type === "retrieve").length;
  const greeting = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_greeting",
        message: { role: "user", content: "hi" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  const retrieveCountAfterGreeting = calls.filter((call) => call.type === "retrieve").length;
  assertCondition(
    greeting.body.output.status === "non_document" &&
      greeting.body.output.sources.length === 0 &&
      greeting.body.output.warnings.some((warning) => warning.code === "NON_DOCUMENT_MESSAGE") &&
      retrieveCountAfterGreeting === retrieveCountBeforeGreeting,
    "non-document greeting did not produce expected structured status without retrieval",
    failures
  );

  const tooBroad = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_too_broad",
        message: { role: "user", content: "Compare all selected returns." },
        documentFilter: {
          documentIds: [
            "doc_a",
            "doc_b",
            "doc_c",
            "doc_d",
            "doc_e",
            "doc_f",
            "doc_g",
            "doc_h",
            "doc_i",
          ],
        },
      })
    )
  );
  assertCondition(
    tooBroad.body.output.status === "narrowing_required" &&
      tooBroad.body.output.warnings.some((warning) => warning.code === "NARROWING_REQUIRED") &&
      tooBroad.body.output.coverage.selectedDocumentIds.length === 9,
    "too-broad source scope did not produce narrowing output",
    failures
  );

  const partial = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_partial",
        message: {
          role: "user",
          content: "Compare taxpayer names across all selected returns.",
        },
        documentFilter: { documentIds: ["doc_a", "doc_b", "doc_c"] },
      })
    )
  );
  assertCondition(
    partial.body.output.status === "answered" &&
      partial.body.output.warnings.some(
        (warning) => warning.code === "PARTIAL_SOURCE_COVERAGE"
      ) &&
      partial.body.output.support.confidenceLabel === "low",
    "partial source coverage did not produce low support warning",
    failures
  );

  const warningResponse = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_warning",
        message: { role: "user", content: "What warning filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  const retrievalWarnings = warningResponse.body.output.warnings.filter(
    (warning) => warning.code === "RETRIEVAL_WARNING"
  );
  assertCondition(
    retrievalWarnings.length === 1 &&
      !JSON.stringify(retrievalWarnings).includes("Filing status: Single"),
    "retrieval warnings were missing or leaked source text",
    failures
  );

  const compact = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_compact",
        outputTemplate: { templateId: "rag_qa.compact.v1" },
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  const compactCreateCall = calls
    .filter((call) => call.type === "createThread")
    .find((call) => call.input.requestKey?.startsWith("req_compact:user:"));
  assertCondition(
    compact.body.output.templateId === "rag_qa.compact.v1" &&
      compactCreateCall?.input.outputTemplate?.templateId === "rag_qa.compact.v1",
    "compact output template was not persisted or returned",
    failures
  );

  const unsupportedTemplate = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_unknown_template",
        outputTemplate: { templateId: "unapproved.template.v1" },
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(
    unsupportedTemplate.status === 400 &&
      unsupportedTemplate.body.message.includes("Unsupported chat output template"),
    "unsupported output template did not return HTTP 400",
    failures
  );

  await route.POST(
    makeJsonRequest({
      requestKey: "req_template_same",
      message: { role: "user", content: "What is my filing status?" },
      documentFilter: { documentIds: ["doc_a"] },
    })
  );
  await route.POST(
    makeJsonRequest({
      requestKey: "req_template_same",
      outputTemplate: { templateId: "rag_qa.default.v1" },
      message: { role: "user", content: "What is my filing status?" },
      documentFilter: { documentIds: ["doc_a"] },
    })
  );
  await route.POST(
    makeJsonRequest({
      requestKey: "req_template_same",
      outputTemplate: { templateId: "rag_qa.compact.v1" },
      message: { role: "user", content: "What is my filing status?" },
      documentFilter: { documentIds: ["doc_a"] },
    })
  );
  const templateSameCalls = calls.filter(
    (call) =>
      call.type === "createThread" &&
      call.input.requestKey?.startsWith("req_template_same:user:")
  );
  const defaultKeys = templateSameCalls
    .filter(
      (call) =>
        call.input.outputTemplate?.templateId === "rag_qa.default.v1"
    )
    .map((call) => call.input.requestKey);
  const compactKey = templateSameCalls
    .filter(
      (call) => call.input.outputTemplate?.templateId === "rag_qa.compact.v1"
    )
    .at(-1)?.input.requestKey;
  assertCondition(
    defaultKeys.length >= 2 &&
      new Set(defaultKeys).size === 1 &&
      compactKey &&
      compactKey !== defaultKeys[0],
    "template fingerprint compatibility rules were not preserved",
    failures
  );

  const existing = await json(
    await route.POST(
      makeJsonRequest({
        threadId: "thread_existing",
        requestKey: "req_existing_template",
        outputTemplate: { templateId: "rag_qa.default.v1" },
        message: { role: "user", content: "What is my filing status?" },
      })
    )
  );
  const existingAppendUser = calls
    .filter((call) => call.type === "appendUser" && call.input.threadId === "thread_existing")
    .at(-1);
  assertCondition(
    existing.body.output.templateId === "rag_qa.compact.v1" &&
      !existingAppendUser.input.requestKey.includes("rag_qa.default"),
    "existing thread did not ignore replacement output template",
    failures
  );

  prismaModule.prisma.chatThread.findFirst = async () => ({
    id: "thread_replay",
    title: "Replay",
    documentFilter: { documentIds: ["doc_a"] },
    outputTemplate: { templateId: "rag_qa.compact.v1", templateVersion: 1 },
    createdAt: new Date("2026-06-23T08:00:00.000Z"),
    updatedAt: new Date("2026-06-23T08:05:00.000Z"),
    messages: [
      {
        id: "message_replay_user",
        role: "USER",
        sequence: 0,
        requestKey: "req_replay:user:key",
        content: "Replay question",
        citations: null,
        evidenceCoverage: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        createdAt: new Date("2026-06-23T08:00:00.000Z"),
      },
      {
        id: "message_replay_assistant",
        role: "ASSISTANT",
        sequence: 1,
        requestKey: "req_replay:assistant:key",
        content: "Persisted final answer [S2]",
        citations: [
          {
            marker: "[S2]",
            rank: 2,
            chunkId: "chunk_replay",
            documentId: "doc_a",
            pageStart: 2,
            pageEnd: 2,
            snippet: "Persisted evidence",
            sourceBlockIds: ["field_replay"],
          },
        ],
        evidenceCoverage: {
          version: 1,
          selectedDocumentIds: ["doc_a"],
          retrievedByDocumentId: { doc_a: 1 },
          finalByDocumentId: { doc_a: 1 },
          noEvidenceDocumentIds: [],
        },
        model: "local-retrieval-fallback-v0",
        inputTokens: 11,
        outputTokens: 5,
        createdAt: new Date("2026-06-23T08:04:00.000Z"),
      },
    ],
  });

  const threadRoute = require(path.join(
    repoRoot,
    "src/app/api/chat/threads/[id]/route.ts"
  ));
  const replay = await json(
    await threadRoute.GET({}, { params: Promise.resolve({ id: "thread_replay" }) })
  );
  const replayAssistant = replay.body.messages.find(
    (message) => message.role === "assistant"
  );
  const replayOutput = replayAssistant?.parts?.find(
    (part) => part.type === "data-output"
  )?.data?.output;
  assertCondition(
    replay.status === 200 &&
      replayAssistant?.parts?.[0]?.text === "Persisted final answer [S2]" &&
      replayOutput?.responseText === "Persisted final answer [S2]" &&
      replayOutput?.sources?.[0]?.marker === "[S2]" &&
      replayOutput?.metadata?.generatedAt === "2026-06-23T08:04:00.000Z" &&
      replayOutput?.metadata?.requestKey === "req_replay:assistant:key" &&
      replayOutput?.templateId === "rag_qa.compact.v1",
    "thread replay did not reconstruct deterministic data-output",
    failures
  );
  assertCondition(
    StructuredChatOutputV1Schema.safeParse(replayOutput).success,
    "thread replay output failed schema validation",
    failures
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("M4 structured output verified: legacy JSON, SSE, replay, templates");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
