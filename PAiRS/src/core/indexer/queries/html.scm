; HTML extraction query. Capture-name contract: see ../extractors.ts.
; HTML has no functions/classes/control-flow, so this query captures the
; closest structural analogue to a named, addressable unit: any element
; carrying an `id` attribute becomes a `@def.field` symbol named after the
; id value (not the tag name) — ids are the only stable, unique handles into
; an HTML document, and this mirrors how the rest of the codebase (CSS
; selectors, JS `document.getElementById`) already refers to elements.
; Elements without an id are not captured (v1: keeps the index small; only
; addressable elements are useful structural anchors). `<script src=...>`
; and `<link href=...>` are captured as @import.specifier so cross-file
; asset references show up in the graph; `<script>` is a distinct
; `script_element` node type in this grammar, not `element`, so it needs
; its own pattern.

(
  (comment)? @doc
  .
  (element
    (start_tag
      (tag_name) @tagname
      (attribute
        (attribute_name) @attrname
        (#eq? @attrname "id")
        (quoted_attribute_value (attribute_value) @name)))) @def.field
)

(element
  (start_tag
    (tag_name) @linktag
    (#eq? @linktag "link")
    (attribute
      (attribute_name) @linkattr
      (#eq? @linkattr "href")
      (quoted_attribute_value (attribute_value) @import.specifier))))

(script_element
  (start_tag
    (attribute
      (attribute_name) @scriptattr
      (#eq? @scriptattr "src")
      (quoted_attribute_value (attribute_value) @import.specifier))))
