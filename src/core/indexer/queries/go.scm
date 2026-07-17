; Go extraction query. Capture-name contract: see ../extractors.ts.
; NOTE: Go has no explicit interface-implements clause — interface
; satisfaction is structural and invisible to syntactic analysis, so
; @ref.implements is never emitted here.
; Exports are capitalization-based (not a keyword), expressed via #match?.
; NOTE: predicates must live INSIDE the parenthesized pattern they constrain
; (before the closing paren that carries the outer @def.* capture) — placing
; a predicate after the pattern silently fails to filter (verified empirically).

(
  (comment)? @doc
  .
  (function_declaration
    name: (identifier) @name
    parameters: (parameter_list) @params
    result: (_)? @ret
    (#match? @name "^[A-Z]")) @def.function
) @exported

(
  (comment)? @doc
  .
  (function_declaration
    name: (identifier) @name
    parameters: (parameter_list) @params
    result: (_)? @ret
    (#not-match? @name "^[A-Z]")) @def.function
)

(
  (comment)? @doc
  .
  (method_declaration
    name: (field_identifier) @name
    parameters: (parameter_list) @params
    result: (_)? @ret
    (#match? @name "^[A-Z]")) @def.method
) @exported

(
  (comment)? @doc
  .
  (method_declaration
    name: (field_identifier) @name
    parameters: (parameter_list) @params
    result: (_)? @ret
    (#not-match? @name "^[A-Z]")) @def.method
)

(
  (comment)? @doc
  .
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (struct_type))
    (#match? @name "^[A-Z]")) @def.struct
) @exported

(
  (comment)? @doc
  .
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (struct_type))
    (#not-match? @name "^[A-Z]")) @def.struct
)

(
  (comment)? @doc
  .
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (interface_type))
    (#match? @name "^[A-Z]")) @def.interface
) @exported

(
  (comment)? @doc
  .
  (type_declaration
    (type_spec
      name: (type_identifier) @name
      type: (interface_type))
    (#not-match? @name "^[A-Z]")) @def.interface
)

(
  (var_declaration
    (var_spec name: (identifier) @name)
    (#match? @name "^[A-Z]")) @def.var
) @exported

(
  (var_declaration
    (var_spec name: (identifier) @name)
    (#not-match? @name "^[A-Z]"))
) @def.var

(
  (const_declaration
    (const_spec name: (identifier) @name)
    (#match? @name "^[A-Z]")) @def.var
) @exported

(
  (const_declaration
    (const_spec name: (identifier) @name)
    (#not-match? @name "^[A-Z]"))
) @def.var

; --- calls -------------------------------------------------------------------
(call_expression function: (identifier) @ref.call)
(call_expression function: (selector_expression field: (field_identifier) @ref.call))

; --- imports -------------------------------------------------------------------
(import_spec path: (interpreted_string_literal) @import.specifier)
