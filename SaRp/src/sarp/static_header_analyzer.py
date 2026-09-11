"""Detects `static` functions and namespace-scope variables in a header: every
translation unit that includes the header gets its own private copy (internal linkage),
which silently bloats the binary (one copy of the function body / variable per TU) and,
for variables, is a well-known footgun — code that assumes a single shared instance
across the program is instead operating on N independent copies with no diagnostic.

C++17's `inline` on a variable (or `inline` on a free function, same as L1) gives a
single, shared, ODR-correct definition across all including TUs and is a mechanical,
behavior-preserving fix in the common case. Pre-C++17 targets can't use `inline`
variables at all, so those are left alone entirely (reported as REJECT, not silently
skipped) rather than proposing an edit that would fail to compile for that target.

Static class *members* (`static int x;` inside a class body) are a different feature
entirely (a shared-across-instances field, not a translation-unit-local copy) and are
never flagged here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, StorageClass, TranslationUnit

from .compdb import CompileDatabase

_CXX17_FLAGS = {"c++17", "c++20", "c++23", "c++26", "gnu++17", "gnu++20", "gnu++23", "gnu++26"}


@dataclass
class StaticHeaderCandidate:
    name: str
    kind: str  # "function" or "variable"
    line: int
    start_offset: int
    reason: str


@dataclass
class StaticHeaderReport:
    header_path: Path
    candidates: list[StaticHeaderCandidate] = field(default_factory=list)
    rejected_pre_cxx17: bool = False


class StaticHeaderAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> StaticHeaderReport:
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
        report = StaticHeaderReport(header_path=header_path)

        if not _targets_cxx17_or_later(args):
            report.rejected_pre_cxx17 = True
            return report

        for cursor in _walk(tu.cursor):
            if cursor.kind not in (CursorKind.FUNCTION_DECL, CursorKind.VAR_DECL):
                continue
            if cursor.location.file is None or Path(cursor.location.file.name).resolve() != header_path:
                continue
            if cursor.storage_class != StorageClass.STATIC:
                continue
            if cursor.semantic_parent is not None and cursor.semantic_parent.kind in (
                CursorKind.CLASS_DECL,
                CursorKind.STRUCT_DECL,
                CursorKind.CLASS_TEMPLATE,
            ):
                continue  # static class member, not a TU-local copy
            if cursor.kind == CursorKind.FUNCTION_DECL and not cursor.is_definition():
                continue

            kind = "function" if cursor.kind == CursorKind.FUNCTION_DECL else "variable"
            report.candidates.append(
                StaticHeaderCandidate(
                    name=cursor.spelling,
                    kind=kind,
                    line=cursor.location.line,
                    start_offset=cursor.extent.start.offset,
                    reason=f"static {kind} at namespace scope in a header; "
                    "every including TU gets its own private copy",
                )
            )

        return report


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _targets_cxx17_or_later(args: list[str]) -> bool:
    for arg in args:
        if arg.startswith("-std="):
            return arg[len("-std=") :].lower() in _CXX17_FLAGS
    return False  # no explicit -std= means the compiler default, which we don't assume is >=17
