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
import { impact, IMPACT_MAX_NODES } from '../analyze/impact';
import { diffImpact } from '../analyze/diffImpact';
import type { DiffHunk } from '../analyze/diffImpact';
import { hierarchy } from '../analyze/hierarchy';
import { moduleMap, moduleKeyOf, moduleNeighbours } from '../analyze/moduleMap';
import type { ModuleMap } from '../analyze/moduleMap';
import { planRename, applyPlan } from './rename';
import type { CodeToolInput, CodeToolName } from './tools';

export interface ExecutorDeps {
  store: CodeStore;
  /** Workspace root. Required for rename_symbol/rename_revert (they write source files). */
  root?: string;
  /**
   * Reads a workspace-relative file's text, or returns null if unreadable.
   * Injected rather than importing `fs` here so core stays free of I/O (R10)
   * and the preview path is testable without a real workspace. When absent,
   * `preview` degrades to doc-only — never to an error.
   */
  readSource?: (relPath: string) => string | null;
  /**
   * Returns the changed line ranges of the current diff. Injected for the same
   * reason as readSource: core must not shell out to git (R10), and
   * diff_impact stays testable without a repository. When absent, diff_impact
   * reports that it is unavailable rather than answering "nothing changed" —
   * an empty blast radius from a missing diff source would read as "safe".
   */
  collectDiff?: (src: { rev?: string; staged?: boolean }) => Promise<DiffHunk[]>;
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

/** One-line, length-capped signature (whitespace collapsed). Shared with the CLI JSON builders. */
export function shortSignature(sig: string): string {
  const one = sig.replace(/\s+/g, ' ').trim();
  return one.length > SIGNATURE_CITE_MAX ? `${one.slice(0, SIGNATURE_CITE_MAX)}…` : one;
}

/**
 * The one line every empty-index answer collapses to. An empty index makes
 * every query a miss, and "No symbol named X" would read as a real answer —
 * the agent then greps, or worse, concludes the symbol doesn't exist.
 */
export const EMPTY_INDEX_MESSAGE =
  'PAiRS index for this workspace is empty — run `pairs index` (or open the folder in VS Code with the PAiRS extension).';

/** EMPTY_INDEX_MESSAGE when the store has no indexed files, else null. Used by every executor and JSON builder. */
export async function emptyIndexMessage(store: CodeStore): Promise<string | null> {
  return (await store.fileCount()) === 0 ? EMPTY_INDEX_MESSAGE : null;
}

/**
 * Footer for a truncated list: always states how many items were dropped and
 * the argument that reveals them — a bounded list must never look complete.
 * `canOffset` tools whose limit can't grow any further page with `offset`.
 */
export function moreFooter(
  more: number,
  o: { limit: number; offset?: number; max?: number; canOffset?: boolean; atLeast?: boolean }
): string {
  const offset = o.offset ?? 0;
  const max = o.max ?? 200;
  const n = `${more}${o.atLeast ? '+' : ''}`;
  if (o.canOffset && (offset > 0 || o.limit + more > max)) return `\n… +${n} more (pass offset=${offset + o.limit})`;
  return `\n… +${n} more (pass limit=${Math.min(o.limit + more + offset, max)})`;
}

/**
 * @param full Skip whitespace-collapsing/truncation — for get_symbol, which
 *   exists precisely to return the complete shape.
 * @param sig Include the signature. List tools whose rows are navigation
 *   targets (impact, who_calls, …) pass false: a dependant's parameter list is
 *   rarely what the reader needs and costs ~30% of the row.
 */
function cite(s: SymbolRecord, full = false, sig = true): string {
  let sigText = sig && s.signature ? ` ${s.signature}` : '';
  if (sigText && !full) sigText = ` ${shortSignature(sigText)}`;
  return `${s.qualified || s.name} [${s.kind}]${sigText}  ${s.file}:${s.startLine}`;
}

/** cite() without the signature: for rows that are only navigation targets. */
const citeBare = (s: SymbolRecord): string => cite(s, false, false);

/**
 * Lines of a symbol's body to inline in a hit. Three lines is the point where
 * a reader can tell an implementation from a stub or a re-export without
 * paying for the whole body — past that the caller should be Reading the file
 * anyway, which is why this is a hard cap rather than a parameter.
 */
const PREVIEW_MAX_LINES = 3;
/** Per-line cap, same reasoning as SIGNATURE_CITE_MAX: one hit stays one screen row. */
const PREVIEW_LINE_MAX = 120;
/** Continuation indent, matching the `from ...` continuation in renderBoundary. */
const PREVIEW_INDENT = '      ';

function truncatePreviewLine(l: string): string {
  return l.length > PREVIEW_LINE_MAX ? `${l.slice(0, PREVIEW_LINE_MAX)}\u2026` : l;
}

/**
 * Strip the excerpt's common indentation. Measured over non-blank lines only:
 * a blank line inside a body has no leading whitespace to speak of, and
 * letting it count would pin the shared indent at 0 and leave every real line
 * pushed off to the right by its original nesting depth.
 */
function dedentPreview(lines: string[]): string[] {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!Number.isFinite(min) || min === 0) return lines;
  return lines.map((l) => l.slice(min));
}

