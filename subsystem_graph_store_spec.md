# Subsystem Spec — Graph Store (`store/graph/`)

The KuzuDB access layer for the derived index. Dramatically simpler than its v1 ancestor: the graph is disposable, the **indexer is the only writer**, and there are no write-time guards because there are no agent writes.

Status: Draft · Addresses R4 (Kuzu bindings), O2 (concurrency), R2 (snapshots)

---

## 1. Responsibilities

- Own the KuzuDB instance under `.gizem/index/`; schema init + versioned migration (migration strategy for a disposable index: bump `schema_version` → drop → re-index).
- Serialize all writes through the indexer's single writer; hand out consistent read snapshots to every consumer (MCP tools, rule engine, CLI).
- Provide the atomic file-subgraph-replace primitive the indexer needs.

## 2. Public Interface

```ts
interface GraphStore {
  read<T>(cypher: string, params?: object): Promise<T[]>;      // snapshot-consistent
  snapshot(): ReadSnapshot;                                     // pinned view for a multi-query task
  /** Sole write path — called only by the indexer. FIFO, one txn at a time. */
  writeFileSubgraph(file: string, decls: Declaration[], edges: DerivedEdge[]): Promise<void>;
  meta(): IndexMeta;                                            // schema_version, full_index_at, unresolved_ratio
  reset(): Promise<void>;                                       // drop + recreate (disposable index)
}
```

No `Transaction` surface is exported: `writeFileSubgraph` is the one composite mutation (delete file's DECLARES closure + bulk-insert replacements) and it is atomic internally.

## 3. Concurrency Model (O2)

KuzuDB is embedded, single-writer, MVCC-read. Only one component ever writes:

```
Indexer ──(FIFO queue, 1 txn)──▶ KuzuDB ◀──(read snapshots)── MCP tools / rules / CLI / viz
```

- Readers never block and never see a torn file subgraph (atomic replace).
- The rule engine pins a `snapshot()` for the duration of a `check` run so all rules evaluate one consistent state.
- **Phase-0 spike S2** confirms Node-binding behavior for reads concurrent with an open write txn. Fallback if reads serialize behind writes: queue reads with a latency budget alarm; ultimate fallback: SQLite relational encoding (documented, not built).

## 4. Why There Is No Guard Engine

v1 ran Tier-1 guards at write time because the LLM authored the graph. In v2 the graph is *derived from reality* — an "invalid" structure in the graph means the code itself has that structure, which is precisely what the rule engine must report, not prevent. Correctness burden moves to the indexer (precision) and the rule engine (judgment). Rules run on read snapshots and never mutate.

## 5. Bulk & Performance

- Cold index uses Kuzu bulk-load (`COPY FROM` buffers) rather than per-node inserts — required for the 15 s / 500-fn target and the 10k-fn stretch (R9).
- Query latency budget < 50 ms (typical, ≤ 5k nodes); per-rule Cypher timings surfaced in `gizem stats`.

## 6. Exit Tests

- [ ] 100 queued file writes apply FIFO; concurrent `read` calls always return a consistent pre- or post-state, never partial (S2 evidence).
- [ ] `reset()` + `fullIndex()` reproduces an isomorphic graph (disposability proof).
- [ ] Schema migration: old `schema_version` triggers automatic clean re-index without user action.
- [ ] Cold index of 500-fn project < 15 s; typical query < 50 ms; both in CI bench.
- [ ] Bindings smoke suite green on Linux/macOS/Windows CI (R4).
