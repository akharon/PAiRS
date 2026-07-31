# Reference Indexer — Reuse Map

`vendor/reference-indexer/` is source lifted from a prior, fully-implemented and tested
multi-language code-indexing VS Code extension (private prior work by the same author).
That project also had an unrelated episodic-memory subsystem — dropped here entirely, it
is out of scope for PAiRS.

- **Date vendored:** 2026-07-16.
- **Not a dependency.** This is a reference/starting-point tree, not an npm package PAiRS
  imports. Files are lifted and adapted into PAiRS's own `src/` during Phase 0.
- **Storage:** the source project used `node:sqlite`. PAiRS keeps **KuzuDB** (see
  `REVIEW.md` §0.2) — the storage-*agnostic* layers here are reused directly; the SQLite
  store (`codeStore.ts` interface + `codeStoreImpl.ts`) is the **reference model** PAiRS's
  Kuzu store implements the same contract against (translate SQL → Cypher). Because the
  interface is preserved, the SQLite impl is a documented drop-in fallback if Kuzu
  bindings disappoint (R4).
- **What was already stripped from this tree** before vendoring: the memory/OKF bundle
  (`src/okf/`), embeddings/recall/lifecycle (`src/intelligence/`), the memory SQLite store
  and its MCP tool executor, the `@memory` chat participant, and all project-specific
  docs/README/lockfile/build output. Only the code-graph spine remains below.

## What remains, and its PAiRS home

| Path | Verdict | PAiRS home / note |
|---|---|---|
| `src/index/parserRegistry(Impl).ts` | Reuse as-is | tree-sitter WASM grammar loading → `core/indexer` |
| `src/index/extractors.ts`, `extractorImpl.ts` | Reuse as-is | symbol/edge/complexity extraction per language → `core/indexer`; produces `FileExtraction`, which PAiRS's Kuzu schema maps from |
| `src/index/queries/*.scm` | Reuse as-is | tree-sitter capture queries, 12 languages |
| `src/index/types.ts` | Reuse as-is | data model: `FileExtraction`, `SymbolRecord`, `EdgeRecord`, `CodeLang`, confidence/kind enums |
| `src/index/codeStore.ts` (interface) | Reuse as contract | PAiRS's Kuzu store implements this `CodeStore` interface |
| `src/index/codeStoreImpl.ts` (SQLite) | Reference only | source of truth for `resolvePending`, `findCycles` (Tarjan SCC), `unreferenced`, `fileEdges`, `hotspots`, `untested` — translate SQL → Cypher |
| `src/index/codeIndexer(Impl).ts` | Reuse / adapt | orchestration (diff → parse → applyExtraction → resolvePending); storage-agnostic behind `CodeStore` |
| `src/index/headlessIndexer.ts`, `nodeFsDeps.ts`, `gitOps.ts`, `provenance(Impl).ts` | Reuse as-is | fs/git/provenance utilities |
| `src/index/codeSearch(Impl).ts` | Adapt | BM25 fusion ranking; FTS is SQLite-specific → needs Kuzu FTS or a separate index. Fusion weights are a good reference |
| `src/mcp/tools.ts` | Reuse as-is | zod tool contracts — PAiRS's MCP surface |
| `src/mcp/codeToolExecutor.ts`, `createExecutors.ts`, `renderShared.ts` | Reuse / adapt | dispatch + rendering: token budgeting, pagination, confidence markers, index-freshness footer; calls `CodeStore`/`CodeSearch` |
| `src/mcp/server.ts`, `serverCli.ts`, `daemon/`, `*Entry.ts` | Reuse as-is | stdio MCP transport, daemon/proxy |
| `src/integration/{mcpProvider,lmTools,commands,ui,surfaces,codeResults,deadCodeActions}.ts` | Reuse / adapt | the VS Code extension shell — PAiRS's primary (extension-first) surface |
| `src/core/logger.ts`, `tokens.ts` | Reuse as-is | generic utilities |
| `esbuild.mjs` | Reuse / adapt | multi-bundle (extension + MCP server/daemon/proxy/desktop entries); already solves the `web-tree-sitter` `import.meta.url` CJS shim. **Change:** add `kuzu` to `external` (native addon, must not be bundled) |
| `scripts/fetch-grammars.mjs` | Reuse as-is | copies prebuilt tree-sitter wasm from the `tree-sitter-wasms` devDep (no native build) + `.scm` queries → `dist/`. Trim the `GRAMMARS` map to shipped langs (Rust first) |
| `scripts/sync-lm-tools.mjs` | Reuse / adapt | generates package.json `languageModelTools` from `tools.ts` zod schemas (single source of truth, no drift between MCP + VS Code LM) |
| `scripts/build-full.sh` | Reuse / adapt | Node≥22 guard + nvm autoselect + install→typecheck→test→build→package |
| `scripts/bump-version.sh` | Reuse / adapt | git-SHA-driven minor bump (forces reindex on reinstall); state dir → `.pairs/` |
| `scripts/package-mcpb.sh` | Reuse / adapt | Claude Desktop `.mcpb` delivery (bundled headless MCP server) — a bonus delivery channel |
| `scripts/package.sh` | Adapt — new work | `.vsix` packaging. **New:** must bundle the platform-specific KuzuDB native binary per `.vsix` (win/mac/linux) — direct amplifier of **R4** |
| `assets/icon.svg` | Reuse as-is | generic single-color brain glyph, no branding; VS Code activity bar recolors it |
| `LICENSE` | Reuse verbatim | MIT, © 2026 Mustafa Kayır — same author as PAiRS, no relicensing needed |
| `THIRD_PARTY_NOTICES.md` | Reuse as template — trim | **Remove** the LGPL-3.0 (`sharp`/libvips) section and `@huggingface/transformers`/`onnxruntime` entries — PAiRS has no embeddings, so it sheds the LGPL obligation. **Keep:** `web-tree-sitter`, `tree-sitter-wasms`, `@modelcontextprotocol/sdk`, `zod` (all MIT). **Add:** `kuzu` (MIT). Re-run `npx license-checker --production` after deps settle |

