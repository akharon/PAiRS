/**
 * module_map (plan.md 1.5) — the module dependency graph, its community
 * structure (Louvain), and explicit-vs-implicit drift.
 *
 * "Module" = a file's directory: in Rust the module path is the file path, so a
 * directory is a natural module boundary without needing declared module
 * metadata. Edges are the file-level DEPENDS_ON graph aggregated to directories,
 * weighted by how many file→file dependencies cross the pair.
 *
 * Louvain groups modules that depend on each other densely into clusters
 * ("subsystems"). driftRatio = edges that cross cluster boundaries: a high
 * cross-cluster ratio means the dependency graph itself doesn't partition
 * cleanly. layoutDrift is the complementary, actually-explicit-vs-implicit
 * signal: how much the *detected* clusters disagree with the *directory tree*
 * partition (top-level segment) — see layoutDrift() below.
 *
 * On top of the clustering the map carries the objective structure too:
 * per-module fan-in/fan-out + Martin instability, the dependency layer
 * (longest path over the cycle-condensed graph), and the module cycles
 * themselves (SCCs). Clustering is a judgement call; cycles and layers are
 * not, and they are what a refactor actually has to respect.
 *
 * Pure core: walks the CodeStore query() escape hatch only, no vscode/store
 * specifics. Louvain is self-contained (no graph library) — a multi-level
 * modularity-gain pass, deterministic given a stable node order.
 */

import type { CodeStore } from '../../store/graph/codeStore';

export interface ModuleCluster {
  id: number;
  modules: string[];
}

/** Per-module structural facts, derived from the module edge list (+ store sizes when available). */
export interface ModuleMetric {
  module: string;
  /** Louvain subsystem the module belongs to. */
  cluster: number;
  /** Distinct modules that depend on this one. */
  fanIn: number;
  /** Distinct modules this one depends on. */
  fanOut: number;
  /** Inbound / outbound edge weight (confidence-weighted file deps). */
  weightIn: number;
  weightOut: number;
  /**
   * Martin instability, fanOut / (fanIn + fanOut): 0 = pure foundation (only
   * depended on), 1 = pure leaf (only depends). 0.5 for an isolated module.
   */
  instability: number;
  /**
   * Dependency depth over the cycle-condensed graph: 0 = depends on no other
   * module, N = longest chain of N modules below it. Modules inside one cycle
   * share a layer (a cycle has no internal ordering).
   */
  layer: number;
  /** Files / symbols in the module; 0 when the store didn't report sizes. */
  files: number;
  symbols: number;
  /**
   * Share of the module's dependency traffic that stays inside it:
   * internal / (internal + inbound + outbound). 1 = self-contained, 0 = every
   * dependency it has crosses a boundary (a pass-through or a junk drawer).
   * `null` for single-file modules, where the measure is meaningless — the
   * map is built from file→file edges, so a one-file module can never show
   * internal traffic.
   */
  cohesion: number | null;
}

/** Per-module facts that don't come from the module edge list itself. */
export interface ModuleFacts {
  files: number;
  symbols: number;
  /** Weight of file→file deps that stay within the module. */
  internalWeight: number;
}

export type ModuleFactsMap = ReadonlyMap<string, ModuleFacts>;

export interface ModuleMapOptions {
  /**
   * Collapse module keys to this many leading path segments after any
   * monorepo-container roll-up (see moduleKeyOf). Omitted = full directory
   * granularity. Use to keep large monorepos legible.
   */
  depth?: number;
  /** Louvain resolution (γ). >1 favors more, smaller clusters; <1 favors fewer, larger ones. Default 1. */
  resolution?: number;
}

