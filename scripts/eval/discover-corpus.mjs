// Discovery pass: list Acme COMPLETED docs, dump chunk text for key docs, and
// grab a Best-Tax (Firm B) doc id for the cross-tenant probe. Writes a JSON
// dump to the path given as argv[2] (default: ./corpus-dump.json).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  login,
  listCompletedDocuments,
  getDocumentWithChunks,
  BASE_URL,
} from "./lib.mjs";

const OUT = process.argv[2] || fileURLToPath(new URL("./corpus-dump.json", import.meta.url));

async function listAllDocuments(cookieHeader) {
  const res = await fetch(`${BASE_URL}/api/documents?limit=100`, {
    headers: { cookie: cookieHeader },
  });
  if (!res.ok) throw new Error(`List all documents failed: ${res.status}`);
  const body = await res.json();
  return body.documents || [];
}

const ACME = { email: "user@acmetax.com", password: "FirmUser1!" };
const BESTTAX = { email: "admin@besttax.com", password: "FirmAdmin1!" };

async function main() {
  const acme = await login(ACME.email, ACME.password);
  console.log(`Logged in Acme as ${acme.user?.email} firm=${acme.user?.firmName} (${acme.user?.firmId})`);
  const docs = await listCompletedDocuments(acme.cookieHeader);
  console.log(`\nAcme COMPLETED documents: ${docs.length}`);
  for (const d of docs) {
    console.log(`  ${d.id}  pages=${d.pageCount}  ${d.originalName}`);
  }

  // Pull chunks for every completed doc (corpus is small) so we can derive
  // grounded ground-truth from the actual extracted text.
  const docDetails = [];
  for (const d of docs) {
    const detail = await getDocumentWithChunks(acme.cookieHeader, d.id, 100);
    docDetails.push({
      id: d.id,
      originalName: d.originalName,
      pageCount: d.pageCount,
      chunkTotal: detail.chunkTotal,
      chunks: (detail.chunks || []).map((c) => ({
        chunkIndex: c.chunkIndex,
        pageNumber: c.pageNumber,
        content: c.content,
      })),
    });
  }

  // Firm B: grab one Best-Tax completed doc id for the cross-tenant probe.
  let bestTax = null;
  try {
    const b = await login(BESTTAX.email, BESTTAX.password);
    const bdocs = await listAllDocuments(b.cookieHeader);
    bestTax = {
      firmId: b.user?.firmId,
      firmName: b.user?.firmName,
      documents: bdocs.map((d) => ({
        id: d.id,
        originalName: d.originalName,
        pageCount: d.pageCount,
        status: d.status,
      })),
    };
    console.log(`\nBest-Tax (Firm B) documents (all statuses): ${bdocs.length}`);
    for (const d of bdocs) {
      console.log(`  ${d.id}  status=${d.status}  pages=${d.pageCount}  ${d.originalName}`);
    }
  } catch (err) {
    console.log(`\nBest-Tax login/list failed: ${err.message}`);
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        acme: { firmId: acme.user?.firmId, firmName: acme.user?.firmName, documents: docDetails },
        bestTax,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`\nDump written to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
