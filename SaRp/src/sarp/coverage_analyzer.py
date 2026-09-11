"""Reports what SaRp's whole-program-flavored analyses (L4/L5 friend/access-narrowing
scans, H4/H5/H6 ODR/linkage/hierarchy checks — none implemented yet, but this report is
their prerequisite per the design doc) can and cannot see.

Every "whole program" claim SaRp makes is only as true as the compile database it was
given: a TU missing from compile_commands.json, or one that fails to parse, is invisible
to every closed-world analysis, and a class/function used only from such a TU could be
silently mis-classified (e.g. "no external users" when an unanalyzed TU is in fact one).
This report makes that gap explicit instead of leaving it implicit, which is also the
stated evidence artifact for the ISO 26262 tool-confidence argument (see the source doc's
"Hard boundaries" section).

Three things are reported, all report-only (no APPLY/REJECT semantics — this classifies
inputs, not proposes edits):
- TUs listed in compile_commands.json that fail to parse (diagnostics at error severity
  or above), and are therefore excluded from every other SaRp analysis
- Project headers that exist on disk under the project root but are never reached
  (directly or transitively) by any parseable TU in the compile database
- Project headers that ARE reached by at least one TU, for a definitive "covered" count
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Index

from .compdb import CompileDatabase

_HEADER_SUFFIXES = {".h", ".hpp", ".hh", ".hxx"}


@dataclass
class CoverageReport:
    total_tus: int = 0
    unparseable_tus: list[tuple[Path, str]] = field(default_factory=list)
    """(file, first diagnostic message) for each TU that failed to parse."""
    covered_headers: list[Path] = field(default_factory=list)
    uncovered_headers: list[Path] = field(default_factory=list)
    """Project headers on disk that no parseable TU reaches, directly or transitively."""


def analyze_coverage(compdb: CompileDatabase, project_root: Path) -> CoverageReport:
    project_root = project_root.resolve()
    index = Index.create()
    report = CoverageReport()

    all_project_headers = sorted(
        p.resolve() for p in project_root.rglob("*") if p.suffix in _HEADER_SUFFIXES and p.is_file()
    )

    reached: set[Path] = set()
    tu_files = sorted(compdb.files())
    report.total_tus = len(tu_files)

    for source_file in tu_files:
        args = compdb.args_for(source_file)
        if args is None:
            continue

        tu = index.parse(str(source_file), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            report.unparseable_tus.append((source_file, str(errors[0])))
            continue

        for included in tu.get_includes():
            header_path = Path(included.include.name).resolve()
            if header_path.suffix in _HEADER_SUFFIXES:
                reached.add(header_path)

    report.covered_headers = sorted(h for h in all_project_headers if h in reached)
    report.uncovered_headers = sorted(h for h in all_project_headers if h not in reached)
    report.unparseable_tus.sort(key=lambda t: t[0])

    return report
