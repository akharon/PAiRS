"""Detects member functions that never touch instance state (no access to private/protected
fields, no calls to non-static member functions, not virtual, not an operator overload) and
are therefore safe to turn into free functions taking the object as an explicit parameter.

Conservative by design: anything virtual, an override, a constructor/destructor, an operator,
or touching any instance member (state or method) is excluded.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, TranslationUnit

from .compdb import CompileDatabase


@dataclass
class FreeFunctionCandidate:
    class_name: str
    method_name: str
    signature: str
    header_line: int
    reason: str


@dataclass
class FreeFunctionReport:
    header_path: Path
    candidates: list[FreeFunctionCandidate] = field(default_factory=list)


class FreeFunctionAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> FreeFunctionReport:
        args = self._compdb.args_for(via_source)
        if args is None:
            raise ValueError(f"No compile command found for {via_source}")

        tu: TranslationUnit = self._index.parse(str(via_source), args=args)
        diagnostics = [d for d in tu.diagnostics if d.severity >= 3]
        if diagnostics:
            raise RuntimeError(
                f"Parse errors in {via_source}: " + "; ".join(str(d) for d in diagnostics)
            )

        header_path = header_path.resolve()
        report = FreeFunctionReport(header_path=header_path)

        methods = [
            c
            for c in _walk(tu.cursor)
            if c.kind == CursorKind.CXX_METHOD
            and c.location.file is not None
            and Path(c.location.file.name).resolve() == header_path
        ]

        for method in methods:
            verdict = _classify(method)
            if verdict is not None:
                report.candidates.append(verdict)

        return report


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


_EXCLUDED_KINDS = {
    CursorKind.CONSTRUCTOR,
    CursorKind.DESTRUCTOR,
}


def _classify(method: Cursor) -> FreeFunctionCandidate | None:
    if method.kind in _EXCLUDED_KINDS:
        return None
    if method.is_virtual_method() or method.is_pure_virtual_method():
        return None
    if method.is_static_method():
        return None  # already a "free function in disguise"; nothing to change
    if method.spelling.startswith("operator"):
        return None

    definition = method.get_definition() or method
    body = next((c for c in definition.get_children() if c.kind == CursorKind.COMPOUND_STMT), None)
    if body is None:
        return None  # no definition visible in this translation unit; nothing to analyze

    if _touches_instance_state(body, method):
        return None

    class_decl = method.semantic_parent
    return FreeFunctionCandidate(
        class_name=class_decl.spelling,
        method_name=method.spelling,
        signature=method.displayname,
        header_line=method.location.line,
        reason="body references no instance fields or non-static member calls; usable via public API only",
    )


def _touches_instance_state(body: Cursor, method: Cursor) -> bool:
    for node in _walk(body):
        if node.kind == CursorKind.MEMBER_REF_EXPR:
            referenced = node.referenced
            if referenced is not None and referenced.kind == CursorKind.FIELD_DECL:
                return True
        if node.kind == CursorKind.DECL_REF_EXPR:
            referenced = node.referenced
            if referenced is not None and referenced.kind == CursorKind.CXX_METHOD:
                if not referenced.is_static_method():
                    return True
        if node.kind == CursorKind.CXX_THIS_EXPR:
            return True
    return False
