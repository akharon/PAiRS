/**
 * Rule evaluation (spec §3.2–§3.4): RuleSet + CodeStore snapshot → Violations.
 *
 * Pure core (R10): only the CodeStore contract, no vscode/Kuzu specifics.
 * "Module" = a file's directory, same convention as core/analyze/moduleMap.
 *
 * Confidence (R1): a violation derived through any fuzzy edge is `possible`
 * and never fails CI. Cross-module edges pulled by Cypher carry their
 * `confidence` column when the query exposes it; rules that walk edges
 * themselves track the weakest confidence seen.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { CheckResult, LayeringRule, MaxFanOutRule, Rule, RuleSet, Violation, ViolationNode, ForbiddenDepRule, VisibilityBoundaryRule, NoCyclesRule, CypherRule } from './types';

/** Directory of a workspace-relative file path ('.' for a root file). */
function moduleOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? '.' : file.slice(0, i);
}

/**
 * Glob → RegExp: `*` = one path segment, `**` = any depth. Anchored.
 * A trailing `/**` also matches the bare prefix (`src/ui/**` matches `src/ui`),
 * matching how humans read "src/ui and everything under it".
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (i === glob.length - 2 && glob[i - 1] === '/') {
          // trailing `/**`: strip the `/` we already emitted, match self or deeper
          out = out.slice(0, -1) + '(?:/.*)?';
          i += 1;
        } else if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; } // `**/` may match zero segments
        else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(out + '$');
}

interface CrossModuleEdge {
  fromModule: string;
  toModule: string;
  fromNode: ViolationNode;
  toNode: ViolationNode;
  line: number;
  fuzzy: boolean;
}

/**
 * All cross-module DEPENDS_ON/CALLS edges with locations + confidence — the
 * shared input for Layering and ForbiddenDep. One query per check() call.
 */
async function crossModuleEdges(store: CodeStore): Promise<CrossModuleEdge[]> {
  const rows = await store.query(
    `MATCH (a:Symbol)-[e:DEPENDS_ON|CALLS]->(b:Symbol) WHERE a.file <> b.file
     RETURN a.qualified AS aq, a.name AS an, a.file AS af, e.line AS line, e.confidence AS conf,
            b.qualified AS bq, b.name AS bn, b.file AS bf, b.startLine AS bl`
  );
  const out: CrossModuleEdge[] = [];
  for (const r of rows) {
    const af = String(r.af);
    const bf = String(r.bf);
    const fromModule = moduleOf(af);
    const toModule = moduleOf(bf);
    if (fromModule === toModule) continue;
    out.push({
      fromModule,
      toModule,
      fromNode: { qualified: String(r.aq || r.an), file: af, line: Number(r.line) },
      toNode: { qualified: String(r.bq || r.bn), file: bf, line: Number(r.bl) },
      line: Number(r.line),
      fuzzy: String(r.conf) === 'fuzzy',
    });
  }
  return out;
}

/** Longest-prefix layer lookup: module path → layer name, or null if unmapped. */
export function layerOfModule(module: string, ruleset: RuleSet): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [prefix, layer] of Object.entries(ruleset.moduleLayers)) {
    if ((module === prefix || module.startsWith(prefix + '/')) && prefix.length > bestLen) {
      best = layer;
      bestLen = prefix.length;
    }
  }
  return best;
}

function base(rule: Rule, nodes: ViolationNode[], fuzzy: boolean, suggestion?: string): Violation {
  return {
    rule: rule.id,
    tier: rule.tier,
    severity: rule.severity,
    nodes,
    explanation: rule.explain,
    ...(suggestion ? { suggestion } : {}),
    confidence: fuzzy ? 'possible' : 'confirmed',
  };
}

function evalLayering(rule: Rule, kind: LayeringRule, ruleset: RuleSet, edges: CrossModuleEdge[]): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const fromLayer = layerOfModule(e.fromModule, ruleset);
    const toLayer = layerOfModule(e.toModule, ruleset);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
    const fromRank = ruleset.layers[fromLayer]!;
    const toRank = ruleset.layers[toLayer]!;
    const upward = toRank > fromRank; // deeper layer depending on a shallower one
    const skipped = fromRank - toRank - 1; // layers jumped over going down
    const skipViolation = kind.maxSkip !== null && !upward && skipped > kind.maxSkip;
    if (!upward && !skipViolation) continue;
    // One violation per (from-symbol, to-symbol) pair.
    const key = `${e.fromNode.qualified}|${e.toNode.qualified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const why = upward
      ? `"${e.fromModule}" (${fromLayer}, rank ${fromRank}) depends upward on "${e.toModule}" (${toLayer}, rank ${toRank})`
      : `"${e.fromModule}" (${fromLayer}) skips ${skipped} layer(s) down to "${e.toModule}" (${toLayer})`;
    out.push(base(rule, [e.fromNode, e.toNode], e.fuzzy, `${why}. Route through an intermediate layer.`));
  }
  return out;
}

