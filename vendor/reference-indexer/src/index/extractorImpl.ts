/**
 * Extractor implementation: runs a language's compiled query over a parsed
 * tree and folds captures into a FileExtraction. See extractors.ts for the
 * capture-name contract this depends on.
 */

import * as crypto from 'node:crypto';
import type { Node, QueryCapture, QueryMatch } from 'web-tree-sitter';
import type { LoadedLanguage } from './parserRegistry';
import { splitIdentifier, type Extractor } from './extractors';
import type { CodeLang, EdgeKind, FileExtraction, NewSymbol, RawImport, RawRef, SymbolKind } from './types';

const QUALIFIER_SEP: Readonly<Record<CodeLang, string>> = {
  c: '::',
  cpp: '::',
  python: '.',
  javascript: '.',
  typescript: '.',
  java: '.',
  go: '.',
  ruby: '.',
  dart: '.',
  rust: '::',
  css: '.',
  html: '.',
};

const DEF_CAPTURE_TO_KIND: Readonly<Record<string, SymbolKind>> = {
  'def.function': 'function',
  'def.method': 'method',
  'def.class': 'class',
  'def.struct': 'struct',
  'def.interface': 'interface',
  'def.enum': 'enum',
  'def.field': 'field',
  'def.var': 'var',
  'def.macro': 'macro',
  'def.module': 'module',
};

const REF_CAPTURE_TO_KIND: Readonly<Record<string, EdgeKind>> = {
  'ref.call': 'calls',
  'ref.extends': 'extends',
  'ref.implements': 'implements',
  'ref.reference': 'references',
};

interface PendingDef {
  node: Node;
  name: string;
  kind: SymbolKind;
  paramsText: string | null;
  retText: string | null;
  docText: string | null;
  exported: boolean;
  /**
   * Dart only: the grammar emits a method/function's signature and body as
   * separate sibling nodes (see queries/dart.scm header), so `node` above
   * covers only the signature. When present, `bodyNode` is the sibling
   * `function_body` — used to compute the real endLine and to walk for
   * complexity, without changing what `node` means for every other
   * language (containment/qualified-name still key off `node`'s range).
   */
  bodyNode?: Node;
}

function stripCommentMarkers(text: string): string {
  return text
    .replace(/^\/\*\*?|\*\/$/g, '')
    .replace(/^\/\/+/, '')
    .replace(/^#+/, '')
    .replace(/^["']{3}|["']{3}$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .join('\n')
    .trim();
}

function buildSignature(paramsText: string | null, retText: string | null): string | null {
  if (!paramsText && !retText) return null;
  const params = paramsText ?? '()';
  return retText ? `${params}${retText}` : params;
}

/**
 * Effective end index/position of a def, extending through `bodyNode` when
 * set (Dart's signature+body sibling split — see PendingDef.bodyNode).
 * Every other language has `bodyNode` undefined and this is just `node`'s
 * own end.
 */
function defEndIndex(def: PendingDef): number {
  return (def.bodyNode ?? def.node).endIndex;
}
function defEndPosition(def: PendingDef): { row: number; column: number } {
  return (def.bodyNode ?? def.node).endPosition;
}

/** Bare final segment of a possibly-qualified reference name (`this.x` → `x`). */
function bareRefName(name: string): string {
  const cleaned = name.replace(/^(this|self|cls)\./, '');
  const parts = cleaned.split(/\.|::/);
  return parts[parts.length - 1] ?? cleaned;
}

// ---------------------------------------------------------------------------
// Complexity walk (extractors.ts "Complexity walk" contract). Node-type names
// verified empirically against the installed tree-sitter-wasms grammars (see
// docs/ArchSpec.md indexer notes — never guess these, they silently
// count 0 when wrong).
// ---------------------------------------------------------------------------

interface ComplexityConfig {
  /** Statement/expression kinds that are decision points. */
  decisions: ReadonlySet<string>;
  /** Node type carrying short-circuit boolean operators, with its operator field name. */
  booleanOpNode: string;
  /** Plain (non-elif/non-else-if) else-branch node type, flat +1 cognitive, no cyclomatic. */
  elseLike: ReadonlySet<string>;
  /** Constructs that increase nesting depth for their children. */
  nesting: ReadonlySet<string>;
  /** Node types marking a nested function/method (their own def owns their complexity). */
  nestedDefs: ReadonlySet<string>;
  /** Case-label node type name (per-case decision, `default` excluded — see hasCaseValue). */
  caseLabel: string | null;
  /** True if `node` (a caseLabel node) represents an actual case, not `default`. */
  hasCaseValue: (node: Node) => boolean;
  /** True if `node` (an if_statement) has a bare `else` (not `else if`) — Java has no elseLike node type for this. */
  hasBareElse?: (node: Node) => boolean;
}

const JS_TS_SHARED: Omit<ComplexityConfig, 'caseLabel' | 'hasCaseValue'> = {
  decisions: new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'catch_clause',
    'ternary_expression',
  ]),
  booleanOpNode: 'binary_expression',
  elseLike: new Set(['else_clause']),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'catch_clause',
  ]),
  nestedDefs: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration']),
};

