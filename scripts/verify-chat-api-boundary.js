#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("path");
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

async function main() {
  const failures = [];
  const calls = [];
  const assistantMessagesByRequestKey = new Map();

  const tenant = require(path.join(repoRoot, "src/lib/tenant.ts"));
  const persistence = require(path.join(repoRoot, "src/lib/chat-persistence.ts"));
  const retrieval = require(path.join(
    repoRoot,
    "src/lib/persisted-base-document-retrieval.ts"
  ));
  const aiConfig = require(path.join(repoRoot, "src/lib/ai/config.ts"));
  const vectorRetrieval = require(path.join(
    repoRoot,
    "src/lib/vector/vector-retrieval.ts"
  ));
  const prismaModule = require(path.join(repoRoot, "src/lib/prisma.ts"));
  let vectorRetrievalEnabled = false;
  let vectorRetrievalShouldFail = false;
  let vectorRetrievalScore = 0.91;
  let vectorRetrievalScoresByDocument = {};

  function retrievalResult(input, documentId, label, score = 1.25) {
    return {
      chunk: {
        chunkId: `chunk_${documentId}`,
        documentId,
        firmId: input.firmId,
        baseArtifactId: `artifact_${documentId}`,
        vectorGeneration: 1,
        content: label,
        contentType: "field_group",
        pageStart: 1,
        pageEnd: 1,
        formType: "Form 1040",
        sectionPath: "page/1/fields",
        tableId: null,
        sourceBlockIds: [`field_${documentId}`, `value_${documentId}`],
        parserVersion: "textract-base-v1",
        chunkStrategy: "base-document-structure-v1",
      },
      metadata: {
        chunkId: `chunk_${documentId}`,
        documentId,
        firmId: input.firmId,
        pageStart: 1,
        pageEnd: 1,
        formType: "Form 1040",
        parserVersion: "textract-base-v1",
        chunkStrategy: "base-document-structure-v1",
        contentType: "field_group",
      },
      score,
      snippet: label,
    };
  }

  tenant.getFirmScopedRequestContext = async () => ({
    userId: "user_a",
    role: "FIRM_USER",
    firmId: "firm_a",
    isAuthenticated: true,
  });

  persistence.createChatThreadWithUserMessage = async (input) => {
    calls.push({ type: "createThread", input });
    return {
      id: "thread_new",
      firmId: input.firmId,
      userId: input.userId,
      title: "What is my filing status?",
      status: "ACTIVE",
      documentFilter: input.documentFilter ?? null,
      nextMessageSequence: 1,
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      messages: [
        {
          id: "message_user_0",
          role: "USER",
          sequence: 0,
          requestKey: input.requestKey ?? null,
          content: input.messageContent,
          uiMessage: { role: "user", content: input.messageContent },
          retrievedChunkIds: null,
          citations: null,
          model: null,
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
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
      title: "Existing",
      status: "ACTIVE",
      documentFilter: { documentIds: ["doc_a"] },
      nextMessageSequence: 2,
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
      updatedAt: new Date("2026-05-15T00:00:00.000Z"),
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
      model: null,
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
    };
  };

  persistence.appendAssistantMessageToThread = async (input) => {
    calls.push({ type: "appendAssistant", input });
    if (input.requestKey && assistantMessagesByRequestKey.has(input.requestKey)) {
      return assistantMessagesByRequestKey.get(input.requestKey);
    }

    const message = {
      id: "message_assistant",
      role: "ASSISTANT",
      sequence: 3,
      requestKey: input.requestKey ?? null,
      content: input.content,
      uiMessage: { role: "assistant", content: input.content },
      retrievedChunkIds: input.retrievedChunkIds,
      citations: input.citations,
      evidenceCoverage: input.evidenceCoverage ?? null,
      model: input.model ?? null,
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
    };
    if (input.requestKey) {
      assistantMessagesByRequestKey.set(input.requestKey, message);
    }

    return message;
  };

  persistence.loadAssistantMessageByRequestKey = async (input) => {
    calls.push({ type: "loadAssistantByRequestKey", input });
    if (!input.requestKey) return null;
    return assistantMessagesByRequestKey.get(input.requestKey) ?? null;
  };

  retrieval.retrievePersistedBaseDocumentChunks = async (input) => {
    calls.push({ type: "retrieve", input });
    if (input.query.includes("unsupported")) {
      return { results: [], citations: [], warnings: [] };
    }
    if (
      input.formTypes &&
      !input.formTypes.includes("Form 1040")
    ) {
      return { results: [], citations: [], warnings: [] };
    }
    if (
      input.pageRange &&
      (input.pageRange.start > 1 || input.pageRange.end < 1)
    ) {
      return { results: [], citations: [], warnings: [] };
    }

    const documents = input.documentIds?.length ? input.documentIds : ["doc_a"];
    const labelsByDocument = {
      doc_a: "Filing status: Single",
      doc_b: "Taxpayer name: Beta Smith",
      doc_c: "Taxpayer name: Gamma Jimenez",
      doc_d: "Total wages: $40,000",
      doc_e: "Total wages: $55,000",
      doc_f: "Total wages: $72,000",
      doc_g: "Total wages: $81,000",
      doc_h: "Total wages: $93,000",
    };

    return {
      results: documents
        .filter((documentId) => labelsByDocument[documentId])
        .map((documentId) =>
          retrievalResult(input, documentId, labelsByDocument[documentId])
        ),
      citations: [],
      warnings: [],
    };
  };

  aiConfig.readM3ProviderConfig = () => ({
    aiChatEnabled: false,
    vectorIndexingEnabled: false,
    vectorRetrievalEnabled,
    vectorMinScore: 0.25,
    openAiApiKey: "sk-redacted",
    aiModel: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 1536,
    pineconeApiKey: "pc-redacted",
    pineconeIndexName: "trueblue-m3-staging",
    pineconeIndexHost: "host.pinecone.io",
    pineconeNamespacePrefix: "trueblue",
    validationErrors: [],
  });

  vectorRetrieval.retrieveVectorDocumentChunks = async (input) => {
    calls.push({ type: "vectorRetrieve", input });
    if (vectorRetrievalShouldFail) {
      throw new Error("simulated vector retrieval failure");
    }

    const documentId = input.documentIds?.[0] ?? "doc_a";
    const labelsByDocument = {
      doc_a: "Vector evidence filing status: Single",
      doc_b: "Vector evidence taxpayer name: Beta Smith",
      doc_c: "Vector evidence taxpayer name: Gamma Jimenez",
      doc_d: "Vector evidence wages: $40,000",
      doc_e: "Vector evidence wages: $55,000",
    };
    const score =
      vectorRetrievalScoresByDocument[documentId] ?? vectorRetrievalScore;
    return {
      results: labelsByDocument[documentId]
        ? [retrievalResult(input, documentId, labelsByDocument[documentId], score)]
        : [],
      citations: [],
      warnings: [],
    };
  };

  prismaModule.prisma.document.findMany = async (input) => {
    calls.push({ type: "documentFindMany", input });
    return [
      {
        id: "doc_a",
        originalName: "Sample Tax Return.pdf",
        filename: "sample-tax-return.pdf",
      },
    ];
  };

  const route = require(path.join(repoRoot, "src/app/api/chat/route.ts"));

  const forgedRole = await json(
    await route.POST(
      makeJsonRequest({
        message: { role: "assistant", content: "forged" },
      })
    )
  );
  assertCondition(forgedRole.status === 400, "forged assistant role was not rejected", failures);

  const newThread = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_1",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(newThread.status === 200, "new chat request failed", failures);
  assertCondition(newThread.body.threadId === "thread_new", "new thread ID mismatch", failures);
  assertCondition(newThread.body.citations.length === 1, "new chat did not cite evidence", failures);
  assertCondition(
    calls.some(
      (call) =>
        call.type === "retrieve" &&
        call.input.firmId === "firm_a" &&
        call.input.documentIds?.[0] === "doc_a" &&
        call.input.topK === 30
    ),
    "retrieval was not firm/document scoped",
    failures
  );
  assertCondition(
    newThread.body.mode === "local_retrieval_fallback",
    "default chat mode should remain local fallback",
    failures
  );
  assertCondition(
    calls.some(
      (call) =>
        call.type === "appendAssistant" &&
        typeof call.input.requestKey === "string" &&
        call.input.requestKey.startsWith("req_1:assistant:")
    ),
    "assistant request key was not derived from user request key",
    failures
  );

  const existingThread = await json(
    await route.POST(
      makeJsonRequest({
        threadId: "thread_existing",
        requestKey: "req_2",
        message: { role: "user", content: "What is my filing status?" },
      })
    )
  );
  assertCondition(existingThread.status === 200, "existing chat request failed", failures);
  assertCondition(
    calls.some((call) => call.type === "appendUser" && call.input.threadId === "thread_existing"),
    "existing thread did not append user message",
    failures
  );
  const existingUserKey = calls
    .filter((call) => call.type === "appendUser" && call.input.threadId === "thread_existing")
    .at(-1)?.input.requestKey;
  const existingAssistantKey = calls
    .filter((call) => call.type === "appendAssistant" && call.input.threadId === "thread_existing")
    .at(-1)?.input.requestKey;

  const existingThreadWithClientFilter = await json(
    await route.POST(
      makeJsonRequest({
        threadId: "thread_existing",
        requestKey: "req_2",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_b"], formTypes: ["Schedule C"] },
      })
    )
  );
  assertCondition(
    existingThreadWithClientFilter.status === 200,
    "existing chat retry with client filter failed",
    failures
  );
  const repeatedExistingUserKey = calls
    .filter((call) => call.type === "appendUser" && call.input.threadId === "thread_existing")
    .at(-1)?.input.requestKey;
  const repeatedExistingAssistantKey = calls
    .filter((call) => call.type === "appendAssistant" && call.input.threadId === "thread_existing")
    .at(-1)?.input.requestKey;
  assertCondition(
    existingUserKey === repeatedExistingUserKey &&
      existingAssistantKey === repeatedExistingAssistantKey,
    "existing thread request keys changed when client sent a replacement filter",
    failures
  );
  assertCondition(
    calls
      .filter((call) => call.type === "retrieve")
      .at(-1)?.input.documentIds?.[0] === "doc_a",
    "existing thread retrieval did not keep the stored document filter",
    failures
  );
  assertCondition(
    existingThreadWithClientFilter.body.answer.includes("Filing status: Single") &&
      existingThreadWithClientFilter.body.citations.length === 1,
    "existing thread retry did not return persisted assistant answer/citations",
    failures
  );

  const existingThreadWithInvalidIgnoredFilter = await json(
    await route.POST(
      makeJsonRequest({
        threadId: "thread_existing",
        requestKey: "req_invalid_filter",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: [] },
      })
    )
  );
  assertCondition(
    existingThreadWithInvalidIgnoredFilter.status === 200,
    "existing thread should ignore invalid replacement filters",
    failures
  );

  const unsupported = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_3",
        message: { role: "user", content: "unsupported question" },
      })
    )
  );
  assertCondition(unsupported.status === 200, "unsupported chat request failed", failures);
  assertCondition(
    unsupported.body.insufficientEvidence === true &&
      unsupported.body.citations.length === 0,
    "unsupported request did not return insufficient evidence",
    failures
  );

  const retrieveCountBeforeGreeting = calls.filter(
    (call) => call.type === "retrieve" || call.type === "vectorRetrieve"
  ).length;
  const greeting = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_greeting",
        message: { role: "user", content: "hi" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  const retrieveCountAfterGreeting = calls.filter(
    (call) => call.type === "retrieve" || call.type === "vectorRetrieve"
  ).length;
  assertCondition(greeting.status === 200, "simple greeting request failed", failures);
  assertCondition(
    greeting.body.citations.length === 0 &&
      greeting.body.answer.includes("Ask a question about the selected documents"),
    "simple greeting should not return document citations",
    failures
  );
  assertCondition(
    retrieveCountAfterGreeting === retrieveCountBeforeGreeting,
    "simple greeting should not trigger document retrieval",
    failures
  );
  for (const conversationalMessage of [
    "good morning",
    "yo",
    "hola",
    "Hi everyone",
    "what can you help me with?",
  ]) {
    const retrieveCountBeforeConversation = calls.filter(
      (call) => call.type === "retrieve" || call.type === "vectorRetrieve"
    ).length;
    const conversational = await json(
      await route.POST(
        makeJsonRequest({
          requestKey: `req_conversation_${conversationalMessage.replace(/\W+/g, "_")}`,
          message: { role: "user", content: conversationalMessage },
          documentFilter: { documentIds: ["doc_a"] },
        })
      )
    );
    const retrieveCountAfterConversation = calls.filter(
      (call) => call.type === "retrieve" || call.type === "vectorRetrieve"
    ).length;
    assertCondition(
      conversational.status === 200 &&
        conversational.body.citations.length === 0 &&
        conversational.body.answer.includes("Ask a question about the selected documents"),
      `conversational prompt '${conversationalMessage}' should not return document citations`,
      failures
    );
    assertCondition(
      retrieveCountAfterConversation === retrieveCountBeforeConversation,
      `conversational prompt '${conversationalMessage}' should not trigger document retrieval`,
      failures
    );
  }

  vectorRetrievalEnabled = true;
  vectorRetrievalShouldFail = false;
  const vectorMode = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_vector",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(vectorMode.status === 200, "vector-enabled chat request failed", failures);
  assertCondition(
    vectorMode.body.mode === "vector_retrieval" &&
      vectorMode.body.answer.includes("Vector evidence filing status"),
    "vector-enabled chat did not use vector retrieval evidence",
    failures
  );
  assertCondition(
    calls.some(
      (call) =>
        call.type === "vectorRetrieve" &&
        call.input.firmId === "firm_a" &&
        call.input.userId === "user_a" &&
        call.input.documentIds?.[0] === "doc_a"
    ),
    "vector retrieval was not firm/user/document scoped",
    failures
  );
  assertCondition(
    calls.some(
      (call) =>
        call.type === "appendAssistant" &&
        call.input.model === "local-grounded-vector-retrieval-v0"
    ),
    "vector retrieval assistant message did not record vector model marker",
    failures
  );

  const vectorMultiSource = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_vector_multi_source",
        message: {
          role: "user",
          content: "For each selected return, what taxpayer name is shown?",
        },
        documentFilter: { documentIds: ["doc_a", "doc_b", "doc_c"] },
      })
    )
  );
  assertCondition(vectorMultiSource.status === 200, "vector multi-source chat request failed", failures);
  assertCondition(
    vectorMultiSource.body.citations.length === 3 &&
      vectorMultiSource.body.citations.map((citation) => citation.documentId).join("|") ===
        "doc_a|doc_b|doc_c",
    "vector multi-source response did not preserve one citation per selected document",
    failures
  );
  assertCondition(
    calls
      .filter((call) => call.type === "vectorRetrieve" && call.input.documentIds?.length === 1)
      .some((call) => call.input.documentIds[0] === "doc_b") &&
      calls
        .filter((call) => call.type === "vectorRetrieve" && call.input.documentIds?.length === 1)
        .some((call) => call.input.documentIds[0] === "doc_c"),
    "vector multi-source retrieval did not query selected documents independently",
    failures
  );

  vectorRetrievalScoresByDocument = {
    doc_d: 0.91,
    doc_e: 0.04,
  };
  const vectorMixedScoreBroad = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_vector_mixed_score_broad",
        message: {
          role: "user",
          content: "Compare wages across all selected returns.",
        },
        documentFilter: { documentIds: ["doc_d", "doc_e"] },
      })
    )
  );
  assertCondition(vectorMixedScoreBroad.status === 200, "vector mixed-score broad request failed", failures);
  assertCondition(
    vectorMixedScoreBroad.body.citations.map((citation) => citation.documentId).join("|") ===
      "doc_d|doc_e",
    "broad mixed-score vector response should preserve low-score per-document fallback",
    failures
  );
  vectorRetrievalScoresByDocument = {};

  vectorRetrievalScore = 0.01;
  const fallbackAfterLowScoreVector = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_vector_low_score_fallback",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(
    fallbackAfterLowScoreVector.status === 200 &&
      fallbackAfterLowScoreVector.body.mode === "local_retrieval_fallback" &&
      fallbackAfterLowScoreVector.body.answer.includes("Filing status: Single"),
    "vector retrieval below threshold did not fall back to local retrieval",
    failures
  );

  vectorRetrievalScore = 0.91;
  vectorRetrievalShouldFail = true;
  const fallbackAfterVectorFailure = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_vector_fallback",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(
    fallbackAfterVectorFailure.status === 200 &&
      fallbackAfterVectorFailure.body.mode === "local_retrieval_fallback" &&
      fallbackAfterVectorFailure.body.answer.includes("Filing status: Single"),
    "vector failure did not fall back to local retrieval",
    failures
  );
  vectorRetrievalEnabled = false;
  vectorRetrievalShouldFail = false;

  const localMultiSource = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_local_multi_source",
        message: {
          role: "user",
          content: "Compare total wages across all three selected returns.",
        },
        documentFilter: { documentIds: ["doc_d", "doc_e", "doc_f"] },
      })
    )
  );
  assertCondition(localMultiSource.status === 200, "local multi-source chat request failed", failures);
  assertCondition(
    localMultiSource.body.citations.length === 3 &&
      localMultiSource.body.citations.map((citation) => citation.documentId).join("|") ===
        "doc_d|doc_e|doc_f",
    "local multi-source response did not preserve one citation per selected document",
    failures
  );
  assertCondition(
    localMultiSource.body.coverage?.version === 1 &&
      localMultiSource.body.coverage.finalByDocumentId?.doc_d === 1 &&
      localMultiSource.body.coverage.finalByDocumentId?.doc_e === 1 &&
      localMultiSource.body.coverage.finalByDocumentId?.doc_f === 1,
    "local multi-source coverage should reflect final public citations",
    failures
  );

  const localEightSources = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_local_eight_sources",
        message: {
          role: "user",
          content: "Give me the wages in the selected returns.",
        },
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
          ],
        },
      })
    )
  );
  assertCondition(localEightSources.status === 200, "local eight-source request failed", failures);
  assertCondition(
    localEightSources.body.citations.length === 8,
    "local fallback should render citations for all 8 selected final evidence results",
    failures
  );
  assertCondition(
    localEightSources.body.answer.includes("[S8]"),
    "local fallback answer should reference the eighth selected evidence marker",
    failures
  );

  const broadTooManySources = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_too_many_sources",
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
    broadTooManySources.status === 200 &&
      broadTooManySources.body.answer.includes("select up to 8 documents") &&
      broadTooManySources.body.citations.length === 0,
    "broad prompt with more than 8 sources should return a narrowing response without citations",
    failures
  );
  assertCondition(
    broadTooManySources.body.coverage?.version === 1 &&
      Object.values(broadTooManySources.body.coverage.finalByDocumentId ?? {}).every(
        (count) => count === 0
      ) &&
      broadTooManySources.body.coverage.noEvidenceDocumentIds?.length === 9,
    "narrowing response coverage should not mark retrieved documents as used",
    failures
  );

  const broadNaturalTooManySources = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_natural_too_many_sources",
        message: { role: "user", content: "What are the taxpayer names in the selected returns?" },
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
    broadNaturalTooManySources.status === 200 &&
      broadNaturalTooManySources.body.answer.includes("select up to 8 documents"),
    "natural broad prompt with more than 8 selected returns should trigger narrowing",
    failures
  );

  const targetedManySources = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_targeted_many_sources",
        message: { role: "user", content: "What is the filing status on doc_a?" },
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
    targetedManySources.status === 200 &&
      !targetedManySources.body.answer.includes("select up to 8 documents"),
    "targeted prompt with more than 8 sources should not trigger broad narrowing",
    failures
  );

  const emptyDocs = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_empty",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: [] },
      })
    )
  );
  assertCondition(emptyDocs.status === 400, "empty documentIds should be rejected", failures);

  const formFiltered = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_form",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"], formTypes: ["Schedule C"] },
      })
    )
  );
  assertCondition(
    formFiltered.status === 200 &&
      formFiltered.body.insufficientEvidence === true &&
      formFiltered.body.citations.length === 0,
    "form-filtered out evidence should return insufficient evidence",
    failures
  );
  assertCondition(
    calls.some(
      (call) =>
        call.type === "retrieve" &&
        call.input.formTypes?.[0] === "Schedule C"
    ),
    "form filter was not passed into retrieval",
    failures
  );

  const pageFiltered = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: "req_page",
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"], pageRange: { start: 2, end: 3 } },
      })
    )
  );
  assertCondition(
    pageFiltered.status === 200 &&
      pageFiltered.body.insufficientEvidence === true &&
      pageFiltered.body.citations.length === 0,
    "page-filtered out evidence should return insufficient evidence",
    failures
  );
  assertCondition(
    calls.some(
      (call) =>
        call.type === "retrieve" &&
        call.input.pageRange?.start === 2 &&
        call.input.pageRange?.end === 3
    ),
    "page filter was not passed into retrieval",
    failures
  );

  const beforeChangedKey = calls.filter(
    (call) => call.type === "appendAssistant" && call.input.requestKey?.startsWith("req_1:assistant:")
  ).length;
  await route.POST(
    makeJsonRequest({
      requestKey: "req_1",
      message: { role: "user", content: "A changed question using same request key" },
      documentFilter: { documentIds: ["doc_a"] },
    })
  );
  const req1AssistantKeys = calls
    .filter(
      (call) => call.type === "appendAssistant" && call.input.requestKey?.startsWith("req_1:assistant:")
    )
    .map((call) => call.input.requestKey);
  assertCondition(
    req1AssistantKeys.length === beforeChangedKey + 1 &&
      new Set(req1AssistantKeys).size === req1AssistantKeys.length,
    "changed request with same requestKey did not derive a distinct scoped key",
    failures
  );

  const longKey = "x".repeat(200);
  const longKeyResponse = await json(
    await route.POST(
      makeJsonRequest({
        requestKey: longKey,
        message: { role: "user", content: "What is my filing status?" },
        documentFilter: { documentIds: ["doc_a"] },
      })
    )
  );
  assertCondition(longKeyResponse.status === 200, "long request key should not fail", failures);
  assertCondition(
    calls
      .filter((call) => call.type === "appendAssistant")
      .some((call) => call.input.requestKey && call.input.requestKey.length <= 120),
    "server-scoped request key exceeded persistence limit",
    failures
  );

  await route.POST(
    makeJsonRequest({
      requestKey: "req_ws",
      message: { role: "user", content: "What is my filing status?" },
      documentFilter: { documentIds: ["doc_a"] },
    })
  );
  await route.POST(
    makeJsonRequest({
      requestKey: "req_ws",
      message: { role: "user", content: "  What is my filing status?  " },
      documentFilter: { documentIds: ["doc_a"] },
    })
  );
  const whitespaceKeys = calls
    .filter((call) => call.type === "createThread" && call.input.requestKey?.startsWith("req_ws:user:"))
    .map((call) => call.input.requestKey);
  assertCondition(
    whitespaceKeys.length === 2 && new Set(whitespaceKeys).size === 1,
    "whitespace-only message variants did not reuse the scoped request key",
    failures
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Chat API boundary verified: auth scope, request validation, retrieval, citations");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
