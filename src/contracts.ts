import { z } from "zod";

export const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  kind: z.enum(["paper", "repository", "documentation", "article"]),
  title: z.string().min(1),
  version: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  urls: z.object({ canonical: z.string().url(), html: z.string().url().optional(), tex: z.string().url().optional(), repo: z.string().url().optional() }),
  tags: z.array(z.string()).default([]),
  provenance: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type Source = z.infer<typeof sourceSchema>;
export const sourcesSchema = z.object({ schema_version: z.literal("rsi.sources.v1"), updated_at: z.string(), sources: z.array(sourceSchema) });
export type Sources = z.infer<typeof sourcesSchema>;
export function sourceKey(source: Source): string { return `${source.id}--${source.version ?? "current"}`; }
export const SOURCE_MANIFEST = "sources/source-manifest.json";
export const PRIVATE_ROOT = ".local";