const COMPLEXITY_CONFIG: Readonly<Record<CodeLang, ComplexityConfig>> = {
  javascript: {
    ...JS_TS_SHARED,
    caseLabel: 'switch_case',
    hasCaseValue: () => true, // switch_default is a distinct node type in js/ts, so switch_case is always a real case
  },
  typescript: {
    ...JS_TS_SHARED,
    caseLabel: 'switch_case',
    hasCaseValue: () => true,
  },
  python: {
    decisions: new Set([
      'if_statement',
      'elif_clause',
      'for_statement',
      'while_statement',
      'except_clause',
      'conditional_expression',
      'if_clause', // comprehension filter
    ]),
    booleanOpNode: 'boolean_operator',
    elseLike: new Set(['else_clause']),
    nesting: new Set(['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause']),
    nestedDefs: new Set(['function_definition', 'lambda']),
    caseLabel: null,
    hasCaseValue: () => true,
  },
  java: {
    decisions: new Set([
      'if_statement',
      'for_statement',
      'enhanced_for_statement',
      'while_statement',
      'do_statement',
      'switch_label',
      'catch_clause',
      'ternary_expression',
    ]),
    booleanOpNode: 'binary_expression',
    elseLike: new Set(), // Java's plain else has no distinct node — see hasBareElse
    nesting: new Set([
      'if_statement',
      'for_statement',
      'enhanced_for_statement',
      'while_statement',
      'do_statement',
      'switch_expression',
      'switch_statement',
      'catch_clause',
    ]),
    nestedDefs: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
    caseLabel: 'switch_label',
    hasCaseValue: (node) => node.namedChildCount > 0,
    hasBareElse: (node) => {
      const alt = node.childForFieldName('alternative');
      return !!alt && alt.type !== 'if_statement';
    },
  },
  c: {
    decisions: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement', 'conditional_expression']),
    booleanOpNode: 'binary_expression',
    elseLike: new Set(['else_clause']),
    nesting: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement']),
    nestedDefs: new Set(['function_definition']),
    caseLabel: 'case_statement',
    hasCaseValue: (node) => node.childForFieldName('value') !== null,
  },
  cpp: {
    decisions: new Set([
      'if_statement',
      'for_statement',
      'for_range_loop',
      'while_statement',
      'do_statement',
      'case_statement',
      'catch_clause',
      'conditional_expression',
    ]),
    booleanOpNode: 'binary_expression',
    elseLike: new Set(['else_clause']),
    nesting: new Set(['if_statement', 'for_statement', 'for_range_loop', 'while_statement', 'do_statement', 'switch_statement', 'catch_clause']),
    nestedDefs: new Set(['function_definition', 'lambda_expression']),
    caseLabel: 'case_statement',
    hasCaseValue: (node) => node.childForFieldName('value') !== null,
  },
  go: {
    // Go's `default_case` is a distinct node type in all three switch forms
    // (expression/type/communication), so every case node here is a real
    // case — no hasCaseValue gymnastics, caseLabel stays null.
    decisions: new Set(['if_statement', 'for_statement', 'expression_case', 'type_case', 'communication_case']),
    booleanOpNode: 'binary_expression',
    // Go's bare `else` is `alternative: (block)` on if_statement, while
    // `else if` is `alternative: (if_statement)` — no distinct elseLike node
    // type, so this reuses Java's hasBareElse hook instead.
    elseLike: new Set(),
    nesting: new Set(['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement']),
    nestedDefs: new Set(['function_declaration', 'method_declaration', 'func_literal']),
    caseLabel: null,
    hasCaseValue: () => true,
    hasBareElse: (node) => {
      const alt = node.childForFieldName('alternative');
      return !!alt && alt.type !== 'if_statement';
    },
  },
  ruby: {
    // Wildcard `_` `when` arms count as a decision like any other (v1
    // acceptable simplification, mirrors Rust's match_arm treatment).
    decisions: new Set(['if', 'elsif', 'for', 'while', 'until', 'when', 'rescue', 'conditional']),
    booleanOpNode: 'binary',
    elseLike: new Set(['else']),
    nesting: new Set(['if', 'elsif', 'for', 'while', 'until', 'case', 'begin']),
    nestedDefs: new Set(['method', 'singleton_method', 'lambda', 'block']),
    caseLabel: null,
    hasCaseValue: () => true,
  },
  dart: {
    // Dart splits && / || into distinct node types with no shared 'operator'
    // field (unlike every other language here, where both share one
    // binary_expression node + an operator field) — so both are counted as
    // ordinary decisions instead of going through the booleanOpNode
    // same-run-collapsing path. This slightly overcounts long chains of the
    // same operator relative to SonarSource's rules; accepted v1 approximation.
    decisions: new Set([
      'if_statement',
      'for_statement',
      'while_statement',
      'do_statement',
      'switch_statement_case',
      'catch_clause',
      'conditional_expression',
      'logical_and_expression',
      'logical_or_expression',
    ]),
    booleanOpNode: '__none__', // no single-field boolean node in this grammar; see decisions above
    elseLike: new Set(),
    nesting: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'try_statement']),
    nestedDefs: new Set(['function_signature']),
    caseLabel: null,
    hasCaseValue: () => true,
    hasBareElse: (node) => {
      const alt = node.childForFieldName('alternative');
      return !!alt && alt.type !== 'if_statement';
    },
  },
  rust: {
    // Wildcard `_` arms are `match_pattern` with no children; counting them
    // as a decision like any other arm is an accepted v1 simplification.
    decisions: new Set(['if_expression', 'match_arm', 'for_expression', 'while_expression', 'loop_expression']),
    booleanOpNode: 'binary_expression',
    elseLike: new Set(['else_clause']),
    nesting: new Set(['if_expression', 'for_expression', 'while_expression', 'loop_expression', 'match_expression']),
    nestedDefs: new Set(['function_item', 'closure_expression']),
    caseLabel: null,
    hasCaseValue: () => true,
  },
  // CSS/HTML are markup/style, not control flow — no decisions, no nesting,
  // no nested defs. Every def gets a flat complexity of 1 (base only).
  css: {
    decisions: new Set(),
    booleanOpNode: '__none__',
    elseLike: new Set(),
    nesting: new Set(),
    nestedDefs: new Set(),
    caseLabel: null,
    hasCaseValue: () => true,
  },
  html: {
    decisions: new Set(),
    booleanOpNode: '__none__',
    elseLike: new Set(),
    nesting: new Set(),
    nestedDefs: new Set(),
    caseLabel: null,
    hasCaseValue: () => true,
  },
};

