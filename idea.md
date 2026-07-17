# GIZEM — Design Document

**Architectural guardrails and a code-graph context engine for AI coding agents.**

Version: 2.0.0 · Status: **Pivoted** — see [`REVIEW.md`](REVIEW.md) §0 for the pivot record

> **📋 See also:** [`plan.md`](plan.md) — MVP Development Plan · [`ArchSpec.md`](ArchSpec.md) — Architecture Specification (arc42, includes the full document hierarchy) · [`REVIEW.md`](REVIEW.md) — Review & pivot rationale

---

## 0. Vision

AI coding agents (Claude Code, Cursor, Copilot) are powerful editors but **architecture-blind**. They answer "what depends on X?" by grepping and reading files — slow, token-expensive, and approximate. Worse, nothing stops an agent from quietly violating the architecture: adding a UI→database dependency, creating a module cycle, calling internals across a layer boundary. Humans catch these in review, sometimes.

GIZEM gives agents two things text files cannot:

1. **A queryable code graph** — a continuously maintained, derived index of the codebase (functions, types, modules, calls, reads/writes, dependencies) in an embedded graph database. One Cypher-backed tool call replaces reading ten files.
2. **Enforceable architectural rules** — layering, dependency direction, cycle bans, and project-specific design rules expressed as graph queries, checked after every agent edit and in CI. **ArchUnit for the agent era.**

### 0.1 What GIZEM is NOT (the pivot)

GIZEM v1 (see `REVIEW.md` and git history) proposed making the graph the *source of truth*: code stored in KuzuDB, text as a projection, custom semantic VCS, graph-to-`.rs` serialization, JIT compilation. Market research and 40 years of structured-editing history (MPS, Intentional, Unison, SemanticMerge) showed that paradigm has high failure probability: the value never exceeds the cost of leaving text.

**v2 inverts the dependency:**

| | v1 (abandoned) | v2 (this document) |
|---|---|---|
| Source of truth | Graph (KuzuDB) | **Text files, unchanged** |
| Graph role | The medium | **Derived, disposable index** |
| VCS | Custom semantic VCS | **Git, unchanged** |
| Build | Graph→`.rs` serializer + JIT | **Cargo, unchanged** |
| Editing | Graph ops / views | **Any editor/agent, unchanged** |
| Distribution | VS Code extension as *editor* (all-in projectional) | **VS Code extension as *companion*** — bundles the MCP server + CLI; visualizes and diagnoses, never edits |
| Sync problem | Bidirectional text↔graph (R1, Critical) | **One-directional: files → graph. Trivially safe.** |

Everything the developer and agent already do stays the same. GIZEM is additive: an index and a gate.

### 0.2 Core Principles

1. **Files are the source of truth.** The graph is derived, rebuildable from scratch at any time, and never written back to source. Deleting `.gizem/` loses nothing.
2. **IDE-native, MCP-backed.** The primary surface is a **VS Code extension** — graph visualization, inline rule diagnostics, and in-editor agent tools. The same core is exposed over MCP (Model Context Protocol), *bundled inside the extension*, so in-editor agents (Copilot) and — via the packaged stdio server — external agents (Claude Code, Cursor) reach the identical tools. A CLI covers CI. The core is protocol-agnostic; the extension is a thin adapter, so the MCP server and CLI stay usable headless.
3. **Rules are queries.** An architectural rule is one Cypher query over the graph, not 100 lines of AST-walking lint code. Rules are invariant under renames, formatting, and file moves.
4. **Check, don't gate writes.** GIZEM never blocks an edit mid-flight. It checks the graph after re-index and reports violations — to the agent (so it self-corrects in the same session), to the developer (diagnostics), and to CI (hard gate).
5. **Fresh or honest.** Every query answer carries an index freshness marker. A stale answer says so.

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Developer's existing workflow (UNCHANGED)                   │
│  editor / AI agent  ──edits──▶  source files  ──▶ git, cargo │
└───────────────┬──────────────────────┬───────────────────────┘
                │ tool calls           │ file change events
                ▼                      ▼
