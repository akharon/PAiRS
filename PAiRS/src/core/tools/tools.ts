/**
 * Tool contracts for PAiRS's code-graph retrieval surface.
 *
 * One zod schema per tool; the VS Code Language Model Tools (Copilot) derive
 * their JSON schema from here via scripts/sync-lm-tools.mjs, so the contract
 * can't drift from what's actually registered.
 *
 * Descriptions and field docs are shipped with every Copilot request: keep
 * them to what an agent needs to pick the tool and set a parameter.
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
const offset = z.number().int().min(0).default(0).describe('Skip this many results (paging).');
const pathHint = z.string().optional().describe('Prefer the symbol defined in this file (path or suffix).');
const workspaceFolder = z.string().optional().describe('Workspace folder name when several are open; default first.');

export const codeToolSchemas = {
  find_symbol: {
    description:
      'Locate a symbol definition by bare or qualified name, workspace-wide (file:line, kind, signature). ' +
      'Use instead of grep/Read. preview:true adds doc + first body lines. Ambiguous names list candidates.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name, e.g. "login" or "AuthService::login".'),
      kinds: z.array(symbolKind).optional().describe('Restrict to these kinds.'),
      langs: z.array(codeLang).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      offset,
      preview: z.boolean().default(false).describe('Include doc and first body lines per hit.'),
      workspaceFolder,
    }),
  },

  get_symbol: {
    description: "Full declaration of a symbol: signature, doc, body excerpt, members. Use instead of Read for a symbol's shape.",
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name.'),
      path: pathHint,
      includeMembers: z.boolean().default(true).describe('List members of a type/impl.'),
      workspaceFolder,
    }),
  },

  outline: {
    description: "Symbols of one file with signatures and line numbers, in order. Use instead of Read to see a file's shape.",
    input: z.object({
      path: z.string().min(1).describe('Workspace-relative file path.'),
      workspaceFolder,
    }),
  },

  impact: {
    description:
      'Transitive dependants ("blast radius") of a symbol: callers, readers, implementers, up to `depth` hops. ' +
      'Call BEFORE renaming/removing/changing a symbol. Fuzzy (name-only) dependants are marked. ' +
      'kinds slices by edge type (["CALLS"] = callers only); includeTests:false drops test-only paths.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name.'),
      path: pathHint,
      depth: z.number().int().min(1).max(6).default(3).describe('Hops to walk.'),
      limit: z.number().int().min(1).max(200).default(25),
      includeTests: z.boolean().default(true).describe('Include dependants reached only via test files.'),
      kinds: z.array(z.enum(IMPACT_EDGE_KINDS)).optional().describe('Only these edge kinds, e.g. ["READS","WRITES"]. Omit for all.'),
      workspaceFolder,
    }),
  },

  diff_impact: {
    description:
      'Blast radius of the current git change in one merged walk: maps diff hunks to changed symbols, then their dependants ' +
      '(each listed once). Use instead of reading the diff and calling impact per function. ' +
      'Hunks outside any symbol are listed separately. Default: unstaged tree; rev for e.g. "main...HEAD".',
    input: z.object({
      rev: z.string().optional().describe('Git revision/range, e.g. "HEAD" or "main...HEAD". Omit for working-tree changes.'),
      staged: z.boolean().default(false).describe('Diff the index instead (ignored when rev is set).'),
      depth: z.number().int().min(1).max(6).default(3).describe('Hops from each changed symbol.'),
      limit: z.number().int().min(1).max(200).default(25),
      offset,
      includeTests: z.boolean().default(true).describe('Include dependants reached only via test files.'),
      kinds: z.array(z.enum(IMPACT_EDGE_KINDS)).optional().describe('Only these edge kinds. Omit for all.'),
      workspaceFolder,
    }),
  },

  hierarchy: {
    description:
      'Type tree: ancestors (extends/implements) and descendants, `depth` hops each way. ' +
      'Use before changing a base class/interface. Narrower than impact.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified class/interface/trait name.'),
      path: pathHint,
      depth: z.number().int().min(1).max(6).default(3).describe('Hops each direction.'),
      limit: z.number().int().min(1).max(200).default(25),
      workspaceFolder,
    }),
  },

  who_calls: {
    description:
      'Direct callers (or callees) of a function/method, one hop; cheaper than impact. ' +
      'includeTests:false hides test-file edges (footer says how many).',
    input: z.object({
      name: z.string().min(1),
      path: pathHint,
      direction: z.enum(['callers', 'callees']).default('callers'),
      includeFuzzy: z.boolean().default(true).describe('Include name-match (unverified) edges.'),
      includeTests: z.boolean().default(true).describe('Include edges from test files.'),
      limit: z.number().int().min(1).max(100).default(20),
      workspaceFolder,
    }),
  },

  file_deps: {
    description:
      'File-level dependencies: importers (what breaks if this file changes or moves) or imports. ' +
      'Use before moving/deleting a file.',
    input: z.object({
      path: z.string().min(1).describe('Workspace-relative file path.'),
      direction: z.enum(['importers', 'imports']).default('importers'),
      transitive: z.boolean().default(false).describe('Walk up to 5 hops; results carry depth.'),
      limit: z.number().int().min(1).max(200).default(25),
      workspaceFolder,
    }),
  },

  module_map: {
    description:
      'Directory-level architecture: subsystems, module cycles, dependency layers, fan-in/out, and drift between ' +
      'folder layout and real dependencies. Use for "where does this belong", "what is safe to change", big refactors. ' +
      'boundary drills into one edge.',
    input: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe('Max items per list (drift edges, cycles).'),
      depth: z.number().int().min(1).max(20).optional().describe('Collapse modules to N leading path segments (large monorepos).'),
      resolution: z.number().min(0.1).max(10).default(1).describe('Louvain resolution: >1 more/smaller subsystems.'),
      boundary: z
        .string()
        .optional()
        .describe('"<from module> -> <to module>" (keys from a plain call): the target symbols the source uses, with sites.'),
      workspaceFolder,
    }),
  },

  analyze: {
    description:
      'Workspace analyses by `kind`: dead_code (zero-reference candidates), fan_out (most outgoing calls), ' +
      'cycles (module/type), test_gap (exported symbols no test references).',
    input: z.object({
      kind: z.enum(['dead_code', 'fan_out', 'cycles', 'test_gap']),
      scope: z.enum(['module', 'type']).default('module').describe('cycles only.'),
      pathPrefix: z.string().optional().describe('Only files under this directory.'),
      excludePath: z.string().optional().describe('Skip files under this directory.'),
      includeExported: z.boolean().default(false).describe('dead_code: also exported symbols.'),
      limit: z.number().int().min(1).max(100).default(20),
      offset,
      workspaceFolder,
    }),
  },

  rename_symbol: {
    description:
      'Rename a symbol and all its reference sites in one pass. Aborts without writing if any site cannot be matched ' +
      'safely or is fuzzy (unless includeFuzzy). No undo log: revert via VCS.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name.'),
      newName: z.string().min(1).describe('New bare identifier.'),
      path: pathHint,
      includeFuzzy: z.boolean().optional().describe('Also rename name-only (fuzzy) sites; may hit unrelated same-named symbols.'),
      workspaceFolder,
    }),
  },

  grep_symbols: {
    description:
      'Substring or regex search over symbol names, qualified names, signatures and docs; returns file:line citations, ' +
      'not file contents. Use when the exact name is unknown.',
    input: z.object({
      pattern: z.string().min(1).describe('Substring, or regex when isRegex.'),
      isRegex: z.boolean().default(false),
      kinds: z.array(symbolKind).optional().describe('Restrict to these kinds.'),
      pathPrefix: z.string().optional().describe('Only files under this directory.'),
      limit: z.number().int().min(1).max(100).default(20),
      workspaceFolder,
    }),
  },

  context_pack: {
    description:
      "One call bundling a symbol's or file's definition, callers, callees, type hierarchy and module deps. " +
      'Use instead of several separate calls.',
    input: z.object({
      name: z.string().min(1).optional().describe('Symbol name. Give this or `path`.'),
      path: z.string().min(1).optional().describe('Workspace-relative file path. Give this or `name`.'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max items per section.'),
      workspaceFolder,
    }),
  },
} as const;

export type CodeToolName = keyof typeof codeToolSchemas;
export type CodeToolInput<T extends CodeToolName> = z.infer<(typeof codeToolSchemas)[T]['input']>;
export type CodeToolArgs<T extends CodeToolName> = z.input<(typeof codeToolSchemas)[T]['input']>;
