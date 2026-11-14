/**
 * CLI structured-output layer (`pairs <tool> --json`): one JSON shape per
 * tool, built from the same store/analyze calls the prose executors
 * (core/tools/executors.ts) use.
 *
 * Deliberately separate from executors.ts rather than a mode flag on it:
 * prose is the default answer format (agents read it reliably and it is the
 * cheapest), and JSON is opt-in for scripting. Because it is opt-in it is
 * also kept lean: records are slimmed to the fields a consumer can act on —
 * no internal ids, no language tag, no null/empty/default-valued fields —
 * since every dropped key is repeated once per row.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type {
  AmbiguousSymbol,
  DeadCodeCandidate,
  EdgeConfidence,
  EdgeKind,
  IndexStats,
  SymbolKind,
  SymbolRecord,
} from '../../core/indexer/types';
import { impact } from '../../core/analyze/impact';
import { diffImpact } from '../../core/analyze/diffImpact';
import type { DiffHunk } from '../../core/analyze/diffImpact';
import { hierarchy } from '../../core/analyze/hierarchy';
import { moduleMap, moduleKeyOf, moduleNeighbours } from '../../core/analyze/moduleMap';
import { planRename, applyPlan } from '../../core/tools/rename';
import {
  EMPTY_INDEX_MESSAGE,
  SITES_SHOWN,
  emptyIndexMessage,
  groupCallEdges,
  pathMatchesHint,
  resolvePathArg,
  shortSignature,
} from '../../core/tools/executors';
import type { CallGroup } from '../../core/tools/executors';
import type { CodeToolInput } from '../../core/tools/tools';

// ---------------------------------------------------------------------------
// Slim record shapes
// ---------------------------------------------------------------------------

/** A symbol as emitted in JSON. Every optional key is omitted when it holds its default. */
export interface SlimSymbol {
  name: string;
  /** Omitted when identical to `name`. */
  qualified?: string;
  kind: string;
  /** Omitted inside per-file listings (outline), where it is the same on every row. */
  file?: string;
  line: number;
  /** Omitted for one-line symbols. */
  endLine?: number;
  signature?: string;
  doc?: string;
  /** Present only when true. */
  exported?: true;
}

interface SlimOpts {
  /** none: omit; short: one line, capped (what prose cite() shows); full: verbatim. */
  sig?: 'none' | 'short' | 'full';
  /** none: omit; first: first line; full: whole doc comment. */
  doc?: 'none' | 'first' | 'full';
  /** Omit `file` (per-file listings). */
  file?: boolean;
}

function slim(s: SymbolRecord, o: SlimOpts = {}): SlimSymbol {
  const out: SlimSymbol = { name: s.name, kind: s.kind, line: s.startLine };
  if (s.qualified && s.qualified !== s.name) out.qualified = s.qualified;
  if (o.file !== false) out.file = s.file;
  if (s.endLine > s.startLine) out.endLine = s.endLine;
  const sig = o.sig ?? 'short';
  if (sig !== 'none' && s.signature) out.signature = sig === 'full' ? s.signature : shortSignature(s.signature);
  const doc = o.doc ?? 'none';
  if (doc !== 'none' && s.doc) {
    const text = doc === 'first' ? s.doc.split('\n')[0]!.trim() : s.doc;
    if (text) out.doc = text;
  }
  if (s.exported) out.exported = true;
  return out;
}

const fuzzyOnly = (c: EdgeConfidence): { confidence?: EdgeConfidence } => (c === 'resolved' ? {} : { confidence: c });

function isAmbiguous(x: SymbolRecord[] | AmbiguousSymbol): x is AmbiguousSymbol {
  return !Array.isArray(x) && x.ambiguous === true;
}

const ambiguousOut = (candidates: SymbolRecord[]): { ambiguous: true; candidates: SlimSymbol[] } => ({
  ambiguous: true,
  candidates: candidates.map((c) => slim(c)),
});

