import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildKnowledge, importContribution, lintKnowledge, parseMarkdown, readKnowledge, searchKnowledge, serializeMarkdown, trustTier, type Contribution } from "../src/knowledge/index.ts";
import { sha256 } from "../src/io.ts";
import { fetchSource, prepareSource } from "../src/ingest/index.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function put(root: string, path: string, value: string | object) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); }
const at = "2026-09-16T07:00:00Z";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rsi-knowledge-")); roots.push(root);
  const source = { id: "survey", title: "RSI Survey", kind: "paper", version: "v1", urls: { canonical: "https://example.org/survey/v1" }, tags: ["rsi"] };
  await put(root, "sources/source-manifest.json", { schema_version: "rsi.sources.v1", updated_at: at, sources: [source] });
  const generation = ".local/prepared/survey--v1/generations/abc123";
  const artifact = `${generation}/paper.llms.txt`, text = "# Survey\n\nA bounded loop measures outcomes.\n\n## Limitations\nThis source does not prove universal improvement.\n";
  await put(root, artifact, text);
  const manifest = { schema_version: "rsi.prepared.v1", source_id: "survey", source_key: "survey--v1", version: "v1", status: "prepared", artifacts: [{ id: "paper", path: artifact, sha256: sha256(text), bytes: Buffer.byteLength(text), role: "prompt_context", format: "markdown" }] };
  const manifestPath = `${generation}/resource-manifest.json`;
  await put(root, manifestPath, manifest);
  await put(root, ".local/prepared/survey--v1/current.json", { ...manifest, manifest_path: manifestPath });
  const contribution: Contribution = { schema_version: "rsi.knowledge-contribution.v1", id: "bounded-loops", source_manifest_sha256: sha256(await readFile(join(root, "sources/source-manifest.json"))), generated: { by: "codex/gpt-6-astra", at }, pages: [{ path: "concepts/bounded-loops.md", frontmatter: { type: "Pattern", title: "Bounded learning loops", custom_extension: { retained: true }, tags: ["rsi"] }, body: "# Bounded loops\n\nA loop measures its outcomes.[^survey]\n\n## Limits\nThe source does not establish universal gains.[^survey]\n\n[^survey]: RSI Survey v1", evidence: [{ source_id: "survey", version: "v1", prepared_manifest: manifestPath, prepared_manifest_sha256: sha256(await readFile(join(root, manifestPath))), artifact, sha256: sha256(text), locator: { start_line: 3, end_line: 6 } }] }] };
  return { root, source, manifest, manifestPath, contribution, artifact, text };
}

