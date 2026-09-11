"""Applies NoexceptMoveCandidate results to a header: inserts `noexcept ` immediately
before the flagged move constructor's opening `{`. Byte-offset edits are applied
back-to-front so earlier insertions never shift the offsets of edits still to come.
"""
from __future__ import annotations

from .noexcept_move_analyzer import NoexceptMoveReport
from .safety import SafetyResult, apply_with_safety_net


def _rewrite_text(report: NoexceptMoveReport) -> str:
    original = report.header_path.read_text()
    text = original

    for candidate in sorted(report.candidates, key=lambda c: c.insert_offset, reverse=True):
        offset = candidate.insert_offset
        if offset < 0 or offset > len(text):
            raise RuntimeError(
                f"Offset {offset} out of range for {report.header_path}; aborting, no edits applied."
            )
        text = text[:offset] + "noexcept " + text[offset:]

    return text


def apply(report: NoexceptMoveReport, *, dry_run: bool = False) -> tuple[str, SafetyResult | None]:
    original = report.header_path.read_text()
    new_text = _rewrite_text(report)

    if dry_run:
        return new_text, None

    names = ", ".join(c.class_name for c in report.candidates)
    description = f"sarp: add noexcept to move ctor in {report.header_path.name} ({names})"
    safety = apply_with_safety_net(report.header_path, original, new_text, description)
    return new_text, safety
