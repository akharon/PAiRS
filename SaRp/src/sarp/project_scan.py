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
    headers it pulls in (directly or transitively).

    Picking the --via file matters beyond "any TU that can parse the header": the
    free-function analysis needs a TU that actually contains a method's out-of-line
    *definition*, not just its declaration (a TU that only sees the header via a
    transitive #include has the declaration but not the body, so the analyzer correctly
    treats every method as "no definition visible" and finds nothing — a real bug this
    was written to fix). The idiomatic .cpp that implements a header shares its basename
    (widget.h <-> widget.cpp), so that pairing is preferred when it exists among the
    includers; otherwise the first includer (in compdb order) is used, same as before.
    """
    project_root = project_root.resolve()
    index = Index.create()
    header_to_includers: dict[Path, list[Path]] = {}

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
            header_to_includers.setdefault(header_path, []).append(source_file)

    targets = []
    for header_path, includers in header_to_includers.items():
        via = _pick_via(header_path, includers)
        targets.append(HeaderTarget(header=header_path, via=via))

    return sorted(targets, key=lambda t: t.header)


def _pick_via(header_path: Path, includers: list[Path]) -> Path:
    same_basename = [c for c in includers if c.stem == header_path.stem]
    return same_basename[0] if same_basename else includers[0]
