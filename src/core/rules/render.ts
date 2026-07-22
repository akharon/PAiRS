/**
 * Violation rendering shared by MCP tools, the CLI, and VS Code diagnostics.
 * Text convention matches executors.ts: every node cites `qualified  file:line`.
 */

import type { Rule, RuleKind, Violation } from './types';

export function renderViolation(v: Violation): string {
  const head = `[${v.severity}${v.confidence === 'possible' ? '/possible' : ''}] ${v.rule} (tier ${v.tier})`;
  const nodes = v.nodes.map((n) => `    at ${n.qualified}  ${n.file}:${n.line}`).join('\n');
  const sugg = v.suggestion ? `\n    fix: ${v.suggestion}` : '';
  return `${head}\n    why: ${v.explanation}\n${nodes}${sugg}`;
}

export function describeRuleKind(k: RuleKind): string {
  switch (k.kind) {
    case 'Layering':
      return `Layering(direction: DownOnly, max_skip: ${k.maxSkip ?? 'any'})`;
    case 'NoCycles':
      return `NoCycles(edge: ${k.edge}, scope: ${k.scope})`;
    case 'ForbiddenDep':
      return `ForbiddenDep(from: ${k.from}, to: ${k.to})`;
    case 'MaxFanOut':
      return `MaxFanOut(max: ${k.max}${k.pathPrefix ? `, path_prefix: ${k.pathPrefix}` : ''})`;
    case 'VisibilityBoundary':
      return `VisibilityBoundary(module: ${k.module})`;
    case 'Cypher':
      return `Cypher(${k.query.length > 60 ? k.query.slice(0, 57) + '…' : k.query})`;
  }
}

export function summarizeRule(r: Rule): string {
  return `${r.id} [tier ${r.tier}, ${r.severity}] ${describeRuleKind(r.kind)}`;
}
