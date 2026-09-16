#!/usr/bin/env python3
"""Bounded, non-executing arXiv source archive extraction and TeX context inspection.

No TeX engine, package install, shell invocation, or archive-supplied code executes.
The original archive remains the authority; this helper preserves source bytes.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath


class SourceError(Exception):
    pass


def safe_name(value):
    if not value or len(value) > 1024 or "\\" in value or "\x00" in value:
        raise SourceError("unsafe_archive_path")
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise SourceError("unsafe_archive_path")
    while value.startswith("./"):
        value = value[2:]
    parts = PurePosixPath(value).parts
    if not parts or any(p in ("..", "") for p in parts):
        raise SourceError("unsafe_archive_path")
    return str(PurePosixPath(*parts))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("latin-1"), "latin-1"


def uncomment(line):
    for m in re.finditer("%", line):
        pos = m.start() - 1
        escapes = 0
        while pos >= 0 and line[pos] == "\\":
            escapes += 1
            pos -= 1
        if escapes % 2 == 0:
            return line[:m.start()]
    return line


def read_bounded(stream, limit, label):
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise SourceError(label)
    return data


def source_payload(raw, max_expanded):
    prefix = ""
    if raw.startswith(b"\x1f\x8b"):
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                raw = read_bounded(stream, max_expanded, "expanded_size_limit")
            prefix = "gzip-"
        except (OSError, EOFError) as exc:
            raise SourceError("invalid_gzip") from exc
    if len(raw) > max_expanded:
        raise SourceError("expanded_size_limit")
    return raw, prefix


def extract(raw_path, destination, limits):
    raw_file = Path(raw_path)
    if raw_file.stat().st_size > limits["max_input_bytes"]:
        raise SourceError("input_size_limit")
    raw = raw_file.read_bytes()
    unpacked, prefix = source_payload(raw, limits["max_expanded_bytes"])
    files = []
    seen = set()
    total = 0
    try:
        archive = tarfile.open(fileobj=io.BytesIO(unpacked), mode="r:")
    except tarfile.ReadError:
        archive = None
    if archive is None:
        text, _ = decode(unpacked)
        if re.search(r"<(?:!doctype\s+html|html|body)\b", text[:1000], re.I):
            raise SourceError("html_is_not_tex")
        if not re.search(r"\\(?:documentclass|begin\s*\{document\}|input|newcommand|def)\b", text):
            raise SourceError("unsupported_source_payload")
        entries = [("main.tex", unpacked)]
        archive_format = prefix + "tex"
    else:
        entries = []
        with archive:
            for index, member in enumerate(archive):
                if index >= limits["max_files"]:
                    raise SourceError("archive_file_count_limit")
                if member.name in (".", "./") and member.isdir():
                    continue
                name = safe_name(member.name)
                if name in seen:
                    raise SourceError("duplicate_archive_path")
                seen.add(name)
                if member.isdir():
                    continue
                if not member.isfile() or member.sparse is not None:
                    raise SourceError("archive_links_or_special_files")
                if member.size < 0 or member.size > limits["max_file_bytes"]:
                    raise SourceError("archive_file_size_limit")
                total += member.size
                if total > limits["max_expanded_bytes"]:
                    raise SourceError("expanded_size_limit")
                stream = archive.extractfile(member)
                if stream is None:
                    raise SourceError("archive_missing_member_data")
                data = read_bounded(stream, limits["max_file_bytes"], "archive_file_size_limit")
                if len(data) != member.size:
                    raise SourceError("archive_member_size_mismatch")
                entries.append((name, data))
        archive_format = prefix + "tar"
    if not entries:
        raise SourceError("empty_source_archive")
    if len(entries) > limits["max_files"]:
        raise SourceError("archive_file_count_limit")
    regular_names = {name for name, _ in entries}
    for name, _ in entries:
        if any(str(parent) in regular_names for parent in PurePosixPath(name).parents if str(parent) != "."):
            raise SourceError("archive_path_collision")
    dest = Path(destination)
    if dest.exists():
        if dest.is_symlink() or any(dest.iterdir()):
            raise SourceError("destination_not_empty")
    else:
        dest.mkdir(parents=True)
    # The application validates its owned root before invoking this helper. The
    # OS may expose that root through /var or /tmp symlinks; archive members have
    # no authority to select or add a parent. The selected directory itself must
    # be fresh/empty and not a symlink, and all members were validated above.
    if dest.is_symlink():
        raise SourceError("symlink_destination")
    # Validate every member before writing any file. Creation is exclusive.
    for name, data in entries:
        if len(data) > limits["max_file_bytes"]:
            raise SourceError("archive_file_size_limit")
        target = dest / safe_name(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("xb") as output:
                output.write(data)
        except (FileExistsError, IsADirectoryError, NotADirectoryError) as exc:
            raise SourceError("archive_path_collision") from exc
        os.chmod(target, 0o600)
        files.append({"file": name, "sha256": digest(data), "bytes": len(data)})
    return archive_format, files


def inspect_tex(dest, files):
    source_suffixes = {".tex", ".sty", ".cls", ".bib", ".bbl", ".ltx"}
    known = {item["file"] for item in files}
    texts = {}
    encoded = {}
    warnings = []
    main_candidates = []
    include_edges = []
    missing_includes = []
    dynamic_includes = []
    macros = []
    constructs = []
    for item in files:
        name = item["file"]
        if Path(name).suffix.lower() not in source_suffixes:
            continue
        text, encoding = decode((dest / name).read_bytes())
        texts[name] = text
        encoded[name] = encoding
        if encoding != "utf-8":
            warnings.append("source_encoding_fallback:" + name)
        stripped = "\n".join(uncomment(line) for line in text.splitlines())
        if re.search(r"\\documentclass(?:\[.*?\])?\s*\{", stripped) or re.search(r"\\begin\s*\{document\}", stripped):
            main_candidates.append(name)
        for m in re.finditer(r"\\(input|include|subfile)\b\s*(?:\{([^}]+)\}|([^\s{}%]+))", stripped):
            ref = (m.group(2) or m.group(3)).strip()
            line = stripped[:m.start()].count("\n") + 1
            edge = {"from": name, "command": m.group(1), "argument": ref, "line": line}
            if any(c in ref for c in ("\\", "#", "|", "$")):
                dynamic_includes.append(edge)
                continue
            candidates = [str(PurePosixPath(name).parent / ref), ref]
            candidates += [p + ".tex" for p in candidates if not PurePosixPath(p).suffix]
            valid = []
            for p in candidates:
                try:
                    valid.append(safe_name(p))
                except SourceError:
                    continue
            target = next((p for p in valid if p in known), None)
            if target:
                include_edges.append({**edge, "to": target})
            else:
                missing_includes.append(edge)
        original_lines = text.splitlines()
        for index, line_text in enumerate(original_lines):
            clean = uncomment(line_text)
            if re.search(r"\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator|def|gdef|edef|xdef|newenvironment|renewenvironment)\b", clean):
                end = index
                balance = clean.count("{") - clean.count("}")
                while balance > 0 and end + 1 < len(original_lines) and end - index < 100:
                    end += 1
                    next_line = uncomment(original_lines[end])
                    balance += next_line.count("{") - next_line.count("}")
                macros.append({"file": name, "start_line": index + 1, "end_line": end + 1, "balanced": balance == 0, "text": "\n".join(original_lines[index:end + 1])})
            for match in re.finditer(r"\\(?:write18|csname|catcode|openout|read|directlua)\b", clean):
                constructs.append({"file": name, "line": index + 1, "construct": match.group(), "handling": "preserved_not_executed"})
    if not texts:
        warnings.append("no_tex_text_files")
    selected = main_candidates[0] if len(main_candidates) == 1 else None
    if not selected:
        warnings.append("ambiguous_main_file" if main_candidates else "main_file_not_found")
    if missing_includes:
        warnings.append("missing_includes")
    for edge in dynamic_includes:
        definition = next((m for m in macros if m["file"] == edge["from"] and m["start_line"] <= edge["line"] <= m["end_line"]), None)
        edge["definition_context"] = definition is not None
    active_dynamic = [edge for edge in dynamic_includes if not edge["definition_context"]]
    if active_dynamic:
        warnings.append("dynamic_includes_not_expanded")
    graph = {}
    for edge in include_edges:
        graph.setdefault(edge["from"], []).append(edge["to"])
    visited, stack, cycles = set(), [], []
    def walk(node):
        if node in stack:
            cycles.append(stack[stack.index(node):] + [node])
            return
        if node in visited:
            return
        visited.add(node)
        stack.append(node)
        for nxt in graph.get(node, []):
            walk(nxt)
        stack.pop()
    for name in sorted(texts):
        walk(name)
    if cycles:
        warnings.append("include_cycles")
    return {
        "text_files": [{"file": name, "encoding": encoded[name], "lines": len(text.splitlines())} for name, text in sorted(texts.items())],
        "main_candidates": sorted(main_candidates), "selected_main": selected,
        "include_edges": include_edges, "missing_includes": missing_includes,
        "dynamic_includes": dynamic_includes, "active_dynamic_includes": active_dynamic, "include_cycles": cycles,
        "macros": macros, "unresolved_constructs": constructs,
        "macro_expansion": "not_performed", "source_execution": "not_performed",
        "warnings": sorted(set(warnings)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("destination")
    parser.add_argument("--max-input-bytes", type=int, default=32 * 1024 * 1024)
    parser.add_argument("--max-expanded-bytes", type=int, default=96 * 1024 * 1024)
    parser.add_argument("--max-file-bytes", type=int, default=32 * 1024 * 1024)
    parser.add_argument("--max-files", type=int, default=4096)
    args = parser.parse_args()
    limits = {key: getattr(args, key) for key in ("max_input_bytes", "max_expanded_bytes", "max_file_bytes", "max_files")}
    if any(value <= 0 for value in limits.values()):
        parser.error("limits must be positive")
    try:
        fmt, files = extract(args.archive, args.destination, limits)
        result = {"schema_version": "rsi.tex-inspection.v1", "status": "extracted", "archive_format": fmt, "files": files, "limits": limits, **inspect_tex(Path(args.destination), files)}
        print(json.dumps(result, ensure_ascii=False))
    except (SourceError, tarfile.TarError, EOFError, OSError, RecursionError) as exc:
        print(json.dumps({"schema_version": "rsi.tex-inspection.v1", "status": "unavailable", "error": str(exc)[:500]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
