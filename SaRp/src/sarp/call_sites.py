"""Finds call sites of a member function across every translation unit in the compile
database. Used by the free-function rewriter to report (never auto-rewrite — see
free_function_rewriter.py) which call sites need manual `obj.method(x)` ->
`method(obj, x)` updates after a declaration is converted to a free function.
"""
from __future__ import annotations

from pathlib import Path

from clang.cindex import CursorKind, Index

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
        for node in _walk(tu.cursor):
            if node.kind != CursorKind.MEMBER_REF_EXPR:
                continue
            if node.spelling != method_name:
                continue
            referenced = node.referenced
            if referenced is None or referenced.kind != CursorKind.CXX_METHOD:
                continue
            if referenced.semantic_parent.spelling != class_name:
                continue
            decl_file = referenced.location.file
            if decl_file is None or Path(decl_file.name).resolve() != header_path:
                continue

            call_file = Path(node.location.file.name).resolve()
            if source_lines is None or sites and sites[-1].file != call_file:
                source_lines = call_file.read_text().splitlines()
            line_no = node.location.line
            source_line = source_lines[line_no - 1] if source_lines and 0 < line_no <= len(source_lines) else ""
            sites.append(
                CallSite(
                    file=call_file,
                    line=line_no,
                    column=node.location.column,
                    source_line=source_line.strip(),
                )
            )

    return sites
