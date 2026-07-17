; TypeScript extraction query (also parses .tsx via the typescript grammar).
; Capture-name contract: see ../extractors.ts. Superset of javascript.scm plus
; type-only constructs (interface, type alias, implements, return types).

(
  (comment)? @doc
  .
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params
    return_type: (type_annotation)? @ret) @def.function
)

(
  (comment)? @doc
  .
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function parameters: (formal_parameters) @params return_type: (type_annotation)? @ret)
            (function_expression parameters: (formal_parameters) @params return_type: (type_annotation)? @ret)]) @def.function
)

(
  (comment)? @doc
  .
  (class_declaration
    name: (type_identifier) @name
    (class_heritage
      (extends_clause value: (identifier) @ref.extends)?
      (implements_clause (type_identifier) @ref.implements)?)?) @def.class
)

(
  (comment)? @doc
  .
  (interface_declaration
    name: (type_identifier) @name
    (extends_type_clause (type_identifier) @ref.extends)?) @def.interface
)

(
  (comment)? @doc
  .
  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params
    return_type: (type_annotation)? @ret) @def.method
)

(
  (comment)? @doc
  .
  (public_field_definition
    name: (property_identifier) @name
    type: (type_annotation)? @ret) @def.field
)

(
  (comment)? @doc
  .
  (enum_declaration
    name: (identifier) @name) @def.enum
)

(
  (comment)? @doc
  .
  (type_alias_declaration
    name: (type_identifier) @name) @def.interface
)

; --- exports -------------------------------------------------------------------
(export_statement (function_declaration name: (identifier) @exported))
(export_statement (class_declaration name: (type_identifier) @exported))
(export_statement (interface_declaration name: (type_identifier) @exported))
(export_statement (type_alias_declaration name: (type_identifier) @exported))
(export_statement (variable_declaration (variable_declarator name: (identifier) @exported)))
(export_statement "default" (identifier) @exported)

; --- calls -----------------------------------------------------------------------
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))

; --- type references (extends/implements outside class_heritage shape above) -----
(extends_type_clause (type_identifier) @ref.extends)
(implements_clause (type_identifier) @ref.implements)

; --- structural type annotations (const x: Interface = {...}) — treated as implicit
;     implements since TypeScript's structural typing means the object literal `x`
;     satisfies Interface regardless of whether Interface is an interface or type alias.
;     Only matches when the value is an object literal (not a new expression, call, or
;     uninitialized declaration), keeping the index focused on meaningful relationships.
(variable_declarator
  name: (identifier)
  type: (type_annotation (type_identifier) @ref.implements)
  value: (object))

; --- imports -----------------------------------------------------------------------
(import_statement source: (string) @import.specifier)
(import_specifier name: (identifier) @import.bound)
(namespace_import (identifier) @import.bound)
(import_clause (identifier) @import.bound)

; --- re-exports (export ... from) ------------------------------------------------
(export_statement source: (string) @import.specifier)
