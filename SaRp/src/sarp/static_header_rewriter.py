"""Applies StaticHeaderCandidate results to a header: replaces the leading `static`
keyword with `inline` (C++17 inline variables / free functions). Edits are applied
back-to-front by byte offset so earlier replacements never shift offsets still to come.

Aborts the whole rewrite (no partial edits) if the text at a candidate's offset isn't
literally `static` — a defensive check against the file having changed since analysis.
"""
from __future__ import annotations

from .safety import SafetyResult, apply_with_safety_net
from .static_header_analyzer import StaticHeaderReport


def _rewrite_text(report: StaticHeaderReport) -> str:
    original = report.header_path.read_text()
    text = original

    for candidate in sorted(report.candidates, key=lambda c: c.start_offset, reverse=True):
        offset = candidate.start_offset
        end = offset + len("static")
        if text[offset:end] != "static":
            raise RuntimeError(
                f"Expected 'static' at offset {offset} of {report.header_path}, "
                f"found: {text[offset:end]!r}. Aborting, no edits applied."
            )
        text = text[:offset] + "inline" + text[end:]

    return text


def apply(report: StaticHeaderReport, *, dry_run: bool = False) -> tuple[str, SafetyResult | None]:
    original = report.header_path.read_text()
    new_text = _rewrite_text(report)

    if dry_run:
        return new_text, None

    names = ", ".join(c.name for c in report.candidates)
    description = f"sarp: static -> inline in {report.header_path.name} ({names})"
    safety = apply_with_safety_net(report.header_path, original, new_text, description)
    return new_text, safety
