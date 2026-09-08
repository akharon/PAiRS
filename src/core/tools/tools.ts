/**
 * Tool contracts for PAiRS's code-graph retrieval surface.
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
import { IMPACT_EDGE_KINDS } from '../analyze/impact';

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
      'list so you can re-call qualified. Pass preview:true to also get each ' +
      "hit's doc and first body lines, which usually removes the follow-up Read.",
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name, e.g. "login" or "AuthService::login".'),
      kinds: z.array(symbolKind).optional().describe('Restrict to these symbol kinds.'),
      langs: z.array(codeLang).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      offset,
      preview: z
        .boolean()
        .default(false)
        .describe(
          "Include the symbol's doc line and first few body lines with each hit — usually removes the follow-up Read."
        ),
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
      'are marked as such. Set includeTests:false to walk only production ' +
      'dependants (test-only paths are excluded from the walk, not just hidden). ' +
      'Pass kinds to slice by edge type (e.g. kinds:["CALLS"] for callers only).',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name of the symbol to analyze.'),
      path: pathHint,
      depth: z.number().int().min(1).max(6).default(3).describe('Transitive hops to walk.'),
      limit: z.number().int().min(1).max(200).default(50),
      includeTests: z.boolean().default(true).describe('Include dependants reached only through test files. Off filters test-only paths out of the walk entirely, not just the rendered list.'),
      kinds: z
        .array(z.enum(IMPACT_EDGE_KINDS))
        .optional()
        .describe(
          'Restrict the walk to these dependency edge kinds — e.g. ["CALLS"] for callers only, ' +
            '["READS","WRITES"] for data access. Omit for all kinds.'
        ),
    }),
  },

  diff_impact: {
    description:
      'Blast radius of the CURRENT CHANGE: maps the git diff\'s changed line ranges to ' +
      'the symbols containing them, then walks every dependant of all of them in one ' +
      'merged pass. Use INSTEAD of reading the diff and then calling `impact` once per ' +
      'changed function — dependants reached from several changed symbols appear once, ' +
      'tagged with which ones reach them. Answers "what do I need to re-test / re-review ' +
      'for this change". Changed lines that sit in no symbol (imports, module-level code, ' +
      'unindexed files) are reported separately, never silently dropped. Defaults to the ' +
      'unstaged working tree; pass `rev` for a revision or range like "main...HEAD".',
    input: z.object({
      rev: z
        .string()
        .optional()
        .describe('Git revision or range to diff, e.g. "HEAD" or "main...HEAD". Omit for uncommitted working-tree changes.'),
      staged: z.boolean().default(false).describe('Diff the index (`git diff --staged`) instead of the working tree. Ignored when `rev` is set.'),
      depth: z.number().int().min(1).max(6).default(3).describe('Transitive hops to walk from each changed symbol.'),
      limit: z.number().int().min(1).max(200).default(50),
      offset,
      includeTests: z.boolean().default(true).describe('Include dependants reached only through test files.'),
      kinds: z
        .array(z.enum(IMPACT_EDGE_KINDS))
        .optional()
        .describe('Restrict the walk to these dependency edge kinds. Omit for all kinds.'),
    }),
  },

  hierarchy: {
    description:
      'Inheritance/interface tree around a type: what it EXTENDS/IMPLEMENTS ' +
      '(ancestors) and what EXTENDS/IMPLEMENTS it (descendants), up to `depth` ' +
      'hops each way. Call on "what does X inherit from", "what implements X", ' +
      'or before changing a base class/interface to see every subclass affected. ' +
      'Narrower than `impact` (which also includes CALLS/READS/WRITES); use this ' +
      'when you specifically want the type hierarchy, not the full dependant set.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name of the class/interface/trait to analyze.'),
      path: pathHint,
      depth: z.number().int().min(1).max(6).default(3).describe('Transitive hops to walk, each direction.'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  },

  who_calls: {
    description:
      'Direct call sites of a function/method ("callers"), or what it calls ' +
      '("callees"). Lighter than `impact` when you only want one hop. Catches ' +
      'renamed imports grep misses. Set includeTests:false to hide test-file ' +
      'callers/callees — the footer reports how many were hidden.',
    input: z.object({
      name: z.string().min(1),
      path: pathHint,
      direction: z.enum(['callers', 'callees']).default('callers'),
      includeFuzzy: z.boolean().default(true).describe('Include name-match (unverified) edges.'),
      includeTests: z.boolean().default(true).describe('Include edges whose reference site is in a test file. Off hides them and the footer states how many were hidden.'),
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
      'The module (directory) dependency graph: detected subsystems (Louvain ' +
      'clusters), module CYCLES, each module\'s dependency LAYER and fan-in/' +
      'fan-out, the most depended-on modules, and explicit-vs-implicit DRIFT ' +
      '(how much dependency weight crosses cluster boundaries). Call on "what ' +
      'are the subsystems", "where does this belong", "what is safe to change", ' +
      '"is the architecture drifting", or before a big refactor. High drift ' +
      'means the folder layout and the real dependencies disagree; cycles mean ' +
      'no layering holds at all.',
    input: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe('Max drift edges to list.'),
      depth: z.number().int().min(1).max(20).optional().describe('Collapse modules to this many leading path segments — use on large monorepos to keep the map legible.'),
      resolution: z.number().min(0.1).max(10).default(1).describe('Louvain resolution: >1 finds more/smaller subsystems, <1 fewer/larger ones.'),
      boundary: z
        .string()
        .optional()
        .describe(
          'Drill into one edge instead of the whole map: "<from module> -> <to module>" ' +
            '(module keys as printed by a plain module_map call). Returns the symbols of ' +
            'the target module that the source actually uses, with reference sites — i.e. ' +
            'exactly what breaking that dependency would require.'
        ),
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
  rename_symbol: {
    description:
      'Rename a symbol and every direct reference site (definition + callers/readers/' +
      'writers/implementers found via the same edges `impact` walks) consistently, ' +
      'in one pass. Aborts without touching any file if a reference site cannot be ' +
      'matched safely (e.g. the indexed line no longer contains the name at a word ' +
      'boundary) — re-index and retry. Aborts without writing if any reference site is ' +
      'fuzzy (name-only match) unless includeFuzzy is set. Revert via your VCS (e.g. ' +
      '`git checkout -- <files>`); this tool does not keep its own undo log.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name of the symbol to rename.'),
      newName: z.string().min(1).describe('New bare identifier.'),
      path: pathHint,
      includeFuzzy: z
        .boolean()
        .optional()
        .describe(
          'Also rename reference sites reached by fuzzy (name-only) edges. Off by default: ' +
            'those sites may belong to an unrelated symbol sharing the name.'
        ),
    }),
  },

  grep_symbols: {
    description:
      'Search symbol names, qualified names, signatures, and doc text by substring or ' +
      'regex, returning graph citations (not file contents). Use when you know roughly ' +
      "what you're looking for but not the exact symbol name — a plain-text search over " +
      'the index instead of grep-and-Read over the filesystem.',
    input: z.object({
      pattern: z.string().min(1).describe('Substring (default) or regex to match against name/qualified/signature/doc.'),
      isRegex: z.boolean().default(false).describe('Treat `pattern` as a regular expression instead of a plain substring.'),
      kinds: z.array(symbolKind).optional().describe('Restrict to these symbol kinds.'),
      pathPrefix: z.string().optional().describe('Limit to files under this workspace-relative directory.'),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },

  context_pack: {
    description:
      'One assembled bundle for a symbol or file: its definition, direct callers, direct ' +
      'callees, type hierarchy (if a type), and enclosing module boundary. Composes ' +
      'find_symbol/who_calls/hierarchy/module_map into a single call — use this instead ' +
      'of making all of those calls separately when you need broad context on one symbol ' +
      'or file fast.',
    input: z.object({
      name: z.string().min(1).optional().describe('Symbol name (bare or qualified). Provide this or `path`.'),
      path: z.string().min(1).optional().describe('Workspace-relative file path, for a file-level pack. Provide this or `name`.'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max items per section (callers, callees, etc).'),
    }),
  },
} as const;

export type CodeToolName = keyof typeof codeToolSchemas;
export type CodeToolInput<T extends CodeToolName> = z.infer<(typeof codeToolSchemas)[T]['input']>;
export type CodeToolArgs<T extends CodeToolName> = z.input<(typeof codeToolSchemas)[T]['input']>;