/** Same resolution semantics as executors.ts's resolveOne, returning data instead of prose. */
async function resolveOneJson(
  store: CodeStore,
  name: string,
  pathHint?: string
): Promise<{ sym: SymbolRecord } | { ambiguous: true; candidates: SymbolRecord[] } | { miss: true; message: string; didYouMean: string[] }> {
  const hit = await store.lookup(name);
  if (isAmbiguous(hit)) {
    let cands = hit.candidates;
    if (pathHint) {
      const narrowed = cands.filter((c) => pathMatchesHint(c.file, pathHint));
      if (narrowed.length === 1) return { sym: narrowed[0]! };
      if (narrowed.length > 0) cands = narrowed;
    }
    return { ambiguous: true, candidates: cands };
  }
  if (hit.length === 0) return { miss: true, message: `No symbol named "${name}" in the index.`, didYouMean: await store.suggestNames(name) };
  if (hit.length === 1) return { sym: hit[0]! };
  const chosen = pathHint ? hit.find((c) => pathMatchesHint(c.file, pathHint)) : undefined;
  return { sym: chosen ?? hit[0]! };
}

/** `didYouMean` only when there is something to suggest. */
const dym = (r: { didYouMean: string[] }): { didYouMean?: string[] } => (r.didYouMean.length ? { didYouMean: r.didYouMean } : {});

/** A path argument that did not resolve: the error code plus near matches / candidates (no prose). */
function pathError(p: Exclude<Awaited<ReturnType<typeof resolvePathArg>>, { path: string }>): Record<string, unknown> {
  return p.error === 'no_file'
    ? { error: 'no_file', path: p.input, ...(p.suggestions.length ? { suggestions: p.suggestions } : {}) }
    : { error: 'ambiguous_path', path: p.input, matches: p.matches };
}

/** Per-caller (or callee) call-site summary: lines (capped), total count when >1, and any non-default confidence/test marks. */
function groupExtras(g: CallGroup): { sites?: number[]; n?: number; confidence?: EdgeConfidence; fuzzySites?: number; test?: true } {
  return {
    ...(g.lines.length ? { sites: g.lines.slice(0, SITES_SHOWN) } : {}),
    ...(g.n > 1 ? { n: g.n } : {}),
    ...(g.fuzzy === g.n ? { confidence: 'fuzzy' as const } : g.fuzzy > 0 ? { fuzzySites: g.fuzzy } : {}),
    ...(g.test === g.n ? { test: true as const } : {}),
  };
}

/** `hasMore`/`nextOffset` appear only when there is more; `total` always states the full size. */
function paginate<T>(
  rows: T[],
  limit: number,
  offset = 0
): { page: T[]; total: number; paging: { total: number; hasMore?: true; nextOffset?: number } } {
  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + page.length < rows.length;
  return {
    page,
    total: rows.length,
    paging: hasMore ? { total: rows.length, hasMore: true, nextOffset: offset + limit } : { total: rows.length },
  };
}

/** Every builder answers an empty index with the same single message the prose tools use. */
async function guarded(store: CodeStore, build: () => Promise<unknown>): Promise<unknown> {
  const empty = await emptyIndexMessage(store);
  return empty ? { message: empty } : build();
}

const CALL_KINDS: EdgeKind[] = ['CALLS'];
const MEMBERS_MAX = 40;

// ---------------------------------------------------------------------------
// Prose renderers for the non-tool commands (stats, files)
// ---------------------------------------------------------------------------

/** `pairs stats` default output: two lines (totals, top symbol kinds). */
export function renderStatsProse(s: IndexStats): string {
  if (s.files === 0) return EMPTY_INDEX_MESSAGE;
  const when = s.lastIndexedAt ? new Date(s.lastIndexedAt).toISOString().replace(/\.\d+Z$/, 'Z') : 'never';
  const head =
    `${s.files} files, ${s.symbols} symbols, ${s.edges} edges (${(s.fuzzyRate * 100).toFixed(0)}% fuzzy), ` +
    `${s.pendingRefs} unresolved refs (${s.externalRefs} external); indexed ${when}`;
  const kinds = Object.entries(s.byKind)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 8)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  return kinds ? `${head}\nkinds: ${kinds}` : head;
}

/** `pairs files` default output: one path per line, with a count header only when empty. */
export function renderFilesProse(paths: string[]): string {
  return paths.length === 0 ? 'No matching files.' : paths.join('\n');
}