## Tests (inherit with the code)

| Path | Verdict | Note |
|---|---|---|
| `src/index/pipeline.test.ts` | Inherit — adapt | parse→extract→store pipeline; the model for PAiRS's golden-corpus test (plan 0.6). Re-point the store at Kuzu or a `CodeStore` fake |
| `src/index/codeIndexerImpl.test.ts` | Inherit — adapt | indexer orchestration; store-fake or Kuzu |
| `src/index/types.test.ts`, `provenanceImpl.test.ts` | Inherit as-is | data model + provenance util, storage-agnostic |
| `src/mcp/renderShared.test.ts` | Inherit as-is | token-budget / pagination / freshness rendering — storage-agnostic |
| `src/mcp/codeToolExecutor.test.ts` | Inherit — adapt | code-tool dispatch/rendering; store-fake |
| `src/mcp/daemon/*.test.ts` | Inherit if daemon infra kept | multi-workspace MCP server plumbing, storage-agnostic |

`vitest.config.ts` was not carried over (trivial to recreate against PAiRS's own package.json); reproduce its one meaningful setting — excluding `**/*.integration.test.ts` — if/when an integration suite exists.

## What PAiRS still has to build (net-new, not present here)

1. **Kuzu-backed `CodeStore`** — implements the reused interface with Cypher; atomic
   file-subgraph replace, read snapshots (`subsystem_graph_store_spec.md`).
2. **Rule engine** — Layering / ForbiddenDep / MaxFanOut / VisibilityBoundary as
   Cypher (NoCycles already exists as Tarjan in `codeStoreImpl`; port or express in
   Cypher), `.pairs/rules.ron` config, mandatory `explain`, baseline/ratchet
   (`subsystem_mcp_rules_spec.md`). **This is the differentiator the reference project
   does not have.**
3. **`check_rules` / `explain_rule` / `list_rules` MCP tools** + agent-hook recipes.
4. **`pairs init`** rule inference (Louvain + structure) — no rule inference existed.
5. **VS Code inline rule diagnostics** (Diagnostics API) — the reference project surfaces
   code search, not architectural violations.
