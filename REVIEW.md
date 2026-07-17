# GIZEM — Review & Pivot Record

Status: Decision record · Date: 2026-07-16 · Companion to `idea.md` v2.0.0, `ArchSpec.md` v2.0.0, `plan.md` v2.0.0

---

## 0. The Pivot (Decision)

**GIZEM v1** — graph as the *source of truth*: code stored in KuzuDB, text as a rendered projection, bidirectional text↔graph sync, graph→`.rs` serializer, Cranelift JIT, custom semantic VCS, LLM containment layers. 12-week plan.

**GIZEM v2 (current)** — graph as a *derived, disposable index* over unchanged text files: MCP retrieval tools + an architectural rule engine ("ArchUnit for AI agents"). Files, Git, and Cargo untouched. 6-week plan.

The pivot was made on 2026-07-16 after (a) an architecture review that found three Phase-0-blocking contradictions and a systemic overconfidence flaw in v1's risk registers, and (b) market research estimating **< 5% success probability** for v1 as scoped.

### 0.1 Follow-on Decisions (2026-07-16)

Two scoping questions raised after the pivot, resolved:

1. **Implementation language — clarified, not changed.** GIZEM is already pure JS/TS (tree-sitter Node bindings, KuzuDB Node bindings, MCP over Node stdio, chokidar). There is no Rust *in the tool*. "Rust" refers only to the **target codebase** v1 indexes.
2. **Target language — Rust retained.** Rust's explicit types + `use` statements make heuristic resolution tractable, which is what makes the `unresolved_ratio ≤ 10%` precision contract (R1) achievable without a full compiler. TS/JS remains the second target (larger market, dogfoodable) but its erased/structural types would force a `tsserver`-grade resolver — deferred, not adopted for v1.
3. **Delivery — reversed to VS Code-extension-first.** ADR-003 previously chose "MCP + CLI, *not* a VS Code-only extension." Revised: the **VS Code extension is now the primary surface** (graph webview + inline rule diagnostics + embedded MCP), because IDE-native viz/diagnostics are the adoption wedge and MCP now has in-editor consumers (Copilot). *This does not reverse the pivot:* the extension is strictly read-only — it never edits code, so it is *not* an "editing surface" under §5.2 and needs no pivot-reversal ADR. The core stays protocol-agnostic and headless-first (MCP + CLI usable with no editor); the honest cost — narrower reach for non-VS Code agents — is tracked as **ArchSpec R10**.

### 0.2 Reuse of a Prior Indexer (2026-07-16)

A prior, fully-implemented and tested VS Code extension by the same author — code
indexing with tree-sitter (12 languages) served over MCP — was folded in as a starting
point. Its source is vendored at [`vendor/reference-indexer/`](vendor/reference-indexer/) with a file-by-file
verdict in [`vendor/reference-indexer/REUSE.md`](vendor/reference-indexer/REUSE.md). Only the code-graph
spine was kept; the original project's own docs, build artifacts, and unrelated
memory subsystem were dropped before vendoring.

- **What GIZEM reuses:** the *code-graph spine* — tree-sitter parser registry + grammars,
  per-language extractors (symbols/edges/complexity), the `CodeStore` contract, the
  two-pass `resolvePending` resolution with `resolved`/`fuzzy` confidence, the MCP stdio
  server, the zod tool contracts, token-budgeting/pagination/freshness-footer rendering,
  the VS Code extension shell, and the `.vsix` build pipeline. This collapses much of
  Phase 0–1 from "build" to "adapt".
- **What GIZEM drops:** the entire memory subsystem (OKF bundle, embeddings, recall,
  lifecycle, `@memory` chat) — the "extra functionality not relevant to this project".
- **Storage decision — KuzuDB retained (evaluated, not defaulted).** The reference project
  runs on `node:sqlite` (zero native bindings) and already ships `findCycles` (Tarjan),
  dead-code, file-deps, and hotspots — every GIZEM Tier-1 rule maps onto SQL, so **SQLite
  would have retired risks R4 (Kuzu bindings) and S2 entirely.** GIZEM nonetheless keeps
  KuzuDB to preserve Cypher as the rule/query language (the raw-Cypher escape hatch and
  the "rules are queries" ergonomics in `idea.md` §0.2/§4). Consequence, recorded honestly:
  R4/S2 stay live, and the Kuzu-backed `CodeStore` + Cypher ports of the analyses are
  net-new work — the reference project's SQLite impl is what to translate from. The proven
  SQLite path is the documented fallback if Kuzu bindings disappoint (ADR-001).
- **Note for scope:** the reference project's parser layer already covers 12 languages. GIZEM keeps
  **Rust-only as the v1 *validation* target** (precision contract, benchmarks), but
  multi-language is now low-cost to switch on post-v1 — the parser/extractor layer is
  language-parameterized, not Rust-specific.

---

## 1. Why v1 Was Abandoned (Market Evidence)