// ---------------------------------------------------------------------------
// Per-tool builders
// ---------------------------------------------------------------------------

export function jsonFindSymbol(store: CodeStore, input: CodeToolInput<'find_symbol'>): Promise<unknown> {
  return guarded(store, async () => {
    const hit = await store.lookup(input.name);
    let syms = isAmbiguous(hit) ? hit.candidates : hit;
    if (input.kinds?.length) syms = syms.filter((s) => input.kinds!.includes(s.kind));
    if (input.langs?.length) syms = syms.filter((s) => input.langs!.includes(s.lang));
    const { page, paging } = paginate(syms, input.limit, input.offset);
    // Only a true miss (nothing before filters) gets suggestions; a filtered-out hit would be misled by them.
    const hadAny = isAmbiguous(hit) ? hit.candidates.length > 0 : hit.length > 0;
    const didYouMean = syms.length === 0 && !hadAny ? await store.suggestNames(input.name) : [];
    return { query: input.name, ...paging, ...dym({ didYouMean }), symbols: page.map((s) => slim(s, { doc: input.preview ? 'first' : 'none' })) };
  });
}

export function jsonGetSymbol(store: CodeStore, input: CodeToolInput<'get_symbol'>): Promise<unknown> {
  return guarded(store, async () => {
    const r = await resolveOneJson(store, input.name, input.path);
    if ('ambiguous' in r) return ambiguousOut(r.candidates);
    if ('miss' in r) return { symbol: null, message: r.message, ...dym(r) };
    const out: Record<string, unknown> = { symbol: slim(r.sym, { sig: 'full', doc: 'full' }) };
    if (input.includeMembers) {
      const members = await store.membersOf(r.sym.id);
      if (members.length > 0) {
        out.members = members.slice(0, MEMBERS_MAX).map((m) => slim(m, { file: false }));
        if (members.length > MEMBERS_MAX) out.moreMembers = members.length - MEMBERS_MAX;
      }
    }
    return out;
  });
}

export function jsonOutline(store: CodeStore, input: CodeToolInput<'outline'>): Promise<unknown> {
  return guarded(store, async () => {
    const p = await resolvePathArg(store, input.path);
    if ('error' in p) return pathError(p);
    const syms = await store.outline(p.path);
    return { path: input.path, ...(p.path !== input.path ? { resolvedPath: p.path } : {}), symbols: syms.map((s) => slim(s, { file: false })) };
  });
}

export function jsonImpact(
  store: CodeStore,
  input: { name: string; path?: string; depth: number; limit: number; includeTests?: boolean; kinds?: readonly EdgeKind[] }
): Promise<unknown> {
  return guarded(store, async () => {
    const r = await resolveOneJson(store, input.name, input.path);
    if ('ambiguous' in r) return ambiguousOut(r.candidates);
    if ('miss' in r) return { seed: null, dependants: [], message: r.message, ...dym(r) };
    const kinds = input.kinds?.length ? input.kinds : undefined;
    const res = await impact(store, r.sym.id, input.depth, kinds, input.includeTests ?? true);
    if (!res) return { seed: null, dependants: [], message: `No symbol id for "${input.name}".` };
    const { page, paging } = paginate(res.dependants, input.limit);
    return {
      seed: slim(res.seed),
      ...paging,
      ...(res.truncated ? { truncated: true } : {}),
      ...(res.capped ? { capped: true } : {}),
      ...(res.hiddenTestEdges ? { hiddenTestEdges: res.hiddenTestEdges } : {}),
      dependants: page.map((d) => ({ ...slim(d.symbol, { sig: 'none' }), depth: d.depth, ...fuzzyOnly(d.confidence) })),
    };
  });
}