┌──────────────────────────────────────────────────────────────┐
│  VS Code EXTENSION (primary surface, Node extension host)    │
│  · module-graph webview · inline rule diagnostics (squiggles)│
│  · status bar: index_age / unresolved_ratio · commands       │
│  · embeds & spawns the MCP server (in-editor + external)     │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  GIZEM core (also headless: `gizem` CLI, stdio MCP)      ││
│  │  ┌────────────┐  ┌──────────────┐  ┌───────────────────┐ ││
│  │  │ MCP Server │  │  Indexer     │  │  Rule Engine      │ ││
│  │  │ query_graph│  │ parse (tree- │  │ .gizem/rules.ron  │ ││
│  │  │ analyze    │  │  sitter/syn) │  │ layering, cycles, │ ││
│  │  │ find_symbol│  │ resolve      │  │ custom Cypher     │ ││
│  │  │ impact     │  │ extract edges│  │                   │ ││
│  │  │ check_rules│  │ incremental  │  │ outputs: agent,   │ ││
│  │  │ get_symbol │  │ (hash/watch) │  │ IDE, CLI, CI,SARIF│ ││
│  │  └─────┬──────┘  └──────┬───────┘  └────────┬──────────┘ ││
│  │        └───────┬────────┴───────────────────┘            ││
│  │                ▼                                          ││
│  │  ┌────────────────────────────────────────────────────┐ ││
│  │  │  KuzuDB (embedded, derived index — safe to delete) │ ││
│  │  │  Functions · Types · Modules · CALLS · READS/WRITES│ ││
│  │  │  DEPENDS_ON · OWNS · IMPLEMENTS · index metadata    │ ││
│  │  └────────────────────────────────────────────────────┘ ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
        Headless (no VS Code): `npx gizem mcp` for external
        agents · `gizem check --ci` for CI — same core.
```

Three consumers of the same graph:

- **The agent** (via MCP, in-editor or external): context retrieval and self-checking.
- **The developer** (via the VS Code extension — graph viz + inline diagnostics): architecture visibility.
- **CI** (via `gizem check --ci`, no editor required): the hard gate.

---

## 2. Code Graph Schema (Derived)

### 2.1 Node Labels

| Label | Description | Key Properties |
|-------|-------------|---------------|
| `Module` | Namespace / crate module | `path: string`, `crate: string`, `layer: string?` |
| `Function` | Callable unit | `name`, `visibility`, `file`, `span`, `sig_hash` |
| `Type` | Struct / enum / trait | `name`, `kind`, `visibility`, `file`, `span` |
| `Param` | Function parameter | `name`, `index` |
| `File` | Source file (index bookkeeping) | `path`, `content_hash`, `indexed_at` |

Every symbol node carries `file` + `span` — answers are always **citable locations** the agent can jump to, never just names.

### 2.2 Edge Kinds

| Edge | From → To | Meaning |
|------|-----------|---------|
| `OWNS` | Module → Function/Type | Containment |
| `DECLARES` | File → Function/Type | Where it lives on disk |
| `CALLS` | Function → Function | Direct call (resolved where possible) |
| `READS` / `WRITES` | Function → Type | Field/static access |
| `DEPENDS_ON` | Function/Module → Type/Module | Type or module reference |
| `PARAM` / `OF_TYPE` / `RETURNS` | signature edges | Signature structure |
| `IMPLEMENTS` | Type → Type (trait) | Trait impl |
| `TESTED_BY` | Function → Function | Test coverage linkage (heuristic: `#[test]` fns calling it) |

**Resolution honesty:** an unresolved call (macro-generated, dynamic dispatch, cross-crate without metadata) is stored as `CALLS {resolved: false, name}`. Queries can include or exclude unresolved edges; rule results distinguish "violation" from "possible violation." This replaces v1's impossible 100%-fidelity requirement — a retrieval index can be ~95% precise and still be 10× better than grep.

### 2.3 What Got Simpler vs. v1

Because the graph is derived and read-only, entire problem classes from the v1 review disappear:

- **No round-trip idempotence** (old R14) — we never render the graph back to text.
- **No opaque passthrough** (old C1) — an unsupported construct simply contributes fewer edges; the file is untouched.
- **No rename body-rewriting** (old C3) — renames happen in text via the agent/LSP as usual; GIZEM just re-indexes.
- **No text↔graph conflict resolution** (old R1, the Critical risk) — sync is one-directional.

---

## 3. Agent Interface — MCP Tools

### 3.1 Retrieval Tools (the token-savings pillar)

