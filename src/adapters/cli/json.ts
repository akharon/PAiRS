/**
 * CLI structured-output layer: one JSON shape per tool, built from the same
 * store/analyze calls the prose executors (core/tools/executors.ts) use.
 *
 * Deliberately separate from executors.ts rather than a mode flag on it:
 * executors.ts is shared with the Copilot Language Model Tools surface,
 * where prose stays the answer format (agents read it more reliably and it
 * costs fewer tokens — see the file header there). JSON-by-default is a CLI
 * scripting/CI concern, not an in-editor agent one.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { AmbiguousSymbol, DeadCodeCandidate, EdgeKind, SymbolKind, SymbolRecord } from '../../core/indexer/types';
import { impact } from '../../core/analyze/impact';
import { hierarchy } from '../../core/analyze/hierarchy';
import { moduleMap, moduleKeyOf } from '../../core/analyze/moduleMap';
import { planRename, applyPlan } from '../../core/tools/rename';
import type { CodeToolInput } from '../../core/tools/tools';

function isAmbiguous(x: SymbolRecord[] | AmbiguousSymbol): x is AmbiguousSymbol {
  return !Array.isArray(x) && x.ambiguous === true;
}

/** Same resolution semantics as executors.ts's resolveOne, returning data instead of prose. */
async function resolveOneJson(
  store: CodeStore,
  name: string,
  pathHint?: string
): Promise<{ sym: SymbolRecord } | { ambiguous: true; candidates: SymbolRecord[] } | { miss: true; message: string }> {
  const hit = await store.lookup(name);
  if (isAmbiguous(hit)) {
    let cands = hit.candidates;
    if (pathHint) {
      const narrowed = cands.filter((c) => c.file === pathHint || c.file.endsWith(pathHint));
      if (narrowed.length === 1) return { sym: narrowed[0]! };
      if (narrowed.length > 0) cands = narrowed;
    }
    return { ambiguous: true, candidates: cands };
  }
  if (hit.length === 0) return { miss: true, message: `No symbol named "${name}" in the index.` };
  if (hit.length === 1) return { sym: hit[0]! };
  const chosen = pathHint ? hit.find((c) => c.file.endsWith(pathHint)) : undefined;
  return { sym: chosen ?? hit[0]! };
}

function paginate<T>(rows: T[], limit: number, offset = 0): { page: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + page.length < rows.length;
  return { page, total: rows.length, hasMore, nextOffset: hasMore ? offset + limit : null };
}

const CALL_KINDS: EdgeKind[] = ['CALLS'];

export async function jsonFindSymbol(store: CodeStore, input: CodeToolInput<'find_symbol'>): Promise<unknown> {
  const hit = await store.lookup(input.name);
  let syms = isAmbiguous(hit) ? hit.candidates : hit;
  if (input.kinds?.length) syms = syms.filter((s) => input.kinds!.includes(s.kind));
  if (input.langs?.length) syms = syms.filter((s) => input.langs!.includes(s.lang));
  const { page, total, hasMore, nextOffset } = paginate(syms, input.limit, input.offset);
  return { query: input.name, total, hasMore, nextOffset, symbols: page };
}

export async function jsonGetSymbol(store: CodeStore, input: CodeToolInput<'get_symbol'>): Promise<unknown> {
  const r = await resolveOneJson(store, input.name, input.path);
  if ('ambiguous' in r) return { ambiguous: true, candidates: r.candidates };
  if ('miss' in r) return { symbol: null, message: r.message };
  const members = input.includeMembers ? await store.membersOf(r.sym.id) : undefined;
  return { symbol: r.sym, members };
}

export async function jsonOutline(store: CodeStore, input: CodeToolInput<'outline'>): Promise<unknown> {
  const syms = await store.outline(input.path);
  return { path: input.path, symbols: syms };
}

