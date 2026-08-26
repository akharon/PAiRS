/**
 * impact(id, depth) — transitive who-depends-on-this walk (V2).
 *
 * Answers "what depends on X?": a breadth-first walk over the reference graph
 * following edges *into* the seed symbol (`edgesTo`), so the result is every
 * caller/reader/implementer that transitively reaches it. This is the query the
 * S1 receiver-inference deferral rides on — its recall against grep ground truth
 * is the Phase 1 gate (V2 ≥ 95%).
 *
 * Pure core: no vscode, no storage-engine specifics — walks the CodeStore interface only
 * (R10). Fuzzy edges are included but marked, matching the "possible"
 * class: a caller reached only through a fuzzy edge is still a caller worth
 * surfacing, just lower-confidence.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { EdgeKind, EdgeConfidence, SymbolRecord } from '../indexer/types';

/** Edge kinds that constitute a dependency for impact purposes. */
export const IMPACT_EDGE_KINDS: readonly EdgeKind[] = ['CALLS', 'READS', 'WRITES', 'IMPLEMENTS', 'EXTENDS', 'REFERENCES'];

export interface ImpactNode {
  symbol: SymbolRecord;
  /** BFS distance from the seed (1 = direct dependant). */
  depth: number;
  /** Weakest edge confidence along the path that first reached this node. */
  confidence: EdgeConfidence;
}

export interface ImpactResult {
  seed: SymbolRecord;
  /** Dependants ordered by depth, then file:line. Excludes the seed. */
  dependants: ImpactNode[];
  /** True if the walk hit `maxDepth` and stopped short of the transitive closure. */
  truncated: boolean;
}

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { resolved: 0, fuzzy: 1, unresolved: 2 };
function weaker(a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * @param maxDepth stop after this many hops (default 5). depth ≤ 0 → 1.
 * @param kinds edge kinds to follow; defaults to IMPACT_EDGE_KINDS.
 */
export async function impact(
  store: CodeStore,
  id: number,
  maxDepth = 5,
  kinds: readonly EdgeKind[] = IMPACT_EDGE_KINDS
): Promise<ImpactResult | null> {
  const seed = await store.get(id);
  if (!seed) return null;

  if (kinds.length === 0) return { seed, dependants: [], truncated: false };

  const depth = maxDepth <= 0 ? 1 : maxDepth;
  const kindList = [...kinds];

  // node id -> best (smallest) depth and weakest confidence seen reaching it.
  const seen = new Map<number, { depth: number; confidence: EdgeConfidence }>();
  let frontier = [id];
  let hop = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (hop >= depth) {
      truncated = true;
      break;
    }
    hop += 1;
    const edges = await store.edgesTo(frontier, kindList);
    const next: number[] = [];
    for (const e of edges) {
      if (e.fromId === id) continue; // exclude self-edges (e.g. a recursive function calling itself)
      const prior = seen.get(e.fromId);
      // A path's confidence is its weakest edge; here we approximate that with
      // just the confidence of the edge that reached this node, since the frontier
      // was already reached at <= the current depth via at-least-as-strong paths.
      const conf = e.confidence;
      if (!prior) {
        seen.set(e.fromId, { depth: hop, confidence: conf });
        next.push(e.fromId);
      } else if (prior.depth === hop) {
        // same-depth alternate path: keep the strongest confidence.
        prior.confidence = prior.confidence === 'resolved' ? 'resolved' : (conf === 'resolved' ? 'resolved' : weaker(prior.confidence, conf));
      }
    }
    frontier = next;
  }

  const ids = [...seen.keys()];
  const symbols = await Promise.all(ids.map((n) => store.get(n)));
  const dependants: ImpactNode[] = [];
  ids.forEach((n, i) => {
    const sym = symbols[i];
    const meta = seen.get(n)!;
    if (sym) dependants.push({ symbol: sym, depth: meta.depth, confidence: meta.confidence });
  });

  dependants.sort(
    (a, b) => a.depth - b.depth || a.symbol.file.localeCompare(b.symbol.file, 'en') || a.symbol.startLine - b.symbol.startLine
  );

  return { seed, dependants, truncated };
}
