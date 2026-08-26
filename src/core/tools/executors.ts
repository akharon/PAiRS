/**
 * Tool executors: validated input → rendered text. One per codeToolSchemas
 * entry. Pure over the CodeStore contract + core/analyze — no MCP or vscode
 * types here, so the VS Code Language Model Tools surface (Phase 1.6) reuses
 * them verbatim.
 *
 * Rendering convention: every symbol cites `qualified  file:startLine` so an
 * agent can jump straight to the definition. Results are compact
 * text, not JSON — agents read prose more reliably and it costs fewer tokens.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { AmbiguousSymbol, DeadCodeCandidate, EdgeKind, SymbolRecord } from '../indexer/types';
import { impact } from '../analyze/impact';
import { hierarchy } from '../analyze/hierarchy';
import { moduleMap, moduleKeyOf } from '../analyze/moduleMap';
import type { ModuleMap } from '../analyze/moduleMap';
import { planRename, applyPlan } from './rename';
import type { CodeToolInput, CodeToolName } from './tools';

export interface ExecutorDeps {
  store: CodeStore;
  /** Workspace root. Required for rename_symbol/rename_revert (they write source files). */
  root?: string;
}

export type Executors = {
  [K in CodeToolName]: (input: CodeToolInput<K>) => Promise<string>;
};

// The extractor stores multi-line signatures with their source newlines and
// indentation verbatim. Left untruncated, a single overloaded/long-signature
// result can span 10 lines and push the `file:line` citation — the single
// most useful token in the output — off to the far end where it's easy to
// miss, defeating the "compact text" point of these tools. 100 chars keeps a
// typical signature readable while still fitting on one line; the full
// signature is always one `get_symbol` call away, which is the right place
// to pay for it.
const SIGNATURE_CITE_MAX = 100;

/**
 * @param full Skip whitespace-collapsing/truncation — for get_symbol, which
 *   exists precisely to return the complete shape.
 */
function cite(s: SymbolRecord, full = false): string {
  let sig = s.signature ? ` ${s.signature}` : '';
  if (sig && !full) {
    sig = sig.replace(/\s+/g, ' ');
    if (sig.length > SIGNATURE_CITE_MAX) sig = `${sig.slice(0, SIGNATURE_CITE_MAX)}…`;
  }
  return `${s.qualified || s.name} [${s.kind}]${sig}  ${s.file}:${s.startLine}`;
}

function isAmbiguous(x: SymbolRecord[] | AmbiguousSymbol): x is AmbiguousSymbol {
  return !Array.isArray(x) && x.ambiguous === true;
}

/** Resolve a name to a single symbol, or return a message asking to qualify. */
async function resolveOne(
  store: CodeStore,
  name: string,
  pathHint?: string
): Promise<{ sym: SymbolRecord } | { message: string }> {
  const hit = await store.lookup(name);
  if (isAmbiguous(hit)) {
    let cands = hit.candidates;
    if (pathHint) {
      const narrowed = cands.filter((c) => c.file === pathHint || c.file.endsWith(pathHint));
      if (narrowed.length === 1) return { sym: narrowed[0]! };
      if (narrowed.length > 0) cands = narrowed;
    }
    return {
      message:
        `"${name}" is ambiguous (${cands.length} definitions). Re-call qualified:\n` +
        cands.map((c) => `  - ${cite(c)}`).join('\n'),
    };
  }
  if (hit.length === 0) return { message: `No symbol named "${name}" in the index.` };
  if (hit.length === 1) return { sym: hit[0]! };
  // lookup returned an exact multi-match array (same qualified in >1 file).
  const chosen = pathHint ? hit.find((c) => c.file.endsWith(pathHint)) : undefined;
  return { sym: chosen ?? hit[0]! };
}

function paginate<T>(rows: T[], limit: number, offset = 0): { page: T[]; note: string } {
  const page = rows.slice(offset, offset + limit);
  const more = rows.length - (offset + page.length);
  const note = more > 0 ? `\n… ${more} more; re-call with offset ${offset + limit}.` : '';
  return { page, note };
}

const CALL_KINDS: EdgeKind[] = ['CALLS'];

/** Module keys are directory paths; anything else can't be safely inlined into SQL. */
const SAFE_MODULE_KEY = /^[\w./\-+@ ]+$/;

/**
 * Reference edges that make one module depend on another. Listed here rather
 * than imported from the store's schema so core keeps its one-way dependency
 * on the store contract (R10).
 */
