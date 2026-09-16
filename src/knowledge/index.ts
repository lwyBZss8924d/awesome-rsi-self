import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { SOURCE_MANIFEST, sourceKey, type Source } from "../contracts.ts";
import { loadSources, noSymlinkPath, sha256, writeJson } from "../io.ts";
import { contributionSchema, datetimeSchema, type Issue, type KnowledgeDocument, type KnowledgeManifest } from "./contracts.ts";
import { citations, formatIssues, headings, localLink, markdownLinks, parseMarkdown, proseLines, serializeMarkdown, trustTier, wikiPath } from "./markdown.ts";
import { applyOwnedWrites, loadKnowledgeManifest, readOptional, scanKnowledge, withKnowledgeLock, type PlannedFile } from "./storage.ts";
import { localEvidence, portableEvidence, strictRelative, validateEvidence } from "./evidence.ts";

export { contributionSchema } from "./contracts.ts";
export type { Contribution, Evidence, Issue, KnowledgeDocument } from "./contracts.ts";
export { parseMarkdown, serializeMarkdown, trustTier } from "./markdown.ts";

async function registry(root: string) {
  await noSymlinkPath(root, SOURCE_MANIFEST);
  const manifest = await loadSources(root), ids = new Set<string>();
  for (const source of manifest.sources) { if (ids.has(source.id)) throw new Error(`duplicate_source_id:${source.id}`); ids.add(source.id); }
  return manifest;
}

/** Imports a model-authored contribution; acceptance verifies binding, not its claims. */
export async function importContribution(root: string, input: unknown) {
  const contribution = contributionSchema.parse(input);
  return withKnowledgeLock(root, async () => {
    const digest = sha256(JSON.stringify(contribution)), old = await loadKnowledgeManifest(root), previous = old.imports[contribution.id];
    if (previous) {
      if (previous.sha256 !== digest) throw new Error("contribution_id_conflict");
      for (const path of previous.pages) {
        const raw = await readFile(await noSymlinkPath(root, `wiki/${path}`), "utf8");
        if (sha256(raw) !== old.files[path]?.sha256) throw new Error(`ownership_conflict:${path}`);
      }
      return { schema_version: "rsi.knowledge-import.v1", ok: true, contribution_id: contribution.id, idempotent: true, written: [], pages: previous.pages, content_support: "not_evaluated", trust: "unverified" };
    }
    const sources = await registry(root), byId = new Map(sources.sources.map(source => [source.id, source]));
    const sourceBytes = await readFile(await noSymlinkPath(root, SOURCE_MANIFEST));
    if (sha256(sourceBytes) !== contribution.source_manifest_sha256) throw new Error("source_manifest_digest_mismatch");
    const writes: PlannedFile[] = [], selected = new Set<string>();
    for (const page of contribution.pages) {
      const path = wikiPath(page.path);
      if (selected.has(path)) throw new Error("duplicate_contribution_path"); selected.add(path);
      if (["index.md", "log.md"].includes(basename(path)) || path.startsWith("sources/")) throw new Error("reserved_contribution_path");
      if (typeof page.frontmatter.type !== "string" || !page.frontmatter.type.trim()) throw new Error("type_required");
      for (const field of ["verified", "generated", "sources", "rsi_evidence", "rsi_contribution"]) if (field in page.frontmatter) throw new Error(`managed_frontmatter:${field}`);
      if (page.frontmatter.status !== undefined && page.frontmatter.status !== "draft") throw new Error("contribution_must_be_draft");
      const existing = await readOptional(await noSymlinkPath(root, `wiki/${path}`)), owner = old.files[path];
      if (existing !== undefined && (!owner || owner.kind !== "authored")) throw new Error(`foreign_file:${path}`);
      if (existing !== undefined && (sha256(existing) !== owner!.sha256 || page.previous_sha256 !== owner!.sha256)) throw new Error(`previous_page_digest_mismatch:${path}`);
      if (existing === undefined && page.previous_sha256) throw new Error(`previous_page_missing:${path}`);
      const refs = new Map<string, Source>();
      for (const evidence of page.evidence) {
        const source = byId.get(evidence.source_id);
        if (!source) throw new Error(`unknown_source:${evidence.source_id}`);
        await validateEvidence(root, evidence, source); refs.set(source.id, source);
      }
      const footnotes = citations(page.body);
      for (const id of footnotes.used) if (!refs.has(id) || !footnotes.defined.includes(id)) throw new Error(`citation_unbound:${id}`);
      for (const id of refs.keys()) if (!footnotes.used.includes(id)) throw new Error(`source_not_cited:${id}`);
      for (const target of markdownLinks(page.body)) {
        if (/^(?:javascript|data|file):/i.test(target)) throw new Error("unsafe_link_scheme");
        localLink(path, target);
      }
      const prior = existing ? parseMarkdown(path, existing).frontmatter : {};
      const frontmatter: Record<string, unknown> = { ...prior, ...page.frontmatter, status: "draft", generated: contribution.generated,
        sources: [...refs.values()].map(source => ({ id: source.id, resource: source.urls.canonical, title: source.title, version: source.version ?? null })),
        rsi_contribution: contribution.id, rsi_evidence: page.evidence.map(portableEvidence) };
      // A changed definition needs independent re-confirmation; never inherit an old
      // verification or elevate a generation event into a confirmation event.
      delete frontmatter.verified;
      const text = serializeMarkdown(frontmatter, page.body);
      writes.push({ path, text, owner: { kind: "authored", contribution_id: contribution.id, evidence: page.evidence.map(portableEvidence), generated: contribution.generated } });
    }
    const next = structuredClone(old);
    next.imports[contribution.id] = { sha256: digest, generated: contribution.generated, pages: [...selected], source_manifest_sha256: contribution.source_manifest_sha256 };
    await writeJson(await noSymlinkPath(root, `.local/knowledge/imports/${contribution.id}.json`), { schema_version: "rsi.knowledge-adoption.v1", contribution_sha256: digest, contribution, content_support: "not_evaluated" });
    await applyOwnedWrites(root, old, next, writes);
    return { schema_version: "rsi.knowledge-import.v1", ok: true, contribution_id: contribution.id, idempotent: false, written: writes.map(write => `wiki/${write.path}`), pages: [...selected], content_support: "not_evaluated", trust: "unverified" };
  });
}

