"""Reports struct/class padding waste using Clang's actual computed layout (`Type.get_size`,
`Type.get_align`, `Type.get_offset` — the libclang-exposed equivalent of `ASTRecordLayout`,
so the byte counts are exact, not a heuristic guess) and proposes a reordering that
minimizes total size: descending-alignment greedy packing, the standard fix for the
common "fields declared in a logical-but-poorly-packed order" case.

Report only, never an APPLY: reordering members changes the type's layout, which is an
ABI break for anything that serializes the struct, uses `offsetof`, or is part of a
public/SDK header — exactly the same allow-list boundary the design doc draws for
pimpl and other ABI-changing edits. This tool reports the exact savings and a proposed
order; a human (or an allow-listed follow-up edit, not implemented here) decides.

Skipped, not reported: classes with a base class, virtual functions (vtable pointer
placement isn't a plain field-reordering problem), bit-fields (their packing interacts
with adjacent fields in ways a simple reorder can silently change), or any field whose
size/alignment isn't known (dependent/template types, incomplete types) — the size
arithmetic would be wrong or misleading.
"""
from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, TranslationUnit

from .compdb import CompileDatabase

_RECORD_DECL_KINDS = (CursorKind.CLASS_DECL, CursorKind.STRUCT_DECL)


@dataclass
class FieldLayout:
    name: str
    type_name: str
    size_bytes: int
    align_bytes: int
    offset_bytes: int


@dataclass
class PaddingCandidate:
    class_name: str
    line: int
    current_size_bytes: int
    current_fields: list[FieldLayout]
    proposed_order: list[str]
    """Field names in the proposed (descending-alignment) order."""
    proposed_size_bytes: int
    savings_bytes: int
    reason: str


@dataclass
class PaddingAnalysisReport:
    header_path: Path
    candidates: list[PaddingCandidate] = dc_field(default_factory=list)
    skipped: dict[str, str] = dc_field(default_factory=dict)


class PaddingAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> PaddingAnalysisReport:
        args = self._compdb.args_for(via_source)
        if args is None:
            raise ValueError(f"No compile command found for {via_source}")

        tu: TranslationUnit = self._index.parse(str(via_source), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            raise RuntimeError(f"Parse errors in {via_source}: " + "; ".join(str(d) for d in errors))

        header_path = header_path.resolve()
        report = PaddingAnalysisReport(header_path=header_path)

        class_decls = [
            c
            for c in _walk(tu.cursor)
            if c.kind in _RECORD_DECL_KINDS
            and c.location.file is not None
            and Path(c.location.file.name).resolve() == header_path
            and c.is_definition()
        ]

        for class_decl in class_decls:
            self._check_class(class_decl, report)

        return report

    def _check_class(self, class_decl: Cursor, report: PaddingAnalysisReport) -> None:
        name = class_decl.spelling
        children = list(class_decl.get_children())

        bases = [c for c in children if c.kind == CursorKind.CXX_BASE_SPECIFIER]
        if bases:
            report.skipped[name] = "has a base class; layout depends on base subobject placement"
            return

        virtuals = [
            c
            for c in children
            if c.kind in (CursorKind.CXX_METHOD, CursorKind.DESTRUCTOR) and c.is_virtual_method()
        ]
        if virtuals:
            report.skipped[name] = "has virtual function(s); vtable pointer affects layout"
            return

        bitfields = [c for c in children if c.kind == CursorKind.FIELD_DECL and c.is_bitfield()]
        if bitfields:
            report.skipped[name] = "has bit-field member(s); packing not handled"
            return

        fields = [c for c in children if c.kind == CursorKind.FIELD_DECL]
        if len(fields) < 2:
            report.skipped[name] = "fewer than 2 fields; nothing to reorder"
            return

        layouts: list[FieldLayout] = []
        for f in fields:
            size = f.type.get_size()
            align = f.type.get_align()
            if size <= 0 or align <= 0:
                report.skipped[name] = f"field '{f.spelling}' has unknown size/alignment (dependent/incomplete type)"
                return
            offset_bits = class_decl.type.get_offset(f.spelling)
            if offset_bits < 0:
                report.skipped[name] = f"field '{f.spelling}' offset could not be computed"
                return
            layouts.append(
                FieldLayout(
                    name=f.spelling,
                    type_name=f.type.spelling,
                    size_bytes=size,
                    align_bytes=align,
                    offset_bytes=offset_bits // 8,
                )
            )

        current_size = class_decl.type.get_size()
        proposed_order, proposed_size = _pack_descending_alignment(layouts)

        if proposed_size >= current_size:
            return  # already optimally packed (or reordering wouldn't help); nothing to report

        report.candidates.append(
            PaddingCandidate(
                class_name=name,
                line=class_decl.location.line,
                current_size_bytes=current_size,
                current_fields=layouts,
                proposed_order=proposed_order,
                proposed_size_bytes=proposed_size,
                savings_bytes=current_size - proposed_size,
                reason=f"reordering by descending alignment saves {current_size - proposed_size} byte(s) "
                f"per instance ({current_size} -> {proposed_size})",
            )
        )


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _pack_descending_alignment(layouts: list[FieldLayout]) -> tuple[list[str], int]:
    ordered = sorted(layouts, key=lambda f: (-f.align_bytes, f.name))
    offset = 0
    max_align = 1
    for f in ordered:
        max_align = max(max_align, f.align_bytes)
        if offset % f.align_bytes != 0:
            offset += f.align_bytes - (offset % f.align_bytes)
        offset += f.size_bytes
    if offset % max_align != 0:
        offset += max_align - (offset % max_align)
    return [f.name for f in ordered], offset
