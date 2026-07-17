/**
 * Pass 1: source text → FileExtraction (symbols + unresolved refs + imports).
 *
 * One implementation over all languages: parse with the language's grammar,
 * run its compiled .scm query, and fold captures into records. Everything
 * language-specific lives in the query file — adding a language must not
 * require new TypeScript.
 *
 * ## .scm capture-name contract (src/index/queries/<lang>.scm)
 *
 * Symbol captures — `@def.<kind>` marks the whole declaration node; within
 * the same pattern, companion captures refine it:
 *   @def.function @def.method @def.class @def.struct @def.interface
 *   @def.enum @def.field @def.var @def.macro
 *   @name       (required) identifier node of the declared name
 *   @params     (optional) parameter list node → SymbolRecord.signature
 *   @ret        (optional) return-type node, appended to signature
 *   @doc        (optional) leading comment node → SymbolRecord.doc
 *                (extractor strips comment markers: slashes, block-comment
 *                delimiters, '#', docstring quotes)
 *   @exported   (optional) presence marks the symbol exported/public
 *
 * Reference captures:
 *   @ref.call        callee identifier of a call/invocation expression
 *   @ref.extends     superclass name in an inheritance clause
 *   @ref.implements  interface name in an implements clause
 *   @ref.reference   other identifier uses worth graphing (type annotations)
 *
 * Import captures:
 *   @import.specifier   module path / header / package string node
 *   @import.bound       (optional, repeatable) locally-bound name nodes
 *
 * Rules the extractor enforces (implementation TODOs for each bullet):
 *  - Containment: a def whose node range encloses another def's range is its
 *    parent → NewSymbol.parentIndex (compute via a range stack, single pass
 *    over defs sorted by start byte).
 *  - `qualified` = join(ancestor names + own name) with the language's
 *    separator: '.' (python/java/js/ts), '::' (c/cpp).
 *  - Refs get fromIndex = innermost enclosing def, else the implicit
 *    module symbol (extractor synthesizes one 'module' NewSymbol per file,
 *    spanning the whole file, as symbols[0]).
 *  - Qualified ref names are kept as written ('this.x'/'self.x' stripped to
 *    bare member name; pass 2 handles the rest).
 *  - Local variables are NOT symbols (v1): queries only capture file/class/
 *    namespace-scope declarations, keeping the index small and useful.
 */

import type { LoadedLanguage } from './parserRegistry';
import type { CodeLang, FileExtraction } from './types';

export interface Extractor {
  /**
   * Parse `source` and extract. Never throws on syntax errors — tree-sitter
   * produces partial trees; extract what parsed and skip ERROR subtrees.
   * @param path workspace-relative path (stored on the extraction)
   * @param stat mtimeMs/size from fs.stat; hash computed here (sha1 of source)
   */
  extract(
    loaded: LoadedLanguage,
    path: string,
    source: string,
    stat: { mtimeMs: number; size: number }
  ): FileExtraction;
}

// ---------------------------------------------------------------------------
// Complexity walk (v4) — computed during extract(), one extra subtree walk
// per function/method symbol, no re-parse.
// ---------------------------------------------------------------------------

/**
 * Per-language node-type sets driving the complexity counters. The extractor
 * walks each function/method def's subtree once and consults these sets.
 *
 * Implemented as COMPLEXITY_CONFIG in extractorImpl.ts (all six languages),
 * with node-type strings verified empirically against the installed wasm
 * grammars (parse a fixture, print `tree.rootNode.toString()`). Members per
 * language:
 *  - decisions: if_statement, for/while/do statements, case/when clauses
 *    (count each case, not the switch), catch clause, conditional/ternary
 *    expression, comprehension if-clauses (python: if_clause).
 *  - booleanOperators: node types or operator literals for && || (js/ts/java/
 *    c/cpp: binary_expression with operator '&&'/'||'; python:
 *    boolean_operator with 'and'/'or').
 *  - elseLike: else_clause / elif_clause — cognitive +1 flat, no nesting add.
 *  - nesting: constructs that increase the nesting level for children
 *    (decisions themselves + nested function definitions).
 */
export interface ComplexityNodeSets {
  decisions: ReadonlySet<string>;
  booleanOperators: ReadonlySet<string>;
  elseLike: ReadonlySet<string>;
  nesting: ReadonlySet<string>;
}

/**
 * Split an identifier into lowercase terms for the FTS name_terms column:
 * camelCase, PascalCase, snake_case, kebab-case, digits.
 * 'parseHTTPConfig_v2' → 'parse http config v2'. Shared with the store's FTS
 * writer and codeSearch's exact-name boost, so it lives here.
 */
export function splitIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .trim()
    .toLowerCase();
}
