; Dart extraction query. Capture-name contract: see ../extractors.ts.
; NOTE: this grammar emits a method/function's signature and its body as two
; separate SIBLING nodes (`(method_signature ...) (function_body ...)`), not
; one node containing the other — unlike every other language here. @def.*
; below spans only the signature; extractorImpl.ts has a small Dart-only
; step (`mergeDartBody`) that extends the captured range through the
; following sibling function_body so endLine/complexity see the real body.
; Do not try to capture both nodes in one pattern — tree-sitter has no
; construct for "match this, then also grab the next sibling" as one node.
;
; NOTE: call expressions have no dedicated node type either — `foo()` parses
; as flat siblings `(identifier) (selector (argument_part ...))`, and
; `foo.bar()` as `(identifier) (selector (unconditional_assignable_selector
; (identifier))) (selector (argument_part ...))`. `this.x()` is not matched
; (v1 gap, mirrors other languages' `this.`-prefixed limitations).

(
  (documentation_comment)? @doc
  .
  (method_signature
    (function_signature
      name: (identifier) @name
      (formal_parameter_list) @params)) @def.method
)

(
  (documentation_comment)? @doc
  .
  (method_signature
    (getter_signature
      name: (identifier) @name)) @def.method
)

(
  (documentation_comment)? @doc
  .
  (method_signature
    (setter_signature
      name: (identifier) @name
      (formal_parameter_list) @params)) @def.method
)

(
  (documentation_comment)? @doc
  .
  (method_signature
    (constructor_signature
      name: (identifier) @name
      parameters: (formal_parameter_list) @params)) @def.method
)

; a body-less constructor (e.g. `Greeter(this.name);`) is wrapped in a plain
; `declaration` node, not `method_signature` (only constructors WITH a body
; get the method_signature wrapper — verified empirically).
(
  (documentation_comment)? @doc
  .
  (declaration
    (constructor_signature
      name: (identifier) @name
      parameters: (formal_parameter_list) @params)) @def.method
)

; a body-less method (abstract method, interface member) is wrapped in a
; plain `declaration` node instead of `method_signature`, same as a
; body-less constructor above.
(
  (documentation_comment)? @doc
  .
  (declaration
    (function_signature
      name: (identifier) @name
      (formal_parameter_list) @params)) @def.method
)

; top-level functions only: anchored under `program` so this pattern does
; not also match the `function_signature` nested inside a class's
; `method_signature` (that shape is captured separately above as @def.method).
; NOTE: no @doc — combining parent-anchoring (required here to avoid
; duplicate-matching nested class methods) with `.` sibling-adjacency (for
; doc-comment attachment) makes this query engine silently drop every
; top-level function after the first one in the file (verified empirically:
; a 2-function fixture only matched the first). v1 accepts no doc capture
; for top-level Dart functions specifically; class methods above are
; unaffected since method_signature/declaration don't recur ambiguously.
(program
  (function_signature
    name: (identifier) @name
    (formal_parameter_list) @params) @def.function)

(
  (documentation_comment)? @doc
  .
  (class_definition
    name: (identifier) @name
    superclass: (superclass (type_identifier) @ref.extends)?
    interfaces: (interfaces (type_identifier) @ref.implements)?) @def.class
)

(
  (documentation_comment)? @doc
  .
  (mixin_declaration
    name: (identifier) @name) @def.class
)

; top-level / class field declarations (not methods): `int x;`, `final y = 1;`
(
  (documentation_comment)? @doc
  .
  (declaration
    (initialized_identifier_list
      (initialized_identifier (identifier) @name))) @def.field
)

; --- calls -----------------------------------------------------------------------
; Anchored on the immediate (identifier) . (selector (argument_part)) sibling
; shape rather than a specific parent statement type, since it recurs
; unchanged under expression_statement, return_statement, and others.
(
  (identifier) @ref.call
  .
  (selector (argument_part))
)
(
  (identifier)
  (selector (unconditional_assignable_selector (identifier) @ref.call))
  .
  (selector (argument_part))
)

; --- imports -----------------------------------------------------------------------
(import_or_export
  (library_import
    (import_specification
      (configurable_uri (uri (string_literal) @import.specifier)))))
