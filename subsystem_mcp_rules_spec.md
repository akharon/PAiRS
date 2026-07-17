# Subsystem Spec — MCP Server & Rule Engine (`adapters/mcp/`, `core/rules/`, `adapters/cli/`)

The product surface: retrieval tools the agent queries, the rule engine that turns architecture into agent-legible policy, and the CLI/CI adapters. Built over a protocol-agnostic core so MCP spec churn (R6) touches only a thin layer.

Status: Draft · Addresses R1 (false positives), R3 (differentiation), R5 (empty config), R6, R10 (VS Code coupling), O3, O4

**Reuse:** the MCP server, zod tool contracts (`tools.ts`), executor dispatch, and rendering (token budgeting, pagination, confidence markers, index-freshness footer) are **adapted from the reference indexer** (`vendor/reference-indexer/src/mcp/` + `integration/`); reused tests include `renderShared.test.ts`, `codeToolExecutor.test.ts`. The **rule engine (§3), guardrail tools (§4), and VS Code inline diagnostics (§7) are net-new** — the reference project has retrieval/analysis but no architectural rules. See [`vendor/reference-indexer/REUSE.md`](vendor/reference-indexer/REUSE.md).

---

## 1. Layering

```
core/tools.ts          typed handlers, protocol-free:  (params, snapshot) → Result
   ├─ adapters/vscode  PRIMARY: extension host — embeds core, webview, inline
   │                   diagnostics, status bar; spawns adapters/mcp (§7)
   ├─ adapters/mcp     MCP stdio server: schema decl, freshness stamps
   └─ adapters/cli     gizem index|check|query|map|init|stats|bench
core/rules             config parse → rule kinds → violations
core/analyze           impact, dead_code, coupling, fan_out, cycles, test_gap, louvain
```

All three adapters call the identical `core/tools.ts` handlers over a read snapshot; the extension adds no logic of its own beyond rendering. `core` never imports `vscode` — the extension depends on the core, never the reverse (R10).

Every response — MCP or CLI — carries `{index_age_ms, unresolved_ratio, stale?: true}`.

## 2. Retrieval Tools

```ts
find_symbol { name_fragment, kind? }            → matches[{id, name, kind, module, file, span}]
get_symbol  { id | name }                        → {sig, doc, edgesIn, edgesOut, file, span}
query_graph { cypher } | { question }            → rows with citable locations   // NL form gated by O3
impact      { id, depth?=2, includeUnresolved? } → dependents[{id, name, path[], file, span}]
analyze     { kind, target? }                    → per-kind structured result
module_map  { granularity? }                     → modules, edges, louvain clusters, drift notes
```

Contracts:
- Results are **locations, not code** — the agent reads code with its own file tools, at the exact span GIZEM cites.
- `includeUnresolved` defaults false for `impact`; when true, unresolved candidates are listed separately with `confidence: "possible"`.
- Read-only: `query_graph` executes on a read snapshot; mutating Cypher is rejected at parse.
- Token budget: typical `impact`/`analyze` response ≤ 150 output tokens for ≤ 20 results; paginate beyond.

## 3. Rule Engine

### 3.1 Config (`.gizem/rules.ron`, committed to git)

```ron
( layers: { "core": 1, "db": 1, "services": 2, "ui": 3 },
  module_layers: { "rules::detectors": "services" },   // explicit overrides
  rules: [
    (id: "no-skip-layer", tier: 1, kind: Layering(direction: DownOnly, max_skip: 0),
     explain: "UI → services → core/db. See docs/arch.md §2."),
    (id: "no-module-cycles", tier: 1, kind: NoCycles(edge: "DEPENDS_ON", scope: Module),
     explain: "Module dependency graph must stay a DAG."),
    (id: "custom", tier: 2, kind: Cypher("MATCH ... RETURN f"),
     explain: "..."),
  ] )
```

`explain` is **mandatory** (parse error without it): it is returned verbatim to the agent and is the mechanism that makes violations self-correcting rather than just red CI.

### 3.2 Built-in Kinds

| Kind | Semantics |
|------|-----------|
| `Layering` | cross-module `DEPENDS_ON`/`CALLS` must respect layer numbers/direction |
| `NoCycles` | edge-kind cycle ban at Module or Type scope |
| `ForbiddenDep` | glob-matched from→to module patterns |
| `MaxFanOut` | per-function out-edge ceiling |
| `VisibilityBoundary` | only `pub` items of a module may be referenced from outside |
| `Cypher` | escape hatch; must RETURN nodes; read-snapshot only |

### 3.3 Violation Model & Confidence (R1)

```ts
interface Violation {
  rule: string; tier: 1 | 2; severity: "error" | "warning";
  nodes: SymbolRefWithLocation[];
  explanation: string;                  // rule.explain verbatim
  suggestion?: string;                  // kind-specific ("route through <layer2 module>")
  confidence: "confirmed" | "possible"; // "possible" iff derived via unresolved edges
}
```

