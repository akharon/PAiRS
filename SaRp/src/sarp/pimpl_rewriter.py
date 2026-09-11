"""Applies ForwardDeclCandidate results to a header: removes the now-unnecessary #include
and inserts a forward declaration in its place. Never partially applies — if any candidate
looks inconsistent with the file on disk (e.g. include line moved), the whole rewrite aborts.

Every real (non-dry-run) apply is revertable: a unified-diff .sarp.patch file is written
next to the header, and the change is additionally committed if the header sits in a clean
git working tree. See safety.py for both mechanisms.
"""
from __future__ import annotations

from pathlib import Path

from .pimpl_analyzer import PimplReport
from .safety import SafetyResult, apply_with_safety_net


def _rewrite_text(report: PimplReport) -> str:
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

    return "".join(new_lines)


def apply(report: PimplReport, *, dry_run: bool = False) -> tuple[str, SafetyResult | None]:
    original = report.header_path.read_text()
    new_text = _rewrite_text(report)

    if dry_run:
        return new_text, None

    type_names = ", ".join(c.type_name for c in report.candidates)
    description = f"sarp: forward-decl rewrite in {report.header_path.name} ({type_names})"
    safety = apply_with_safety_net(report.header_path, original, new_text, description)
    return new_text, safety