/**
 * The doc line and first few body lines of a symbol. This is the whole point
 * of `preview`: a signature tells an agent where a symbol is, but not whether
 * it is a real implementation, a stub, or a re-export — and answering that
 * question with a Read costs far more tokens than three lines do.
 *
 * Never throws and never returns a partial error string: a stale index or an
 * unreadable file degrades the hit to doc-only (or to nothing), because a
 * preview is an optimisation and must not be able to fail the tool.
 *
 * Returns '' when there is nothing to show; callers must then emit nothing
 * extra, not a blank line.
 */
function renderPreview(
  s: SymbolRecord,
  read?: (p: string) => string | null,
  opts?: { includeDoc?: boolean }
): string {
  const out: string[] = [];
  if (opts?.includeDoc !== false && s.doc) {
    const first = s.doc.split('\n')[0]!.trim();
    if (first) out.push(`${PREVIEW_INDENT}doc: ${truncatePreviewLine(first)}`);
  }
  if (read) {
    let text: string | null = null;
    try {
      text = read(s.file);
    } catch {
      text = null;
    }
    if (text !== null) {
      const lines = text.split('\n');
      // startLine is 1-based and comes from the index, which can be stale
      // relative to disk — an out-of-range start yields an empty slice here
      // rather than an exception.
      const start = s.startLine - 1;
      const end = Math.min(s.endLine, lines.length);
      const slice = lines.slice(start, Math.min(end, start + PREVIEW_MAX_LINES));
      if (slice.length > 0) {
        for (const l of dedentPreview(slice)) out.push(`${PREVIEW_INDENT}${truncatePreviewLine(l)}`);
        const remaining = end - start - slice.length;
        if (remaining > 0) out.push(`${PREVIEW_INDENT}\u2026 (${remaining} more line(s))`);
      }
    }
  }
  return out.join('\n');
}

function isAmbiguous(x: SymbolRecord[] | AmbiguousSymbol): x is AmbiguousSymbol {
  return !Array.isArray(x) && x.ambiguous === true;
}

/** Hint `tools.ts` matches `src/core/tools/tools.ts` but not `src/xtools.ts` (suffix on a `/` boundary). */
export function pathMatchesHint(file: string, hint: string): boolean {
  const h = hint.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return file === h || file.endsWith(`/${h}`);
}

/** Max paths named in an ambiguity / suggestion message. */
const PATHS_SHOWN = 5;

/** The `Did you mean: a, b, c?` tail for a symbol miss (empty when there is nothing close). */
export function didYouMeanTail(names: readonly string[]): string {
  return names.length ? ` Did you mean: ${names.join(', ')}?` : '';
}

/** Outcome of resolving a user-supplied file path (see CodeStore.resolveFilePath). */
export type PathResolution =
  | { path: string; /** `(resolved a → b)\n` when the input was not already the indexed path, else ''. */ note: string }
  | { error: 'no_file'; input: string; suggestions: string[]; message: string }
  | { error: 'ambiguous_path'; input: string; matches: string[]; message: string };

/**
 * Resolve a file path argument: exact, normalised, or unique `/`-boundary
 * suffix. A miss says "no such indexed file" (with near matches) so it can
 * never be mistaken for a genuinely empty result for a real file.
 */
export async function resolvePathArg(store: CodeStore, input: string): Promise<PathResolution> {
  const r = await store.resolveFilePath(input);
  if ('exact' in r) {
    return { path: r.exact, note: r.exact === input ? '' : `(resolved ${input} → ${r.exact})\n` };
  }
  if (r.matches.length > 1) {
    const shown = r.matches.slice(0, PATHS_SHOWN).join(', ') + (r.matches.length > PATHS_SHOWN ? `, +${r.matches.length - PATHS_SHOWN} more` : '');
    return {
      error: 'ambiguous_path',
      input,
      matches: r.matches.slice(0, PATHS_SHOWN),
      message: `"${input}" is ambiguous: ${shown} (pass the full path).`,
    };
  }
  return {
    error: 'no_file',
    input,
    suggestions: r.closest,
    message: `No indexed file matches "${input}".${r.closest.length ? ` Closest: ${r.closest.join(', ')}.` : ''}`,
  };
}