export async function jsonImpact(
  store: CodeStore,
  input: { name: string; path?: string; depth: number; limit: number; includeTests?: boolean; kinds?: readonly EdgeKind[] }
): Promise<unknown> {
  const r = await resolveOneJson(store, input.name, input.path);
  if ('ambiguous' in r) return { ambiguous: true, candidates: r.candidates };
  if ('miss' in r) return { seed: null, dependants: [], message: r.message };
  const kinds = input.kinds?.length ? input.kinds : undefined;
  const res = await impact(store, r.sym.id, input.depth, kinds, input.includeTests ?? true);
  if (!res) return { seed: null, dependants: [], message: `No symbol id for "${input.name}".` };
  const { page, total, hasMore, nextOffset } = paginate(res.dependants, input.limit);
  return {
    seed: res.seed,
    total,
    hasMore,
    nextOffset,
    truncated: res.truncated,
    hiddenTestEdges: res.hiddenTestEdges,
    dependants: page,
  };
}

export async function jsonHierarchy(store: CodeStore, input: CodeToolInput<'hierarchy'>): Promise<unknown> {
  const r = await resolveOneJson(store, input.name, input.path);
  if ('ambiguous' in r) return { ambiguous: true, candidates: r.candidates };
  if ('miss' in r) return { seed: null, ancestors: [], descendants: [], message: r.message };
  const res = await hierarchy(store, r.sym.id, input.depth);
  if (!res) return { seed: null, ancestors: [], descendants: [], message: `No symbol id for "${input.name}".` };
  const ancestors = paginate(res.ancestors, input.limit);
  const descendants = paginate(res.descendants, input.limit);
  return {
    seed: res.seed,
    ancestors: {
      items: ancestors.page,
      total: ancestors.total,
      hasMore: ancestors.hasMore,
      nextOffset: ancestors.nextOffset,
      truncated: res.ancestorsTruncated,
    },
    descendants: {
      items: descendants.page,
      total: descendants.total,
      hasMore: descendants.hasMore,
      nextOffset: descendants.nextOffset,
      truncated: res.descendantsTruncated,
    },
  };
}

export async function jsonWhoCalls(store: CodeStore, input: CodeToolInput<'who_calls'>): Promise<unknown> {
  const r = await resolveOneJson(store, input.name, input.path);
  if ('ambiguous' in r) return { ambiguous: true, candidates: r.candidates };
  if ('miss' in r) return { symbol: null, edges: [], message: r.message };
  const edges =
    input.direction === 'callers' ? await store.edgesTo([r.sym.id], CALL_KINDS) : await store.edgesFrom([r.sym.id], CALL_KINDS);
  const fuzzyFiltered = input.includeFuzzy ? edges : edges.filter((e) => e.confidence !== 'fuzzy');
  const hiddenTestEdges = input.includeTests ? 0 : fuzzyFiltered.filter((e) => e.test).length;
  const filtered = input.includeTests ? fuzzyFiltered : fuzzyFiltered.filter((e) => !e.test);
  const { page: edgePage, total, hasMore, nextOffset } = paginate(filtered, input.limit);
  const syms = await Promise.all(edgePage.map((e) => store.get(input.direction === 'callers' ? e.fromId : e.toId)));
  const items = edgePage.map((e, i) => ({ symbol: syms[i], edge: e })).filter((x) => x.symbol);
  return { symbol: r.sym, direction: input.direction, total, hasMore, nextOffset, hiddenTestEdges, items };
}

export async function jsonFileDeps(store: CodeStore, input: CodeToolInput<'file_deps'>): Promise<unknown> {
  const dir = input.direction === 'importers' ? 'importers' : 'imports';
  const deps = await store.fileEdges(input.path, dir, { transitive: input.transitive, limit: input.limit });
  return { path: input.path, direction: dir, deps };
}

