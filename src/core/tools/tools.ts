/**
 * Tool contracts for PAiRS's code-graph retrieval surface (plan.md 1.1–1.5).
 *
 * One zod schema per tool; the VS Code Language Model Tools (Copilot) derive
 * their JSON schema from here via scripts/sync-lm-tools.mjs, so the contract
 * can't drift from what's actually registered.
 *
 * Trimmed from vendor/reference-indexer/src/mcp/tools.ts: no memory tools, no
 * embedding-dependent tools (`find_duplicates`, semantic `code_search`). Every
 * tool here maps to a method that already exists on CodeStore or to
 * core/analyze/impact.
 */

import { z } from 'zod';
import { CODE_LANGS, SYMBOL_KINDS } from '../indexer/types';

const symbolKind = z.enum(SYMBOL_KINDS as [string, ...string[]]);
const codeLang = z.enum(CODE_LANGS as [string, ...string[]]);
const offset = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Skip this many results — re-call with the offset from a truncated response to page.');
const pathHint = z
  .string()
  .optional()
  .describe('Disambiguation hint: prefer the symbol defined in this file (workspace-relative path or suffix).');

export const codeToolSchemas = {
  find_symbol: {
    description:
      'Find where a symbol is defined by name (bare or qualified), workspace-wide. ' +
      'Returns definitions with file:line, kind, and signature. Use INSTEAD of ' +
      'grep/Read to locate a definition. Ambiguous names return the candidate ' +
      'list so you can re-call qualified.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name, e.g. "login" or "AuthService::login".'),
      kinds: z.array(symbolKind).optional().describe('Restrict to these symbol kinds.'),
      langs: z.array(codeLang).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      offset,
    }),
  },

  get_symbol: {
    description:
      'Full declaration of a symbol by name: signature, doc, span, and (for a ' +
      'type/impl) its members. Use INSTEAD of Read when you need a symbol\'s ' +
      'shape, not its body.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name.'),
      path: pathHint,
      includeMembers: z.boolean().default(true).describe('List members of a type/impl (methods, fields).'),
    }),
  },

  outline: {
    description:
      "Structural outline of a file: its symbols, signatures, and line ranges, " +
      'ordered by position. Use INSTEAD of Read when you need a file\'s shape.',
    input: z.object({
      path: z.string().min(1).describe('Workspace-relative file path.'),
    }),
  },

  impact: {
    description:
      'What transitively DEPENDS ON a symbol ("blast radius"): every caller, ' +
      'reader, and implementer that reaches it, up to `depth` hops. Call BEFORE ' +
      'renaming/removing/changing a symbol, or on "what depends on X". Catches ' +
      'renamed-import references grep misses. Fuzzy (name-matched) dependants ' +
      'are marked as such.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name of the symbol to analyze.'),
      path: pathHint,
      depth: z.number().int().min(1).max(6).default(3).describe('Transitive hops to walk.'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  },

  who_calls: {
    description:
      'Direct call sites of a function/method ("callers"), or what it calls ' +
      '("callees"). Lighter than `impact` when you only want one hop. Catches ' +
      'renamed imports grep misses.',
    input: z.object({
      name: z.string().min(1),
      path: pathHint,
      direction: z.enum(['callers', 'callees']).default('callers'),
      includeFuzzy: z.boolean().default(true).describe('Include name-match (unverified) edges.'),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },

  file_deps: {
    description:
      'File-level dependency graph: which files depend on this one ("importers", ' +
      'the blast radius) or what it depends on ("imports"). Call BEFORE moving/' +
      'deleting a file or on "what would break".',
    input: z.object({
      path: z.string().min(1).describe('Workspace-relative file path.'),
      direction: z.enum(['importers', 'imports']).default('importers'),
      transitive: z.boolean().default(false).describe('Walk up to 5 hops; results carry their depth.'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  },

  module_map: {
    description:
      'The module (directory) dependency graph with its detected subsystems ' +
      '(Louvain clusters) and explicit-vs-implicit DRIFT: how much of the ' +
      'dependency weight crosses cluster boundaries. Call on "what are the ' +
      'subsystems", "is the architecture drifting", or before a big refactor. ' +
      'High drift means the folder layout and the real dependencies disagree.',
    input: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe('Max drift edges to list.'),
    }),
  },

  analyze: {
    description:
      'Workspace-wide architectural analyses. `kind`: dead_code (zero-reference ' +
      'symbols — candidates, not verdicts), fan_out (functions with the most ' +
      'outgoing calls), cycles (dependency cycles at module or type scope), ' +
      'test_gap (exported symbols with no test referencing them).',
    input: z.object({
      kind: z.enum(['dead_code', 'fan_out', 'cycles', 'test_gap']),
      scope: z.enum(['module', 'type']).default('module').describe('cycles only: cycle detection scope.'),
      pathPrefix: z.string().optional().describe('Limit to files under this workspace-relative directory.'),
      excludePath: z.string().optional().describe('Skip files under this directory (e.g. tests).'),
      includeExported: z.boolean().default(false).describe('dead_code: also report exported/public symbols.'),
      limit: z.number().int().min(1).max(100).default(30),
      offset,
    }),
  },
  check_rules: {
    description:
      'Evaluate the workspace\'s architectural rules (.pairs/rules.ron) against ' +
      'the code graph. Call AFTER editing code to verify no architecture rule is ' +
      'violated — each violation returns the rule\'s explanation so you can ' +
      'self-correct. `possible` findings come from fuzzy edges and never fail CI.',
    input: z.object({
      tier: z.number().int().min(1).max(2).optional().describe('Only evaluate rules of this tier.'),
      rule: z.string().optional().describe('Only evaluate this rule id.'),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },

  list_rules: {
    description: 'Summarize the active ruleset: rule ids, kinds, tiers, severities, and layers.',
    input: z.object({}),
  },

  explain_rule: {
    description: 'Full detail of one rule: its kind, configuration, and the explanation shown on violations.',
    input: z.object({
      rule: z.string().min(1).describe('Rule id from list_rules.'),
    }),
  },

  rename_symbol: {
    description:
      'Rename a symbol and every direct reference site (definition + callers/readers/' +
      'writers/implementers found via the same edges `impact` walks) consistently, ' +
      'in one pass. Aborts without touching any file if a reference site cannot be ' +
      'matched safely (e.g. the indexed line no longer contains the name at a word ' +
      'boundary) — re-index and retry. Revert via your VCS (e.g. `git checkout -- ' +
      '<files>`); this tool does not keep its own undo log.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name of the symbol to rename.'),
      newName: z.string().min(1).describe('New bare identifier.'),
      path: pathHint,
    }),
  },
} as const;

export type CodeToolName = keyof typeof codeToolSchemas;
export type CodeToolInput<T extends CodeToolName> = z.infer<(typeof codeToolSchemas)[T]['input']>;
export type CodeToolArgs<T extends CodeToolName> = z.input<(typeof codeToolSchemas)[T]['input']>;