/** "No symbol named …" plus close names, so the next call is a retry rather than a grep. */
async function symbolMiss(store: CodeStore, name: string, suffix = ' in the index'): Promise<string> {
  return `No symbol named "${name}"${suffix}.` + didYouMeanTail(await store.suggestNames(name));
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
      const narrowed = cands.filter((c) => pathMatchesHint(c.file, pathHint));
      if (narrowed.length === 1) return { sym: narrowed[0]! };
      if (narrowed.length > 0) cands = narrowed;
    }
    return {
      message:
        `"${name}" is ambiguous (${cands.length} definitions). Re-call qualified:\n` +
        cands.map((c) => `  - ${cite(c)}`).join('\n'),
    };
  }
  if (hit.length === 0) return { message: await symbolMiss(store, name) };
  if (hit.length === 1) return { sym: hit[0]! };
  // lookup returned an exact multi-match array (same qualified in >1 file).
  const chosen = pathHint ? hit.find((c) => pathMatchesHint(c.file, pathHint)) : undefined;
  return { sym: chosen ?? hit[0]! };
}

/** One caller (or callee) with every call site collapsed into it. */
export interface CallGroup {
  id: number;
  /** Distinct call-site lines, ascending. */
  lines: number[];
  /** Total edges (call sites) folded in. */
  n: number;
  fuzzy: number;
  test: number;
}

/** Group call edges by counterpart symbol, in first-seen order (the store's order). */
export function groupCallEdges(
  edges: ReadonlyArray<{ fromId: number; toId: number; line: number; confidence: string; test?: boolean | number }>,
  side: 'from' | 'to'
): CallGroup[] {
  const byId = new Map<number, CallGroup>();
  for (const e of edges) {
    const id = side === 'from' ? e.fromId : e.toId;
    let g = byId.get(id);
    if (!g) byId.set(id, (g = { id, lines: [], n: 0, fuzzy: 0, test: 0 }));
    g.n++;
    if (e.line && !g.lines.includes(e.line)) g.lines.push(e.line);
    if (e.confidence === 'fuzzy') g.fuzzy++;
    if (e.test) g.test++;
  }
  const out = [...byId.values()];
  for (const g of out) g.lines.sort((a, b) => a - b);
  return out;
}

/** Call-site lines shown per grouped caller; the `×N` count says how many exist. */
export const SITES_SHOWN = 5;

const groupFuzzy = (g: CallGroup): string => (g.fuzzy === 0 ? '' : g.fuzzy === g.n ? '  [fuzzy]' : `  [${g.fuzzy} fuzzy]`);

/** `×N (lines a, b, c, d, e, …)`; the ellipsis means more distinct lines exist than shown. */
function groupSites(g: CallGroup): string {
  const shown = g.lines.slice(0, SITES_SHOWN).join(', ');
  return `×${g.n}${shown ? ` (lines ${shown}${g.lines.length > SITES_SHOWN ? ', …' : ''})` : ''}`;
}

/** One row per caller: `file:line` when it calls once, `file ×N (lines …)` when it calls repeatedly. */
function callerRow(s: SymbolRecord, g: CallGroup): string {
  const label = s.qualified || s.name;
  if (g.n === 1) return `  - ${label} [${s.kind}]  ${s.file}:${g.lines[0] ?? 0}${groupFuzzy(g)}`;
  // A module symbol is named by its path: don't print the file twice.
  return `  - ${label} [${s.kind}]${label === s.file ? '' : `  ${s.file}`} ${groupSites(g)}${groupFuzzy(g)}`;
}

/** One row per callee: its declaration, plus the repeat count when called more than once. */
const calleeRow = (s: SymbolRecord, g: CallGroup): string => `  - ${citeBare(s)}${g.n > 1 ? ` ${groupSites(g)}` : ''}${groupFuzzy(g)}`;

/**
 * @param offset rows to skip within `rows`
 * @param o.max the tool's schema maximum for `limit`
 * @param o.canOffset the tool has an `offset` parameter (else only `limit` can grow)
 * @param o.baseOffset offset the store already applied before returning `rows`
 * @param o.atLeast `rows` was itself capped, so the dropped count is a lower bound
 */