function docSourceIds(doc: KnowledgeDocument): string[] {
  return Array.isArray(doc.frontmatter.sources) ? doc.frontmatter.sources.flatMap((source: any) => typeof source?.id === "string" ? [source.id] : []) : [];
}

export async function lintKnowledge(root: string) {
  const scan = await scanKnowledge(root), issues = [...scan.issues], documents = scan.documents;
  const byPath = new Map(documents.map(doc => [doc.path, doc]));
  const sources = await registry(root), sourceById = new Map(sources.sources.map(source => [source.id, source]));
  const owned = await loadKnowledgeManifest(root);
  const add = (path: string, category: Issue["category"], code: string, message: string, severity: Issue["severity"] = "error") => issues.push({ path, category, code, message, severity });
  for (const doc of documents) {
    issues.push(...formatIssues(doc));
    if (doc.reserved) continue;
    const fm = doc.frontmatter, footnotes = citations(doc.body), sourceIds = docSourceIds(doc);
    if (new Set(sourceIds).size !== sourceIds.length) add(doc.path, "citation", "duplicate_source_id", "Source footnote IDs must be unique within a concept.");
    if (fm.sources !== undefined && !Array.isArray(fm.sources)) add(doc.path, "citation", "sources_shape", "sources must be a list.");
    if (Array.isArray(fm.sources)) for (const source of fm.sources as any[]) {
      if (!source || typeof source.resource !== "string" || !source.resource.trim()) add(doc.path, "citation", "source_resource", "Each source entry needs a resource.");
      if (source?.last_modified && !datetimeSchema.safeParse(source.last_modified).success) add(doc.path, "lifecycle", "source_datetime", "last_modified needs a datetime with offset.", "warning");
    }
    for (const id of footnotes.used) {
      if (!sourceIds.includes(id)) add(doc.path, "citation", "citation_source_missing", `Footnote ${id} has no matching sources[].id.`);
      if (!footnotes.defined.includes(id)) add(doc.path, "citation", "citation_definition_missing", `Footnote ${id} has no definition.`);
    }
    if (fm.status !== undefined && !["draft", "stable", "deprecated"].includes(String(fm.status))) add(doc.path, "lifecycle", "unknown_status", "Unknown lifecycle status; content remains consumable.", "warning");
    if (fm.generated !== undefined) {
      const generated = fm.generated as any;
      if (!generated || typeof generated.by !== "string" || !datetimeSchema.safeParse(generated.at).success) add(doc.path, "lifecycle", "generated_shape", "generated should identify its actor and timestamp.", "warning");
    }
    if (fm.verified !== undefined) {
      const values = Array.isArray(fm.verified) ? fm.verified : [fm.verified];
      for (const event of values as any[]) if (!event || typeof event.by !== "string" || !datetimeSchema.safeParse(event.at).success) add(doc.path, "lifecycle", "verified_shape", "verified should be a mapping or list of actor/datetime events.", "warning");
    }
    if (fm.stale_after !== undefined && !datetimeSchema.safeParse(fm.stale_after).success) add(doc.path, "lifecycle", "stale_after_datetime", "stale_after needs a datetime with offset, not a date-only value.", "warning");
    if (fm.type === "Attested Computation" && (typeof fm.runtime !== "string" || !fm.runtime)) add(doc.path, "lifecycle", "computation_runtime", "Attested Computation convention requires runtime.", "warning");
    for (const target of markdownLinks(doc.body)) {
      if (/^(?:javascript|data|file):/i.test(target)) { add(doc.path, "link", "unsafe_link_scheme", `Unsupported link scheme in ${target}.`); continue; }
      try {
        const link = localLink(doc.path, target); if (!link) continue;
        if (!link.path.endsWith(".md")) continue;
        const linked = byPath.get(link.path);
        if (!linked) add(doc.path, "link", "broken_link", `Unwritten target ${link.path}; this does not invalidate OKF.`, "warning");
        else if (link.fragment && !headings(linked.body).some(heading => heading.slug === link.fragment)) add(doc.path, "link", "broken_fragment", `Unknown heading ${link.fragment} in ${link.path}.`, "warning");
      } catch (error: any) { add(doc.path, "link", "unsafe_link", error.message); }
    }
  }
  for (const [path, owner] of Object.entries(owned.files)) {
    const doc = byPath.get(path);
    if (!doc || doc.sha256 !== owner.sha256) { add(path, "ownership", "ownership_conflict", "Owned content is missing or differs from the accepted write receipt."); continue; }
    for (const evidence of owner.evidence ?? []) {
      const source = sourceById.get(evidence.source_id);
      if (!source || (source.version ?? null) !== evidence.version) { add(path, "evidence", "source_revision_not_current", `Recorded source ${evidence.source_id}@${evidence.version} is not the current registry revision.`, "warning"); continue; }
      try { await validateEvidence(root, localEvidence(evidence, source), source); }
      catch (error: any) {
        const unavailable = error.code === "ENOENT";
        add(path, "evidence", unavailable ? "local_evidence_unavailable" : "evidence_invalid", unavailable ? "Prepared evidence is not present in this checkout; source binding remains visible, support is not rechecked." : error.message, unavailable ? "warning" : "error");
      }
    }
  }
  return { schema_version: "rsi.knowledge-lint.v1", ok: !issues.some(issue => issue.severity === "error"), okf_conformant: !issues.some(issue => issue.category === "format" && issue.severity === "error"), content_support: "not_evaluated", document_count: documents.length, concept_count: documents.filter(doc => !doc.reserved).length, issues };
}