**Trust rule:** `possible` violations are reported to agents and humans but **never fail CI**. False-positive triage: any confirmed-violation FP found in the corpus is a release blocker for the rule kind (plan Phase 2 exit).

### 3.4 Evaluation Scopes

- `scope: all` — full snapshot (CLI, CI).
- `scope: changed` — rules pruned to those whose patterns can touch the changed nodes' modules; target < 200 ms after save.

## 4. Guardrail Tools (MCP)

```ts
check_rules  { scope?: "changed" | "all", tier? }   → { violations: Violation[], checked_rules, index_age_ms }
explain_rule { rule_id }                             → { explain, examples, kind, config }
list_rules   { }                                     → active ruleset summary
```

`check_rules` calls `indexer.awaitFresh()` first — a guardrail must never judge a stale graph. Shipped hook recipes (Claude Code post-edit hook; Cursor rules snippet) wire `check_rules(scope: changed)` after every agent edit — the V4 demo loop.

NL→Cypher (O3): if kept, implemented via MCP *sampling* (the agent's own model translates; GIZEM validates read-only-ness and executes) — GIZEM ships no model calls of its own. Decision in Phase 1; raw Cypher + built-ins are sufficient for MVP if deferred.

## 5. Analyses (Tier 3)

| Kind | Output |
|------|--------|
| `impact` | transitive dependents with call paths |
| `dead_code` | unreferenced non-`pub`, non-entry functions (confidence-aware: unresolved-heavy files damp findings) |
| `coupling` | module pairs with edge count > threshold |
| `fan_out` | functions exceeding out-degree threshold |
| `cycles` | all module/type cycles with member lists |
| `test_gap` | `pub` functions with no `TESTED_BY` linkage (O5 heuristic) |
| `louvain` | dendrogram + drift report (implicit cluster spans N explicit modules ⇒ refactor candidate) |

## 6. CLI & CI

| Command | Behavior |
|---------|----------|
| `gizem index` | full index; prints IndexReport |
| `gizem check [--ci] [--baseline f] [--format human\|sarif\|json]` | evaluate rules; `--ci` forces cold index; exit 1 only on **new confirmed** tier-1/2-error violations |
| `gizem baseline update` | snapshot current confirmed violations (the ratchet) |
| `gizem query '<cypher>'` | ad-hoc read query |
| `gizem map` | module graph + Louvain (text/JSON) |
| `gizem init` | index → infer layers (path structure + Louvain + edge direction stats) → write draft `rules.ron` + findings report (R5) |
| `gizem stats` / `gizem bench` | metrics; reproducible token/latency/precision benchmark |

Baseline identity (O4): violation key = `hash(rule_id + sorted symbol paths)` (module-qualified names, not file paths) — stable under file moves, invalidated by genuine renames (acceptable: a rename is a review-worthy change).

## 7. VS Code Extension Surface (primary)

The extension is a thin shell over `core/tools.ts`; it renders, it never edits.

| Contribution | Backed by | Notes |
|--------------|-----------|-------|
| Module-graph webview | `module_map` | Louvain clusters + explicit-vs-implicit drift; click a node → reveals `file:span` |
| Inline diagnostics | `check_rules(scope: changed)` violation model | VS Code Diagnostics API squiggles; `confidence: possible` rendered as Hint/Info, `confirmed` as Warning/Error; `explanation` in the hover |
| Status bar item | `stats()` | `index_age_ms` + `unresolved_ratio`; click → `gizem stats` panel |
| Commands | tool handlers | `Gizem: Find Symbol`, `Impact`, `Module Map`, `Check Rules`, `Init` |
| Embedded MCP | spawns `adapters/mcp` | so in-editor Copilot and external hosts share one server/index |

Contracts:
- **Read-only:** the extension registers no edit/codeAction that mutates source. Quick-fixes, if any, only insert `#[allow]`-style suppressions or open the cited span — never rewrite logic (preserves the no-write pivot).
- **No core coupling:** `core` has zero `vscode` imports; the extension is the only package that does. This keeps the headless MCP + CLI paths (R10) identical and testable without an editor.

## 8. Exit Tests

- [ ] V4 demo: seeded layering violation from a real Claude Code session → `check_rules` reports with explanation → agent self-corrects → re-check clean.
- [ ] V6: legacy repo passes day-1 with baseline; new seeded violation fails CI; SARIF renders on GitHub.
- [ ] Zero confirmed-violation false positives across the 3-repo corpus with the starter ruleset.
- [ ] `check_rules(scope: changed)` < 200 ms after save (with awaitFresh) on ARES.
- [ ] `gizem init` proposal rated "mostly right" by a maintainer on an unseen repo (V7).
- [ ] MCP conformance: tools usable from Claude Code and Cursor per docs; malformed params rejected with structured errors.
- [ ] Extension: `.vsix` installs; webview + inline diagnostics + status bar render on ARES; no source-mutating contribution registered.
- [ ] R10 gate: full MCP + CLI conformance/E2E passes with **no VS Code present**; `core` package has zero `vscode` imports (lint-enforced).
