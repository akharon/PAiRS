# GIZEM — Architecture Specification (arc42)

**Architectural guardrails and a code-graph context engine for AI coding agents.**

Version: 2.0.0 · Status: Draft (post-pivot) · Supersedes v1.0.0 (graph-as-source-of-truth — see [`REVIEW.md`](REVIEW.md) §0)

---

## 0. Document Hierarchy

```
TIER 0 — Vision        idea.md                    why + what
TIER 1 — Architecture  ArchSpec.md (this)         how it is structured
TIER 2 — Delivery      plan.md                    in what order
TIER 2 — Review        REVIEW.md                  v1 critique + pivot record
TIER 3 — Subsystems    subsystem_indexer_spec.md      parse/resolve/extract
                       subsystem_graph_store_spec.md  KuzuDB access, index txns
                       subsystem_mcp_rules_spec.md    MCP server + rule engine
```

**Traceability:** each Tier-1 building block (§5) maps to a Tier-3 spec; each Tier-3 spec ends with exit tests that let the risk register (§11) honestly downgrade a risk. Risks are never "Eliminated" before their exit tests pass.

---

## 1. Introduction and Goals

### 1.1 Problem

AI coding agents retrieve context by reading files (token-expensive, approximate) and modify code with no architectural awareness (layer violations, cycles, and coupling slip through until human review — or don't). Existing code-graph MCP tools solve retrieval only; existing architecture linters (ArchUnit-style) are human/test-suite-oriented with no agent feedback loop.

GIZEM maintains a **derived** code graph over unchanged text files and exposes it two ways: retrieval tools (token-efficient context) and a rule engine (architecture as enforceable, agent-legible policy).

### 1.2 Core Principles

1. Files are the source of truth; the graph is a disposable index (delete `.gizem/` → re-index).
2. One-directional dataflow: files → indexer → graph → consumers. No write-back, ever.
3. Rules are graph queries with mandatory human-written explanations.
4. Check-after-edit, not gate-before-write.
5. Measured honesty: every answer carries `index_age_ms` and `unresolved_ratio`.

### 1.3 Stakeholders

| Stakeholder | Concern |
|-------------|---------|
| AI coding agent (via MCP) | Cheap, precise, citable answers; actionable violations |
| Developer | Zero workflow change; architecture visibility; trustworthy checks (low false-positive rate) |
| CI system | Deterministic exit codes, SARIF, baseline/ratchet mode |
| Tech lead / architect | Rules as reviewable config in git |

### 1.4 Quality Requirements (top 5)

| Attribute | Target |
|-----------|--------|
| Incremental re-index (1 file saved) | < 100 ms p95 |
| Full index, 500-function project | < 15 s |
| Query latency (typical Cypher, ≤ 5k nodes) | < 50 ms |
| Resolution precision (CALLS on idiomatic Rust) | ≥ 90% resolved, measured & reported |
| Rule check false-positive rate on Tier-1 rules | Low enough that teams keep it in CI — tracked via baseline suppression counts |

---

## 2. Constraints

| Constraint | Impact |
|------------|--------|
| MCP protocol (spec-versioned) | Agent surface must track spec; keep a thin adapter over a protocol-agnostic core |
| Node.js runtime — VS Code extension host *is* Node; KuzuDB bindings + tree-sitter WASM + MCP SDK all run there | One runtime serves both the extension and headless `npx gizem` from a single core |
| tree-sitter parsing (no type inference) | Name resolution is heuristic; precision is a metric, not a guarantee (R1) |
| Rust-only v1 | Schema and parser choice must not bake in Rust-isms (language tag on nodes) |
| Solo/small-team, 6-week MVP | No SaaS, no dashboard, no multi-language, no VS Code editing surfaces |
| Local-only, no telemetry by default | Trust prerequisite for running inside private codebases |

---

## 3. System Context

```
 Developer + Copilot ─────▶ ┌───────────────────────────┐
   (VS Code extension host) │  GIZEM core                │ ──reads──▶ source files
 External agent ─MCP stdio▶ │  (indexer·graph·rules·mcp) │ ──r/w───▶ .gizem/ (index, cache)
 CI ── CLI --ci ───────────▶ └───────────────────────────┘ ──reads──▶ .gizem/rules.ron (in git)
```

The **VS Code extension is the primary host**: it embeds the core in the extension host process, renders the graph webview + inline diagnostics, and spawns/exposes the MCP server for both in-editor (Copilot) and external agents. The identical core runs headless as `npx gizem mcp` (external agents without VS Code) and `gizem check --ci` (CI).

**External interfaces**

| Interface | Protocol | Purpose |
|-----------|----------|---------|
| MCP server | stdio JSON-RPC (MCP) | Agent tools: retrieval + guardrails |
| CLI | `gizem index/check/query/init/map` | Human + CI + pre-commit |
| SARIF output | file/stdout | GitHub code scanning integration |
| File watcher | fs events (chokidar) | Incremental re-index |
| Rules config | `.gizem/rules.ron` (checked into git) | Team-owned policy |

**In scope (v1 MVP):** Rust indexing (tree-sitter + resolution layer), KuzuDB graph, MCP retrieval tools, rule engine (built-in kinds + raw Cypher), **VS Code extension (primary: graph webview + inline rule diagnostics + embedded MCP)**, headless CLI + CI + baseline mode, Louvain module map, `gizem init` rule inference.

**Out of scope (v1):** any code modification (the extension never edits — read-only diagnostics), multi-language, SaaS/dashboard, semantic VCS, serialization/compilation, projectional views, real-time collaboration, non-VS Code IDE extensions (external agents use the headless MCP server).

---

## 4. Solution Strategy

| Decision | Rationale | Rejected |
|----------|-----------|----------|
| **Derived index, never source of truth** | Removes the sync/round-trip/containment problem class that killed v1 and every structured-editing predecessor | Graph-as-medium (v1) |
| **VS Code extension as primary surface, bundling MCP + CLI** (revised 2026-07-16; supersedes the prior MCP-first stance) | IDE-native graph viz + inline diagnostics are the adoption wedge where developers already work; the extension embeds the MCP server (in-editor Copilot + spawned stdio for external agents) and ships the headless CLI for CI. Core stays protocol-agnostic so nothing is VS Code-locked | Standalone MCP-server-only (weaker UX/discoverability); VS Code editing surface (violates the no-write pivot) |
| **tree-sitter first, syn later** | Multi-language future, fast incremental parsing, WASM in Node. Precision gap is measured (`unresolved_ratio`) and closable | Hand-written parser; rust-analyzer embedding (too heavy for v1) |
| **KuzuDB embedded** | Cypher for rules, embeddable, no server. Disposable-index design caps the blast radius of binding immaturity | Neo4j (server), SQLite (no graph queries — kept as documented fallback) |
| **Rules in RON in git** | Reviewable policy; explanations travel with the rule to the agent | UI-configured rules, code-based rules (ArchUnit style) |
| **Baseline/ratchet CI mode** | Legacy codebases have violations on day 1; failing on *new* violations only makes adoption possible | All-or-nothing gating |
| **Louvain for module map + rule inference** | Retained from v1 — proven in architecture recovery; now also seeds `gizem init` | K-means |

Patterns: **Pipeline** (parse → resolve → extract → store), **single-writer** (indexer is the only graph writer; all consumers read snapshots), **hexagonal** (protocol-agnostic core; MCP/CLI/JSON-RPC as adapters).

---

## 5. Building Block View

```
┌─────────────────────────────────────────────────────────────┐
│  gizem (Node.js package)                                    │
│                                                             │
│  adapters/        core/                    store/           │
│  ├─ vscode/ ★     ├─ indexer/    ────────▶ ├─ graph/        │
│  ├─ mcp/          │   parse (tree-sitter)  │  (KuzuDB,      │
│  ├─ cli/          │   resolve, extract     │   snapshots,   │
│  └─ (★ primary)   │                        │                │
│        │          │   watch, incremental   │   schema)      │
│        │          ├─ rules/                │                │
│        └────────▶ │   engine, builtins,    │                │
│                   │   baseline, sarif      │                │
│                   ├─ analyze/  (impact, dead code, Louvain) │
│                   └─ querynl/  (NL → Cypher, optional)      │
└─────────────────────────────────────────────────────────────┘
```

| Module | Responsibility | Spec |
|--------|---------------|------|
| `core/indexer` | Parse files, resolve names, extract nodes/edges, incremental updates, freshness metadata | [`subsystem_indexer_spec.md`](subsystem_indexer_spec.md) |
| `store/graph` | KuzuDB lifecycle, schema/migration, single-writer transactions, read snapshots | [`subsystem_graph_store_spec.md`](subsystem_graph_store_spec.md) |
| `core/rules` + `adapters/mcp` | Rule parsing/execution, violation formatting, baseline, MCP tool surface | [`subsystem_mcp_rules_spec.md`](subsystem_mcp_rules_spec.md) |
| `core/analyze` | Tier-3 queries: impact, dead code, coupling, fan-out, test gap, cycles, Louvain map | in MCP/rules spec §5 |
| `adapters/cli` | `index`, `check`, `query`, `map`, `init`; exit codes; SARIF | in MCP/rules spec §6 |
| `adapters/vscode` | **Primary surface.** Extension host: embeds the core, module-graph webview, inline rule diagnostics (VS Code Diagnostics API), status bar (freshness/`unresolved_ratio`), spawns the MCP server. Read-only — never edits | in MCP/rules spec §7 |
| `core/querynl` | Natural-language → Cypher translation (calls the user's own model via MCP sampling; optional) | in MCP/rules spec §4 |

### 5.1 Graph Schema

Node labels and edges as in idea.md §2 (Module, Function, Type, Param, File; OWNS, DECLARES, CALLS{resolved}, READS, WRITES, DEPENDS_ON, PARAM, OF_TYPE, RETURNS, IMPLEMENTS, TESTED_BY). All symbol nodes carry `lang`, `file`, `span`. Index metadata: `File{content_hash, indexed_at}`, one `IndexMeta` node `{schema_version, full_index_at, unresolved_ratio}`.

---

## 6. Runtime View

### 6.1 Agent Retrieval (primary scenario)

```
agent → MCP impact(id: "detect_speed", depth: 2)
  1. read snapshot from graph store
  2. Cypher: transitive CALLS/DEPENDS_ON dependents ≤ depth
  3. return {dependents: [{name, file:span, path}], index_age_ms, unresolved_ratio}
  ~80 output tokens; agent never opens a file
```

### 6.2 Edit → Check Loop (the differentiating scenario)

```
agent edits src/ui/panel.rs
  1. watcher fires → indexer re-parses file (< 100 ms)
  2. graph store: replace file's DECLARES subgraph in one txn
  3. rule engine: run Tier-1/2 rules scoped to changed nodes
  4. agent (via post-edit hook) calls check_rules(scope: changed)
  5. violation returned with rule explanation + fix suggestion
  6. agent corrects; re-check passes
```

### 6.3 CI Gate

```
gizem check --ci --baseline .gizem/baseline.json
  1. full index (cold, deterministic)
  2. run all Tier-1/2 rules
  3. diff violations against baseline → fail only on new ones
  4. emit SARIF + human summary; exit code 0/1
```

### 6.4 First Run

```
gizem init
  1. full index
  2. Louvain clustering + module structure analysis
  3. propose layers + starter rules → write .gizem/rules.ron draft
  4. report: modules, cycles found, suggested layering, unresolved_ratio
```

---

## 7. Deployment

**Primary:** a VS Code Marketplace extension (`.vsix`) bundling the core, MCP server, and CLI — one-click install, in-editor graph viz + diagnostics. **Headless:** the same core ships as an npm package — `npx gizem mcp` (external agents: Claude Code, Cursor), `npx gizem check` (CLI/CI) — no editor required. KuzuDB native addon and tree-sitter WASM grammars bundled in both. `.gizem/` holds index DB, cache, baseline (index DB gitignored; `rules.ron` and `baseline.json` committed). No server components; no network calls except optional NL→Cypher via the agent's own MCP sampling.

---

## 8. Cross-Cutting Concepts

| Concern | Approach |
|---------|----------|
| Error handling | All tool/CLI responses structured `{ok}` / `{error, detail, suggestion}`; indexer never aborts a run on one bad file — records `File{parse_error}` and continues |
| Staleness | Every response stamped `index_age_ms`; queries against a >30 s-stale index include a `stale: true` flag; CLI `check --ci` always full-indexes |
| Security | Read-only over source; no code execution; no network; rules.ron Cypher runs on read snapshots only |
| Testing | Unit (resolver, rule kinds), golden-corpus (index fixtures → expected graph), property (incremental ≡ full re-index), E2E (MCP session against real repo), benchmark (latency + precision on 3 public Rust repos) |
| Observability | `gizem stats`: node/edge counts, unresolved_ratio, per-rule timings |

---

## 9. Architectural Decisions (ADRs)

| ADR | Decision | Status |
|-----|----------|--------|
| 001 | KuzuDB embedded as index store (SQLite documented as fallback; index disposability caps risk) | Accepted |
| 002 | Derived-index architecture; no write-back (supersedes v1 ADR-002 hybrid body model) | Accepted — pivot |
| 003 | VS Code extension as primary surface — bundles MCP server + CLI, provides graph viz + inline diagnostics, never edits (supersedes the prior MCP-first 003) | Accepted — revised 2026-07-16 |
| 004 | tree-sitter parsing with heuristic resolver; `syn`/rust-analyzer precision upgrade post-MVP, gated on measured `unresolved_ratio` | Accepted |
| 005 | Rules as RON config with mandatory `explain`; built-in kinds + raw Cypher escape hatch | Accepted |
| 006 | Louvain for module map and `init` inference (carried over from v1 ADR-006) | Accepted |
| 007 | Baseline/ratchet mode for CI adoption on legacy codebases | Accepted |
| — | v1 ADRs on serializer, Cranelift, semantic VCS, dummy file tools | **Retired** (pivot) |

---

## 10. Verification Criteria (v1.0 gates)

| # | Criterion | Verified |
|---|-----------|----------|
| V1 | Index a real 500+-function Rust project; `unresolved_ratio` ≤ 10%; zero crashes | Phase 0 |
| V2 | `impact` on a core type matches manual grep-derived ground truth ≥ 95% recall | Phase 1 |
| V3 | Token benchmark: dependency question via MCP ≤ 10% of the tokens of file-reading baseline, measured on 20 scripted questions | Phase 1 |
| V4 | Layering rule catches a seeded violation introduced by a real agent session; agent self-corrects using the returned explanation | Phase 2 |
| V5 | Save-to-fresh-index < 100 ms p95; changed-scope `check_rules` < 200 ms | Phase 3 |
| V6 | `gizem check --ci --baseline` on a legacy repo: passes day 1, fails on a new seeded violation | Phase 2 |
| V7 | `gizem init` on an unfamiliar repo proposes a ruleset a maintainer rates as "mostly right" (design-partner test) | Phase 3 |
| V8 | Incremental ≡ full: after 100 random edits, incremental index equals cold full index (graph isomorphism check) | Phase 3 |

---

## 11. Risk Register (honest, pre-implementation)

Scores are residual **before** exit tests pass. "Eliminated" requires the named test green.

| ID | Risk | Score | Mitigation | Exit test |
|----|------|-------|-----------|-----------|
| R1 | Resolution precision too low → false positives → teams disable rules | **High** | unresolved-ratio metric; "possible violation" class excluded from CI fail; resolver golden corpus; syn upgrade path | V2, V4, precision bench ≥ 90% |
| R2 | Index staleness causes wrong agent answers | **Medium** | freshness stamp on every answer; watcher + on-demand reindex before `check_rules`; CI always cold-indexes | V5, staleness E2E |
| R3 | Retrieval commoditization — graph-MCP rivals add rules | **Medium** | rules ship in MVP (week 4), not post-MVP; `init` inference and agent-legible explanations are the moat | V4, V7 |
| R4 | KuzuDB binding instability | **Medium** | disposable index (worst case: re-index); cross-platform CI week 1; SQLite fallback design documented | V1 on 3 platforms |
| R5 | Empty-config problem — nobody writes rules | **Medium** | `gizem init` proposes layers/rules from structure + Louvain; starter packs | V7 |
| R6 | MCP spec churn | **Low-Med** | protocol-agnostic core, thin adapter; CLI parity for everything | adapter conformance tests |
| R7 | Incremental-index drift vs. full index | **Medium** | property test incremental ≡ full in CI | V8 |
| R8 | Scope creep back toward v1 (views, write tools) | **Low-Med** | Non-goals list (idea.md §7); any write tool requires a new ADR | review discipline |
| R9 | Performance on large repos (>10k functions) | **Medium** | per-file incremental design; Kuzu bulk load for cold index; bench repo in CI | V1/V5 on 10k-fn repo (stretch) |
| R10 | VS Code-first delivery narrows reach: non-VS Code agents get only the packaged stdio MCP + CLI; risk of extension-host coupling leaking into the core | **Medium** | core stays protocol-agnostic and headless-first; extension is a thin adapter over the identical core; MCP + CLI remain first-class | MCP server + CLI pass full conformance/E2E **with no VS Code present** |

---

## 12. Open Items

| ID | Question | Target |
|----|----------|--------|
| O1 | Resolver design: how far can tree-sitter + scope heuristics get on idiomatic Rust (traits, method calls, `use` globs)? Spike with measured precision | Phase 0, week 1 |
| O2 | KuzuDB concurrency: confirm reader-snapshot behavior under concurrent index writes in Node bindings | Phase 0 spike |
| O3 | NL→Cypher: use MCP sampling (agent's own model) vs. skip for MVP (raw Cypher + built-in analyses may suffice) | Phase 1 decision |
| O4 | Baseline format: violation identity under renames/moves (hash of rule+nodes vs. locations) | Phase 2 |
| O5 | `TESTED_BY` heuristic quality — is `#[test]`-caller linkage good enough for `test_gap`? | Phase 1 |
| O6 | Monorepo/workspace scoping: per-crate graphs vs. one graph with `crate` property | Phase 0 |

---

## 13. Glossary

| Term | Definition |
|------|------------|
| Derived index | The KuzuDB graph — rebuildable from source at any time, never authoritative |
| Resolution / `unresolved_ratio` | Fraction of reference edges whose target could not be identified; the core precision metric |
| Tier 1/2/3 | Architectural constraints (error) / design rules (warning) / on-demand analyses (info) |
| Baseline / ratchet | CI mode failing only on violations not present in a committed baseline snapshot |
| MCP | Model Context Protocol — the standard tool interface consumed by AI coding agents |
| Louvain | Community-detection algorithm used for the module map and `init` rule inference |

---

## Appendix

| Field | Value |
|-------|-------|
| Template | arc42 8.0 (adapted) |
| Last updated | 2026-07-16 |
| Version | 2.0.0 — post-pivot draft; risk register honest per REVIEW.md discipline |

References: [`REVIEW.md`](REVIEW.md) (pivot rationale + market research) · CodexGraph (NAACL 2025) · Codebase-Memory (arXiv 2603.27277) · Blondel et al. 2008 (Louvain) · modelcontextprotocol.io · docs.kuzudb.com