export interface ModuleMap {
  /** Directory-level modules, sorted. */
  modules: string[];
  /** Directed weighted edges between modules (from → to), weight = confidence-weighted #file deps. */
  edges: Array<{ from: string; to: string; weight: number }>;
  /** Louvain communities over the (undirected) module graph. */
  clusters: ModuleCluster[];
  /** Fraction of edge weight that crosses cluster boundaries (0 = perfectly modular dependency graph). */
  driftRatio: number;
  /** Cross-cluster edges, heaviest first — the concrete drift to inspect. */
  drift: Array<{ from: string; to: string; weight: number }>;
  /**
   * Agreement (Adjusted Rand Index, -1..1) between the Louvain partition and
   * the directory-tree partition (top-level path segment). 1 = clusters
   * exactly match the folder layout; 0 = no better than chance; negative =
   * systematically worse than chance. This is the actual "does the explicit
   * layout match the implicit dependency structure" signal.
   */
  layoutDrift: number;
  /** Per-module fan-in/out, instability and dependency layer, sorted by module. */
  metrics: ModuleMetric[];
  /**
   * Module dependency cycles: strongly-connected components of size ≥ 2,
   * largest first. Unlike drift (a clustering judgement) these are objective —
   * no layering can be valid while they exist.
   */
  cycles: string[][];
  /**
   * Edges whose removal makes the module graph acyclic — the concrete answer
   * to "how do I break these cycles", cheapest-first. Greedy, so not provably
   * minimal, but it is a real cut set: remove all of them and no cycle
   * remains. Empty when there are no cycles.
   */
  cycleCuts: Array<{ from: string; to: string; weight: number }>;
}

const SCAFFOLD_SEGMENTS = new Set(['src', 'crates', 'packages', 'libs', 'apps', 'lib']);

/**
 * Module key for a file: directory path, with monorepo container segments
 * (`crates`, `packages`, ...) rolled into `container/name` so a cargo
 * workspace doesn't degenerate into meaningless per-container noise (shared
 * with initProposal's former private `coarsen`/`layerName` logic).
 * `depth` (if given) further collapses to that many leading segments.
 */
export function moduleKeyOf(file: string, opts: ModuleMapOptions = {}): string {
  const dir = (() => {
    const i = file.lastIndexOf('/');
    return i < 0 ? '.' : file.slice(0, i);
  })();
  let segs = dir.split('/');
  if (segs.length >= 2 && SCAFFOLD_SEGMENTS.has(segs[0]!) && segs[0] !== 'src') {
    segs = segs.slice(0, 2);
  }
  if (opts.depth && opts.depth > 0 && segs.length > opts.depth) {
    segs = segs.slice(0, opts.depth);
  }
  return segs.join('/');
}

export async function moduleMap(store: CodeStore, opts: ModuleMapOptions = {}): Promise<ModuleMap> {
  // Every file→file DEPENDS_ON edge, aggregated to module→module weights.
  // Test-origin edges excluded (`#[cfg(test)]` uses are not architecture).
  // Fuzzy edges stay IN but count for less: on a cargo workspace every
  // cross-crate `use` caps at fuzzy (multi-candidate names, R1 gate), so
  // confirmed-only starves the map to zero modules — tried and reverted
  // during the V7 self-review. Down-weighting instead of dropping keeps that
  // signal while not letting ambiguous edges dominate the drift calculation.
  const rows = await store.query(
    `SELECT a.file AS af, b.file AS bf, e.confidence AS conf, COUNT(*) AS n
     FROM Edge e
     JOIN Symbol a ON a.id = e.src
     JOIN Symbol b ON b.id = e.dst
     WHERE e.kind = 'DEPENDS_ON' AND a.file <> b.file AND COALESCE(e.test, 0) = 0
     GROUP BY a.file, b.file, e.confidence`
  );

  const weight = new Map<string, number>(); // "from to" -> weight
  const moduleSet = new Set<string>();
  const internal = new Map<string, number>();
  for (const r of rows) {
    const from = moduleKeyOf(String(r.af), opts);
    const to = moduleKeyOf(String(r.bf), opts);
    const n = Number(r.n);
    const w = r.conf === 'fuzzy' ? n * 0.5 : n;
    // Same-module file deps don't belong on the graph, but they are exactly
    // the cohesion signal: a module whose files never reference each other is
    // a folder, not a module.
    if (from === to) {
      internal.set(from, (internal.get(from) ?? 0) + w);
      continue;
    }
    moduleSet.add(from);
    moduleSet.add(to);
    const key = `${from} ${to}`;
    weight.set(key, (weight.get(key) ?? 0) + w);
  }

  const modules = [...moduleSet].sort();
  const edges = [...weight.entries()].map(([k, w]) => {
    const [from, to] = k.split(' ');
    return { from: from!, to: to!, weight: w };
  });

  return moduleMapFromEdges(modules, edges, opts, await moduleFacts(store, opts, internal));
}

