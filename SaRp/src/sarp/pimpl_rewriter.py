"""Applies ForwardDeclCandidate results to a header: removes the now-unnecessary #include
and inserts a forward declaration in its place. Never partially applies — if any candidate
looks inconsistent with the file on disk (e.g. include line moved), the whole rewrite aborts.
"""
from __future__ import annotations

from pathlib import Path

from .pimpl_analyzer import PimplReport


def apply(report: PimplReport, *, dry_run: bool = False) -> str:
    original = report.header_path.read_text()
    lines = original.splitlines(keepends=True)

    replacements: list[tuple[int, str]] = []
    for candidate in report.candidates:
        idx = candidate.include_line - 1
        if idx < 0 or idx >= len(lines):
            raise RuntimeError(
                f"Include line {candidate.include_line} out of range for {report.header_path}; aborting, no edits applied."
            )
        if "#include" not in lines[idx]:
            raise RuntimeError(
                f"Expected #include at line {candidate.include_line} of {report.header_path}, "
                f"found: {lines[idx]!r}. Aborting, no edits applied."
            )
        replacements.append((idx, f"class {candidate.type_name};\n"))

    new_lines = list(lines)
    for idx, replacement in replacements:
        new_lines[idx] = replacement

    new_text = "".join(new_lines)

    if not dry_run:
        report.header_path.write_text(new_text)

    return new_text
