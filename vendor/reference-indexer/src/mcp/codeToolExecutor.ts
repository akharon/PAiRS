/**
 * CodeToolExecutor implementation shared by the MCP server and the VS Code
 * LanguageModelTools surface — the code-index twin of toolExecutor.ts
 * (invariant #6: one behavior, all transports go through here).
 */

import type { CodeStore } from '../index/codeStore';
import type { CodeSearch } from '../index/codeSearch';
import type {
  CallTreeNode,
  EdgeConfidence,
  EdgeKind,
  ScoredSymbol,
  SymbolRecord,
  TypeRelation,
} from '../index/types';
import {
  codeToolSchemas,
  type CodeToolArgs,
  type CodeToolExecutor,
  type CodeToolInput,
  type CodeToolName,
  type ToolResult,
} from './tools';
import { applyBudget, budgetItems, freshnessFooter, truncationFooter } from './renderShared';
import type { IndexFreshness } from '../index/provenance';
import { logger } from '../core/logger';

export interface CodeToolExecutorDeps {
  store: CodeStore;
  search: CodeSearch;
  /** Approx-token cap on rendered results, mirroring the memory executor. Default 1500. */
  contextTokenBudget?: number;
  /**
   * Optional: find memories anchored to a symbol (body contains
   * `sym:<qualified>`). When absent, change_impact silently omits its
   * "Linked memories" section rather than hard-depending on the memory store.
   */
  memoryAnchors?: (qualified: string) => Promise<Array<{ id: string; title: string; type: string }>>;
  /**
   * Optional: live index freshness (docs/MemoryIndexSynergy.md §F1), called
   * once per tool response. When absent, the footer falls back to the plain
   * "updated <ISO>" line it always had.
   */
  freshness?: () => Promise<IndexFreshness | null>;
}

export class CodeToolExecutorImpl implements CodeToolExecutor {
  private readonly store: CodeStore;
  private readonly search: CodeSearch;
  private readonly contextTokenBudget: number;
  private readonly memoryAnchors?: (qualified: string) => Promise<Array<{ id: string; title: string; type: string }>>;
  private readonly getFreshness?: () => Promise<IndexFreshness | null>;

  constructor(deps: CodeToolExecutorDeps) {
    this.store = deps.store;
    this.search = deps.search;
    this.contextTokenBudget = deps.contextTokenBudget ?? 1500;
    this.memoryAnchors = deps.memoryAnchors;
    this.getFreshness = deps.freshness;
  }

  async execute<T extends CodeToolName>(
    tool: T,
    input: CodeToolArgs<T>,
    _actor: 'mcp' | 'lm-tool' | 'chat'
  ): Promise<ToolResult> {
    // Log tool calls for verification
    if (typeof process !== 'undefined' && process.env.DEBUG_PAIRS) {
      console.log(`[Memory] Executing code tool: ${tool}`, { actor: _actor, input });
    }
    try {
      // Freshness contract: never let "no results" be mistaken for "not indexed".
      // index_status is exempt — asking "is the index trustworthy" while it's
      // empty is a valid, answerable question, not a case to short-circuit.
      const stats = await this.store.stats();
      if (stats.symbols === 0 && tool !== 'index_status') {
        return {
          text:
            `Code index is empty — no symbols indexed yet (initial scan still running, code ` +
            `indexing disabled, or the standalone server has never indexed this workspace). ` +
            `Absence of results is NOT evidence; fall back to Read/grep or retry after indexing.`,
        };
      }
      const result = await this.dispatch(tool, input);
      if (!result.isError && tool !== 'index_status') {
        const freshness = await this.getFreshness?.().catch(() => null);
        // Token-cost tradeoff (docs/OptimizationPlan.md T3): a trustworthy,
        // up-to-date index needs no per-call footer — only surface it when
        // there's something the agent should actually weigh (lag, dirty
        // files, a scan in flight, or freshness being unknown at all).
        const isStale =
          !freshness ||
          freshness.indexing ||
          (freshness.commitsBehind !== null && freshness.commitsBehind > 0) ||
          freshness.dirtyUnindexed.length > 0;
        if (isStale) {
          const trust = freshness ? ` — ${freshnessFooter(freshness)}` : '';
          const updated = stats.lastIndexedAt ? new Date(stats.lastIndexedAt).toISOString() : 'never';
          result.text += `\n\n_index: ${stats.files} files, ${stats.symbols} symbols, updated ${updated}${trust}_`;
        }
      }
      return result;
    } catch (err) {
      logger.error(`code tool ${String(tool)}`, err);
      return { text: `Error: ${(err as Error).message}`, isError: true };
    }
  }