export function jsonDiffImpact(
  store: CodeStore,
  collectDiff: (src: { rev?: string; staged?: boolean }) => Promise<DiffHunk[]>,
  input: CodeToolInput<'diff_impact'>
): Promise<unknown> {
  return guarded(store, async () => {
    let hunks: DiffHunk[];
    try {
      hunks = await collectDiff({ rev: input.rev, staged: input.staged });
    } catch (err) {
      return { changed: [], dependants: [], message: `Could not read the diff: ${(err as Error).message}` };
    }
    if (hunks.length === 0) {
      return { changed: [], dependants: [], affectedFiles: [], unattributed: [], total: 0, message: 'No changes to analyze.' };
    }
    const kinds = input.kinds?.length ? input.kinds : undefined;
    const res = await diffImpact(store, hunks, input.depth, kinds, input.includeTests);
    // Paginate the out-of-change dependants only; a symbol already in the diff
    // is not a review item, so it must not consume the caller's budget.
    const external = res.dependants.filter((d) => !d.alsoChanged);
    const { page, paging } = paginate(external, input.limit, input.offset);
    const files = paginate(res.affectedFiles, input.limit);
    const unattributed = paginate(res.unattributed, input.limit);
    return {
      changed: res.changed.slice(0, input.limit).map((c) => slim(c.symbol, { sig: 'none' })),
      ...(res.changed.length > input.limit ? { moreChanged: res.changed.length - input.limit } : {}),
      ...paging,
      ...(res.truncated ? { truncated: true } : {}),
      ...(res.hiddenTestEdges ? { hiddenTestEdges: res.hiddenTestEdges } : {}),
      dependants: page.map((d) => ({
        ...slim(d.symbol, { sig: 'none' }),
        depth: d.depth,
        ...fuzzyOnly(d.confidence),
        ...(d.viaSeeds.length > 1 ? { via: d.viaSeeds.length } : {}),
      })),
      affectedFiles: files.page,
      ...(files.paging.hasMore ? { moreFiles: files.total - files.page.length } : {}),
      unattributed: unattributed.page,
      ...(unattributed.paging.hasMore ? { moreUnattributed: unattributed.total - unattributed.page.length } : {}),
    };
  });
}

export function jsonHierarchy(store: CodeStore, input: CodeToolInput<'hierarchy'>): Promise<unknown> {
  return guarded(store, async () => {
    const r = await resolveOneJson(store, input.name, input.path);
    if ('ambiguous' in r) return ambiguousOut(r.candidates);
    if ('miss' in r) return { seed: null, ancestors: [], descendants: [], message: r.message, ...dym(r) };
    const res = await hierarchy(store, r.sym.id, input.depth);
    if (!res) return { seed: null, ancestors: [], descendants: [], message: `No symbol id for "${input.name}".` };
    const side = (nodes: typeof res.ancestors, truncated: boolean) => {
      const { page, paging } = paginate(nodes, input.limit);
      return {
        items: page.map((d) => ({ ...slim(d.symbol, { sig: 'none' }), depth: d.depth, ...fuzzyOnly(d.confidence) })),
        ...paging,
        ...(truncated ? { truncated: true } : {}),
      };
    };
    return {
      seed: slim(res.seed),
      ancestors: side(res.ancestors, res.ancestorsTruncated),
      descendants: side(res.descendants, res.descendantsTruncated),
    };
  });
}

export function jsonWhoCalls(store: CodeStore, input: CodeToolInput<'who_calls'>): Promise<unknown> {
  return guarded(store, async () => {
    const r = await resolveOneJson(store, input.name, input.path);
    if ('ambiguous' in r) return ambiguousOut(r.candidates);
    if ('miss' in r) return { symbol: null, edges: [], message: r.message, ...dym(r) };
    const edges =
      input.direction === 'callers' ? await store.edgesTo([r.sym.id], CALL_KINDS) : await store.edgesFrom([r.sym.id], CALL_KINDS);
    const fuzzyFiltered = input.includeFuzzy ? edges : edges.filter((e) => e.confidence !== 'fuzzy');
    const hiddenTestEdges = input.includeTests
      ? 0
      : groupCallEdges(fuzzyFiltered.filter((e) => e.test), input.direction === 'callers' ? 'from' : 'to').length;
    const filtered = input.includeTests ? fuzzyFiltered : fuzzyFiltered.filter((e) => !e.test);
    // One item per distinct caller/callee; `sites` are the call-site lines
    // (in the caller's file; for callees, the seed's), `n` the total when >1.
    const groups = groupCallEdges(filtered, input.direction === 'callers' ? 'from' : 'to');
    const { page: groupPage, paging } = paginate(groups, input.limit);
    const syms = await store.getMany(groupPage.map((g) => g.id));
    const items = groupPage
      .map((g) => ({ s: syms.get(g.id), g }))
      .filter((x) => x.s)
      .map((x) => ({ ...slim(x.s!, { sig: 'none' }), ...groupExtras(x.g) }));
    return {
      symbol: slim(r.sym),
      direction: input.direction,
      ...paging,
      ...(hiddenTestEdges ? { hiddenTestEdges } : {}),
      items,
    };
  });
}

