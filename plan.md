# GIZEM — MVP Development Plan

**Ship the guardrail loop in 6 weeks. Every phase ends with something installable.**

Version: 2.0.0 · Status: Draft (post-pivot) · Target: 6 weeks · Supersedes the 12-week v1 plan (see [`REVIEW.md`](REVIEW.md) §0)

---

## Plan Philosophy

1. **Every phase ships** an installable artifact — a VS Code extension (`.vsix`, pre-release channel) from Phase 1 on, plus the headless `npx gizem@next` package for external agents and CI. Same core, two shells.
2. **Rules are the MVP, not the epilogue.** Retrieval alone is commoditized (Codebase-Memory, CodexGraph); the guardrail loop ships by week 4.
3. **Precision is measured from day 1.** `unresolved_ratio` is on the dashboard from the first index; no fidelity claims without numbers.
4. **Risks stay open until their exit test is green.** No "Eliminated" labels pre-implementation (the v1 lesson).
5. **Two spikes gate the plan** (week 1): resolver precision (O1) and KuzuDB concurrency (O2). Both have documented fallbacks.

Test corpus: **ARES** (500+ fn internal project) + 2 public Rust repos (e.g. `ripgrep`, a mid-size axum service) for precision benchmarks that can be published.

---

## Phase 0 — Indexer & Graph (Weeks 1–2) · `v0.1.0`

**What ships:** `gizem index` + `gizem query` (raw Cypher) + `gizem stats` on any Rust project.

### Week-1 Spikes (gates)

| Spike | Question | Pass | Fallback |
|-------|----------|------|----------|
| S1 — Resolver (O1) | tree-sitter + scope heuristics on ARES: what % of calls resolve? | ≥ 85% raw | add `syn`-based signature pass for the resolver only |
| S2 — Kuzu concurrency (O2) | Read snapshot stable during concurrent index write in Node bindings? | documented behavior confirmed | serialize reads behind writes (latency hit) or SQLite fallback design |

### Deliverables

| # | Deliverable |
|---|------------|
| 0.1 | Node package scaffold, CLI skeleton, cross-platform CI (Linux/macOS/Windows) |
| 0.2 | KuzuDB store: schema v1, migration stub, single-writer transaction wrapper, read snapshots |
| 0.3 | tree-sitter Rust parse → symbol declaration pass (Modules, Functions, Types, Params, Files) |
| 0.4 | Resolution pass: `use`-map + scope-aware reference resolution → CALLS/READS/WRITES/DEPENDS_ON/IMPLEMENTS with `resolved` flag |
| 0.5 | `unresolved_ratio` + `gizem stats`; per-file `content_hash` bookkeeping |
| 0.6 | Golden-corpus test harness: fixture files → expected graph |
| 0.7 | Workspace/monorepo scoping decision implemented (O6: single graph, `crate` property) |

### Exit Criteria

- [ ] Index ARES: zero crashes, `unresolved_ratio` ≤ 10% (V1), full index < 15 s.
- [ ] Index `ripgrep`: completes, stats published in repo.
- [ ] Golden corpus: 40+ fixtures covering fns, impl blocks, traits, `use` forms, method calls, macros (macros allowed to be unresolved — but *counted*).
- [ ] `gizem query 'MATCH (f:Function)-[:CALLS]->(g) RETURN ...'` returns cited `file:span` results.
- [ ] Cross-platform CI green.

---

## Phase 1 — VS Code Extension + MCP Retrieval (Week 3) · `v0.2.0`

**What ships:** the **VS Code extension** (pre-release) — embeds the core, a symbol/graph panel, and a bundled MCP server exposing `find_symbol`, `get_symbol`, `query_graph`, `impact`, `analyze`, `module_map`. Same tools available headless via `npx gizem mcp`. Setup docs for in-editor Copilot and external Claude Code / Cursor.

### Deliverables

| # | Deliverable |
|---|------------|
| 1.1 | MCP adapter (stdio) over protocol-agnostic core; tool schemas + freshness stamps on every response |
| 1.2 | `find_symbol` / `get_symbol` (signature, edges, span, doc comment) |
| 1.3 | `impact(id, depth)` — transitive dependents with paths |
| 1.4 | `analyze`: dead_code, coupling, fan_out, cycles, test_gap (O5 heuristic: `#[test]` callers) |
| 1.5 | `module_map`: module graph + Louvain clusters + explicit-vs-implicit drift notes |
| 1.6 | **VS Code extension scaffold:** activation, core embedded in extension host, spawns the MCP server, status bar (index_age / unresolved_ratio), symbol-search command + panel |
| 1.7 | Token benchmark harness: 20 scripted context questions, MCP vs. file-reading baseline (V3, RS1) |
| 1.8 | O3 decision: NL→Cypher via MCP sampling, or defer (raw Cypher + built-ins suffice for MVP) |

### Exit Criteria

- [ ] Extension installs from `.vsix`, indexes ARES on activation, symbol panel + status bar work; core also runs headless with no editor (R10 gate).
- [ ] Claude Code session on ARES answers "what depends on Kinematics?" via `impact` — correct against grep ground truth ≥ 95% recall (V2).
- [ ] Token benchmark shows ≤ 10% of baseline tokens on the 20-question set; numbers committed to repo (V3).
- [ ] `analyze(dead_code)` on ARES verified against manual inspection.
- [ ] MCP server passes protocol conformance tests; works in-editor (Copilot) and in Claude Code / Cursor per docs.

---

## Phase 2 — Rule Engine & CI Gate (Week 4) · `v0.3.0` — **the differentiator**

