/**
 * Tool executors: validated input → rendered text. One per codeToolSchemas
 * entry. Pure over the CodeStore contract + core/analyze — no MCP or vscode
 * types here, so the VS Code Language Model Tools surface (Phase 1.6) reuses
 * them verbatim.
 *
 * Rendering convention: every symbol cites `qualified  file:startLine` so an
 * agent can jump straight to the definition (plan.md 1.2). Results are compact
 * text, not JSON — agents read prose more reliably and it costs fewer tokens.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { AmbiguousSymbol, EdgeKind, SymbolRecord } from '../../core/indexer/types';
import { impact } from '../../core/analyze/impact';
import { moduleMap } from '../../core/analyze/moduleMap';
import type { CodeToolInput, CodeToolName } from './tools';

export interface ExecutorDeps {
  store: CodeStore;
}

export type Executors = {
  [K in CodeToolName]: (input: CodeToolInput<K>) => Promise<string>;
};

function cite(s: SymbolRecord): string {
  const sig = s.signature ? ` ${s.signature}` : '';
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
        cite(s),
        s.doc ? `\ndoc: ${s.doc}` : '',
      ].filter(Boolean);
      if (input.includeMembers) {
        const members = await store.membersOf(s.id);
        if (members.length > 0) {
          lines.push(`\nmembers (${members.length}):`);
          for (const m of members) lines.push(`  - ${cite(m)}`);
        }
      }
      return lines.join('\n');
    },

    async outline(input) {
      const syms = await store.outline(input.path);
      if (syms.length === 0) return `No indexed symbols in ${input.path} (not indexed, or empty).`;
      return `${input.path} — ${syms.length} symbols:\n` + syms.map((s) => `  ${s.startLine}: ${s.qualified || s.name} [${s.kind}]${s.signature ? ` ${s.signature}` : ''}`).join('\n');
    },

    async impact(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const res = await impact(store, r.sym.id, input.depth);
      if (!res) return `No symbol id for "${input.name}".`;
      if (res.dependants.length === 0) return `Nothing depends on ${cite(res.seed)} within ${input.depth} hop(s).`;
      const { page, note } = paginate(res.dependants, input.limit);
      const trunc = res.truncated ? ` (walk truncated at depth ${input.depth})` : '';
      const body = page
        .map((d) => `  - d${d.depth} ${cite(d.symbol)}${d.confidence === 'fuzzy' ? '  [fuzzy]' : ''}`)
        .join('\n');
      return `${res.dependants.length} dependant(s) of ${res.seed.qualified || res.seed.name}${trunc}:\n${body}${note}`;
    },

    async who_calls(input) {
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const edges =
        input.direction === 'callers'
          ? await store.edgesTo([r.sym.id], CALL_KINDS)
          : await store.edgesFrom([r.sym.id], CALL_KINDS);
      const filtered = input.includeFuzzy ? edges : edges.filter((e) => e.confidence !== 'fuzzy');
      if (filtered.length === 0) return `No ${input.direction} for ${cite(r.sym)}.`;
      const otherIds = filtered.map((e) => (input.direction === 'callers' ? e.fromId : e.toId));
      const syms = await Promise.all(otherIds.map((id) => store.get(id)));
      const { page, note } = paginate(
        syms.map((s, i) => ({ s, e: filtered[i]! })).filter((x) => x.s),
        input.limit
      );
      const body = page.map((x) => `  - ${cite(x.s!)}${x.e.confidence === 'fuzzy' ? '  [fuzzy]' : ''}`).join('\n');
      return `${filtered.length} ${input.direction} of ${r.sym.qualified || r.sym.name}:\n${body}${note}`;
    },

    async file_deps(input) {
      const dir = input.direction === 'importers' ? 'importers' : 'imports';
      const deps = await store.fileEdges(input.path, dir, { transitive: input.transitive, limit: input.limit });
      if (deps.length === 0) return `No ${dir} for ${input.path}.`;
      const body = deps.map((d) => `  - d${d.depth} ${d.path}:${d.line}`).join('\n');
      return `${deps.length} ${dir} of ${input.path}:\n${body}`;
    },

    async module_map(input) {
      const map = await moduleMap(store);
      if (map.modules.length === 0) return 'No inter-module dependencies indexed (single module, or no DEPENDS_ON edges).';
      const clusters = map.clusters
        .map((c, i) => `  subsystem ${i + 1} (${c.modules.length}): ${c.modules.join(', ')}`)
        .join('\n');
      const drift = map.drift.slice(0, input.limit).map((e) => `  - ${e.from} → ${e.to}  (×${e.weight})`).join('\n');
      const pct = (map.driftRatio * 100).toFixed(0);
      return (
        `${map.modules.length} modules in ${map.clusters.length} subsystem(s); ` +
        `drift ${pct}% of dependency weight crosses subsystem boundaries.\n\n` +
        `Subsystems:\n${clusters}` +
        (map.drift.length ? `\n\nCross-subsystem edges (drift, heaviest first):\n${drift}` : '\n\nNo cross-subsystem drift.')
      );
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
          return `${c.length} dead-code candidate(s) — verify each (syntactic only):\n` +
            c.map((x) => `  - ${cite(x.symbol)}${x.note ? `  [${x.note}]` : ''}`).join('\n');
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
  };
}
