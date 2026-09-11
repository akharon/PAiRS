"""Detects headers that #include a type but only ever need a forward declaration
(pointer/reference members, pointer/reference params, no member access, no sizeof/value
semantics), and reports which #includes can be replaced by a forward `class X;` decl.

This intentionally only ever recommends; it does not classify anything as safe to remove
unless every use of the type across the *entire translation unit visible to this header*
requires nothing more than an incomplete type.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, TranslationUnit, TypeKind

from .compdb import CompileDatabase


@dataclass
class ForwardDeclCandidate:
    type_name: str
    header_declaring_type: str
    include_line: int
    reason: str


@dataclass
class PimplReport:
    header_path: Path
    candidates: list[ForwardDeclCandidate] = field(default_factory=list)
    kept_includes: list[str] = field(default_factory=list)


class PimplAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> PimplReport:
        """Parse `via_source` (a .cpp that includes header_path) so libclang has a full
        translation unit, then restrict findings to declarations physically in header_path.
        """
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
        report = PimplReport(header_path=header_path)

        include_lines = _find_local_includes(header_path)

        class_decls = [
            c
            for c in _walk(tu.cursor)
            if c.kind in (CursorKind.CLASS_DECL, CursorKind.STRUCT_DECL)
            and c.location.file is not None
            and Path(c.location.file.name).resolve() == header_path
            and c.is_definition()
        ]

        for class_decl in class_decls:
            self._check_class(class_decl, header_path, include_lines, report)

        return report

    def _check_class(
        self,
        class_decl: Cursor,
        header_path: Path,
        include_lines: dict[str, int],
        report: PimplReport,
    ) -> None:
        # Collect every type this class definition references (fields, method signatures
        # written inline in the header) that resolves to a class/struct declared in one
        # of the headers we #include.
        referenced_types: dict[str, list[bool]] = {}  # type_name -> [needs_complete, ...]

        def record(type_name: str | None, needs_complete: bool) -> None:
            if type_name is None or type_name == class_decl.spelling:
                return
            referenced_types.setdefault(type_name, []).append(needs_complete)

        for child in class_decl.get_children():
            if child.kind == CursorKind.FIELD_DECL:
                record(_underlying_record_name(child.type), not _is_incomplete_ok(child.type))
            elif child.kind in (CursorKind.CXX_METHOD, CursorKind.CONSTRUCTOR, CursorKind.DESTRUCTOR):
                for param in child.get_arguments():
                    record(_underlying_record_name(param.type), not _is_incomplete_ok(param.type))
                record(_underlying_record_name(child.result_type), not _is_incomplete_ok(child.result_type))

        for type_name, needs_complete_flags in referenced_types.items():
            if type_name not in include_lines:
                continue  # not one of our local #includes; leave alone

            if not any(needs_complete_flags):
                report.candidates.append(
                    ForwardDeclCandidate(
                        type_name=type_name,
                        header_declaring_type=type_name,
                        include_line=include_lines[type_name],
                        reason="only used by pointer/reference (no member access, no value semantics)",
                    )
                )
            else:
                report.kept_includes.append(type_name)


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _underlying_record_name(clang_type) -> str | None:
    t = clang_type
    while t.kind in (TypeKind.POINTER, TypeKind.LVALUEREFERENCE, TypeKind.RVALUEREFERENCE):
        t = t.get_pointee()
    t = t.get_canonical()
    decl = t.get_declaration()
    if decl.kind in (CursorKind.CLASS_DECL, CursorKind.STRUCT_DECL) and decl.spelling:
        return decl.spelling
    return None


def _is_incomplete_ok(clang_type) -> bool:
    """True if this type usage (field type, param type, or return type) only needs a
    forward declaration: it's a pointer or reference to the record, never used by value.
    """
    return clang_type.kind in (TypeKind.POINTER, TypeKind.LVALUEREFERENCE, TypeKind.RVALUEREFERENCE)


def _find_local_includes(header_path: Path) -> dict[str, int]:
    """Very small textual scan: map declared-class-name-in-included-header -> #include line.
    We resolve name->header by reading the included header and grabbing its top-level
    class/struct name (good enough for the common one-class-per-header convention this
    tool targets; ambiguous headers are simply skipped, which is always safe).
    """
    result: dict[str, int] = {}
    lines = header_path.read_text().splitlines()
    header_dir = header_path.parent
    for i, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped.startswith("#include \""):
            continue
        included_name = stripped.split('"')[1]
        included_path = (header_dir / included_name).resolve()
        if not included_path.exists():
            continue
        type_name = _sniff_primary_type_name(included_path)
        if type_name:
            result[type_name] = i
    return result


def _sniff_primary_type_name(header_path: Path) -> str | None:
    import re

    text = header_path.read_text()
    m = re.search(r"\bclass\s+(\w+)\s*[{:;]", text)
    if m:
        return m.group(1)
    m = re.search(r"\bstruct\s+(\w+)\s*[{:;]", text)
    if m:
        return m.group(1)
    return None
