// Verify that vector_retrieval now works after the backfill. Talks to the
// running app over HTTP only (login + postChat from lib.mjs).
import { login, postChat } from "./lib.mjs";

const ACME = { email: "user@acmetax.com", password: "FirmUser1!" };
const WHIT = "cmnkctmr4006sfbpbhao7db8j"; // Whittaker Jordan (25p)
const JIM = "cmnkctkep0030fbpb13mzl3ru"; // Jimenez Julio (22p)

const PROBES = [
  { label: "WHIT filing status", documentIds: [WHIT], content: "What is the filing status reported on this return?" },
  { label: "WHIT taxpayer name", documentIds: [WHIT], content: "Whose individual income tax return is this? Provide the taxpayer's name." },
  { label: "JIM total tax (numeric)", documentIds: [JIM], content: "What is the total tax on this return?" },
];

async function main() {
  const acme = await login(ACME.email, ACME.password);
  console.log(`Logged in as ${acme.user?.email} firm=${acme.user?.firmName}\n`);

  for (const p of PROBES) {
    const r = await postChat(acme.cookieHeader, { content: p.content, documentIds: p.documentIds });
    const o = r.json && r.json.output;
    const support = (o && o.support) || {};
    const sources = (o && o.sources) || [];
    const answer = (r.json && (r.json.answer ?? (o && o.responseText))) || "";
    console.log(`### ${p.label}`);
    console.log(`Q: ${p.content}`);
    console.log(
      `status=${o && o.status} retrievalMode=${support.retrievalMode} ` +
        `model=${o && o.metadata && o.metadata.model} confidence=${support.confidenceLabel} ` +
        `sources=${sources.length} latency=${r.latencyMs}ms http=${r.status}`
    );
    console.log(`A: ${answer}`);
    if (sources.length) {
      console.log("Sources:");
      for (const s of sources) {
        console.log(
          `  ${s.marker} ${s.filename} p.${s.pageStart}-${s.pageEnd} score=${s.relevanceScore} :: ${(s.snippet || "").slice(0, 120).replace(/\s+/g, " ")}`
        );
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