  private async dispatch<T extends CodeToolName>(tool: T, input: CodeToolArgs<T>): Promise<ToolResult> {
    const handlers: Partial<Record<CodeToolName, (value: unknown) => Promise<ToolResult>>> = {
      code_search: (value) => this.codeSearch(codeToolSchemas.code_search.input.parse(value)),
      who_calls: (value) => this.whoCalls(codeToolSchemas.who_calls.input.parse(value)),
      find_implementations: (value) => this.findImplementations(codeToolSchemas.find_implementations.input.parse(value)),
      code_outline: (value) => this.codeOutline(codeToolSchemas.code_outline.input.parse(value)),
      find_dead_code: (value) => this.findDeadCode(codeToolSchemas.find_dead_code.input.parse(value)),
      file_deps: (value) => this.fileDeps(codeToolSchemas.file_deps.input.parse(value)),
      code_hotspots: (value) => this.codeHotspots(codeToolSchemas.code_hotspots.input.parse(value)),
      find_duplicates: (value) => this.findDuplicates(codeToolSchemas.find_duplicates.input.parse(value)),
      get_declaration: (value) => this.getDeclaration(codeToolSchemas.get_declaration.input.parse(value)),
      change_impact: (value) => this.changeImpact(codeToolSchemas.change_impact.input.parse(value)),
      who_tests: (value) => this.whoTests(codeToolSchemas.who_tests.input.parse(value)),
      find_untested: (value) => this.findUntested(codeToolSchemas.find_untested.input.parse(value)),
      dependency_cycle: (value) => this.dependencyCycle(codeToolSchemas.dependency_cycle.input.parse(value)),
      index_status: () => this.indexStatus(),
    };

    const handler = handlers[tool];
    if (!handler) return { text: `Unknown tool: ${String(tool)}`, isError: true };
    return handler(input);
  }

  private async codeSearch(input: CodeToolInput<'code_search'>): Promise<ToolResult> {
    const results = await this.search.search({
      text: input.query,
      kinds: input.kinds as ScoredSymbol['symbol']['kind'][] | undefined,
      langs: input.langs as ScoredSymbol['symbol']['lang'][] | undefined,
      pathPrefix: input.pathPrefix,
      excludePath: input.excludePath,
      exportedOnly: input.exportedOnly,
      limit: input.limit,
      offset: input.offset,
    });

    if (!results.length) {
      return { text: `No symbols found for "${input.query}"${input.offset ? ` at offset ${input.offset}` : ''}.` };
    }

    const header =
      input.offset > 0
        ? `Found ${results.length} symbol${results.length === 1 ? '' : 's'} (offset ${input.offset}):`
        : `Found ${results.length} symbol${results.length === 1 ? '' : 's'}:`;
    const lines: string[] = [header, ''];
    // One block per result so the token budget and pagination offset count
    // symbols, not the interleaved `## <file>` header lines (R1). A stateful
    // renderer emits the header the first time each file appears; budgetItems
    // stops at the first over-budget item, so prevFile can't run ahead.
    let prevFile: string | null = null;
    const renderBlock = (r: ScoredSymbol): string => {
      const s = r.symbol;
      const fileHeader = s.file === prevFile ? '' : `## ${s.file}\n`;
      prevFile = s.file;
      const doc = s.doc ? `\n  > ${firstLine(s.doc)}` : '';
      return `${fileHeader}- ${s.qualified}${s.signature ?? ''} ·${s.kind} — score ${r.score.toFixed(2)}  :${s.startLine}-${s.endLine}${doc}`;
    };
    const { blocks, included } = budgetItems(results, renderBlock, this.contextTokenBudget);
    lines.push(...blocks);
    if (included < results.length) {
      lines.push(truncationFooter(results.length - included, 'result', input.offset + included));
    } else if (results.length === input.limit) {
      lines.push(`\n_(page full — re-call with offset=${input.offset + results.length} for more)_`);
    }
    return { text: lines.join('\n') };
  }

