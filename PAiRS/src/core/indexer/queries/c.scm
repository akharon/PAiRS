; C extraction query. Capture-name contract: see ../extractors.ts.
; C has no export keyword: `exported` is a static/non-static heuristic
; applied by the extractor (non-`static` top-level function/var = exported),
; not captured here.

(
  (comment)? @doc
  .
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @name
      parameters: (parameter_list) @params)) @def.function
)

(
  (comment)? @doc
  .
  (struct_specifier
    name: (type_identifier) @name) @def.struct
)

(
  (comment)? @doc
  .
  (enum_specifier
    name: (type_identifier) @name) @def.enum
)

(preproc_def
  name: (identifier) @name) @def.macro

(preproc_function_def
  name: (identifier) @name) @def.macro

; --- calls -----------------------------------------------------------------------
(call_expression function: (identifier) @ref.call)

; --- includes -----------------------------------------------------------------------
(preproc_include path: (string_literal) @import.specifier)
(preproc_include path: (system_lib_string) @import.specifier)
