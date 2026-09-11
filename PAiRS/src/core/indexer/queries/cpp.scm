; C++ extraction query. Capture-name contract: see ../extractors.ts.
; Also parses C headers (.h routes to 'cpp' — see parserRegistry.EXT_TO_LANG),
; so this grammar must stay a superset-compatible with plain C constructs.

(
  (comment)? @doc
  .
  (function_definition
    declarator: (function_declarator
      declarator: [(identifier) @name
                   (field_identifier) @name
                   (qualified_identifier name: (identifier) @name)]
      parameters: (parameter_list) @params)) @def.function
)

(
  (comment)? @doc
  .
  (class_specifier
    name: (type_identifier) @name
    (base_class_clause (type_identifier) @ref.extends)?) @def.class
)

(
  (comment)? @doc
  .
  (struct_specifier
    name: (type_identifier) @name
    (base_class_clause (type_identifier) @ref.extends)?) @def.struct
)

(
  (comment)? @doc
  .
  (enum_specifier
    name: (type_identifier) @name) @def.enum
)

(preproc_def name: (identifier) @name) @def.macro
(preproc_function_def name: (identifier) @name) @def.macro

; --- calls -----------------------------------------------------------------------
(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (qualified_identifier name: (identifier) @ref.call))

; --- includes -----------------------------------------------------------------------
(preproc_include path: (string_literal) @import.specifier)
(preproc_include path: (system_lib_string) @import.specifier)
