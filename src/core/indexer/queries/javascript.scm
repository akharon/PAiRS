; JavaScript extraction query. Capture-name contract: see ../extractors.ts.

; --- function declarations -------------------------------------------------
(
  (comment)? @doc
  .
  (function_declaration
    name: (identifier) @name
    parameters: (formal_parameters) @params) @def.function
)

; arrow/function assigned to a top-level or class-field const/let/var
(
  (comment)? @doc
  .
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function parameters: (formal_parameters) @params)
            (function_expression parameters: (formal_parameters) @params)]) @def.function
)

; --- classes -----------------------------------------------------------------
(
  (comment)? @doc
  .
  (class_declaration
    name: (identifier) @name
    (class_heritage (identifier) @ref.extends)?) @def.class
)

; --- methods (inside class_body) ---------------------------------------------
(
  (comment)? @doc
  .
  (method_definition
    name: (property_identifier) @name
    parameters: (formal_parameters) @params) @def.method
)

; --- exports (marks the wrapped declaration as exported) ----------------------
(export_statement
  (function_declaration name: (identifier) @exported))
(export_statement
  (class_declaration name: (identifier) @exported))
(export_statement
  (variable_declaration (variable_declarator name: (identifier) @exported)))
(export_statement "default" (identifier) @exported)

; --- calls ---------------------------------------------------------------------
(call_expression
  function: (identifier) @ref.call)
(call_expression
  function: (member_expression
    property: (property_identifier) @ref.call))

; --- imports ---------------------------------------------------------------------
(import_statement
  source: (string) @import.specifier)
(import_specifier
  name: (identifier) @import.bound)
(namespace_import (identifier) @import.bound)
(import_clause (identifier) @import.bound)

; --- re-exports (export ... from) ------------------------------------------------
(export_statement
  source: (string) @import.specifier)
