"""Detects C++ headers that are `#include`d (directly or transitively) by a C
translation unit but lack an `extern "C"` guard: every declaration in the header gets
C++ name-mangled linkage, which the C TU's linker step can't resolve, producing a
link-time "undefined reference" for a symbol whose declaration the C compiler happily
accepted (headers use `#ifdef __cplusplus` to stay compatible with both, so a C
compiler never rejects the missing guard at parse time — the failure only shows up
later, at link time, in a mixed C/C++ build).

Whole-program-ish but cheap: rather than a semantic AST check, this only needs the
compile database to know which TUs are C (`.c` extension) and libclang's
preprocessor-level `get_includes()` to know what those TUs pull in — the same
mechanism `project_scan.py` already uses for header discovery, just seeded from C TUs
instead of C++ ones.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Index

from .compdb import CompileDatabase

_HEADER_SUFFIXES = {".h", ".hpp", ".hh", ".hxx"}
_EXTERN_C_RE = re.compile(r'extern\s+"C"')


@dataclass
class ExternCIssue:
    header: Path
    c_consumers: list[Path]
    reason: str


@dataclass
class ExternCReport:
    issues: list[ExternCIssue] = field(default_factory=list)


def audit_headers(compdb: CompileDatabase, project_root: Path) -> ExternCReport:
    project_root = project_root.resolve()
    index = Index.create()
    header_to_c_consumers: dict[Path, list[Path]] = {}

    for source_file in compdb.files():
        if source_file.suffix != ".c":
            continue
        args = compdb.args_for(source_file)
        if args is None:
            continue

        tu = index.parse(str(source_file), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            continue  # unparseable C TU; skip rather than fail the whole scan

        for included in tu.get_includes():
            header_path = Path(included.include.name).resolve()
            if header_path.suffix not in _HEADER_SUFFIXES:
                continue
            if project_root not in header_path.parents and header_path.parent != project_root:
                continue  # system/third-party header, not ours to flag
            header_to_c_consumers.setdefault(header_path, []).append(source_file)

    report = ExternCReport()
    for header_path, consumers in sorted(header_to_c_consumers.items()):
        text = header_path.read_text(errors="replace")
        if _EXTERN_C_RE.search(text) or "__cplusplus" in text:
            continue  # already guarded (or already conditionally handles the C case)

        report.issues.append(
            ExternCIssue(
                header=header_path,
                c_consumers=sorted(set(consumers)),
                reason='included by a C translation unit but has no extern "C" guard; '
                "declarations will get C++ name-mangled linkage and fail to link from C",
            )
        )

    return report
