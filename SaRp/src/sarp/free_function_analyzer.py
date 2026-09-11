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
class SourceSpan:
    file: Path
    start_offset: int
    end_offset: int
    start_line: int


@dataclass
class FreeFunctionCandidate:
    class_name: str
    method_name: str
    signature: str
    header_line: int
    reason: str
    is_const: bool
    param_types: list[str]
    param_names: list[str]
    return_type: str
    declaration_span: SourceSpan
    """Span of the full member-function declaration inside the class body (header)."""
    definition_span: SourceSpan | None
    """Span of the out-of-line definition (usually in the .cpp), if one exists in this TU."""
    enclosing_class_end_offset: int
    """Byte offset just past the enclosing class's closing `};` in the header — the free
    function declaration is inserted here, since it must live outside the class body."""


@dataclass
class CallSite:
    file: Path
    line: int
    column: int
    source_line: str


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
    params = list(method.get_arguments())
    header_text = Path(method.location.file.name).read_text()

    return FreeFunctionCandidate(
        class_name=class_decl.spelling,
        method_name=method.spelling,
        signature=method.displayname,
        header_line=method.location.line,
        reason="body references no instance fields or non-static member calls; usable via public API only",
        is_const=method.is_const_method(),
        param_types=[p.type.spelling for p in params],
        param_names=[p.spelling or f"arg{i}" for i, p in enumerate(params)],
        return_type=method.result_type.spelling,
        declaration_span=_whole_line_span(_span_of(method), header_text),
        definition_span=_span_of(definition) if definition != method else None,
        enclosing_class_end_offset=_class_end_offset(class_decl, header_text),
    )


def _class_end_offset(class_decl: Cursor, header_text: str) -> int:
    """A CLASS_DECL's extent ends right after the closing `}`, not after the class's own
    trailing `;` — find that `;` explicitly so an insertion point placed here lands after
    the complete `class X { ... };`, not between the `}` and its `;`.
    """
    brace_end = class_decl.extent.end.offset
    semicolon = header_text.find(";", brace_end)
    return semicolon + 1 if semicolon != -1 else brace_end


def _whole_line_span(span: SourceSpan, text: str) -> SourceSpan:
    """Widens a declaration's span to cover its full source line(s), including leading
    indentation and the trailing `;` + newline, so removing it from the class leaves no
    stray blank/semicolon behind.
    """
    line_start = text.rfind("\n", 0, span.start_offset) + 1
    semicolon = text.find(";", span.end_offset)
    line_end = text.find("\n", semicolon) + 1 if semicolon != -1 else len(text)
    return SourceSpan(
        file=span.file,
        start_offset=line_start,
        end_offset=line_end,
        start_line=span.start_line,
    )


def _span_of(cursor: Cursor) -> SourceSpan:
    extent = cursor.extent
    return SourceSpan(
        file=Path(extent.start.file.name).resolve(),
        start_offset=extent.start.offset,
        end_offset=extent.end.offset,
        start_line=extent.start.line,
    )


def _touches_instance_state(body: Cursor, method: Cursor) -> bool:
    for node in _walk(body):
        if node.kind == CursorKind.MEMBER_REF_EXPR:
            # Implicit-`this` field access (`x_`) AND implicit-`this` member-function
            # calls (`helper()`, called without `this->`) both surface as
            # MEMBER_REF_EXPR — libclang doesn't distinguish them by cursor kind, only
            # by what `referenced` resolves to.
            referenced = node.referenced
            if referenced is not None and referenced.kind == CursorKind.FIELD_DECL:
                return True
            if referenced is not None and referenced.kind == CursorKind.CXX_METHOD:
                if not referenced.is_static_method():
                    return True
        if node.kind == CursorKind.DECL_REF_EXPR:
            referenced = node.referenced
            if referenced is not None and referenced.kind == CursorKind.CXX_METHOD:
                if not referenced.is_static_method():
                    return True
        if node.kind == CursorKind.CXX_THIS_EXPR:
            return True
    return False