export function jsonFileDeps(store: CodeStore, input: CodeToolInput<'file_deps'>): Promise<unknown> {
  return guarded(store, async () => {
    const dir = input.direction === 'importers' ? 'importers' : 'imports';
    const p = await resolvePathArg(store, input.path);
    if ('error' in p) return pathError(p);
    const all = await store.fileEdges(p.path, dir, { transitive: input.transitive, limit: 201 });
    const { page, paging } = paginate(all, input.limit);
    return {
      path: input.path,
      ...(p.path !== input.path ? { resolvedPath: p.path } : {}),
      direction: dir,
      ...paging,
      deps: page.map((d) => ({ path: d.path, line: d.line, ...(input.transitive ? { depth: d.depth } : {}) })),
    };
  });
}

export function jsonModuleMap(store: CodeStore, input: CodeToolInput<'module_map'>): Promise<unknown> {
  return guarded(store, async () => {
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
        .map((t) => ({
          symbol: t.symbol,
          ...(t.kind ? { kind: t.kind } : {}),
          file: t.file,
          ...(t.line !== null ? { line: t.line } : {}),
          via: [...t.via],
          refs: t.refs,
          ...(t.fuzzy ? { fuzzy: t.fuzzy } : {}),
        }))
        .sort((a, b) => (b.refs.length - (b.fuzzy ?? 0) - (a.refs.length - (a.fuzzy ?? 0))) || b.refs.length - a.refs.length || a.symbol.localeCompare(b.symbol));
      const { page, paging } = paginate(ranked, input.limit);
      return {
        boundary: input.boundary,
        dependsOn: true,
        weight: edge.weight,
        ...(map.cycles.some((c) => c.includes(from) && c.includes(to)) ? { inCycle: true } : {}),
        ...(map.drift.some((d) => d.from === from && d.to === to) ? { crossCluster: true } : {}),
        ...paging,
        symbols: page,
      };
    }

    // Whole map, slimmed: rounded weights/ratios, per-module metrics reduced to
    // what a consumer acts on, and every long list bounded by `limit`.
    const r2 = (n: number): number => Math.round(n * 100) / 100;
    const cap = <T>(rows: T[], n: number): { rows: T[]; more?: number } => ({
      rows: rows.slice(0, n),
      ...(rows.length > n ? { more: rows.length - n } : {}),
    });
    const limit = input.limit;
    const edges = cap(map.edges, Math.max(limit * 5, 100));
    const drift = cap(map.drift, limit);
    const cycles = cap(map.cycles, limit);
    const cuts = cap(map.cycleCuts, limit);
    const clusters = cap(map.clusters, limit);
    const w = (e: { from: string; to: string; weight: number }) => ({ from: e.from, to: e.to, weight: r2(e.weight) });
    const more = {
      ...(edges.more ? { edges: edges.more } : {}),
      ...(drift.more ? { drift: drift.more } : {}),
      ...(cycles.more ? { cycles: cycles.more } : {}),
      ...(cuts.more ? { cycleCuts: cuts.more } : {}),
      ...(clusters.more ? { clusters: clusters.more } : {}),
    };
    return {
      modules: map.modules,
      edges: edges.rows.map(w),
      clusters: clusters.rows.map((c) => c.modules),
      driftRatio: r2(map.driftRatio),
      drift: drift.rows.map(w),
      layoutDrift: r2(map.layoutDrift),
      metrics: map.metrics.map((m) => ({
        module: m.module,
        cluster: m.cluster,
        layer: m.layer,
        fanIn: m.fanIn,
        fanOut: m.fanOut,
        ...(m.files ? { files: m.files } : {}),
        ...(m.cohesion !== null ? { cohesion: r2(m.cohesion) } : {}),
      })),
      cycles: cycles.rows,
      cycleCuts: cuts.rows.map(w),
      ...(Object.keys(more).length ? { more } : {}),
    };
  });
}