const BOUNDARY_EDGE_KINDS: EdgeKind[] = ['DEPENDS_ON', 'CALLS', 'READS', 'WRITES', 'IMPLEMENTS', 'EXTENDS'];

/**
 * Drill into one module→module edge: the concrete symbol references that make
 * it exist. Without this a drift number is a verdict an agent can't act on —
 * "60% of weight crosses boundaries" says nothing about what to move, whereas
 * "these 4 uses of CodeStore are the whole edge" is a refactor.
 */
async function renderBoundary(
  store: CodeStore,
  map: ModuleMap,
  spec: string,
  limit: number,
  opts: { depth?: number }
): Promise<string> {
  const parts = spec.split(/\s*(?:->|→|=>)\s*/);
  const [from, to] = [parts[0]?.trim() ?? '', parts[1]?.trim() ?? ''];
  if (parts.length !== 2 || !from || !to) {
    return `boundary must be "<from module> -> <to module>", e.g. "${map.modules[0] ?? 'src/a'} -> ${map.modules[1] ?? 'src/b'}".`;
  }
  const known = new Set(map.modules);
  const unknown = [from, to].filter((m) => !known.has(m));
  if (unknown.length > 0) {
    const near = map.modules.filter((m) => unknown.some((u) => m.includes(u) || u.includes(m))).slice(0, 8);
    return (
      `Unknown module(s): ${unknown.join(', ')}. ` +
      (near.length ? `Did you mean: ${near.join(', ')}?` : `Call module_map without \`boundary\` for the module list.`)
    );
  }

  const edge = map.edges.find((e) => e.from === from && e.to === to);
  if (!edge) return `${from} does not depend on ${to} (no DEPENDS_ON edges cross that boundary).`;

  // Prefix-filter in SQL (cheap, coarse — subdirectories of the key slip
  // through), then re-key in TS so the module boundary is exact. Keys come
  // from indexed file paths, and are re-checked against the charset before
  // being inlined, so nothing user-shaped reaches the query. `_` and `%` are
  // LIKE wildcards and appear in real paths, so escape them explicitly.
  const prefixFilter = (side: 'a' | 'b', m: string): string =>
    m === '.' || !SAFE_MODULE_KEY.test(m)
      ? ''
      : ` AND ${side}.file LIKE '${m.replace(/[\\%_]/g, (c) => `\\${c}`)}%' ESCAPE '\\'`;
  const filter = prefixFilter('a', from) + prefixFilter('b', to);

  // All reference kinds, not just DEPENDS_ON: an import edge lands on the
  // target *file's* module symbol, which names the coupling but not its
  // content. CALLS/READS/OF_TYPE-style edges are what the source actually
  // uses, and those are what a refactor has to relocate or invert.
  const targets = new Map<string, { label: string; kind: string; where: string; via: Set<string>; refs: string[]; fuzzy: number }>();
  const rows = await store.query(
    `SELECT a.file AS af, e.line AS line, e.confidence AS conf, e.kind AS ek,
            b.file AS bf, b.name AS bn, b.kind AS bk, b.qualified AS bq, b.startLine AS bl
     FROM Edge e
     JOIN Symbol a ON a.id = e.src
     JOIN Symbol b ON b.id = e.dst
     WHERE e.kind IN (${BOUNDARY_EDGE_KINDS.map((k) => `'${k}'`).join(',')})
       AND a.file <> b.file AND COALESCE(e.test, 0) = 0${filter}`
  );
  for (const r of rows) {
    const af = String(r.af);
    const bf = String(r.bf);
    if (moduleKeyOf(af, opts) !== from || moduleKeyOf(bf, opts) !== to) continue;
    const key = `${r.bq || r.bn}@${bf}`;
    const t = targets.get(key) ?? {
      label: String(r.bq || r.bn),
      kind: String(r.bk ?? ''),
      where: `${bf}:${r.bl ?? '?'}`,
      via: new Set<string>(),
      refs: [],
      fuzzy: 0,
    };
    t.via.add(String(r.ek ?? 'REF'));
    t.refs.push(`${af}:${r.line ?? '?'}`);
    if (r.conf === 'fuzzy') t.fuzzy += 1;
    targets.set(key, t);
  }
  if (targets.size === 0) {
    return `${from} → ${to} has weight ×${edge.weight} in the map, but no symbol-level references survived filtering (the edge may be entirely fuzzy or test-only).`;
  }

  // Rank by CONFIRMED references first, fuzzy only as a tie-break. A fuzzy
  // edge is a bare name match (an `arr.push()` can land on any `push` method
  // in the target module), so letting fuzzy counts drive the order puts
  // resolver noise at the top of a list an agent is about to refactor from.
  // They stay listed — on some languages every cross-module use is fuzzy —
  // but they sort below anything the resolver actually confirmed.
  const confirmed = (t: { refs: string[]; fuzzy: number }): number => t.refs.length - t.fuzzy;
  const ranked = [...targets.values()].sort(
    (a, b) => confirmed(b) - confirmed(a) || b.refs.length - a.refs.length || a.label.localeCompare(b.label)
  );
  const { page, note } = paginate(ranked, limit);
  const inCycle = map.cycles.some((c) => c.includes(from) && c.includes(to));
  const crossCluster = map.drift.some((d) => d.from === from && d.to === to);
  const total = ranked.reduce((s, t) => s + t.refs.length, 0);

  return (
    `${from} → ${to}: ${total} reference(s) through ${ranked.length} symbol(s) of ${to}` +
    `${inCycle ? ' — this pair sits in a module cycle' : crossCluster ? ' — cross-subsystem (drift)' : ''}.\n` +
    `Removing this dependency means removing every use below.\n` +
    page
      .map(
        (t) =>
          `  - ${t.label}${t.kind ? ` [${t.kind}]` : ''}  ${t.where}  ← ${t.refs.length} ref(s)` +
          ` via ${[...t.via].join('/')}` +
          (t.fuzzy === t.refs.length ? '  [all fuzzy — name-matched, verify before acting]' : t.fuzzy ? `, ${t.fuzzy} fuzzy` : '') +
          '\n' +
          `      from ${t.refs.slice(0, 6).join(', ')}${t.refs.length > 6 ? `, +${t.refs.length - 6} more` : ''}`
      )
      .join('\n') +
    note
  );
}

