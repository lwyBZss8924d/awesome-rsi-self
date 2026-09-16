import { readFile, writeFile, mkdir, rename, rm, lstat } from "node:fs/promises";
import { dirname, resolve, relative, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getSource, noSymlinkPath, readJson, sha256, writeJson } from "../io.ts";
import { sourceKey, SOURCE_MANIFEST, type Source } from "../contracts.ts";
import { ARXIV_TEMPLATE, GENERIC_TEMPLATE, extractHtml, validateTemplate } from "./html.ts";
import { PARSER_VERSION, type Acquisition, type Artifact, type CleaningTemplate, type IngestResult, type PreparedManifest, type RawManifest, type SourceMapBlock } from "./types.ts";

export * from "./types.ts";
export { extractHtml, ARXIV_TEMPLATE, GENERIC_TEMPLATE } from "./html.ts";
export { fetchAsset, requestArtifact, runArtifactRequest, recordVisualReceipt } from "./artifacts.ts";

export type FetchOptions = {
  refresh?: boolean;
  timeout_ms?: number;
  max_html_bytes?: number;
  max_tex_bytes?: number;
  /** Dependency injection for deterministic HTTP contract tests. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};
export type PrepareOptions = {
  template?: CleaningTemplate;
  python?: string;
  max_expanded_bytes?: number;
  max_file_bytes?: number;
  max_files?: number;
  signal?: AbortSignal;
};
const defaultLimits = { timeout_ms: 60_000, max_html_bytes: 24 * 1024 * 1024, max_tex_bytes: 32 * 1024 * 1024 };
const boundedInteger = (value: number, label: string, upper: number) => {
  if (!Number.isInteger(value) || value <= 0 || value > upper) throw new Error(`invalid_${label}`);
  return value;
};
const identity = (source: Source) => ({ id: source.id, version: source.version ?? null, urls: source.urls });
const identitySha = (source: Source) => sha256(JSON.stringify(identity(source)));
const rel = (root: string, path: string) => relative(resolve(root), path).replaceAll("\\", "/");

export function arxivIdentity(url: string): { id: string; version: string | null } | null {
  const parsed = new URL(url);
  if (!/^(?:export\.)?arxiv\.org$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/(?:abs|html|src|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?(?:\.pdf)?\/?$/i);
  return match ? { id: match[1], version: match[2] ?? null } : null;
}
export function validateVersionBinding(source: Source): string | null {
  const urls = [source.urls.html, source.urls.tex].filter((v): v is string => !!v);
  const bindings = urls.map(arxivIdentity).filter((v): v is NonNullable<typeof v> => v !== null);
  if (!bindings.length) {
    if (urls.some(url => /(^|\.)arxiv\.org$/i.test(new URL(url).hostname))) throw new Error("unsupported_arxiv_url");
    return null;
  }
  if (bindings.some(binding => !binding.version)) throw new Error("arxiv_exact_version_required");
  const expected = bindings[0];
  if (bindings.length !== urls.length || bindings.some(binding => binding.id !== expected.id || binding.version !== expected.version)) throw new Error("arxiv_version_mismatch");
  if (source.version !== expected.version) throw new Error("source_version_mismatch");
  const canonical = arxivIdentity(source.urls.canonical);
  if (canonical && (canonical.id !== expected.id || (canonical.version && canonical.version !== expected.version))) throw new Error("canonical_version_mismatch");
  return `${expected.id}${expected.version}`;
}

async function optionalJson(file: string): Promise<any | null> {
  try { return await readJson(file); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}
async function privatePath(root: string, item: string): Promise<string> { return noSymlinkPath(root, `.local/${item}`); }
export async function verifyArtifacts(root: string, artifacts: Artifact[]): Promise<void> {
  for (const item of artifacts) {
    const file = await noSymlinkPath(root, item.path);
    const st = await lstat(file);
    if (!st.isFile() || st.size !== item.bytes) throw new Error(`artifact_size_mismatch:${item.id}`);
    if (sha256(await readFile(file)) !== item.sha256) throw new Error(`artifact_digest_mismatch:${item.id}`);
  }
}
async function immutable(root: string, path: string, content: Uint8Array | string) {
  const target = await noSymlinkPath(root, path);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, content, { flag: "wx", mode: 0o600 }); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    if (sha256(await readFile(target)) !== sha256(content)) throw new Error("immutable_content_conflict");
  }
}
async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("response_size_limit");
  if (!response.body) throw new Error("empty_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) { await reader.cancel(); throw new Error("response_size_limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error("empty_response_body");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
const TEXT_FORMATS: Record<string, string> = {
  md: "markdown", markdown: "markdown", mdx: "mdx", qmd: "quarto-markdown", txt: "text", text: "text",
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", sh: "shell", zsh: "shell", json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", css: "css",
};
function decodeSourceText(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("text_invalid_utf8"); }
  if (!text.trim()) throw new Error("text_empty_content");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || /^(?:%PDF-|PK\x03\x04|\x7fELF)/.test(text)) throw new Error("binary_disguised_as_text");
  return text;
}
function validatePayload(kind: "html" | "tex", bytes: Uint8Array, contentType: string, binding: string | null, source: Source, url: string): { kind: Acquisition["kind"]; format: string; extension: string } {
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 32_768))).toString("utf8");
  const html = /<(?:!doctype\s+html|html|body|article)\b/i.test(prefix);
  if (kind === "html") {
    if (source.kind !== "paper" && binding === null && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) {
      const mediaType = contentType.split(";")[0].trim().toLowerCase();
      const suffix = extname(new URL(url).pathname).slice(1).toLowerCase();
      const textual = /^text\//.test(mediaType) || /^application\/(?:json|[^/]+\+json|javascript|x-javascript|xml|[^/]+\+xml|yaml|x-yaml|toml)$/.test(mediaType) || (mediaType === "application/octet-stream" && !!TEXT_FORMATS[suffix]);
      if (!textual) throw new Error("response_is_not_textual_document");
      const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
      if (charset && !/^(?:utf-8|utf8|us-ascii|ascii)$/i.test(charset)) throw new Error("text_unsupported_charset");
      decodeSourceText(bytes);
      const format = TEXT_FORMATS[suffix] ?? (mediaType === "text/markdown" ? "markdown" : mediaType.includes("json") ? "json" : mediaType.includes("javascript") ? "javascript" : mediaType.includes("xml") ? "xml" : "text");
      const extension = TEXT_FORMATS[suffix] ? suffix : format === "markdown" ? "md" : format === "json" ? "json" : format === "javascript" ? "js" : format === "xml" ? "xml" : "txt";
      return { kind: "raw_text", format, extension };
    }
    if (!html || /application\/pdf/i.test(contentType)) throw new Error("response_is_not_html");
    const citation = prefix.match(/<meta[^>]+name=["']citation_arxiv_id["'][^>]+content=["']([^"']+)/i)?.[1];
    if (binding && citation && /v\d+$/.test(citation) && citation !== binding) throw new Error("html_citation_version_mismatch");
    return { kind: "html", format: "html", extension: "html" };
  } else {
    if (html || /text\/html|application\/xhtml/i.test(contentType)) throw new Error("response_is_not_tex_archive");
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const tar = bytes.length > 512 && Buffer.from(bytes.subarray(257, 263)).toString("ascii").startsWith("ustar");
    const tex = /\\(?:documentclass|begin\s*\{document\}|input|newcommand|def)\b/.test(prefix);
    if (!gzip && !tar && !tex) throw new Error("unrecognized_tex_payload");
    return { kind: "tex", format: "tex-source-archive", extension: "source" };
  }
}

export async function fetchSource(root: string, id: string, options: FetchOptions = {}): Promise<RawManifest> {
  const source = await getSource(root, id), key = sourceKey(source), binding = validateVersionBinding(source);
  const sourceManifestSha = sha256(await readFile(resolve(root, SOURCE_MANIFEST)));
  const timeout = boundedInteger(options.timeout_ms ?? defaultLimits.timeout_ms, "timeout_ms", 300_000);
  const limits = { html: boundedInteger(options.max_html_bytes ?? defaultLimits.max_html_bytes, "max_html_bytes", 128 * 1024 * 1024), tex: boundedInteger(options.max_tex_bytes ?? defaultLimits.max_tex_bytes, "max_tex_bytes", 256 * 1024 * 1024) };
  const currentPath = await privatePath(root, `raw/${key}/current.json`);
  const previous: RawManifest | null = await optionalJson(currentPath);
  if (previous && !options.refresh && (previous as any).source_identity_sha256 === identitySha(source) && previous.status === "fetched") {
    await verifyArtifacts(root, previous.artifacts);
    return { ...previous, cache_hit: true };
  }
  const acquisitions: Acquisition[] = [], attempts: RawManifest["attempts"] = [], warnings: string[] = [];
  for (const kind of ["html", "tex"] as const) {
    const url = source.urls[kind];
    if (!url) { if (source.kind === "paper") warnings.push(`${kind}_url_not_declared`); continue; }
    const receiptPath = `.local/raw/${key}/acquisitions/${randomUUID()}.json`;
    const acquiredAt = new Date().toISOString();
    try {
      const cached = previous && (previous as any).source_identity_sha256 === identitySha(source) && !options.refresh ? previous.acquisitions.find(a => (a.url_field ?? a.kind) === kind && a.requested_url === url) : null;
      if (cached) {
        await verifyArtifacts(root, [cached.artifact]); acquisitions.push(cached);
        attempts.push({ kind, url, status: "ok", receipt: (previous?.attempts.find(a => a.kind === kind && a.status === "ok")?.receipt ?? "") });
        continue;
      }
      options.signal?.throwIfAborted();
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
      const response = await (options.fetch ?? globalThis.fetch)(url, { redirect: "follow", signal, headers: { "User-Agent": "awesome-rsi-self/0.1 source-context-ingest", "Accept": kind === "html" ? source.kind === "paper" ? "text/html,application/xhtml+xml" : "text/html,application/xhtml+xml,text/markdown,text/plain,application/json" : "application/x-tar,application/gzip,application/octet-stream,text/plain" } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
      const finalUrl = response.url || url;
      if (binding) {
        const final = arxivIdentity(finalUrl);
        if (!final || `${final.id}${final.version ?? ""}` !== binding) { await response.body?.cancel(); throw new Error("redirect_version_mismatch"); }
      }
      const bytes = await boundedResponse(response, limits[kind]);
      signal.throwIfAborted();
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      const observed = validatePayload(kind, bytes, type, binding, source, finalUrl);
      const digest = sha256(bytes), rawPath = `.local/raw/${key}/${observed.kind === "raw_text" ? "text" : kind}/${digest}.${observed.extension}`;
      await immutable(root, rawPath, bytes);
      const acquired: Acquisition = {
        kind: observed.kind, url_field: kind, ...(observed.kind === "raw_text" ? { text_encoding: "utf-8" as const } : {}), requested_url: url, final_url: finalUrl, acquired_at: acquiredAt, http_status: response.status,
        content_type: type, etag: response.headers.get("etag"), last_modified: response.headers.get("last-modified"),
        artifact: { id: observed.kind === "raw_text" ? "raw-text" : `raw-${kind}`, path: rawPath, sha256: digest, bytes: bytes.length, role: "source_raw", format: observed.format }, version_binding: binding,
      };
      await immutable(root, receiptPath, `${JSON.stringify({ schema_version: "rsi.acquisition.v1", source_id: id, source_key: key, status: "ok", ...acquired }, null, 2)}\n`);
      acquisitions.push(acquired); attempts.push({ kind, url, status: "ok", receipt: receiptPath });
    } catch (error: any) {
      const reason = String(error.message ?? error).slice(0, 500);
      warnings.push(`${kind}:${reason}`);
      await immutable(root, receiptPath, `${JSON.stringify({ schema_version: "rsi.acquisition.v1", source_id: id, source_key: key, kind, url, acquired_at: acquiredAt, status: "unavailable", reason }, null, 2)}\n`);
      attempts.push({ kind, url, status: "unavailable", reason, receipt: receiptPath });
      if (options.signal?.aborted) { warnings.push("acquisition_cancelled_remaining_requests_not_started"); break; }
    }
  }
  const wanted = [source.urls.html, source.urls.tex].filter(Boolean).length;
  const status = acquisitions.length === 0 ? "unavailable" : acquisitions.length === wanted && !warnings.length ? "fetched" : "partial";
  const result: RawManifest = { schema_version: "rsi.raw.v1", source_id: id, source_key: key, version: source.version ?? null, status, source, source_manifest_sha256: sourceManifestSha, source_identity_sha256: identitySha(source), artifacts: acquisitions.map(a => a.artifact), acquisitions, attempts, warnings, cache_hit: false };
  await writeJson(currentPath, result);
  return result;
}

function textBuffer() {
  let text = "";
  let nextLine = 1;
  return {
    append(value: string) { const clean = value.trimEnd(); const start_line = nextLine; text += `${clean}\n\n`; nextLine += clean.split("\n").length + 1; return { start_line, end_line: nextLine - 2 }; },
    value() { return text.trimEnd() + "\n"; },
  };
}
async function resolveHelper() {
  for (const target of ["../../scripts/ingest/tex_source.py", "../scripts/ingest/tex_source.py", "./scripts/ingest/tex_source.py"]) {
    const candidate = fileURLToPath(new URL(target, import.meta.url));
    try { if ((await lstat(candidate)).isFile()) return candidate; }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("tex_helper_not_packaged");
}
async function parserIdentity(helper: string) {
  const inputs = [{ name: "entry", content: await readFile(fileURLToPath(import.meta.url)) }, { name: "tex-helper", content: await readFile(helper) }];
  // A bundled entry already contains this module. An unbundled run binds it too.
  try { inputs.push({ name: "html", content: await readFile(new URL("./html.ts", import.meta.url)) }); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  return sha256(JSON.stringify(inputs.map(i => ({ name: i.name, sha256: sha256(i.content) }))));
}
async function runTex(archive: string, destination: string, options: PrepareOptions, helper: string) {
  options.signal?.throwIfAborted();
  const python = options.python ?? "python3";
  const argv = [python, helper, archive, destination, "--max-expanded-bytes", String(options.max_expanded_bytes ?? 96 * 1024 * 1024), "--max-file-bytes", String(options.max_file_bytes ?? 32 * 1024 * 1024), "--max-files", String(options.max_files ?? 4096)];
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...processEnvWithoutModelSecrets(), PYTHONDONTWRITEBYTECODE: "1" } });
  const timer = setTimeout(() => process.kill(), 60_000);
  const abort = () => process.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    options.signal?.throwIfAborted();
    if (out.length > 12 * 1024 * 1024) throw new Error("tex_inspection_output_limit");
    let result: any;
    try { result = JSON.parse(out); } catch { throw new Error(`tex_helper_invalid_output:${code}:${err.slice(0, 200)}`); }
    if (code !== 0 || result.status !== "extracted") throw new Error(result.error ?? `tex_helper_exit_${code}`);
    return result;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
function processEnvWithoutModelSecrets(): Record<string, string> {
  const env: Record<string, string> = {};
  // Local, non-model tool. It needs executable resolution and locale, not provider keys.
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT"]) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

export async function getPreparedManifest(root: string, id: string): Promise<PreparedManifest | null> {
  const source = await getSource(root, id);
  const pointer = await optionalJson(await privatePath(root, `prepared/${sourceKey(source)}/current.json`));
  if (!pointer) return null;
  const manifest = await readJson(await noSymlinkPath(root, pointer.manifest_path)) as PreparedManifest;
  if (manifest.source_id !== source.id || manifest.source_key !== sourceKey(source) || manifest.version !== (source.version ?? null) || sha256(JSON.stringify(manifest.source_identity)) !== identitySha(source)) throw new Error("prepared_identity_mismatch");
  if (pointer.manifest_sha256 !== sha256(await readFile(await noSymlinkPath(root, pointer.manifest_path)))) throw new Error("prepared_manifest_digest_mismatch");
  return manifest;
}

export async function prepareSource(root: string, id: string, options: PrepareOptions = {}): Promise<IngestResult> {
  options.signal?.throwIfAborted();
  const source = await getSource(root, id), key = sourceKey(source), binding = validateVersionBinding(source);
  const raw: RawManifest | null = await optionalJson(await privatePath(root, `raw/${key}/current.json`));
  if (!raw || !raw.acquisitions.length) return { source_id: id, source_key: key, version: source.version ?? null, status: "unavailable", artifacts: [], warnings: ["raw_acquisition_required"] };
  if ((raw as any).source_identity_sha256 !== identitySha(source)) throw new Error("raw_identity_mismatch_refetch_required");
  await verifyArtifacts(root, raw.artifacts);
  const limits = {
    max_expanded_bytes: boundedInteger(options.max_expanded_bytes ?? 96 * 1024 * 1024, "max_expanded_bytes", 256 * 1024 * 1024),
    max_file_bytes: boundedInteger(options.max_file_bytes ?? 32 * 1024 * 1024, "max_file_bytes", 128 * 1024 * 1024),
    max_files: boundedInteger(options.max_files ?? 4096, "max_files", 10_000),
  };
  const template = validateTemplate(options.template ?? (binding ? ARXIV_TEMPLATE : GENERIC_TEMPLATE));
  const helper = await resolveHelper();
  const recipe = { parser_version: PARSER_VERSION, implementation_sha256: await parserIdentity(helper), inputs: raw.artifacts.map(a => ({ id: a.id, sha256: a.sha256 })).sort((a, b) => a.id.localeCompare(b.id)), template, limits };
  const preparationKey = sha256(JSON.stringify(recipe));
  const generationRel = `.local/prepared/${key}/generations/${preparationKey}`;
  const generation = await noSymlinkPath(root, generationRel);
  const manifestRel = `${generationRel}/resource-manifest.json`;
  const pointerPath = await privatePath(root, `prepared/${key}/current.json`);
  const existing = await optionalJson(await noSymlinkPath(root, manifestRel)) as PreparedManifest | null;
  if (existing) {
    await verifyArtifacts(root, existing.artifacts);
    const manifestSha = sha256(await readFile(await noSymlinkPath(root, manifestRel)));
    await writeJson(pointerPath, { ...existing, manifest_path: manifestRel, manifest_sha256: manifestSha });
    return { ...existing, manifest_path: manifestRel, manifest_sha256: manifestSha, cache_hit: true };
  }
  const staging = await privatePath(root, `prepared/${key}/.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  const artifacts: Artifact[] = [], warnings = [...raw.warnings], sourceMaps: SourceMapBlock[] = [], assetRecords: any[] = [];
  const sections: { path: string; title: string }[] = [];
  const completeness: Record<string, unknown> = { html: "not_available", tex: "not_available", text: "not_available", visual_verification: "not_requested", full_read: "not_claimed", source_execution: "not_performed", cross_format_equivalence: "not_verified" };
  const save = async (path: string, value: string | Uint8Array, artifactId: string, role: string, format: string) => {
    const target = await noSymlinkPath(staging, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, { flag: "wx", mode: 0o600 });
    artifacts.push({ id: artifactId, path: `${generationRel}/${path}`, sha256: sha256(value), bytes: typeof value === "string" ? Buffer.byteLength(value) : value.length, role, format });
  };
  try {
    const textRaw = raw.acquisitions.find(a => a.kind === "raw_text");
    if (textRaw) {
      if (source.kind === "paper" || binding) throw new Error("paper_raw_text_not_allowed");
      options.signal?.throwIfAborted();
      const bytes = await readFile(await noSymlinkPath(root, textRaw.artifact.path));
      const text = decodeSourceText(bytes), lineCount = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      const extension = extname(textRaw.artifact.path) || ".txt";
      const contextPath = ["markdown", "text"].includes(textRaw.artifact.format) ? "document.llms.txt" : `document${extension}`;
      // Do not trim, render, execute, or synthesize the source. It remains an exact
      // byte copy; line locators use LF boundaries (including CRLF source files).
      await save(contextPath, bytes, "document-context", "prompt_context", textRaw.artifact.format);
      for (let start = 1; start <= lineCount; start += 200) {
        const end = Math.min(start + 199, lineCount);
        sourceMaps.push({ id: `text-lines-${start}-${end}`, output: { artifact: `${generationRel}/${contextPath}`, start_line: start, end_line: end }, origin: { kind: "text", raw_sha256: textRaw.artifact.sha256, file: textRaw.artifact.path, start_line: start, end_line: end }, precision: "exact" });
      }
      completeness.html = "not_applicable_raw_text";
      completeness.text = "source_lines_preserved";
      completeness.text_lines = lineCount;
      completeness.text_format = textRaw.artifact.format;
      completeness.text_encoding = "utf-8";
      completeness.observed_media_type = textRaw.content_type;
    }
    const htmlRaw = raw.acquisitions.find(a => a.kind === "html");
    if (htmlRaw) {
      try {
        options.signal?.throwIfAborted();
        const extracted = extractHtml(await readFile(await noSymlinkPath(root, htmlRaw.artifact.path), "utf8"), { url: htmlRaw.final_url, title: source.title, template });
        const full = textBuffer();
        let section = textBuffer(), sectionName = "Overview", sectionIndex = 0, sectionMaps: { block: typeof extracted.blocks[number]; start_line: number; end_line: number }[] = [];
        const finishSection = async () => {
          if (!sectionMaps.length) return;
          const slug = sectionName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "section";
          const file = `sections/${String(++sectionIndex).padStart(3, "0")}-${slug}.llms.txt`;
          await save(file, section.value(), `section-${sectionIndex}`, "prompt_context", "markdown");
          sections.push({ path: file, title: sectionName });
          for (const item of sectionMaps) sourceMaps.push({ id: `${item.block.id}-section`, output: { artifact: `${generationRel}/${file}`, start_line: item.start_line, end_line: item.end_line }, origin: { ...item.block.origin, raw_sha256: htmlRaw.artifact.sha256 }, precision: "structural" });
          section = textBuffer(); sectionMaps = [];
        };
        if (extracted.blocks[0]?.heading?.level !== 1) full.append(`# ${extracted.title || source.title}`);
        for (const block of extracted.blocks) {
          options.signal?.throwIfAborted();
          if (block.heading && block.heading.level <= 2 && sectionMaps.length) await finishSection();
          if (block.heading && block.heading.level <= 2) sectionName = block.heading.title;
          const lines = full.append(block.text);
          sourceMaps.push({ id: block.id, output: { artifact: `${generationRel}/paper.llms.txt`, ...lines }, origin: { ...block.origin, raw_sha256: htmlRaw.artifact.sha256 }, precision: "structural" });
          sectionMaps.push({ block, ...section.append(block.text) });
        }
        await finishSection();
        await save("paper.llms.txt", full.value(), "paper-context", "prompt_context", "markdown");
        completeness.html = extracted.blocks.length > 1 ? "structure_extracted" : "sparse";
        completeness.html_counts = extracted.counts;
        completeness.html_body_selector = extracted.body_selector;
        warnings.push(...extracted.warnings);
        assetRecords.push(...extracted.assets.map(a => ({ ...a, source_raw_sha256: htmlRaw.artifact.sha256, acquisition_status: "declared_remote", visual_verification: "not_requested" })));
      } catch (error: any) { completeness.html = "extraction_failed"; warnings.push(`html:${String(error.message).slice(0, 500)}`); }
    }
    const texRaw = raw.acquisitions.find(a => a.kind === "tex");
    options.signal?.throwIfAborted();
    if (texRaw) {
      try {
        const tex = await runTex(await noSymlinkPath(root, texRaw.artifact.path), resolve(staging, "tex-files"), { ...options, ...limits }, helper);
        const context = textBuffer(); context.append(`# ${source.title}: TeX source context`);
        context.append("> Exact decoded source files. Macros and includes are preserved, not executed or expanded. The original archive and per-file digests remain authoritative.");
        for (const entry of tex.text_files) {
          const bytes = await readFile(resolve(staging, "tex-files", entry.file));
          const text = bytes.toString(entry.encoding === "latin-1" ? "latin1" : "utf8");
          const block = `## ${entry.file}\n\n\`\`\`latex\n${text.trimEnd()}\n\`\`\``;
          const lines = context.append(block);
          const fileLineCount = text.trimEnd().split("\n").length;
          sourceMaps.push({ id: `tex-${sourceMaps.length + 1}`, output: { artifact: `${generationRel}/tex-context.llms.txt`, start_line: lines.start_line + 3, end_line: lines.start_line + 2 + fileLineCount }, origin: { kind: "tex", raw_sha256: texRaw.artifact.sha256, file: entry.file, start_line: 1, end_line: fileLineCount }, precision: "exact" });
        }
        await save("tex-context.llms.txt", context.value(), "tex-context", "prompt_context", "markdown");
        await save("tex-inspection.json", `${JSON.stringify(tex, null, 2)}\n`, "tex-inspection", "source_structure", "json");
        for (const entry of tex.files) {
          const suffix = extname(entry.file).toLowerCase();
          artifacts.push({ id: `tex-file:${entry.file}`, path: `${generationRel}/tex-files/${entry.file}`, sha256: entry.sha256, bytes: entry.bytes, role: "source_extracted", format: suffix.slice(1) || "binary" });
          if ([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".eps"].includes(suffix)) assetRecords.push({ id: `tex-asset:${entry.file}`, file: `${generationRel}/tex-files/${entry.file}`, kind: suffix === ".pdf" ? "pdf" : "image", sha256: entry.sha256, bytes: entry.bytes, acquisition_status: "source_archive", visual_verification: "not_requested" });
        }
        warnings.push(...tex.warnings.map((w: string) => `tex:${w}`));
        completeness.tex = tex.text_files.length && tex.selected_main && !tex.missing_includes.length && !tex.active_dynamic_includes.length && !tex.include_cycles.length ? "source_graph_extracted" : "partial";
        completeness.tex_main_file = tex.selected_main;
        completeness.tex_files = tex.text_files.length;
        completeness.tex_macros_preserved = tex.macros.length;
      } catch (error: any) {
        await rm(resolve(staging, "tex-files"), { recursive: true, force: true });
        completeness.tex = "extraction_failed"; warnings.push(`tex:${String(error.message).slice(0, 500)}`);
      }
    }
    await save("assets.json", `${JSON.stringify({ schema_version: "rsi.source-assets.v1", source_id: id, assets: assetRecords }, null, 2)}\n`, "source-assets", "artifact_candidates", "json");
    await save("source-map.json", `${JSON.stringify({ schema_version: "rsi.source-map.v1", source_id: id, source_key: key, blocks: sourceMaps }, null, 2)}\n`, "source-map", "provenance", "json");
    await save("preparation-recipe.json", `${JSON.stringify(recipe, null, 2)}\n`, "preparation-recipe", "configuration", "json");
    const documentArtifact = artifacts.find(a => a.id === "document-context");
    const links = [artifacts.some(a => a.id === "paper-context") ? "- [Cleaned paper](paper.llms.txt): Deterministic HTML extraction." : "", artifacts.some(a => a.id === "tex-context") ? "- [TeX source context](tex-context.llms.txt): Exact decoded source files with unexpanded macros." : "", documentArtifact ? `- [Source document](${relative(generationRel, documentArtifact.path)}): Exact UTF-8 ${documentArtifact.format} source; not executed or summarized.` : ""].filter(Boolean);
    const index = [`# ${source.title}`, "", `> Source context for ${id}${source.version ? ` (${source.version})` : ""}. Extraction does not claim a full read, visual verification, or cross-format equivalence.`, "", "Select a section before loading the complete paper. Source links are inert until requested.", "", "## Content", "", ...links, ...sections.map(s => `- [${s.title.replace(/[\[\]]/g, "")}](${s.path}): Source-grounded section.`), "", "## Metadata", "", "- [Resource manifest](resource-manifest.json): Artifact digests, identity and coverage.", "- [Source map](source-map.json): Output lines to original HTML elements or TeX files.", "- [Assets](assets.json): Declared or extracted figures and PDFs; visual verification is separate.", "- [Preparation recipe](preparation-recipe.json): Parser version, template and bounds.", "", "## Optional", "", `- [Original publication](${source.urls.canonical}): Publisher source.`, ""].join("\n");
    await save("llms.txt", index, "context-index", "context_index", "llms-txt-v2");
    const hasContent = artifacts.some(a => ["paper-context", "tex-context", "document-context"].includes(a.id));
    const htmlOK = source.urls.html ? completeness.html === "structure_extracted" || (source.kind !== "paper" && completeness.text === "source_lines_preserved") : true;
    const texOK = source.urls.tex ? completeness.tex === "source_graph_extracted" : source.kind !== "paper";
    const status = !hasContent ? "unavailable" : htmlOK && texOK && raw.status === "fetched" ? "prepared" : "partial";
    const manifest: PreparedManifest = { schema_version: "rsi.prepared.v1", source_id: id, source_key: key, version: source.version ?? null, preparation_key: preparationKey, parser_version: PARSER_VERSION, status, source_manifest_sha256: raw.source_manifest_sha256, source_identity: identity(source), input_artifacts: raw.artifacts, artifacts, completeness, warnings: [...new Set(warnings)] };
    await writeFile(resolve(staging, "resource-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    options.signal?.throwIfAborted();
    await mkdir(dirname(generation), { recursive: true });
    try { await rename(staging, generation); }
    catch (error: any) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      const concurrent = await readJson(resolve(generation, "resource-manifest.json"));
      if (sha256(JSON.stringify(concurrent)) !== sha256(JSON.stringify(manifest))) throw new Error("preparation_generation_conflict");
      await rm(staging, { recursive: true });
    }
    const manifestSha = sha256(await readFile(resolve(generation, "resource-manifest.json")));
    await writeJson(pointerPath, { ...manifest, manifest_path: manifestRel, manifest_sha256: manifestSha });
    return { ...manifest, manifest_path: manifestRel, manifest_sha256: manifestSha, cache_hit: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectSource(root: string, id: string): Promise<IngestResult> {
  const source = await getSource(root, id), key = sourceKey(source);
  validateVersionBinding(source);
  const raw: RawManifest | null = await optionalJson(await privatePath(root, `raw/${key}/current.json`));
  const prepared = await getPreparedManifest(root, id);
  const warnings: string[] = [];
  if (raw) {
    if ((raw as any).source_identity_sha256 !== identitySha(source)) throw new Error("raw_identity_mismatch_refetch_required");
    await verifyArtifacts(root, raw.artifacts);
  }
  if (prepared) await verifyArtifacts(root, prepared.artifacts);
  if (!raw) warnings.push("raw_acquisition_required");
  else if (!prepared) warnings.push("preparation_required");
  return { source_id: id, source_key: key, version: source.version ?? null, status: prepared?.status ?? raw?.status ?? "unavailable", artifacts: prepared?.artifacts ?? raw?.artifacts ?? [], warnings: [...warnings, ...(prepared?.warnings ?? raw?.warnings ?? [])], raw_status: raw?.status ?? "unavailable", prepared_status: prepared?.status ?? "unavailable", completeness: prepared?.completeness ?? null, raw_artifacts: raw?.artifacts ?? [], preparation_key: prepared?.preparation_key ?? null, visual_verification: "not_inferred_from_extraction" };
}