function evalForbiddenDep(rule: Rule, kind: ForbiddenDepRule, edges: CrossModuleEdge[]): Violation[] {
  const from = globToRegExp(kind.from);
  const to = globToRegExp(kind.to);
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!from.test(e.fromModule) || !to.test(e.toModule)) continue;
    const key = `${e.fromNode.qualified}|${e.toNode.qualified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(base(rule, [e.fromNode, e.toNode], e.fuzzy, `Dependency ${e.fromModule} → ${e.toModule} matches forbidden pattern ${kind.from} → ${kind.to}.`));
  }
  return out;
}

async function evalMaxFanOut(rule: Rule, kind: MaxFanOutRule, store: CodeStore): Promise<Violation[]> {
  // Out-degree of CALLS per function/method, with fuzzy counted separately so
  // a ceiling crossed only via fuzzy edges is a `possible` finding.
  const rows = await store.query(
    `MATCH (a:Symbol)-[e:CALLS]->(:Symbol)
     WHERE a.kind = 'function' OR a.kind = 'method'
     RETURN a.qualified AS q, a.name AS n, a.file AS f, a.startLine AS l,
            count(e) AS total, sum(CASE WHEN e.confidence = 'fuzzy' THEN 1 ELSE 0 END) AS fuzzy`
  );
  const out: Violation[] = [];
  for (const r of rows) {
    const file = String(r.f);
    if (kind.pathPrefix && !file.startsWith(kind.pathPrefix)) continue;
    const total = Number(r.total);
    const fuzzyN = Number(r.fuzzy);
    if (total <= kind.max) continue;
    const confirmedOnly = total - fuzzyN;
    const node: ViolationNode = { qualified: String(r.q || r.n), file, line: Number(r.l) };
    out.push(base(rule, [node], confirmedOnly <= kind.max, `Fan-out ${total} exceeds max ${kind.max}. Extract helpers or split responsibilities.`));
  }
  return out;
}

async function evalVisibilityBoundary(rule: Rule, kind: VisibilityBoundaryRule, store: CodeStore): Promise<Violation[]> {
  // Any reference edge from outside `module` into a non-exported symbol of it.
  const rows = await store.query(
    `MATCH (a:Symbol)-[e:CALLS|READS|WRITES|DEPENDS_ON|IMPLEMENTS|EXTENDS|REFERENCES]->(b:Symbol)
     WHERE a.file <> b.file AND b.exported = false AND b.kind <> 'module'
     RETURN a.qualified AS aq, a.name AS an, a.file AS af, e.line AS line, e.confidence AS conf,
            b.qualified AS bq, b.name AS bn, b.file AS bf, b.startLine AS bl`
  );
  const bound = kind.module.replace(/\/+$/, '');
  const inModule = (file: string): boolean => moduleOf(file) === bound || moduleOf(file).startsWith(bound + '/');
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const af = String(r.af);
    const bf = String(r.bf);
    if (!inModule(bf) || inModule(af)) continue;
    const key = `${String(r.aq || r.an)}|${String(r.bq || r.bn)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      base(
        rule,
        [
          { qualified: String(r.aq || r.an), file: af, line: Number(r.line) },
          { qualified: String(r.bq || r.bn), file: bf, line: Number(r.bl) },
        ],
        String(r.conf) === 'fuzzy',
        `"${String(r.bq || r.bn)}" is private to ${bound}; expose a pub API or move the caller inside.`
      )
    );
  }
  return out;
}

async function evalNoCycles(rule: Rule, kind: NoCyclesRule, store: CodeStore): Promise<Violation[]> {
  // Confidence via a second, confirmed-only pass: a cycle is `confirmed` only
  // when it survives with every fuzzy edge removed. DEPENDS_ON is not purely
  // `use`-derived (macro invocations land there fuzzy), so a cycle stitched
  // through fuzzy edges — ripgrep's `write!` sites fanning onto every
  // workspace `write` method — must report `possible`, never fail CI (R1).
  const cycles = await store.findCycles({ edge: kind.edge, scope: kind.scope });
  const confirmedCycles = await store.findCycles({ edge: kind.edge, scope: kind.scope, confirmedOnly: true });
  const confirmedMembers = new Set(confirmedCycles.flat());
  return cycles.map((members) =>
    base(
      rule,
      members.map((m) => ({ qualified: m, file: m, line: 1 })),
      !members.every((m) => confirmedMembers.has(m)),
      `Break the cycle: ${members.join(' → ')} → ${members[0]}.`
    )
  );
}

async function evalCypher(rule: Rule, kind: CypherRule, store: CodeStore): Promise<Violation[]> {
  const rows = await store.query(kind.query);
  const out: Violation[] = [];
  for (const r of rows) {
    // Accept either `s.*` projections or explicit aliases qualified/file/line.
    const get = (suffix: string): unknown => {
      if (suffix in r) return r[suffix];
      const k = Object.keys(r).find((key) => key === suffix || key.endsWith('.' + suffix));
      return k === undefined ? undefined : r[k];
    };
    const qualified = get('qualified') ?? get('name');
    const file = get('file');
    if (qualified === undefined || file === undefined) continue; // row shape not citable — skip
    const line = get('line') ?? get('startLine') ?? 1;
    out.push(base(rule, [{ qualified: String(qualified), file: String(file), line: Number(line) }], false));
  }
  return out;
}

/** Evaluate every rule in the set against the store snapshot. */
export async function checkRules(store: CodeStore, ruleset: RuleSet): Promise<CheckResult> {
  const needsEdges = ruleset.rules.some((r) => r.kind.kind === 'Layering' || r.kind.kind === 'ForbiddenDep');
  const edges = needsEdges ? await crossModuleEdges(store) : [];

  const violations: Violation[] = [];
  for (const rule of ruleset.rules) {
    const k = rule.kind;
    switch (k.kind) {
      case 'Layering':
        violations.push(...evalLayering(rule, k, ruleset, edges));
        break;
      case 'ForbiddenDep':
        violations.push(...evalForbiddenDep(rule, k, edges));
        break;
      case 'MaxFanOut':
        violations.push(...(await evalMaxFanOut(rule, k, store)));
        break;
      case 'VisibilityBoundary':
        violations.push(...(await evalVisibilityBoundary(rule, k, store)));
        break;
      case 'NoCycles':
        violations.push(...(await evalNoCycles(rule, k, store)));
        break;
      case 'Cypher':
        violations.push(...(await evalCypher(rule, k, store)));
        break;
    }
  }
  return { violations, checkedRules: ruleset.rules.map((r) => r.id) };
}
