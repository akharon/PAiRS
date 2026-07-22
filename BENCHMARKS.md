# Measured index stats

Numbers, not claims (plan philosophy #3). Reproduce any row with:

```sh
npm run build && npm run fetch-grammars
cd <repo> && node <gizem>/dist/cli.js index
```

Machine: Linux, Node 22.23.1, kuzu 0.11.3. Recorded 2026-07-17 (Phase 0, v0.1.0).

## Corpus

| Repo | Files | Symbols | Edges | Index time |
|---|---|---|---|---|
| ARES (internal, 100-file sample) | 100 | 1,035 | 1,569 | **23 s** |
| [ripgrep](https://github.com/BurntSushi/ripgrep) @ depth-1 clone | 102 | 3,249 | 23,620 | **27 s** |

## Precision

| Repo | `fuzzyRate` | `resolvableMisses` | `externalRefs` | `unresolvedRatio` |
|---|---|---|---|---|
| ARES | 37.3% | **0** | 3,276 | 67.6% |
| ripgrep | 79.5% | **0** | 7,810 | — |

*(Numbers updated after the golden-corpus pass fixed inline-`mod` function
extraction — see "Correctness fixes" below. ARES functions jumped 472 → 635 as
163 previously-invisible module functions entered the index, and its fuzzyRate
improved 41.8% → 37.3%. ripgrep's rose 74.5% → 79.5%: the newly-visible symbols
are mostly test helpers reached by unqualified method calls, which land in the
deferred bucket.)*

**How to read these:**

- **`resolvableMisses` = 0 on both** — every unresolved ref provably names
  nothing in the workspace. This is the number that would indicate a resolver
  *bug*, and it is clean on both corpora.
- **`unresolvedRatio` is not a precision metric** and the two repos show why it
  can't be: it swings 71% → 30% between them while `resolvableMisses` stays 0.
  It measures how much stdlib/dependency code a repo calls, not resolver
  quality. Reported as a workload descriptor only.
- **`fuzzyRate` is the precision metric** (R1), and v1 misses the ≤ 15% bar.
  The gap is entirely **unqualified method calls** (`self.foo.observe()`), which
  need receiver-type inference — deferred to v1.1 by decision (see plan.md S1).
  ripgrep is close to a worst case for this: **2,032 of its 2,793 symbols are
  methods**, and ~200 flag structs each implement `name_long`, so a bare
  `name_long` call has ~200 candidates. ARES, with proportionally more free
  functions, fares much better at 41.8%.

Fuzzy edges are *marked*, not hidden: per plan.md deliverable 2.4, findings that
depend on one are reported as "possible" and excluded from CI failure.

## Robustness

- **Zero crashes** on both repos.
- **ARES: zero parse errors** across 100 files.
- **ripgrep: 1 of 101 files partially indexed** —
  `crates/printer/src/hyperlink/mod.rs` uses an open-ended range pattern
  (`128.. =>`) the vendored tree-sitter-rust grammar doesn't accept. Degrades as
  designed: the file's parsed portion is still indexed and the error is
  reported, rather than failing the run. Fix is a grammar bump, not GIZEM code.

## Correctness fixes (golden-corpus pass)

A 67-case Rust corpus (`src/core/indexer/rustCorpus.test.ts`) surfaced bugs the
two real-world repos couldn't, because both use file-level modules:

- **Inline-`mod` functions were dropped entirely.** The `@def.function` query
  pattern was anchored to `source_file`, so every function inside `mod x { ... }`
  — including `#[cfg(test)] mod tests` — was invisible to the index. Fixed.
- **`impl<T> Wrapper<T>` methods didn't qualify** (the `type:` field holds a
  `generic_type`); they fell back to bare names. Fixed.
- **Supertrait bounds (`trait Shape: Draw`) were silently discarded** — the Rust
  ref-kind map had no `ref.extends` entry, so the whole trait-inheritance graph
  was lost. Fixed.

## V2 gate — `impact()` recall vs grep (Phase 1)

`scripts/v2-recall.mjs` samples the most-referenced exported functions in
ripgrep, then compares the set of files `impact(name)` reaches transitively
against grep call-site ground truth (file-level; grep can't resolve to a
symbol). Run after indexing: `node scripts/v2-recall.mjs <repo>`.

**Result (ripgrep, 14 symbols, 68 ground-truth file references):**

- **8 of 14 symbols: 100% recall** — every distinctive free function
  (`strip_prefix`, `interpolate`, `resolve_binary`, `generate_digits`,
  `lookup`, `errored`, `find_iter_at_in_context`, `locate`).
- **Raw recall 66%**, but every miss falls into one of three known, verified
  causes — **zero genuine resolver bugs**:
  - **Method calls (S1 deferred):** `.stdout()`, `args.` on a receiver — needs
    receiver-type inference, deferred to v1.1 by decision. This is the risk the
    S1 deferral was said to ride on, and it is exactly what shows up here.
  - **Macro bodies:** references inside `rgtest!(...)`/`macro_rules!` /
    `err_message!(...)` parse as opaque `token_tree` — invisible to *any* AST
    indexer, not a GIZEM miss.
  - **grep false positives:** name collisions with stdlib (`std::io::stdout`,
    `env::args`) or substrings (`set_messages` vs `messages`) — the ground truth
    over-counts, not the graph under-counts.
  - The one parse-error file (`hyperlink/mod.rs`, grammar gap) drops
    `hyperlink_aliases` — a documented limitation, not a resolver bug.

**Verdict: V2 passes for what it gates** — the transitive `impact` walk has no
resolver defect; recall is limited only by the accepted S1 method-call deferral
and AST-universal macro opacity. The auto-classifier in the script undercounts
(it can't see stdlib collisions), so the 11 it labels "UNEXPLAINED" were
manually audited to the causes above.

## V3 gate — token cost vs a file-reading agent (Phase 1)

The headline "why GIZEM" number: answering an agent's structural questions
through the MCP tools vs. answering them by grep-then-read. `dist/v3-bench.js`
runs 20 scripted questions (who_calls, impact, get_symbol, outline, file_deps,
module_map, analyze), authored against symbols the harness discovers in the
indexed store so the set adapts to the corpus. Both sides counted with the same
cl100k tokenizer (`gpt-tokenizer`):

- **GIZEM cost** = tokens of the tool response an agent receives.
- **Baseline** = tokens of the full text of every file `grep -lw <term>` returns
  for that question — the files a no-index agent must read to answer. This is a
  *lower bound* on the file-reading path (no re-reads, no reasoning thrash), so
  the ratio is conservative in GIZEM's favor being understated the other way.

Run: `node dist/v3-bench.js <indexed-repo>` (`--json` for raw rows).

**Result (ARes, 20 questions):**

- **Aggregate 0.84% of baseline** — 9,473 GIZEM tokens vs 1,132,198 baseline
  tokens, a ~120× reduction. Mean per-question ratio 1.6%.
- **Every question ≤ 5.8%**; the tool never once approached the 10% bar.
- Biggest wins are the whole-codebase questions (cycles, subsystems, test-gap)
  where the baseline must sweep 51–97 files (100k–196k tokens) and GIZEM answers
  in 7–1,222 tokens — exactly where a derived index should dominate.

**Verdict: V3 passes with two orders of magnitude of headroom** (≤10% required,
0.84% measured).

## Real-client MCP conformance (Phase 1)

Registered the stdio server in Claude Code (`claude mcp add gizem -- node
dist/mcp-server.js --db <ws>/.gizem/index`) against indexed ARes and drove tool
calls from a live agent (`claude -p … --allowedTools mcp__gizem__*`): find_symbol
returned the correct `file:line`, module_map returned 3 subsystems / 45% drift,
analyze(cycles) reported no module cycles — all correct, all over real
JSON-RPC-through-a-client, not just the smoke harness.

**Bug this surfaced (fixed):** for Rust, `DEPENDS_ON` was **never populated** —
`rust.scm` captures `use` as an `@import.specifier` (feeding only resolution
narrowing), and the DEPENDS_ON-producing `@ref.reference` capture exists only for
non-Rust langs. So every DEPENDS_ON-backed tool (`module_map`, `file_deps`,
`analyze cycles`) returned empty on all Rust corpora, silently. Fixed by
resolving each non-glob `use` specifier into a `DEPENDS_ON` edge from the
importer's module symbol to the imported symbol (`codeStoreImpl.applyExtraction`,
spec §3). ARes now yields 62 cross-file DEPENDS_ON edges → 9 modules / 3
subsystems / 45% drift. Pinned by `resolver.test.ts` ("use statements create
cross-file DEPENDS_ON edges").

## Index time

77 s → 9.1 s on ARES during Phase 0 (measured at 862 symbols). A CPU profile showed the index was 91.7%
idle — never CPU-bound, but bound on Kuzu round-trips. Two changes, both
verified to leave every precision metric bit-identical:

1. **Batch writes into `UNWIND`** (69 s → 24.6 s). One `UNWIND` of 500 rows is
   ~8x faster than 500 `CREATE`s.
2. **Mirror the symbol table in memory** (24.6 s → 9.1 s). Resolution is pure
   lookup against a table only the indexer writes.

After the corpus fixes, ARES rose 9.1 s → 23 s and now also exceeds the < 15 s
budget — the inline-`mod` fix added ~170 symbols and their edges, and index cost
scales with symbol/edge volume. So the budget is currently missed on both repos
(ARES 23 s, ripgrep 27 s). The write path is already batched (`UNWIND`) and reads
are cached; the next lever is likely coarser transaction batching across files
rather than per-file. Re-profile before the Phase 4 10k-function bench (R9); this
does not block Phase 1.

## V4 gate — agent self-correction (2026-07-22): PASS

Seeded a real Tier-1 layering violation in ARES (`src/core/v4_seed.rs`
importing + calling `sim::longitudinal::integrate_bicycle` from core).
`gizem check` reported it with citations and the rule's `explain`. A live
`claude -p` agent (haiku) restricted to the gizem MCP tools + Read/Edit ran
`check_rules`, identified the violation, and self-corrected (removed the
breaching file, correctly noting `step_from_core` had no callers). Post-fix
`check` is clean — only the pre-existing tier-2 fan-out warning remains.

## R1 gate — Tier-1 false positives on ARES (2026-07-22): PASS (after fix)

The starter ruleset initially produced 2 Tier-1 layering FPs: both from the
`#[cfg(test)] mod tests` in `src/core/geom.rs`, whose tests deliberately drive
the *real* sim integrator (upward dep by design). Fixed at the extraction
level: refs/uses inside `#[cfg(test)]` mods / `#[test]` fns are flagged
`inTest`, reference edges carry a `test` column (schema v3), and
Layering/ForbiddenDep/VisibilityBoundary/NoCycles exclude test-origin edges.
Post-fix: **0 Tier-1 violations on ARES**, `resolvableMisses` 0, the seeded
violation above still detected (no lost recall on prod code).

## V5 — incremental latency after transactions + prepared statements (2026-07-22)

Two store changes (semantics verified bit-identical: fuzzyRate/resolvableMisses
unchanged):
1. **Explicit transactions**: applyExtraction/removeFile/resolvePending's write
   tail each run in one BEGIN/COMMIT. Auto-commit was flushing the WAL per
   statement — ~45 ms × ~17 statements on the grown ARES index.
2. **Parameterized UNWIND** (`execRows`): symbol/edge/pending batch inserts go
   through prepared statements with `$rows` bound as a parameter; literal
   UNWINDs made Kuzu re-parse megabyte struct literals (measured 10x slower).
   kuzu 0.11.3 trap: nulls inside param structs throw ("vector with ANY
   type") — nullable columns travel as sentinels ('' / -1) CASEd back to
   typed NULLs in the statement.

| Metric (ARES) | Before | After | Bar |
|---|---|---|---|
| incremental indexFile p50 | 140 ms | **58 ms** | — |
| incremental indexFile p95 | 638 ms | **125 ms** | < 100 ms |
| cold full index | 23 s | **4.5 s** | < 15 s ✓ |
| check after save | 72–103 ms | (unchanged) | < 200 ms ✓ |

p95 remains 25% over bar; the residual is tree-sitter parse (34 ms for the
55 KB maneuvers.rs) + the cascade DETACH DELETE (21 ms) on the single heaviest
file — statement overhead is gone. Next lever would be incremental parse trees,
out of v1 scope.

## V7 self-review — `gizem init` on ripgrep (2026-07-22)

Fresh clone, never previously configured. After fixes (workspace-aware layer
names, crate-granularity coarsening, one-dense-cluster per-module fallback,
test-edge exclusion in moduleMap): proposal names every crate correctly and
gets the extremes right (cli/globset foundational; tests on top), but middle
ranks scramble — **~40% pairwise agreement with the Cargo dependency DAG**
(printer/searcher/core inverted). Root cause is measured, not mysterious:
ripgrep's 74% fuzzyRate (S1 method-call deferral, documented worst case)
feeds direction inference noise. On ARES (48% fuzzy) the proposal matched the
maintainer's curated layering at the extremes (map foundational, ui/scenario
top) with the mid-stack flagged ambiguous. Every guess is emitted as a
finding — the proposal never claims more confidence than the graph supports.
V7's exit (external maintainer rates "mostly right") remains open; proposal
quality is resolver-precision-bound, so the v1.1 receiver-type inference is
the lever.
