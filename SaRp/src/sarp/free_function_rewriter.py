"""Rewrites a FreeFunctionCandidate's declaration (header) and out-of-line definition
(.cpp, if present) from a member function into a free function taking the object as an
explicit first parameter. Call sites are NEVER rewritten automatically — see
call_sites.py; they are reported so the user can update them by hand, since finding
every call site project-wide and rewriting them atomically is a larger, riskier
operation than this tool currently attempts (same one-shot-per-file safety model as
pimpl_rewriter, but scoped to declaration + definition only).
"""
from __future__ import annotations

from pathlib import Path

from .free_function_analyzer import FreeFunctionCandidate, SourceSpan
from .safety import SafetyResult, apply_with_safety_net


def _self_param(candidate: FreeFunctionCandidate) -> str:
    const = "const " if candidate.is_const else ""
    return f"{const}{candidate.class_name}& self"


def _free_function_signature(candidate: FreeFunctionCandidate, *, with_body_placeholder: bool = False) -> str:
    params = [_self_param(candidate)]
    params += [f"{t} {n}" for t, n in zip(candidate.param_types, candidate.param_names)]
    return f"{candidate.return_type} {candidate.method_name}({', '.join(params)})"


def _rewrite_span(text: str, span: SourceSpan, replacement: str) -> str:
    return text[: span.start_offset] + replacement + text[span.end_offset :]


def _rewrite_header(header_original: str, candidate: FreeFunctionCandidate) -> str:
    """Removes the member declaration line from inside the class and inserts a free
    function declaration immediately after the class's closing `};`. Two edits to the
    same text, applied end-of-file-first so the earlier offset (inside the class) stays
    valid after the later one (after the class) has already been applied.
    """
    free_decl = f"\n{_free_function_signature(candidate)};\n"
    with_insertion = (
        header_original[: candidate.enclosing_class_end_offset]
        + free_decl
        + header_original[candidate.enclosing_class_end_offset :]
    )
    # declaration_span offsets are relative to header_original (before the insertion
    # above), and the insertion point is after the class — i.e. after the declaration —
    # so those offsets are still valid in with_insertion.
    return (
        with_insertion[: candidate.declaration_span.start_offset]
        + with_insertion[candidate.declaration_span.end_offset :]
    )


def _rewrite_definition_body(original: str, candidate: FreeFunctionCandidate, span: SourceSpan) -> str:
    """Replace `ClassName::method(params) [const] { body }` with the free-function form.
    We keep the original body verbatim (offsets relative to the definition span cover the
    whole `ReturnType ClassName::method(...) { ... }`), just swap the signature: everything
    up to (and not including) the body's opening `{` is regenerated, the `{ ... }` body text
    is preserved byte-for-byte since `this->`/bare-member usage was already proven absent by
    the analyzer (a non-state-touching body cannot reference anything that becomes invalid
    when `this` is replaced by an explicit `self` parameter).
    """
    def_text = original[span.start_offset : span.end_offset]
    brace_idx = def_text.find("{")
    if brace_idx == -1:
        raise RuntimeError("Could not locate definition body opening brace; aborting, no edits applied.")
    body = def_text[brace_idx:]
    new_signature = _free_function_signature(candidate)
    return new_signature + " " + body


def apply(candidate: FreeFunctionCandidate, *, dry_run: bool = False) -> dict[Path, tuple[str, SafetyResult | None]]:
    """Returns {file: (new_text, safety_result)} for each file touched (header always;
    .cpp only if an out-of-line definition was found). safety_result is None in dry_run.
    """
    results: dict[Path, tuple[str, SafetyResult | None]] = {}

    header_original = candidate.declaration_span.file.read_text()
    header_new_text = _rewrite_header(header_original, candidate)

    if dry_run:
        results[candidate.declaration_span.file] = (header_new_text, None)
    else:
        description = f"sarp: convert {candidate.class_name}::{candidate.method_name} to a free function"
        safety = apply_with_safety_net(
            candidate.declaration_span.file, header_original, header_new_text, description
        )
        results[candidate.declaration_span.file] = (header_new_text, safety)

    if candidate.definition_span is not None:
        def_original = candidate.definition_span.file.read_text()
        replacement = _rewrite_definition_body(def_original, candidate, candidate.definition_span)
        def_new_text = _rewrite_span(def_original, candidate.definition_span, replacement)

        if dry_run:
            results[candidate.definition_span.file] = (def_new_text, None)
        else:
            description = f"sarp: convert {candidate.class_name}::{candidate.method_name} to a free function"
            safety = apply_with_safety_net(
                candidate.definition_span.file, def_original, def_new_text, description
            )
            results[candidate.definition_span.file] = (def_new_text, safety)

    return results
