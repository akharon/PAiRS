/**
 * Pass 1: source text → FileExtraction (symbols + unresolved refs + uses).
 *
 * Adapted from vendor/reference-indexer/src/index/extractors.ts, trimmed to
 * v1 scope: the complexity walk (cyclomatic/cognitive) and FTS name-splitting
 * are dropped — no PAiRS tool consumes them (subsystem_indexer_spec.md has no
 * complexity metric; hotspots ranks by CALLS fan-out, computed by the store,
 * not here). One implementation over all 12 languages the reference project
 * shipped grammars for — everything language-specific lives in the query
 * file, not here. v1's *precision contract* (unresolved_ratio ≤ 10%,
 * benchmarks) validates Rust only (types.ts V1_VALIDATED_LANGS); the other
 * 11 languages parse and populate the graph unmeasured. Adding a language
 * means a new `.scm` file plus (if it needs PAiRS's refined edge vocabulary
 * rather than the generic one) an entry in extractorImpl.ts's ref-kind map,
 * not new extraction logic.
 *
 * ## .scm capture-name contract (queries/<lang>.scm)
 *
 * Symbol captures — `@def.<kind>` marks the whole declaration node; within
 * the same pattern, companion captures refine it:
 *   @def.function @def.method @def.class @def.struct @def.interface
 *   @def.enum @def.field @def.var @def.macro
 *   @name       (required) identifier node of the declared name
 *   @params     (optional) parameter list node → SymbolRecord.signature
 *   @ret        (optional) return-type node, appended to signature
 *   @doc        (optional) leading comment node → SymbolRecord.doc
 *   @exported   (optional) presence marks the symbol exported/public
 *
 * Scope captures — a construct that names a qualifier segment but declares no
 * symbol of its own (Rust's `impl Greeter` block, whose symbol is the
 * separately-captured struct_item). Descendants qualify through it; it never
 * appears in `symbols` and never becomes a `parentIndex`:
 *   @scope       the whole scoping node
 *   @scope.name  identifier node supplying the qualifier segment
 *
 * Reference captures:
 *   @ref.call        callee identifier of a call/invocation expression
 *   @ref.extends     superclass name in an inheritance clause
 *   @ref.implements  interface/trait name in an implements/impl clause
 *   @ref.reference   other identifier uses worth graphing (type annotations,
 *                     macro invocations)
 *
 * Import captures:
 *   @import.specifier   module path / `use` path / header / package string
 *   @import.bound        (optional, repeatable) locally-bound name nodes
 *
 * Rules the extractor enforces:
 *  - Containment: a def whose node range encloses another def's range is its
 *    parent → NewSymbol.parentIndex (range stack, single pass over defs
 *    sorted by start byte).
 *  - `qualified` = join(ancestor names + own name) with the language's
 *    separator: '.' (python/java/js/ts), '::' (c/cpp/rust).
 *  - Refs get fromIndex = innermost enclosing def, else the implicit
 *    module symbol (extractor synthesizes one 'module' NewSymbol per file,
 *    spanning the whole file, as symbols[0]).
 *  - Local variables are NOT symbols (v1): queries only capture module/
 *    class/impl/trait-scope declarations, keeping the index small and useful.
 */

import type { LoadedLanguage } from './parserRegistry';
import type { FileExtraction } from './types';

export interface Extractor {
  /**
   * Parse `source` and extract. Never throws on syntax errors — tree-sitter
   * produces partial trees; extract what parsed and skip ERROR subtrees
   * (caller marks the file `parseError: true` when `tree.rootNode.hasError`).
   * @param path workspace-relative path (stored on the extraction)
   * @param stat mtimeMs/size from fs.stat; hash computed here (sha1 of source)
   */
  extract(loaded: LoadedLanguage, path: string, source: string, stat: { mtimeMs: number; size: number }, crate: string | null): FileExtraction;
}
