# Subsystem Spec — Indexer (`core/indexer/`)

The parse → resolve → extract pipeline that turns source files into the derived graph. This is the product's engine and its primary precision risk (R1). One-directional by design: it reads files and writes the graph; nothing ever flows back.

Status: Draft · Addresses R1 (precision), R2 (staleness), R7 (incremental drift), O1, O5, O6

**Reuse:** the parse/resolve/extract pipeline is **adapted from the reference indexer** (`vendor/reference-indexer/src/index/` — `parserRegistryImpl`, `extractorImpl`, `codeIndexerImpl`, two-pass `resolvePending` with `resolved`/`fuzzy` confidence, `types.ts` data model). Net-new here is only the KuzuDB store binding (see [`subsystem_graph_store_spec.md`](subsystem_graph_store_spec.md)) and Rust-precision measurement. Reused tests: `pipeline.test.ts` (golden model), `codeIndexerImpl.test.ts`, `types.test.ts`, `provenanceImpl.test.ts`. See [`vendor/reference-indexer/REUSE.md`](vendor/reference-indexer/REUSE.md).

---

## 1. Responsibilities

- Parse Rust source with tree-sitter; declare symbol nodes (Module, Function, Type, Param) with `file` + `span`.
- Resolve references (calls, type uses, field access) into edges, marking each `resolved: true|false`.
- Maintain `unresolved_ratio` and per-file freshness metadata.
- Incremental: on file change, replace exactly that file's declared subgraph.
- Never abort a run on one bad file: record `File{parse_error}` and continue.

## 2. Public Interface

```ts
interface Indexer {
  fullIndex(root: string): IndexReport;                  // cold, deterministic
  indexFile(path: string): FileIndexResult;              // incremental unit
  onFileChanged(path: string): void;                     // watcher entry (debounced)
  stats(): IndexStats;                                   // counts, unresolved_ratio, ages
}

interface FileIndexResult {
  declared: SymbolId[];            // nodes now DECLAREd by this file
  edges: { resolved: number; unresolved: number };
  parseErrors: SpanError[];
  elapsedMs: number;
}

interface IndexReport {
  files: number; functions: number; types: number;
  unresolvedRatio: number;         // the headline precision metric
  errors: FileError[];
  elapsedMs: number;
}
```

## 3. Pipeline

```
file bytes
  → tree-sitter parse (error-tolerant CST)
  → Pass 1 DECLARE: symbols + signature edges (PARAM/OF_TYPE/RETURNS/OWNS/DECLARES)
  → Pass 2 RESOLVE: build use-map + scope stack; resolve references
  → extract edges: CALLS / READS / WRITES / DEPENDS_ON / IMPLEMENTS  (+ resolved flag)
  → graph store txn: replace file subgraph atomically
```

Full index runs Pass 1 for **all** files before any Pass 2 (forward references). Incremental re-index runs both passes for the changed file against the existing symbol table, then re-resolves the set of *other* files whose unresolved references name symbols this file now declares/removed (tracked via an `unresolved-name → files` inverted map).

## 4. Resolution Strategy (O1 — the precision contract)

tree-sitter gives syntax, not semantics. The resolver layers, in order:

1. **`use`-map:** explicit imports, renames (`as`), glob imports (flagged lower-confidence).
2. **Scope stack:** locals/params shadow items; module-local items; `super`/`crate` paths.
3. **Inherent-method heuristic:** `recv.method()` resolved when receiver type is locally inferable (let-binding with explicit type, param type, field type); otherwise unresolved.
4. **Trait methods, macro-generated items, dynamic dispatch:** **unresolved by design** in v1 — stored as `CALLS {resolved: false, name}`.

Rules of the contract:
- Never guess silently: a resolution below confidence threshold is stored unresolved, not wrong.
- `unresolved_ratio` = unresolved reference edges / total reference edges, per file and global; exposed in every MCP response and `gizem stats`.
- **Precision upgrade path (post-MVP / v1.1):** a `syn`-based signature+impl pass, or rust-analyzer as an optional sidecar resolver. Triggered by measured need, not speculation.

## 5. Incremental Correctness (R7)

**Invariant:** for any edit sequence, `incrementalIndex(edits)` produces a graph isomorphic to `fullIndex(finalState)`.

Enforced by:
- File subgraph replacement is atomic (one store txn): delete all nodes/edges `DECLARE`d by the file, insert fresh.
- Cross-file re-resolution via the unresolved-name inverted map (§3).
- CI property test (plan V8): 100 random edits on the golden corpus → isomorphism check vs. cold index.

Staleness (R2): watcher debounce 150 ms; `check_rules` and CI paths force a flush (`awaitFresh()`) before evaluating; every graph answer carries `index_age_ms`.

## 6. Failure Modes

| Input | Behavior |
|-------|----------|
| Syntax-broken file (mid-edit) | Keep previous subgraph, mark `File{parse_error, stale:true}`, retry on next change |
| File deleted | Remove subgraph; names it declared go to unresolved on referencing files (re-resolve them) |
| Non-Rust / generated / target dirs | Excluded by default ignore set (`target/`, `.git/`); configurable |
| Huge file (>1 MB) | Index with warning; span-only bodies are never stored (graph holds no body text — only spans) |

Note the last row: **the graph stores no code text**, only names, signatures, spans, and edges. Reading code stays the agent's file tools' job — GIZEM tells it exactly where to look.

## 7. Exit Tests (green ⇒ R1/R7 downgrade)

- [ ] Golden corpus (40+ fixtures): declared symbols and resolved edges exactly match expectations.
- [ ] ARES: `unresolved_ratio` ≤ 10%; published per-category breakdown (plain calls / methods / traits / macros).
- [ ] Public-repo bench (`ripgrep` + 1 service repo): indexes clean, numbers published.
- [ ] Incremental ≡ full property test, 100 random edits (V8).
- [ ] Single-file re-index < 100 ms p95 on ARES (V5).
- [ ] Broken-file resilience: syntax error in one file leaves the rest of the graph intact and queryable.