describe("source-grounded contribution import", () => {
  test("imports draft, preserves unknown fields, and keeps physical evidence private", async () => {
    const f = await fixture();
    const result = await importContribution(f.root, f.contribution);
    expect(result.ok).toBe(true);
    const raw = await readFile(join(f.root, "wiki/concepts/bounded-loops.md"), "utf8"), doc = parseMarkdown("concepts/bounded-loops.md", raw);
    expect(doc.frontmatter.status).toBe("draft"); expect(doc.frontmatter.verified).toBeUndefined(); expect(trustTier(doc.frontmatter)).toBe("unverified");
    expect(doc.frontmatter.custom_extension).toEqual({ retained: true });
    expect(raw).not.toContain(".local/");
    expect(await readFile(join(f.root, "wiki/knowledge-manifest.json"), "utf8")).not.toContain(".local/");
    expect(await readFile(join(f.root, ".local/knowledge/imports/bounded-loops.json"), "utf8")).toContain(f.artifact);
    expect((await lintKnowledge(f.root)).ok).toBe(true);
    expect((await importContribution(f.root, f.contribution)).idempotent).toBe(true);
  });

  test("unknown fields survive updates and existing page digest is required", async () => {
    const f = await fixture(); await importContribution(f.root, f.contribution);
    const current = await readFile(join(f.root, "wiki/concepts/bounded-loops.md"), "utf8"), updated = structuredClone(f.contribution);
    updated.id = "bounded-loops-r2"; updated.pages[0]!.frontmatter = { type: "Pattern", title: "Updated bounded loops" };
    await expect(importContribution(f.root, updated)).rejects.toThrow("previous_page_digest_mismatch");
    updated.pages[0]!.previous_sha256 = sha256(current);
    await importContribution(f.root, updated);
    expect((await readKnowledge(f.root, "concepts/bounded-loops.md")).frontmatter.custom_extension).toEqual({ retained: true });
  });

  test("rejects human generation, verification assertion, and stable promotion", async () => {
    const f = await fixture();
    const human = structuredClone(f.contribution); human.generated.by = "human:owner";
    await expect(importContribution(f.root, human)).rejects.toThrow();
    const verified = structuredClone(f.contribution); verified.pages[0]!.frontmatter.verified = { by: "human:owner", at };
    await expect(importContribution(f.root, verified)).rejects.toThrow("managed_frontmatter:verified");
    const stable = structuredClone(f.contribution); stable.pages[0]!.frontmatter.status = "stable";
    await expect(importContribution(f.root, stable)).rejects.toThrow("contribution_must_be_draft");
  });

  test("rejects wrong source version and stale registry manifest", async () => {
    const f = await fixture(), wrong = structuredClone(f.contribution);
    wrong.pages[0]!.evidence[0]!.version = "v2";
    await expect(importContribution(f.root, wrong)).rejects.toThrow("source_version_mismatch");
    await put(f.root, "sources/source-manifest.json", { schema_version: "rsi.sources.v1", updated_at: at, sources: [{ ...f.source, title: "Changed registry" }] });
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow("source_manifest_digest_mismatch");
  });

  test("rejects modified prepared manifest, unlisted leaf, changed bytes and invalid locator", async () => {
    const f = await fixture();
    const unlisted = structuredClone(f.contribution); unlisted.pages[0]!.evidence[0]!.artifact = f.artifact.replace("paper", "unknown");
    await expect(importContribution(f.root, unlisted)).rejects.toThrow("artifact_not_bound_by_manifest");
    const range = structuredClone(f.contribution); range.pages[0]!.evidence[0]!.locator.end_line = 100;
    await expect(importContribution(f.root, range)).rejects.toThrow("locator_out_of_bounds");
    await put(f.root, f.artifact, "altered text");
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow("artifact_digest_mismatch");
    await put(f.root, f.manifestPath, { ...f.manifest, source_id: "other" });
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow("prepared_manifest_digest_mismatch");
  });

  test("rejects unbound citations and uncited evidence without writing any pages", async () => {
    const f = await fixture(), bad = structuredClone(f.contribution);
    bad.pages[0]!.body = "Claim.[^other]\n\n[^other]: Other";
    await expect(importContribution(f.root, bad)).rejects.toThrow("citation_unbound");
    bad.pages[0]!.body = "An unattributed claim.";
    await expect(importContribution(f.root, bad)).rejects.toThrow("source_not_cited");
    expect(await Bun.file(join(f.root, "wiki/concepts/bounded-loops.md")).exists()).toBe(false);
  });

  test("ignores citation examples inside inline and fenced code", async () => {
    const f = await fixture();
    f.contribution.pages[0]!.body += "\n\nExample `[^not-a-source]`.\n\n```md\n[^another-example]\n```";
    await importContribution(f.root, f.contribution);
    expect((await lintKnowledge(f.root)).ok).toBe(true);
  });

  test("refuses foreign files, path traversal, symlink artifacts, and malicious owned paths", async () => {
    const f = await fixture();
    await put(f.root, "wiki/concepts/bounded-loops.md", "owner content");
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow("foreign_file");
    for (const path of ["../outside.md", "/outside.md", "concepts/%2e%2e/out.md", "concepts\\out.md", "sources/override.md"]) {
      const c = structuredClone(f.contribution); c.pages[0]!.path = path;
      await expect(importContribution(f.root, c)).rejects.toThrow();
    }
    await rm(join(f.root, "wiki/concepts/bounded-loops.md"));
    await rm(join(f.root, f.artifact)); await symlink(join(f.root, "sources/source-manifest.json"), join(f.root, f.artifact));
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow("symlink_path");
    await put(f.root, "wiki/knowledge-manifest.json", { schema_version: "rsi.knowledge-manifest.v1", files: { "../escape.md": { kind: "derived", sha256: "a".repeat(64) } }, imports: {} });
    await expect(buildKnowledge(f.root)).rejects.toThrow("invalid_wiki_path");
  });
});

