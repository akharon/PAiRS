; Rust extraction query. Capture-name contract: see ../extractors.ts.
; NOTE: impl-block methods qualify bare (`get`, not `Greeter::get`) since the
; `impl` block itself is not a captured symbol — accepted v1 limitation. Do
; NOT add a @def.class for impl_item; it would duplicate the struct_item
; symbol already captured separately.

; top-level functions only: anchored under source_file so this pattern does
; not also match function_item inside an impl_item/trait_item body (those
; are captured separately below as @def.method). NOTE: no @doc here —
; parent-anchoring (needed to prevent duplicate matches against nested
; impl/trait methods) is incompatible with the sibling-adjacency `.` needed
; for correct doc-comment attachment in this tree-sitter query engine
; (verified empirically: combining both either drops later siblings or lets
; a doc comment leak onto every later sibling, not just the next one) — v1
; accepts no doc capture for top-level Rust functions specifically.
(source_file
  (function_item
    (visibility_modifier)? @exported
    name: (identifier) @name
    parameters: (parameters) @params
    return_type: (_)? @ret) @def.function
)

; impl-block methods (with body). NOTE: no @doc — see the top-level
; @def.function pattern's comment above for why parent-anchoring (required
; here so these function_item nodes aren't ALSO matched by the top-level
; @def.function pattern) can't be combined with `.` sibling-adjacency: this
; query engine only matches the FIRST child at a given anchored position and
; silently drops later siblings (verified empirically — m2/m3 in a 3-method
; impl block were dropped when this pattern used the parent+`.` form).
(impl_item
  body: (declaration_list
    (function_item
      (visibility_modifier)? @exported
      name: (identifier) @name
      parameters: (parameters) @params
      return_type: (_)? @ret) @def.method))

; trait method signatures (no body) — captured so find_implementations /
; get_declaration can see the trait surface. No @doc, same reason as above.
(trait_item
  body: (declaration_list
    (function_signature_item
      name: (identifier) @name
      parameters: (parameters) @params
      return_type: (_)? @ret) @def.method))

(
  (line_comment)? @doc
  .
  (struct_item
    (visibility_modifier)? @exported
    name: (type_identifier) @name) @def.struct
)

(
  (line_comment)? @doc
  .
  (enum_item
    (visibility_modifier)? @exported
    name: (type_identifier) @name) @def.enum
)

(
  (line_comment)? @doc
  .
  (trait_item
    (visibility_modifier)? @exported
    name: (type_identifier) @name
    bounds: (trait_bounds (type_identifier) @ref.extends)?) @def.interface
)

(
  (line_comment)? @doc
  .
  (const_item
    (visibility_modifier)? @exported
    name: (identifier) @name
    type: (_)? @ret) @def.var
)

; --- implements ------------------------------------------------------------------
(impl_item trait: (type_identifier) @ref.implements type: (type_identifier))

; --- calls -----------------------------------------------------------------------
(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (scoped_identifier name: (identifier) @ref.call))
(macro_invocation macro: (identifier) @ref.reference)

; --- imports -----------------------------------------------------------------------
(use_declaration argument: (_) @import.specifier)
