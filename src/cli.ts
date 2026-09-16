import { createAicatlog, type Extension } from "aicatlog";
import { z } from "zod";
import { resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadSources, readJson } from "./io.ts";
import { renderDashboard, viewSchema } from "@codex-rsi/view-kit";

async function buildAndView(root: string, render = false) {
  const result = await (await import("./knowledge/index.ts")).buildKnowledge(root);
  if (!result.ok || !result.coverage || !result.view) return result;
  const view = viewSchema.parse(result.view);
  await mkdir(resolve(root, "views"), { recursive: true });
  await writeFile(resolve(root, "views/current.json"), JSON.stringify(view, null, 2) + "\n");
  if (render) { await mkdir(resolve(root, "docs"), { recursive: true }); await writeFile(resolve(root, "docs/index.html"), renderDashboard(view)); }
  return { schema_version: result.schema_version, ok: result.ok, generated_at: result.generated_at,
    written_count: result.written.length, source_count: result.coverage.length,
    view: "views/current.json", dashboard: render ? "docs/index.html" : null, lint: result.lint };
}

const objectOutput = z.record(z.string(), z.unknown());
const rootOption = { root: z.string().optional().describe("Explicit source-owned KB root") };
const jsonArg = z.string().describe("JSON object or @path to a JSON input file");
async function inputJson(value: string) { return value.startsWith("@") ? readJson(resolve(value.slice(1))) : JSON.parse(value); }

export function createKnowledgeApi(defaultRoot = process.cwd()) {
  const base = resolve(defaultRoot);
  const root = (input: any) => resolve(input.root ?? base);
  const checked = (fn: (input: any) => Promise<any>) => async (_ctx: unknown, input: any) => objectOutput.parse(await fn(input));
  const extension: Extension = { namespace: "kb", commands: {
    sources: { description: "List registered source identities; registration does not mean reading or verification.", readOnly: true,
      options: z.object({ ...rootOption, id: z.string().optional(), limit: z.number().int().min(1).max(500).default(20), offset: z.number().int().min(0).default(0) }),
      run: checked(async i => { const m = await loadSources(root(i)); const rows = m.sources.filter(s => !i.id || s.id === i.id); return { schema_version: "rsi.source-list.v1", total: rows.length, sources: rows.slice(i.offset, i.offset + i.limit), next_offset: i.offset + i.limit < rows.length ? i.offset + i.limit : null }; }) },
    fetch: { description: "Preserve exact-version HTML/TeX or a configured source as immutable local RAW.", sourceWrite: true,
      args: z.object({ id: z.string() }), options: z.object({ ...rootOption, refresh: z.boolean().default(false) }),
      run: checked(async i => (await import("./ingest/index.ts")).fetchSource(root(i), i.id, { refresh: i.refresh })) },
    prepare: { description: "Prepare faithful text, TeX context, llms.txt navigation and source maps from preserved RAW.", sourceWrite: true,
      args: z.object({ id: z.string() }), options: z.object(rootOption),
      run: checked(async i => (await import("./ingest/index.ts")).prepareSource(root(i), i.id)) },
    inspect: { description: "Inspect one source's current acquisition/preparation evidence without expanding the corpus.", readOnly: true,
      args: z.object({ id: z.string() }), options: z.object(rootOption),
      run: checked(async i => (await import("./ingest/index.ts")).inspectSource(root(i), i.id)) },
    contribute: { description: "Import a source-bound draft Wiki contribution; evidence validity is not a truth verdict.", sourceWrite: true,
      args: z.object({ contribution: jsonArg }), options: z.object(rootOption),
      run: checked(async i => (await import("./knowledge/index.ts")).importContribution(root(i), await inputJson(i.contribution))) },
    lint: { description: "Report OKF format, citations, links, evidence and trust boundaries separately.", readOnly: true,
      options: z.object(rootOption), run: checked(async i => (await import("./knowledge/index.ts")).lintKnowledge(root(i))) },
    build: { description: "Build derived Wiki indexes, backlinks, source coverage and a current view.", sourceWrite: true,
      options: z.object(rootOption), run: checked(async i => buildAndView(root(i))) },
    view: { description: "Read a bounded section of the generated KB view; use render after source changes.", readOnly: true,
      options: z.object({ ...rootOption, section: z.enum(["projects", "items", "findings", "sources", "metrics"]).default("projects"), limit: z.number().int().min(1).max(500).default(20), offset: z.number().int().nonnegative().default(0) }),
      run: checked(async i => { const view = viewSchema.parse(await readJson(resolve(root(i), "views/current.json"))); const items = view[i.section as "projects"].slice(i.offset, i.offset + i.limit); return { schema_version: "rsi.view-section.v1", revision: view.revision, generated_at: view.generated_at, section: i.section, total: view[i.section as "projects"].length, items }; }) },
    render: { description: "Build a current view and an offline Human Wiki Kanban from owner data.", sourceWrite: true,
      options: z.object(rootOption), run: checked(async i => buildAndView(root(i), true)) },
    read: { description: "Read a confined Wiki document with line provenance.", readOnly: true,
      args: z.object({ path: z.string() }), options: z.object(rootOption),
      run: checked(async i => (await import("./knowledge/index.ts")).readKnowledge(root(i), i.path)) },
    search: { description: "Search the owned Wiki without loading the full corpus.", readOnly: true,
      args: z.object({ query: z.string() }), options: z.object({ ...rootOption, limit: z.number().int().min(1).max(100).default(20) }),
      run: checked(async i => (await import("./knowledge/index.ts")).searchKnowledge(root(i), i.query, i.limit)) },
    export: { description: "Preview or apply a digest-owned curated public KB projection.", sourceWrite: true,
      options: z.object({ ...rootOption, target: z.string(), apply: z.boolean().default(false), revision: z.string().optional() }),
      run: checked(async i => (await import("./operations/index.ts")).exportKnowledge(root(i), { target: i.target, dryRun: !i.apply, sourceRevision: i.revision })) },
    daily: { description: "Plan or run one finite source-grounded daily pipeline from explicit local configuration.", sourceWrite: true,
      options: z.object({ ...rootOption, config: z.string(), apply: z.boolean().default(false), runId: z.string().optional(), resume: z.boolean().default(false) }),
      run: checked(async i => { const ops = await import("./operations/index.ts"); const cfg = await readJson(resolve(i.config));
        if (!i.apply) return ops.dailyPlan(root(i), cfg);
        const ingest = await import("./ingest/index.ts"), wiki = await import("./knowledge/index.ts");
        return ops.runDaily(root(i), cfg, { runId: i.runId, resume: i.resume, hooks: {
          fetch: (source: any, ctx: any) => ingest.fetchSource(ctx.root, source.id, { signal: ctx.signal, timeout_ms: Math.max(1, Math.min(60000, ctx.deadlineAt - Date.now())) }),
          prepare: (source: any, ctx: any) => ingest.prepareSource(ctx.root, source.id),
          compile: (contribution: any, ctx: any) => wiki.importContribution(ctx.root, contribution),
          lint: (ctx: any) => wiki.lintKnowledge(ctx.root),
          build: (ctx: any) => buildAndView(ctx.root, true),
        } }); }) },
  } };
  return createAicatlog({ registryPath: resolve(base, "aicatlog-manifest.json"), stateRoot: resolve(base, ".local/aicatlog/state"), cacheRoot: resolve(base, ".local/aicatlog/cache") }, [extension]);
}

if (import.meta.main) await createKnowledgeApi(fileURLToPath(new URL("..", import.meta.url))).serve();