type Coverage = { id: string; title: string; kind: string; version: string | null; source_key: string; status: "registered" | "prepared" | "authored"; extraction_status: string | null; prepared_availability: "local" | "recorded" | "absent" | "invalid"; authored_pages: string[]; full_read_claim: false; canonical: string };
async function sourceCoverage(root: string, sources: Source[], docs: KnowledgeDocument[], manifest: KnowledgeManifest) {
  const result: Coverage[] = [];
  for (const source of sources) {
    let extraction: string | null = null, availability: Coverage["prepared_availability"] = "absent";
    try {
      const current = await readOptional(await noSymlinkPath(root, `.local/prepared/${sourceKey(source)}/current.json`));
      if (current) {
        const value = JSON.parse(current);
        if (value.source_id !== source.id || value.source_key !== sourceKey(source) || (value.version ?? null) !== (source.version ?? null)) throw new Error("prepared_pointer_identity");
        const manifestPath = strictRelative(value.manifest_path);
        if (!manifestPath.startsWith(`.local/prepared/${sourceKey(source)}/generations/`) || !manifestPath.endsWith("/resource-manifest.json")) throw new Error("prepared_pointer_path");
        const bytes = await readFile(await noSymlinkPath(root, manifestPath));
        if (value.manifest_sha256 && sha256(bytes) !== value.manifest_sha256) throw new Error("prepared_pointer_digest");
        const prepared = JSON.parse(bytes.toString("utf8"));
        if (prepared.schema_version !== "rsi.prepared.v1" || prepared.source_id !== source.id || prepared.source_key !== sourceKey(source) || (prepared.version ?? null) !== (source.version ?? null)) throw new Error("prepared_manifest_identity");
        extraction = String(prepared.status ?? "prepared"); availability = "local";
      }
    } catch { extraction = "unavailable"; availability = "invalid"; }
    if (availability === "absent") {
      const path = `sources/${sourceKey(source)}.md`, old = docs.find(doc => doc.path === path), record = old?.frontmatter.rsi_source as any;
      if (old && manifest.files[path]?.sha256 === old.sha256 && record?.id === source.id && record.version === (source.version ?? null) && typeof record.extraction_status === "string" && record.extraction_status !== "unavailable") {
        extraction = record.extraction_status; availability = "recorded";
      }
    }
    const authored = docs.filter(doc => {
      const owner = manifest.files[doc.path];
      return !doc.reserved && owner?.kind === "authored" && owner.sha256 === doc.sha256 && owner.evidence?.some(e => e.source_id === source.id && e.version === (source.version ?? null));
    }).map(doc => doc.path).sort();
    result.push({ id: source.id, title: source.title, kind: source.kind, version: source.version ?? null, source_key: sourceKey(source), status: authored.length ? "authored" : extraction && extraction !== "unavailable" ? "prepared" : "registered", extraction_status: extraction, prepared_availability: availability, authored_pages: authored, full_read_claim: false, canonical: source.urls.canonical });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

const markdownText = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/([\[\]\\])/g, "\\$1");
function titleOf(doc: KnowledgeDocument): string { return typeof doc.frontmatter.title === "string" ? doc.frontmatter.title : basename(doc.path, ".md"); }
function descriptionOf(doc: KnowledgeDocument): string { return typeof doc.frontmatter.description === "string" ? doc.frontmatter.description : ""; }

/** Deterministic derived source references/indexes. Model content is never invented here. */
export async function buildKnowledge(root: string, options: { generatedAt?: string } = {}) {
  return withKnowledgeLock(root, async () => {
    const before = await lintKnowledge(root);
    if (!before.ok) return { schema_version: "rsi.knowledge-build.v1", ok: false as const, written: [], lint: before };
    const registered = await registry(root), old = await loadKnowledgeManifest(root), next = structuredClone(old);
    const at = datetimeSchema.parse(options.generatedAt ?? registered.updated_at);
    const scanned = await scanKnowledge(root), coverage = await sourceCoverage(root, registered.sources, scanned.documents, old);
    const writes: PlannedFile[] = [];
    for (const source of registered.sources) {
      const cover = coverage.find(row => row.id === source.id)!;
      const path = `sources/${sourceKey(source)}.md`;
      const frontmatter = { type: "Reference", title: source.title, description: `Registered ${source.kind} source; coverage: ${cover.status}. Full reading is not asserted.`, resource: source.urls.canonical, tags: source.tags, status: "draft", generated: { by: "process:rsi-source-registry", at: registered.updated_at },
        sources: [{ id: source.id, resource: source.urls.canonical, title: source.title }], rsi_source: { id: source.id, version: source.version ?? null, coverage: cover.status, extraction_status: cover.extraction_status, full_read_claim: false } };
      const links = cover.authored_pages.map(item => `- [${markdownText(item)}](/${item})`).join("\n");
      const body = `# ${markdownText(source.title)}\n\nThis page records a source pointer and processing coverage. It is not a paper summary or evidence of complete reading.[^${source.id}]\n\n- Source ID: \`${source.id}\`\n- Version: \`${source.version ?? "unversioned"}\`\n- Coverage: \`${cover.status}\`\n- Extraction: \`${cover.extraction_status ?? "not prepared"}\`\n\n## Authored contributions\n\n${links || "No authored contribution has been imported for this source revision."}\n\n[^${source.id}]: [Original source](${source.urls.canonical})\n`;
      writes.push({ path, text: serializeMarkdown(frontmatter, body), owner: { kind: "source" } });
    }
    const replacement = new Map(writes.map(write => [write.path, parseMarkdown(write.path, write.text)]));
    const concepts = [...scanned.documents.filter(doc => !doc.reserved && !replacement.has(doc.path)), ...replacement.values()].sort((a, b) => a.path.localeCompare(b.path));
    const dirs = new Set<string>([""]);
    for (const doc of concepts) { let directory = dirname(doc.path); while (directory !== ".") { dirs.add(directory); directory = dirname(directory); } }
    for (const directory of [...dirs].sort()) {
      const direct = concepts.filter(doc => (dirname(doc.path) === "." ? "" : dirname(doc.path)) === directory);
      const children = [...dirs].filter(child => child && (dirname(child) === "." ? "" : dirname(child)) === directory).sort();
      const lines = [directory ? `# ${markdownText(basename(directory))}` : "# RSI Knowledge Wiki", ""];
      if (children.length) lines.push("## Directories", "", ...children.map(child => `- [${markdownText(basename(child))}](${basename(child)}/index.md)`), "");
      if (direct.length) lines.push("## Concepts", "", ...direct.map(doc => `- [${markdownText(titleOf(doc))}](${basename(doc.path)})${descriptionOf(doc) ? ` - ${markdownText(descriptionOf(doc))}` : ""}`), "");
      if (!children.length && !direct.length) lines.push("No concepts have been registered yet.", "");
      const text = `${directory ? "" : '---\nokf_version: "0.2"\n---\n\n'}${lines.join("\n")}`;
      writes.push({ path: directory ? `${directory}/index.md` : "index.md", text, owner: { kind: "derived" } });
    }
    const events = [{ at: registered.updated_at, text: `Source registry contains ${registered.sources.length} entries. Registration does not assert reading.` }, ...Object.entries(old.imports).map(([id, entry]) => ({ at: entry.generated.at, text: `Imported draft contribution \`${id}\`: ${entry.pages.map(path => `[${markdownText(path)}](/${path})`).join(", ")}. Source support remains independently unverified.` }))].sort((a, b) => b.at.localeCompare(a.at) || a.text.localeCompare(b.text));
    let day = "", log = "# Knowledge Update Log\n";
    for (const event of events) { const date = event.at.slice(0, 10); if (date !== day) { log += `\n## ${date}\n`; day = date; } log += `\n- ${event.text}\n`; }
    writes.push({ path: "log.md", text: log, owner: { kind: "derived" } });
    await applyOwnedWrites(root, old, next, writes);
    const lint = await lintKnowledge(root), finalDocs = (await scanKnowledge(root)).documents;
    if (!lint.ok) return { schema_version: "rsi.knowledge-build.v1", ok: false as const, written: writes.map(write => `wiki/${write.path}`), lint };
    const index = knowledgeIndex(finalDocs);
    const sourceIds = new Set(coverage.map(source => source.id));
    const view = {
      schema_version: "rsi.view.v1", kind: "kb", id: "awesome-rsi-self", title: "Awesome RSI Self", description: "Source-grounded knowledge, processing coverage, and unverified drafts.", revision: sha256(JSON.stringify({ registry: registered, files: next.files })), generated_at: at,
      lanes: ["registered", "prepared", "authored", "draft", "stable", "deprecated"].map(id => ({ id, label: id })),
      projects: [{ id: "knowledge", title: "RSI Knowledge", summary: "Registration, preprocessing and authored knowledge remain distinct.", status: "active" }],
      items: [...coverage.map(source => ({ id: `source:${source.source_key}`, project_id: "knowledge", title: source.title, summary: `Source ${source.version ?? "unversioned"}; full reading is not asserted.`, status: source.status, phase: "source", evidence: [{ label: "Original source", href: source.canonical }], source_refs: [source.id], badges: [source.extraction_status ?? "not prepared"] })),
        ...concepts.filter(doc => !doc.path.startsWith("sources/")).map(doc => ({ id: `concept:${doc.path}`, project_id: "knowledge", title: titleOf(doc), summary: descriptionOf(doc), status: ["draft", "stable", "deprecated"].includes(String(doc.frontmatter.status)) ? String(doc.frontmatter.status) : "stable", phase: "knowledge", evidence: [{ label: "Wiki document", href: `../wiki/${doc.path}` }], source_refs: docSourceIds(doc).filter(id => sourceIds.has(id)), badges: [trustTier(doc.frontmatter)] }))],
      sources: coverage.map(source => ({ id: source.id, title: source.title, kind: source.kind, status: source.status, href: source.canonical, version: source.version })),
      findings: lint.issues.map((issue, index) => ({ id: `knowledge-check-${index + 1}`, title: `${issue.code}: ${issue.path}`, description: issue.message, status: "open" })),
      metrics: [{ label: "Registered sources", value: coverage.length }, { label: "Sources with authored drafts", value: coverage.filter(source => source.status === "authored").length }, { label: "Authored concepts", value: concepts.filter(doc => !!doc.frontmatter.rsi_contribution).length }],
      notices: ["Format conformance is separate from source support. No pipeline stage asserts full reading or human confirmation."],
    };
    return { schema_version: "rsi.knowledge-build.v1", ok: true as const, generated_at: at, written: writes.map(write => `wiki/${write.path}`), coverage, index, view, lint };
  });
}

function knowledgeIndex(documents: KnowledgeDocument[]) {
  const concepts = documents.filter(doc => !doc.reserved), paths = new Set(concepts.map(doc => doc.path)), edges: { from: string; to: string }[] = [];
  for (const doc of concepts) for (const target of markdownLinks(doc.body)) {
    try { const link = localLink(doc.path, target); if (link && paths.has(link.path) && !edges.some(edge => edge.from === doc.path && edge.to === link.path)) edges.push({ from: doc.path, to: link.path }); } catch { /* lint owns diagnostics */ }
  }
  return { schema_version: "rsi.knowledge-index.v1", concepts: concepts.map(doc => ({ path: doc.path, sha256: doc.sha256, title: titleOf(doc), description: descriptionOf(doc), type: doc.frontmatter.type, status: doc.frontmatter.status ?? "stable", trust: trustTier(doc.frontmatter), sources: docSourceIds(doc), backlinks: edges.filter(edge => edge.to === doc.path).map(edge => edge.from).sort() })), edges };
}

export async function readKnowledge(root: string, selector: string) {
  const parts = selector.split("#"), path = wikiPath(parts[0]!);
  if (parts.length > 2) throw new Error("invalid_selector");
  const raw = await readFile(await noSymlinkPath(root, `wiki/${path}`), "utf8"), doc = parseMarkdown(path, raw), section = parts[1];
  if (!section) return { path: `wiki/${path}`, sha256: doc.sha256, frontmatter: doc.frontmatter, body: doc.body, start_line: doc.bodyStartLine, end_line: raw.split(/\r?\n/).length, trust: trustTier(doc.frontmatter) };
  const entries = headings(doc.body), exact = entries.filter(entry => entry.title === section), found = exact.length ? exact : entries.filter(entry => entry.slug === section);
  if (found.length !== 1) throw new Error(found.length ? "ambiguous_section" : "section_not_found");
  const start = found[0]!, stop = entries.find(entry => entry.line > start.line && entry.level <= start.level)?.line ?? doc.body.split(/\r?\n/).length + 1;
  return { path: `wiki/${path}`, sha256: doc.sha256, frontmatter: doc.frontmatter, body: doc.body.split(/\r?\n/).slice(start.line - 1, stop - 1).join("\n"), start_line: doc.bodyStartLine + start.line - 1, end_line: doc.bodyStartLine + stop - 2, trust: trustTier(doc.frontmatter) };
}

export async function searchKnowledge(root: string, query: string, limit = 10) {
  if (!query.trim() || query.length > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_search_input");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean), docs = (await scanKnowledge(root)).documents;
  const results = docs.filter(doc => !doc.reserved).flatMap(doc => {
    const text = `${titleOf(doc)}\n${descriptionOf(doc)}\n${doc.body}`.toLowerCase();
    if (!terms.every(term => text.includes(term))) return [];
    const lines = proseLines(doc.body), index = lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term)));
    return [{ path: `wiki/${doc.path}`, sha256: doc.sha256, title: titleOf(doc), status: doc.frontmatter.status ?? "stable", trust: trustTier(doc.frontmatter), snippet: index >= 0 ? lines[index]!.slice(0, 320) : descriptionOf(doc).slice(0, 320), line: index >= 0 ? doc.bodyStartLine + index : null, score: terms.reduce((sum, term) => sum + (titleOf(doc).toLowerCase().includes(term) ? 2 : 1), 0) }];
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { schema_version: "rsi.knowledge-search.v1", query, total: results.length, results: results.slice(0, limit), truncated: results.length > limit, backend: "bounded_text_scan" };
}
