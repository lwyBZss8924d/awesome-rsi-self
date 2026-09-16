# Awesome RSI Self

A source-grounded knowledge workspace for recursive self-improvement of agent
skills, tools, context and execution harnesses. Public knowledge is portable OKF
Markdown. Agent navigation uses llms.txt and structured manifests. Private RAW,
model trajectories, local configuration and run artifacts stay outside publication.

## Use

Requires Bun 1.3.14 or later. Dependencies are locked; the aicatlog SDK is vendored
as a pinned package, with no global install or background service.

```sh
bun install --frozen-lockfile
bun run cli -- kb sources --json
bun run cli -- kb fetch arxiv-2607.13104-v1 --json
bun run cli -- kb prepare arxiv-2607.13104-v1 --json
bun run cli -- kb inspect arxiv-2607.13104-v1 --json
bun run cli -- kb lint --json
bun run cli -- kb build --json
bun run check
```

Use `--help`, `--schema --json`, `--format toon`, `--filter-output`, and
`--full-output` to discover bounded interfaces. The same commands are available
through `createKnowledgeApi(root).call(name, input)`. Build exports OpenAPI through
an in-process Fetch adapter; it does not start a server or provide MCP.

## Source, context and knowledge

* `sources/source-manifest.json` owns versioned public source identities.
* `.local/raw/` preserves downloaded HTML and TeX archives with content hashes.
* `.local/prepared/` contains faithful text, llms.txt navigation and source maps.
* `wiki/` contains authored OKF reference, concept, pattern and comparison pages.
* `workflows/` describes source-bound contributions and the finite daily run.

Registration, extraction, reading, verification, publication and adoption are
separate observations. Drafts remain drafts until their contents are independently
checked. Source material does not acquire authority to execute code or change the
repository harness.

The daily workflow incrementally reads its upstream resource list and research
feeds, preserves RAW, compiles and validates a candidate Wiki, and may publish to
the explicitly configured repository. Each phase records its actual outcome.

See [Agent navigation](llms.txt) and [Knowledge overview](wiki/index.md).

Curated knowledge projections contain the Wiki, context navigation and workflow
contracts, not the executable toolchain or active repository AGENTS instructions.
Run the CLI from this source repository when using a projected knowledge copy.
The optional development harness link points back to the public source owner.
