import { parseHTML } from "linkedom";
import type { CleaningTemplate, ExtractedAsset, HtmlBlock } from "./types.ts";

export const ARXIV_TEMPLATE: CleaningTemplate = {
  schema_version: "rsi.cleaning-template.v1", id: "arxiv-latexml-v1",
  body_selectors: ["article.ltx_document", ".ltx_document", "article", "main", "body"],
  remove_selectors: ["nav", ".ltx_page_header", ".ltx_page_footer", ".ltx_page_navbar", "style", "noscript", "button", "form"],
  title_selectors: ["h1.ltx_title", "h1", "title"],
};
export const GENERIC_TEMPLATE: CleaningTemplate = {
  schema_version: "rsi.cleaning-template.v1", id: "generic-article-v1",
  body_selectors: ["article", "main", "body"],
  remove_selectors: ["nav", "header", "footer", "style", "noscript", "button", "form"],
  title_selectors: ["h1", "title"],
};

export function validateTemplate(value: CleaningTemplate): CleaningTemplate {
  if (value.schema_version !== "rsi.cleaning-template.v1" || !/^[a-z0-9._-]+$/i.test(value.id)) throw new Error("invalid_cleaning_template");
  for (const name of ["body_selectors", "remove_selectors", "title_selectors"] as const) {
    if (!Array.isArray(value[name]) || value[name].length > 32 || value[name].some(v => typeof v !== "string" || v.length > 256)) throw new Error(`invalid_template_${name}`);
  }
  if (!value.body_selectors.length) throw new Error("body_selector_required");
  return value;
}
const compact = (s: string) => s.replace(/[\t\r\n ]+/g, " ").trim();
const safeLink = (value: string | null) => value && !/^(?:javascript|data|vbscript):/i.test(value.trim()) ? value : "";
const tagOf = (node: any): string => String(node.localName ?? "").toLowerCase();
const textOf = (node: any) => compact(node.textContent ?? "");

function locator(el: any) {
  if (el.id) return { kind: "html" as const, selector: `[id=${JSON.stringify(el.id)}]`, element_id: String(el.id) };
  const path: string[] = [];
  for (let cur = el; cur?.localName && path.length < 12; cur = cur.parentElement) {
    const tag = tagOf(cur);
    let n = 1;
    for (let prev = cur.previousElementSibling; prev; prev = prev.previousElementSibling) if (tagOf(prev) === tag) n++;
    path.unshift(`${tag}:nth-of-type(${n})`);
    if (cur.id) { path[0] = `[id=${JSON.stringify(cur.id)}]`; break; }
  }
  return { kind: "html" as const, selector: path.join(" > ") };
}