/**
 * Files + symbols per module (so the view can weight a node by how much code
 * it actually holds — a 40-file module and a 1-file module are not the same
 * architectural object), joined with the internal dependency weight collected
 * above. Best-effort: a store that can't answer the size query still gets its
 * internal weights, and the size-derived fields stay at 0.
 */
async function moduleFacts(
  store: CodeStore,
  opts: ModuleMapOptions,
  internal: ReadonlyMap<string, number>
): Promise<ModuleFactsMap> {
  const facts = new Map<string, ModuleFacts>();
  const factsFor = (key: string): ModuleFacts => {
    const cur = facts.get(key) ?? { files: 0, symbols: 0, internalWeight: internal.get(key) ?? 0 };
    facts.set(key, cur);
    return cur;
  };
  for (const key of internal.keys()) factsFor(key);

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await store.query(`SELECT file AS f, COUNT(*) AS n FROM Symbol GROUP BY file`);
  } catch {
    return facts;
  }
  for (const r of rows) {
    if (typeof r.f !== 'string') continue; // defensive: unexpected row shape → no sizes, not garbage
    const cur = factsFor(moduleKeyOf(r.f, opts));
    cur.files += 1;
    cur.symbols += Number(r.n) || 0;
  }
  return facts;
}

/** Cluster + drift over an already-built module edge list (initProposal re-clusters at crate granularity). */
export function moduleMapFromEdges(
  modules: string[],
  edges: Array<{ from: string; to: string; weight: number }>,
  opts: ModuleMapOptions = {},
  facts: ModuleFactsMap = new Map()
): ModuleMap {
  const clusters = louvain(modules, edges, opts.resolution ?? 1);
  const clusterOf = new Map<string, number>();
  clusters.forEach((c) => c.modules.forEach((m) => clusterOf.set(m, c.id)));

  let crossWeight = 0;
  let totalWeight = 0;
  const drift: Array<{ from: string; to: string; weight: number }> = [];
  for (const e of edges) {
    totalWeight += e.weight;
    if (clusterOf.get(e.from) !== clusterOf.get(e.to)) {
      crossWeight += e.weight;
      drift.push(e);
    }
  }
  drift.sort((a, b) => b.weight - a.weight);

  const { components, layerOf } = condense(modules, edges);
  const cycles = components
    .filter((c) => c.length > 1)
    .map((c) => [...c].sort())
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));

  return {
    modules,
    edges,
    clusters,
    driftRatio: totalWeight > 0 ? crossWeight / totalWeight : 0,
    drift,
    layoutDrift: layoutAgreement(modules, clusters),
    metrics: moduleMetrics(modules, edges, clusterOf, layerOf, facts),
    cycles,
    cycleCuts: cycles.length === 0 ? [] : greedyCutSet(modules, edges),
  };
}

/**
 * Cheapest-first feedback edge set: keep removing the lightest edge that still
 * sits inside a cycle until none is left. Greedy (a true minimum feedback arc
 * set is NP-hard) but the result is always a valid cut, and "delete these two
 * light edges" is the only form of cycle report anyone can act on.
 *
 * Cost is one SCC pass per removal, over the module graph only — tens to a few
 * hundred nodes. Cycles are rare enough that this never runs on a clean repo.
 */