/**
 * module_map's text form. Ordered by how much a reader has to act on it:
 * cycles first (objective, blocking), then the subsystem inventory annotated
 * with each module's layer and fan, then the modules whose position makes them
 * expensive to change, then the drift edges. The annotations are the point —
 * a bare list of directory names tells an agent nothing about which module is
 * a foundation and which is a leaf.
 */
function renderModuleMap(map: ModuleMap, limit: number): string {
  const metricOf = new Map(map.metrics.map((m) => [m.module, m]));
  const inCycle = new Set(map.cycles.flat());
  // ↻ marks a module whose layer is shared with the rest of its cycle — the
  // number is the condensed group's depth, not a position the module earned.
  const tag = (m: string): string => {
    const k = metricOf.get(m);
    return k ? `${m} (L${k.layer}${inCycle.has(m) ? '↻' : ''} ←${k.fanIn} →${k.fanOut})` : m;
  };

  const head =
    `${map.modules.length} modules in ${map.clusters.length} subsystem(s); ` +
    `drift ${(map.driftRatio * 100).toFixed(0)}% of dependency weight crosses subsystem boundaries; ` +
    `layout agreement ${(map.layoutDrift * 100).toFixed(0)}% (how well detected subsystems match the folder layout).\n` +
    `Per module: L = dependency layer (0 = depends on nothing), ↻ = in a cycle (layer shared with it), ` +
    `← fan-in (modules depending on it), → fan-out.`;

  const cycles = map.cycles.length
    ? `\n\nModule cycles (${map.cycles.length}) — no layering is valid while these exist:\n` +
      map.cycles
        .slice(0, limit)
        .map((c) => `  - ${c.length} modules: ${c.join(' ↔ ')}`)
        .join('\n') +
      `\nBreaking all of them takes cutting these ${map.cycleCuts.length} edge(s) (lightest first — ` +
      `invert the dependency or move the shared code down a layer):\n` +
      map.cycleCuts
        .slice(0, limit)
        .map((e) => `  - ${e.from} → ${e.to}  (×${e.weight}; module_map boundary: "${e.from} -> ${e.to}" lists the uses)`)
        .join('\n')
    : '';

  const clusters =
    `\n\nSubsystems:\n` +
    map.clusters.map((c, i) => `  subsystem ${i + 1} (${c.modules.length}): ${c.modules.map(tag).join(', ')}`).join('\n');

  // Foundations: everyone depends on them, so a change there is the widest
  // blast radius in the repo. Bottlenecks both serve and consume heavily —
  // the modules that make layering arguments hard.
  const byFanIn = [...map.metrics].sort((a, b) => b.fanIn - a.fanIn || a.module.localeCompare(b.module));
  const foundations = byFanIn
    .filter((m) => m.fanIn > 0)
    .slice(0, 5)
    .map((m) => `  - ${tag(m.module)}${m.files ? `  ${m.files} file(s)` : ''}`)
    .join('\n');
  const bottlenecks = [...map.metrics]
    .filter((m) => m.fanIn >= 2 && m.fanOut >= 2)
    .sort((a, b) => Math.min(b.fanIn, b.fanOut) - Math.min(a.fanIn, a.fanOut) || a.module.localeCompare(b.module))
    .slice(0, 5)
    .map((m) => `  - ${tag(m.module)}`)
    .join('\n');
  // Low cohesion over several files = the directory groups code that doesn't
  // reference itself. Usually a junk drawer, sometimes a pure leaf collection.
  const scattered = [...map.metrics]
    .filter((m) => m.cohesion !== null && m.cohesion < 0.2 && m.files >= 3)
    .sort((a, b) => a.cohesion! - b.cohesion! || a.module.localeCompare(b.module))
    .slice(0, 5)
    .map((m) => `  - ${m.module} (${m.files} files, cohesion ${m.cohesion!.toFixed(2)})`)
    .join('\n');

  const drift = map.drift.length
    ? `\n\nCross-subsystem edges (drift, heaviest first):\n` +
      map.drift.slice(0, limit).map((e) => `  - ${e.from} → ${e.to}  (×${e.weight})`).join('\n')
    : '\n\nNo cross-subsystem drift.';

  return (
    head +
    cycles +
    clusters +
    (foundations ? `\n\nMost depended-on (widest blast radius):\n${foundations}` : '') +
    (bottlenecks ? `\n\nBottlenecks (serve and consume heavily — hardest to layer):\n${bottlenecks}` : '') +
    (scattered ? `\n\nLow cohesion (files barely reference each other — may not be one module):\n${scattered}` : '') +
    drift
  );
}

