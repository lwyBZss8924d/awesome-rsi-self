import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, relative, extname } from "node:path";
import { homedir } from "node:os";
import { getSource, noSymlinkPath, readJson, sha256, writeJson } from "../io.ts";
import { sourceKey } from "../contracts.ts";
import { getPreparedManifest, verifyArtifacts } from "./index.ts";
import type { Artifact } from "./types.ts";

export type ArtifactOperation = "parse" | "screenshot" | "view_image";
export type ArtifactRequestOptions = {
  asset_id: string;
  operation: ArtifactOperation;
  /** Explicit, bounded pages e.g. 1-3,7. Screenshots require this selector. */
  pages?: string;
  max_pages?: number;
  dpi?: number;
  no_ocr?: boolean;
};
type ArtifactRequest = {
  schema_version: "rsi.artifact-request.v1";
  request_id: string;
  source_id: string;
  source_key: string;
  preparation_key: string;
  operation: ArtifactOperation;
  template: "lit-parse-json-v1" | "lit-screenshot-v1" | "view-image-v1";
  source_artifact: Artifact;
  config: { pages: string | null; max_pages: number; dpi: number; no_ocr: boolean };
  output_directory: string;
  execution: "pending";
  visual_verification: "not_performed";
};
type VisualReceipt = {
  actor: string;
  method: "view_image";
  observed_image_sha256: string;
  finding: string;
  outcome: "verified" | "discrepancy" | "uncertain";
  /** Reference to the actual image tool event; not a claim derived from parse output. */
  evidence_ref: string;
};
const operations = new Set(["parse", "screenshot", "view_image"]);
const limit = (n: number, min: number, max: number, label: string) => {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid_${label}`);
  return n;
};
function pages(value: string | undefined, max: number): string | null {
  if (!value) return null;
  if (value.length > 128 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw new Error("invalid_pages");
  const unique = new Set<number>();
  for (const piece of value.split(",")) {
    const [a, b = a] = piece.split("-").map(Number);
    if (a < 1 || b < a || b > 10_000 || b - a + 1 > max) throw new Error("page_bound_exceeded");
    for (let p = a; p <= b; p++) unique.add(p);
  }
  if (unique.size > max) throw new Error("page_bound_exceeded");
  return [...unique].sort((a, b) => a - b).join(",");
}
async function existsJson(file: string) {
  try { return await readJson(file); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}
async function writeOnce(root: string, item: string, object: unknown) {
  const path = await noSymlinkPath(root, item), data = `${JSON.stringify(object, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, data, { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error.code !== "EEXIST" || sha256(await readFile(path)) !== sha256(data)) throw error; }
}

/** Fetch exactly one selected embedded asset. No recursive page/network expansion. */
export async function fetchAsset(root: string, sourceId: string, assetId: string, options: { fetch?: typeof fetch; signal?: AbortSignal; max_bytes?: number; timeout_ms?: number; allowed_origins?: string[] } = {}) {
  const source = await getSource(root, sourceId), manifest = await getPreparedManifest(root, sourceId);
  if (!manifest) throw new Error("preparation_required");
  const assetManifest = manifest.artifacts.find(a => a.id === "source-assets");
  if (!assetManifest) throw new Error("asset_manifest_missing");
  await verifyArtifacts(root, [assetManifest]);
  const assets = await readJson(await noSymlinkPath(root, assetManifest.path));
  const asset = assets.assets.find((a: any) => a.id === assetId);
  if (!asset?.url) throw new Error("remote_asset_not_found");
  const url = new URL(asset.url);
  const origin = new URL(source.urls.html ?? source.urls.canonical).origin;
  const allowed = new Set([origin, ...(options.allowed_origins ?? []).map(value => new URL(value).origin)]);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin)) throw new Error("asset_origin_not_allowed");
  const receiptPath = `.local/prepared/${sourceKey(source)}/asset-receipts/${sha256(JSON.stringify({ preparation_key: manifest.preparation_key, asset_id: assetId, url: url.href }))}.json`;
  const cached = await existsJson(await noSymlinkPath(root, receiptPath));
  if (cached) { await verifyArtifacts(root, [cached.artifact]); return { ...cached, receipt_path: receiptPath, cache_hit: true }; }
  const max = limit(options.max_bytes ?? 20 * 1024 * 1024, 1, 64 * 1024 * 1024, "asset_max_bytes");
  const timeout = limit(options.timeout_ms ?? 30_000, 1, 120_000, "asset_timeout_ms");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  signal.throwIfAborted();
  // Redirects are explicit so untrusted HTML cannot send an asset fetch to a new origin.
  let current = url.href, response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await (options.fetch ?? globalThis.fetch)(current, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || redirects === 3) throw new Error("asset_redirect_limit");
    const target = new URL(location, current);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || !allowed.has(target.origin)) throw new Error("asset_redirect_origin_not_allowed");
    current = target.href;
  }
  if (!response?.ok || !response.body) throw new Error(`asset_http_${response?.status ?? "missing"}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) { await response.body.cancel(); throw new Error("asset_size_limit"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > max) { await reader.cancel(); throw new Error("asset_size_limit"); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  const bytes = Buffer.concat(chunks);
  const prefix = bytes.subarray(0, 16), type = response.headers.get("content-type") ?? "";
  const extension = prefix.subarray(0, 4).toString() === "%PDF" ? "pdf" : prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" : prefix[0] === 255 && prefix[1] === 216 ? "jpg" : prefix.subarray(0, 3).toString() === "GIF" ? "gif" : prefix.subarray(0, 4).toString() === "RIFF" && prefix.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (!extension) throw new Error("unsupported_asset_payload");
  const digest = sha256(bytes), file = `.local/raw/${sourceKey(source)}/assets/${digest}.${extension}`;
  const target = await noSymlinkPath(root, file); await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error.code !== "EEXIST" || sha256(await readFile(target)) !== digest) throw error; }
  const artifact: Artifact = { id: `asset:${assetId}`, path: file, sha256: digest, bytes: bytes.length, role: "source_raw_asset", format: extension };
  const receipt = { schema_version: "rsi.asset-acquisition.v1", source_id: sourceId, source_key: sourceKey(source), preparation_key: manifest.preparation_key, asset_id: assetId, requested_url: url.href, final_url: current, acquired_at: new Date().toISOString(), content_type: type, artifact, status: "fetched", visual_verification: "not_performed" };
  await writeOnce(root, receiptPath, receipt);
  return { ...receipt, receipt_path: receiptPath, cache_hit: false };
}

export async function requestArtifact(root: string, sourceId: string, options: ArtifactRequestOptions) {
  if (!operations.has(options.operation)) throw new Error("unsupported_artifact_operation");
  const source = await getSource(root, sourceId), manifest = await getPreparedManifest(root, sourceId);
  if (!manifest) throw new Error("preparation_required");
  const assetsFile = manifest.artifacts.find(a => a.id === "source-assets");
  if (!assetsFile) throw new Error("asset_manifest_missing");
  await verifyArtifacts(root, [assetsFile]);
  const assets = await readJson(await noSymlinkPath(root, assetsFile.path));
  const asset = assets.assets.find((a: any) => a.id === options.asset_id);
  if (!asset) throw new Error("asset_not_found");
  let input: Artifact | undefined;
  if (asset.file) {
    input = manifest.artifacts.find(a => a.path === asset.file);
    if (!input || input.sha256 !== asset.sha256) throw new Error("asset_not_bound_to_manifest");
  } else if (asset.url) {
    const receiptPath = `.local/prepared/${sourceKey(source)}/asset-receipts/${sha256(JSON.stringify({ preparation_key: manifest.preparation_key, asset_id: options.asset_id, url: new URL(asset.url).href }))}.json`;
    const receipt = await existsJson(await noSymlinkPath(root, receiptPath));
    if (!receipt || receipt.preparation_key !== manifest.preparation_key || receipt.asset_id !== options.asset_id || receipt.source_id !== sourceId) throw new Error("asset_acquisition_required");
    input = receipt.artifact;
  }
  if (!input) throw new Error("asset_acquisition_required");
  await verifyArtifacts(root, [input]);
  const extension = extname(input.path).toLowerCase();
  if (options.operation === "view_image" && ![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) throw new Error("raster_image_required_use_screenshot");
  if (options.operation !== "view_image" && ![".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".docx", ".xlsx", ".pptx"].includes(extension)) throw new Error("unsupported_lit_asset_format");
  const maxPages = limit(options.max_pages ?? 10, 1, 30, "max_pages");
  const config = { pages: pages(options.pages, maxPages), max_pages: maxPages, dpi: limit(options.dpi ?? 150, 150, 200, "dpi"), no_ocr: options.no_ocr ?? true };
  if (options.operation === "screenshot" && !config.pages) throw new Error("screenshot_requires_selected_pages");
  const template = options.operation === "parse" ? "lit-parse-json-v1" : options.operation === "screenshot" ? "lit-screenshot-v1" : "view-image-v1";
  const recipe = { schema_version: "rsi.artifact-request.v1" as const, source_id: sourceId, source_key: sourceKey(source), preparation_key: manifest.preparation_key, operation: options.operation, template, source_artifact: input, config };
  const key = sha256(JSON.stringify(recipe)), directory = `.local/prepared/${sourceKey(source)}/artifact-jobs/${key}`;
  const request: ArtifactRequest = { ...recipe, template, request_id: key, output_directory: `${directory}/output`, execution: "pending", visual_verification: "not_performed" };
  await writeOnce(root, `${directory}/request.json`, request);
  return { ...request, request_path: `${directory}/request.json`, next_action: options.operation === "view_image" ? "Use the native view_image tool on source_artifact.path, then record a visual receipt tied to the observed digest and event." : "runArtifactRequest with this request path; it executes a fixed local argv template." };
}

async function loadRequest(root: string, requestPath: string): Promise<ArtifactRequest> {
  const request: ArtifactRequest = await readJson(await noSymlinkPath(root, requestPath));
  if (request.schema_version !== "rsi.artifact-request.v1" || !operations.has(request.operation)) throw new Error("invalid_artifact_request");
  const { request_id, output_directory, execution, visual_verification, ...recipe } = request;
  if (sha256(JSON.stringify(recipe)) !== request_id) throw new Error("artifact_request_digest_mismatch");
  const expected = `.local/prepared/${request.source_key}/artifact-jobs/${request_id}`;
  if (requestPath !== `${expected}/request.json` || output_directory !== `${expected}/output`) throw new Error("artifact_request_path_mismatch");
  const currentSource = await getSource(root, request.source_id);
  if (sourceKey(currentSource) !== request.source_key) throw new Error("artifact_source_identity_mismatch");
  if (!request.source_artifact.path.startsWith(`.local/prepared/${request.source_key}/generations/${request.preparation_key}/`) && !request.source_artifact.path.startsWith(`.local/raw/${request.source_key}/assets/`)) throw new Error("artifact_source_path_mismatch");
  await verifyArtifacts(root, [request.source_artifact]);
  limit(request.config.max_pages, 1, 30, "max_pages"); limit(request.config.dpi, 150, 200, "dpi");
  if (pages(request.config.pages ?? undefined, request.config.max_pages) !== request.config.pages) throw new Error("noncanonical_pages");
  const expectedTemplate = request.operation === "parse" ? "lit-parse-json-v1" : request.operation === "screenshot" ? "lit-screenshot-v1" : "view-image-v1";
  if (request.template !== expectedTemplate || typeof request.config.no_ocr !== "boolean") throw new Error("invalid_artifact_template");
  if (request.operation === "screenshot" && !request.config.pages) throw new Error("screenshot_requires_selected_pages");
  return request;
}

export function artifactArgv(request: ArtifactRequest, input: string, output: string): string[] {
  if (request.operation === "parse") {
    return ["parse", input, "--format", "json", "--output", resolve(output, "parsed.json"), "--max-pages", String(request.config.max_pages), "--dpi", String(request.config.dpi), "--num-workers", "1", "--extract-blocks", "--extract-images", "--image-output-dir", resolve(output, "images"), ...(request.config.no_ocr ? ["--no-ocr"] : []), ...(request.config.pages ? ["--target-pages", request.config.pages] : [])];
  }
  if (request.operation === "screenshot") return ["screenshot", input, "--output-dir", output, "--target-pages", request.config.pages!, "--dpi", String(request.config.dpi)];
  throw new Error("native_view_image_required");
}
async function walkFiles(root: string, current: string): Promise<string[]> {
  const files: string[] = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error("tool_output_symlink");
    const path = resolve(current, item.name);
    if (item.isDirectory()) files.push(...await walkFiles(root, path));
    else if (item.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
    else throw new Error("tool_output_special_file");
    if (files.length > 500) throw new Error("tool_output_count_limit");
  }
  return files;
}
function localToolEnv() {
  return Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].filter(k => process.env[k]).map(k => [k, process.env[k]!]));
}
async function litVersion(lit: string) {
  const child = Bun.spawn([lit, "--version"], { stdout: "pipe", stderr: "pipe", env: localToolEnv() });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 || output.length > 1024 || !output.trim()) throw new Error(`lit_version_unavailable:${code}`);
    return output.trim();
  } finally { clearTimeout(timer); }
}

export async function runArtifactRequest(root: string, requestPath: string, options: { lit?: string; timeout_ms?: number } = {}) {
  const request = await loadRequest(root, requestPath);
  if (request.operation === "view_image") return { status: "requires_native_tool", request_id: request.request_id, source_artifact: request.source_artifact, visual_verification: "not_performed" };
  const output = await noSymlinkPath(root, request.output_directory), receiptPath = `${dirname(requestPath)}/execution-receipt.json`;
  const previous = await existsJson(await noSymlinkPath(root, receiptPath));
  if (previous?.status === "succeeded") { await verifyArtifacts(root, previous.artifacts); return { ...previous, cache_hit: true }; }
  if (previous) return { ...previous, cache_hit: true, next_action: "Inspect the retained failure; change the recipe or provide a new explicit request after diagnosis. No automatic retry." };
  const lit = options.lit ?? resolve(homedir(), ".cargo/bin/lit");
  if (!lit.startsWith("/")) throw new Error("lit_absolute_executable_required");
  const toolVersion = await litVersion(lit);
  const cacheKey = sha256(JSON.stringify({ source_sha256: request.source_artifact.sha256, template: request.template, config: request.config, lit, tool_version: toolVersion }));
  const cachePath = `.local/artifact-cache/${cacheKey}.json`;
  const cached = await existsJson(await noSymlinkPath(root, cachePath));
  if (cached?.status === "succeeded") {
    await verifyArtifacts(root, cached.artifacts);
    const reused = { ...cached, request_id: request.request_id, source_id: request.source_id, source_key: request.source_key, reused_from: cached.request_id, cached: true };
    await writeOnce(root, receiptPath, reused);
    return { ...reused, cache_hit: true };
  }
  const timeout = limit(options.timeout_ms ?? 120_000, 1, 300_000, "timeout_ms");
  const job = await noSymlinkPath(root, dirname(requestPath));
  // An exclusive started marker prevents a second worker from rerunning this recipe.
  const marker = resolve(job, "started.json");
  try { await writeFile(marker, `${JSON.stringify({ request_id: request.request_id, started_at: new Date().toISOString(), process_id: process.pid })}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error.code === "EEXIST") return { status: "running_or_interrupted", request_id: request.request_id, next_action: "Inspect started.json and process identity; do not remove a live marker or duplicate this parse." }; throw error; }
  const argv = [lit, ...artifactArgv(request, await noSymlinkPath(root, request.source_artifact.path), output)];
  await mkdir(output, { recursive: true });
  let timedOut = false;
  let result: any;
  try {
    const child = Bun.spawn(argv, { stdout: Bun.file(resolve(job, "stdout.txt")), stderr: Bun.file(resolve(job, "stderr.txt")), env: localToolEnv() });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    let exitCode: number;
    try { exitCode = await child.exited; } finally { clearTimeout(timer); }
    const files = await walkFiles(resolve(root), output);
    const artifacts: Artifact[] = [];
    let total = 0;
    for (const file of files) {
      const data = await readFile(await noSymlinkPath(root, file));
      total += data.length;
      if (total > 128 * 1024 * 1024) throw new Error("tool_output_size_limit");
      artifacts.push({ id: `tool-output:${relative(output, resolve(root, file))}`, path: file, sha256: sha256(data), bytes: data.length, role: "tool_extraction", format: extname(file).slice(1) || "text" });
    }
    const parseOutput = artifacts.find(a => a.path.endsWith("/parsed.json"));
    if (exitCode === 0 && request.operation === "parse") {
      if (!parseOutput) throw new Error("parse_output_missing");
      const parsed = await readJson(await noSymlinkPath(root, parseOutput.path));
      if (!Array.isArray(parsed.pages) || !parsed.pages.length || parsed.pages.length > request.config.max_pages || !Number.isInteger(parsed.total_pages) || parsed.total_pages < parsed.pages.length) throw new Error("parse_output_schema_invalid");
    }
    result = { status: exitCode === 0 && !timedOut && artifacts.length ? "succeeded" : "failed", exit_code: exitCode, timed_out: timedOut, artifacts };
  } catch (error: any) { result = { status: "failed", error: String(error.message).slice(0, 500), artifacts: [] }; }
  const receipt = { schema_version: "rsi.artifact-execution.v1", request_id: request.request_id, source_id: request.source_id, source_key: request.source_key, source_sha256: request.source_artifact.sha256, template: request.template, tool_version: toolVersion, argv, finished_at: new Date().toISOString(), ...result, visual_verification: "not_performed" };
  await writeOnce(root, receiptPath, receipt);
  if (receipt.status === "succeeded") {
    try { await writeOnce(root, cachePath, receipt); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
  }
  return receipt;
}

