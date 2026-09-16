import { mkdir, writeFile, cp } from "node:fs/promises";
import { createKnowledgeApi } from "../src/cli.ts";

await mkdir("dist", { recursive: true });
const result = await Bun.build({ entrypoints: ["src/cli.ts"], target: "bun", outdir: "dist", naming: "cli.js" });
if (!result.success) throw new Error(result.logs.join("\n"));
const response = await createKnowledgeApi().fetch(new Request("http://local/openapi.json"));
if (!response.ok) throw new Error(`openapi_export_${response.status}`);
await writeFile("dist/openapi.json", await response.text());
await cp("scripts/ingest", "dist/scripts/ingest", { recursive: true });
console.log(JSON.stringify({ status: "built", cli: "dist/cli.js", openapi: "dist/openapi.json", server_started: false }));