export function createExecutors(deps: ExecutorDeps): Executors {
  const { store } = deps;

  return {
    async find_symbol(input) {
      const hit = await store.lookup(input.name);
      let syms = isAmbiguous(hit) ? hit.candidates : hit;
      if (input.kinds?.length) syms = syms.filter((s) => input.kinds!.includes(s.kind));
      if (input.langs?.length) syms = syms.filter((s) => input.langs!.includes(s.lang));
      if (syms.length === 0) return `No symbol named "${input.name}" (after filters).`;
      const { page, note } = paginate(syms, input.limit, input.offset);
      return `${page.length} definition(s) for "${input.name}":\n` + page.map((s) => `  - ${cite(s)}`).join('\n') + note;
    },

    async get_symbol(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const s = r.sym;
      const lines = [
        cite(s, true),
        s.doc ? `\ndoc: ${s.doc}` : '',
      ].filter(Boolean);
      if (input.includeMembers) {
        const members = await store.membersOf(s.id);
        if (members.length > 0) {
          lines.push(`\nmembers (${members.length}):`);
          for (const m of members) lines.push(`  - ${cite(m, true)}`);
        }
      }
      return lines.join('\n');
    },

    async outline(input) {
      const syms = await store.outline(input.path);
      if (syms.length === 0) return `No indexed symbols in ${input.path} (not indexed, or empty).`;
      // Same rationale as cite(): a multi-line signature interpolated verbatim
      // would blow up a file-wide listing far worse than a single find_symbol
      // hit does. Collapse + truncate here too rather than duplicating the
      // constant's reasoning.
      return (
        `${input.path} — ${syms.length} symbols:\n` +
        syms
          .map((s) => {
            let sig = s.signature ? ` ${s.signature.replace(/\s+/g, ' ')}` : '';
            if (sig.length > SIGNATURE_CITE_MAX + 1) sig = `${sig.slice(0, SIGNATURE_CITE_MAX)}…`;
            return `  ${s.startLine}: ${s.qualified || s.name} [${s.kind}]${sig}`;
          })
          .join('\n')
      );
    },

    async impact(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const res = await impact(store, r.sym.id, input.depth, undefined, input.includeTests);
      if (!res) return `No symbol id for "${input.name}".`;
      if (res.dependants.length === 0) return `Nothing depends on ${cite(res.seed)} within ${input.depth} hop(s).`;
      const { page, note } = paginate(res.dependants, input.limit);
      const trunc = res.truncated ? ` (walk truncated at depth ${input.depth})` : '';
      const body = page
        .map((d) => `  - d${d.depth} ${cite(d.symbol)}${d.confidence === 'fuzzy' ? '  [fuzzy]' : ''}`)
        .join('\n');
      // An agent must never mistake a filtered list for a complete one.
      const hiddenNote = res.hiddenTestEdges > 0 ? `\n(… ${res.hiddenTestEdges} test-file edge(s) hidden; pass includeTests to see them)` : '';
      return `${res.dependants.length} dependant(s) of ${res.seed.qualified || res.seed.name}${trunc}:\n${body}${note}${hiddenNote}`;
    },

    async hierarchy(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const res = await hierarchy(store, r.sym.id, input.depth);
      if (!res) return `No symbol id for "${input.name}".`;
      if (res.ancestors.length === 0 && res.descendants.length === 0) {
        return `No EXTENDS/IMPLEMENTS edges for ${cite(res.seed)} within ${input.depth} hop(s).`;
      }
      const render = (nodes: typeof res.ancestors) =>
        paginate(nodes, input.limit);
      const lines = [`Hierarchy for ${res.seed.qualified || res.seed.name}:`];
      if (res.ancestors.length > 0) {
        const { page, note } = render(res.ancestors);
        const trunc = res.ancestorsTruncated ? ` (walk truncated at depth ${input.depth})` : '';
        lines.push(`\n${res.ancestors.length} ancestor(s)${trunc}:`);
        lines.push(page.map((d) => `  - up${d.depth} ${cite(d.symbol)}${d.confidence === 'fuzzy' ? '  [fuzzy]' : ''}`).join('\n') + note);
      } else {
        lines.push('\nNo ancestors (extends/implements nothing indexed).');
      }
      if (res.descendants.length > 0) {
        const { page, note } = render(res.descendants);
        const trunc = res.descendantsTruncated ? ` (walk truncated at depth ${input.depth})` : '';
        lines.push(`\n${res.descendants.length} descendant(s)${trunc}:`);
        lines.push(page.map((d) => `  - down${d.depth} ${cite(d.symbol)}${d.confidence === 'fuzzy' ? '  [fuzzy]' : ''}`).join('\n') + note);
      } else {
        lines.push('\nNo descendants (nothing extends/implements this).');
      }
      return lines.join('\n');
    },

    async who_calls(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const edges =
        input.direction === 'callers'
          ? await store.edgesTo([r.sym.id], CALL_KINDS)
          : await store.edgesFrom([r.sym.id], CALL_KINDS);
      const fuzzyFiltered = input.includeFuzzy ? edges : edges.filter((e) => e.confidence !== 'fuzzy');
      const hiddenTestCount = input.includeTests ? 0 : fuzzyFiltered.filter((e) => e.test).length;
      const filtered = input.includeTests ? fuzzyFiltered : fuzzyFiltered.filter((e) => !e.test);
      if (filtered.length === 0) return `No ${input.direction} for ${cite(r.sym)}.`;
      // Paginate the edge list first, then fetch only that page's symbols —
      // fetching every counterpart before slicing made large fan-ins cost one
      // store round-trip per edge for rows that were then discarded.
      const { page: edgePage, note } = paginate(filtered, input.limit);
      const syms = await Promise.all(edgePage.map((e) => store.get(input.direction === 'callers' ? e.fromId : e.toId)));
      const page = syms.map((s, i) => ({ s, e: edgePage[i]! })).filter((x) => x.s);
      // Cite the *reference site*, not the counterpart's declaration line.
      // `EdgeRecord.line` is in `from`'s file, so it only re-anchors the
      // `callers` direction; for `callees` the edge line belongs to the
      // caller's file, not the callee's, so the declaration stands.
      //
      // Without this, N calls from one function collapsed into N identical
      // rows: `who_calls checkRules` printed `rules.test.ts:1` ten times for
      // ten distinct call sites, none of them navigable.
      const body = page
        .map((x) => {
          const at = input.direction === 'callers' ? `${x.s!.file}:${x.e.line}` : null;
          return `  - ${cite(x.s!)}${at ? `  → called at ${at}` : ''}${x.e.confidence === 'fuzzy' ? '  [fuzzy]' : ''}`;
        })
        .join('\n');
      // An agent must never mistake a filtered list for a complete one.
      const hiddenNote = hiddenTestCount > 0 ? `\n(… ${hiddenTestCount} test-file ${input.direction === 'callers' ? 'caller' : 'callee'}(s) hidden; pass includeTests to see them)` : '';
      return `${filtered.length} ${input.direction} of ${r.sym.qualified || r.sym.name}:\n${body}${note}${hiddenNote}`;
    },

    async file_deps(input) {
      const dir = input.direction === 'importers' ? 'importers' : 'imports';
      const deps = await store.fileEdges(input.path, dir, { transitive: input.transitive, limit: input.limit });
      if (deps.length === 0) return `No ${dir} for ${input.path}.`;
      const body = deps.map((d) => `  - d${d.depth} ${d.path}:${d.line}`).join('\n');
      return `${deps.length} ${dir} of ${input.path}:\n${body}`;
    },

    async module_map(input) {
      const opts = { depth: input.depth, resolution: input.resolution };
      const map = await moduleMap(store, opts);
      if (map.modules.length === 0) return 'No inter-module dependencies indexed (single module, or no DEPENDS_ON edges).';
      if (input.boundary) return renderBoundary(store, map, input.boundary, input.limit, opts);
      return renderModuleMap(map, input.limit);
    },

    async analyze(input) {
      switch (input.kind) {
        case 'dead_code': {
          const c = await store.unreferenced({
            pathPrefix: input.pathPrefix,
            excludePath: input.excludePath,
            includeExported: input.includeExported,
            limit: input.limit,
            offset: input.offset,
          });
          if (c.length === 0) return 'No dead-code candidates (given filters).';
          // The old blanket "verify each (syntactic only)" header understated
          // what's actually in the list: some candidates (like a type-only
          // interface) aren't just syntactically unverified, they're
          // structurally unprovable with this extractor — so that gets a
          // specific per-candidate note instead of one vague disclaimer.
          const noteText = (n: DeadCodeCandidate['note']): string =>
            n === 'type-only' ? '  [type-only — no reference edges are emitted for type positions]' : n ? `  [${n}]` : '';
          return `${c.length} dead-code candidate(s) — verify each (syntactic only):\n` +
            c.map((x) => `  - ${cite(x.symbol)}${noteText(x.note)}`).join('\n');
        }
        case 'fan_out': {
          const rows = await store.hotspots({ pathPrefix: input.pathPrefix, limit: input.limit, offset: input.offset });
          if (rows.length === 0) return 'No functions with outgoing calls found.';
          return `Top ${rows.length} by call fan-out:\n` + rows.map((s) => `  - ${cite(s)}`).join('\n');
        }
        case 'cycles': {
          const cycles = await store.findCycles({ edge: 'DEPENDS_ON', scope: input.scope, pathPrefix: input.pathPrefix, limit: input.limit });
          if (cycles.length === 0) return `No ${input.scope}-scope dependency cycles.`;
          return `${cycles.length} cycle(s):\n` + cycles.map((c, i) => `  ${i + 1}. ${c.join(' → ')} → ${c[0]}`).join('\n');
        }
        case 'test_gap': {
          const rows = await store.untested({ pathPrefix: input.pathPrefix, excludePath: input.excludePath, limit: input.limit, offset: input.offset });
          if (rows.length === 0) return 'No untested exported symbols (given filters).';
          return `${rows.length} exported symbol(s) with no test reference:\n` + rows.map((s) => `  - ${cite(s)}`).join('\n');
        }
      }
    },

    async rename_symbol(input) {
      if (!deps.root) return 'Renaming is unavailable (server started without a workspace root).';
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const plan = await planRename(store, deps.root, r.sym, input.newName, {
        includeFuzzy: input.includeFuzzy,
      });
      if ('message' in plan) return plan.message;
      const touched = applyPlan(plan);
      const fuzzyCount = plan.sites.filter((s) => s.confidence === 'fuzzy').length;
      const fuzzyNote = fuzzyCount > 0 ? ` (${fuzzyCount} fuzzy site(s) included)` : '';
      return (
        `Renamed ${r.sym.qualified || r.sym.name} → ${input.newName} across ${touched.length} file(s)` +
        `${fuzzyNote}:\n` +
        touched.map((f) => `  - ${f}`).join('\n') +
        `\nRevert via your VCS (e.g. \`git checkout -- <files>\`) if needed.`
      );
    },
  };
}
