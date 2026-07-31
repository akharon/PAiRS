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

import * as fs from 'node:fs';
import type { CodeStore } from '../../store/graph/codeStore';
import type { AmbiguousSymbol, EdgeKind, SymbolRecord } from '../indexer/types';
import { impact } from '../analyze/impact';
import { moduleMap } from '../analyze/moduleMap';
import { parseRuleSet } from '../rules/config';
import { checkRules } from '../rules/evaluate';
import { renderViolation, describeRuleKind } from '../rules/render';
import type { RuleSet } from '../rules/types';
import { planRename, applyPlan } from './rename';
import type { CodeToolInput, CodeToolName } from './tools';

export interface ExecutorDeps {
  store: CodeStore;
  /** Path to `.pairs/rules.ron`. Re-read on every rule-tool call so edits apply live. */
  rulesPath?: string;
  /** Workspace root. Required for rename_symbol/rename_revert (they write source files). */
  root?: string;
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

  /** rules.ron → RuleSet, or a user-facing message when missing/invalid. */
  function loadRules(): RuleSet | { message: string } {
    if (!deps.rulesPath) return { message: 'No rules configured (server started without a rules path).' };
    let src: string;
    try {
      src = fs.readFileSync(deps.rulesPath, 'utf8');
    } catch {
      return { message: `No ruleset at ${deps.rulesPath}. Create .pairs/rules.ron to enable architectural rules.` };
    }
    try {
      return parseRuleSet(src);
    } catch (e) {
      return { message: `Invalid ${deps.rulesPath}: ${(e as Error).message}` };
    }
  }

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
      // Paginate the edge list first, then fetch only that page's symbols —
      // fetching every counterpart before slicing made large fan-ins cost one
      // store round-trip per edge for rows that were then discarded.
      const { page: edgePage, note } = paginate(filtered, input.limit);
      const syms = await Promise.all(edgePage.map((e) => store.get(input.direction === 'callers' ? e.fromId : e.toId)));
      const page = syms.map((s, i) => ({ s, e: edgePage[i]! })).filter((x) => x.s);
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

    async check_rules(input) {
      const rs = loadRules();
      if ('message' in rs) return rs.message;
      let ruleset = rs;
      if (input.tier !== undefined || input.rule !== undefined) {
        const rules = rs.rules.filter((r) => (input.tier === undefined || r.tier === input.tier) && (input.rule === undefined || r.id === input.rule));
        if (rules.length === 0) return input.rule ? `No rule "${input.rule}" in the ruleset.` : `No tier-${input.tier} rules.`;
        ruleset = { ...rs, rules };
      }
      const stats = await store.stats();
      if (stats.files === 0) return 'Index is empty — run `pairs index` first; rules cannot be checked over nothing.';
      const { violations, checkedRules } = await checkRules(store, ruleset);
      if (violations.length === 0) return `OK — ${checkedRules.length} rule(s) checked, no violations.`;
      const confirmed = violations.filter((v) => v.confidence === 'confirmed').length;
      const { page, note } = paginate(violations, input.limit);
      return (
        `${violations.length} violation(s) (${confirmed} confirmed, ${violations.length - confirmed} possible) from ${checkedRules.length} rule(s):\n\n` +
        page.map(renderViolation).join('\n\n') +
        note
      );
    },

    async list_rules() {
      const rs = loadRules();
      if ('message' in rs) return rs.message;
      const layers = Object.entries(rs.layers)
        .sort((a, b) => a[1] - b[1])
        .map(([n, r]) => `${n}=${r}`)
        .join(', ');
      const body = rs.rules.map((r) => `  - ${r.id} [tier ${r.tier}, ${r.severity}] ${describeRuleKind(r.kind)}`).join('\n');
      return `${rs.rules.length} rule(s)${layers ? `; layers: ${layers}` : ''}:\n${body}`;
    },

    async explain_rule(input) {
      const rs = loadRules();
      if ('message' in rs) return rs.message;
      const r = rs.rules.find((x) => x.id === input.rule);
      if (!r) return `No rule "${input.rule}". Known: ${rs.rules.map((x) => x.id).join(', ')}.`;
      return `${r.id} [tier ${r.tier}, ${r.severity}]\nkind: ${describeRuleKind(r.kind)}\nexplain: ${r.explain}`;
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

    async rename_symbol(input) {
      if (!deps.root) return 'Renaming is unavailable (server started without a workspace root).';
      const r = await resolveOne(store, input.name, input.path);
      if ('message' in r) return r.message;
      const plan = await planRename(store, deps.root, r.sym, input.newName);
      if ('message' in plan) return plan.message;
      const touched = applyPlan(plan);
      return (
        `Renamed ${r.sym.qualified || r.sym.name} → ${input.newName} across ${touched.length} file(s):\n` +
        touched.map((f) => `  - ${f}`).join('\n') +
        `\nRevert via your VCS (e.g. \`git checkout -- <files>\`) if needed.`
      );
    },
  };
}
