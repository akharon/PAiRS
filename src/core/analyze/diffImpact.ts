/**
 * diff_impact — blast radius of a working-tree change, in one walk.
 *
 * The workflow this replaces: an agent reads a diff, picks the changed
 * function names out of it by eye, then issues one `impact` call per name and
 * deduplicates the overlapping dependant lists itself. That costs a full diff
 * read plus N calls whose results largely repeat each other.
 *
 * Here the changed line ranges are mapped to symbols through Symbol.startLine/
 * endLine — the one step nothing outside the graph can do — and every matched
 * symbol seeds a walk (run concurrently, one per seed) whose results are then
 * merged. Dependants reached from several seeds appear once, tagged with
 * every seed that reaches them, so the output shrinks
 * as the seeds' blast radii overlap (which, for symbols changed together, they
 * usually do).
 *
 * Pure core: no git, no vscode, no storage specifics (R10). Hunks arrive
 * already parsed so this is testable without a repository; the CLI adapter
 * owns `git diff` and its hunk-header parsing.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { EdgeConfidence, EdgeKind, SymbolRecord } from '../indexer/types';
import { impact, IMPACT_EDGE_KINDS } from './impact';

/** A changed line range in one file. `startLine`/`endLine` are 1-based, inclusive. */
export interface DiffHunk {
  /** Workspace-relative path, as the index stores it. */
  path: string;
  startLine: number;
  endLine: number;
}

/** A symbol whose body overlaps at least one changed hunk — a seed of the walk. */
export interface ChangedSymbol {
  symbol: SymbolRecord;
  /** Hunks that landed inside this symbol's span. */
  hunks: DiffHunk[];
}

/**
 * A changed hunk that overlapped no symbol span: imports, module-level
 * constants, a file whose language has no extractor, or a file not indexed
 * yet. Reported rather than dropped — an empty blast radius that silently
 * omitted a changed import would read as "safe", which is the one wrong
 * answer this command must never give.
 */
export interface UnattributedHunk extends DiffHunk {
  reason: 'file-not-indexed' | 'no-symbol-at-line';
}

export interface DiffDependant {
  symbol: SymbolRecord;
  /** Shallowest BFS distance across all seeds that reach this node. */
  depth: number;
  /** Weakest confidence along the path that first reached it, at that depth. */
  confidence: EdgeConfidence;
  /** Symbol ids of every changed symbol whose walk reached this node. */
  viaSeeds: number[];
  /**
   * True when this dependant is itself one of the changed symbols. The change
   * already covers it, so it needs no separate review pass — but it is kept in
   * the list because its presence is what reveals a changed-symbol dependency
   * chain inside the diff.
   */
  alsoChanged: boolean;
}

export interface DiffImpactResult {
  changed: ChangedSymbol[];
  unattributed: UnattributedHunk[];
  /** Merged, deduplicated dependants ordered by depth, then file, then line. */
  dependants: DiffDependant[];
  /** Distinct files containing at least one dependant — the review surface. */
  affectedFiles: string[];
  /** True if any seed's walk stopped at `maxDepth` short of its closure. */
  truncated: boolean;
  /** Total test-file edges skipped across all walks (see ImpactResult). */
  hiddenTestEdges: number;
}

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { resolved: 0, fuzzy: 1, unresolved: 2 };

/**
 * Map hunks to the symbols they land in.
 *
 * A hunk can overlap several symbols (a method and its enclosing class, or a
 * hunk spanning two functions) and every one of them is a real seed, so all
 * overlaps are kept rather than picking the narrowest. The walk merges by
 * symbol id anyway, so an enclosing type contributing the same dependants as
 * its method costs nothing in the output.
 */
