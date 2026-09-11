"""Applies ConstCandidate results to a header: inserts ` const` immediately after the
flagged method's parameter-list `)`. Byte-offset edits are applied back-to-front so
earlier insertions never shift the offsets of edits still to come.
"""
from __future__ import annotations

from .const_propagation_analyzer import ConstPropagationReport
from .safety import SafetyResult, apply_with_safety_net


def _rewrite_text(report: ConstPropagationReport) -> str:
    original = report.header_path.read_text()
    text = original

    for candidate in sorted(report.candidates, key=lambda c: c.insert_offset, reverse=True):
        offset = candidate.insert_offset
        if offset < 0 or offset > len(text):
            raise RuntimeError(
                f"Offset {offset} out of range for {report.header_path}; aborting, no edits applied."
            )
        text = text[:offset] + " const" + text[offset:]

    return text


def apply(report: ConstPropagationReport, *, dry_run: bool = False) -> tuple[str, SafetyResult | None]:
    original = report.header_path.read_text()
    new_text = _rewrite_text(report)

    if dry_run:
        return new_text, None

    names = ", ".join(f"{c.class_name}::{c.method_name}" for c in report.candidates)
    description = f"sarp: add const in {report.header_path.name} ({names})"
    safety = apply_with_safety_net(report.header_path, original, new_text, description)
    return new_text, safety