| Tool | Parameters | Returns | Replaces |
|------|-----------|---------|----------|
| `find_symbol` | `name_fragment, kind?` | matches with `{id, name, kind, module, file:span}` | grep + guessing |
| `get_symbol` | `id \| name` | signature, doc, edges in/out, file:span | opening the file |
| `query_graph` | `question` (NL → Cypher) or raw Cypher | nodes/edges with locations | reading 5–10 files |
| `analyze` | `kind: impact \| dead_code \| coupling \| fan_out \| test_gap \| cycles` | structured result + locations | manual audit |
| `impact` | `id, depth?` | transitive dependents with paths | "what breaks if I change this?" |
| `module_map` | `granularity?` | module graph + Louvain clusters + drift notes | reading the whole tree |

Every response includes `{index_age_ms, unresolved_ratio}` so the agent knows answer quality.

**Token economics (measured target, not marketing):** a dependency question answered by `impact` costs ~30–100 tokens vs. ~2,000+ for multi-file reading. [Codebase-Memory](https://arxiv.org/html/2603.27277v1) demonstrated 10× token reduction with this architecture — GIZEM's retrieval pillar is validated externally; our benchmark (plan.md RS1) confirms it on our own tooling.

### 3.2 Guardrail Tools (the differentiator)

| Tool | Parameters | Returns |
|------|-----------|---------|
| `check_rules` | `scope?: changed \| all`, `tier?` | violations `{rule, severity, nodes, locations, explanation, suggestion}` |
| `explain_rule` | `rule_id` | why the rule exists, examples, how to fix |
| `list_rules` | — | active ruleset with tiers |

**The agent loop this enables** (the core product moment):

```
Agent edits src/ui/panel.rs adding `use crate::db::pool;`
  → GIZEM re-indexes the file (< 100 ms)
  → agent calls check_rules(scope: changed)
  → violation: "layering: ui (layer 3) may not depend on db (layer 1).
     ui→db edge at src/ui/panel.rs:14. Route through services (layer 2)."
  → agent fixes it in the same session, before the human ever sees the PR
```

An agent hook (Claude Code hooks / Cursor rules) can run `check_rules` automatically after every edit — GIZEM supplies ready-made hook configs.

### 3.3 No Write Tools

GIZEM exposes **zero** tools that modify source code. The agent's existing file tools do the writing. This is deliberate: it removes the entire v1 containment problem (old R15) and makes GIZEM safe to add to any workflow.

---

## 4. Rule System

### 4.1 Rule Tiers

| Tier | Nature | Severity | Runs |
|------|--------|----------|------|
| **1 — Architectural constraints** | Layering, dependency direction, module-cycle ban, forbidden imports | error | on re-index, `gizem check`, CI |
| **2 — Design rules** | Project-specific: max fan-out, interface segregation, "detectors never write to X", naming/ownership conventions | warning (configurable) | same |
| **3 — On-demand analysis** | Dead code, coupling hotspots, test gaps, deepest chains | informational | when invoked |

### 4.2 Rule Definition (`.gizem/rules.ron`, checked into git)

```ron
(
  layers: { "core": 1, "services": 2, "ui": 3, "db": 1 },
  rules: [
    (id: "no-skip-layer",
     tier: 1,
     kind: Layering(direction: DownOnly, max_skip: 0),
     explain: "UI talks to services, services to core/db. See docs/arch.md §2."),

    (id: "no-module-cycles",
     tier: 1,
     kind: NoCycles(edge: "DEPENDS_ON", scope: Module)),

    (id: "detectors-pure",
     tier: 2,
     kind: Cypher("MATCH (f:Function)<-[:OWNS]-(:Module {path:'rules::detectors'})
                   WHERE EXISTS { (f)-[:WRITES]->(:Type) WHERE NOT t.name = 'ViolationEvent' }
                   RETURN f"),
     explain: "Detectors may only emit ViolationEvent; all other state is read-only."),
  ],
)
```

Built-in rule kinds (`Layering`, `NoCycles`, `MaxFanOut`, `ForbiddenDep`, `VisibilityBoundary`) cover the common 80%; raw Cypher covers the rest. Every rule requires an `explain` — the agent receives it verbatim, which is what makes violations *self-correcting* rather than just red CI.

### 4.3 Outputs

- **MCP**: structured violations to the agent (§3.2).
- **CLI**: `gizem check` — human-readable; `--format sarif` for GitHub code scanning; exit code for pre-commit hooks.
- **CI**: `gizem check --ci --baseline` — fails only on *new* violations (baseline file allows incremental adoption on legacy codebases; the ratchet pattern).

---

## 5. Indexer

The graph is produced by an incremental indexer (fully specified in [`subsystem_indexer_spec.md`](subsystem_indexer_spec.md)), **adapted from a proven, tested multi-language indexer** (a prior project by the same author, vendored at [`vendor/reference-indexer/`](vendor/reference-indexer/) — see [`REVIEW.md`](REVIEW.md) §0.2):

- **Parse:** tree-sitter grammars — the reused parser layer already ships 12 languages; v1 *validates* on Rust with a Rust-aware resolution layer. `syn`-based deep resolution is a post-MVP precision upgrade, evaluated against measured `unresolved_ratio`.
- **Two-pass:** (1) declare all symbols, (2) resolve references and extract edges.
- **Incremental:** file watcher + content hashes; a saved file re-indexes in < 100 ms; only that file's `DECLARES` subgraph is replaced.
- **Honest resolution:** unresolvable references stored with `resolved: false`, counted in `unresolved_ratio`.

The v1 review's biggest finding (R11: "GIZEM has a full Rust frontend at its center and denies it") is now embraced: the indexer *is* the product's engine, it is named, owned, and its precision is a tracked metric instead of an assumed 100%.

---

## 6. Positioning & Competition

| Competitor | What they have | GIZEM's differentiation |
|------------|---------------|------------------------|
| Codebase-Memory, CodeGraph, CodexGraph-style tools | Read-only code graph via MCP, token savings | **Rules/guardrails** — none of them enforce architecture; retrieval alone is commoditizing |
| ArchUnit / archunit-style linters | Architectural tests | JVM/test-suite bound, human-oriented, no agent feedback loop, no graph queries |
| Serena / LSP-wrapper MCP tools | Precise symbol navigation | No architectural layer, no cross-cutting rules, no module analytics |
| rust-analyzer / LSP | Precise single-symbol answers | No whole-graph queries ("all cycles", "layer violations"), no rule engine, not agent-consumable as policy |

**The wedge:** teams adopting AI agents at scale are discovering that agents erode architecture faster than humans review. GIZEM is the missing control loop. Retrieval tools get GIZEM installed; the rule engine makes it indispensable.

**Go-to-market:** open-source **VS Code Marketplace extension** (bundling the MCP server + CLI) as the front door — discoverability and one-click install where developers already are — Rust first (design-partner-friendly), TypeScript second (market size). The headless MCP server + CLI cover external agents (Claude Code, Cursor) and CI. Revenue path (post-MVP, out of scope here): team dashboard, org-wide rule packs, PR-bot.

---

## 7. Explicit Non-Goals

- **No source-of-truth graph.** Files win, always. (The v1 pivot.)
- **No write tools.** GIZEM never edits code.
- **No custom VCS, no serializer, no compiler, no JIT.** Git and Cargo are untouched.
- **No projectional editing / views-as-documents.** The VS Code extension — now the *primary* surface — visualizes and diagnoses; it never edits code. (The v1 non-goal that matters *more* now that the IDE is the front door.)
- **No 100% resolution guarantee.** Precision is measured and reported, not promised.
- **No multi-language in v1.** Rust first; the schema and tree-sitter choice keep the door open.
- **No server/SaaS in v1.** Local-only, like the toolchain it sits beside.

---

## 8. Risks (Summary — full register in ArchSpec §11)

| Risk | Score | Mitigation |
|------|-------|-----------|
| Resolution precision too low for rules (false positives erode trust) | **High** | `unresolved_ratio` metric, "possible violation" class, baseline/ratchet mode, syn upgrade path |
| Retrieval-only competitors add rules first | **Medium** | Rules are the MVP centerpiece, not a later phase; ship in week 4 |
| MCP spec churn | **Low-Medium** | Thin protocol adapter; CLI shares the same core |
| KuzuDB Node bindings | **Medium** | Index is disposable — worst case is re-index, never data loss; SQLite fallback is feasible |
| Nobody writes rules (empty-config problem) | **Medium** | `gizem init` infers layers from module structure + Louvain and proposes a starter ruleset |
| VS Code-first delivery narrows reach for non-VS Code agents | **Medium** | Core stays protocol-agnostic; MCP server + CLI remain first-class and headless (`npx gizem mcp`) — the extension is a thin adapter, not a gate (ArchSpec §11 R10) |