export async function resolveChangedSymbols(
  store: CodeStore,
  hunks: readonly DiffHunk[]
): Promise<{ changed: ChangedSymbol[]; unattributed: UnattributedHunk[] }> {
  const byPath = new Map<string, DiffHunk[]>();
  for (const h of hunks) {
    const list = byPath.get(h.path);
    if (list) list.push(h);
    else byPath.set(h.path, [h]);
  }

  const bySymbolId = new Map<number, ChangedSymbol>();
  const unattributed: UnattributedHunk[] = [];

  for (const [path, fileHunks] of byPath) {
    const syms = await store.outline(path);
    if (syms.length === 0) {
      // No indexed symbols at all: either the file is outside the index (a
      // config file, an unsupported language) or it is new and unindexed.
      // Either way the caller must look at it by hand.
      for (const h of fileHunks) unattributed.push({ ...h, reason: 'file-not-indexed' });
      continue;
    }
    for (const h of fileHunks) {
      // The file's module symbol spans the whole file (line 1 to EOF), so it
      // overlaps every hunk. Treat it as a fallback seed, not a co-equal one:
      // only use it when no more specific (non-module) symbol matches, or a
      // hunk that lands inside e.g. `alpha` would spuriously also seed a walk
      // from the whole-file module symbol, and true module-scope hunks (an
      // import, a top-level const) would never reach the unattributed path.
      const specific = syms.filter(
        (s) => s.kind !== 'module' && s.startLine <= h.endLine && s.endLine >= h.startLine
      );
      let matches = specific;
      if (matches.length === 0) {
        matches = syms.filter(
          (s) => s.kind === 'module' && s.startLine <= h.endLine && s.endLine >= h.startLine
        );
      }
      for (const s of matches) {
        const existing = bySymbolId.get(s.id);
        if (existing) existing.hunks.push(h);
        else bySymbolId.set(s.id, { symbol: s, hunks: [h] });
      }
      if (matches.length === 0) unattributed.push({ ...h, reason: 'no-symbol-at-line' });
    }
  }

  const changed = [...bySymbolId.values()].sort(
    (a, b) => a.symbol.file.localeCompare(b.symbol.file) || a.symbol.startLine - b.symbol.startLine
  );
  return { changed, unattributed };
}

/**
 * @param maxDepth hops per seed walk (default 3, matching the `impact` tool).
 * @param kinds edge kinds to follow; defaults to IMPACT_EDGE_KINDS.
 * @param includeTests false drops test-file edges from every walk's frontier.
 */
export async function diffImpact(
  store: CodeStore,
  hunks: readonly DiffHunk[],
  maxDepth = 3,
  kinds: readonly EdgeKind[] = IMPACT_EDGE_KINDS,
  includeTests = true
): Promise<DiffImpactResult> {
  const { changed, unattributed } = await resolveChangedSymbols(store, hunks);
  const changedIds = new Set(changed.map((c) => c.symbol.id));

  const merged = new Map<number, DiffDependant>();
  let truncated = false;
  let hiddenTestEdges = 0;

  const seedResults = await Promise.all(
    changed.map((seed) => impact(store, seed.symbol.id, maxDepth, kinds, includeTests))
  );

  for (let i = 0; i < changed.length; i++) {
    const seed = changed[i]!;
    const res = seedResults[i];
    if (!res) continue;
    if (res.truncated) truncated = true;
    hiddenTestEdges += res.hiddenTestEdges;
    for (const d of res.dependants) {
      const prev = merged.get(d.symbol.id);
      if (!prev) {
        merged.set(d.symbol.id, {
          symbol: d.symbol,
          depth: d.depth,
          confidence: d.confidence,
          viaSeeds: [seed.symbol.id],
          alsoChanged: changedIds.has(d.symbol.id),
        });
        continue;
      }
      prev.viaSeeds.push(seed.symbol.id);
      // Keep the shortest path, and the confidence belonging to it: a node
      // reachable at d1/resolved from one seed and d3/fuzzy from another is
      // a d1/resolved dependant, not a fuzzy one.
      if (d.depth < prev.depth) {
        prev.depth = d.depth;
        prev.confidence = d.confidence;
      } else if (d.depth === prev.depth && CONFIDENCE_RANK[d.confidence] < CONFIDENCE_RANK[prev.confidence]) {
        prev.confidence = d.confidence;
      }
    }
  }

  const dependants = [...merged.values()].sort(
    (a, b) =>
      a.depth - b.depth ||
      a.symbol.file.localeCompare(b.symbol.file) ||
      a.symbol.startLine - b.symbol.startLine
  );
  // Files a reviewer or a test run has to touch. Excludes files whose only
  // listed symbol is itself part of the diff — those are already open.
  const affectedFiles = [
    ...new Set(dependants.filter((d) => !d.alsoChanged).map((d) => d.symbol.file)),
  ].sort();

  return { changed, unattributed, dependants, affectedFiles, truncated, hiddenTestEdges };
}
