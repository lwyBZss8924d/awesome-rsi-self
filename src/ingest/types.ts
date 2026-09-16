import type { Source } from "../contracts.ts";

export const PARSER_VERSION = "rsi-paper-context/1.0.3";
export type IngestStatus = "fetched" | "prepared" | "partial" | "unavailable";
export type Artifact = {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  role: string;
  format: string;
};
export type IngestResult = {
  source_id: string;
  source_key: string;
  version: string | null;
  status: IngestStatus;
  artifacts: Artifact[];
  warnings: string[];
  [key: string]: unknown;
};
export type Acquisition = {
  kind: "html" | "tex" | "raw_text";
  url_field?: "html" | "tex";
  text_encoding?: "utf-8";
  requested_url: string;
  final_url: string;
  acquired_at: string;
  http_status: number;
  content_type: string;
  etag: string | null;
  last_modified: string | null;
  artifact: Artifact;
  version_binding: string | null;
};
export type RawManifest = IngestResult & {
  schema_version: "rsi.raw.v1";
  source: Source;
  source_manifest_sha256: string;
  acquisitions: Acquisition[];
  attempts: { kind: "html" | "tex"; url: string; status: "ok" | "unavailable"; reason?: string; receipt: string }[];
};
export type CleaningTemplate = {
  schema_version: "rsi.cleaning-template.v1";
  id: string;
  body_selectors: string[];
  remove_selectors: string[];
  title_selectors: string[];
};
export type SourceOrigin = {
  kind: "html" | "tex" | "text";
  raw_sha256: string;
  selector?: string;
  element_id?: string;
  file?: string;
  start_line?: number;
  end_line?: number;
};
export type SourceMapBlock = {
  id: string;
  output: { artifact: string; start_line: number; end_line: number };
  origin: SourceOrigin | null;
  precision: "structural" | "exact" | "unmapped";
};
export type HtmlBlock = {
  id: string;
  text: string;
  heading?: { level: number; title: string };
  origin: Omit<SourceOrigin, "raw_sha256">;
};
export type ExtractedAsset = {
  id: string;
  url?: string;
  file?: string;
  kind: "image" | "pdf" | "other";
  alt?: string;
  origin?: Omit<SourceOrigin, "raw_sha256">;
};
export type PreparedManifest = IngestResult & {
  schema_version: "rsi.prepared.v1";
  preparation_key: string;
  parser_version: string;
  source_manifest_sha256: string;
  input_artifacts: Artifact[];
  source_identity: { id: string; version: string | null; urls: Source["urls"] };
  completeness: Record<string, unknown>;
};
