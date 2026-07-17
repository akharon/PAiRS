/**
 * Tool contracts shared by BOTH integration surfaces:
 *  - the stdio MCP server (src/mcp/server.ts) for Claude Code & any MCP client
 *  - vscode.lm.registerTool Language Model Tools for Copilot agent mode
 *
 * One zod schema per tool; both surfaces derive their JSON schema from here
 * so the contracts can't drift.
 */

import { z } from 'zod';
import { MEMORY_TYPES } from '../core/types';
import { CODE_LANGS, SYMBOL_KINDS } from '../index/types';

const memoryType = z.enum(MEMORY_TYPES as [string, ...string[]]);
const symbolKind = z.enum(SYMBOL_KINDS as [string, ...string[]]);
const codeLang = z.enum(CODE_LANGS as [string, ...string[]]);
const offset = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Skip this many results — re-call with the offset suggested in a truncated response to page.');
const pathHint = z
  .string()
  .optional()
  .describe('Disambiguation hint: prefer the symbol defined in this file (workspace-relative path or suffix).');

export const toolSchemas = {
  memory_save: {
    description:
      'Persist a durable fact (decision+rationale, constraint, preference, ' +
      'gotcha, failed approach) to workspace memory. Call PROACTIVELY when the ' +
      'user states one, not just when asked. Skip facts derivable from the code. ' +
      'Anchor to code with `sym:Qualified.Name` in the body.',
    input: z.object({
      type: memoryType,
      title: z.string().min(3).max(120),
      body: z.string().min(1).describe('Markdown. May link other memories by relative path.'),
      description: z.string().max(200).optional().describe('One-line summary.'),
      tags: z.array(z.string()).max(10).default([]),
      importance: z.number().min(0).max(1).default(0.5),
      resource: z.string().url().optional(),
    }),
  },

  memory_search: {
    description:
      'Search saved workspace memories by meaning and keywords. Call BEFORE ' +
      'proposing an approach or redoing investigation, and on "why did we...", ' +
      '"what did we decide...", "have we tried..." — often already recorded.',
    input: z.object({
      query: z.string().min(1),
      types: z.array(memoryType).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(25).default(8),
      offset,
      includeBody: z
        .boolean()
        .default(false)
        .describe('set true to include full bodies; default returns title+summary — fetch bodies only for the hits you need.'),
    }),
  },

  memory_list: {
    description:
      'List saved memory titles grouped by type — cheap overview of what is ' +
      'known about this workspace. Call at task start or on "what do we know".',
    input: z.object({
      types: z.array(memoryType).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset,
    }),
  },

  memory_forget: {
    description:
      'Delete a memory by id when it is wrong or obsolete. Prefer memory_save ' +
      'with corrected content when the topic is still relevant. Recoverable via rewind.',
    input: z.object({
      id: z.string(),
      reason: z.string().optional(),
    }),
  },

  memory_context: {
    description:
      'Token-budgeted briefing of the most relevant saved memories. Call ONCE ' +
      'at session/task start, before exploring code, with a short task ' +
      'description — returns ranked, deduplicated decisions/gotchas/constraints.',
    input: z.object({
      task: z.string().optional().describe('What you are about to work on — improves ranking. Omit for a general briefing.'),
      tokenBudget: z
        .number()
        .int()
        .min(200)
        .max(4000)
        .optional()
        .describe('Approx token cap; defaults to the workspace contextTokenBudget setting (1500).'),
      types: z.array(memoryType).optional(),
    }),
  },
} as const;

/**
 * Code-index tools (structural knowledge: definitions, call graph,
 * inheritance). Kept in a separate schema object so memory tooling is
 * untouched, but registered on the SAME two surfaces (MCP server +
 * vscode.lm) by extension.ts / server.ts. Only registered when
 * `pairs.codeIndex.enabled` is on.
 *
 * Shared response conventions (executor must follow):
 *  - Every symbol renders as `qualified — signature` + `[file:start-end]`.
 *  - Fuzzy-confidence graph edges render with a trailing `(~ name match)`
 *    marker so agents know to verify.
 *  - An ambiguous `symbol` argument returns the candidate list (qualified
 *    names) and asks the agent to re-call with one of them — not an error.
 */
