/**
 * `gizem init` (plan.md 3.4 / R5): index → moduleMap → proposed layers +
 * starter rules.ron + findings. Turns the empty-config problem into a reviewed
 * starting point: everything emitted is a *proposal* — the human (V7) accepts
 * or edits, never trusts blindly.
 *
 * Layer inference: aggregate each Louvain cluster's dependency flow. A cluster
 * that is depended-ON far more than it depends-on sits low (foundational);
 * one that mostly depends-on others sits high (application). Rank = order by
 * net inbound ratio. Ties/ambiguity are reported, not hidden.
 *
 * Pure core (R10): CodeStore + moduleMap only.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import { moduleMap } from './moduleMap';
import type { ModuleMap } from './moduleMap';

export interface LayerProposal {
  /** Layer name → rank (1 = lowest/foundation), matching rules.ron `layers`. */
  layers: Record<string, number>;
  /** Module (directory) → layer name, matching rules.ron `module_layers`. */
  moduleLayers: Record<string, string>;
  /** The generated starter rules.ron source. */
  rulesRon: string;
  /** Human-readable findings (drift, cycles, ambiguity) to review before adopting. */
  findings: string[];
  map: ModuleMap;
}

/** Short, stable layer name for a cluster: the most common top segment of its modules. */
function layerName(modules: string[], taken: Set<string>): string {
  const counts = new Map<string, number>();
  for (const m of modules) {
    // Prefer the second segment when everything starts with src/ ('src/core' → 'core').
    const segs = m.split('/');
    const cand = segs[0] === 'src' && segs.length > 1 ? segs[1]! : segs[0]!;
    counts.set(cand, (counts.get(cand) ?? 0) + 1);
  }
  let best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'layer';
  let name = best;
  let i = 2;
  while (taken.has(name)) name = `${best}${i++}`;
  taken.add(name);
  return name;
}

export async function proposeInit(store: CodeStore): Promise<LayerProposal> {
  const map = await moduleMap(store);
  const findings: string[] = [];

  if (map.modules.length === 0) {
    return {
      layers: {},
      moduleLayers: {},
      rulesRon: starterRules({}, {}, findings),
      findings: ['No inter-module dependencies found — index first, or the workspace is a single module. Starter rules include NoCycles/MaxFanOut only.'],
      map,
    };
  }

  // Net dependency flow per cluster: inbound weight (others depend on it)
  // minus outbound (it depends on others), normalized by total involvement.
  const clusterOf = new Map<string, number>();
  map.clusters.forEach((c) => c.modules.forEach((m) => clusterOf.set(m, c.id)));
  const inW = new Map<number, number>();
  const outW = new Map<number, number>();
  for (const e of map.edges) {
    const cf = clusterOf.get(e.from)!;
    const ct = clusterOf.get(e.to)!;
    if (cf === ct) continue;
    outW.set(cf, (outW.get(cf) ?? 0) + e.weight);
    inW.set(ct, (inW.get(ct) ?? 0) + e.weight);
  }

  const scored = map.clusters.map((c) => {
    const inn = inW.get(c.id) ?? 0;
    const out = outW.get(c.id) ?? 0;
    const total = inn + out;
    // 1 = pure foundation (only depended on), 0 = pure application.
    const foundation = total === 0 ? 0.5 : inn / total;
    return { cluster: c, foundation, inn, out };
  });
  // Lowest rank = most foundational.
  scored.sort((a, b) => b.foundation - a.foundation || a.cluster.modules[0]!.localeCompare(b.cluster.modules[0]!));

  const taken = new Set<string>();
  const layers: Record<string, number> = {};
  const moduleLayers: Record<string, string> = {};
  scored.forEach((s, i) => {
    const name = layerName(s.cluster.modules, taken);
    layers[name] = i + 1;
    for (const m of s.cluster.modules) moduleLayers[m] = name;
    if (s.inn + s.out === 0) {
      findings.push(`Layer "${name}" (${s.cluster.modules.join(', ')}) has no cross-cluster dependencies — its rank ${i + 1} is arbitrary; review.`);
    } else if (s.foundation > 0.35 && s.foundation < 0.65) {
      findings.push(`Layer "${name}" is ambiguous (in ${s.inn} / out ${s.out}): it both serves and consumes other subsystems about equally. Its rank ${i + 1} is a guess; review.`);
    }
  });

  // Existing violations of the proposal = current drift the team must decide on.
  const pct = (map.driftRatio * 100).toFixed(0);
  if (map.drift.length > 0) {
    findings.push(`${pct}% of dependency weight crosses subsystem boundaries. Heaviest: ${map.drift.slice(0, 3).map((d) => `${d.from} → ${d.to} (×${d.weight})`).join('; ')}. Baseline these (gizem baseline update) or refactor.`);
  }

  const cycles = await store.findCycles({ edge: 'DEPENDS_ON', scope: 'module', excludeTest: true, limit: 5 });
  for (const c of cycles) {
    findings.push(`Module cycle: ${c.join(' → ')} → ${c[0]} — the NoCycles rule will flag this on day 1; baseline or break it.`);
  }

  return { layers, moduleLayers, rulesRon: starterRules(layers, moduleLayers, findings), findings, map };
}

function starterRules(layers: Record<string, number>, moduleLayers: Record<string, string>, findings: string[]): string {
  const layerLines = Object.entries(layers)
    .sort((a, b) => a[1] - b[1])
    .map(([n, r]) => `"${n}": ${r}`)
    .join(', ');
  const modLines = Object.entries(moduleLayers)
    .sort()
    .map(([m, l]) => `"${m}": "${l}"`)
    .join(', ');
  const header = [
    '// Starter ruleset proposed by `gizem init` — REVIEW BEFORE TRUSTING.',
    '// Layer ranks were inferred from observed dependency direction; the',
    '// findings below list every place the inference was a guess.',
    ...findings.map((f) => `// finding: ${f}`),
  ].join('\n');
  const layering =
    Object.keys(layers).length >= 2
      ? `    (id: "layering", tier: 1, kind: Layering(direction: DownOnly, max_skip: 1),
     explain: "Higher layers may depend on lower ones, never the reverse. Ranks: ${Object.entries(
       layers
     )
       .sort((a, b) => a[1] - b[1])
       .map(([n]) => n)
       .join(' <- ')}."),\n`
      : '';
  return `${header}
( ${layerLines ? `layers: { ${layerLines} },\n  module_layers: { ${modLines} },\n` : ''}  rules: [
${layering}    (id: "no-module-cycles", tier: 1, kind: NoCycles(edge: "DEPENDS_ON", scope: Module),
     explain: "Module dependency graph must stay a DAG."),
    (id: "fanout-40", tier: 2, severity: warning, kind: MaxFanOut(max: 40),
     explain: "Functions calling 40+ targets are doing too much."),
  ] )
`;
}
