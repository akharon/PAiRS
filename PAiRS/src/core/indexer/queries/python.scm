; Python extraction query. Capture-name contract: see ../extractors.ts.
; Doc: Python docstrings are the first statement in a function/class body
; (a bare string expression_statement), not a preceding comment — handled by
; a dedicated pattern rather than the leading-comment convention used
; elsewhere, since tree-sitter-python has no comment-then-def adjacency for
; docstrings.

(
  (comment)? @doc
  .
  (function_definition
    name: (identifier) @name
    parameters: (parameters) @params
    return_type: (type)? @ret) @def.function
)

(function_definition
  body: (block . (expression_statement (string) @doc)))

(
  (comment)? @doc
  .
  (class_definition
    name: (identifier) @name
    superclasses: (argument_list (identifier) @ref.extends)?) @def.class
)

(class_definition
  body: (block . (expression_statement (string) @doc)))

; --- calls -----------------------------------------------------------------------
(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))

; --- decorators (treated as references worth graphing) ----------------------------
(decorator (identifier) @ref.reference)
(decorator (attribute attribute: (identifier) @ref.reference))

; --- imports -----------------------------------------------------------------------
(import_statement name: (dotted_name) @import.specifier)
(import_from_statement module_name: (dotted_name) @import.specifier)
(import_from_statement module_name: (relative_import) @import.specifier)
(aliased_import name: (dotted_name) alias: (identifier) @import.bound)
(import_from_statement name: (dotted_name) @import.bound)
