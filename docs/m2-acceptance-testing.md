# Milestone 2 — Acceptance Testing Guide

**Staging URL:** http://54.208.102.72
**Milestone:** Document Upload & Processing
**Prerequisite:** Milestone 1 completed and deployed

**Important:** Staging runs over HTTP. Do NOT upload real client tax documents until TLS is configured. Use the 6 sample PDFs provided for testing.

---

## How to Test

Milestone 2 is API-only — there is no frontend UI for document uploads yet (that's Milestone 5). You can test using **curl** (command line) or **Postman** (desktop app).

Authentication uses httpOnly JWT cookies, the same as Milestone 1. If you need a refresher, refer to the M1 Acceptance Testing Guide.

### Option A: Postman (recommended if you prefer a visual tool)

1. Open Postman and create a new request
2. **Login first:** POST `http://54.208.102.72/api/auth/login` with body (raw JSON):
   ```json
   {"email": "user@acmetax.com", "password": "FirmUser1!"}
   ```
   Postman automatically stores the cookies from the response.
3. **Upload a PDF:** Create a new POST request to `http://54.208.102.72/api/documents/upload`. Under the Body tab, select "form-data", add a key named `file`, change its type to "File" (dropdown on the right), and select a sample PDF from your computer.
4. **List documents:** GET `http://54.208.102.72/api/documents` — cookies are sent automatically.
5. **View document detail:** GET `http://54.208.102.72/api/documents/DOCUMENT_ID?chunks=true` — replace DOCUMENT_ID with the `id` from the upload response.
6. **Test invalid files:** Same as step 3, but select a non-PDF file (e.g., W2.jpg) or an oversized file. Check the error response.
7. **Test deletion:** Create a DELETE request to `http://54.208.102.72/api/documents/DOCUMENT_ID`.
8. **Switch accounts:** To test as a different user, make a new POST to `/api/auth/login` with different credentials. Postman updates the cookies automatically.

All tests in this document can be performed in Postman — the curl commands are provided as an alternative. Every curl command maps directly to a Postman request with the same URL, method, and body.

### Option B: curl (command line)

**Windows note:** The curl commands in this document use Unix-style escaping (`\"` inside double quotes). On Windows, use **Git Bash** or **WSL** (Windows Subsystem for Linux) — both are included with Git for Windows. If you use Windows Command Prompt (cmd.exe) or plain PowerShell, the escaping is different and the commands will fail. Alternatively, use Postman (Option A) which works identically on all platforms.

```bash
# Step 1: Login and save cookies
curl -c cookies.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"user@acmetax.com\",\"password\":\"FirmUser1!\"}"

# Step 2: Use those cookies on subsequent requests
curl -b cookies.txt http://54.208.102.72/api/documents
```

### A note about Document IDs

When you upload a PDF, the response includes an `id` field (e.g., `"id": "cm5abc123..."`). Many of the tests below ask you to use this ID. Copy it from the upload response and paste it into the URL where you see `DOCUMENT_ID`.

**Save the ID once and reuse it (recommended for the chunk-detail tests).** If you are running the curl tests from bash (Git Bash / WSL / Linux / macOS), assign the ID to a shell variable immediately after the upload and reference it in every later call. This avoids re-pasting the ID, and — more importantly — it makes it easy to always quote the full URL, which you must do whenever it contains `?` or `&`:

```bash
# Replace with the id field from your own upload response
DOC_ID="cm5abc123..."

# Always wrap the URL in double quotes when it contains ? or &
curl -b cookies.txt "http://54.208.102.72/api/documents/$DOC_ID?chunks=true&limit=3"
```

If you forget the quotes, bash will interpret `&` as a job-control operator and silently drop everything after it, and some shells will rewrite `${VAR?…}` as a parameter-expansion. Either mistake produces a URL with no document ID in the path and the server will correctly return 404. Quoting the whole URL prevents both.

**Windows users who prefer not to deal with shell quoting should use Postman (Option A) instead of curl.** Postman constructs the URL for you, so it is not affected by shell quoting differences between cmd.exe, PowerShell, and Git Bash.

### Session expiration

Access tokens expire after 15 minutes. If you see an unexpected `{"error":"Token expired"}` response during testing, simply re-run the login command to get fresh cookies:

```bash
curl -c cookies.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"user@acmetax.com\",\"password\":\"FirmUser1!\"}"
```

---

## Test Accounts

| Email | Password | Role | Firm |
|---|---|---|---|
| admin@trueblue.dev | Admin123! | Platform Admin | — (sees all firms) |
| admin@acmetax.com | FirmAdmin1! | Firm Admin | Acme Tax Services |
| user@acmetax.com | FirmUser1! | Firm User | Acme Tax Services |
| admin@besttax.com | FirmAdmin1! | Firm Admin | Best Tax Advisors |

---

## Sample PDFs for Testing

These are the 6 sample PDFs previously provided. All are text-based with extractable text.

| File | Pages | Size | Type |
|---|---|---|---|
| Crestline Financial Group LLC | 41 | 304 KB | Business return (1120/1065) |
| ELLINGTON PETER | 43 | 301 KB | Individual 1040 |
| Jimenez Julio | 22 | 205 KB | Individual 1040 |
| SHOEMAKER JOHNNY and ANNIE | 63 | 435 KB | Individual 1040 (married filing) |
| SMITH TALIA S and Antonio Smith | 52 | 385 KB | Individual 1040 (married filing) |
| Whittaker Jordan | 25 | 264 KB | Individual 1040 |

---

## Criterion 1: API accepts PDF upload, stores in S3, associates with correct tenant

> *Scope doc: "API accepts PDF upload, stores file in cloud storage, and associates it with the correct tenant"*

### Test 1a: Upload a PDF

```bash
# Login as Acme Tax user
curl -c cookies.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"user@acmetax.com\",\"password\":\"FirmUser1!\"}"

# Upload a sample PDF (adjust the filename to match your local file)
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@2025 Tax Return Documents (Jimenez Julio).pdf"
```

**Expected:** 200 response with status COMPLETED and a chunk count:
```json
{
  "document": {
    "id": "cm5abc123...",
    "originalName": "2025 Tax Return Documents (Jimenez Julio).pdf",
    "fileSize": 210232,
    "pageCount": 22,
    "status": "COMPLETED",
    "chunkCount": 21
  }
}
```

Copy the `id` value — you will need it for later tests.

### Test 1b: Verify document appears in the document list

```bash
curl -b cookies.txt http://54.208.102.72/api/documents
```

**Expected:** The document you just uploaded appears in the list. The response contains several fields for each document — the key ones to look for are `originalName`, `status`, and `pageCount`:
```json
{
  "documents": [
    {
      "id": "cm5abc123...",
      "filename": "2025_Tax_Return_Documents_(Jimenez_Julio).pdf",
      "originalName": "2025 Tax Return Documents (Jimenez Julio).pdf",
      "mimeType": "application/pdf",
      "fileSize": 210232,
      "pageCount": 22,
      "status": "COMPLETED",
      "errorMessage": null,
      "firmId": "...",
      "uploadedById": "...",
      "createdAt": "2026-04-...",
      "updatedAt": "2026-04-..."
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

**Browser shortcut:** Log in at http://54.208.102.72/login as `user@acmetax.com`, then navigate to `http://54.208.102.72/api/documents` in the same browser tab to see the JSON response.

### Test 1b-verify: Confirm the file is stored in cloud storage (S3)

The scope requires files to be stored in cloud storage, not on the server's local disk. To verify this, fetch the document detail:

```bash
curl -b cookies.txt http://54.208.102.72/api/documents/DOCUMENT_ID
```

In the response, look for these two fields:

| Field | What it confirms | Example value |
|---|---|---|
| `s3Bucket` | Which S3 bucket the file is stored in | `"trueblue-documents-prod"` |
| `s3Key` | The file's path inside that bucket | `"firmId/documents/docId/filename.pdf"` |

If both fields are populated, the file was successfully stored in AWS S3. The `s3Key` also shows the tenant isolation structure — each firm's documents are stored under their own `firmId` prefix.

### Test 1c: Tenant isolation — other firms cannot see the document

```bash
# Login as Best Tax (a different firm)
curl -c best.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@besttax.com\",\"password\":\"FirmAdmin1!\"}"

# List their documents — should be empty
curl -b best.txt http://54.208.102.72/api/documents
```

**Expected:** Empty list — Best Tax cannot see Acme Tax's documents:
```json
{"documents":[],"total":0,"page":1,"limit":20}
```

### Test 1d: Cross-tenant access to a specific document returns 404

```bash
# Try to access Acme's document as Best Tax (use the ID from test 1a)
curl -b best.txt http://54.208.102.72/api/documents/DOCUMENT_ID
```

**Expected:** 404 Not Found:
```json
{"error":"Not Found","message":"Document not found"}
```

The system deliberately returns 404 (not 403) so that someone from another firm cannot even tell whether a document ID exists. This is a security measure to prevent ID enumeration.

### Test 1e: Platform Admin can see documents across all firms

```bash
# Login as Platform Admin
curl -c admin.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@trueblue.dev\",\"password\":\"Admin123!\"}"

# List all documents across all firms
curl -b admin.txt http://54.208.102.72/api/documents
```

**Expected:** The response includes the Acme Tax document you uploaded, even though Platform Admin is not part of Acme Tax. Platform Admin has visibility across all firms.

Platform Admin can also filter by firm using `?firmId=` — the firm ID is visible in the `firmId` field of any document in the list above:
```bash
curl -b admin.txt "http://54.208.102.72/api/documents?firmId=FIRM_ID_FROM_ABOVE"
```

**Note:** The `?firmId=` filter only works for Platform Admin. If a Firm User or Firm Admin tries it, the parameter is silently ignored and they only see their own firm's documents.

### Test 1f: Firm Admin and Firm User can upload

Both Firm Admin and Firm User have the `upload_documents` permission. You can verify by uploading a PDF while logged in as `admin@acmetax.com` (Firm Admin) and `user@acmetax.com` (Firm User).

**Note:** Platform Admin also has the `upload_documents` permission, but cannot upload on staging because Platform Admin is not associated with any firm. Uploads require a firm context so that documents are stored under the correct tenant. If a Platform Admin attempts to upload, the API returns:
```json
{"error":"Bad Request","message":"Upload requires a firm context"}
```

---

## Criterion 2: Invalid file types and oversized files rejected with descriptive errors

> *Scope doc: "Invalid file types and oversized files are rejected with descriptive error responses"*

For these tests, stay logged in as `user@acmetax.com` (or any account).

### Test 2a: Wrong file type (not a PDF)

Upload a non-PDF file, such as the W2.jpg sample image:

```bash
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@W2.jpg"
```

**Expected:** 415 Unsupported Media Type with a descriptive message:
```json
{"error":"Unsupported Media Type","message":"File must have a .pdf extension"}
```

### Test 2b: Renamed file that is not actually a PDF

The system does not just check the file extension — it also inspects the first few bytes of the file to confirm it is a real PDF. To test this:

1. Take any non-PDF file (e.g., a .txt or .jpg file)
2. Rename it to end in `.pdf` (e.g., rename `notes.txt` to `notes.pdf`)
3. Upload it:

```bash
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@notes.pdf"
```

**Expected:** 415 Unsupported Media Type — rejected even though the extension is .pdf:
```json
{"error":"Unsupported Media Type","message":"File does not appear to be a valid PDF (invalid magic bytes)"}
```

This 3-layer validation (extension + MIME type + file content inspection) prevents spoofed uploads.

### Test 2c: Oversized file (> 20 MB)

Upload a file larger than 20 MB. If you don't have a large PDF handy, create a dummy test file:

**Mac / Linux:**
```bash
dd if=/dev/zero bs=1048576 count=21 > too_large.pdf
```

**Windows (PowerShell):**
```powershell
$f = New-Object byte[] (21 * 1024 * 1024); [System.IO.File]::WriteAllBytes("too_large.pdf", $f)
```

**Postman:** In the Body tab (form-data), select the `too_large.pdf` file you just created as the `file` field and send the request.

**curl:**
```bash
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@too_large.pdf"
```

**Expected:** 413 Payload Too Large:
```json
{"error":"Payload Too Large","message":"File size exceeds maximum of 20MB"}
```

The size limit is enforced at two levels — the application rejects files >20MB, and Nginx rejects anything >25MB before it even reaches the application.

### Test 2d: No file provided

Send a request with form data but without the `file` field:

```bash
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "other=test"
```

**Expected:** 400 Bad Request:
```json
{"error":"Bad Request","message":"No file provided. Use the 'file' field."}
```

### Test 2e: No authentication

```bash
# No login cookies — just hit the endpoint directly (use any of the sample PDFs)
curl http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@2025 Tax Return Documents (Jimenez Julio).pdf"
```

**Expected:** 401 Unauthorized:
```json
{"error":"Unauthorized"}
```

---

## Criterion 3: Text successfully extracted from a sample text-based PDF

> *Scope doc: "Text is successfully extracted from a sample text-based PDF"*

### Test 3a: View the extracted text

Use the document ID from test 1a to fetch the document detail with chunks:

```bash
curl -b cookies.txt "http://54.208.102.72/api/documents/DOCUMENT_ID?chunks=true&limit=3"
```

**Expected:** The response includes document metadata plus a `chunks` array. The key thing to look for is readable text in the `content` field of each chunk:

```json
{
  "document": {
    "id": "cm5abc123...",
    "filename": "2025_Tax_Return_Documents_(Jimenez_Julio).pdf",
    "originalName": "2025 Tax Return Documents (Jimenez Julio).pdf",
    "s3Key": "firmId/documents/docId/2025_Tax_Return_Documents_(Jimenez_Julio).pdf",
    "s3Bucket": "trueblue-documents-prod",
    "mimeType": "application/pdf",
    "fileSize": 210232,
    "pageCount": 22,
    "status": "COMPLETED",
    "errorMessage": null,
    "firmId": "...",
    "uploadedById": "...",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "chunks": [
    {
      "id": "...",
      "content": "Department of the Treasury-Internal Revenue Service\nU.S. Individual Income Tax Return 2025\nForm 1040...",
      "pageNumber": 1,
      "chunkIndex": 0,
      "tokenEstimate": 487,
      "metadata": {
        "filename": "2025_Tax_Return_Documents_(Jimenez_Julio).pdf",
        "formType": "Form 1040"
      }
    }
  ],
  "chunkTotal": 21
}
```

The `content` field contains the actual text extracted from each page of the PDF. Read through a few chunks to confirm the text is accurate and readable.

### What text cleaning and normalization is applied

The scope lists "text cleaning and normalization" as a deliverable. Before chunking, every page of extracted text goes through the following processing:

This remediation is conservative: it preserves visible selectable footer text instead of stripping it, so contract checks can still see `Page X of Y`, `DO NOT FILE`, and `DRAFT` when they are present in the PDF.

- **Unicode normalization** — curly quotes are straightened (`"` → `"`), em-dashes converted to hyphens, non-breaking spaces converted to regular spaces
- **Whitespace cleanup** — excessive blank lines and runs of spaces are collapsed so the text is readable without visual noise
- **Control character removal** — invisible characters (null bytes, form feeds, vertical tabs) that appear in some PDF exports are stripped
- **Visible text preservation** — selectable footer-style text is kept when it is visible in the PDF, including `Page X of Y`, `DO NOT FILE`, and `DRAFT`
- **Tax data preservation** — dollar signs, commas in numbers, percentages, dates, and form line numbers are explicitly preserved through all cleaning steps

You can observe these effects in the `content` field: the text should be clean, readable, and biased toward preserving content rather than stripping visible text.

The current pass also keeps visible text intact so page-level and chunk-level checks can assert against the same content the user can select in the PDF.

### Test 3b: Verify financial data is preserved accurately

Spot-check the `content` field across several chunks. Open the original PDF side by side and compare specific values:

1. **Page 1** — Find the `Form 1040` heading and the taxpayer name. Both should be present and match the PDF.
2. **A page with income figures** — Look for a line with a dollar amount (e.g., wages, adjusted gross income). The dollar sign, commas, and digits should all be intact (e.g., `$87,000` not `87000` or garbled text).
3. **A schedule page** — Find a Schedule (A, B, C, etc.) and verify the schedule title and at least one line item with a number match the PDF.

**Pass criteria:** The extracted text is readable, financial figures match the source PDF, and form structure is recognizable. Minor whitespace differences from the original are expected (this is a result of the normalization described above).

### Test 3c: Upload all 6 sample PDFs

Upload each of the 6 sample PDFs and confirm they all return status `COMPLETED`. Adjust the filenames below to match the exact filenames on your computer:

```bash
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@Crestline Financial Group LLC.pdf"

curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@ELLINGTON PETER.pdf"

curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@Jimenez Julio.pdf"

curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@SHOEMAKER JOHNNY and ANNIE.pdf"

curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@SMITH TALIA S and Antonio Smith.pdf"

curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@Whittaker Jordan.pdf"
```

**Important:** Replace the filenames above with the exact filenames of the sample PDFs on your computer. The names shown are abbreviated — your files may have a longer name like `2025 Tax Return Documents (Jimenez Julio).pdf`.

**Note:** Uploads are processed one at a time on staging (to prevent memory issues), so if you run these too quickly back-to-back, you may see a "Too Many Requests" response. Wait for each upload to finish before starting the next one. If you already uploaded some of these in earlier tests, that's fine — duplicates are allowed and each upload gets its own unique ID.

**Expected:** All 6 return status `COMPLETED` with page counts matching the sample PDFs table above.

---

## Criterion 4: Text chunked with metadata (file name, page number) attached

> *Scope doc: "Text is chunked with metadata (file name, page number) attached to each chunk"*

### Test 4a: Verify chunk metadata fields

```bash
curl -b cookies.txt "http://54.208.102.72/api/documents/DOCUMENT_ID?chunks=true&limit=5"
```

Every chunk in the response should have these fields. `metadata.formType` is the stable public alias for the chunk's resolved IRS form ownership; `metadata.explicitFormType` is the page-local detection, and `metadata.resolvedFormType` is the canonical value returned to callers. Legacy rows that do not record provenance should keep `metadata.formTypeSource` as `null` rather than inventing `propagated`.

| Field | What it is | Example |
|---|---|---|
| `pageNumber` | Which page of the PDF this text came from (starts at 1) | `1`, `2`, `15` |
| `chunkIndex` | Sequential position across all chunks (starts at 0) | `0`, `1`, `2` |
| `tokenEstimate` | Approximate number of tokens (for AI processing in M3) | `487` |
| `metadata.filename` | The sanitized filename (spaces replaced with underscores) | `"2025_Tax_Return_Documents_(Jimenez_Julio).pdf"` |
| `metadata.formType` | Stable public form type alias for the chunk's resolved ownership | `"Form 1040"`, `"Schedule C"`, `null` |
| `metadata.explicitFormType` | Form type detected directly on that page, or `null` when none was detected on that page | `"Form 1040"`, `null` |
| `metadata.resolvedFormType` | Canonical resolved form ownership for the chunk | `"Form 1040"`, `"Schedule C"`, `null` |
| `metadata.formTypeSource` | Whether the form type was detected explicitly or propagated; legacy rows with unknown provenance stay `null` | `"explicit"`, `"propagated"`, `null` |

### Test 4b: Verify chunk count is reasonable

The number of chunks should be close to the number of pages. Current sample PDFs land a little below page count because some pages are empty or near-empty, and long pages can still split into multiple chunks when they exceed the token cap:

| Document | Pages | Expected Chunks (approx) |
|---|---|---|
| Jimenez Julio | 22 | 17-22 |
| Whittaker Jordan | 25 | 20-25 |
| Crestline Financial Group LLC | 41 | 35-41 |
| ELLINGTON PETER | 43 | 37-43 |
| SMITH TALIA S and Antonio Smith | 52 | 45-52 |
| SHOEMAKER JOHNNY and ANNIE | 63 | 55-63 |

You can see the `chunkCount` in the upload response, or check `chunkTotal` in the detail response.

### Test 4c: Verify IRS form type detection

`metadata.formType` is now the resolved form-ownership label for the chunk, not only the page-local explicit header detection. That means continuation pages can legitimately keep the same `formType` even when the later page does not repeat the full form header, while unrelated/support pages should still return `null`.

The system automatically identifies IRS form types from the extracted text. Check chunks from different pages — you should see detected form types like:

- `Form 1040` — Individual income tax return
- `Schedule A`, `Schedule B`, `Schedule C` — Itemized deductions, interest, business income
- `Form 1120` or `Form 1065` — Business returns (from the Crestline Financial document)
- `Schedule K-1` — Partner's share of income

Not every chunk will have a `formType`. Pages that don't contain a recognizable IRS form header will show `null` — this is expected.

### Test 4d: Verify chunk pagination

For documents with many chunks, you can page through them:

```bash
# First 5 chunks
curl -b cookies.txt "http://54.208.102.72/api/documents/DOCUMENT_ID?chunks=true&page=1&limit=5"

# Next 5 chunks
curl -b cookies.txt "http://54.208.102.72/api/documents/DOCUMENT_ID?chunks=true&page=2&limit=5"
```

**Expected:** Each page returns a different set of chunks. The `chunkTotal` field tells you the total number of chunks across all pages.

---

## Additional Feature: Document Deletion

Document deletion was implemented in M2 for completeness, even though it was not listed in the acceptance criteria. Three levels of delete authorization are enforced:

| Who | Can Delete |
|---|---|
| Document owner (any role) | Their own documents |
| Firm Admin | Any document in their firm |
| Platform Admin | Any document in any firm |
| Firm User (not the owner) | Blocked (403) |
| User from another firm | Blocked (404) |

### Test 5a: Owner deletes their own document

Upload a document as `user@acmetax.com`, then delete it:

```bash
# Upload
curl -b cookies.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@2025 Tax Return Documents (Whittaker Jordan).pdf"

# Copy the "id" from the response, then delete it
curl -b cookies.txt -X DELETE http://54.208.102.72/api/documents/DOCUMENT_ID
```

**Expected:** 204 No Content (empty response body). The document no longer appears when you list documents.

### Test 5b: Firm Admin deletes another user's document

Use the ID of a document uploaded by `user@acmetax.com` from earlier tests (e.g., one of the documents from test 3c), and delete it as `admin@acmetax.com`:

```bash
# Login as Firm Admin
curl -c firm_admin.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"

# Delete a document that was uploaded by user@acmetax.com
curl -b firm_admin.txt -X DELETE http://54.208.102.72/api/documents/DOCUMENT_ID
```

**Expected:** 204 No Content. Firm Admins can delete any document within their firm.

### Test 5c: Non-owner Firm User is blocked

First, upload a document as `admin@acmetax.com` (Firm Admin):

```bash
# Login as Firm Admin
curl -c firm_admin.txt http://54.208.102.72/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@acmetax.com\",\"password\":\"FirmAdmin1!\"}"

# Upload a document as Firm Admin
curl -b firm_admin.txt http://54.208.102.72/api/documents/upload \
  -X POST -F "file=@2025 Tax Return Documents (Jimenez Julio).pdf"
```

Copy the `id` from the response. Now try to delete it as `user@acmetax.com` (Firm User who did NOT upload it):

```bash
curl -b cookies.txt -X DELETE http://54.208.102.72/api/documents/DOCUMENT_ID
```

**Expected:** 403 Forbidden:
```json
{"error":"Forbidden","message":"You do not have permission to delete this document"}
```

### Test 5d: Cross-tenant delete returns 404

Try to delete an Acme Tax document while logged in as Best Tax:

```bash
curl -b best.txt -X DELETE http://54.208.102.72/api/documents/DOCUMENT_ID
```

**Expected:** 404 Not Found (not 403 — same ID-enumeration protection as in test 1d):
```json
{"error":"Not Found","message":"Document not found"}
```

---

## Additional Feature: Failure Recovery

The system includes automatic cleanup on startup. If the server restarts while an upload is in progress (e.g., during a deployment), any documents stuck in `UPLOADING` or `PROCESSING` status for more than 5 minutes are automatically marked as `FAILED` so they don't appear stuck forever.

You can view failed documents by filtering the document list:

```bash
curl -b cookies.txt "http://54.208.102.72/api/documents?status=FAILED"
```

---

## Acceptance Criteria Checklist

Use this checklist to confirm all four acceptance criteria are met:

**Criterion 1 — Upload, storage, and tenant association:**
- [ ] PDF upload returns 200 with status COMPLETED and a chunk count (test 1a)
- [ ] Uploaded document appears in the document list (test 1b)
- [ ] Document detail shows s3Bucket and s3Key confirming cloud storage (test 1b-verify)
- [ ] A different firm's user cannot see the document in their list (test 1c)
- [ ] A different firm's user gets 404 when accessing the document by ID (test 1d)
- [ ] Platform Admin can see documents across all firms (test 1e)

**Criterion 2 — Invalid files rejected with descriptive errors:**
- [ ] Non-PDF file (e.g., .jpg) rejected with 415 and descriptive message (test 2a)
- [ ] Renamed non-PDF file rejected based on content inspection (test 2b)
- [ ] File > 20MB rejected with 413 (test 2c)
- [ ] Missing file rejected with 400 (test 2d)
- [ ] Unauthenticated request rejected with 401 (test 2e)

**Criterion 3 — Text extraction, cleaning, and normalization:**
- [ ] Chunks contain readable, clean text extracted from the PDF (test 3a)
- [ ] Visible page text that is selectable in the PDF is preserved rather than stripped aggressively (test 3a)
- [ ] Visible repeated headers or footers may still appear when they are part of the selectable page content (test 3a)
- [ ] Text is normalized — no garbled characters, excessive whitespace, or repeated headers (test 3a)
- [ ] Dollar amounts, form line numbers, and dates match the source PDF (test 3b)
- [ ] All 6 sample PDFs upload and process successfully with status COMPLETED (test 3c)

**Criterion 4 — Chunking with metadata:**
- [ ] Each chunk has pageNumber, chunkIndex, and metadata fields (test 4a)
- [ ] Chunk counts are reasonable relative to page counts (test 4b)
- [ ] IRS form types are detected (Form 1040, Schedule C, etc.) (test 4c)

---

## What's Not Included in M2

These features are planned for later milestones:

| Feature | Milestone |
|---|---|
| Document list UI with upload button | Milestone 5 |
| OCR for scanned/image PDFs (like W2.jpg) | Milestone 5 |
| Vector embeddings from text chunks | Milestone 3 |
| Natural language querying / chat | Milestone 3 + 4 |
