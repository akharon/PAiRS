# Tree-sitter extraction queries

One `<lang>.scm` per indexed language: `c.scm`, `cpp.scm`, `python.scm`,
`javascript.scm`, `typescript.scm`, `java.scm`, `go.scm`, `ruby.scm`,
`dart.scm`, `rust.scm`, `css.scm`, `html.scm`. Bundled as text by esbuild
(add a `.scm` text loader in esbuild.mjs) and compiled per-language by
ParserRegistry.load().

The capture-name contract (`@def.*`, `@name`, `@ref.*`, `@import.*`, …) is
documented in `../extractors.ts` — the extractor is language-agnostic; ALL
language knowledge lives in these files.

Example shape (python.scm):

```scm
(function_definition
  name: (identifier) @name
  parameters: (parameters) @params) @def.function

(class_definition
  name: (identifier) @name
  superclasses: (argument_list (identifier) @ref.extends)?) @def.class

(call
  function: [(identifier) @ref.call
             (attribute attribute: (identifier) @ref.call)])

(import_from_statement
  module_name: (dotted_name) @import.specifier
  name: (dotted_name) @import.bound)
```

Node-type references while writing these: each grammar repo's
`src/node-types.json`, or interactively at https://tree-sitter.github.io/tree-sitter/playground.
Validate with the per-language fixture tests (see extractors.test.ts plan in
docs/ArchSpec.md — one small real-world source file per language,
asserting the exact FileExtraction).

**Never guess node-type names** — they differ per grammar and silently
capture nothing when wrong. Verify empirically: parse a fixture with the
installed wasm grammar and print `tree.rootNode.toString()`.

## Language-specific gotchas

- **Go**: exports are capitalization-based (no keyword), expressed via
  `(#match? @name "^[A-Z]")` predicates. Predicates must sit INSIDE the
  parenthesized pattern they constrain — placing one after the closing paren
  silently fails to filter (verified empirically against this grammar's
  query engine). No `implements` clause exists; interface satisfaction is
  structural and invisible to syntactic analysis.
- **Ruby**: no static export/visibility syntax node (`private`/`protected`
  are plain method calls, not modifiers), and no static type annotations —
  same v1 approach as `python.scm`: all defs are visible, no `@ret` capture.
- **Dart**: a method/function's signature and body are separate SIBLING
  nodes (`method_signature`/`function_signature` then a following
  `function_body`), not one node containing the other like every other
  language here. `@def.*` captures only the signature; `extractorImpl.ts`
  has a small Dart-only step that extends the range through the sibling
  body for `endLine`/complexity (see `PendingDef.bodyNode` there). Call
  expressions also have no dedicated node type — `foo()` parses as flat
  siblings `(identifier) (selector (argument_part ...))`.
- **Rust**: impl-block methods qualify bare (`get`, not `Greeter::get`) since
  the `impl` block itself is not a captured symbol (v1 limitation). Trait
  method signatures with no body are captured as `@def.method` too, from
  `function_signature_item`.
- **General gotcha (Dart/Rust specifically hit this)**: a pattern anchored to
  a specific parent node (needed so a def type occurring at two nesting
  depths — e.g. a bare top-level function vs. the same node type nested
  inside a class/impl body — isn't captured twice) CANNOT also use `.`
  sibling-adjacency for an optional preceding doc-comment: this query engine
  only matches the first child at an anchored position and silently drops
  every later sibling. Verified empirically (a 3-method impl block only
  matched method 1). When both properties are needed, this codebase drops
  the `@doc` capture for that specific pattern rather than risk dropped
  symbols — dropped symbols are silent data loss, a missing doc string is
  not.
- **CSS/HTML**: neither language has functions, classes, or control flow, so
  they don't fit the def/complexity model the same way as the other eight
  languages. CSS rule sets (`.selector { ... }`) are captured as
  `@def.class` named after their full selector text; there is no
  containment even for rule sets nested inside `@media` (the grammar still
  parses them as sibling `rule_set` nodes). HTML elements are only captured
  when they carry an `id` attribute (`@def.field`, named after the id
  value, not the tag name — ids are the only stable handle into a
  document). Both have empty `COMPLEXITY_CONFIG` entries in
  `extractorImpl.ts` (flat complexity of 1, no decisions/nesting/nested
  defs). `<link href=...>` and `<script src=...>` map to
  `@import.specifier`; note `<script>` is a distinct `script_element` node
  type in this grammar, not `element`.