export const codeToolSchemas = {
  code_search: {
    description:
      'Search code symbols workspace-wide by name, signature, or doc meaning. ' +
      'Returns definitions with file:line. Use INSTEAD of grep/Read for finding ' +
      'where something is defined, even without the exact name.',
    input: z.object({
      query: z.string().min(1),
      kinds: z.array(symbolKind).optional(),
      langs: z.array(codeLang).optional(),
      pathPrefix: z.string().optional().describe('Limit to files under this workspace-relative directory.'),
      excludePath: z.string().optional().describe('Skip files under this workspace-relative directory.'),
      exportedOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(10),
      offset,
    }),
  },

  who_calls: {
    description:
      'List call sites of a function/method workspace-wide ("callers"), or ' +
      'what it calls ("callees"). Call BEFORE renaming/removing a function, or ' +
      'on "what calls X" — catches renamed imports grep misses.',
    input: z.object({
      symbol: z.string().min(1),
      path: pathHint,
      direction: z.enum(['callers', 'callees']).default('callers'),
      depth: z.number().int().min(1).max(3).default(1).describe('Transitive hops; >1 returns a tree.'),
      includeFuzzy: z.boolean().default(true).describe('Include name-match (unverified) edges.'),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },

  find_implementations: {
    description:
      'Find every implementation/subtype of an interface or class ' +
      '("subtypes"), or its ancestry ("supertypes"), workspace-wide. Call ' +
      'BEFORE changing an interface/base class to see what must also change.',
    input: z.object({
      symbol: z.string().min(1),
      path: pathHint,
      direction: z.enum(['subtypes', 'supertypes']).default('subtypes'),
      transitive: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },

  code_outline: {
    description:
      "Structural outline of a file: symbols, signatures, line ranges. Use " +
      'INSTEAD of Read when you need a file\'s shape, not its full source.',
    input: z.object({
      path: z.string().min(1).describe('Workspace-relative file path.'),
    }),
  },

  find_dead_code: {
    description:
      'List symbols with zero references workspace-wide — dead-code ' +
      'CANDIDATES, not verdicts (syntactic only; misses dynamic dispatch/' +
      'reflection). Call before deleting a suspected-unused symbol. Verify ' +
      'each hit. Exported symbols excluded unless includeExported.',
    input: z.object({
      pathPrefix: z.string().optional().describe('Limit to files under this workspace-relative directory.'),
      excludePath: z.string().optional().describe('Skip files under this workspace-relative directory (e.g. tests).'),
      kinds: z.array(symbolKind).optional(),
      langs: z.array(codeLang).optional(),
      includeExported: z
        .boolean()
        .default(false)
        .describe('Also report exported/public symbols (may be consumed outside the workspace).'),
      limit: z.number().int().min(1).max(100).default(30),
      offset,
    }),
  },

  file_deps: {
    description:
      'File-level import graph: which files import this one ("importers", the ' +
      'blast radius), or what it imports ("imports"). Call BEFORE editing/' +
      'moving/deleting a file or on "what would break".',
    input: z.object({
      path: z.string().min(1).describe('Workspace-relative file path.'),
      direction: z.enum(['importers', 'imports']).default('importers'),
      transitive: z.boolean().default(false).describe('Walk up to 5 hops; results carry their depth.'),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  },

  code_hotspots: {
    description:
      'Rank the most complex functions/methods workspace-wide by cyclomatic ' +
      'or cognitive complexity. Call on "where to focus refactoring" or ' +
      '"riskiest code to change" — beats inspecting a random file.',
    input: z.object({
      metric: z.enum(['cognitive', 'cyclomatic']).default('cognitive'),
      threshold: z.number().int().min(1).optional().describe('Only symbols at or above this value.'),
      pathPrefix: z.string().optional(),
      kinds: z.array(symbolKind).optional(),
      langs: z.array(codeLang).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset,
    }),
  },

  find_duplicates: {
    description:
      'Find function/method pairs that are semantic near-duplicates ' +
      '(embedding similarity) — merge candidates. Call before writing a new ' +
      'helper to check for overlap. Conceptual only, not token-level clones; ' +
      'inspect bodies before merging. Requires embeddings enabled.',
    input: z.object({
      threshold: z.number().min(0.5).max(1).default(0.85).describe('Minimum cosine similarity.'),
      pathPrefix: z.string().optional(),
      kinds: z.array(symbolKind).optional(),
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum pairs returned.'),
      offset,
    }),
  },

  get_declaration: {
    description:
      'Full declaration of a function/method/class/type by name: signature, ' +
      'doc comment, member list. Use INSTEAD of Read when you need shape, not ' +
      'implementation body.',
    input: z.object({
      name: z.string().min(1).describe('Bare or qualified name, e.g. "login" or "AuthService.login".'),
      path: pathHint,
      includeMembers: z
        .boolean()
        .default(true)
        .describe('For class/interface/struct/enum kinds, also list child symbols (methods/fields).'),
    }),
  },

  change_impact: {
    description:
      'Blast-radius report: transitive callers, subtypes, importing files, and ' +
      'anchored memories for a symbol — one call replaces separate who_calls + ' +
      'find_implementations + file_deps + memory_search. Call BEFORE renaming/' +
      'moving/deleting. Syntactic only; fuzzy edges marked (~).',
    input: z.object({
      symbol: z.string().min(1).describe('Bare or qualified name, e.g. "login" or "AuthService.login".'),
      path: pathHint,
      depth: z.number().int().min(1).max(3).default(2).describe('Transitive caller hops.'),
      includeFuzzy: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(40).describe('Cap per section.'),
    }),
  },

  who_tests: {
    description:
      'Which tests exercise a symbol: walks callers up to `depth` hops into ' +
      'test files. Call BEFORE changing behavior or on "is X tested". In-file ' +
      'test modules (e.g. Rust #[cfg(test)]) not detected. Fuzzy edges (~).',
    input: z.object({
      symbol: z.string().min(1),
      path: pathHint,
      depth: z.number().int().min(1).max(3).default(2),
      includeFuzzy: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(30),
    }),
  },

  find_untested: {
    description:
      'Exported functions/methods with no direct test reference (depth 1 ' +
      'only; use who_tests for transitive). Coverage-review list, not a ' +
      'verdict — table-driven/reflective tests may not register.',
    input: z.object({
      pathPrefix: z.string().optional(),
      excludePath: z.string().optional(),
      kinds: z.array(symbolKind).optional().describe('Defaults to function+method.'),
      langs: z.array(codeLang).optional(),
      limit: z.number().int().min(1).max(100).default(30),
      offset,
    }),
  },

  dependency_cycle: {
    description:
      'Detect circular import dependencies (Tarjan SCC over the file import ' +
      'graph). Call when investigating brittle import/init order. Cycles ' +
      'length ≥ 2 only.',
    input: z.object({
      pathPrefix: z.string().optional().describe('Limit scan to files under this workspace-relative directory.'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max cycles to report.'),
    }),
  },

  index_status: {
    description:
      'Is the code index trustworthy now? Commit/branch indexed, commits ' +
      'since, dirty files, scan-in-flight, per-language counts. Call when a ' +
      'result looks stale, after a branch switch, or before a high-stakes change.',
    input: z.object({}),
  },
} as const;

export type ToolName = keyof typeof toolSchemas;
/** Parsed input (defaults applied) — what executor handlers receive after schema.parse. */
export type ToolInput<T extends ToolName> = z.infer<(typeof toolSchemas)[T]['input']>;
/** Raw input (defaults optional) — what callers may pass to execute(). */
export type ToolArgs<T extends ToolName> = z.input<(typeof toolSchemas)[T]['input']>;

export type CodeToolName = keyof typeof codeToolSchemas;
export type CodeToolInput<T extends CodeToolName> = z.infer<(typeof codeToolSchemas)[T]['input']>;
export type CodeToolArgs<T extends CodeToolName> = z.input<(typeof codeToolSchemas)[T]['input']>;

/** Transport-agnostic executor implemented once over MemoryStore/RecallRanker. */
export interface MemoryToolExecutor {
  execute<T extends ToolName>(
    tool: T,
    input: ToolArgs<T>,
    actor: 'mcp' | 'lm-tool' | 'chat'
  ): Promise<ToolResult>;
}

/** Same pattern over CodeStore/CodeSearch (src/mcp/codeToolExecutor.ts). */
export interface CodeToolExecutor {
  execute<T extends CodeToolName>(
    tool: T,
    input: CodeToolArgs<T>,
    actor: 'mcp' | 'lm-tool' | 'chat'
  ): Promise<ToolResult>;
}

export interface ToolResult {
  /** Markdown rendered back to the agent. */
  text: string;
  isError?: boolean;
}
