/** One finite, resumable RAW/preparation pass; never claims reading or verification. */
import { resolve } from "node:path";
import { loadSources, readJson, writeJson } from "../src/io.ts";
import { fetchSource, prepareSource } from "../src/ingest/index.ts";

const root = resolve(process.argv[2] ?? ".");
const ids = process.argv.slice(3);
const sources = (await loadSources(root)).sources.filter(s => !ids.length || ids.includes(s.id));
const receiptPath = resolve(root, ".local/seed-bootstrap.json");
const prior = await readJson(receiptPath).catch(() => ({ schema_version: "rsi.seed-bootstrap.v1", sources: {}, full_read_claim: false }));
prior.started_at ??= new Date().toISOString();
let cursor = 0;
async function worker() {
  while (cursor < sources.length) {
    const source = sources[cursor++]!;
    if (prior.sources[source.id]?.preparation?.status === "prepared") continue;
    try {
      const acquisition = await fetchSource(root, source.id, { timeout_ms: 45000 });
      const preparation = await prepareSource(root, source.id);
      prior.sources[source.id] = { acquisition, preparation, observed_at: new Date().toISOString(), reading: "not_asserted" };
    } catch (error) { prior.sources[source.id] = { status: "unavailable", error: String(error), observed_at: new Date().toISOString(), reading: "not_asserted" }; }
    // All changes happen synchronously before snapshotting; each save awaits completion.
    await writeJson(receiptPath, prior);
    console.log(JSON.stringify({ source_id: source.id, status: prior.sources[source.id].preparation?.status ?? prior.sources[source.id].status }));
  }
}
// One writer keeps the receipt straightforward and respects source-service pacing.
await worker();
prior.completed_at = new Date().toISOString();
await writeJson(receiptPath, prior);
console.log(JSON.stringify({ receipt: ".local/seed-bootstrap.json", observed_sources: Object.keys(prior.sources).length, full_read_claim: false }));
