// Shared eval helpers for the M4 output-quality baseline harness.
// Node 20+ (global fetch), ESM, no new dependencies.
// This file only talks to the running app over HTTP. It does NOT import or
// modify any application code.

export const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";

/**
 * Log in and return the cookie header to resend on subsequent requests.
 * Node 20 fetch has no cookie jar, so we capture Set-Cookie manually.
 */
export async function login(email, password) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Login failed for ${email}: ${res.status} ${text}`);
  }
  // getSetCookie() returns an array of Set-Cookie header values (Node 20+).
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  const cookiePairs = setCookies
    .map((c) => c.split(";")[0])
    .filter((c) => c && c.includes("="));
  const cookieHeader = cookiePairs.join("; ");
  const body = await res.json().catch(() => ({}));
  return { cookieHeader, user: body.user };
}

export async function listCompletedDocuments(cookieHeader) {
  const res = await fetch(
    `${BASE_URL}/api/documents?status=COMPLETED&limit=100`,
    { headers: { cookie: cookieHeader } }
  );
  if (!res.ok) {
    throw new Error(`List documents failed: ${res.status}`);
  }
  const body = await res.json();
  return body.documents || [];
}

export async function getDocumentWithChunks(cookieHeader, id, limit = 100) {
  const res = await fetch(
    `${BASE_URL}/api/documents/${id}?chunks=true&limit=${limit}`,
    { headers: { cookie: cookieHeader } }
  );
  if (!res.ok) {
    throw new Error(`Get document ${id} failed: ${res.status}`);
  }
  return res.json();
}

/**
 * POST /api/chat using the non-streaming legacy_json path. This returns the
 * full {output, answer, citations, coverage, ...} object, where `output` is the
 * identical StructuredChatOutputV1 envelope that the streaming `data-output`
 * part carries (both are built by buildOutputForFinalResponse in route.ts).
 * Every question runs as a NEW thread (no threadId) so documentFilter is honored.
 */
export async function postChat(cookieHeader, { content, documentIds }) {
  const body = { message: { role: "user", content } };
  if (documentIds && documentIds.length > 0) {
    body.documentFilter = { documentIds };
  }
  const startedAt = Date.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - startedAt;
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* keep raw for diagnostics */
  }
  return { status: res.status, ok: res.ok, latencyMs, json, raw };
}

// ---------------------------------------------------------------------------
// Numeric grounding helpers — mirror src/lib/ai/grounding-check.ts so the
// harness's hallucination signal uses the same definition the app enforces.
// ---------------------------------------------------------------------------
const NUMERIC_CLAIM_PATTERN =
  /(?:\$|\bUSD\s*)?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$\s*\d+(?:\.\d+)?/gi;

function normalizeNumber(value) {
  return value
    .toLowerCase()
    .replace(/usd/g, "")
    .replace(/[$,\s]/g, "")
    .replace(/\.00$/g, "");
}

export function extractGroundedNumbers(text) {
  return [...String(text).matchAll(NUMERIC_CLAIM_PATTERN)]
    .map((m) => ({ raw: m[0].trim(), norm: normalizeNumber(m[0]) }))
    .filter((n) => n.norm);
}

export function numbersInSources(sources) {
  const set = new Set();
  for (const s of sources || []) {
    const text = `${s.snippet || ""} ${s.snippetFull || ""}`;
    for (const n of extractGroundedNumbers(text)) {
      set.add(n.norm);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// Schema validation — replicates the invariants of StructuredChatOutputV1Schema
// (src/lib/chat-output-schema.ts) at the JS level so the .mjs harness needs no
// build step. Returns an array of human-readable violations ([] === valid).
// ---------------------------------------------------------------------------
export function validateOutputSchema(output) {
  const errors = [];
  if (!output || typeof output !== "object") {
    return ["output missing or not an object"];
  }
  if (output.schemaVersion !== "trueblue.chat.output.v1") {
    errors.push(`schemaVersion !== trueblue.chat.output.v1 (got ${output.schemaVersion})`);
  }
  const validStatuses = ["answered", "insufficient_evidence", "narrowing_required", "non_document"];
  if (!validStatuses.includes(output.status)) {
    errors.push(`invalid status ${output.status}`);
  }
  const sources = Array.isArray(output.sources) ? output.sources : [];
  const coverage = output.coverage || {};
  const support = output.support || {};
  const selected = new Set(coverage.selectedDocumentIds || []);
  const citedDocs = new Set();

  sources.forEach((s, i) => {
    citedDocs.add(s.documentId);
    if (!selected.has(s.documentId)) {
      errors.push(`sources[${i}].documentId ${s.documentId} not in coverage.selectedDocumentIds`);
    }
    if (s.marker !== `[${s.sourceId}]`) {
      errors.push(`sources[${i}].marker ${s.marker} != [${s.sourceId}]`);
    }
    if (!/^S[1-9][0-9]*$/.test(s.sourceId || "")) {
      errors.push(`sources[${i}].sourceId invalid: ${s.sourceId}`);
    }
    if (!(Number.isInteger(s.pageStart) && s.pageStart >= 1)) {
      errors.push(`sources[${i}].pageStart invalid: ${s.pageStart}`);
    }
    if (!(Number.isInteger(s.pageEnd) && s.pageEnd >= 1)) {
      errors.push(`sources[${i}].pageEnd invalid: ${s.pageEnd}`);
    }
    if (Number.isInteger(s.pageStart) && Number.isInteger(s.pageEnd) && s.pageEnd < s.pageStart) {
      errors.push(`sources[${i}] pageEnd ${s.pageEnd} < pageStart ${s.pageStart}`);
    }
  });

  if (support.sourceCount !== sources.length) {
    errors.push(`support.sourceCount ${support.sourceCount} != sources.length ${sources.length}`);
  }
  if (support.selectedDocumentCount !== (coverage.selectedDocumentIds || []).length) {
    errors.push(
      `support.selectedDocumentCount ${support.selectedDocumentCount} != selectedDocumentIds.length ${(coverage.selectedDocumentIds || []).length}`
    );
  }
  if (support.citedDocumentCount !== citedDocs.size) {
    errors.push(`support.citedDocumentCount ${support.citedDocumentCount} != unique cited docs ${citedDocs.size}`);
  }
  // coverage internal consistency
  for (const docId of coverage.selectedDocumentIds || []) {
    if (!(docId in (coverage.finalByDocumentId || {}))) {
      errors.push(`selected doc ${docId} missing from finalByDocumentId`);
    }
  }
  for (const docId of Object.keys(coverage.finalByDocumentId || {})) {
    if (!selected.has(docId)) {
      errors.push(`finalByDocumentId key ${docId} not selected`);
    }
  }
  return errors;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
