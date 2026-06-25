# M4 Structured Output Contract

M4 adds a server-built structured output envelope to chat responses. The LLM does not author this envelope; the server builds it from the finalized answer, final public citations, evidence coverage, thread template, retrieval mode, and persisted assistant-message metadata.

## Schema

Every output object uses:

```json
{
  "schemaVersion": "trueblue.chat.output.v1",
  "templateId": "rag_qa.default.v1",
  "templateVersion": 1,
  "status": "answered",
  "responseText": "Answer text with [S1].",
  "sources": [],
  "coverage": {
    "version": 1,
    "selectedDocumentIds": [],
    "retrievedByDocumentId": {},
    "finalByDocumentId": {},
    "noEvidenceDocumentIds": []
  },
  "support": {
    "confidenceLabel": "none",
    "confidenceBasis": "No cited source support is attached to this response.",
    "retrievalMode": "local_retrieval_fallback",
    "sourceCount": 0,
    "selectedDocumentCount": 0,
    "citedDocumentCount": 0,
    "retrievalWarningCount": 0
  },
  "warnings": [],
  "metadata": {
    "threadId": "thread_id",
    "messageId": "message_id",
    "requestKey": "scoped_request_key",
    "model": "local-retrieval-fallback-v0",
    "generatedAt": "2026-06-23T00:00:00.000Z",
    "responseMode": "rag_qa"
  }
}
```

`status` is one of `answered`, `insufficient_evidence`, `narrowing_required`, or `non_document`.

`sources[]` is built only from final public citations. It includes marker/source IDs, page range, snippets, source block IDs, and retrieval metadata such as `contentType`, `sectionPath`, `tableId`, and `relevanceScore` when available.

## Templates

Registered templates are controlled in code:

- `rag_qa.default.v1`: full envelope.
- `rag_qa.compact.v1`: same schema, reduced optional source payloads.

Unknown templates fail for new threads. Existing-thread requests ignore replacement template selections and continue using the thread template. Old threads with `null` template replay as `rag_qa.default.v1`.

## Response Surfaces

Legacy `POST /api/chat` JSON keeps all existing fields and adds:

```json
{ "output": { "schemaVersion": "trueblue.chat.output.v1" } }
```

Assistant-ui streaming keeps the existing part order and adds `data-output`:

```text
data-thread
data-citations
data-coverage
data-output
text deltas
data-usage
```

Thread replay reconstructs `data-output` from persisted assistant message content, citations, coverage, model, token fields, `createdAt`, and the persisted thread template. Replay does not re-finalize text.

## Examples

Answered:

```json
{
  "schemaVersion": "trueblue.chat.output.v1",
  "templateId": "rag_qa.default.v1",
  "templateVersion": 1,
  "status": "answered",
  "responseText": "The filing status is Single [S1].",
  "sources": [
    {
      "sourceId": "S1",
      "marker": "[S1]",
      "rank": 1,
      "chunkId": "chunk_1",
      "documentId": "doc_1",
      "pageStart": 1,
      "pageEnd": 1,
      "pageLabel": "Page 1",
      "snippet": "Filing status: Single",
      "sourceBlockIds": ["field_1"],
      "contentType": "field_group",
      "sectionPath": "page/1/fields",
      "relevanceScore": 0.94
    }
  ],
  "coverage": {
    "version": 1,
    "selectedDocumentIds": ["doc_1"],
    "retrievedByDocumentId": { "doc_1": 1 },
    "finalByDocumentId": { "doc_1": 1 },
    "noEvidenceDocumentIds": []
  },
  "support": {
    "confidenceLabel": "medium",
    "confidenceBasis": "Support is based on one cited source without retrieval warnings.",
    "retrievalMode": "local_retrieval_fallback",
    "sourceCount": 1,
    "selectedDocumentCount": 1,
    "citedDocumentCount": 1,
    "retrievalWarningCount": 0
  },
  "warnings": [],
  "metadata": {
    "threadId": "thread_1",
    "messageId": "message_1",
    "generatedAt": "2026-06-23T00:00:00.000Z",
    "responseMode": "rag_qa"
  }
}
```

Insufficient evidence:

```json
{
  "schemaVersion": "trueblue.chat.output.v1",
  "templateId": "rag_qa.default.v1",
  "templateVersion": 1,
  "status": "insufficient_evidence",
  "responseText": "I could not find enough support in the uploaded documents to answer that question.",
  "sources": [],
  "coverage": {
    "version": 1,
    "selectedDocumentIds": ["doc_1"],
    "retrievedByDocumentId": { "doc_1": 0 },
    "finalByDocumentId": { "doc_1": 0 },
    "noEvidenceDocumentIds": ["doc_1"]
  },
  "support": {
    "confidenceLabel": "none",
    "confidenceBasis": "No cited source support is attached to this response.",
    "retrievalMode": "local_retrieval_fallback",
    "sourceCount": 0,
    "selectedDocumentCount": 1,
    "citedDocumentCount": 0,
    "retrievalWarningCount": 0
  },
  "warnings": [
    {
      "code": "INSUFFICIENT_EVIDENCE",
      "message": "The selected documents did not provide enough cited support.",
      "severity": "warning"
    }
  ],
  "metadata": {
    "threadId": "thread_1",
    "messageId": "message_2",
    "generatedAt": "2026-06-23T00:01:00.000Z",
    "responseMode": "rag_qa"
  }
}
```

## M6 Extension Path

M6 can add a domain payload inside a later version of this envelope, for example `domainPayload.schemaVersion = "trueblue.tax.output.v1"`. M6 should cite M4 source IDs such as `S1` rather than duplicating source text.
