"""Applies a FullPimplCandidate: rewrites the class's header to hold a single
`std::unique_ptr<Impl> impl_` instead of its private fields, adds a `struct Impl;`
forward declaration and (if needed) an out-of-line `~ClassName()` declaration, and
emits a `struct ClassName::Impl { ...fields... };` definition plus rewritten
`impl_->field` accesses in the .cpp.

Two coordinated files, one safety-net application per file (same pattern as
free_function_rewriter): both are written, or an exception is raised before either is
touched — see `apply()`.
"""
from __future__ import annotations

from pathlib import Path

from .full_pimpl_analyzer import FieldAccess, FullPimplCandidate
from .safety import SafetyResult, apply_with_safety_net


def _rewrite_header(candidate: FullPimplCandidate) -> str:
    original = candidate.header_path.read_text()
    class_text = original[candidate.class_body_start_offset : candidate.class_body_end_offset]

    if "#include <memory>" not in original:
        include_insertion_point = _first_include_or_pragma_end(original)
        original = original[:include_insertion_point] + "#include <memory>\n" + original[include_insertion_point:]
        # Offsets captured before this insertion have shifted; recompute the class span.
        shift = len("#include <memory>\n")
        class_text = original[
            candidate.class_body_start_offset + shift : candidate.class_body_end_offset + shift
        ]

    new_class_text = _build_new_class_text(class_text, candidate)

    start = original.index(class_text)
    return original[:start] + new_class_text + original[start + len(class_text) :]


def _first_include_or_pragma_end(text: str) -> int:
    lines = text.splitlines(keepends=True)
    offset = 0
    last_directive_end = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#pragma once") or stripped.startswith("#include"):
            last_directive_end = offset + len(line)
        elif stripped and not stripped.startswith("//"):
            break
        offset += len(line)
    return last_directive_end


def _build_new_class_text(class_text: str, candidate: FullPimplCandidate) -> str:
    lines = class_text.splitlines(keepends=True)
    field_lines_removed = []
    kept_lines = []
    for line in lines:
        stripped = line.strip()
        if any(stripped == field_decl.strip() or stripped.rstrip("\n") == field_decl.strip() for field_decl in candidate.private_fields):
            field_lines_removed.append(line)
            continue
        kept_lines.append(line)

    text = "".join(kept_lines)

    # Insert `struct Impl;` + `std::unique_ptr<Impl> impl_;` where the fields used to be,
    # right before the closing `};` — find the last `private:` section and append there.
    # Simplest robust approach: insert right before the final `};` of the class.
    class_close = text.rstrip()
    assert class_close.endswith("};"), "expected class text to end with '};'"
    body_without_close = text[: text.rstrip().rindex("};")]

    impl_member = "    struct Impl;\n    std::unique_ptr<Impl> impl_;\n"
    new_text = body_without_close + impl_member + "};\n" if text.endswith("\n") else body_without_close + impl_member + "};"

    if candidate.needs_out_of_line_destructor:
        new_text = _insert_destructor_declaration(new_text, candidate.class_name)

    return new_text


def _insert_destructor_declaration(class_text: str, class_name: str) -> str:
    """Insert `~ClassName();` right after the class's opening `{`. If the class already
    opens directly into a `public:` section, the declaration is inserted just after
    that label so no duplicate `public:` is introduced; otherwise an explicit
    `public:` label is added, which is always valid C++ regardless of what
    access-specifier sections already exist below it.
    """
    open_brace = class_text.index("{")
    after_brace = class_text[open_brace + 1 :]
    stripped = after_brace.lstrip()
    if stripped.startswith("public:"):
        label_offset = open_brace + 1 + (len(after_brace) - len(stripped)) + len("public:")
        insertion = f"\n    ~{class_name}();"
        return class_text[:label_offset] + insertion + class_text[label_offset:]

    insertion = f"\npublic:\n    ~{class_name}();\n"
    return class_text[: open_brace + 1] + insertion + class_text[open_brace + 1 :]


def _rewrite_source(candidate: FullPimplCandidate, source_path: Path) -> str:
    original = source_path.read_text()

    accesses_in_file = [a for a in candidate.field_accesses if a.file == source_path]
    ctor_bodies_in_file = [c for c in candidate.constructor_bodies if c.file == source_path]

    # Field-access rewrites and impl_ construction inserts are both offset-based edits
    # into the SAME text; applying them in one descending-offset pass (as if they were
    # a single edit list) keeps every earlier offset valid regardless of edit order.
    edits: list[tuple[int, int, str]] = []
    for access in accesses_in_file:
        edits.append((access.start_offset, access.end_offset, f"impl_->{access.field_name}"))
    for ctor in ctor_bodies_in_file:
        edits.append((ctor.body_open_offset, ctor.body_open_offset, "\n    impl_ = std::make_unique<Impl>();"))
    edits.sort(key=lambda e: e[0], reverse=True)

    text = original
    for start, end, replacement in edits:
        text = text[:start] + replacement + text[end:]

    impl_struct = _build_impl_struct_definition(candidate)
    dtor_definition = (
        f"\n{candidate.class_name}::~{candidate.class_name}() = default;\n"
        if candidate.needs_out_of_line_destructor
        else ""
    )

    include_line = f'#include "{candidate.header_path.name}"\n'
    if include_line in text:
        insertion_point = text.index(include_line) + len(include_line)
        text = text[:insertion_point] + f"\n{impl_struct}{dtor_definition}" + text[insertion_point:]
    else:
        text = f"{impl_struct}{dtor_definition}\n" + text

    return text


def _build_impl_struct_definition(candidate: FullPimplCandidate) -> str:
    field_lines = "\n".join(f"    {f}" for f in candidate.private_fields)
    return f"struct {candidate.class_name}::Impl {{\n{field_lines}\n}};\n"


def apply(
    candidate: FullPimplCandidate, source_path: Path, *, dry_run: bool = False
) -> dict[Path, tuple[str, SafetyResult | None]]:
    """`source_path` is the .cpp where field accesses live and where the Impl struct
    definition is emitted — normally the same .cpp passed as --via.
    """
    results: dict[Path, tuple[str, SafetyResult | None]] = {}

    header_original = candidate.header_path.read_text()
    header_new = _rewrite_header(candidate)

    source_original = source_path.read_text()
    source_new = _rewrite_source(candidate, source_path)

    if dry_run:
        results[candidate.header_path] = (header_new, None)
        results[source_path] = (source_new, None)
        return results

    description = f"sarp: full pimpl rewrite of {candidate.class_name}"
    header_safety = apply_with_safety_net(candidate.header_path, header_original, header_new, description)
    results[candidate.header_path] = (header_new, header_safety)

    source_safety = apply_with_safety_net(source_path, source_original, source_new, description)
    results[source_path] = (source_new, source_safety)

    return results