export async function recordVisualReceipt(root: string, requestPath: string, input: VisualReceipt) {
  const request = await loadRequest(root, requestPath);
  if (!input.actor?.trim() || input.method !== "view_image" || !input.evidence_ref?.trim() || !input.finding?.trim() || !["verified", "discrepancy", "uncertain"].includes(input.outcome)) throw new Error("invalid_visual_receipt");
  let images: Artifact[] = [];
  if (request.operation === "view_image") images = [request.source_artifact];
  else {
    const execution = await existsJson(await noSymlinkPath(root, `${dirname(requestPath)}/execution-receipt.json`));
    if (execution?.status !== "succeeded") throw new Error("artifact_execution_required");
    images = execution.artifacts.filter((a: Artifact) => /\.(?:png|jpe?g|webp|gif)$/i.test(a.path));
  }
  const image = images.find(a => a.sha256 === input.observed_image_sha256);
  if (!image) throw new Error("visual_image_digest_mismatch");
  await verifyArtifacts(root, [image]);
  const receipt = { schema_version: "rsi.visual-receipt.v1", request_id: request.request_id, source_id: request.source_id, source_image: image, ...input, recorded_at: new Date().toISOString(), status: "recorded", trust: "actor_attestation_not_independently_verified" };
  const name = sha256(JSON.stringify(receipt));
  await writeOnce(root, `${dirname(requestPath)}/visual-receipts/${name}.json`, receipt);
  return receipt;
}
