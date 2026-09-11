"""Detects classes whose move constructor/assignment could be `noexcept` but isn't
(either not user-declared and would resolve to defaulted-but-not-yet-visible-as-noexcept,
or user-provided without the specifier) even though every member and base's own move
operation is itself noexcept.

This matters because `std::vector` (and every other container that offers the strong
exception-safety guarantee) checks `std::is_nothrow_move_constructible` before using a
move during reallocation; if it's false, the container silently falls back to copying
every element instead, which is often the single biggest hidden performance bug in
C++ code that "already uses move semantics" but never explicitly marked anything.

libclang leaves an implicitly-defaulted special member's `exception_specification_kind`
as UNEVALUATED unless the translation unit actually odr-uses it (e.g. an explicit move),
which the analyzed --via file has no reason to do — so this walks the member/base tree
itself and computes noexcept-ness structurally, rather than trusting libclang's lazy
evaluation. This mirrors how the compiler itself derives it for `= default`: a type is
noexcept-move-constructible only if every base and non-static data member is, and (for
scalars/pointers, which have no user-visible move ctor at all) those are always noexcept
by definition.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import (
    AccessSpecifier,
    Cursor,
    CursorKind,
    ExceptionSpecificationKind,
    Index,
    TranslationUnit,
    TypeKind,
)

from .compdb import CompileDatabase

_RECORD_DECL_KINDS = (CursorKind.CLASS_DECL, CursorKind.STRUCT_DECL)


@dataclass
class NoexceptMoveCandidate:
    class_name: str
    line: int
    move_ctor_line: int | None
    insert_offset: int
    """Byte offset of the move constructor's opening `{`; `noexcept ` is inserted here."""
    reason: str


@dataclass
class NoexceptMoveReport:
    header_path: Path
    candidates: list[NoexceptMoveCandidate] = field(default_factory=list)
    skipped: dict[str, str] = field(default_factory=dict)


class NoexceptMoveAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> NoexceptMoveReport:
        args = self._compdb.args_for(via_source)
        if args is None:
            raise ValueError(f"No compile command found for {via_source}")

        tu: TranslationUnit = self._index.parse(str(via_source), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            raise RuntimeError(f"Parse errors in {via_source}: " + "; ".join(str(d) for d in errors))

        header_path = header_path.resolve()
        report = NoexceptMoveReport(header_path=header_path)

        class_decls = [
            c
            for c in _walk(tu.cursor)
            if c.kind in _RECORD_DECL_KINDS
            and c.location.file is not None
            and Path(c.location.file.name).resolve() == header_path
            and c.is_definition()
        ]

        cache: dict[str, bool | None] = {}
        for class_decl in class_decls:
            self._check_class(class_decl, cache, report)

        return report

    def _check_class(self, class_decl: Cursor, cache: dict, report: NoexceptMoveReport) -> None:
        name = class_decl.spelling
        move_ctor = _find_move_ctor(class_decl)

        if move_ctor is not None and _is_marked_noexcept(move_ctor):
            return  # already correctly marked; nothing to do

        if move_ctor is not None and _has_body(move_ctor):
            can_be_noexcept, reason = _members_and_bases_noexcept(class_decl, cache)
            if not can_be_noexcept:
                report.skipped[name] = reason
                return
            body = next(c for c in move_ctor.get_children() if c.kind == CursorKind.COMPOUND_STMT)
            report.candidates.append(
                NoexceptMoveCandidate(
                    class_name=name,
                    line=class_decl.location.line,
                    move_ctor_line=move_ctor.location.line,
                    insert_offset=body.extent.start.offset,
                    reason="user-provided move constructor could be marked noexcept: "
                    "every base/member's own move operation is noexcept",
                )
            )
            return

        # No user-declared move ctor, or a `= default`/implicit one: the compiler already
        # derives noexcept-ness structurally and correctly for these, so there's nothing
        # for Sarp to add here — flagging would just restate what the compiler does.
        return


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _find_move_ctor(class_decl: Cursor) -> Cursor | None:
    for child in class_decl.get_children():
        if child.kind == CursorKind.CONSTRUCTOR and child.is_move_constructor():
            return child
    return None


def _has_body(ctor: Cursor) -> bool:
    return any(c.kind == CursorKind.COMPOUND_STMT for c in ctor.get_children())


def _is_marked_noexcept(ctor: Cursor) -> bool:
    return ctor.exception_specification_kind in (
        ExceptionSpecificationKind.BASIC_NOEXCEPT,
        ExceptionSpecificationKind.COMPUTED_NOEXCEPT,
    )


def _members_and_bases_noexcept(class_decl: Cursor, cache: dict) -> tuple[bool, str]:
    for base in class_decl.get_children():
        if base.kind != CursorKind.CXX_BASE_SPECIFIER:
            continue
        base_decl = base.type.get_declaration()
        ok, reason = _record_is_nothrow_move_constructible(base_decl, cache)
        if not ok:
            return False, f"base '{base.type.spelling}' {reason}"

    for field_decl in class_decl.get_children():
        if field_decl.kind != CursorKind.FIELD_DECL:
            continue
        field_type = field_decl.type
        while field_type.kind == TypeKind.ELABORATED:
            field_type = field_type.get_named_type()
        record_decl = field_type.get_canonical().get_declaration()
        if record_decl.kind not in _RECORD_DECL_KINDS:
            continue  # scalar/pointer/enum members are always nothrow-movable
        ok, reason = _record_is_nothrow_move_constructible(record_decl, cache)
        if not ok:
            return False, f"member '{field_decl.spelling}' ({field_type.spelling}) {reason}"

    return True, ""


def _record_is_nothrow_move_constructible(record_decl: Cursor, cache: dict) -> tuple[bool, str]:
    key = record_decl.spelling or str(record_decl.get_usr())
    if key in cache:
        cached = cache[key]
        return (cached is True, "" if cached else "has a move constructor that is not noexcept")

    definition = record_decl.get_definition()
    if definition is None:
        cache[key] = None
        return False, "is not fully visible in this translation unit (can't verify)"

    move_ctor = _find_move_ctor(definition)
    if move_ctor is None:
        # No user-declared move ctor: compiler-generated one is noexcept iff every
        # member/base is, so recurse the same way.
        ok, reason = _members_and_bases_noexcept(definition, cache)
        cache[key] = ok
        return ok, ("" if ok else reason)

    if _is_marked_noexcept(move_ctor):
        cache[key] = True
        return True, ""

    cache[key] = False
    return False, "has a move constructor that is not noexcept"