const BOOLEAN_OPERATORS: ReadonlySet<string> = new Set(['&&', '||', 'and', 'or']);

interface ComplexityCounts {
  complexity: number;
  cognitive: number;
}

/**
 * Walk one function/method def's subtree once, counting cyclomatic and
 * SonarSource-simplified cognitive complexity. Skips subtrees rooted at
 * other collected defs (`innerDefNodeIds`) — a nested function's decisions
 * belong to its own symbol, not the enclosing one.
 */
function countComplexity(lang: CodeLang, defNode: Node, innerDefNodeIds: ReadonlySet<number>, extraRoot?: Node): ComplexityCounts {
  const cfg = COMPLEXITY_CONFIG[lang];
  let cyclomatic = 1;
  let cognitive = 0;

  const walk = (node: Node, depth: number, isRoot: boolean): void => {
    if (!isRoot && innerDefNodeIds.has(node.id)) return; // nested def: counted separately

    const type = node.type;
    let childDepth = depth;

    if (cfg.caseLabel && type === cfg.caseLabel) {
      if (cfg.hasCaseValue(node)) {
        cyclomatic += 1;
        cognitive += 1 + depth;
      }
    } else if (cfg.decisions.has(type)) {
      cyclomatic += 1;
      cognitive += 1 + depth;
    } else if (cfg.elseLike.has(type)) {
      cognitive += 1;
    } else if (type === cfg.booleanOpNode) {
      const op = node.childForFieldName('operator')?.text;
      if (op && BOOLEAN_OPERATORS.has(op)) {
        const parent = node.parent;
        const sameRun = parent?.type === cfg.booleanOpNode && parent.childForFieldName('operator')?.text === op;
        if (!sameRun) {
          cyclomatic += 1;
          cognitive += 1;
        }
      }
    }

    if (type === 'if_statement' && cfg.hasBareElse?.(node)) {
      cognitive += 1;
    }

    if (cfg.nesting.has(type)) childDepth = depth + 1;

    for (const child of node.namedChildren) {
      if (child) walk(child, childDepth, false);
    }
  };

  walk(defNode, 0, true);
  // Dart only: the def node captured is just the signature (see
  // PendingDef.bodyNode); walk the sibling body's subtree too, continuing
  // at depth 0 since the body isn't itself a nesting construct.
  if (extraRoot) walk(extraRoot, 0, true);
  return { complexity: cyclomatic, cognitive };
}