1. **The demand is for a different product.** "Code graph for LLM context" is a validated, growing category — CodexGraph (NAACL 2025), Codebase-Memory (10× token reduction, 66 languages, open source), CodeGraph, GitNexus, Serena. **Every one builds the graph as a read-only index over normal files.** They capture ~80% of v1's value with ~5% of its architecture. v1's differentiator — graph as the medium — is exactly the part the market routed around.
2. **The economic foundation was eroding.** v1's headline was token savings; token prices collapsed through 2025–26 (frontier-class coding at $0.14/M). The $12.8B agent-tooling market is won on capability and workflow, not token thrift. And 70% of engineers stack 2–4 tools — v1's all-or-nothing medium was incompatible with the dominant usage pattern.
3. **Forty years of prior art failed at the same boundary.** JetBrains MPS (20+ years, still DSL-niche), Intentional Software (~15 years, never shipped broadly), Unison ("code in database is too foreign for most teams" after 7 years *with* a working product), SemanticMerge (discontinued even as a Git-compatible add-on). Common cause: **the value never exceeded the cost of leaving text.** v1 inherited all three exit barriers simultaneously.
4. **Technical review compounded it** (§2 below): v1 secretly contained a full Rust frontend it claimed not to need, and its hardest problem (bidirectional sync with concurrent human+LLM edits) is the precise mechanism that killed projectional editors.

## 2. v1 Technical Findings (retained for the record)

The pre-pivot review of v1 found:

- **Systemic flaw:** every risk scored "Eliminated" and every open item "Resolved" before any code existed. *Discipline carried into v2:* no risk is downgraded without a named, passing exit test (ArchSpec v2 §11).
- **C1** — "import real Rust" contradicted "supported subset only" (real projects use generics/traits/macros/async). v1 fix was opaque passthrough; **in v2 this dissolves** — an unsupported construct just contributes fewer edges; the file is never regenerated.
- **C2** — "bit-identical binary" was an impossible exit criterion. **Dissolves in v2** — no serialization, no build path.
- **C3** — `rename_symbol` updated edges but not the body text that named the callee → broken builds. **Dissolves in v2** — renames happen in text as usual; GIZEM re-indexes.
- **R11 (the big one)** — v1 claimed lexing/parsing/name-resolution were "eliminated," yet import, edit-translation, codegen, and refactors all required a full Rust frontend. **In v2 this is embraced, not denied:** the indexer *is* the engine, and its precision (`unresolved_ratio`) is a first-class, published metric (v2 risk R1).
- **R1 (v1's Critical)** — bidirectional text↔graph sync with conflict resolution. **Dissolves in v2** — dataflow is one-directional (files → graph).
- **R15** — LLM containment was soft, not "impossible" as claimed. **Dissolves in v2** — GIZEM has zero write tools; there is nothing to contain.

## 3. What Carried Over from v1

| v1 asset | v2 home |
|----------|---------|
| Graph schema core (Module/Function/Type, CALLS/READS/WRITES/DEPENDS_ON/OWNS) | idea.md §2, now with `file:span` + `resolved` flag |
| Tier-1/2/3 rule taxonomy + Cypher-as-rule insight | The **product centerpiece** (rule engine, §4 of idea.md) |
| Tier-3 analyses (impact, dead code, coupling, fan-out, test gap) | MCP `analyze` tools |
| Louvain module discovery | `module_map` + `gizem init` rule inference |
| KuzuDB choice, single-writer discipline, honest-risk methodology | store spec + this discipline |
| Token-economics framing | Reframed as *measured benchmark* (plan V3), not marketing claim |

Dropped entirely: serializer, JIT/Cranelift, semantic VCS, views/source maps, dummy file tools, containment layers, annotations-as-edges, error/logging-as-edges. Their spec files were deleted; v1 detail survives in git history.

## 4. Current Document Set

| Doc | Role |
|-----|------|
| [`idea.md`](idea.md) | Vision v2: positioning, tools, rules, non-goals |
| [`ArchSpec.md`](ArchSpec.md) | Architecture v2 (arc42): building blocks, ADRs, honest risk register, open items |
| [`plan.md`](plan.md) | 6-week plan, spike-gated, verification criteria V1–V8 |
| [`subsystem_indexer_spec.md`](subsystem_indexer_spec.md) | Parse/resolve/extract pipeline, precision contract |
| [`subsystem_graph_store_spec.md`](subsystem_graph_store_spec.md) | KuzuDB access, single-writer indexing, snapshots |
| [`subsystem_mcp_rules_spec.md`](subsystem_mcp_rules_spec.md) | MCP tool surface, rule engine, CLI/CI outputs |

## 5. Standing Review Discipline

1. A risk leaves the register only when its named exit test passes in CI.
2. Any proposal to add a write tool, a serialization path, or an *editing* surface is a pivot-reversal and requires a new ADR arguing against §1 of this document. Read-only surfaces (the VS Code extension's viz + diagnostics) are not editing surfaces and are permitted — the moment a surface mutates source, this clause fires.
3. Precision numbers (`unresolved_ratio`, rule false-positive counts) are published with every release; claims without numbers don't ship.
