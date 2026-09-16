import { parseDocument, stringify } from "yaml";
import { basename, dirname, posix } from "node:path";
import { sha256 } from "../io.ts";
import type { Issue, KnowledgeDocument } from "./contracts.ts";

/** Public selectors never accept absolute paths, traversal, encoding, or Windows aliases. */
export function wikiPath(value: string): string {
  const path = value.startsWith("wiki/") ? value.slice(5) : value;
  if (!path || /[\\\0%?#]/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || !path.endsWith(".md")) throw new Error("invalid_wiki_path");
  return path;
}

export function parseMarkdown(path: string, raw: string): KnowledgeDocument {
  let frontmatter: Record<string, unknown> = {}, body = raw, bodyStartLine = 1;
  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const lines = raw.split(/\r?\n/), end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end < 0) throw new Error("frontmatter_unclosed");
    const parsed = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true });
    if (parsed.errors.length) throw new Error(`frontmatter_yaml:${parsed.errors[0]!.message}`);
    const value = parsed.toJS({ maxAliasCount: 100 });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("frontmatter_mapping_required");
    frontmatter = value;
    body = lines.slice(end + 1).join("\n"); bodyStartLine = end + 2;
  } else if (!["index.md", "log.md"].includes(basename(path))) throw new Error("frontmatter_missing");
  return { path, raw, body, frontmatter, bodyStartLine, sha256: sha256(raw), reserved: ["index.md", "log.md"].includes(basename(path)) };
}

export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Blank fenced code without moving line numbers; examples must not become citations. */
export function proseLines(body: string): string[] {
  let fence: string | undefined;
  return body.split(/\r?\n/).map(line => {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) { if (!fence) fence = match[1]!; else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length) fence = undefined; return ""; }
    return fence || /^(?: {4}|\t)/.test(line) ? "" : line.replace(/(`+)(.*?)\1/g, match => " ".repeat(match.length));
  });
}

export function citations(body: string) {
  const used = new Set<string>(), defined = new Set<string>();
  for (const line of proseLines(body)) {
    const definition = /^\s{0,3}\[\^([^\]]+)\]:/.exec(line);
    if (definition) { defined.add(definition[1]!); continue; }
    for (const match of line.matchAll(/\[\^([^\]]+)\]/g)) used.add(match[1]!);
  }
  return { used: [...used], defined: [...defined] };
}

export function markdownLinks(body: string): string[] {
  const output: string[] = [];
  for (const line of proseLines(body)) {
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) output.push(match[1] ?? match[2]!);
    const definition = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/.exec(line);
    if (definition) output.push(definition[1] ?? definition[2]!);
  }
  return output;
}

export function localLink(from: string, target: string): { path: string; fragment?: string } | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
  if (/[\\\0%]/.test(target)) throw new Error("unsafe_local_link");
  const [path, fragment] = target.split("#", 2);
  const resolved = path ? posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(dirname(from), path)) : from;
  if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) throw new Error("link_path_escape");
  return { path: resolved.endsWith("/") ? `${resolved}index.md` : resolved, fragment };
}

export function headingSlug(value: string): string { return value.toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-"); }
export function headings(body: string): { title: string; slug: string; line: number; level: number }[] {
  const output: { title: string; slug: string; line: number; level: number }[] = [];
  const counts = new Map<string, number>();
  const lines = proseLines(body);
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    if (!match) return;
    const title = match[2]!, base = headingSlug(title), count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    output.push({ title, slug: count ? `${base}-${count}` : base, line: index + 1, level: match[1]!.length });
  });
  return output;
}

export function formatIssues(doc: KnowledgeDocument): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string) => issues.push({ path: doc.path, category: "format", code, severity: "error", message });
  if (!doc.reserved && (typeof doc.frontmatter.type !== "string" || !doc.frontmatter.type.trim())) add("type_required", "OKF concepts require a nonempty type; unknown types are allowed.");
  if (basename(doc.path) === "index.md") {
    const keys = Object.keys(doc.frontmatter);
    if (keys.length && (doc.path !== "index.md" || keys.some(key => key !== "okf_version"))) add("index_frontmatter", "Only bundle-root index.md may carry okf_version frontmatter.");
    if (!/^#{1,6}\s+\S/m.test(doc.body)) add("index_sections", "OKF index files need heading sections.");
  }
  if (basename(doc.path) === "log.md") {
    if (Object.keys(doc.frontmatter).length) add("log_frontmatter", "OKF log files do not have frontmatter.");
    for (const line of proseLines(doc.body)) {
      if (/^##\s/.test(line) && !/^## \d{4}-\d{2}-\d{2}\s*$/.test(line)) add("log_date", "OKF log date groups must use YYYY-MM-DD.");
    }
  }
  return issues;
}

export function trustTier(frontmatter: Record<string, unknown>): "unverified" | "machine-confirmed" | "human-reviewed" {
  const value = frontmatter.verified, events = Array.isArray(value) ? value : value ? [value] : [];
  const valid = events.filter((entry: any) => entry && typeof entry.by === "string" && typeof entry.at === "string");
  if (!valid.length) return "unverified";
  return valid.some((entry: any) => entry.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}