function greedyCutSet(
  modules: string[],
  edges: Array<{ from: string; to: string; weight: number }>
): Array<{ from: string; to: string; weight: number }> {
  const cut: Array<{ from: string; to: string; weight: number }> = [];
  let remaining = [...edges];
  for (;;) {
    const comps = condense(modules, remaining).components.filter((c) => c.length > 1);
    if (comps.length === 0) return cut;
    const inCycle = new Map<string, number>();
    comps.forEach((c, i) => c.forEach((m) => inCycle.set(m, i)));
    // Only edges whose endpoints share an SCC can be part of a cycle.
    const candidates = remaining.filter((e) => inCycle.has(e.from) && inCycle.get(e.from) === inCycle.get(e.to));
    if (candidates.length === 0) return cut; // defensive: an SCC with no internal edge can't happen
    const victim = candidates.reduce((best, e) =>
      e.weight < best.weight || (e.weight === best.weight && `${e.from} ${e.to}` < `${best.from} ${best.to}`) ? e : best
    );
    cut.push(victim);
    remaining = remaining.filter((e) => e !== victim);
  }
}

function moduleMetrics(
  modules: string[],
  edges: Array<{ from: string; to: string; weight: number }>,
  clusterOf: Map<string, number>,
  layerOf: Map<string, number>,
  facts: ModuleFactsMap
): ModuleMetric[] {
  const inn = new Map<string, { n: number; w: number }>();
  const out = new Map<string, { n: number; w: number }>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const o = out.get(e.from) ?? { n: 0, w: 0 };
    o.n += 1;
    o.w += e.weight;
    out.set(e.from, o);
    const i = inn.get(e.to) ?? { n: 0, w: 0 };
    i.n += 1;
    i.w += e.weight;
    inn.set(e.to, i);
  }
  return modules.map((m) => {
    const i = inn.get(m) ?? { n: 0, w: 0 };
    const o = out.get(m) ?? { n: 0, w: 0 };
    const f = facts.get(m) ?? { files: 0, symbols: 0, internalWeight: 0 };
    const traffic = f.internalWeight + i.w + o.w;
    return {
      module: m,
      cluster: clusterOf.get(m) ?? -1,
      fanIn: i.n,
      fanOut: o.n,
      weightIn: i.w,
      weightOut: o.w,
      instability: i.n + o.n === 0 ? 0.5 : o.n / (i.n + o.n),
      layer: layerOf.get(m) ?? 0,
      files: f.files,
      symbols: f.symbols,
      cohesion: f.files < 2 || traffic === 0 ? null : f.internalWeight / traffic,
    };
  });
}

/**
 * Tarjan SCC + condensation depth. Two outputs in one pass because they need
 * the same structure: the components are the module cycles, and the longest
 * path over the condensed (necessarily acyclic) graph is the dependency layer
 * — the only depth that is well-defined when cycles exist, since a cycle's
 * members cannot be ordered relative to each other.
 *
 * Iterative, not recursive: a deep monorepo dependency chain would blow the
 * call stack on a recursive Tarjan.
 */
function condense(
  modules: string[],
  edges: Array<{ from: string; to: string; weight: number }>
): { components: string[][]; layerOf: Map<string, number> } {
  const idx = new Map(modules.map((m, i) => [m, i]));
  const n = modules.length;
  const succ: number[][] = modules.map(() => []);
  for (const e of edges) {
    const u = idx.get(e.from);
    const v = idx.get(e.to);
    if (u === undefined || v === undefined || u === v) continue;
    succ[u]!.push(v);
  }

  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const compOf = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: Array<{ v: number; next: number }> = [{ v: root, next: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.v;
      let descended = false;
      while (frame.next < succ[v]!.length) {
        const w = succ[v]![frame.next++]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push({ v: w, next: 0 });
          descended = true;
          break;
        }
        if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
      }
      if (descended) continue;

      if (low[v] === index[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = 0;
          compOf[w] = components.length;
          comp.push(w);
          if (w === v) break;
        }
        components.push(comp);
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low[parent.v] = Math.min(low[parent.v]!, low[v]!);
    }
  }

  // Tarjan emits components in reverse topological order, so every successor
  // component is already scored when a component is visited — one linear pass
  // gives the longest-path depth without a second traversal.
  const compLayer = new Int32Array(components.length);
  components.forEach((comp, c) => {
    let depth = 0;
    for (const v of comp) {
      for (const w of succ[v]!) {
        const cw = compOf[w]!;
        if (cw !== c) depth = Math.max(depth, compLayer[cw]! + 1);
      }
    }
    compLayer[c] = depth;
  });

  const layerOf = new Map<string, number>();
  modules.forEach((m, i) => layerOf.set(m, compLayer[compOf[i]!]!));
  return { components: components.map((c) => c.map((i) => modules[i]!)), layerOf };
}

