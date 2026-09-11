"""Rewrites call sites found by call_sites.py from member-call syntax to free-function
syntax: `obj.method(args)` -> `method(obj, args)`, `obj->method(args)` ->
`method(*obj, args)`.

Grouped and applied per-file (a call site's file may differ from the free function's
own declaration/definition files), each going through the same patch+git safety net as
every other SaRp rewrite. Purely mechanical text substitution — the object and argument
expressions are copied verbatim from their own source spans, never re-synthesized, so
side effects, operator precedence, and comments inside them are preserved exactly.
"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from .free_function_analyzer import CallSite
from .safety import SafetyResult, apply_with_safety_net


def _rewrite_one_call(text: str, site: CallSite, method_name: str) -> str:
    obj_text = text[site.object_start_offset : site.object_end_offset]
    if site.object_is_pointer:
        obj_text = f"*{obj_text}"

    arg_texts = [text[start:end] for start, end in site.arg_spans]
    new_call = f"{method_name}({', '.join([obj_text, *arg_texts])})"

    return text[: site.call_start_offset] + new_call + text[site.call_end_offset :]


def _rewrite_file(file_path: Path, sites: list[CallSite], method_name: str) -> str:
    text = file_path.read_text()
    # Apply in descending offset order so earlier offsets in the same file stay valid
    # as later (i.e. higher-offset) edits are applied first.
    for site in sorted(sites, key=lambda s: s.call_start_offset, reverse=True):
        text = _rewrite_one_call(text, site, method_name)
    return text


def apply(
    sites: list[CallSite], method_name: str, *, dry_run: bool = False
) -> dict[Path, tuple[str, SafetyResult | None]]:
    """Rewrites every call site, grouped by file (a method can be called from many
    files). Returns {file: (new_text, safety_result)}; safety_result is None in
    dry_run. Files are independent — if a later file's git precondition check fails,
    earlier files are NOT rolled back (each file's patch is still valid and revertable
    on its own; this mirrors free_function_rewriter's per-file safety-net behavior).

    Sites with rewritable=False (e.g. inside a macro expansion, where libclang's
    cursor extents can't be trusted for a text edit) are silently excluded here — the
    caller is responsible for reporting them separately so the user updates them by
    hand, same as it already does for any call site before this rewriter existed.
    """
    rewritable_sites = [s for s in sites if s.rewritable]

    by_file: dict[Path, list[CallSite]] = defaultdict(list)
    for site in rewritable_sites:
        by_file[site.file].append(site)

    results: dict[Path, tuple[str, SafetyResult | None]] = {}
    for file_path, file_sites in by_file.items():
        original = file_path.read_text()
        new_text = _rewrite_file(file_path, file_sites, method_name)

        if dry_run:
            results[file_path] = (new_text, None)
            continue

        description = f"sarp: update {len(file_sites)} call site(s) of {method_name} to free-function syntax"
        safety = apply_with_safety_net(file_path, original, new_text, description)
        results[file_path] = (new_text, safety)

    return results