  /** Resolve a symbol name, using a caller-supplied path hint to break ambiguity in one call. */
  private async resolveSymbol(
    name: string,
    pathHint?: string
  ): Promise<SymbolRecord[] | { ambiguous: true; candidates: SymbolRecord[] }> {
    const resolved = await this.store.lookup(name);
    if (isAmbiguous(resolved) && pathHint) {
      const matches = resolved.candidates.filter((s) => s.file === pathHint || s.file.endsWith(pathHint));
      if (matches.length === 1) return matches;
      if (matches.length > 1) return { ambiguous: true, candidates: matches };
    }
    return resolved;
  }

  private async whoCalls(input: CodeToolInput<'who_calls'>): Promise<ToolResult> {
    const resolved = await this.resolveSymbol(input.symbol, input.path);
    if (isAmbiguous(resolved)) return renderAmbiguous(resolved.candidates);
    if (resolved.length === 0) {
      return {
        text: `No symbol found matching "${input.symbol}". Try code_search to locate the right name.`,
      };
    }

    const tree = await this.buildCallTree(input, resolved);
    if (tree.length === 0) {
      const verb = input.direction === 'callers' ? 'callers' : 'callees';
      const root = resolved[0]!;
      return { text: `No ${verb} found for \`${root.qualified}\`.` };
    }

    const root = resolved[0]!;
    const header = `${input.direction === 'callers' ? 'Callers of' : 'Callees of'} \`${root.qualified}\`:`;
    const lines = [header, ...renderCallTree(tree)];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async findImplementations(input: CodeToolInput<'find_implementations'>): Promise<ToolResult> {
    const resolved = await this.resolveSymbol(input.symbol, input.path);
    if (isAmbiguous(resolved)) return renderAmbiguous(resolved.candidates);
    if (resolved.length === 0) {
      return {
        text: `No symbol found matching "${input.symbol}". Try code_search to locate the right name.`,
      };
    }

    const root = resolved[0]!;
    const relations = await this.collectTypeRelations(input, root);

    if (relations.length === 0) {
      const verb = input.direction === 'subtypes' ? 'implementations/subtypes' : 'supertypes';
      return { text: `No ${verb} found for \`${root.qualified}\`.` };
    }

    const header = `${input.direction === 'subtypes' ? 'Subtypes of' : 'Supertypes of'} \`${root.qualified}\`:`;
    const lines = [header, ...renderTypeRelations(relations)];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async buildCallTree(input: CodeToolInput<'who_calls'>, roots: SymbolRecord[]): Promise<CallTreeNode[]> {
    const kinds: EdgeKind[] = ['calls'];
    const visited = new Set<number>(roots.map((s) => s.id));
    let remaining = input.limit;

    const buildLevel = async (symbols: SymbolRecord[], depth: number): Promise<CallTreeNode[]> => {
      if (depth > input.depth || remaining <= 0 || symbols.length === 0) return [];
      const ids = symbols.map((s) => s.id);
      const edges =
        input.direction === 'callers'
          ? await this.store.edgesTo(ids, kinds)
          : await this.store.edgesFrom(ids, kinds);

      const nodes: CallTreeNode[] = [];
      for (const edge of edges) {
        if (edge.confidence === 'fuzzy' && !input.includeFuzzy) continue;
        const otherId = input.direction === 'callers' ? edge.fromId : edge.toId;
        if (visited.has(otherId) && depth > 1) continue; // allow siblings at depth 1, guard deeper cycles
        if (remaining <= 0) break;
        const symbol = await this.store.get(otherId);
        if (!symbol) continue;
        visited.add(otherId);
        remaining -= 1;
        const children = await buildLevel([symbol], depth + 1);
        nodes.push({ symbol, line: edge.line, confidence: edge.confidence, children });
      }
      return nodes;
    };

    return buildLevel(roots, 1);
  }

  private async collectTypeRelations(
    input: CodeToolInput<'find_implementations'>,
    root: SymbolRecord
  ): Promise<TypeRelation[]> {
    const kinds: EdgeKind[] = ['extends', 'implements'];
    const visited = new Set<number>([root.id]);
    const relations: TypeRelation[] = [];
    let frontier: SymbolRecord[] = [root];
    let depth = 1;
    const maxDepth = input.transitive ? 8 : 1;

    while (frontier.length > 0 && depth <= maxDepth && relations.length < input.limit) {
      const ids = frontier.map((s) => s.id);
      const edges =
        input.direction === 'subtypes' ? await this.store.edgesTo(ids, kinds) : await this.store.edgesFrom(ids, kinds);

      const next: SymbolRecord[] = [];
      for (const edge of edges) {
        const otherId = input.direction === 'subtypes' ? edge.fromId : edge.toId;
        if (visited.has(otherId)) continue;
        visited.add(otherId);
        const symbol = await this.store.get(otherId);
        if (!symbol) continue;
        relations.push({ symbol, kind: edge.kind as TypeRelation['kind'], confidence: edge.confidence, depth });
        next.push(symbol);
        if (relations.length >= input.limit) break;
      }
      frontier = next;
      depth += 1;
    }

    return relations;
  }

  private async codeOutline(input: CodeToolInput<'code_outline'>): Promise<ToolResult> {
    const symbols = await this.store.outline(input.path);
    if (symbols.length === 0) {
      // Check if the file IS indexed (has a module symbol) but just has no
      // top-level declarations — common for barrel/re-export index files.
      const files = await this.store.listFiles();
      const isIndexed = files.some((f) => f.path === input.path);
      if (isIndexed) {
        return {
          text:
            `"${input.path}" is indexed but has no top-level symbols — it may be a ` +
            `re-export barrel, an index file with only \`export { ... } from\` statements, ` +
            `or a file with only top-level statements (no function/class/var declarations).`,
        };
      }
      return {
        text:
          `No indexed symbols for "${input.path}". Either the file isn't indexed yet, has no ` +
          `top-level declarations, or its extension isn't one of: c, cpp, py, js, ts, java (and variants).`,
      };
    }

    const depthOf = (s: SymbolRecord, byId: Map<number, SymbolRecord>): number => {
      let d = 0;
      let cur: SymbolRecord | undefined = s;
      while (cur?.parentId !== null && cur?.parentId !== undefined) {
        cur = byId.get(cur.parentId);
        d += 1;
      }
      return d;
    };
    const byId = new Map(symbols.map((s) => [s.id, s]));

    const lines = [`## ${input.path}`, ''];
    for (const s of symbols) {
      const indent = '  '.repeat(depthOf(s, byId));
      const sig = s.signature ?? '';
      const hotspot = s.complexity >= 10 ? ` [cx ${s.complexity}]` : '';
      lines.push(`${indent}- ${s.kind} \`${s.name}\`${sig}  [L${s.startLine}-${s.endLine}]${hotspot}`);
    }
    return applyBudget(lines, this.contextTokenBudget);
  }

  // -- v4 analysis tools --------------------------------------------------------

  private async findDeadCode(input: CodeToolInput<'find_dead_code'>): Promise<ToolResult> {
    const candidates = await this.store.unreferenced({
      pathPrefix: input.pathPrefix,
      excludePath: input.excludePath,
      kinds: input.kinds as SymbolRecord['kind'][] | undefined,
      langs: input.langs as SymbolRecord['lang'][] | undefined,
      includeExported: input.includeExported,
      limit: input.limit,
      offset: input.offset,
    });

    if (candidates.length === 0) {
      return {
        text: `No unreferenced symbols found${input.pathPrefix ? ` under "${input.pathPrefix}"` : ''}${
          input.offset ? ` at offset ${input.offset}` : ''
        }.`,
      };
    }

    const lines = [
      `${candidates.length} dead-code candidate(s)${input.offset ? ` (offset ${input.offset})` : ''} ` +
        `(syntactic analysis — verify before deleting; dynamic/reflective uses are invisible):`,
      '',
      ...renderGroupedByFile(
        candidates.map((c) => c.symbol),
        (s) => {
          const c = candidates.find((c) => c.symbol.id === s.id);
          return c?.note === 'exported' ? `${s.qualified} _(exported)_` : s.qualified;
        }
      ),
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async fileDeps(input: CodeToolInput<'file_deps'>): Promise<ToolResult> {
    const deps = await this.store.fileEdges(input.path, input.direction, {
      transitive: input.transitive,
      limit: input.limit,
    });

    if (deps.length === 0) {
      const outline = await this.store.outline(input.path);
      if (outline.length === 0) {
        return {
          text:
            `No indexed symbols for "${input.path}". Either the file isn't indexed yet, has no ` +
            `top-level declarations, or its extension isn't one of: c, cpp, py, js, ts, java (and variants).`,
        };
      }
      return { text: `No ${input.direction} found for "${input.path}".` };
    }

    const header =
      input.direction === 'importers' ? `Files that import ${input.path}:` : `Files imported by ${input.path}:`;
    const lines = [
      header,
      ...deps.map(
        (d) => `- ${d.path}  [L${d.line}]${input.transitive && d.depth > 1 ? `  (depth ${d.depth})` : ''}`
      ),
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async codeHotspots(input: CodeToolInput<'code_hotspots'>): Promise<ToolResult> {
    const symbols = await this.store.hotspots({
      metric: input.metric,
      threshold: input.threshold,
      pathPrefix: input.pathPrefix,
      kinds: input.kinds as SymbolRecord['kind'][] | undefined,
      langs: input.langs as SymbolRecord['lang'][] | undefined,
      limit: input.limit,
      offset: input.offset,
    });

    if (symbols.length === 0) {
      return {
        text: `No functions at or above ${input.metric}${input.threshold !== undefined ? ` ${input.threshold}` : ''}${
          input.offset ? ` at offset ${input.offset}` : ''
        }.`,
      };
    }

    const lines = [
      `Top ${symbols.length} by ${input.metric} complexity${input.offset ? ` (offset ${input.offset})` : ''}:`,
      '',
      ...renderGroupedByFile(
        symbols,
        (s) => `${s.qualified}  cx ${s.complexity} / cog ${s.cognitive}`
      ),
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async findDuplicates(input: CodeToolInput<'find_duplicates'>): Promise<ToolResult> {
    const stats = await this.store.stats();
    if (stats.symbols === 0 || stats.symbols - stats.pendingEmbeddings === 0) {
      return {
        text:
          `Duplicate detection requires code-index embeddings ` +
          `(pairs.codeIndex.embeddingsEnabled) and an initial indexing pass.`,
      };
    }

    const pairs = await this.store.similarPairs(input.threshold, {
      pathPrefix: input.pathPrefix,
      kinds: input.kinds as SymbolRecord['kind'][] | undefined,
      limit: input.limit,
      offset: input.offset,
    });

    if (pairs.length === 0) {
      return {
        text: `No similar symbol pairs found at or above ${(input.threshold * 100).toFixed(0)}% similarity${
          input.offset ? ` at offset ${input.offset}` : ''
        }.`,
      };
    }

    const lines = [
      `${pairs.length} similar pair(s)${input.offset ? ` (offset ${input.offset})` : ''} ` +
        `(semantic similarity of name/signature/doc — inspect bodies before merging):`,
      ...pairs.flatMap((p) => [
        `- \`${p.a.qualified}\` ↔ \`${p.b.qualified}\`  ${(p.similarity * 100).toFixed(0)}%`,
        `  [${p.a.file}:${p.a.startLine}] ↔ [${p.b.file}:${p.b.startLine}]`,
      ]),
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async getDeclaration(input: CodeToolInput<'get_declaration'>): Promise<ToolResult> {
    const resolved = await this.resolveSymbol(input.name, input.path);
    if (isAmbiguous(resolved)) return renderAmbiguous(resolved.candidates);
    if (resolved.length === 0) {
      return {
        text: `No symbol found matching "${input.name}". Try code_search to locate the right name.`,
      };
    }

    const symbol = resolved[0]!;
    const lines = [
      renderSymbol(symbol),
      `_(${symbol.exported ? 'exported' : 'not exported'}, complexity ${symbol.complexity}, cognitive ${symbol.cognitive})_`,
    ];
    if (symbol.doc) lines.push('', symbol.doc);

    const CONTAINER_KINDS: SymbolRecord['kind'][] = ['class', 'struct', 'interface', 'enum'];
    if (input.includeMembers && CONTAINER_KINDS.includes(symbol.kind)) {
      const members = await this.store.membersOf(symbol.id);
      if (members.length > 0) {
        lines.push('', 'Members:', ...members.map((m) => `- ${renderSymbol(m)}`));
      }
    }

    return applyBudget(lines, this.contextTokenBudget);
  }

  private async changeImpact(input: CodeToolInput<'change_impact'>): Promise<ToolResult> {
    const resolved = await this.resolveSymbol(input.symbol, input.path);
    if (isAmbiguous(resolved)) return renderAmbiguous(resolved.candidates);
    if (resolved.length === 0) {
      return { text: `No symbol found matching "${input.symbol}". Try code_search to locate the right name.` };
    }
    const root = resolved[0]!;

    const CONTAINER_KINDS: SymbolRecord['kind'][] = ['class', 'struct', 'interface'];
    const sections: string[] = [];
    // Track symbols already rendered to avoid duplication across sections (R5).
    const renderedQualified = new Set<string>();

    // 1. Callers (transitive) + other references at depth 1.
    const callTree = await this.buildCallTree(
      { symbol: input.symbol, path: input.path, direction: 'callers', depth: input.depth, includeFuzzy: input.includeFuzzy, limit: input.limit },
      resolved
    );
    if (callTree.length > 0) {
      // Mark all symbols rendered in the call tree
      const markTree = (nodes: CallTreeNode[]) => {
        for (const n of nodes) {
          renderedQualified.add(n.symbol.qualified);
          markTree(n.children);
        }
      };
      markTree(callTree);
      sections.push('## Callers', ...renderCallTree(callTree));
    }
    const otherRefs = await this.store.edgesTo([root.id], ['references']);
    const fuzzyFiltered = input.includeFuzzy ? otherRefs : otherRefs.filter((e) => e.confidence === 'resolved');
    if (fuzzyFiltered.length > 0) {
      const lines: string[] = [];
      for (const edge of fuzzyFiltered.slice(0, input.limit)) {
        const symbol = await this.store.get(edge.fromId);
        if (!symbol) continue;
        if (renderedQualified.has(symbol.qualified)) {
          lines.push(`- ${symbol.qualified} (also caller) L${edge.line}${confidenceMarker(edge.confidence)}`);
        } else {
          lines.push(`- ${renderSymbol(symbol)} L${edge.line}${confidenceMarker(edge.confidence)}`);
          renderedQualified.add(symbol.qualified);
        }
      }
      if (lines.length > 0) sections.push('## Other references', ...lines);
    }

    // 2. Subtypes/implementations, only for class/interface/struct kinds.
    if (CONTAINER_KINDS.includes(root.kind)) {
      const relations = await this.collectTypeRelations(
        { symbol: input.symbol, path: input.path, direction: 'subtypes', transitive: true, limit: input.limit },
        root
      );
      if (relations.length > 0) {
        sections.push('## Subtypes/implementations', ...renderTypeRelations(relations));
        for (const r of relations) renderedQualified.add(r.symbol.qualified);
      }
    }

    // 3. Files importing this symbol's file, transitively.
    const importers = await this.store.fileEdges(root.file, 'importers', { transitive: true, maxDepth: 3, limit: input.limit });
    if (importers.length > 0) {
      sections.push(
        '## Importing files',
        ...importers.map((d) => `- ${d.path}  L${d.line}${d.depth > 1 ? `  (depth ${d.depth})` : ''}`)
      );
    }

    // 4. Linked memories (optional dep).
    if (this.memoryAnchors) {
      const memories = await this.memoryAnchors(root.qualified);
      if (memories.length > 0) {
        sections.push('## Linked memories', ...memories.map((m) => `- \`${m.id}\` (${m.type}): ${m.title}`));
      }
    }

    if (sections.length === 0) {
      return { text: `No callers, subtypes, importers, or linked memories found for \`${root.qualified}\`.` };
    }

    const lines = [
      `Change impact for \`${root.qualified}\`:`,
      '',
      ...sections,
      '',
      '_Syntactic analysis: dynamic dispatch and reflection are invisible; fuzzy edges marked (~)._',
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async whoTests(input: CodeToolInput<'who_tests'>): Promise<ToolResult> {
    const resolved = await this.resolveSymbol(input.symbol, input.path);
    if (isAmbiguous(resolved)) return renderAmbiguous(resolved.candidates);
    if (resolved.length === 0) {
      return { text: `No symbol found matching "${input.symbol}". Try code_search to locate the right name.` };
    }
    const root = resolved[0]!;

    const hits = await this.store.testsReferencing([root.id], { depth: input.depth, includeFuzzy: input.includeFuzzy });
    if (hits.length === 0) {
      return { text: `No tests found exercising \`${root.qualified}\` within ${input.depth} hop(s).` };
    }

    const byFile = new Map<string, typeof hits>();
    for (const hit of hits.slice(0, input.limit)) {
      if (!byFile.has(hit.test.file)) byFile.set(hit.test.file, []);
      byFile.get(hit.test.file)!.push(hit);
    }

    const lines = [`Tests exercising \`${root.qualified}\`:`, ''];
    for (const [file, fileHits] of byFile) {
      lines.push(`## ${file}`);
      for (const hit of fileHits) {
        lines.push(
          `- ${hit.test.qualified} [L${hit.test.startLine}] → reaches \`${hit.target.qualified}\` in ${hit.depth} hop(s)${confidenceMarker(hit.confidence)}`
        );
      }
    }
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async findUntested(input: CodeToolInput<'find_untested'>): Promise<ToolResult> {
    const results = await this.store.untested({
      pathPrefix: input.pathPrefix,
      excludePath: input.excludePath,
      kinds: input.kinds as SymbolRecord['kind'][] | undefined,
      langs: input.langs as SymbolRecord['lang'][] | undefined,
      limit: input.limit,
      offset: input.offset,
    });

    if (results.length === 0) {
      return {
        text: `No untested exported symbols found${input.pathPrefix ? ` under "${input.pathPrefix}"` : ''}${
          input.offset ? ` at offset ${input.offset}` : ''
        }.`,
      };
    }

    const lines = [
      `${results.length} untested exported symbol(s)${input.offset ? ` (offset ${input.offset})` : ''} ` +
        `(direct test references only — syntactic, table-driven/reflective tests may not register):`,
      '',
      ...renderGroupedByFile(results, (s) => `${s.qualified}${s.signature ?? ''} ·${s.kind}`),
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async dependencyCycle(input: CodeToolInput<'dependency_cycle'>): Promise<ToolResult> {
    const cycles = await this.store.findCycles({
      pathPrefix: input.pathPrefix,
      limit: input.limit,
    });

    if (cycles.length === 0) {
      return {
        text: `No circular import dependencies found${input.pathPrefix ? ` under "${input.pathPrefix}"` : ''}.`,
      };
    }

    const lines = [
      `Found ${cycles.length} circular import dependenc${cycles.length === 1 ? 'y' : 'ies'}:`,
      '',
      ...cycles.map(
        (comp, i) =>
          `**Cycle ${i + 1}** (${comp.length} files):\n${comp.map((p) => `  - ${p}`).join('\n')}`
      ),
      '',
      '_Syntactic analysis: only resolves relative imports; bare package/module imports are invisible._',
    ];
    return applyBudget(lines, this.contextTokenBudget);
  }

  private async indexStatus(): Promise<ToolResult> {
    const stats = await this.store.stats();
    const lines = [`Index: ${stats.files} file(s), ${stats.symbols} symbol(s), ${stats.edges} edge(s).`];

    const freshness = await this.getFreshness?.().catch(() => null);
    if (freshness) {
      lines.push(freshnessFooter(freshness));
    } else {
      lines.push('_Generation tracking unavailable for this session — freshness cannot be reported._');
    }

    if (stats.pendingRefs > 0) lines.push(`${stats.pendingRefs} unresolved reference(s) pending.`);
    if (stats.pendingEmbeddings > 0) lines.push(`${stats.pendingEmbeddings} symbol(s) awaiting embeddings.`);

    return { text: lines.join('\n') };
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers — the response-format contract (see codeToolSchemas doc)
// ---------------------------------------------------------------------------

/** `AuthService.login(user: User) → Promise<Session>  [src/auth/service.ts:42-67]` */
export function renderSymbol(s: SymbolRecord): string {
  const sig = s.signature ? `${s.signature}` : '';
  return `${s.qualified}${sig}  [${s.file}:${s.startLine}-${s.endLine}]`;
}

/** Markers agents rely on: fuzzy edges are explicitly unverified. */
export function confidenceMarker(c: EdgeConfidence): string {
  return c === 'fuzzy' ? ' _(~ name match — verify)_' : '';
}

export function renderCallTree(nodes: CallTreeNode[], indent = 0): string[] {
  const lines: string[] = [];
  for (const n of nodes) {
    lines.push(`${'  '.repeat(indent)}- ${renderSymbol(n.symbol)} L${n.line}${confidenceMarker(n.confidence)}`);
    lines.push(...renderCallTree(n.children, indent + 1));
  }
  return lines;
}

export function renderAmbiguous(candidates: SymbolRecord[]): ToolResult {
  const lines = [
    `Multiple symbols match — re-call with one of these qualified names (or pass \`path\` to disambiguate):`,
    ...candidates.map((s) => `- \`${s.qualified}\` ${renderSymbol(s)} ·${s.kind}`),
  ];
  return { text: lines.join('\n') };
}

export function renderTypeRelations(rels: TypeRelation[]): string[] {
  return rels.map(
    (r) =>
      `- ${renderSymbol(r.symbol)} ·${r.symbol.kind} — ${r.kind}${r.depth > 1 ? ` (depth ${r.depth})` : ''}${confidenceMarker(r.confidence)}`
  );
}

/**
 * Group symbol results by file and render each group under a `## <file>`
 * header with just `:start-end` per item (no repeat of the full path).
 * `renderLine(s)` should return the line body (qualified name + signature +
 * any metadata tags); the helper adds the dash prefix and `:range` suffix.
 * Modeled on the existing who_tests grouping pattern.
 */
function renderGroupedByFile(symbols: SymbolRecord[], renderLine: (s: SymbolRecord) => string): string[] {
  const byFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file)!.push(s);
  }

  const lines: string[] = [];
  for (const [file, syms] of byFile) {
    lines.push(`## ${file}`);
    for (const s of syms) {
      lines.push(`- ${renderLine(s)}  :${s.startLine}-${s.endLine}`);
    }
  }
  return lines;
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? text : `${text.slice(0, nl)}…`;
}

function isAmbiguous(x: SymbolRecord[] | { ambiguous: true; candidates: SymbolRecord[] }): x is {
  ambiguous: true;
  candidates: SymbolRecord[];
} {
  return !Array.isArray(x);
}

