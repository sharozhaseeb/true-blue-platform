# Milestone 3 - Acceptance Testing Guide

**Stakeholder URL:** http://52.70.0.80  
**Milestone:** Vector Database & AI Integration  
**Prerequisite:** Milestone 2 document upload and processing is available

**Current AI provider:** Client-owned OpenAI key configured on staging

**Important:** The current stakeholder environment is served over HTTP, not HTTPS. Open `http://52.70.0.80/login` directly. Do not upload real client tax documents until TLS and production data-handling approval are complete. Use the sample PDFs already provided for testing.

---

## Contents

- [What This Milestone Proves](#what-this-milestone-proves)
- [Current Pre-Check](#current-pre-check)
- [Test Accounts](#test-accounts)
- [Before You Start](#before-you-start)
- [Criterion 1: Uploaded Document Is Embedded and Stored for Retrieval](#criterion-1-uploaded-document-is-embedded-and-stored-for-retrieval)
- [Criterion 2: Retrieval Is Tenant-Safe](#criterion-2-retrieval-is-tenant-safe)
- [Criterion 3: Grounded Answers Include Source Citations](#criterion-3-grounded-answers-include-source-citations)
- [Criterion 4: Unsupported Questions Return Insufficient Information](#criterion-4-unsupported-questions-return-insufficient-information)
- [Citation Negative Check: Non-Document Messages Do Not Show Sources](#citation-negative-check-non-document-messages-do-not-show-sources)
- [Criterion 5: LLM Provider Can Be Swapped by Configuration](#criterion-5-llm-provider-can-be-swapped-by-configuration)
- [Chat History Acceptance Checks](#chat-history-acceptance-checks)
- [Delete Chat Acceptance Checks](#delete-chat-acceptance-checks)
- [Delete Source File Acceptance Checks](#delete-source-file-acceptance-checks)
- [Operator Smoke Checks](#operator-smoke-checks)
- [Optional API Upload Steps](#optional-api-upload-steps)
- [Optional API Chat Smoke](#optional-api-chat-smoke)
- [Acceptance Criteria Checklist](#acceptance-criteria-checklist)

---

## What This Milestone Proves

Milestone 3 validates that uploaded documents can be embedded, stored in a tenant-safe vector layer, retrieved for user questions, and answered by an LLM with source grounding.

Scope criteria being tested:

- "An uploaded and processed document is embedded and stored in the correct tenant-specific namespace"
- "A user query retrieves relevant chunks from that tenant's documents only (no cross-tenant data leakage)"
- "System prompts enforce source-grounding: LLM responds based on retrieved context, cites source documents in responses, and explicitly states when insufficient context is available"
- "When no relevant context is found, the system returns a clear insufficient information response rather than generating an unsupported answer"
- "LLM provider can be swapped by changing a configuration value (no core code changes required)"

Related UI checks included in this guide:

- Chat history
- Collapsible source citations
- Delete chat
- Delete source files

---

## Current Pre-Check

Before sharing this guide, staging was verified on May 28, 2026 against:

- `2025 Tax Return Documents (Whittaker Jordan).pdf`
- Acme Tax firm admin account
- Best Tax firm admin account for cross-tenant checks
- Client-owned OpenAI configuration, returning model metadata `gpt-4o-mini`

Verified acceptance-level results:

- `/`, `/login`, and `/dashboard/chat` return `200`.
- Supported taxpayer-name question returns `Jordan Whittaker` with a public citation.
- Unsupported spacecraft question returns insufficient-information text with no public citations.
- Greeting `hi` returns guidance with no public citations.
- Best Tax cannot access the Acme document; the API returns `404`.

---

## Test Accounts

| Email | Password | Role | Firm |
| --- | --- | --- | --- |
| admin@acmetax.com | FirmAdmin1! | Firm Admin | Acme Tax Services |
| user@acmetax.com | FirmUser1! | Firm User | Acme Tax Services |
| admin@besttax.com | FirmAdmin1! | Firm Admin | Best Tax Advisors |

Recommended tester account for most checks:

```text
admin@acmetax.com / FirmAdmin1!
```

Browser testing is recommended for stakeholders. The optional API commands are included for deeper verification. If using curl on Windows, use Git Bash or WSL to avoid quoting issues.

The Platform Admin account is intentionally not needed for this M3 guide. M3 chat and retrieval are firm-scoped, so use a firm account for testing.

---

## How API Cookie Files Work

Some API tests use files named `acme.txt` or `best.txt`. These are not files that already exist in the repo. They are temporary local cookie files created by curl after login.

Example:

```bash
curl -c acme.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"
```

What this does:

- `-c acme.txt` saves the login cookies into a local file named `acme.txt`.
- Later commands use `-b acme.txt` to send those saved cookies back to staging.
- `acme.txt` and `best.txt` are just separate cookie sessions for different test accounts.

If a command unexpectedly returns `401 Unauthorized`, re-run the login command for that cookie file.

---

## How to Read API Placeholders

Some commands contain placeholders like `DOCUMENT_ID` or `ACME_DOCUMENT_ID`.

Replace those placeholders with the real `id` value returned by staging.

Example document list response:

```json
{
  "documents": [
    {
      "id": "cmpnngfdc0003rzbigyhovwsi",
      "originalName": "2025 Tax Return Documents (Whittaker Jordan).pdf",
      "status": "COMPLETED"
    }
  ]
}
```

If the guide says `DOCUMENT_ID`, replace it with:

```text
cmpnngfdc0003rzbigyhovwsi
```

---

## Before You Start

1. Open http://52.70.0.80/login.
   - Use `http://`, not `https://`.
2. Log in as `admin@acmetax.com`.
3. Go to http://52.70.0.80/dashboard/chat.
4. Confirm you can see:
   - a left `History` panel
   - a central `Document Q&A` chat area
   - a right `Sources` panel

If the `Sources` panel is empty, upload one sample PDF using the API upload steps near the end of this guide, then return to `/dashboard/chat`.

---

## Criterion 1: Uploaded Document Is Embedded and Stored for Retrieval

This criterion is confirmed on staging by uploading or selecting a completed document, asking a question that can only be answered from that document, and verifying the answer includes source evidence.

Stakeholders do not need direct access to Pinecone. The acceptance test confirms the deployed end-to-end behavior: processed document -> retrieval-ready evidence -> grounded answer with citation.

### Browser Test

1. In `/dashboard/chat`, look at the `Sources` panel.
2. Confirm at least one completed PDF appears.
3. Select one source document, preferably:

```text
2025 Tax Return Documents (Whittaker Jordan).pdf
```

4. Ask:

```text
What taxpayer name is shown on this return?
```

Expected result:

- The answer should identify the taxpayer as `Jordan Whittaker`.
- The answer should appear in the chat area.
- The response should include a collapsed button such as `Sources used: 1`.
- Expanding the source should show the filename, page number, and text snippet.
- The right `Sources` panel should indicate which selected source was used for the answer.

Why this validates the criterion:

- The document was processed into retrieval chunks.
- The retrieval layer found relevant evidence for the question.
- The LLM response used retrieved document evidence instead of answering from general knowledge.
- The citation proves the answer is tied back to a specific uploaded document page.

### API Confirmation

Use this if you want to confirm through the staging API instead of the browser.

Login as Acme:

```bash
curl -c acme.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"
```

List completed documents:

```bash
curl -b acme.txt "http://52.70.0.80/api/documents?status=COMPLETED&limit=5"
```

Copy one completed document `id`, then use it as `DOCUMENT_ID` in this request:

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"acceptance-criterion-1\",\"messageId\":\"criterion-1-message\",\"messages\":[{\"id\":\"criterion-1-message\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"What taxpayer name is shown on this return?\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"DOCUMENT_ID\"]}}}"
```

Expected result:

- The response streams back over the connection.
- The streamed data includes answer text.
- The streamed data includes citation data.
- The answer should be supported by the selected document.

---

## Criterion 2: Retrieval Is Tenant-Safe

This verifies that one firm cannot query or retrieve another firm's documents.

### Browser Test

1. Log in as `admin@acmetax.com`.
2. Go to `/dashboard/chat`.
3. Confirm Acme documents and Acme chat history are visible.
4. Sign out.
5. Log in as `admin@besttax.com`.
6. Go to `/dashboard/chat`.

Expected result:

- Best Tax should not see Acme's chat history.
- Best Tax should not see Acme's source documents.
- If Best Tax has no documents, the Sources panel may show no completed documents.

### API Cross-Tenant Test

Use this if you want direct proof against a specific Acme document or chat thread.

Login as Acme:

```bash
curl -c acme.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"
```

List Acme documents:

```bash
curl -b acme.txt "http://52.70.0.80/api/documents?status=COMPLETED&limit=5"
```

Copy one Acme `id` as `ACME_DOCUMENT_ID`.

Login as Best Tax:

```bash
curl -c best.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@besttax.com\",\"password\":\"FirmAdmin1!\"}"
```

Try to access the Acme document:

```bash
curl -b best.txt "http://52.70.0.80/api/documents/ACME_DOCUMENT_ID"
```

Expected result:

```json
{"error":"Not Found","message":"Document not found"}
```

Why this matters:

- The system returns `404`, not `403`, so the other tenant cannot even confirm whether the document ID exists.

---

## Criterion 3: Grounded Answers Include Source Citations

### Browser Test

1. Log in as `admin@acmetax.com`.
2. Go to `/dashboard/chat`.
3. Select `2025 Tax Return Documents (Whittaker Jordan).pdf` in the Sources panel.
4. Ask:

```text
What amount is shown for wages or total income?
```

Expected result:

- The answer should mention the supported value from the document.
- For the Whittaker Jordan sample, a known verified answer is `$27,645`.
- The answer should include a collapsed citation button.
- Expanding citations should show:
  - source marker such as `[S1]`
  - source filename
  - page number or page range
  - supporting snippet

Pass criteria:

- The answer is based on the uploaded source, not general tax knowledge.
- The source citation is visible and understandable.
- The source citation can be expanded and collapsed to reduce clutter.

### Required Multi-Source Regression Test

This check verifies that selecting multiple sources does not silently answer from only one document.

1. In `/dashboard/chat`, click `New thread`.
2. Select these three completed Acme sample PDFs:
   - `2025 Tax Return Documents (Whittaker Jordan).pdf`
   - `2025 Tax Return Documents (SMITH TALIA S and Antonio Smith).pdf`
   - `2025 Tax Return Documents (Jimenez Julio).pdf`
3. Ask:

```text
For each selected return, what taxpayer name is shown?
```

Expected result:

- The answer should address each selected return, not only one return.
- The answer should identify the taxpayer name for each return when supported by the selected evidence.
- If a selected return does not contain enough evidence for the requested field, the answer should say that for that specific return instead of silently omitting it.
- The visible citations should correspond to the selected documents actually used in the answer.
- A selected document that has no supporting evidence for the specific question may be shown as `No evidence used`; that is acceptable if the answer explicitly says the requested field was not supported for that document.

Additional multi-source check:

```text
Compare the total wages across all three selected returns.
```

Expected result:

- The assistant should not blanket-refuse if wage evidence is available in the selected returns.
- The answer should either provide supported per-return wage values with citations or clearly state which selected return lacks supporting wage evidence.
- Numeric values should only be accepted when they are tied to cited source evidence. If a number is not supported by the selected source text, the answer should omit it or state that the evidence is insufficient.

---

## Criterion 4: Unsupported Questions Return Insufficient Information

This verifies that the system does not hallucinate when the uploaded document does not support the answer.

### Browser Test

1. Stay in `/dashboard/chat`.
2. Select one source document.
3. Ask:

```text
Does this document mention a spacecraft purchase?
```

Expected result:

- The assistant should not invent an answer.
- The assistant should say that the uploaded/selected evidence does not provide enough support.
- The message should not show a `Sources used` panel unless the final answer actually uses cited source evidence.

Pass criteria:

- No unsupported claim is made.
- The answer makes clear that the information is not found in the selected source evidence.
- Public citations are reserved for evidence actually used in the final answer.

---

## Citation Negative Check: Non-Document Messages Do Not Show Sources

This verifies that citations are not shown merely because source files are selected. Citations should appear only when the final answer uses document evidence.

### Browser Test

1. Stay in `/dashboard/chat`.
2. Select one source document.
3. Ask:

```text
hi
```

Expected result:

- The assistant should respond with short guidance to ask a question about the selected documents.
- The response should not show a `Sources used` panel.
- The response should not show source snippets or citation markers.

Pass criteria:

- A greeting or non-document message does not trigger visible citations.
- The UI stays uncluttered unless document evidence was actually used.

---

## Criterion 5: LLM Provider Can Be Swapped by Configuration

This criterion should not be tested by changing live stakeholder settings during acceptance review. The safe staging confirmation is:

1. The deployed staging chat works with the currently configured client-owned OpenAI key.
2. Model/provider settings are controlled by environment variables and server-side provider modules, not by UI code changes.
3. The deployment process can restart the app with new provider/model settings without changing the chat UI or retrieval flow.

Configuration values:

- Provider settings are environment-driven:
  - `OPENAI_API_KEY`
  - `AI_MODEL`
  - `EMBEDDING_MODEL`
  - `EMBEDDING_DIMENSION`
  - `ENABLE_AI_CHAT`
  - `ENABLE_VECTOR_RETRIEVAL`
- AI, embedding, vector retrieval, and provider config are isolated in dedicated modules under:

```text
src/lib/ai/
src/lib/vector/
```

Expected result:

- The current deployment uses the configured client-owned OpenAI provider path.
- Model values can be changed through environment configuration.
- Provider-specific code is isolated server-side; the UI and retrieval flow are not tied to one model name.

Staging confirmation:

1. Log in at http://52.70.0.80/login.
2. Open `/dashboard/chat`.
3. Ask a supported document question.
4. Confirm the system returns an AI answer with source citation.

That confirms the currently configured provider path is active on staging.

Provider/model swap verification is an operator-level deployment check, not a stakeholder UI action. If the client requests a live provider/model swap test, the safe procedure is:

1. Schedule a short maintenance window.
2. Update only the approved provider/model environment variables and secrets.
3. Restart the app.
4. Re-run the same supported document question.
5. Confirm citations and insufficient-information behavior still work.

Note: M3 is currently configured for the client-owned OpenAI path. If a different provider family is requested, it should be handled through the same operator deployment procedure with a short smoke test rather than as a casual live acceptance step.

Local/operator verification commands:

```bash
npm run verify:vector-provider
npm run verify:live-vector-providers
npm run verify:chat-streaming
```

---

## Chat History Acceptance Checks

These are UI/product checks added during the M3 stakeholder polish pass.

### Test 6a: Chat is saved in history

1. Log in as `admin@acmetax.com`.
2. Go to `/dashboard/chat`.
3. Select a source document.
4. Ask a supported question.
5. Wait for the answer to finish.
6. Look at the left History panel.

Expected result:

- A new chat appears in History.
- The title should be based on the question.
- The row should show source count and message count.

### Test 6b: Open an old chat

1. Click any previous chat in the History panel.

Expected result:

- The previous messages load.
- The Sources panel shows the locked source scope for that chat.
- The selected source scope should not unexpectedly change when switching history items.

### Test 6c: Start a new thread

1. Click `New thread`.

Expected result:

- The chat area returns to the empty state.
- The Sources panel becomes selectable again.
- New questions start a separate chat instead of appending to the old one.

---

## Delete Chat Acceptance Checks

Chat deletion removes the chat from the user's history. It does not delete source documents.

### Browser Test

1. Create a temporary test chat by asking:

```text
Temporary acceptance test. What taxpayer name is shown on this return?
```

2. Confirm the new chat appears in the History panel.
3. Click the trash/delete button on that chat row.
4. Confirm the deletion prompt.

Expected result:

- The chat disappears from History.
- If it was the open chat, the screen returns to a new-thread state.
- Source documents remain available in the Sources panel.

Implementation note:

- Chat deletion is a soft delete. It hides the chat from the user's active history while preserving safer backend behavior.

---

## Delete Source File Acceptance Checks

Source-file deletion is permanent for that document: it removes the uploaded file, extracted artifacts, retrieval vectors, and database document record.

Only test this with a disposable sample upload.

Permission note:

- Firm Admin can delete source files in their firm.
- Firm User can delete their own uploaded source files.
- Firm User cannot delete another user's source file.
- Users from another firm cannot see or delete the source file.

### Recommended Safe Test

1. Upload a duplicate sample PDF using the API upload steps below.
2. Wait until it is completed.
3. Go to `/dashboard/chat`.
4. Find that newly uploaded duplicate in the Sources panel.
5. Click its source-file trash/delete button.
6. Confirm the warning prompt.

Expected result:

- The deleted source disappears from the Sources panel.
- It no longer appears in `GET /api/documents`.
- Existing old chat answers may still show historical text, but the deleted document should no longer be available for new retrieval.

Do not use this test on the main stakeholder sample documents unless you intentionally want them removed from the environment.

---

## Operator Smoke Checks

These checks are engineering smoke checks, not browser steps for stakeholders.

Before final handoff, the engineering operator should confirm only the acceptance-level behavior needed for this milestone:

- The stakeholder URL opens over HTTP:

```bash
curl -s -o /dev/null -w "%{http_code}" http://52.70.0.80/login
```

- The expected response is `200`.
- A supported document question returns an answer with citations.
- An unsupported document question returns an insufficient-information answer without invented facts.
- A greeting such as `hi` does not show citations.
- Best Tax cannot access an Acme document.

Recommended commands:

```bash
npm run verify:chat-api
npm run verify:chat-streaming
npm run verify:vector-provider
npm run verify:vector-retrieval
npm run verify:m3-quality
```

These commands are supporting engineering checks. The stakeholder acceptance checks above remain the source of truth for client testing.

---

## Optional API Upload Steps

Use this section only if the Sources panel has no completed documents or if you need a disposable duplicate document for source-delete testing.

### Login

```bash
curl -c acme.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"
```

### Upload a sample PDF

```bash
curl -b acme.txt http://52.70.0.80/api/documents/upload \
  -X POST -F "file=@/path/to/2025 Tax Return Documents (Whittaker Jordan).pdf"
```

Expected immediate result:

```json
{
  "document": {
    "id": "DOCUMENT_ID",
    "originalName": "2025 Tax Return Documents (Whittaker Jordan).pdf",
    "status": "PROCESSING",
    "providerJobId": "..."
  }
}
```

Copy the `id` value.

### Poll until processing completes

```bash
curl -b acme.txt "http://52.70.0.80/api/documents/DOCUMENT_ID"
```

Expected final result:

```json
{
  "document": {
    "id": "DOCUMENT_ID",
    "originalName": "2025 Tax Return Documents (Whittaker Jordan).pdf",
    "status": "COMPLETED",
    "pageCount": 25
  }
}
```

If the status is still `PROCESSING`, wait 10-20 seconds and poll again.

---

## Optional API Chat Smoke

Most stakeholders should use the browser UI. Use this section only if you want API-level proof that chat streams and creates a thread.

Login first:

```bash
curl -c acme.txt http://52.70.0.80/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"
```

Ask a question against one document:

```bash
curl -N -b acme.txt http://52.70.0.80/api/chat \
  -X POST -H "Content-Type: application/json" \
  -d "{\"id\":\"acceptance-thread-1\",\"messageId\":\"message-1\",\"messages\":[{\"id\":\"message-1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"What taxpayer name is shown on this return?\"}]}],\"metadata\":{\"documentFilter\":{\"documentIds\":[\"DOCUMENT_ID\"]}}}"
```

Expected result:

- The response streams text events.
- One event includes a thread ID.
- One event includes citation data.
- The final text answer should be supported by the selected document.

---

## Acceptance Criteria Checklist

Use this checklist for sign-off.

**Criterion 1 - Embedding and tenant-specific vector storage**

- [ ] A completed source document is visible in `/dashboard/chat`.
- [ ] A supported question retrieves an answer from that document.
- [ ] The answer includes a source citation.
- [ ] Optional API chat smoke returns streamed answer text and citation data for that document.

**Criterion 2 - Tenant-safe retrieval**

- [ ] Acme user can see Acme documents and chats.
- [ ] Best Tax user cannot see Acme documents or chats.
- [ ] Cross-tenant document access returns `404` when tested by API.

**Criterion 3 - Source-grounded cited answers**

- [ ] Supported question returns a relevant answer.
- [ ] Citation can be expanded.
- [ ] Citation includes filename, page number/range, and snippet.
- [ ] Multi-source taxpayer-name test addresses every selected return or explicitly notes no evidence per selected return.
- [ ] Multi-source wage comparison does not silently use only one selected source or blanket-refuse when selected evidence exists.

**Criterion 4 - Insufficient information behavior**

- [ ] Unsupported question does not produce an invented answer.
- [ ] Assistant clearly states that selected sources do not provide enough support.
- [ ] Unsupported answers do not display public citations unless source evidence is actually used.

**Citation negative check**

- [ ] A simple greeting such as `hi` returns guidance without a `Sources used` panel.
- [ ] Source citations are shown only for answers grounded in selected document evidence.

**Criterion 5 - Provider configurability**

- [ ] Provider/model settings are environment-driven.
- [ ] Staging chat confirms the currently configured provider path is active.
- [ ] Any live provider-swap test is handled as an operator deployment check, not a casual UI test.

**Additional UI checks**

- [ ] Chat history saves new chats.
- [ ] Previous chats can be reopened.
- [ ] Citations are collapsed by default and expandable.
- [ ] Chat can be deleted from History.
- [ ] Disposable source file can be deleted from Sources, if intentionally tested.

**Operator smoke checks**

- [ ] Stakeholder URL returns `200` over HTTP.
- [ ] Supported, unsupported, greeting, and tenant-isolation checks pass on staging.
- [ ] Local chat/vector smoke commands pass if run by engineering.

---

## Known Testing Notes

- The current stakeholder URL uses HTTP, so use sample data only.
- AI answers may vary slightly in wording, but they should stay grounded in the selected source evidence.
- If a source was deleted, old chat text may still appear historically, but that source should not be available for new retrieval.
- If the system says there is insufficient information, that is a correct result when the selected document does not support the question.
- Do not use provider-swap testing on the live stakeholder environment; treat it as an engineering configuration verification.