/** Directory-tree partition: group modules by their top-level path segment. */
function directoryPartition(modules: string[]): Map<string, string> {
  const part = new Map<string, string>();
  for (const m of modules) part.set(m, m.split('/')[0] ?? m);
  return part;
}

/**
 * Adjusted Rand Index between the Louvain partition and the directory-tree
 * partition — the actual "explicit layout vs implicit dependency structure"
 * agreement measure. 1 = identical partitions, 0 = chance-level agreement,
 * negative = worse than chance.
 */
function layoutAgreement(modules: string[], clusters: ModuleCluster[]): number {
  const n = modules.length;
  if (n < 2) return 1;

  const louvainOf = new Map<string, number>();
  clusters.forEach((c) => c.modules.forEach((m) => louvainOf.set(m, c.id)));
  const dirPart = directoryPartition(modules);
  const dirIds = new Map<string, number>();
  for (const d of dirPart.values()) if (!dirIds.has(d)) dirIds.set(d, dirIds.size);

  // Contingency table: count[louvainCluster][dirCluster].
  const count = new Map<string, number>();
  const rowSum = new Map<number, number>();
  const colSum = new Map<number, number>();
  for (const m of modules) {
    const a = louvainOf.get(m)!;
    const b = dirIds.get(dirPart.get(m)!)!;
    count.set(`${a} ${b}`, (count.get(`${a} ${b}`) ?? 0) + 1);
    rowSum.set(a, (rowSum.get(a) ?? 0) + 1);
    colSum.set(b, (colSum.get(b) ?? 0) + 1);
  }

  const comb2 = (x: number): number => (x * (x - 1)) / 2;
  const sumComb = (m: Map<number, number>): number => [...m.values()].reduce((s, v) => s + comb2(v), 0);

  const indexTerm = [...count.values()].reduce((s, v) => s + comb2(v), 0);
  const rowTerm = sumComb(rowSum);
  const colTerm = sumComb(colSum);
  const nTerm = comb2(n);
  const expected = (rowTerm * colTerm) / (nTerm || 1);
  const maxIndex = (rowTerm + colTerm) / 2;
  const denom = maxIndex - expected;

  return denom === 0 ? 1 : (indexTerm - expected) / denom;
}

/**
 * Louvain community detection: repeated local-move + aggregation rounds
 * until a round produces no aggregation (no move improves modularity even
 * at the coarsened level). Operates on the undirected, weight-summed
 * projection of the directed edges. Deterministic: nodes are visited in the
 * given (sorted) order at every level.
 *
 * `resolution` (γ) scales the null-model term in the gain: >1 makes large
 * merges less attractive (more, smaller clusters), <1 the opposite — without
 * it, large graphs collapse past the modularity resolution limit into a
 * handful of blobs.
 */
