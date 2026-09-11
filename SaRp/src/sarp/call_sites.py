"""Finds call sites of a member function across every translation unit in the compile
database, and captures enough source-span information for call_site_rewriter.py to
mechanically rewrite `obj.method(args)` / `obj->method(args)` into
`method(obj, args)` / `method(*obj, args)` after the declaration has been converted to
a free function.
"""
from __future__ import annotations

from pathlib import Path

from clang.cindex import CursorKind, Index, TypeKind

from .compdb import CompileDatabase
from .free_function_analyzer import CallSite, _walk


def find_call_sites(
    compdb: CompileDatabase, class_name: str, method_name: str, header_path: Path
) -> list[CallSite]:
    header_path = header_path.resolve()
    index = Index.create()
    sites: list[CallSite] = []

    for source_file in compdb.files():
        args = compdb.args_for(source_file)
        if args is None:
            continue
        tu = index.parse(str(source_file), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            continue

        source_lines: list[str] | None = None
        call_file: Path | None = None
        for node in _walk(tu.cursor):
            if node.kind != CursorKind.CALL_EXPR:
                continue
            if node.spelling != method_name:
                continue

            children = list(node.get_children())
            if not children or children[0].kind != CursorKind.MEMBER_REF_EXPR:
                continue
            member_ref = children[0]

            referenced = member_ref.referenced
            if referenced is None or referenced.kind != CursorKind.CXX_METHOD:
                continue
            if referenced.semantic_parent.spelling != class_name:
                continue
            decl_file = referenced.location.file
            if decl_file is None or Path(decl_file.name).resolve() != header_path:
                continue

            obj_children = list(member_ref.get_children())
            if not obj_children:
                continue  # implicit `this->method(...)` inside another member function; skip
            obj = obj_children[0]

            this_call_file = Path(node.location.file.name).resolve()
            if source_lines is None or this_call_file != call_file:
                source_lines = this_call_file.read_text().splitlines()
                call_file = this_call_file

            line_no = node.location.line
            source_line = source_lines[line_no - 1] if 0 < line_no <= len(source_lines) else ""

            arg_spans = [(c.extent.start.offset, c.extent.end.offset) for c in children[1:]]
            rewritable = _spans_are_sane(
                this_call_file,
                node.extent.start.offset,
                node.extent.end.offset,
                obj.extent.start.offset,
                obj.extent.end.offset,
                arg_spans,
                method_name,
            )

            sites.append(
                CallSite(
                    file=this_call_file,
                    line=line_no,
                    column=node.location.column,
                    source_line=source_line.strip(),
                    call_start_offset=node.extent.start.offset,
                    call_end_offset=node.extent.end.offset,
                    object_start_offset=obj.extent.start.offset,
                    object_end_offset=obj.extent.end.offset,
                    object_is_pointer=obj.type.kind == TypeKind.POINTER,
                    arg_spans=arg_spans,
                    rewritable=rewritable,
                )
            )

    return sites


def _spans_are_sane(
    file_path: Path,
    call_start: int,
    call_end: int,
    obj_start: int,
    obj_end: int,
    arg_spans: list[tuple[int, int]],
    method_name: str,
) -> bool:
    """A call site sitting inside a macro expansion (assert(...), a logging macro,
    etc.) can make libclang report degenerate/empty cursor extents — trusting those
    for a text rewrite would corrupt the file (verified: it does, without this check).
    Reject anything that doesn't look like real, non-empty, correctly-ordered spans
    that actually contain the method name being rewritten.
    """
    if call_end <= call_start or obj_end <= obj_start:
        return False
    if obj_start < call_start or obj_end > call_end:
        return False
    for start, end in arg_spans:
        if end <= start or start < call_start or end > call_end:
            return False

    text = file_path.read_text()
    call_text = text[call_start:call_end]
    return method_name in call_text and len(call_text) < 2000
