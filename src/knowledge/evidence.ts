import { readFile } from "node:fs/promises";
import { z } from "zod";
import { sourceKey, type Source } from "../contracts.ts";
import { noSymlinkPath, sha256 } from "../io.ts";
import { evidenceSchema, recordedEvidenceSchema, type Evidence, type RecordedEvidence } from "./contracts.ts";

export function strictRelative(path: string): string {
  if (!path || path.startsWith("/") || /[\\\0%]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid_artifact_path");
  return path;
}

export function portableEvidence(evidence: Evidence): RecordedEvidence {
  const generation = evidence.prepared_manifest.slice(0, -"resource-manifest.json".length);
  const { prepared_manifest: _private, artifact, ...rest } = evidence;
  return { ...rest, preparation_key: generation.split("/").at(-2)!, artifact: artifact.slice(generation.length) };
}

export function localEvidence(record: RecordedEvidence, source: Source): Evidence {
  const evidence = recordedEvidenceSchema.parse(record), artifact = strictRelative(evidence.artifact);
  const { preparation_key, ...rest } = evidence;
  const prefix = `.local/prepared/${sourceKey(source)}/generations/${preparation_key}/`;
  return { ...rest, artifact: `${prefix}${artifact}`, prepared_manifest: `${prefix}resource-manifest.json` };
}

const preparedManifestSchema = z.object({
  schema_version: z.literal("rsi.prepared.v1"),
  source_id: z.string(), source_key: z.string(), version: z.string().nullable().optional(),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().optional(), role: z.string().optional(), format: z.string().optional() }).passthrough()),
}).passthrough();

/** This establishes the existence and location of evidence, never semantic support. */
export async function validateEvidence(root: string, evidenceInput: Evidence, source: Source) {
  const evidence = evidenceSchema.parse(evidenceInput);
  if (evidence.source_id !== source.id || evidence.version !== (source.version ?? null)) throw new Error("source_version_mismatch");
  const prefix = `.local/prepared/${sourceKey(source)}/generations/`;
  const manifestPath = strictRelative(evidence.prepared_manifest), artifactPath = strictRelative(evidence.artifact);
  if (!manifestPath.startsWith(prefix) || !manifestPath.endsWith("/resource-manifest.json")) throw new Error("prepared_manifest_scope");
  const generation = manifestPath.slice(0, -"resource-manifest.json".length);
  if (!artifactPath.startsWith(generation)) throw new Error("artifact_outside_generation");
  const manifestBytes = await readFile(await noSymlinkPath(root, manifestPath));
  if (sha256(manifestBytes) !== evidence.prepared_manifest_sha256) throw new Error("prepared_manifest_digest_mismatch");
  const manifest = preparedManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.source_id !== source.id || manifest.source_key !== sourceKey(source) || (manifest.version ?? null) !== evidence.version) throw new Error("prepared_source_mismatch");
  if (manifest.source_identity !== undefined) {
    const identity = manifest.source_identity as { id?: string; version?: string | null; urls?: Record<string, string> };
    if (identity.id !== source.id || (identity.version ?? null) !== evidence.version || !identity.urls || Object.entries(source.urls).some(([key, url]) => identity.urls?.[key] !== url)) throw new Error("prepared_source_identity_mismatch");
  }
  const members = manifest.artifacts.filter(artifact => artifact.path === artifactPath);
  if (members.length !== 1 || members[0]!.sha256 !== evidence.sha256) throw new Error("artifact_not_bound_by_manifest");
  const member = members[0]!;
  if (!/\.(?:txt|md|tex)$/i.test(artifactPath) || (member.role && ["context_index", "source_map", "metadata"].includes(member.role))) throw new Error("evidence_requires_context_leaf");
  const bytes = await readFile(await noSymlinkPath(root, artifactPath));
  if (sha256(bytes) !== evidence.sha256 || (member.bytes !== undefined && bytes.byteLength !== member.bytes)) throw new Error("artifact_digest_mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (evidence.locator.end_line < evidence.locator.start_line || evidence.locator.end_line > lines.length) throw new Error("locator_out_of_bounds");
  if (!lines.slice(evidence.locator.start_line - 1, evidence.locator.end_line).join("\n").trim()) throw new Error("locator_empty");
  return { source_id: source.id, version: evidence.version, artifact: artifactPath, sha256: evidence.sha256, locator: evidence.locator, lines: lines.length, semantic_support: "not_evaluated" as const };
}
