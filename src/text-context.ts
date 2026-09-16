/** Shared ingest/evidence contract. A suffix or valid UTF-8 alone is not a
 * context declaration: the bound artifact must have a supported role/format. */
export const TEXT_FORMATS_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "markdown", markdown: "markdown", mdx: "mdx", qmd: "quarto-markdown", txt: "text", text: "text",
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", sh: "shell", zsh: "shell", json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", css: "css",
};

// The TeX archive exposes individual original files under source_extracted;
// its aggregate context is emitted as UTF-8 Markdown under prompt_context.
const TEXT_CONTEXT_FORMATS = new Set([...Object.values(TEXT_FORMATS_BY_EXTENSION), "tex", "sty", "cls", "bib", "bst"]);
export function isTextContextArtifact(artifact: { role?: string; format?: string }): boolean {
  return (artifact.role === "prompt_context" || artifact.role === "source_extracted") && typeof artifact.format === "string" && TEXT_CONTEXT_FORMATS.has(artifact.format);
}

export function decodeTextContext(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("text_invalid_utf8"); }
  if (!text.trim()) throw new Error("text_empty_content");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || /^(?:%PDF-|PK\x03\x04|\x7fELF)/.test(text)) throw new Error("binary_disguised_as_text");
  return text;
}
