import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const datetimeSchema = z.string().refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), "ISO datetime with an explicit offset required");
export const evidenceSchema = z.object({
  source_id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  version: z.string().nullable(),
  prepared_manifest: z.string(),
  prepared_manifest_sha256: digestSchema,
  artifact: z.string(),
  sha256: digestSchema,
  locator: z.object({ start_line: z.number().int().positive(), end_line: z.number().int().positive() }).strict(),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
/** Portable evidence pointer. Physical cache paths remain in private receipts. */
export const recordedEvidenceSchema = evidenceSchema.omit({ prepared_manifest: true }).extend({
  preparation_key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
});
export type RecordedEvidence = z.infer<typeof recordedEvidenceSchema>;

/** A generation record is authorship, not an independent confirmation. */
export const contributionSchema = z.object({
  schema_version: z.literal("rsi.knowledge-contribution.v1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  source_manifest_sha256: digestSchema,
  generated: z.object({
    by: z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, "Agent actor must use producer/version; human and process claims are not accepted here"),
    at: datetimeSchema,
  }).strict(),
  pages: z.array(z.object({
    path: z.string(),
    previous_sha256: digestSchema.optional(),
    frontmatter: z.record(z.string(), z.unknown()),
    body: z.string().min(1),
    evidence: z.array(evidenceSchema).min(1),
  }).strict()).min(1).max(100),
}).strict();
export type Contribution = z.infer<typeof contributionSchema>;

export type Category = "format" | "citation" | "link" | "evidence" | "ownership" | "lifecycle";
export type Issue = { path: string; category: Category; code: string; severity: "error" | "warning"; message: string };
export type KnowledgeDocument = {
  path: string; sha256: string; frontmatter: Record<string, unknown>; body: string; raw: string;
  reserved: boolean; bodyStartLine: number;
};
export type OwnedFile = {
  kind: "authored" | "source" | "derived";
  sha256: string;
  contribution_id?: string;
  evidence?: RecordedEvidence[];
  generated?: { by: string; at: string };
};
export type KnowledgeManifest = {
  schema_version: "rsi.knowledge-manifest.v1";
  files: Record<string, OwnedFile>;
  imports: Record<string, { sha256: string; generated: { by: string; at: string }; pages: string[]; source_manifest_sha256: string }>;
};
export const KNOWLEDGE_MANIFEST = "wiki/knowledge-manifest.json";
export const emptyManifest = (): KnowledgeManifest => ({ schema_version: "rsi.knowledge-manifest.v1", files: {}, imports: {} });
