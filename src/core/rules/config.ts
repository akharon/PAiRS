/**
 * `.gizem/rules.ron` → validated RuleSet (spec §3.1). Validation errors are
 * ConfigError with the rule id in the message where one exists — a bad config
 * must be fixable from the error alone, since agents hit these too.
 *
 * `explain` is mandatory on every rule: it is the self-correction payload.
 */

import { REFERENCE_EDGE_KINDS, STRUCTURAL_EDGE_KINDS } from '../indexer/types';
import type { EdgeKind } from '../indexer/types';
import { stripCypherLiterals } from '../../store/graph/codeStore';
import { isVariant, parseRon } from './ron';
import type { RonValue, RonVariant } from './ron';
import type { Rule, RuleKind, RuleSet, RuleTier, Severity } from './types';

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(msg);
}

function asObject(v: RonValue, what: string): Record<string, RonValue> {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || isVariant(v)) fail(`${what} must be a struct/map`);
  return v;
}

function asString(v: RonValue | undefined, what: string): string {
  if (typeof v !== 'string') fail(`${what} must be a string`);
  return v;
}

function asNumber(v: RonValue | undefined, what: string): number {
  if (typeof v !== 'number') fail(`${what} must be a number`);
  return v;
}

const EDGE_KINDS: readonly string[] = [...STRUCTURAL_EDGE_KINDS, ...REFERENCE_EDGE_KINDS];

function parseKind(v: RonValue, ruleId: string): RuleKind {
  if (!isVariant(v)) fail(`rule "${ruleId}": kind must be a variant like Layering(...) or NoCycles(...)`);
  const ctx = `rule "${ruleId}" kind ${v.variant}`;
  switch (v.variant) {
    case 'Layering': {
      const dir = v.named['direction'];
      if (dir !== undefined && !(isVariant(dir) && dir.variant === 'DownOnly')) fail(`${ctx}: direction must be DownOnly`);
      const ms = v.named['max_skip'];
      const maxSkip = ms === undefined || ms === null ? null : asNumber(ms, `${ctx}: max_skip`);
      return { kind: 'Layering', direction: 'DownOnly', maxSkip };
    }
    case 'NoCycles': {
      const edge = asString(v.named['edge'] ?? 'DEPENDS_ON', `${ctx}: edge`);
      if (!EDGE_KINDS.includes(edge)) fail(`${ctx}: unknown edge kind "${edge}"`);
      const scopeV = v.named['scope'];
      let scope: 'module' | 'type' = 'module';
      if (scopeV !== undefined) {
        const s = isVariant(scopeV) ? scopeV.variant : scopeV;
        if (s !== 'Module' && s !== 'Type' && s !== 'module' && s !== 'type') fail(`${ctx}: scope must be Module or Type`);
        scope = String(s).toLowerCase() as 'module' | 'type';
      }
      return { kind: 'NoCycles', edge: edge as EdgeKind, scope };
    }
    case 'ForbiddenDep': {
      return {
        kind: 'ForbiddenDep',
        from: asString(v.named['from'], `${ctx}: from`),
        to: asString(v.named['to'], `${ctx}: to`),
      };
    }
    case 'MaxFanOut': {
      const max = asNumber(v.named['max'], `${ctx}: max`);
      if (max < 1) fail(`${ctx}: max must be >= 1`);
      const pp = v.named['path_prefix'];
      return { kind: 'MaxFanOut', max, ...(pp !== undefined && pp !== null ? { pathPrefix: asString(pp, `${ctx}: path_prefix`) } : {}) };
    }
    case 'VisibilityBoundary': {
      return { kind: 'VisibilityBoundary', module: asString(v.named['module'], `${ctx}: module`) };
    }
    case 'Cypher': {
      const q = v.args[0] ?? v.named['query'];
      const query = asString(q, `${ctx}: query`);
      assertReadOnlyCypher(query, ruleId);
      return { kind: 'Cypher', query };
    }
    default:
      fail(`rule "${ruleId}": unknown rule kind "${(v as RonVariant).variant}"`);
  }
}

/** Reject mutating Cypher at parse time (spec §3.2: read-snapshot only). */
export function assertReadOnlyCypher(query: string, ruleId: string): void {
  const banned = /\b(CREATE|MERGE|DELETE|DETACH|SET|DROP|ALTER|COPY|LOAD|CALL|INSTALL|ATTACH|EXPORT|IMPORT)\b/i;
  // Scan with string literals/comments blanked: a quoted word like
  // "… WHERE s.doc CONTAINS 'create'" is data, not a mutation.
  const m = banned.exec(stripCypherLiterals(query));
  if (m) fail(`rule "${ruleId}": Cypher rules are read-only — "${m[0].toUpperCase()}" is not allowed`);
}

export function parseRuleSet(source: string): RuleSet {
  let doc: RonValue;
  try {
    doc = parseRon(source);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const root = asObject(doc, 'rules.ron root');

  const layers: Record<string, number> = {};
  if (root['layers'] !== undefined) {
    const raw = asObject(root['layers'], 'layers');
    for (const [name, rank] of Object.entries(raw)) layers[name] = asNumber(rank, `layers["${name}"]`);
  }

  const moduleLayers: Record<string, string> = {};
  if (root['module_layers'] !== undefined) {
    const raw = asObject(root['module_layers'], 'module_layers');
    for (const [mod, layer] of Object.entries(raw)) {
      const l = asString(layer, `module_layers["${mod}"]`);
      if (!(l in layers)) fail(`module_layers["${mod}"]: unknown layer "${l}"`);
      moduleLayers[mod] = l;
    }
  }

  const rulesRaw = root['rules'];
  if (!Array.isArray(rulesRaw)) fail('rules must be a list');
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const r of rulesRaw) {
    const o = isVariant(r) ? fail('each rule must be a struct (id: …, kind: …, explain: …)') : asObject(r, 'rule');
    const id = asString(o['id'], 'rule id');
    if (seen.has(id)) fail(`duplicate rule id "${id}"`);
    seen.add(id);
    const tierN = o['tier'] === undefined ? 1 : asNumber(o['tier'], `rule "${id}": tier`);
    if (tierN !== 1 && tierN !== 2) fail(`rule "${id}": tier must be 1 or 2`);
    const sevV = o['severity'];
    let severity: Severity = 'error';
    if (sevV !== undefined) {
      const s = isVariant(sevV) ? sevV.variant.toLowerCase() : sevV;
      if (s !== 'error' && s !== 'warning') fail(`rule "${id}": severity must be error or warning`);
      severity = s;
    }
    if (o['explain'] === undefined) fail(`rule "${id}": missing mandatory "explain"`);
    const explain = asString(o['explain'], `rule "${id}": explain`);
    if (explain.trim() === '') fail(`rule "${id}": explain must not be empty`);
    const kind = parseKind(o['kind'] ?? fail(`rule "${id}": missing kind`), id);
    if (kind.kind === 'Layering' && Object.keys(layers).length === 0) fail(`rule "${id}": Layering requires a non-empty layers map`);
    rules.push({ id, tier: tierN as RuleTier, severity, kind, explain });
  }

  return { layers, moduleLayers, rules };
}