function louvain(
  nodes: string[],
  directed: Array<{ from: string; to: string; weight: number }>,
  resolution: number
): ModuleCluster[] {
  if (nodes.length === 0) return [];

  const idx = new Map(nodes.map((n, i) => [n, i]));
  let n = nodes.length;
  let adj: Array<Map<number, number>> = nodes.map(() => new Map());
  let selfLoop: number[] = nodes.map(() => 0);
  let m2 = 0;
  for (const e of directed) {
    const u = idx.get(e.from)!;
    const v = idx.get(e.to)!;
    if (u === v) continue;
    adj[u]!.set(v, (adj[u]!.get(v) ?? 0) + e.weight);
    adj[v]!.set(u, (adj[v]!.get(u) ?? 0) + e.weight);
    m2 += 2 * e.weight;
  }
  if (m2 === 0) {
    return nodes.map((mod, i) => ({ id: i, modules: [mod] }));
  }

  // membership[level][nodeAtLevel] = community id at that level; base nodes
  // are tracked through every level via baseMembers.
  let baseMembers: string[][] = nodes.map((mod) => [mod]);

  for (;;) {
    const { comm, moved } = localMove(n, adj, selfLoop, m2, resolution);
    if (!moved) break;

    // Aggregate: each distinct community becomes one node at the next level.
    const label = new Map<number, number>();
    for (let node = 0; node < n; node++) {
      const c = comm[node]!;
      if (!label.has(c)) label.set(c, label.size);
    }
    const nextN = label.size;
    if (nextN === n) break; // no actual merge happened

    const nextMembers: string[][] = Array.from({ length: nextN }, () => []);
    for (let node = 0; node < n; node++) {
      nextMembers[label.get(comm[node]!)!]!.push(...baseMembers[node]!);
    }

    // Intra-community edges fold into a self-loop (kept, not dropped) so the
    // aggregated node's degree — and therefore m2, the null-model term — stays
    // consistent with the original graph across levels. Dropping them instead
    // (as an earlier version did) understates deg/m2 at level 2+ and makes any
    // remaining cross-community edge look artificially attractive, collapsing
    // unrelated clusters into one.
    const nextAdj: Array<Map<number, number>> = Array.from({ length: nextN }, () => new Map());
    const nextSelfLoop: number[] = Array.from({ length: nextN }, () => 0);
    for (let u = 0; u < n; u++) {
      const cu = label.get(comm[u]!)!;
      nextSelfLoop[cu]! += selfLoop[u]!;
      for (const [v, w] of adj[u]!) {
        const cv = label.get(comm[v]!)!;
        if (cu === cv) {
          nextSelfLoop[cu]! += w / 2; // each undirected edge counted from both endpoints
          continue;
        }
        nextAdj[cu]!.set(cv, (nextAdj[cu]!.get(cv) ?? 0) + w);
      }
    }

    baseMembers = nextMembers;
    adj = nextAdj;
    selfLoop = nextSelfLoop;
    n = nextN;
  }

  return baseMembers.map((modules, id) => ({ id, modules: [...modules].sort() }));
}

/** One Louvain local-move pass (no aggregation) over the given weighted adjacency. */
function localMove(
  n: number,
  adj: Array<Map<number, number>>,
  selfLoop: number[],
  m2: number,
  resolution: number
): { comm: number[]; moved: boolean } {
  const deg = adj.map((a, i) => [...a.values()].reduce((s, w) => s + w, 0) + 2 * selfLoop[i]!);
  const comm = Array.from({ length: n }, (_, i) => i);
  const commTot = deg.slice();

  const modularityGain = (node: number, target: number, kIn: number): number =>
    kIn - (resolution * commTot[target]! * deg[node]!) / m2;

  let everMoved = false;
  let improved = true;
  while (improved) {
    improved = false;
    for (let node = 0; node < n; node++) {
      const cur = comm[node]!;
      const wTo = new Map<number, number>();
      for (const [nb, w] of adj[node]!) {
        const c = comm[nb]!;
        wTo.set(c, (wTo.get(c) ?? 0) + w);
      }
      commTot[cur]! -= deg[node]!;
      const kInCur = wTo.get(cur) ?? 0;

      let bestComm = cur;
      let bestGain = modularityGain(node, cur, kInCur);
      for (const [c, kIn] of wTo) {
        if (c === cur) continue;
        const gain = modularityGain(node, c, kIn);
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestComm = c;
        }
      }
      commTot[bestComm]! += deg[node]!;
      comm[node] = bestComm;
      if (bestComm !== cur) {
        improved = true;
        everMoved = true;
      }
    }
  }

  return { comm, moved: everMoved };
}