describe("prepared textual evidence integration", () => {
  test.each([
    ["ts", "typescript", "export const retries = 2;\nthrow new Error('source must never execute');\n"],
    ["qmd", "quarto-markdown", "---\ntitle: Context\n---\n\n# Findings\nA source observation.\n"],
  ])("imports genuine prepared %s context with portable source metadata", async (extension, format, contents) => {
    const root = await mkdtemp(join(tmpdir(), "rsi-text-contribution-")); roots.push(root);
    const url = `https://example.test/pinned/document.${extension}`;
    await put(root, "sources/source-manifest.json", { schema_version: "rsi.sources.v1", updated_at: at, sources: [{ id: "text-source", kind: "documentation", version: "pinned", title: "Source context", urls: { canonical: url, html: url }, tags: [] }] });
    const remote = (async () => new Response(contents, { headers: { "content-type": "text/plain; charset=utf-8" } })) as unknown as typeof fetch;
    await fetchSource(root, "text-source", { fetch: remote });
    const prepared = await prepareSource(root, "text-source");
    const leaf = prepared.artifacts.find(item => item.id === "document-context")!;
    expect(leaf.format).toBe(format); expect(leaf.role).toBe("prompt_context"); expect(leaf.path).toEndWith(`document.${extension}`);
    const input: Contribution = {
      schema_version: "rsi.knowledge-contribution.v1", id: `text-${extension}`, generated: { by: "test/text-context", at },
      source_manifest_sha256: sha256(await readFile(join(root, "sources/source-manifest.json"))),
      pages: [{ path: `concepts/${extension}-source.md`, frontmatter: { type: "Reference", title: "Source observation" }, body: "The source has been inspected as text, without execution.[^text-source]\n\n[^text-source]: Exact pinned context.",
        evidence: [{ source_id: "text-source", version: "pinned", prepared_manifest: String(prepared.manifest_path), prepared_manifest_sha256: String(prepared.manifest_sha256), artifact: leaf.path, sha256: leaf.sha256, locator: { start_line: 1, end_line: contents.trimEnd().split("\n").length } }] }],
    };
    expect((await importContribution(root, input)).ok).toBe(true);
    expect((await lintKnowledge(root)).ok).toBe(true);
    const wiki = await readFile(join(root, `wiki/concepts/${extension}-source.md`), "utf8");
    expect(wiki).not.toContain(root); expect(wiki).not.toContain(".local/");
    expect((await readKnowledge(root, `concepts/${extension}-source.md`)).trust).toBe("unverified");
  });

  test.each([
    ["context_index", "markdown"], ["metadata", "text"], ["provenance", "json"],
    ["configuration", "yaml"], ["prompt_context", "png"], ["source_extracted", "pdf"],
  ])("rejects bound %s/%s artifacts despite a textual suffix", async (role, format) => {
    const f = await fixture();
    f.manifest.artifacts[0]!.role = role; f.manifest.artifacts[0]!.format = format;
    await put(f.root, f.manifestPath, f.manifest);
    f.contribution.pages[0]!.evidence[0]!.prepared_manifest_sha256 = sha256(await readFile(join(f.root, f.manifestPath)));
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow("evidence_requires_context_leaf");
  });

  test.each([
    [new Uint8Array([0xff, 0xfe]), "text_invalid_utf8"],
    [new TextEncoder().encode("%PDF-1.7\nNot a text source"), "binary_disguised_as_text"],
  ])("validates actual context bytes after role/format binding", async (bytes, reason) => {
    const f = await fixture(), artifact = f.manifest.artifacts[0]!;
    await writeFile(join(f.root, f.artifact), bytes);
    artifact.sha256 = sha256(bytes); artifact.bytes = bytes.byteLength;
    await put(f.root, f.manifestPath, f.manifest);
    const evidence = f.contribution.pages[0]!.evidence[0]!;
    evidence.sha256 = artifact.sha256; evidence.prepared_manifest_sha256 = sha256(await readFile(join(f.root, f.manifestPath)));
    await expect(importContribution(f.root, f.contribution)).rejects.toThrow(reason);
  });
});