export function extractHtml(html: string, options: { url: string; title: string; template?: CleaningTemplate }) {
  const template = validateTemplate(options.template ?? ARXIV_TEMPLATE);
  const { document } = parseHTML(html);
  const warnings: string[] = [];
  const blocks: HtmlBlock[] = [];
  const assets: ExtractedAsset[] = [];
  const counts = { headings: 0, paragraphs: 0, math: 0, tables: 0, figures: 0, citations: 0, footnotes: 0 };
  const pick = (selectors: string[]) => selectors.map(s => document.querySelector(s)).find(Boolean);
  const root: any = pick(template.body_selectors);
  if (!root) throw new Error("html_body_not_found");
  const title = textOf(pick(template.title_selectors) ?? { textContent: options.title });
  const rawSelector = locator(root).selector;
  const structuralPositions = new WeakMap<object, ReturnType<typeof locator>>();
  for (const el of [root, ...root.querySelectorAll("*")]) structuralPositions.set(el, locator(el));
  const at = (el: any) => structuralPositions.get(el) ?? locator(el);
  for (const selector of template.remove_selectors) for (const el of root.querySelectorAll(selector)) el.remove();
  for (const el of root.querySelectorAll("script")) if (!/^math\/tex(?:;|$)/i.test(el.getAttribute("type") ?? "")) el.remove();
  for (const el of root.querySelectorAll("[hidden],[aria-hidden=true]")) {
    // Math renderer fallbacks are data; retain the primary MathML representation.
    if (!el.querySelector("math") && tagOf(el) !== "math") el.remove();
  }
  for (const el of root.querySelectorAll("img")) {
    const href = safeLink(el.getAttribute("src"));
    let absolute: string | undefined;
    try { if (href) absolute = new URL(href, options.url).href; } catch { warnings.push("invalid_image_url"); }
    assets.push({ id: `html-asset-${assets.length + 1}`, url: absolute, kind: "image", alt: el.getAttribute("alt") ?? "", origin: at(el) });
  }

  const childInline = (el: any): string => Array.from(el.childNodes ?? []).map(inline).join("");
  function math(el: any, block = false): string {
    counts.math++;
    const tex = el.getAttribute("alttext") ?? el.getAttribute("data-tex") ?? el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) return block || el.getAttribute("display") === "block" ? `\n$$\n${tex.trim()}\n$$\n` : `$${tex.trim()}$`;
    warnings.push("math_without_tex_preserved_as_mathml");
    return `\n\`\`\`mathml\n${el.outerHTML}\n\`\`\`\n`;
  }
  function inline(node: any): string {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/[\t\r\n ]+/g, " ");
    const tag = tagOf(node);
    if (!tag) return "";
    if (tag === "math") return math(node);
    if (tag === "script") return /^math\/tex/i.test(node.getAttribute("type") ?? "") ? `$${node.textContent.trim()}$` : "";
    if (tag === "br") return "\n";
    if (tag === "img") {
      const href = safeLink(node.getAttribute("src"));
      const alt = node.getAttribute("alt") ?? "";
      return href ? `![${alt.replace(/\]/g, "\\]")}](${href})` : alt;
    }
    if (tag === "a") {
      const href = safeLink(node.getAttribute("href")), label = childInline(node).trim();
      if (node.classList?.contains("ltx_ref") || /bib|cite/i.test(href)) counts.citations++;
      return href ? `[${label || href}](${href})` : label;
    }
    if (tag === "sup") return `<sup>${childInline(node)}</sup>`;
    if (tag === "sub") return `<sub>${childInline(node)}</sub>`;
    if (tag === "code") return `\`${textOf(node).replace(/`/g, "\\`")}\``;
    if (["b", "strong"].includes(tag)) return `**${childInline(node).trim()}**`;
    if (["i", "em"].includes(tag)) return `*${childInline(node).trim()}*`;
    if (tag === "table") return table(node);
    if (/ltx_note/.test(node.className ?? "")) counts.footnotes++;
    return childInline(node);
  }
  function table(el: any): string {
    counts.tables++;
    const rows: any[][] = Array.from(el.querySelectorAll("tr")).map((tr: any) => Array.from(tr.children).filter((n: any) => ["th", "td"].includes(tagOf(n))));
    if (!rows.length) return el.outerHTML;
    if (rows.some(row => row.some(cell => Number(cell.getAttribute("colspan") ?? 1) !== 1 || Number(cell.getAttribute("rowspan") ?? 1) !== 1))) {
      warnings.push("spanning_table_preserved_as_html");
      return `\`\`\`html\n${el.outerHTML}\n\`\`\``;
    }
    const width = Math.max(...rows.map(row => row.length));
    const rendered = rows.map(row => Array.from({ length: width }, (_, i) => row[i] ? childInline(row[i]).trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>") : ""));
    const line = (r: string[]) => `| ${r.join(" | ")} |`;
    return [line(rendered[0]), line(Array(width).fill("---")), ...rendered.slice(1).map(line)].join("\n");
  }
  function emit(el: any, text: string, heading?: HtmlBlock["heading"]) {
    const normalized = text.trim();
    if (!normalized) return;
    blocks.push({ id: `html-block-${String(blocks.length + 1).padStart(5, "0")}`, text: normalized, ...(heading ? { heading } : {}), origin: at(el) });
  }
  function list(el: any, depth = 0): string {
    let n = 0;
    return Array.from(el.children).filter((node: any) => tagOf(node) === "li").map((li: any) => {
      const chunks: string[] = [];
      for (const child of li.childNodes) chunks.push(["ul", "ol"].includes(tagOf(child)) ? `\n${list(child, depth + 1)}` : inline(child));
      return `${"  ".repeat(depth)}${tagOf(el) === "ol" ? `${++n}.` : "-"} ${chunks.join("").trim()}`;
    }).join("\n");
  }
  function visit(el: any) {
    const tag = tagOf(el);
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1)), title = childInline(el).trim();
      counts.headings++; emit(el, `${"#".repeat(level)} ${title}`, { level, title }); return;
    }
    if (tag === "p") { counts.paragraphs++; emit(el, childInline(el)); return; }
    if (tag === "table") { emit(el, table(el)); return; }
    if (tag === "figure") {
      counts.figures++; const body: string[] = [];
      for (const child of el.children) body.push(tagOf(child) === "table" ? table(child) : tagOf(child) === "img" ? inline(child) : childInline(child));
      emit(el, body.join("\n\n")); return;
    }
    if (["ul", "ol"].includes(tag)) { emit(el, list(el)); return; }
    if (tag === "pre") { emit(el, `\`\`\`\n${el.textContent}\n\`\`\``); return; }
    if (tag === "math") { emit(el, math(el, true)); return; }
    if (tag === "img") { emit(el, inline(el)); return; }
    if (/\bltx_equation(?:group)?\b/.test(el.className ?? "")) { emit(el, childInline(el)); return; }
    if (["figcaption", "blockquote", "dt", "dd"].includes(tag)) { emit(el, childInline(el)); return; }
    const buffer: string[] = [];
    const flush = () => { if (buffer.length) { emit(el, buffer.join("")); buffer.length = 0; } };
    for (const child of el.childNodes ?? []) {
      if (child.nodeType === 3 || ["span", "a", "strong", "em", "code", "sup", "sub"].includes(tagOf(child))) buffer.push(inline(child));
      else { flush(); visit(child); }
    }
    flush();
  }
  visit(root);
  if (blocks.length < 2) warnings.push("html_sparse_extraction");
  return { title, blocks, assets, counts, warnings: [...new Set(warnings)], template_id: template.id, body_selector: rawSelector };
}