/** Kinds whose subtree gets a real complexity count; everything else is 1/0. */
const COMPLEXITY_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'macro']);

export class ExtractorImpl implements Extractor {
  extract(
    loaded: LoadedLanguage,
    path: string,
    source: string,
    stat: { mtimeMs: number; size: number }
  ): FileExtraction {
    const hash = crypto.createHash('sha1').update(source).digest('hex');
    const tree = loaded.parser.parse(source);
    const extraction: FileExtraction = {
      path,
      lang: loaded.lang,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash,
      symbols: [],
      refs: [],
      imports: [],
    };
    if (!tree) return extraction;

    try {
      const matches = loaded.query.matches(tree.rootNode);
      const defs: PendingDef[] = [];
      const rawRefs: Array<{ node: Node; name: string; kind: EdgeKind }> = [];
      const rawImports: Array<{ specifier: string; bound: string[]; line: number }> = [];
      const standaloneExportedNames = new Set<string>();

      // First pass over captures: collect defs, refs, imports, and exported
      // markers separately (a single QueryMatch may span multiple patterns'
      // captures depending on how the grammar's query engine groups them).
      const importSpecNodeToBound = new Map<number, string[]>();

      for (const match of matches) {
        this.foldMatch(match, defs, rawRefs, rawImports, standaloneExportedNames, importSpecNodeToBound);
      }

      // Attach bound names collected against the same match's import.specifier.
      for (const imp of rawImports) {
        void imp; // bound names are folded in foldMatch directly per-match; see below.
      }

      if (defs.length === 0 && rawRefs.length === 0 && !tree.rootNode.hasError) {
        // No declarations found (e.g. a script with only top-level statements).
      }

      // Synthesize the implicit file/module symbol as symbols[0] so refs
      // made at file scope have somewhere to attach.
      const moduleSymbol: NewSymbol = {
        name: path.split('/').pop() ?? path,
        qualified: path,
        kind: 'module',
        lang: loaded.lang,
        startLine: 1,
        endLine: source.split('\n').length,
        signature: null,
        doc: null,
        exported: true,
        // Module symbols keep the fixed 1/0 baseline; function/method defs
        // below get real counts from countComplexity() over COMPLEXITY_CONFIG.
        complexity: 1,
        cognitive: 0,
        parentIndex: null,
      };
      extraction.symbols.push(moduleSymbol);

      // Sort defs by (start byte asc, end byte desc) so containment can be
      // computed with a simple stack: a def's parent is the nearest
      // still-open enclosing def.
      defs.sort((a, b) => a.node.startIndex - b.node.startIndex || defEndIndex(b) - defEndIndex(a));

      const stack: Array<{ def: PendingDef; index: number }> = [];
      const nodeIdToIndex = new Map<number, number>();
      const allDefNodeIds = new Set(defs.map((d) => d.node.id));

      for (const def of defs) {
        while (stack.length && defEndIndex(stack[stack.length - 1]!.def) <= def.node.startIndex) {
          stack.pop();
        }
        const parentIndex = stack.length ? stack[stack.length - 1]!.index : null;
        const sep = QUALIFIER_SEP[loaded.lang];
        const parentQualified = parentIndex !== null ? extraction.symbols[parentIndex]!.qualified : null;
        const qualified = parentQualified ? `${parentQualified}${sep}${def.name}` : def.name;

        const counts = COMPLEXITY_KINDS.has(def.kind)
          ? countComplexity(loaded.lang, def.node, allDefNodeIds, def.bodyNode)
          : { complexity: 1, cognitive: 0 };

        const symbol: NewSymbol = {
          name: def.name,
          qualified,
          kind: def.kind,
          lang: loaded.lang,
          startLine: def.node.startPosition.row + 1,
          endLine: defEndPosition(def).row + 1,
          signature: buildSignature(def.paramsText, def.retText),
          doc: def.docText ? stripCommentMarkers(def.docText) : null,
          exported: def.exported || standaloneExportedNames.has(def.name),
          complexity: counts.complexity,
          cognitive: counts.cognitive,
          parentIndex,
        };
        const index = extraction.symbols.length;
        extraction.symbols.push(symbol);
        nodeIdToIndex.set(def.node.id, index);
        stack.push({ def, index });
      }

      // Resolve refs to their innermost enclosing def (module symbol = index 0
      // when no def encloses the reference site).
      const defRanges = defs.map((d) => ({ index: nodeIdToIndex.get(d.node.id)!, def: d }));
      for (const ref of rawRefs) {
        let enclosing = 0; // module symbol
        let bestSize = Infinity;
        for (const dr of defRanges) {
          const start = dr.def.node.startIndex;
          const end = defEndIndex(dr.def);
          if (ref.node.startIndex >= start && ref.node.endIndex <= end) {
            const size = end - start;
            if (size < bestSize) {
              bestSize = size;
              enclosing = dr.index;
            }
          }
        }
        extraction.refs.push({
          fromIndex: enclosing,
          name: bareRefName(ref.name),
          kind: ref.kind,
          line: ref.node.startPosition.row + 1,
        });
      }

      for (const imp of rawImports) {
        extraction.imports.push({ specifier: imp.specifier, boundNames: imp.bound, line: imp.line });
      }
    } finally {
      tree.delete();
    }

    return extraction;
  }

