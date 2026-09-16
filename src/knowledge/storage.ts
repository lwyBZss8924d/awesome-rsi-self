import { lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { noSymlinkPath, sha256 } from "../io.ts";
import { emptyManifest, recordedEvidenceSchema, digestSchema, datetimeSchema, KNOWLEDGE_MANIFEST, type KnowledgeManifest, type OwnedFile, type Issue, type KnowledgeDocument } from "./contracts.ts";
import { parseMarkdown, wikiPath } from "./markdown.ts";

const generation = z.object({ by: z.string(), at: datetimeSchema });
const manifestSchema = z.object({
  schema_version: z.literal("rsi.knowledge-manifest.v1"),
  files: z.record(z.string(), z.object({ kind: z.enum(["authored", "source", "derived"]), sha256: digestSchema, contribution_id: z.string().optional(), evidence: z.array(recordedEvidenceSchema).optional(), generated: generation.optional() }).strict()),
  imports: z.record(z.string(), z.object({ sha256: digestSchema, generated: generation, pages: z.array(z.string()), source_manifest_sha256: digestSchema }).strict()),
}).strict();

export async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
}

export async function loadKnowledgeManifest(root: string): Promise<KnowledgeManifest> {
  const file = await noSymlinkPath(root, KNOWLEDGE_MANIFEST), raw = await readOptional(file);
  if (!raw) return emptyManifest();
  const value = manifestSchema.parse(JSON.parse(raw));
  for (const path of Object.keys(value.files)) if (wikiPath(path) !== path) throw new Error("invalid_owned_path");
  for (const [id, entry] of Object.entries(value.imports)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error("invalid_import_id");
    for (const path of entry.pages) if (wikiPath(path) !== path) throw new Error("invalid_import_path");
  }
  return value;
}

export async function withKnowledgeLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const base = await noSymlinkPath(root, ".local/knowledge");
  await mkdir(base, { recursive: true });
  const lock = resolve(base, "mutation.lock");
  try { await mkdir(lock); } catch (error: any) { if (error.code === "EEXIST") throw new Error("knowledge_writer_active_or_interrupted: inspect .local/knowledge/mutation.lock before owner recovery"); throw error; }
  await writeFile(resolve(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  try { return await work(); }
  finally {
    const { unlink } = await import("node:fs/promises");
    await unlink(resolve(lock, "owner.json")); await rmdir(lock);
  }
}

export type PlannedFile = { path: string; text: string; owner: Omit<OwnedFile, "sha256"> };
export async function applyOwnedWrites(root: string, oldManifest: KnowledgeManifest, nextManifest: KnowledgeManifest, writes: PlannedFile[]): Promise<void> {
  for (const write of writes) {
    const path = wikiPath(write.path), file = await noSymlinkPath(root, `wiki/${path}`), existing = await readOptional(file), owned = oldManifest.files[path];
    if (existing !== undefined && !owned) throw new Error(`foreign_file:${path}`);
    if (owned && existing !== undefined && sha256(existing) !== owned.sha256) throw new Error(`ownership_conflict:${path}`);
    if (owned && existing === undefined) throw new Error(`owned_file_missing:${path}`);
  }
  // All conflicts are checked before effects. The manifest is written last; interrupted
  // writes remain detectable as ownership conflicts rather than being silently adopted.
  for (const write of writes) {
    const file = await noSymlinkPath(root, `wiki/${write.path}`);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, write.text, { flag: "wx", mode: 0o644 }); await rename(temp, file);
    nextManifest.files[write.path] = { ...write.owner, sha256: sha256(write.text) };
  }
  const manifestFile = await noSymlinkPath(root, KNOWLEDGE_MANIFEST);
  await mkdir(dirname(manifestFile), { recursive: true });
  const temporary = `${manifestFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  await rename(temporary, manifestFile);
}

export async function scanKnowledge(root: string): Promise<{ documents: KnowledgeDocument[]; issues: Issue[] }> {
  const documents: KnowledgeDocument[] = [], issues: Issue[] = [], base = await noSymlinkPath(root, "wiki");
  async function walk(directory: string, prefix: string) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) { issues.push({ path, category: "ownership", code: "symlink_skipped", severity: "error", message: "Wiki traversal never follows symbolic links." }); continue; }
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), `${path}/`);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        try { wikiPath(path); documents.push(parseMarkdown(path, await readFile(resolve(directory, entry.name), "utf8"))); }
        catch (error: any) { issues.push({ path, category: "format", code: "document_parse", severity: "error", message: error.message }); }
      }
    }
  }
  await walk(base, "");
  return { documents, issues };
}