describe("OKF conformance, provenance and derived views", () => {
  test("registered and prepared source pages never imply a learned summary", async () => {
    const f = await fixture();
    await rm(join(f.root, ".local/prepared"), { recursive: true });
    const result = await buildKnowledge(f.root, { generatedAt: at });
    expect(result.ok).toBe(true); if (!result.ok || !result.coverage) throw new Error("build failed");
    expect(result.coverage[0]!.status).toBe("registered"); expect(result.coverage[0]!.full_read_claim).toBe(false);
    const source = await readKnowledge(f.root, "sources/survey--v1.md");
    expect(source.body).toContain("not a paper summary"); expect(source.frontmatter.status).toBe("draft"); expect(source.trust).toBe("unverified");
    expect((await lintKnowledge(f.root)).okf_conformant).toBe(true);
  });

  test("builds deterministic indexes, backlinks, sources coverage and portable view", async () => {
    const f = await fixture(); await importContribution(f.root, f.contribution);
    const second = structuredClone(f.contribution); second.id = "comparison"; second.pages[0]!.path = "comparisons/loops.md"; second.pages[0]!.body += "\n\nSee [bounded loops](/concepts/bounded-loops.md).";
    await importContribution(f.root, second);
    const built = await buildKnowledge(f.root, { generatedAt: at }), again = await buildKnowledge(f.root, { generatedAt: at });
    expect(built.ok).toBe(true); expect(again.ok).toBe(true);
    expect(built.view).toEqual(again.view); expect(built.index).toEqual(again.index);
    expect(built.coverage?.[0]!.authored_pages).toHaveLength(2);
    expect(built.index?.concepts.find(doc => doc.path === "concepts/bounded-loops.md")!.backlinks).toContain("comparisons/loops.md");
    expect(JSON.stringify(built.view)).not.toContain(".local/");
    expect(await readFile(join(f.root, "wiki/index.md"), "utf8")).toContain('okf_version: "0.2"');
    expect(await readFile(join(f.root, "wiki/log.md"), "utf8")).toContain("## 2026-09-16");
  });

  test("public clone lint preserves unavailable evidence separately from confirmation", async () => {
    const f = await fixture(); await importContribution(f.root, f.contribution); await buildKnowledge(f.root, { generatedAt: at });
    await rm(join(f.root, ".local"), { recursive: true });
    const lint = await lintKnowledge(f.root);
    expect(lint.ok).toBe(true); expect(lint.okf_conformant).toBe(true); expect(lint.content_support).toBe("not_evaluated");
    expect(lint.issues.some(issue => issue.code === "local_evidence_unavailable")).toBe(true);
    expect((await readKnowledge(f.root, "concepts/bounded-loops.md")).trust).toBe("unverified");
  });

  test("previously recorded preparation remains visible when public clone has no cache", async () => {
    const f = await fixture();
    const initial = await buildKnowledge(f.root, { generatedAt: at });
    expect(initial.coverage?.[0]!.status).toBe("prepared");
    expect(initial.coverage?.[0]!.prepared_availability).toBe("local");
    await rm(join(f.root, ".local"), { recursive: true });
    const clone = await buildKnowledge(f.root, { generatedAt: at });
    expect(clone.coverage?.[0]!.status).toBe("prepared");
    expect(clone.coverage?.[0]!.prepared_availability).toBe("recorded");
    expect(clone.coverage?.[0]!.full_read_claim).toBe(false);
  });

  test("broken links, unknown fields/types, and absent optional trust remain OKF conformant", async () => {
    const f = await fixture(); await put(f.root, "wiki/custom.md", serializeMarkdown({ type: "Future Type", future: { nested: ["value"] } }, "# Custom\n\nSee [unwritten](/future.md)."));
    const lint = await lintKnowledge(f.root);
    expect(lint.okf_conformant).toBe(true); expect(lint.ok).toBe(true);
    expect(lint.issues.find(issue => issue.code === "broken_link")!.severity).toBe("warning");
    expect(trustTier({ verified: { by: "process:check", at } })).toBe("machine-confirmed");
    expect(trustTier({ verified: [{ by: "process:check", at }, { by: "human:owner", at }] })).toBe("human-reviewed");
    const doc = await readKnowledge(f.root, "custom.md"); expect(doc.frontmatter.future).toEqual({ nested: ["value"] });
  });

  test("format success does not hide missing citation or falsely promote forged foreign contribution", async () => {
    const f = await fixture(); await put(f.root, "wiki/foreign.md", serializeMarkdown({ type: "Claim", rsi_contribution: "fake", rsi_evidence: [] }, "Unsupported.[^missing]\n\n[^missing]: Missing"));
    const lint = await lintKnowledge(f.root); expect(lint.okf_conformant).toBe(true); expect(lint.ok).toBe(false);
    expect(lint.issues.some(issue => issue.category === "citation")).toBe(true);
    expect((await buildKnowledge(f.root)).ok).toBe(false);
  });

  test("foreign rsi metadata does not fabricate accepted authored coverage", async () => {
    const f = await fixture();
    await put(f.root, "wiki/foreign.md", serializeMarkdown({ type: "Future Type", rsi_contribution: "fake", rsi_evidence: [{ source_id: "survey", version: "v1" }] }, "An external note without a pipeline adoption receipt."));
    const built = await buildKnowledge(f.root);
    expect(built.coverage?.[0]!.status).toBe("prepared");
    expect(built.coverage?.[0]!.authored_pages).toEqual([]);
  });

  test("format errors and external changes block build without overwriting", async () => {
    const f = await fixture(); await put(f.root, "wiki/bad.md", "---\ntitle: no type\n---\nMissing type.");
    expect((await lintKnowledge(f.root)).okf_conformant).toBe(false);
    await rm(join(f.root, "wiki/bad.md")); await buildKnowledge(f.root);
    await put(f.root, "wiki/index.md", "# Foreign replacement\n");
    const result = await buildKnowledge(f.root); expect(result.ok).toBe(false);
    expect(await readFile(join(f.root, "wiki/index.md"), "utf8")).toBe("# Foreign replacement\n");
  });

  test("read sections and bounded text search preserve current digest and reject traversal", async () => {
    const f = await fixture(); await importContribution(f.root, f.contribution);
    const section = await readKnowledge(f.root, "concepts/bounded-loops.md#Limits");
    expect(section.body).toContain("does not establish"); expect(section.body).not.toContain("# Bounded loops"); expect(section.start_line).toBeGreaterThan(1);
    expect((await searchKnowledge(f.root, "bounded", 1)).results).toHaveLength(1);
    for (const path of ["../AGENTS.md", "/tmp/a.md", "wiki/../AGENTS.md", "concepts/%2e%2e/a.md"]) await expect(readKnowledge(f.root, path)).rejects.toThrow("invalid_wiki_path");
    await expect(searchKnowledge(f.root, "bounded", 0)).rejects.toThrow("invalid_search_input");
  });
});
