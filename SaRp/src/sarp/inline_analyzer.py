"""Detects free functions defined (not just declared) in a header with external linkage
and no `inline` keyword: every translation unit that includes the header gets its own
definition, so the linker either silently picks one arbitrarily (violating ODR, since
each TU's copy is a distinct but supposedly-identical definition) or fails outright with
a duplicate-symbol error once two TUs are linked together. Adding `inline` is always a
safe fix: it does not change behavior, only linkage.

Templates and functions already marked `constexpr` are already implicitly inline and are
never flagged. Member functions are excluded too: a function defined inside the class body
is implicitly inline already; one defined out-of-line is left to a separate pass, since
flagging the free-function case first is the strict subset with zero ambiguity about
"defined in a header".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, TranslationUnit

from .compdb import CompileDatabase


@dataclass
class MissingInlineCandidate:
    function_name: str
    line: int
    start_offset: int
    reason: str


@dataclass
class InlineReport:
    header_path: Path
    candidates: list[MissingInlineCandidate] = field(default_factory=list)


class InlineAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> InlineReport:
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
        report = InlineReport(header_path=header_path)

        for cursor in _walk(tu.cursor):
            if cursor.kind != CursorKind.FUNCTION_DECL:
                continue
            if cursor.location.file is None or Path(cursor.location.file.name).resolve() != header_path:
                continue
            if not cursor.is_definition():
                continue
            if _is_template(cursor):
                continue
            leading = _leading_specifiers(cursor)
            if leading & {"inline", "constexpr", "static"}:
                continue  # already inline (or already TU-local; not our concern here)

            report.candidates.append(
                MissingInlineCandidate(
                    function_name=cursor.spelling,
                    line=cursor.location.line,
                    start_offset=cursor.extent.start.offset,
                    reason="non-template function with external linkage defined in a header; "
                    "every including TU gets its own copy (ODR violation risk)",
                )
            )

        return report


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _is_template(cursor: Cursor) -> bool:
    return cursor.kind == CursorKind.FUNCTION_TEMPLATE


def _leading_specifiers(cursor: Cursor) -> set[str]:
    """Return the storage/inline specifiers (`inline`, `constexpr`, `static`) written
    before the return type, by scanning tokens up to the function's name. Cursor flags
    for these aren't exposed by this libclang binding, so token inspection is the only
    reliable signal.
    """
    specifiers = {"inline", "constexpr", "static", "consteval"}
    found: set[str] = set()
    for token in cursor.get_tokens():
        if token.spelling == cursor.spelling:
            break
        if token.spelling in specifiers:
            found.add(token.spelling)
    return found