**What ships:** `.gizem/rules.ron`, `check_rules` MCP tool, `gizem check` with SARIF + baseline, pre-commit and agent-hook recipes.

### Deliverables

| # | Deliverable |
|---|------------|
| 2.1 | Rule config parser (RON): layers, rules, mandatory `explain` |
| 2.2 | Built-in rule kinds: `Layering`, `NoCycles`, `ForbiddenDep`, `MaxFanOut`, `VisibilityBoundary` |
| 2.3 | Raw-Cypher rule kind (read-snapshot-only execution) |
| 2.4 | Violation model: `{rule, severity, nodes, locations, explanation, suggestion, confidence}` — unresolved-edge-dependent findings marked "possible", excluded from CI fail (R1) |
| 2.5 | `check_rules(scope: changed|all)` MCP tool + `explain_rule`, `list_rules` |
| 2.6 | `gizem check` CLI: human output, `--format sarif`, exit codes |
| 2.7 | Baseline/ratchet: `--baseline` snapshot + diff; violation identity stable under file moves (O4) |
| 2.8 | Agent-hook recipes: Claude Code post-edit hook + Cursor rules file that auto-run `check_rules` |
| 2.9 | VS Code inline diagnostics: violations rendered as squiggles via the Diagnostics API (from the same violation model, read-only) |

### Exit Criteria

- [ ] Seeded layering violation introduced by a *real agent session* is caught; agent self-corrects from the returned explanation (V4 — the demo).
- [ ] Legacy-repo day-1: `check --ci --baseline` passes; new seeded violation fails CI (V6).
- [ ] SARIF renders in GitHub code scanning.
- [ ] Zero Tier-1 false positives on ARES with the starter ruleset (R1 gate — any FP triaged before release).

---

## Phase 3 — Incremental Loop, Init & Graph Viz (Week 5) · `v0.4.0`

**What ships:** file watcher, < 100 ms incremental re-index, `gizem init` rule inference, and the VS Code module-graph webview (now a core deliverable, read-only).

### Deliverables

| # | Deliverable |
|---|------------|
| 3.1 | Watcher (chokidar) + debounce; per-file subgraph replace in one transaction |
| 3.2 | Incremental ≡ full property test in CI (V8 / R7) |
| 3.3 | Scoped rule evaluation on changed nodes (< 200 ms after save) |
| 3.4 | `gizem init`: index → Louvain + structure analysis → proposed layers + starter `rules.ron` + findings report (R5) |
| 3.5 | VS Code module-graph webview (Louvain clusters + drift), fed by `module_map`; wired to the Phase-2 inline diagnostics — read-only |

### Exit Criteria

- [ ] Save-to-fresh-index < 100 ms p95 on ARES; changed-scope check < 200 ms (V5).
- [ ] 100 random edits: incremental graph isomorphic to cold full index (V8).
- [ ] `gizem init` on a repo the team has never seen: maintainer rates proposal "mostly right" (V7, design-partner test).

---

## Phase 4 — Harden, Benchmark, Release (Week 6) · `v1.0.0`

| Day | Activity |
|-----|----------|
| 1–2 | Bug bash: full agent workflow on ARES + 2 public repos; every crash/FP triaged |
| 3 | Performance: index/query/check targets from ArchSpec §1.4; 10k-function stretch bench (R9) |
| 4 | Precision report: published `unresolved_ratio` + rule FP numbers on the 3 corpus repos |
| 5 | Docs: README, "10 minutes to guarded agents" walkthrough, rule cookbook, hook recipes |
| 6–7 | VS Code Marketplace publish (extension) + npm publish (headless core/CLI) + MCP registry listing; announcement post with the V4 self-correction demo |

### Exit Criteria

- [ ] All V1–V8 verification criteria green.
- [ ] Zero P0 (crash/wrong-CI-fail) bugs; P1s documented.
- [ ] Published benchmark numbers (tokens, precision, latency) reproducible via `gizem bench`.

---

## Phase Dependency & Timeline

```
Wk1        Wk2        Wk3        Wk4        Wk5        Wk6
[S1+S2 spikes]
[Phase 0: indexer+graph][Phase 1: MCP][Phase 2: rules][Phase 3: incr+init][Phase 4: release]
 v0.1.0 ──────────────▶ v0.2.0 ─────▶ v0.3.0 ────────▶ v0.4.0 ───────────▶ v1.0.0
```

Critical path: resolver precision (S1). If S1 lands at 85–90% only, Phase 2's "possible violation" class carries more weight and the syn-precision upgrade moves from post-MVP into a v1.1 fast-follow — the plan does not slip; the precision report is just more conservative.

---

## Risk Status (tracked, not "eliminated")

Full register in ArchSpec §11. Watch-list by phase:

| Phase | Primary risks in play | Green when |
|-------|----------------------|------------|
| 0 | R1 (precision), R4 (Kuzu), O1/O2/O6 | S1/S2 pass, V1 |
| 1 | R2 (staleness), R10 (VS Code coupling), O3/O5 | V2, V3, headless MCP+CLI green with no editor |
| 2 | R1 (false positives), R3 (differentiation), O4 | V4, V6, FP triage clean |
| 3 | R7 (incremental drift), R5 (empty config) | V8, V5, V7 |
| 4 | R9 (scale) | bench published |

Deferred research items: RS1 (token savings — measured in Phase 1, published in Phase 4), RS2 (agent adoption of graph tools vs. file reads — passive telemetry off by default, opt-in bench harness instead), RS4 (Louvain quality — Phase 3 via V7).