export async function jsonModuleMap(store: CodeStore, input: CodeToolInput<'module_map'>): Promise<unknown> {
  const opts = { depth: input.depth, resolution: input.resolution };
  const map = await moduleMap(store, opts);
  if (input.boundary) {
    const parts = input.boundary.split(/\s*(?:->|→|=>)\s*/);
    const [from, to] = [parts[0]?.trim() ?? '', parts[1]?.trim() ?? ''];
    if (parts.length !== 2 || !from || !to) {
      return { boundary: input.boundary, message: 'boundary must be "<from module> -> <to module>".' };
    }
    const known = new Set(map.modules);
    const unknown = [from, to].filter((m) => !known.has(m));
    if (unknown.length > 0) return { boundary: input.boundary, message: `Unknown module(s): ${unknown.join(', ')}.`, modules: map.modules };
    const edge = map.edges.find((e) => e.from === from && e.to === to);
    if (!edge) return { boundary: input.boundary, dependsOn: false };
    const rows = await store.query(
      `SELECT a.file AS af, e.line AS line, e.confidence AS conf, e.kind AS ek,
              b.file AS bf, b.name AS bn, b.kind AS bk, b.qualified AS bq, b.startLine AS bl
       FROM Edge e
       JOIN Symbol a ON a.id = e.src
       JOIN Symbol b ON b.id = e.dst
       WHERE e.kind IN ('DEPENDS_ON','CALLS','READS','WRITES','IMPLEMENTS','EXTENDS')
         AND a.file <> b.file AND COALESCE(e.test, 0) = 0`
    );
    const targets = new Map<string, { symbol: string; kind: string; file: string; line: number | null; via: Set<string>; refs: string[]; fuzzy: number }>();
    for (const r of rows) {
      const af = String(r.af);
      const bf = String(r.bf);
      if (moduleKeyOf(af, opts) !== from || moduleKeyOf(bf, opts) !== to) continue;
      const key = `${r.bq || r.bn}@${bf}`;
      const t = targets.get(key) ?? {
        symbol: String(r.bq || r.bn),
        kind: String(r.bk ?? ''),
        file: bf,
        line: r.bl === null || r.bl === undefined ? null : Number(r.bl),
        via: new Set<string>(),
        refs: [],
        fuzzy: 0,
      };
      t.via.add(String(r.ek ?? 'REF'));
      t.refs.push(`${af}:${r.line ?? '?'}`);
      if (r.conf === 'fuzzy') t.fuzzy += 1;
      targets.set(key, t);
    }
    const ranked = [...targets.values()]
      .map((t) => ({ symbol: t.symbol, kind: t.kind, file: t.file, line: t.line, via: [...t.via], refs: t.refs, fuzzy: t.fuzzy }))
      .sort((a, b) => (b.refs.length - b.fuzzy - (a.refs.length - a.fuzzy)) || b.refs.length - a.refs.length || a.symbol.localeCompare(b.symbol));
    const { page, total, hasMore, nextOffset } = paginate(ranked, input.limit);
    return {
      boundary: input.boundary,
      dependsOn: true,
      weight: edge.weight,
      inCycle: map.cycles.some((c) => c.includes(from) && c.includes(to)),
      crossCluster: map.drift.some((d) => d.from === from && d.to === to),
      total,
      hasMore,
      nextOffset,
      symbols: page,
    };
  }
  return map;
}

export async function jsonAnalyze(store: CodeStore, input: CodeToolInput<'analyze'>): Promise<unknown> {
  switch (input.kind) {
    case 'dead_code': {
      const c: DeadCodeCandidate[] = await store.unreferenced({
        pathPrefix: input.pathPrefix,
        excludePath: input.excludePath,
        includeExported: input.includeExported,
        limit: input.limit,
        offset: input.offset,
      });
      return { kind: input.kind, candidates: c };
    }
    case 'fan_out': {
      const rows = await store.hotspots({ pathPrefix: input.pathPrefix, limit: input.limit, offset: input.offset });
      return { kind: input.kind, symbols: rows };
    }
    case 'cycles': {
      const cycles = await store.findCycles({ edge: 'DEPENDS_ON', scope: input.scope, pathPrefix: input.pathPrefix, limit: input.limit });
      return { kind: input.kind, scope: input.scope, cycles };
    }
    case 'test_gap': {
      const rows = await store.untested({ pathPrefix: input.pathPrefix, excludePath: input.excludePath, limit: input.limit, offset: input.offset });
      return { kind: input.kind, symbols: rows };
    }
  }
}

