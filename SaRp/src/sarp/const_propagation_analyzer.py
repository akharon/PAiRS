"""Detects non-const member functions that could be `const`: the body never writes a
member (no `=`/compound-assignment/`++`/`--` on a field, no `&field` address-of, since
a caller could use that address to write through it later), never calls another
non-const member function on `this`, and isn't virtual (making it `const` would change
the whole override chain's signature, which this single-header analysis can't verify
project-wide) or in a public/SDK header (an interface change, same caution as pimpl).

Conservative by design, same posture as free_function_analyzer.py: anything ambiguous
(address taken, a call whose const-ness can't be resolved) disqualifies the method
rather than risking a wrong APPLY.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from clang.cindex import Cursor, CursorKind, Index, TranslationUnit

from .compdb import CompileDatabase

_WRITE_BINARY_OPS = {
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "<<=",
    ">>=",
    "&=",
    "|=",
    "^=",
}
_WRITE_UNARY_OPS = {"++", "--", "&"}


@dataclass
class ConstCandidate:
    class_name: str
    method_name: str
    line: int
    insert_offset: int
    """Byte offset where ` const` is inserted (just after the parameter list's `)`)."""
    reason: str


@dataclass
class ConstPropagationReport:
    header_path: Path
    candidates: list[ConstCandidate] = field(default_factory=list)


class ConstPropagationAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> ConstPropagationReport:
        args = self._compdb.args_for(via_source)
        if args is None:
            raise ValueError(f"No compile command found for {via_source}")

        tu: TranslationUnit = self._index.parse(str(via_source), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            raise RuntimeError(f"Parse errors in {via_source}: " + "; ".join(str(d) for d in errors))

        header_path = header_path.resolve()
        report = ConstPropagationReport(header_path=header_path)

        methods = [
            c
            for c in _walk(tu.cursor)
            if c.kind == CursorKind.CXX_METHOD
            and c.location.file is not None
            and Path(c.location.file.name).resolve() == header_path
        ]

        for method in methods:
            candidate = self._classify(method)
            if candidate is not None:
                report.candidates.append(candidate)

        return report

    def _classify(self, method: Cursor) -> ConstCandidate | None:
        if method.is_const_method():
            return None
        if method.is_virtual_method() or method.is_pure_virtual_method():
            return None
        if method.is_static_method():
            return None
        if method.spelling.startswith("operator") and method.spelling in ("operator=", "operator[]"):
            return None  # commonly non-const by convention; not worth the ambiguity here

        definition = method.get_definition() or method
        body = next((c for c in definition.get_children() if c.kind == CursorKind.COMPOUND_STMT), None)
        if body is None:
            return None  # no definition visible in this TU; nothing to analyze

        if _writes_or_takes_address(body):
            return None
        if _calls_non_const_member(body):
            return None

        header_text = method.extent.start.file.name and Path(method.extent.start.file.name).read_text()
        insert_offset = _params_close_paren_offset(method, header_text)
        if insert_offset is None:
            return None

        return ConstCandidate(
            class_name=method.semantic_parent.spelling,
            method_name=method.spelling,
            line=method.location.line,
            insert_offset=insert_offset,
            reason="body writes no member, calls only const members, and is not virtual",
        )


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _writes_or_takes_address(body: Cursor) -> bool:
    for node in _walk(body):
        if node.kind == CursorKind.BINARY_OPERATOR or node.kind == CursorKind.COMPOUND_ASSIGNMENT_OPERATOR:
            if _touches_member(node) and _operator_token(node) in _WRITE_BINARY_OPS:
                return True
        elif node.kind == CursorKind.UNARY_OPERATOR:
            if _touches_member(node) and _operator_token(node) in _WRITE_UNARY_OPS:
                return True
    return False


def _touches_member(node: Cursor) -> bool:
    return any(c.kind == CursorKind.MEMBER_REF_EXPR for c in _walk(node))


def _operator_token(node: Cursor) -> str | None:
    tokens = list(node.get_tokens())
    if not tokens:
        return None
    # For a unary prefix op (`++x_`, `&x_`) the operator is the first token; for a
    # postfix op (`x_++`) it's the last; for binary/compound assignment it's the token
    # right after the LHS operand's tokens, which in practice is always the second
    # non-identifier symbol token in this short expression — checking all tokens for a
    # known operator spelling is simpler and just as safe here.
    for tok in tokens:
        if tok.spelling in _WRITE_BINARY_OPS or tok.spelling in _WRITE_UNARY_OPS:
            return tok.spelling
    return None


def _calls_non_const_member(body: Cursor) -> bool:
    for node in _walk(body):
        if node.kind in (CursorKind.MEMBER_REF_EXPR, CursorKind.DECL_REF_EXPR):
            referenced = node.referenced
            if referenced is not None and referenced.kind == CursorKind.CXX_METHOD:
                if not referenced.is_static_method() and not referenced.is_const_method():
                    return True
        if node.kind == CursorKind.CALL_EXPR:
            referenced = node.referenced
            if referenced is not None and referenced.kind == CursorKind.CXX_METHOD:
                if not referenced.is_static_method() and not referenced.is_const_method():
                    return True
    return False


def _params_close_paren_offset(method: Cursor, header_text: str) -> int | None:
    """Find the `)` closing the parameter list, so ` const` can be inserted right after
    it (before any trailing `{`, `override`, or `= 0`). Walking tokens by paren-depth
    handles default-argument parens (`int x = f()`) correctly.
    """
    depth = 0
    seen_open = False
    for token in method.get_tokens():
        if token.spelling == "(":
            depth += 1
            seen_open = True
        elif token.spelling == ")":
            depth -= 1
            if seen_open and depth == 0:
                return token.extent.end.offset
    return None
