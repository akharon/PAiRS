; CSS extraction query. Capture-name contract: see ../extractors.ts.
; CSS has no functions/classes/control-flow in the programming-language
; sense, so this query maps the closest structural analogue: each rule set
; (selector list + declaration block) becomes a `@def.class` symbol named
; after its full selector text (e.g. ".foo", "#bar, .baz", ":root"). There is
; no containment between rule sets (even ones nested inside `@media`, since
; the grammar still parses them as sibling `rule_set` nodes at the same
; query-match level) — every rule set is a flat top-level symbol; `@media`
; itself is not captured. No @ref.call/@ref.extends/@ref.implements apply.
; `@import` (both the `url(...)` and bare-string forms) is captured as
; @import.specifier so cross-file references still show up in the graph.

(
  (comment)? @doc
  .
  (rule_set
    (selectors) @name) @def.class
)

(import_statement (call_expression (arguments (string_value) @import.specifier)))
(import_statement (string_value) @import.specifier)