  private foldMatch(
    match: QueryMatch,
    defs: PendingDef[],
    rawRefs: Array<{ node: Node; name: string; kind: EdgeKind }>,
    rawImports: Array<{ specifier: string; bound: string[]; line: number }>,
    /** Bare names marked exported by a standalone (non-def-colocated) match. */
    standaloneExportedNames: Set<string>,
    _importSpecNodeToBound: Map<number, string[]>
  ): void {
    const byName = new Map<string, QueryCapture[]>();
    for (const cap of match.captures) {
      if (!byName.has(cap.name)) byName.set(cap.name, []);
      byName.get(cap.name)!.push(cap);
    }

    const defCapture = [...byName.keys()].find((k) => k.startsWith('def.'));
    if (defCapture) {
      const kind = DEF_CAPTURE_TO_KIND[defCapture];
      const nameNode = byName.get('name')?.[0]?.node;
      const defNode = byName.get(defCapture)?.[0]?.node;
      if (kind && nameNode && defNode) {
        // Dart only: signature and body are sibling nodes, not one
        // containing the other (see queries/dart.scm header) — pick up the
        // immediately following function_body, when present, as bodyNode.
        const nextSibling = defNode.nextSibling;
        const bodyNode = nextSibling?.type === 'function_body' ? nextSibling : undefined;
        defs.push({
          node: defNode,
          name: nameNode.text,
          kind,
          paramsText: byName.get('params')?.[0]?.node.text ?? null,
          retText: byName.get('ret')?.[0]?.node.text ?? null,
          docText: byName.get('doc')?.[0]?.node.text ?? null,
          exported: byName.has('exported'),
          bodyNode,
        });
      }
      // A single match can also carry ref.extends/ref.implements captures
      // for the same def (see class_declaration patterns) — fall through.
    }

    for (const [capName, kind] of Object.entries(REF_CAPTURE_TO_KIND)) {
      for (const cap of byName.get(capName) ?? []) {
        rawRefs.push({ node: cap.node, name: cap.node.text, kind });
      }
    }

    const specCap = byName.get('import.specifier')?.[0];
    if (specCap) {
      const bound = (byName.get('import.bound') ?? []).map((c) => c.node.text);
      rawImports.push({
        specifier: specCap.node.text.replace(/^["']|["']$/g, ''),
        bound,
        line: specCap.node.startPosition.row + 1,
      });
    } else if (byName.has('exported') && !defCapture) {
      // Standalone `export function f() {}` / `export { x }` patterns without
      // a co-located def capture: matches across different query patterns
      // are NOT guaranteed to arrive in def-then-export order (verified:
      // tree-sitter orders by pattern index at a given start position, not
      // by node depth), so we can't resolve against `defs` here — collect
      // the name and resolve once all matches are folded (see caller).
      const nameNode = byName.get('exported')![0]!.node;
      standaloneExportedNames.add(nameNode.text);
    }
  }
}

export const extractorImpl = new ExtractorImpl();
export { splitIdentifier };
