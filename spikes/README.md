# Phase 0 spikes

## S1 — resolver precision (O1)

**Run against the real resolver, not an estimate.** There is no S1 script: the CLI
already exposes the authoritative numbers, and a separate re-implementation would
measure something subtly different from what ships.

```sh
npm run build && npm run fetch-grammars
cd <rust-project>
node <gizem>/dist/cli.js index   # reports fuzzyRate / resolvableMisses / externalRefs
node <gizem>/dist/cli.js stats   # same, plus byKind
```

`index` now reports the S1 metrics directly — no ad-hoc queries needed:

- **`fuzzyRate`** — the precision number (R1). fuzzy ÷ all reference edges.
- **`resolvableMisses`** — unresolved refs that name a workspace symbol. Genuine
  resolver bugs; **expected 0**. Anything else is a regression.
- **`externalRefs`** — stdlib/dependency calls. Correctly unresolved (GIZEM
  indexes workspace code only), excluded from precision.
- `unresolvedRatio` — retained as a workload descriptor, **not** a precision
  metric: it is dominated by `externalRefs`. See plan.md S1.

To break down where fuzzy edges come from:

```sh
node <gizem>/dist/cli.js query \
  "MATCH (a)-[e:CALLS]->(b) WHERE e.confidence='fuzzy'
   RETURN b.name AS callee, count(e) AS c ORDER BY c DESC LIMIT 10"
```

The resolver ladder these numbers depend on is pinned by
`src/store/graph/resolver.test.ts` (real Kuzu, not a fake). Full results in
`plan.md`.

## S2 — Kuzu concurrency (O2)

```sh
node spikes/s2-kuzu-concurrency.mjs                 # concurrency check (PASSes)
GIZEM_S2_VARIANT=1 node spikes/s2-kuzu-concurrency.mjs   # conn.close(); db.close() -> SIGSEGV
GIZEM_S2_VARIANT=2 node spikes/s2-kuzu-concurrency.mjs   # db.close()               -> SIGSEGV
GIZEM_S2_VARIANT=3 node spikes/s2-kuzu-concurrency.mjs   # no close()               -> clean
```

Doubles as the regression test for the `db.close()` segfault that forces
`KuzuCodeStore.dispose()` to be a no-op. Requires Node 22.
