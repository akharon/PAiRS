/**
 * hierarchy(id, depth) — inheritance/interface tree around a symbol.
 *
 * Answers "what does X extend/implement?" (ancestors, walking `edgesFrom`)
 * and "what extends/implements X?" (descendants, walking `edgesTo`), both
 * restricted to EXTENDS/IMPLEMENTS edges. Same BFS shape as impact(), but
 * two-directional and scoped to inheritance edges only — impact() folds
 * EXTENDS/IMPLEMENTS into a broader dependant walk (CALLS/READS/WRITES/...)
 * and doesn't separate ancestors from descendants.
 *
 * Pure core: no vscode, no storage-engine specifics — walks the CodeStore interface only.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { EdgeKind, EdgeConfidence, SymbolRecord } from '../indexer/types';

export const HIERARCHY_EDGE_KINDS: readonly EdgeKind[] = ['EXTENDS', 'IMPLEMENTS'];

export interface HierarchyNode {
  symbol: SymbolRecord;
  /** BFS distance from the seed (1 = direct ancestor/descendant). */
  depth: number;
  confidence: EdgeConfidence;
}

export interface HierarchyResult {
  seed: SymbolRecord;
  /** What the seed extends/implements, ordered by depth then file:line. */
  ancestors: HierarchyNode[];
  /** What extends/implements the seed, ordered by depth then file:line. */
  descendants: HierarchyNode[];
  ancestorsTruncated: boolean;
  descendantsTruncated: boolean;
}

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { resolved: 0, fuzzy: 1, unresolved: 2 };
function weaker(a: EdgeConfidence, b: EdgeConfidence): EdgeConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** BFS over one direction (edgesFrom = ancestors, edgesTo = descendants). */
async function walk(
  store: CodeStore,
  seedId: number,
  maxDepth: number,
  edgeFn: (ids: number[], kinds: EdgeKind[]) => Promise<{ fromId: number; toId: number; confidence: EdgeConfidence }[]>,
  pick: (e: { fromId: number; toId: number }) => number
): Promise<{ nodes: HierarchyNode[]; truncated: boolean }> {
  const seen = new Map<number, { depth: number; confidence: EdgeConfidence }>();
  let frontier = [seedId];
  let hop = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (hop >= maxDepth) {
      truncated = true;
      break;
    }
    hop += 1;
    const edges = await edgeFn(frontier, [...HIERARCHY_EDGE_KINDS]);
    const next: number[] = [];
    for (const e of edges) {
      const nodeId = pick(e);
      if (nodeId === seedId) continue;
      const prior = seen.get(nodeId);
      if (!prior) {
        seen.set(nodeId, { depth: hop, confidence: e.confidence });
        next.push(nodeId);
      } else if (prior.depth === hop) {
        prior.confidence = weaker(prior.confidence, e.confidence);
      }
    }
    frontier = next;
  }

  const ids = [...seen.keys()];
  const symbols = await store.getMany(ids);
  const nodes: HierarchyNode[] = [];
  ids.forEach((n) => {
    const sym = symbols.get(n);
    const meta = seen.get(n)!;
    if (sym) nodes.push({ symbol: sym, depth: meta.depth, confidence: meta.confidence });
  });
  nodes.sort(
    (a, b) => a.depth - b.depth || a.symbol.file.localeCompare(b.symbol.file, 'en') || a.symbol.startLine - b.symbol.startLine
  );
  return { nodes, truncated };
}

/**
 * @param maxDepth stop after this many hops (default 5). depth ≤ 0 → 1.
 */
export async function hierarchy(store: CodeStore, id: number, maxDepth = 5): Promise<HierarchyResult | null> {
  const seed = await store.get(id);
  if (!seed) return null;

  const depth = maxDepth <= 0 ? 1 : maxDepth;

  const [up, down] = await Promise.all([
    // Ancestors: edges FROM the seed (X EXTENDS Base) — the seed side is fromId.
    walk(store, id, depth, (ids, kinds) => store.edgesFrom(ids, kinds), (e) => e.toId),
    // Descendants: edges TO the seed (Sub EXTENDS X) — the seed side is toId.
    walk(store, id, depth, (ids, kinds) => store.edgesTo(ids, kinds), (e) => e.fromId),
  ]);

  return {
    seed,
    ancestors: up.nodes,
    descendants: down.nodes,
    ancestorsTruncated: up.truncated,
    descendantsTruncated: down.truncated,
  };
}
