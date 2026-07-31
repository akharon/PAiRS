/**
 * Rule engine domain types (subsystem_mcp_rules_spec.md §3). Net-new to PAiRS —
 * the reference indexer has retrieval/analysis but no architectural rules.
 *
 * A ruleset lives in `.pairs/rules.ron` (committed). Every rule carries a
 * mandatory `explain`, returned verbatim in violations: the mechanism that
 * makes a finding self-correcting for an agent rather than just red CI.
 */

import type { EdgeKind, SymbolRecord } from '../indexer/types';

/** Layer name → rank. Lower ranks are "deeper" (core=1 … ui=3). */
export type LayerMap = Record<string, number>;

export type RuleTier = 1 | 2;
export type Severity = 'error' | 'warning';

// -- Rule kinds (spec §3.2) ---------------------------------------------------

export interface LayeringRule {
  kind: 'Layering';
  /** DownOnly: a module may only depend on modules of equal or lower rank. */
  direction: 'DownOnly';
  /** Max layers a dependency may skip downward. 0 = adjacent only; null = any. */
  maxSkip: number | null;
}

export interface NoCyclesRule {
  kind: 'NoCycles';
  edge: EdgeKind;
  scope: 'module' | 'type';
}

export interface ForbiddenDepRule {
  kind: 'ForbiddenDep';
  /** Glob over module paths (workspace-relative dirs), e.g. `src/core/**`. */
  from: string;
  to: string;
}

export interface MaxFanOutRule {
  kind: 'MaxFanOut';
  /** Ceiling on CALLS out-degree per function/method. */
  max: number;
  pathPrefix?: string;
}

export interface VisibilityBoundaryRule {
  kind: 'VisibilityBoundary';
  /** Module (directory) whose non-`pub` items must not be referenced from outside. */
  module: string;
}

export interface CypherRule {
  kind: 'Cypher';
  /** Read-only Cypher; must RETURN a symbol node aliased `s` (or columns s.*). */
  query: string;
}

export type RuleKind = LayeringRule | NoCyclesRule | ForbiddenDepRule | MaxFanOutRule | VisibilityBoundaryRule | CypherRule;

export interface Rule {
  id: string;
  tier: RuleTier;
  severity: Severity;
  kind: RuleKind;
  /** Mandatory. Returned verbatim to the agent with every violation. */
  explain: string;
}

export interface RuleSet {
  /** Layer name → rank (Layering rules need this; may be empty otherwise). */
  layers: LayerMap;
  /**
   * Module path prefix → layer name. A module's layer is the longest matching
   * prefix; modules with no match are outside layering (never violate).
   */
  moduleLayers: Record<string, string>;
  rules: Rule[];
}

// -- Violations (spec §3.3) ---------------------------------------------------

export interface ViolationNode {
  qualified: string;
  file: string;
  line: number;
}

export interface Violation {
  rule: string;
  tier: RuleTier;
  severity: Severity;
  nodes: ViolationNode[];
  /** rule.explain verbatim. */
  explanation: string;
  suggestion?: string;
  /** "possible" iff derived via fuzzy/unresolved edges — never fails CI (R1). */
  confidence: 'confirmed' | 'possible';
}

export interface CheckResult {
  violations: Violation[];
  checkedRules: string[];
}

/**
 * Baseline identity (O4): stable under file moves, invalidated by renames.
 * key = rule id + sorted module-qualified names of the violating nodes.
 */
export function violationKey(v: Violation): string {
  return `${v.rule}::${v.nodes.map((n) => n.qualified).sort().join('|')}`;
}

/** Convenience for rule evaluators building nodes from symbols. */
export function nodeOf(s: SymbolRecord, line?: number): ViolationNode {
  return { qualified: s.qualified || s.name, file: s.file, line: line ?? s.startLine };
}