export function jsonAnalyze(store: CodeStore, input: CodeToolInput<'analyze'>): Promise<unknown> {
  return guarded(store, async () => {
    const probe = 101;
    const paged = <T>(rows: T[]): { rows: T[]; more?: number } => ({
      rows: rows.slice(0, input.limit),
      ...(rows.length > input.limit ? { more: rows.length - input.limit, nextOffset: input.offset + input.limit } : {}),
    });
    switch (input.kind) {
      case 'dead_code': {
        const c: DeadCodeCandidate[] = await store.unreferenced({
          pathPrefix: input.pathPrefix,
          excludePath: input.excludePath,
          includeExported: input.includeExported,
          limit: probe,
          offset: input.offset,
        });
        const p = paged(c);
        const { rows, ...rest } = p;
        return {
          kind: input.kind,
          ...rest,
          candidates: rows.map((x) => ({ ...slim(x.symbol, { sig: 'none' }), ...(x.note ? { note: x.note } : {}) })),
        };
      }
      case 'fan_out': {
        const { rows, ...rest } = paged(await store.hotspots({ pathPrefix: input.pathPrefix, limit: probe, offset: input.offset }));
        return { kind: input.kind, ...rest, symbols: rows.map((s) => slim(s, { sig: 'none' })) };
      }
      case 'cycles': {
        const cycles = await store.findCycles({ edge: 'DEPENDS_ON', scope: input.scope, pathPrefix: input.pathPrefix, limit: 101 });
        const { page, paging } = paginate(cycles, input.limit);
        return { kind: input.kind, scope: input.scope, ...paging, cycles: page };
      }
      case 'test_gap': {
        const { rows, ...rest } = paged(
          await store.untested({ pathPrefix: input.pathPrefix, excludePath: input.excludePath, limit: probe, offset: input.offset })
        );
        return { kind: input.kind, ...rest, symbols: rows.map((s) => slim(s, { sig: 'none' })) };
      }
    }
  });
}

export function jsonRenameSymbol(
  store: CodeStore,
  root: string | undefined,
  input: CodeToolInput<'rename_symbol'>
): Promise<unknown> {
  return guarded(store, async () => {
    if (!root) return { renamed: false, message: 'Renaming is unavailable (no workspace root).' };
    const r = await resolveOneJson(store, input.name, input.path);
    if ('ambiguous' in r) return ambiguousOut(r.candidates);
    if ('miss' in r) return { renamed: false, message: r.message, ...dym(r) };
    const plan = await planRename(store, root, r.sym, input.newName, { includeFuzzy: input.includeFuzzy });
    if ('message' in plan) return { renamed: false, message: plan.message };
    const touched = applyPlan(plan);
    return {
      renamed: true,
      from: r.sym.qualified || r.sym.name,
      to: input.newName,
      files: touched,
      sites: plan.sites.map((s) => ({ file: s.file, line: s.line, ...fuzzyOnly(s.confidence) })),
      ...(plan.collisionsElsewhere.length ? { collisionsElsewhere: plan.collisionsElsewhere.map((c) => slim(c, { sig: 'none' })) } : {}),
    };
  });
}

export function jsonGrepSymbols(store: CodeStore, input: CodeToolInput<'grep_symbols'>): Promise<unknown> {
  return guarded(store, async () => {
    const symbols = await store.grepSymbols(input.pattern, {
      isRegex: input.isRegex,
      kinds: input.kinds as SymbolKind[] | undefined,
      pathPrefix: input.pathPrefix,
      limit: 101,
    });
    const { page, paging } = paginate(symbols, input.limit);
    return {
      pattern: input.pattern,
      ...(input.isRegex ? { isRegex: true } : {}),
      ...paging,
      symbols: page.map((s) => slim(s)),
    };
  });
}

