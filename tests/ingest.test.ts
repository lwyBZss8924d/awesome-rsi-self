import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { extractHtml, fetchSource, prepareSource, inspectSource, validateVersionBinding, getPreparedManifest, ARXIV_TEMPLATE } from "../src/ingest/index.ts";
import { artifactArgv, fetchAsset, requestArtifact, runArtifactRequest, recordVisualReceipt } from "../src/ingest/artifacts.ts";
import { sha256 } from "../src/io.ts";

const roots: string[] = [];
const html = await readFile(new URL("./fixtures/ingest/article.html", import.meta.url), "utf8");
const source = { id: "arxiv-2607.13104-v1", kind: "paper" as const, version: "v1", title: "Fixture paper", urls: { canonical: "https://arxiv.org/abs/2607.13104v1", html: "https://arxiv.org/html/2607.13104v1", tex: "https://arxiv.org/src/2607.13104v1" }, tags: [] };
const main = "\\documentclass{article}\n\\newcommand{\\energy}{E=mc^2}\n\\begin{document}\n\\input{parts/results}\n\\includegraphics{plot.png}\n\\end{document}\n";

function tar(entries: { name: string; content?: string | Uint8Array; type?: string; link?: string }[]): Uint8Array {
  const output: Uint8Array[] = [];
  const str = (header: Buffer, at: number, size: number, value: string) => header.write(value.slice(0, size), at, size, "utf8");
  for (const entry of entries) {
    const content = typeof entry.content === "string" ? Buffer.from(entry.content) : Buffer.from(entry.content ?? []);
    const header = Buffer.alloc(512);
    str(header, 0, 100, entry.name); str(header, 100, 8, "0000600\0"); str(header, 108, 8, "0000000\0"); str(header, 116, 8, "0000000\0");
    str(header, 124, 12, content.length.toString(8).padStart(11, "0") + "\0"); str(header, 136, 12, "00000000000\0");
    header.fill(32, 148, 156); str(header, 156, 1, entry.type ?? "0"); str(header, 157, 100, entry.link ?? ""); str(header, 257, 6, "ustar\0"); str(header, 263, 2, "00");
    const checksum = header.reduce((a, b) => a + b, 0);
    str(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    output.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  output.push(Buffer.alloc(1024));
  return Buffer.concat(output);
}
const fixtureTar = () => gzipSync(tar([
  { name: "main.tex", content: main },
  { name: "parts/results.tex", content: "\\section{Results}\nObserved $E=mc^2$.\n" },
  { name: "macros.sty", content: "\\newcommand{\\loadfile}[1]{\\input{#1}}\n" },
  { name: "plot.png", content: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YYQAAAAASUVORK5CYII=", "base64") },
]));
async function setup(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "rsi-ingest-test-")); roots.push(root);
  await mkdir(resolve(root, "sources"));
  await writeFile(resolve(root, "sources/source-manifest.json"), JSON.stringify({ schema_version: "rsi.sources.v1", updated_at: "2026-09-16T00:00:00Z", sources: [{ ...source, ...overrides }] }));
  return root;
}
function fetcher(tex: Uint8Array | string = fixtureTar(), options: { html?: string; texType?: string } = {}) {
  return (async (input: any) => new Response(String(input).includes("/html/") ? options.html ?? html : typeof tex === "string" ? tex : Uint8Array.from(tex).buffer, { headers: { "content-type": String(input).includes("/html/") ? "text/html" : options.texType ?? "application/gzip" } })) as typeof fetch;
}
async function prepared(tex?: Uint8Array | string) {
  const root = await setup(); await fetchSource(root, source.id, { fetch: fetcher(tex) });
  const result = await prepareSource(root, source.id); return { root, result };
}
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

describe("HTML structural extraction", () => {
  test("preserves math, tables, figures, citations, footnotes and appendix", () => {
    const result = extractHtml(html, { url: source.urls.html, title: source.title });
    const text = result.blocks.map(b => b.text).join("\n");
    expect(text).toContain("$E=mc^2$"); expect(text).toContain("\\sum_i x_i = 1");
    expect(text).toContain("| A | 0.75 |"); expect(text).toContain('colspan="2"');
    expect(text).toContain("![A precise plot](figure.png)"); expect(text).toContain("Figure 1: Details and axis.");
    expect(text).toContain("[1]"); expect(text).toContain("Boundary condition."); expect(text).toContain("Preserve this proof.");
    expect(text).not.toContain("Discard navigation"); expect(text).not.toContain("never execute");
    expect(result.assets).toHaveLength(1); expect(result.counts.math).toBe(2);
    expect(result.blocks.find(b => b.text.includes("conserved"))?.origin.element_id).toBe("p1");
  });
  test("custom templates select content without executing source scripts", () => {
    const result = extractHtml('<html><body><div id="custom"><h1>Title</h1><p>Kept</p><aside>Discard</aside></div></body></html>', { url: "https://example.test/a", title: "Title", template: { schema_version: "rsi.cleaning-template.v1", id: "custom", body_selectors: ["#custom"], remove_selectors: ["aside"], title_selectors: ["h1"] } });
    expect(result.blocks.map(b => b.text).join()).toContain("Kept"); expect(result.blocks.map(b => b.text).join()).not.toContain("Discard");
  });
  test("MathML without TeX remains inspectable and produces an explicit warning", () => {
    const result = extractHtml('<html><body><h1>T</h1><p>X <math><mi>x</mi></math></p></body></html>', { url: "https://example.test/a", title: "T" });
    expect(result.blocks.map(b => b.text).join()).toContain("```mathml"); expect(result.warnings).toContain("math_without_tex_preserved_as_mathml");
  });
});

describe("acquisition identity and limits", () => {
  test("rejects mixed or unpinned arXiv versions before any request", () => {
    expect(() => validateVersionBinding({ ...source, urls: { ...source.urls, tex: "https://arxiv.org/src/2607.13104v2" } })).toThrow("arxiv_version_mismatch");
    expect(() => validateVersionBinding({ ...source, urls: { ...source.urls, tex: "https://arxiv.org/src/2607.13104" } })).toThrow("arxiv_exact_version_required");
  });
  test("keeps HTTP HTML masquerading as TeX unavailable", async () => {
    const root = await setup(); const result = await fetchSource(root, source.id, { fetch: fetcher("<html><body>Rate limited</body></html>", { texType: "application/octet-stream" }) });
    expect(result.status).toBe("partial"); expect(result.artifacts).toHaveLength(1); expect(result.warnings[0]).toContain("response_is_not_tex_archive");
  });
  test("bounded streaming rejects oversized responses and cancellation stops the next request", async () => {
    const root = await setup(); const result = await fetchSource(root, source.id, { fetch: fetcher(), max_html_bytes: 10 });
    expect(result.status).toBe("partial"); expect(result.warnings).toContain("html:response_size_limit");
    const root2 = await setup(), controller = new AbortController(); let calls = 0;
    const response = (async () => { calls++; controller.abort(); return new Response(html, { headers: { "content-type": "text/html" } }); }) as unknown as typeof fetch;
    const cancelled = await fetchSource(root2, source.id, { fetch: response, signal: controller.signal });
    expect(calls).toBe(1); expect(cancelled.status).toBe("unavailable"); expect(cancelled.warnings).toContain("acquisition_cancelled_remaining_requests_not_started");
  });
  test("idempotent fetch preserves original receipts and checks cached bytes", async () => {
    const root = await setup(); let calls = 0; const original = fetcher();
    const mock = (async (...args: Parameters<typeof fetch>) => { calls++; return original(...args); }) as typeof fetch;
    const first = await fetchSource(root, source.id, { fetch: mock }); const second = await fetchSource(root, source.id, { fetch: mock });
    expect(calls).toBe(2); expect(second.cache_hit).toBe(true); expect(second.artifacts).toEqual(first.artifacts);
    expect((await readdir(resolve(root, `.local/raw/${first.source_key}/acquisitions`))).length).toBe(2);
    await writeFile(resolve(root, first.artifacts[0].path), "corrupted");
    await expect(fetchSource(root, source.id, { fetch: mock })).rejects.toThrow("artifact_size_mismatch");
  });
  test("symlinked private storage is rejected", async () => {
    const root = await setup(), external = await mkdtemp(resolve(tmpdir(), "rsi-symlink-test-")); roots.push(external);
    await symlink(external, resolve(root, ".local"));
    await expect(fetchSource(root, source.id, { fetch: fetcher() })).rejects.toThrow("symlink_path");
    expect(await readdir(external)).toEqual([]);
  });
});

describe("TeX context and immutable preparations", () => {
  test("extracts include graph and macro source, preserves exact file lines, and reuses generation", async () => {
    const { root, result } = await prepared(); expect(result.status).toBe("prepared");
    const inspection = JSON.parse(await readFile(resolve(root, result.artifacts.find(a => a.id === "tex-inspection")!.path), "utf8"));
    expect(inspection.selected_main).toBe("main.tex"); expect(inspection.include_edges).toHaveLength(1); expect(inspection.missing_includes).toHaveLength(0);
    expect(inspection.dynamic_includes[0].definition_context).toBe(true); expect(inspection.active_dynamic_includes).toHaveLength(0);
    expect(inspection.macros.some((m: any) => m.text.includes("E=mc^2"))).toBe(true);
    const maps = JSON.parse(await readFile(resolve(root, result.artifacts.find(a => a.id === "source-map")!.path), "utf8"));
    const mapping = maps.blocks.find((b: any) => b.origin?.kind === "tex" && b.origin.file === "main.tex");
    const context = (await readFile(resolve(root, mapping.output.artifact), "utf8")).split("\n");
    expect(context.slice(mapping.output.start_line - 1, mapping.output.end_line).join("\n")).toBe(main.trimEnd());
    const second = await prepareSource(root, source.id); expect(second.preparation_key).toBe(result.preparation_key); expect(second.cache_hit).toBe(true);
    expect((await inspectSource(root, source.id)).completeness).toMatchObject({ full_read: "not_claimed", cross_format_equivalence: "not_verified" });
  });
  test("single gzip TeX is supported; unresolved actual includes remain partial", async () => {
    const { root, result } = await prepared(gzipSync(Buffer.from("\\documentclass{article}\n\\begin{document}\n\\input{missing}\n\\input{\\dynamic}\n\\end{document}")));
    expect(result.status).toBe("partial"); expect(result.warnings).toContain("tex:missing_includes"); expect(result.warnings).toContain("tex:dynamic_includes_not_expanded");
    expect(await getPreparedManifest(root, source.id)).not.toBeNull();
  });
  test.each([
    ["traversal", { name: "../escape.tex", content: main }, "unsafe_archive_path"],
    ["absolute", { name: "/escape.tex", content: main }, "unsafe_archive_path"],
    ["symlink", { name: "link.tex", type: "2", link: "main.tex" }, "archive_links_or_special_files"],
    ["hardlink", { name: "hard.tex", type: "1", link: "main.tex" }, "archive_links_or_special_files"],
    ["device", { name: "device", type: "3" }, "archive_links_or_special_files"],
  ] as const)("rejects archive %s without claiming extracted context", async (_label, entry, reason) => {
    const { result } = await prepared(gzipSync(tar([{ name: "main.tex", content: main }, entry])));
    expect(result.status).toBe("partial"); expect(result.warnings.some(w => w.includes(reason))).toBe(true); expect(result.artifacts.some(a => a.id === "tex-context")).toBe(false);
  });
  test("archive expansion and file counts are bounded", async () => {
    const root = await setup(); await fetchSource(root, source.id, { fetch: fetcher() });
    const size = await prepareSource(root, source.id, { max_expanded_bytes: 100 });
    expect(size.warnings.some(w => w.includes("expanded_size_limit"))).toBe(true);
    const count = await prepareSource(root, source.id, { max_files: 2 }); expect(count.warnings.some(w => w.includes("archive_file_count_limit"))).toBe(true);
    expect(count.preparation_key).not.toBe(size.preparation_key);
  });
  test("file/directory collisions do not leave unregistered extracted files", async () => {
    const { root, result } = await prepared(gzipSync(tar([{ name: "main.tex", content: main }, { name: "part", content: "ordinary file" }, { name: "part/child.tex", content: "child" }])));
    expect(result.warnings).toContain("tex:archive_path_collision");
    const directory = resolve(root, String(result.manifest_path), "..");
    expect(await readdir(directory)).not.toContain("tex-files");
  });
});

describe("non-paper source text", () => {
  async function documentRoot(extension: string) {
    const url = `https://raw.githubusercontent.com/example/project/fixed-revision/document.${extension}`;
    return setup({ id: "document-source", kind: "documentation", version: "fixed-revision", urls: { canonical: url, html: url } });
  }
  const textFetch = (text: string | Uint8Array, contentType = "text/plain; charset=utf-8") => (async () => new Response(typeof text === "string" ? text : Uint8Array.from(text).buffer, { headers: { "content-type": contentType } })) as unknown as typeof fetch;

  test.each([
    ["md", "markdown", "# Specification\r\n\r\n> Preserve original lines.\r\n\r\n## Contract\r\nContent.\r\n"],
    ["qmd", "quarto-markdown", "---\ntitle: Source\n---\n\n# Instructions\n\n```{python}\nraise RuntimeError(\"never execute\")\n```\n"],
    ["ts", "typescript", "// Source context, not an executable transform.\nexport const html = `<article>literal markup</article>`;\nthrow new Error(\"never execute source\");\n"],
  ])("preserves %s bytes and maps exact source lines", async (extension, format, contents) => {
    const root = await documentRoot(extension);
    const fetched = await fetchSource(root, "document-source", { fetch: textFetch(contents) });
    expect(fetched.status).toBe("fetched"); expect(fetched.acquisitions[0].kind).toBe("raw_text"); expect(fetched.acquisitions[0].url_field).toBe("html");
    expect(fetched.acquisitions[0].content_type).toBe("text/plain; charset=utf-8"); expect(fetched.artifacts[0].format).toBe(format);
    expect(await readFile(resolve(root, fetched.artifacts[0].path), "utf8")).toBe(contents);
    const output = await prepareSource(root, "document-source");
    expect(output.status).toBe("prepared");
    expect(output.completeness).toMatchObject({ html: "not_applicable_raw_text", text: "source_lines_preserved", full_read: "not_claimed", source_execution: "not_performed" });
    const context = output.artifacts.find(a => a.id === "document-context")!;
    expect(context.format).toBe(format); expect(context.sha256).toBe(fetched.artifacts[0].sha256);
    expect(await readFile(resolve(root, context.path), "utf8")).toBe(contents);
    const map = JSON.parse(await readFile(resolve(root, output.artifacts.find(a => a.id === "source-map")!.path), "utf8"));
    expect(map.blocks[0]).toMatchObject({ precision: "exact", output: { artifact: context.path, start_line: 1 }, origin: { kind: "text", raw_sha256: context.sha256, file: fetched.artifacts[0].path, start_line: 1 } });
    expect(map.blocks[0].output.end_line).toBe(contents.split("\n").length - 1);
    const index = await readFile(resolve(root, output.artifacts.find(a => a.id === "context-index")!.path), "utf8");
    expect(index).toContain("[Source document]");
  });

  test.each([
    ["NUL bytes", Buffer.from("# A document\n\0binary"), "binary_disguised_as_text"],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0x80, 0x81]), "text_invalid_utf8"],
    ["PDF content", Buffer.from("%PDF-1.7\nNot a text source"), "binary_disguised_as_text"],
  ])("rejects %s advertised as text", async (_label, contents, expected) => {
    const root = await documentRoot("md");
    const result = await fetchSource(root, "document-source", { fetch: textFetch(contents) });
    expect(result.status).toBe("unavailable"); expect(result.artifacts).toEqual([]); expect(result.warnings.some(w => w.includes(expected))).toBe(true);
  });

  test("does not weaken exact paper HTML/TeX rules", async () => {
    const root = await setup();
    const result = await fetchSource(root, source.id, { fetch: fetcher(fixtureTar(), { html: "# Not HTML\nPaper text is not enough." }) });
    expect(result.status).toBe("partial"); expect(result.warnings).toContain("html:response_is_not_html"); expect(result.acquisitions.some(a => a.kind === "raw_text")).toBe(false);
  });

  test("retains prior failed receipts after a successful scoped retry", async () => {
    const root = await documentRoot("md");
    const failed = await fetchSource(root, "document-source", { fetch: textFetch(new Uint8Array([0xff])) });
    const receipt = failed.attempts[0].receipt, before = await readFile(resolve(root, receipt));
    const recovered = await fetchSource(root, "document-source", { fetch: textFetch("# Restored source\n\nValid text.") });
    expect(recovered.status).toBe("fetched"); expect(recovered.attempts[0].receipt).not.toBe(receipt);
    expect(sha256(await readFile(resolve(root, receipt)))).toBe(sha256(before));
    expect((await readdir(resolve(root, `.local/raw/${recovered.source_key}/acquisitions`))).length).toBe(2);
  });
});

