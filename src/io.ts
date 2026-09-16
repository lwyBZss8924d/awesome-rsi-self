import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { sourcesSchema, SOURCE_MANIFEST } from "./contracts.ts";

export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function readJson(file: string): Promise<any> { return JSON.parse(await readFile(file, "utf8")); }
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}
export function confined(root: string, item: string): string {
  if (isAbsolute(item)) throw new Error("relative_path_required");
  const result = resolve(root, item), rel = relative(resolve(root), result);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("path_escape");
  return result;
}
export async function noSymlinkPath(root: string, item: string): Promise<string> {
  const target = confined(root, item);
  const parts = relative(resolve(root), target).split(/[\\/]/).filter(Boolean);
  let current = resolve(root);
  for (const part of ["", ...parts]) {
    if (part) current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink_path"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}
export async function loadSources(root: string) { return sourcesSchema.parse(await readJson(resolve(root, SOURCE_MANIFEST))); }
export async function getSource(root: string, id: string) {
  const source = (await loadSources(root)).sources.find(s => s.id === id);
  if (!source) throw new Error(`source_not_found:${id}`);
  return source;
}
