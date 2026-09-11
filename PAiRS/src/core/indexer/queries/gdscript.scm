; GDScript extraction query. Capture-name contract: see ../extractors.ts.
; GDScript has one class per file (implicit); `class_name_statement` names it
; and `extends_statement` (top-level, not the nested `class_definition` one)
; gives its base type. Nested `class` blocks use `class_definition` instead.
; No static export/visibility syntax (like Python/Ruby) — all defs visible.

(
  (comment)? @doc
  .
  (function_definition
    name: (name) @name
    parameters: (parameters) @params
    return_type: (type)? @ret) @def.function
)

(
  (comment)? @doc
  .
  (class_definition
    name: (name) @name
    extends: (extends_statement (type (identifier) @ref.extends))?) @def.class
)

(
  (comment)? @doc
  .
  (class_name_statement
    name: (name) @name
    extends: (extends_statement (type (identifier) @ref.extends))?) @def.class
)

(
  (comment)? @doc
  .
  (variable_statement
    name: (name) @name
    type: (type)? @ret) @def.field
)

(
  (comment)? @doc
  .
  (const_statement
    name: (name) @name
    type: (type)? @ret) @def.field
)

(
  (comment)? @doc
  .
  (signal_statement
    name: (name) @name
    parameters: (parameters)? @params) @def.field
)

; --- calls -----------------------------------------------------------------------
(call (identifier) @ref.call)
(attribute_call (identifier) @ref.call)

; --- imports -----------------------------------------------------------------------
; `preload("res://...")` / `load("res://...")` are GDScript's module references —
; no static import syntax exists, so these calls double as @import.specifier.
(call
  (identifier) @_fn
  (#any-of? @_fn "preload" "load")
  (arguments (string) @import.specifier))