function paginate<T>(
  rows: T[],
  limit: number,
  offset = 0,
  o: { max?: number; canOffset?: boolean; baseOffset?: number; atLeast?: boolean } = {}
): { page: T[]; note: string } {
  const page = rows.slice(offset, offset + limit);
  const more = rows.length - (offset + page.length);
  const note =
    more > 0
      ? moreFooter(more, { limit, offset: offset + (o.baseOffset ?? 0), max: o.max, canOffset: o.canOffset, atLeast: o.atLeast })
      : '';
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
  const { page, note } = paginate(ranked, limit, 0, { max: 100 });
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

  const foot = (total: number): string => (total > limit ? moreFooter(total - limit, { limit, max: 100 }) : '');
  const MODS_PER_LINE = 12;
  const capList = (items: string[]): string =>
    items.length > MODS_PER_LINE ? `${items.slice(0, MODS_PER_LINE).join(' ↔ ')} … +${items.length - MODS_PER_LINE} more` : items.join(' ↔ ');

  const cycles = map.cycles.length
    ? `\n\nModule cycles (${map.cycles.length}) — no layering is valid while these exist:\n` +
      map.cycles
        .slice(0, limit)
        .map((c) => `  - ${c.length} modules: ${capList(c)}`)
        .join('\n') +
      foot(map.cycles.length) +
      `\nBreaking all of them takes cutting these ${map.cycleCuts.length} edge(s) (lightest first; ` +
      `\`boundary: "a -> b"\` lists the uses):\n` +
      map.cycleCuts
        .slice(0, limit)
        .map((e) => `  - ${e.from} → ${e.to}  (×${e.weight})`)
        .join('\n') +
      foot(map.cycleCuts.length)
    : '';

  const tagMods = (mods: string[]): string =>
    mods.length > MODS_PER_LINE
      ? `${mods.slice(0, MODS_PER_LINE).map(tag).join(', ')}, … +${mods.length - MODS_PER_LINE} more`
      : mods.map(tag).join(', ');
  const clusters =
    `\n\nSubsystems:\n` +
    map.clusters
      .slice(0, limit)
      .map((c, i) => `  subsystem ${i + 1} (${c.modules.length}): ${tagMods(c.modules)}`)
      .join('\n') +
    foot(map.clusters.length);

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
      map.drift.slice(0, limit).map((e) => `  - ${e.from} → ${e.to}  (×${e.weight})`).join('\n') +
      foot(map.drift.length)
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

/** `limit` the store is asked for when the caller only needs to know whether more rows exist. */
const PROBE_MAX = { analyze: 100, grep: 100, fileDeps: 200, cycles: 100 } as const;

/** Cycle members shown per line; a 40-module SCC is noise past this. */
const CYCLE_MEMBERS_MAX = 12;
/** Members listed by get_symbol for a large type. */
const MEMBERS_MAX = 40;

const fuzzyTag = (c: string): string => (c === 'fuzzy' ? '  [fuzzy]' : '');

export function createExecutors(deps: ExecutorDeps): Executors {
  const { store } = deps;

  const base: Executors = {
    async find_symbol(input) {
      const hit = await store.lookup(input.name);
      let syms = isAmbiguous(hit) ? hit.candidates : hit;
      if (input.kinds?.length) syms = syms.filter((s) => input.kinds!.includes(s.kind));
      if (input.langs?.length) syms = syms.filter((s) => input.langs!.includes(s.lang));
      if (syms.length === 0) {
        const hadAny = isAmbiguous(hit) ? hit.candidates.length > 0 : hit.length > 0;
        // Filtered-out hits exist, so a near-name suggestion would only mislead.
        return hadAny ? `No symbol named "${input.name}" (after filters).` : await symbolMiss(store, input.name, '');
      }
      const { page, note } = paginate(syms, input.limit, input.offset, { max: 50, canOffset: true });
      const body = page
        .map((s) => {
          const line = `  - ${cite(s)}`;
          if (!input.preview) return line;
          const p = renderPreview(s, deps.readSource);
          return p ? `${line}\n${p}` : line;
        })
        .join('\n');
      return `${page.length} definition(s) for "${input.name}":\n` + body + note;
    },

    async get_symbol(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const s = r.sym;
      const lines = [
        cite(s, true),
        s.doc ? `\ndoc: ${s.doc}` : '',
      ].filter(Boolean);
      // Unconditional here (unlike find_symbol's opt-in flag): get_symbol is
      // by definition the "show me this symbol's shape" call, so the excerpt
      // is always what the caller came for. includeDoc is off because the doc
      // is already rendered on its own line above.
      const preview = renderPreview(s, deps.readSource, { includeDoc: false });
      if (preview) lines.push(`\nbody:\n${preview}`);
      if (input.includeMembers) {
        const members = await store.membersOf(s.id);
        if (members.length > 0) {
          // Members get the capped one-line citation: the type's own signature
          // above is the full-fidelity part, and a large class would otherwise
          // dump every method's untruncated signature into one answer.
          lines.push(`\nmembers (${members.length}):`);
          for (const m of members.slice(0, MEMBERS_MAX)) lines.push(`  - ${cite(m)}`);
          if (members.length > MEMBERS_MAX) lines.push(`… +${members.length - MEMBERS_MAX} more (use outline on ${s.file})`);
        }
      }
      return lines.join('\n');
    },

    async outline(input) {
      const p = await resolvePathArg(store, input.path);
      if ('error' in p) return p.message;
      const syms = await store.outline(p.path);
      if (syms.length === 0) return `${p.note}${p.path} is indexed but declares no symbols.`;
      // Same rationale as cite(): a multi-line signature interpolated verbatim
      // would blow up a file-wide listing far worse than a single find_symbol
      // hit does.
      return (
        p.note +
        `${p.path} — ${syms.length} symbols:\n` +
        syms
          .map((s) => {
            const sig = s.signature ? ` ${shortSignature(s.signature)}` : '';
            return `  ${s.startLine}: ${s.qualified || s.name} [${s.kind}]${sig}`;
          })
          .join('\n')
      );
    },

    async impact(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      // An empty `kinds` array must mean "no restriction", not "no kinds":
      // passing [] through would hit impact()'s kinds.length === 0 early
      // return and answer "nothing depends on X" — the most dangerous
      // possible false negative right before a rename or a delete.
      const kinds = input.kinds?.length ? input.kinds : undefined;
      // A filtered empty result reads as "safe to delete" unless the header
      // says what was filtered out.
      const kindNote = kinds ? ` via ${kinds.join('/')} only` : '';
      const res = await impact(store, r.sym.id, input.depth, kinds, input.includeTests);
      if (!res) return `No symbol id for "${input.name}".`;
      if (res.dependants.length === 0) return `Nothing depends on ${cite(res.seed)} within ${input.depth} hop(s)${kindNote}.`;
      const { page, note } = paginate(res.dependants, input.limit, 0, { max: 200 });
      const trunc = res.capped
        ? ` (walk capped at ${IMPACT_MAX_NODES} nodes — a hub; narrow with kinds or depth)`
        : res.truncated
          ? ` (walk truncated at depth ${input.depth})`
          : '';
      const body = page.map((d) => `  - d${d.depth} ${citeBare(d.symbol)}${fuzzyTag(d.confidence)}`).join('\n');
      // An agent must never mistake a filtered list for a complete one.
      const hiddenNote = res.hiddenTestEdges > 0 ? `\n(… ${res.hiddenTestEdges} test-file edge(s) hidden; pass includeTests to see them)` : '';
      return `${res.dependants.length} dependant(s)${kindNote} of ${res.seed.qualified || res.seed.name}${trunc}:\n${body}${note}${hiddenNote}`;
    },

    async diff_impact(input) {
      if (!deps.collectDiff) return 'diff_impact is unavailable here (no diff source configured).';
      let hunks: DiffHunk[];
      try {
        hunks = await deps.collectDiff({ rev: input.rev, staged: input.staged });
      } catch (err) {
        return `Could not read the diff: ${(err as Error).message}`;
      }
      if (hunks.length === 0) {
        const what = input.rev ? `\`${input.rev}\`` : input.staged ? 'the index' : 'the working tree';
        return `No changes in ${what} — nothing to analyze.`;
      }
      const kinds = input.kinds?.length ? input.kinds : undefined;
      const kindNote = kinds ? ` via ${kinds.join('/')} only` : '';
      const res = await diffImpact(store, hunks, input.depth, kinds, input.includeTests);

      const lines: string[] = [];
      lines.push(
        `${res.changed.length} changed symbol(s) across ${new Set(res.changed.map((c) => c.symbol.file)).size} file(s):`
      );
      const changed = paginate(res.changed, input.limit, 0, { max: 200 });
      for (const c of changed.page) lines.push(`  * ${citeBare(c.symbol)}`);
      if (changed.note) lines.push(changed.note.trimStart());

      if (res.dependants.length === 0) {
        lines.push(`\nNothing depends on the changed symbols within ${input.depth} hop(s)${kindNote}.`);
      } else {
        const external = res.dependants.filter((d) => !d.alsoChanged);
        const { page, note } = paginate(external, input.limit, input.offset, { max: 200, canOffset: true });
        const trunc = res.truncated ? ` (walk truncated at depth ${input.depth})` : '';
        lines.push(`\n${external.length} dependant(s)${kindNote} outside the change${trunc}:`);
        // seedCount is the payload a per-symbol impact call cannot give: a
        // dependant reached from several changed symbols is one review, not N.
        lines.push(
          page
            .map((d) => {
              const shared = d.viaSeeds.length > 1 ? `  [via ${d.viaSeeds.length} changed symbols]` : '';
              return `  - d${d.depth} ${citeBare(d.symbol)}${fuzzyTag(d.confidence)}${shared}`;
            })
            .join('\n') + note
        );
        const files = paginate(res.affectedFiles, input.limit, 0, { max: 200 });
        lines.push(`\n${res.affectedFiles.length} file(s) to re-check:`);
        for (const f of files.page) lines.push(`  ${f}`);
        if (files.note) lines.push(files.note.trimStart());
      }

      if (res.unattributed.length > 0) {
        // Never fold this into the dependant count: these are changes the walk
        // could not reason about at all, so "0 dependants" plus a silent
        // unattributed hunk would be a false all-clear.
        lines.push(`\n${res.unattributed.length} changed hunk(s) matched no indexed symbol (review by hand):`);
        const un = paginate(res.unattributed, input.limit, 0, { max: 200 });
        for (const u of un.page) lines.push(`  ${u.path}:${u.startLine}-${u.endLine} [${u.reason}]`);
        if (un.note) lines.push(un.note.trimStart());
      }
      if (res.hiddenTestEdges > 0) {
        lines.push(`\n(… ${res.hiddenTestEdges} test-file edge(s) hidden; pass includeTests to see them)`);
      }
      return lines.join('\n');
    },

    async hierarchy(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const res = await hierarchy(store, r.sym.id, input.depth);
      if (!res) return `No symbol id for "${input.name}".`;
      if (res.ancestors.length === 0 && res.descendants.length === 0) {
        return `No EXTENDS/IMPLEMENTS edges for ${cite(res.seed)} within ${input.depth} hop(s).`;
      }
      const render = (nodes: typeof res.ancestors) => paginate(nodes, input.limit, 0, { max: 200 });
      const lines = [`Hierarchy for ${res.seed.qualified || res.seed.name}:`];
      if (res.ancestors.length > 0) {
        const { page, note } = render(res.ancestors);
        const trunc = res.ancestorsTruncated ? ` (walk truncated at depth ${input.depth})` : '';
        lines.push(`\n${res.ancestors.length} ancestor(s)${trunc}:`);
        lines.push(page.map((d) => `  - up${d.depth} ${citeBare(d.symbol)}${fuzzyTag(d.confidence)}`).join('\n') + note);
      } else {
        lines.push('\nNo ancestors (extends/implements nothing indexed).');
      }
      if (res.descendants.length > 0) {
        const { page, note } = render(res.descendants);
        const trunc = res.descendantsTruncated ? ` (walk truncated at depth ${input.depth})` : '';
        lines.push(`\n${res.descendants.length} descendant(s)${trunc}:`);
        lines.push(page.map((d) => `  - down${d.depth} ${citeBare(d.symbol)}${fuzzyTag(d.confidence)}`).join('\n') + note);
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
      const side = input.direction === 'callers' ? 'from' : 'to';
      const hiddenTestCount = input.includeTests
        ? 0
        : groupCallEdges(fuzzyFiltered.filter((e) => e.test), side).length;
      const filtered = input.includeTests ? fuzzyFiltered : fuzzyFiltered.filter((e) => !e.test);
      if (filtered.length === 0) return `No ${input.direction} for ${cite(r.sym)}.`;
      // One row per distinct caller/callee: a test file calling the seed 19
      // times used to be 19 near-identical rows. Count, paginate and footer
      // all work on the groups, so `limit`/`offset` mean distinct counterparts.
      const groups = groupCallEdges(filtered, side);
      // Fetch only the page's symbols — fetching every counterpart before
      // slicing made large fan-ins cost a store round-trip per discarded row.
      const { page: groupPage, note } = paginate(groups, input.limit, 0, { max: 100 });
      const syms = await store.getMany(groupPage.map((g) => g.id));
      const page = groupPage.map((g) => ({ s: syms.get(g.id), g })).filter((x) => x.s);
      // Callers are cited at the *reference site* (`EdgeRecord.line` is in the
      // caller's file), not at the caller's declaration. For callees the edge
      // line belongs to the seed's file, so the callee's declaration stands.
      const body = page.map(({ s, g }) => (input.direction === 'callers' ? callerRow(s!, g) : calleeRow(s!, g))).join('\n');
      // An agent must never mistake a filtered list for a complete one.
      const hiddenNote = hiddenTestCount > 0 ? `\n(… ${hiddenTestCount} test-file ${input.direction === 'callers' ? 'caller' : 'callee'}(s) hidden; pass includeTests to see them)` : '';
      const sites = input.direction === 'callers' ? ' (file:line = call site)' : '';
      const total = groups.length === filtered.length ? '' : ` / ${filtered.length} call sites`;
      return `${groups.length} ${input.direction}${total} of ${r.sym.qualified || r.sym.name}${sites}:\n${body}${note}${hiddenNote}`;
    },

    async file_deps(input) {
      const dir = input.direction === 'importers' ? 'importers' : 'imports';
      // Probe past the cap so a truncated list says how much is missing.
      const p = await resolvePathArg(store, input.path);
      if ('error' in p) return p.message;
      const all = await store.fileEdges(p.path, dir, { transitive: input.transitive, limit: PROBE_MAX.fileDeps + 1 });
      if (all.length === 0) return `${p.note}No ${dir} for ${p.path}.`;
      const { page, note } = paginate(all, input.limit, 0, { max: 200, atLeast: all.length > PROBE_MAX.fileDeps });
      const body = page.map((d) => `  - ${input.transitive ? `d${d.depth} ` : ''}${d.path}:${d.line}`).join('\n');
      return `${p.note}${all.length > PROBE_MAX.fileDeps ? `${PROBE_MAX.fileDeps}+` : all.length} ${dir} of ${p.path}:\n${body}${note}`;
    },

    async module_map(input) {
      const opts = { depth: input.depth, resolution: input.resolution };
      const map = await moduleMap(store, opts);
      if (map.modules.length === 0) return 'No inter-module dependencies indexed (single module, or no DEPENDS_ON edges).';
      if (input.boundary) return renderBoundary(store, map, input.boundary, input.limit, opts);
      return renderModuleMap(map, input.limit);
    },

    async analyze(input) {
      const probe = PROBE_MAX.analyze + 1;
      // Rows come back from the store already offset; paginate only trims to
      // `limit` and words the footer (baseOffset keeps its offset= hint right).
      const pageOf = <T>(rows: T[]): { page: T[]; note: string } =>
        paginate(rows, input.limit, 0, { max: 100, canOffset: true, baseOffset: input.offset, atLeast: rows.length >= probe });
      switch (input.kind) {
        case 'dead_code': {
          const c = await store.unreferenced({
            pathPrefix: input.pathPrefix,
            excludePath: input.excludePath,
            includeExported: input.includeExported,
            limit: probe,
            offset: input.offset,
          });
          if (c.length === 0) return 'No dead-code candidates (given filters).';
          // Some candidates (like a type-only interface) aren't just
          // syntactically unverified, they're structurally unprovable with this
          // extractor — so those get a specific per-candidate note.
          const noteText = (n: DeadCodeCandidate['note']): string =>
            n === 'type-only' ? '  [type-only — no reference edges are emitted for type positions]' : n ? `  [${n}]` : '';
          const { page, note } = pageOf(c);
          return `${page.length} dead-code candidate(s) — verify each (syntactic only):\n` +
            page.map((x) => `  - ${citeBare(x.symbol)}${noteText(x.note)}`).join('\n') + note;
        }
        case 'fan_out': {
          const rows = await store.hotspots({ pathPrefix: input.pathPrefix, limit: probe, offset: input.offset });
          if (rows.length === 0) return 'No functions with outgoing calls found.';
          const { page, note } = pageOf(rows);
          return `Top ${page.length} by call fan-out:\n` + page.map((s) => `  - ${citeBare(s)}`).join('\n') + note;
        }
        case 'cycles': {
          const cycles = await store.findCycles({ edge: 'DEPENDS_ON', scope: input.scope, pathPrefix: input.pathPrefix, limit: PROBE_MAX.cycles + 1 });
          if (cycles.length === 0) return `No ${input.scope}-scope dependency cycles.`;
          const { page, note } = paginate(cycles, input.limit, 0, { max: 100, atLeast: cycles.length > PROBE_MAX.cycles });
          const ring = (c: string[]): string =>
            (c.length > CYCLE_MEMBERS_MAX ? [...c.slice(0, CYCLE_MEMBERS_MAX), `… +${c.length - CYCLE_MEMBERS_MAX} more`] : [...c, c[0]!]).join(' → ');
          return `${page.length} cycle(s):\n` + page.map((c, i) => `  ${i + 1}. ${ring(c)}`).join('\n') + note;
        }
        case 'test_gap': {
          const rows = await store.untested({ pathPrefix: input.pathPrefix, excludePath: input.excludePath, limit: probe, offset: input.offset });
          if (rows.length === 0) return 'No untested exported symbols (given filters).';
          const { page, note } = pageOf(rows);
          return `${page.length} exported symbol(s) with no test reference:\n` + page.map((s) => `  - ${citeBare(s)}`).join('\n') + note;
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
      // Non-blocking collisions: legal, but the caller is the only one who can
      // judge whether reusing the name across modules is a semantic clash.
      const others = plan.collisionsElsewhere;
      const collisionNote = others.length
        ? `\nNote: ${others.length} other symbol(s) named "${input.newName}" already exist elsewhere (` +
          others.slice(0, 3).map((c) => `${c.file}:${c.startLine}`).join(', ') +
          (others.length > 3 ? `, +${others.length - 3} more` : '') +
          `); verify this is not a semantic clash.`
        : '';
      return (
        `Renamed ${r.sym.qualified || r.sym.name} → ${input.newName} across ${touched.length} file(s)` +
        `${fuzzyNote}:\n` +
        touched.map((f) => `  - ${f}`).join('\n') +
        `\nRevert via your VCS (e.g. \`git checkout -- <files>\`) if needed.` +
        collisionNote
      );
    },

    async grep_symbols(input) {
      const symbols = await store.grepSymbols(input.pattern, {
        isRegex: input.isRegex,
        kinds: input.kinds as SymbolRecord['kind'][] | undefined,
        pathPrefix: input.pathPrefix,
        limit: PROBE_MAX.grep + 1,
      });
      const mode = input.isRegex ? ' (regex)' : '';
      if (symbols.length === 0) return `No symbols match "${input.pattern}"${mode}.`;
      const { page, note } = paginate(symbols, input.limit, 0, { max: 100, atLeast: symbols.length > PROBE_MAX.grep });
      return `${symbols.length > PROBE_MAX.grep ? `${PROBE_MAX.grep}+` : symbols.length} symbol(s) match "${input.pattern}"${mode}:\n` +
        page.map((s) => `  - ${cite(s)}`).join('\n') + note;
    },

    async context_pack(input) {
      if (!input.name && !input.path) return 'context_pack needs `name` or `path`.';
      const section = <T>(title: string, rows: T[], render: (r: T) => string): string => {
        const { page, note } = paginate(rows, input.limit, 0, { max: 50 });
        return `\n${title}:\n` + page.map(render).join('\n') + note;
      };
      const moduleLines = async (file: string): Promise<{ key: string; lines: string[] }> => {
        const key = moduleKeyOf(file, {});
        const nb = await moduleNeighbours(store, key);
        const names = (edges: typeof nb.dependsOn, side: 'to' | 'from'): string => {
          const { page, note } = paginate(edges, input.limit, 0, { max: 50 });
          return page.map((e) => e[side]).join(', ') + note.replace('\n', ' ');
        };
        return {
          key,
          lines: [
            nb.dependsOn.length ? `  depends on: ${names(nb.dependsOn, 'to')}` : '  depends on nothing.',
            nb.dependedOnBy.length ? `  depended on by: ${names(nb.dependedOnBy, 'from')}` : '  depended on by nothing.',
          ],
        };
      };

      if (input.path && !input.name) {
        const p = await resolvePathArg(store, input.path);
        if ('error' in p) return p.message;
        const symbols = await store.outline(p.path);
        const mod = await moduleLines(p.path);
        const lines = [`${p.note}Context pack for ${p.path} (module ${mod.key}):`];
        lines.push(symbols.length ? section(`${symbols.length} symbol(s)`, symbols, (s) => `  - ${cite(s)}`).trimStart() : 'No indexed symbols.');
        lines.push(`\nModule ${mod.key}:`, ...mod.lines);
        return lines.join('\n');
      }

      const r = await resolveOne(store, input.name!, input.path);
      if ('message' in r) return r.message;
      const sym = r.sym;

      const [callerEdges, calleeEdges, hierarchyRes, mod] = await Promise.all([
        store.edgesTo([sym.id], CALL_KINDS),
        store.edgesFrom([sym.id], CALL_KINDS),
        hierarchy(store, sym.id, 2),
        moduleLines(sym.file),
      ]);
      // Distinct callers/callees, not call sites: one caller hitting the seed
      // 19 times is one row (`×19`), and the footer counts rows.
      const callerGroups = groupCallEdges(callerEdges, 'from');
      const calleeGroups = groupCallEdges(calleeEdges, 'to');
      const callerPage = callerGroups.slice(0, input.limit);
      const calleePage = calleeGroups.slice(0, input.limit);
      const [callerSyms, calleeSyms] = await Promise.all([
        store.getMany(callerPage.map((g) => g.id)),
        store.getMany(calleePage.map((g) => g.id)),
      ]);

      const lines = [`Context pack for ${cite(sym)}:`];
      const listed = (
        title: string,
        groups: CallGroup[],
        shown: CallGroup[],
        syms: Map<number, SymbolRecord>,
        row: (s: SymbolRecord, g: CallGroup) => string,
        empty: string
      ): string => {
        if (groups.length === 0) return `\n${empty}`;
        const note = groups.length > input.limit ? moreFooter(groups.length - input.limit, { limit: input.limit, max: 50 }) : '';
        const body = shown.flatMap((g) => (syms.has(g.id) ? [row(syms.get(g.id)!, g)] : [])).join('\n');
        return `\n${groups.length} ${title}:\n` + body + note;
      };
      lines.push(listed('caller(s)', callerGroups, callerPage, callerSyms, callerRow, 'No callers.'));
      lines.push(listed('callee(s)', calleeGroups, calleePage, calleeSyms, calleeRow, 'No callees.'));
      if (hierarchyRes && hierarchyRes.ancestors.length > 0) {
        lines.push(section('Extends/implements', hierarchyRes.ancestors, (a) => `  - ${citeBare(a.symbol)}`));
      }
      if (hierarchyRes && hierarchyRes.descendants.length > 0) {
        lines.push(section('Extended/implemented by', hierarchyRes.descendants, (d) => `  - ${citeBare(d.symbol)}`));
      }
      lines.push(`\nModule ${mod.key}:`, ...mod.lines);
      return lines.join('\n');
    },
  };

  // Every tool answers an empty index with the same one-liner (see
  // EMPTY_INDEX_MESSAGE) instead of a tool-specific "nothing found".
  const guarded = {} as Executors;
  for (const name of Object.keys(base) as CodeToolName[]) {
    const fn = base[name] as (input: unknown) => Promise<string>;
    (guarded as Record<CodeToolName, (input: unknown) => Promise<string>>)[name] = async (input) =>
      (await emptyIndexMessage(store)) ?? fn(input);
  }
  return guarded;
}
