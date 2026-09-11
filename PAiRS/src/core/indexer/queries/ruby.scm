; Ruby extraction query. Capture-name contract: see ../extractors.ts.
; NOTE: Ruby has no static export/visibility syntax node — `private`/
; `protected` are plain method calls (an `identifier` node), not a modifier
; attached to the following `method` node, so @exported is never emitted
; here (same v1 approach as python.scm: all defs are treated as visible).
; Ruby also has no static return-type or parameter-type annotations, so
; @ret is never captured; @params captures the parameter list as written.

(
  (comment)? @doc
  .
  (method
    name: (identifier) @name
    parameters: (method_parameters)? @params) @def.method
)

(
  (comment)? @doc
  .
  (singleton_method
    name: (identifier) @name
    parameters: (method_parameters)? @params) @def.method
)

(
  (comment)? @doc
  .
  (class
    name: (constant) @name
    superclass: (superclass (constant) @ref.extends)?) @def.class
)

(
  (comment)? @doc
  .
  (module
    name: (constant) @name) @def.class
)

; `include Mod` / `extend Mod` inside a class body — treated as a reference,
; not a structural `extends` edge (Ruby mixins are not single-inheritance).
(call method: (identifier) @ref.reference
  (#any-of? @ref.reference "include" "extend" "prepend")
  arguments: (argument_list (constant) @ref.reference))

; --- calls -----------------------------------------------------------------------
(call method: (identifier) @ref.call)

; --- imports -----------------------------------------------------------------------
(call method: (identifier) @_req (#any-of? @_req "require" "require_relative")
  arguments: (argument_list (string (string_content) @import.specifier)))
