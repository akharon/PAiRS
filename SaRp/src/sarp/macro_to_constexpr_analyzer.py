"""Detects object-like macros with a single literal value, and function-like macros
whose expansion is a single parenthesized expression evaluating each parameter exactly
once, and proposes converting them to a `constexpr`/`inline` equivalent: type safety
(the macro has no type, so it silently participates in wrong-type arithmetic or
comparisons) and debuggability (a macro has no symbol the debugger can show; a
constexpr does) are the payoff, and this is explicitly MISRA-relevant.

Detection is textual/preprocessor-level (like the include-guard audit), not AST-based:
libclang's macro-definition cursor gives the *definition* tokens but not where the
macro is *used*, so "used in #if" and "double-evaluates an argument" are both checked
against the macro's own token text, conservatively — a macro is only ever proposed when
we're confident it fits, matching the project's binary APPLY/REJECT contract:

- **Object-like, single literal**: `#define NAME <int/float/char/string literal>` with
  no other tokens. Becomes `constexpr auto NAME = <literal>;` (or a caller-supplied
  type, which this analyzer doesn't infer — `auto` is always correct for a single
  literal).
- **Function-like, single expression, each param used once**: the replacement-list
  tokens must be exactly one parenthesized expression (balanced parens wrapping
  everything), and each parameter name may appear at most once in it — multiple
  appearances risk (and, for the classic `((x)+(x))` shape, guarantee) evaluating a
  side-effecting argument more than once, which a `constexpr` function form cannot
  reproduce and must not silently change the behavior of. The proposed replacement is a
  `template <typename T0, ...> constexpr auto NAME(T0 x, ...)` function (not an
  abbreviated `auto`-parameter template, which needs C++20) so it compiles for any
  target this project already builds.

Rejected outright (never proposed): used inside `#if`/`#elif`/`#ifdef`/`#ifndef`
anywhere in the header (constexpr values aren't visible to the preprocessor), any
`#` (stringize) or `##` (token-paste) operator in the replacement list (these have no
constexpr equivalent), and macros with zero or more than one parameter appearance
ambiguity — see above.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, TranslationUnit

from .compdb import CompileDatabase

_LITERAL_RE = re.compile(
    r"^(-?\d+\.\d+[fFlL]?|-?\d+[uUlL]*|-?0[xX][0-9a-fA-F]+[uUlL]*|'.'|\".*\")$"
)
_DIRECTIVE_RE = re.compile(r"^\s*#\s*(if|ifdef|ifndef|elif)\b")


@dataclass
class MacroCandidate:
    macro_name: str
    line: int
    kind: str  # "object_like" or "function_like"
    proposed: str
    reason: str


@dataclass
class MacroRejection:
    macro_name: str
    line: int
    reason: str


@dataclass
class MacroReport:
    header_path: Path
    candidates: list[MacroCandidate] = field(default_factory=list)
    rejected: list[MacroRejection] = field(default_factory=list)


class MacroToConstexprAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> MacroReport:
        args = self._compdb.args_for(via_source)
        if args is None:
            raise ValueError(f"No compile command found for {via_source}")

        tu: TranslationUnit = self._index.parse(
            str(via_source), args=args, options=TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD
        )
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            raise RuntimeError(f"Parse errors in {via_source}: " + "; ".join(str(d) for d in errors))

        header_path = header_path.resolve()
        report = MacroReport(header_path=header_path)

        used_in_conditional = _macros_used_in_conditionals(header_path)

        for cursor in tu.cursor.get_children():
            if cursor.kind != CursorKind.MACRO_DEFINITION:
                continue
            if cursor.location.file is None or Path(cursor.location.file.name).resolve() != header_path:
                continue

            self._classify(cursor, used_in_conditional, report)

        report.candidates.sort(key=lambda c: c.line)
        report.rejected.sort(key=lambda r: r.line)
        return report

    def _classify(self, cursor: Cursor, used_in_conditional: set[str], report: MacroReport) -> None:
        name = cursor.spelling
        line = cursor.location.line
        tokens = [t.spelling for t in cursor.get_tokens()]
        if not tokens or tokens[0] != name:
            return
        body_tokens = tokens[1:]

        if name in used_in_conditional:
            report.rejected.append(MacroRejection(name, line, "used in #if/#ifdef/#elif; not visible to the preprocessor as constexpr"))
            return

        if "#" in body_tokens:
            report.rejected.append(MacroRejection(name, line, "uses # (stringize) or ## (token-paste); no constexpr equivalent"))
            return

        is_function_like = bool(body_tokens) and body_tokens[0] == "("
        if not is_function_like:
            self._classify_object_like(name, line, body_tokens, report)
        else:
            self._classify_function_like(name, line, body_tokens, report)

    def _classify_object_like(self, name: str, line: int, body_tokens: list[str], report: MacroReport) -> None:
        if len(body_tokens) != 1 or not _LITERAL_RE.match(body_tokens[0]):
            report.rejected.append(
                MacroRejection(name, line, "object-like macro is not a single literal value")
            )
            return

        report.candidates.append(
            MacroCandidate(
                macro_name=name,
                line=line,
                kind="object_like",
                proposed=f"constexpr auto {name} = {body_tokens[0]};",
                reason="object-like macro with a single literal value",
            )
        )

    def _classify_function_like(self, name: str, line: int, body_tokens: list[str], report: MacroReport) -> None:
        close_paren_idx = _matching_paren(body_tokens, 0)
        if close_paren_idx is None:
            report.rejected.append(MacroRejection(name, line, "malformed parameter list"))
            return
        params = [t for t in body_tokens[1:close_paren_idx] if t != ","]
        expansion = body_tokens[close_paren_idx + 1 :]

        if not expansion:
            report.rejected.append(MacroRejection(name, line, "empty expansion"))
            return
        if expansion[0] != "(" or _matching_paren(expansion, 0) != len(expansion) - 1:
            report.rejected.append(
                MacroRejection(name, line, "expansion is not a single parenthesized expression")
            )
            return

        for param in params:
            if expansion.count(param) > 1:
                report.rejected.append(
                    MacroRejection(
                        name,
                        line,
                        f"parameter '{param}' appears more than once in the expansion "
                        "(would evaluate a side-effecting argument multiple times)",
                    )
                )
                return

        template_params = ", ".join(f"typename T{i}" for i in range(len(params)))
        param_list = ", ".join(f"T{i} {p}" for i, p in enumerate(params))
        expansion_text = " ".join(expansion)
        template_prefix = f"template <{template_params}> " if params else ""
        report.candidates.append(
            MacroCandidate(
                macro_name=name,
                line=line,
                kind="function_like",
                proposed=f"{template_prefix}constexpr auto {name}({param_list}) {{ return {expansion_text}; }}",
                reason="function-like macro whose expansion is a single expression evaluating each parameter once",
            )
        )


def _matching_paren(tokens: list[str], open_idx: int) -> int | None:
    if tokens[open_idx] != "(":
        return None
    depth = 0
    for i in range(open_idx, len(tokens)):
        if tokens[i] == "(":
            depth += 1
        elif tokens[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return None


def _macros_used_in_conditionals(header_path: Path) -> set[str]:
    """Textual scan for identifiers appearing in #if/#ifdef/#ifndef/#elif directives
    anywhere in the header. Deliberately over-inclusive (any identifier on such a line
    is treated as "used in a conditional", even if it's unrelated to a #define
    elsewhere in the file) since a false REJECT is always safe, a false APPLY is not.
    """
    used: set[str] = set()
    for line in header_path.read_text(errors="replace").splitlines():
        if _DIRECTIVE_RE.match(line):
            used.update(re.findall(r"[A-Za-z_]\w*", line))
    return used