describe("local parse requests and visual receipts", () => {
  test("reuses successful parse across preparation generations with the same bytes/configuration", async () => {
    const { root } = await prepared();
    const mock = resolve(root, "mock-lit");
    await writeFile(mock, '#!/usr/bin/env bun\nif(process.argv.includes("--version")){console.log("lit fixture-test");process.exit(0)} const p=process.argv.indexOf("--output"); const counter=import.meta.dir+"/calls.txt"; let n=0;try{n=Number(await Bun.file(counter).text())}catch{} await Bun.write(counter,String(n+1)); await Bun.write(process.argv[p+1],JSON.stringify({total_pages:1,pages:[{page_number:1,text:"fixture"}]}));\n');
    await chmod(mock, 0o700);
    const first = await requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "parse", pages: "1", max_pages: 1 });
    const execution = await runArtifactRequest(root, first.request_path, { lit: mock }); expect(execution.status).toBe("succeeded");
    await prepareSource(root, source.id, { template: { ...ARXIV_TEMPLATE, id: "equivalent-test-template" } });
    const second = await requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "parse", pages: "1", max_pages: 1 });
    expect(first.request_id).not.toBe(second.request_id);
    const reused = await runArtifactRequest(root, second.request_path, { lit: mock });
    expect(reused.cache_hit).toBe(true); expect(reused.reused_from).toBe(first.request_id); expect(await readFile(resolve(root, "calls.txt"), "utf8")).toBe("1");
  });
  test("fetches one selected figure once, stores original bytes and rejects redirected origins", async () => {
    const { root } = await prepared();
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6YYQAAAAASUVORK5CYII=", "base64");
    let calls = 0;
    const remote = (async () => { calls++; return new Response(imageBytes, { headers: { "content-type": "image/png" } }); }) as unknown as typeof fetch;
    const first = await fetchAsset(root, source.id, "html-asset-1", { fetch: remote });
    const second = await fetchAsset(root, source.id, "html-asset-1", { fetch: remote });
    expect(calls).toBe(1); expect(second.cache_hit).toBe(true); expect(first.artifact.sha256).toBe(sha256(imageBytes));
    const view = await requestArtifact(root, source.id, { asset_id: "html-asset-1", operation: "view_image" }); expect(view.source_artifact.sha256).toBe(first.artifact.sha256);
    const other = await prepared();
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })) as unknown as typeof fetch;
    await expect(fetchAsset(other.root, source.id, "html-asset-1", { fetch: redirect })).rejects.toThrow("asset_redirect_origin_not_allowed");
  });
  test("creates fixed argv with exact asset digest; does not manufacture visual review", async () => {
    const { root, result } = await prepared();
    const req = await requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "parse", pages: "1", max_pages: 1 });
    expect(req.visual_verification).toBe("not_performed"); expect(req.config.no_ocr).toBe(true);
    const argv = artifactArgv(req, "/tmp/file with spaces.png", "/tmp/output");
    expect(argv).toContain("/tmp/file with spaces.png"); expect(argv).toContain("--no-ocr"); expect(argv).not.toContain("--ocr-server-url");
    await expect(requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "screenshot" })).rejects.toThrow("screenshot_requires_selected_pages");
    const view = await requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "view_image" });
    expect((await runArtifactRequest(root, view.request_path)).status).toBe("requires_native_tool");
    await expect(recordVisualReceipt(root, view.request_path, { actor: "fixture", method: "view_image", observed_image_sha256: "invalid", finding: "not actually observed", outcome: "uncertain", evidence_ref: "fixture:event" })).rejects.toThrow("visual_image_digest_mismatch");
    const receipt = await recordVisualReceipt(root, view.request_path, { actor: "fixture-test-only", method: "view_image", observed_image_sha256: view.source_artifact.sha256, finding: "Test attestation only; no live model invoked.", outcome: "uncertain", evidence_ref: "fixture:event" });
    expect(receipt.trust).toBe("actor_attestation_not_independently_verified");
    expect((await getPreparedManifest(root, source.id))?.completeness.visual_verification).toBe("not_requested");
  });
  test("rejects unbounded or shell-shaped page strings", async () => {
    const { root } = await prepared();
    await expect(requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "parse", pages: "1;touch /tmp/x" })).rejects.toThrow("invalid_pages");
    await expect(requestArtifact(root, source.id, { asset_id: "tex-asset:plot.png", operation: "parse", pages: "1-99" })).rejects.toThrow("page_bound_exceeded");
  });
});
