"""Applies MissingInlineCandidate results to a header: inserts `inline ` immediately
before each flagged function's return type. Byte-offset edits are applied back-to-front
so earlier insertions never shift the offsets of edits still to come.

Every real (non-dry-run) apply is revertable the same way as the other rewriters: a
unified-diff .sarp.patch file next to the header, plus a git commit when the tree is
clean. See safety.py.
"""
from __future__ import annotations

from .inline_analyzer import InlineReport
from .safety import SafetyResult, apply_with_safety_net


def _rewrite_text(report: InlineReport) -> str:
    original = report.header_path.read_text()
    text = original

    for candidate in sorted(report.candidates, key=lambda c: c.start_offset, reverse=True):
        offset = candidate.start_offset
        if offset < 0 or offset > len(text):
            raise RuntimeError(
                f"Offset {offset} out of range for {report.header_path}; aborting, no edits applied."
            )
        text = text[:offset] + "inline " + text[offset:]

    return text


def apply(report: InlineReport, *, dry_run: bool = False) -> tuple[str, SafetyResult | None]:
    original = report.header_path.read_text()
    new_text = _rewrite_text(report)

    if dry_run:
        return new_text, None

    names = ", ".join(c.function_name for c in report.candidates)
    description = f"sarp: add missing inline in {report.header_path.name} ({names})"
    safety = apply_with_safety_net(report.header_path, original, new_text, description)
    return new_text, safety
