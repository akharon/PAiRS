; Java extraction query. Capture-name contract: see ../extractors.ts.
; NOTE: tree-sitter requires sibling captures within one pattern to appear in
; the same relative order as the grammar's actual children (modifiers, then
; type, then name, then parameters/body) — reordering breaks query
; compilation ("Bad pattern structure"), so don't reorder these to match
; ../extractors.ts's capture-name doc order.

(
  (block_comment)? @doc
  .
  (class_declaration
    (modifiers "public" @exported)?
    name: (identifier) @name
    superclass: (superclass (type_identifier) @ref.extends)?
    interfaces: (super_interfaces (type_list (type_identifier) @ref.implements))?) @def.class
)

(
  (block_comment)? @doc
  .
  (interface_declaration
    name: (identifier) @name
    (extends_interfaces (type_list (type_identifier) @ref.extends))?) @def.interface
)

(
  (block_comment)? @doc
  .
  (enum_declaration
    name: (identifier) @name) @def.enum
)

(
  (block_comment)? @doc
  .
  (method_declaration
    (modifiers "public" @exported)?
    type: (_) @ret
    name: (identifier) @name
    parameters: (formal_parameters) @params) @def.method
)

(
  (block_comment)? @doc
  .
  (constructor_declaration
    (modifiers "public" @exported)?
    name: (identifier) @name
    parameters: (formal_parameters) @params) @def.method
)

(
  (block_comment)? @doc
  .
  (field_declaration
    (modifiers "public" @exported)?
    declarator: (variable_declarator name: (identifier) @name)) @def.field
)

; --- calls -----------------------------------------------------------------------
(method_invocation name: (identifier) @ref.call)

; --- imports -----------------------------------------------------------------------
(import_declaration (scoped_identifier) @import.specifier)
(import_declaration (identifier) @import.specifier)