export async function jsonRenameSymbol(
  store: CodeStore,
  root: string | undefined,
  input: CodeToolInput<'rename_symbol'>
): Promise<unknown> {
  if (!root) return { renamed: false, message: 'Renaming is unavailable (no workspace root).' };
  const r = await resolveOneJson(store, input.name, input.path);
  if ('ambiguous' in r) return { ambiguous: true, candidates: r.candidates };
  if ('miss' in r) return { renamed: false, message: r.message };
  const plan = await planRename(store, root, r.sym, input.newName, { includeFuzzy: input.includeFuzzy });
  if ('message' in plan) return { renamed: false, message: plan.message };
  const touched = applyPlan(plan);
  return {
    renamed: true,
    from: r.sym.qualified || r.sym.name,
    to: input.newName,
    files: touched,
    sites: plan.sites,
    collisionsElsewhere: plan.collisionsElsewhere,
  };
}

export async function jsonGrepSymbols(store: CodeStore, input: CodeToolInput<'grep_symbols'>): Promise<unknown> {
  const symbols = await store.grepSymbols(input.pattern, {
    isRegex: input.isRegex,
    kinds: input.kinds as SymbolKind[] | undefined,
    pathPrefix: input.pathPrefix,
    limit: input.limit,
  });
  return { pattern: input.pattern, isRegex: input.isRegex, total: symbols.length, symbols };
}

/**
 * context_pack (Step 6.2): one bundle for a symbol or file, composed from the
 * SAME calls find_symbol/who_calls/hierarchy/module_map already make — no
 * new graph traversal, just assembly.
 */
export async function jsonContextPack(store: CodeStore, input: CodeToolInput<'context_pack'>): Promise<unknown> {
  if (!input.name && !input.path) {
    return { message: 'context_pack needs `name` or `path`.' };
  }
  if (input.path && !input.name) {
    const symbols = await store.outline(input.path);
    const opts = {};
    const map = await moduleMap(store, opts);
    const key = moduleKeyOf(input.path, opts);
    const moduleEdges = {
      dependsOn: map.edges.filter((e) => e.from === key).slice(0, input.limit),
      dependedOnBy: map.edges.filter((e) => e.to === key).slice(0, input.limit),
    };
    return { path: input.path, symbols, module: key, moduleEdges };
  }

  const r = await resolveOneJson(store, input.name!, input.path);
  if ('ambiguous' in r) return { ambiguous: true, candidates: r.candidates };
  if ('miss' in r) return { symbol: null, message: r.message };
  const sym = r.sym;

  const [callerEdges, calleeEdges, hierarchyRes, map] = await Promise.all([
    store.edgesTo([sym.id], CALL_KINDS),
    store.edgesFrom([sym.id], CALL_KINDS),
    hierarchy(store, sym.id, 2),
    moduleMap(store),
  ]);
  const callerIds = callerEdges.slice(0, input.limit).map((e) => e.fromId);
  const calleeIds = calleeEdges.slice(0, input.limit).map((e) => e.toId);
  const [callerSyms, calleeSyms] = await Promise.all([store.getMany(callerIds), store.getMany(calleeIds)]);
  const key = moduleKeyOf(sym.file, {});

  return {
    symbol: sym,
    callers: {
      total: callerEdges.length,
      items: callerEdges.slice(0, input.limit).map((e) => ({ symbol: callerSyms.get(e.fromId), edge: e })),
    },
    callees: {
      total: calleeEdges.length,
      items: calleeEdges.slice(0, input.limit).map((e) => ({ symbol: calleeSyms.get(e.toId), edge: e })),
    },
    hierarchy: hierarchyRes
      ? {
          ancestors: hierarchyRes.ancestors.slice(0, input.limit),
          descendants: hierarchyRes.descendants.slice(0, input.limit),
        }
      : null,
    module: key,
    moduleEdges: {
      dependsOn: map.edges.filter((e) => e.from === key).slice(0, input.limit),
      dependedOnBy: map.edges.filter((e) => e.to === key).slice(0, input.limit),
    },
  };
}