/**
 * context_pack (Step 6.2): one bundle for a symbol or file, composed from the
 * SAME calls find_symbol/who_calls/hierarchy already make plus one targeted
 * module-neighbour query (no whole-graph clustering) — just assembly.
 */
export function jsonContextPack(store: CodeStore, input: CodeToolInput<'context_pack'>): Promise<unknown> {
  return guarded(store, async () => {
    if (!input.name && !input.path) {
      return { message: 'context_pack needs `name` or `path`.' };
    }
    const bounded = <T extends { to?: string; from?: string }>(rows: T[]): { rows: T[]; more?: number } => ({
      rows: rows.slice(0, input.limit),
      ...(rows.length > input.limit ? { more: rows.length - input.limit } : {}),
    });
    const moduleEdges = async (file: string) => {
      const key = moduleKeyOf(file, {});
      const nb = await moduleNeighbours(store, key);
      const dep = bounded(nb.dependsOn);
      const by = bounded(nb.dependedOnBy);
      return {
        module: key,
        moduleEdges: {
          dependsOn: dep.rows.map((e) => ({ module: e.to, weight: e.weight })),
          ...(dep.more ? { moreDependsOn: dep.more } : {}),
          dependedOnBy: by.rows.map((e) => ({ module: e.from, weight: e.weight })),
          ...(by.more ? { moreDependedOnBy: by.more } : {}),
        },
      };
    };

    if (input.path && !input.name) {
      const p = await resolvePathArg(store, input.path);
      if ('error' in p) return pathError(p);
      const symbols = await store.outline(p.path);
      return {
        path: input.path,
        ...(p.path !== input.path ? { resolvedPath: p.path } : {}),
        symbols: symbols.slice(0, input.limit).map((s) => slim(s, { file: false })),
        ...(symbols.length > input.limit ? { moreSymbols: symbols.length - input.limit } : {}),
        ...(await moduleEdges(p.path)),
      };
    }

    const r = await resolveOneJson(store, input.name!, input.path);
    if ('ambiguous' in r) return ambiguousOut(r.candidates);
    if ('miss' in r) return { symbol: null, message: r.message, ...dym(r) };
    const sym = r.sym;

    const [callerEdges, calleeEdges, hierarchyRes, mod] = await Promise.all([
      store.edgesTo([sym.id], CALL_KINDS),
      store.edgesFrom([sym.id], CALL_KINDS),
      hierarchy(store, sym.id, 2),
      moduleEdges(sym.file),
    ]);
    const callerGroups = groupCallEdges(callerEdges, 'from');
    const calleeGroups = groupCallEdges(calleeEdges, 'to');
    const [callerSyms, calleeSyms] = await Promise.all([
      store.getMany(callerGroups.slice(0, input.limit).map((g) => g.id)),
      store.getMany(calleeGroups.slice(0, input.limit).map((g) => g.id)),
    ]);
    const items = (groups: CallGroup[], syms: Map<number, SymbolRecord>) =>
      groups
        .slice(0, input.limit)
        .map((g) => ({ s: syms.get(g.id), g }))
        .filter((x) => x.s)
        .map((x) => ({ ...slim(x.s!, { sig: 'none' }), ...groupExtras(x.g) }));
    const hnodes = (nodes: NonNullable<typeof hierarchyRes>['ancestors']) =>
      nodes.slice(0, input.limit).map((d) => ({ ...slim(d.symbol, { sig: 'none' }), depth: d.depth, ...fuzzyOnly(d.confidence) }));

    const hasHierarchy = !!hierarchyRes && (hierarchyRes.ancestors.length > 0 || hierarchyRes.descendants.length > 0);
    return {
      symbol: slim(sym),
      callers: { total: callerGroups.length, items: items(callerGroups, callerSyms) },
      callees: { total: calleeGroups.length, items: items(calleeGroups, calleeSyms) },
      ...(hasHierarchy
        ? { hierarchy: { ancestors: hnodes(hierarchyRes!.ancestors), descendants: hnodes(hierarchyRes!.descendants) } }
        : {}),
      ...mod,
    };
  });
}
