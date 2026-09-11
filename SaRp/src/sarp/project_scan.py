"""Discovers every project header reachable from compile_commands.json's translation
units, and picks one .cpp "via" file per header for batch analysis.

A header only needs ONE full translation unit that includes it (directly or
transitively) to be analyzed — libclang needs a complete, compilable TU to resolve
types, but the header's own declarations don't change across TUs that include it (in
the absence of conditional-compilation tricks, which this tool doesn't attempt to
detect — see the README's stated limitations).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from clang.cindex import Index

from .compdb import CompileDatabase

_HEADER_SUFFIXES = {".h", ".hpp", ".hh", ".hxx"}


@dataclass
class HeaderTarget:
    header: Path
    via: Path


def discover_headers(compdb: CompileDatabase, project_root: Path) -> list[HeaderTarget]:
    """For every .cpp in the compile database, parse it and record which project-local
    headers it pulls in (directly or transitively). The FIRST .cpp (in compdb order)
    that reaches a given header wins as that header's --via file.
    """
    project_root = project_root.resolve()
    index = Index.create()
    header_to_via: dict[Path, Path] = {}

    for source_file in compdb.files():
        args = compdb.args_for(source_file)
        if args is None:
            continue

        tu = index.parse(str(source_file), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            continue  # unparseable TU; skip rather than fail the whole scan

        for included in tu.get_includes():
            header_path = Path(included.include.name).resolve()
            if header_path.suffix not in _HEADER_SUFFIXES:
                continue
            if project_root not in header_path.parents and header_path.parent != project_root:
                continue  # system/third-party header, not ours to rewrite
            header_to_via.setdefault(header_path, source_file)

    return [HeaderTarget(header=h, via=v) for h, v in sorted(header_to_via.items())]
