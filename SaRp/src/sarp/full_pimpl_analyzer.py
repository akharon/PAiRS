"""Detects classes eligible for the FULL pimpl idiom: moving every private data member
into a `struct Impl` defined in the .cpp, replaced by a single
`std::unique_ptr<Impl> impl_` member in the header. Unlike pimpl_analyzer.py (which only
prunes an #include down to a forward declaration when a type is merely referenced by
pointer/reference), this rewrites the class's own shape.

Conservative eligibility, by design — a class only qualifies when ALL of the following
hold, so the rewrite can be applied mechanically without risking a change in behavior:

- Every private member is a DATA field (no private methods — redirecting private
  method calls through impl_-> is possible in principle, but multiplies the rewrite's
  surface area and risk for marginal benefit; a class with private helper methods is
  simply not offered as a candidate for now).
- No protected members at all (pimpl cleanly owns "this class's private state"; a
  protected member is visible to subclasses and moving it into an Impl the subclass
  can't see would change behavior for any existing derived class).
- Not polymorphic in a way that matters here: virtual methods are allowed (they don't
  reference impl_ any differently), but the class must not itself be an incomplete
  forward-declared type already, and must have an out-of-line-definable destructor
  (unique_ptr<Impl> with an incomplete Impl requires the destructor to be defined where
  Impl is complete — i.e. in the .cpp, which this tool already requires for the
  rewrite to compile).
- No private static members (those aren't per-instance state and don't belong in Impl;
  a class that has them is skipped rather than silently mishandled).
- Every method that reads/writes a private field must have its DEFINITION visible in
  this translation unit (in the header inline, or out-of-line in the .cpp reached via
  --via) — a method whose body isn't visible can't be safely rewritten to go through
  impl_->field, so its presence disqualifies the whole class.
"""
from __future__ import annotations

from dataclasses import dataclass, field as dc_field
from pathlib import Path

from clang.cindex import AccessSpecifier, Cursor, CursorKind, Index, TranslationUnit

from .compdb import CompileDatabase


@dataclass
class FieldAccess:
    """One reference to a private field, found inside some method's body."""
    field_name: str
    file: Path
    start_offset: int
    end_offset: int


@dataclass
class ConstructorBody:
    """Where a constructor's `{` opening brace sits — impl_ must be constructed as the
    very first statement, since every field access inside the body is rewritten to go
    through impl_->, which would dereference null if impl_ weren't allocated first.
    """
    file: Path
    body_open_offset: int
    """Offset of the character immediately after the body's opening `{`."""


@dataclass
class FullPimplCandidate:
    class_name: str
    header_path: Path
    class_body_start_offset: int
    class_body_end_offset: int
    """Span of the whole `class X { ... };` in the header, to rewrite in one piece."""
    private_fields: list[str]
    """Field declarations' full text (including trailing `;`), moved verbatim into Impl."""
    field_accesses: list[FieldAccess]
    """Every `field_name` reference inside a method body, header or .cpp, to rewrite to `impl_->field_name`."""
    constructor_bodies: list[ConstructorBody]
    """Every constructor definition's body-open position, needing an `impl_ = std::make_unique<Impl>();` inserted first."""
    has_user_declared_constructor: bool
    needs_out_of_line_destructor: bool
    """True if the class has no user-declared destructor yet (one must be added, since
    unique_ptr<Impl> with an incomplete Impl requires an out-of-line ~ClassName())."""
    reason: str


@dataclass
class FullPimplReport:
    header_path: Path
    candidates: list[FullPimplCandidate] = dc_field(default_factory=list)
    skipped: dict[str, str] = dc_field(default_factory=dict)
    """class_name -> reason it was NOT offered as a candidate."""


class FullPimplAnalyzer:
    def __init__(self, compdb: CompileDatabase):
        self._compdb = compdb
        self._index = Index.create()

    def analyze_header(self, header_path: Path, via_source: Path) -> FullPimplReport:
        args = self._compdb.args_for(via_source)
        if args is None:
            raise ValueError(f"No compile command found for {via_source}")

        tu: TranslationUnit = self._index.parse(str(via_source), args=args)
        errors = [d for d in tu.diagnostics if d.severity >= 3]
        if errors:
            raise RuntimeError(f"Parse errors in {via_source}: " + "; ".join(str(d) for d in errors))

        header_path = header_path.resolve()
        report = FullPimplReport(header_path=header_path)

        class_decls = [
            c
            for c in _walk(tu.cursor)
            if c.kind == CursorKind.CLASS_DECL
            and c.location.file is not None
            and Path(c.location.file.name).resolve() == header_path
            and c.is_definition()
        ]

        for class_decl in class_decls:
            self._check_class(class_decl, header_path, report)

        return report

    def _check_class(self, class_decl: Cursor, header_path: Path, report: FullPimplReport) -> None:
        name = class_decl.spelling
        children = list(class_decl.get_children())

        protected_members = [c for c in children if c.access_specifier == AccessSpecifier.PROTECTED]
        if protected_members:
            report.skipped[name] = "has protected member(s); pimpl only manages private state"
            return

        private_fields = [c for c in children if c.kind == CursorKind.FIELD_DECL and c.access_specifier == AccessSpecifier.PRIVATE]
        private_methods = [
            c
            for c in children
            if c.kind == CursorKind.CXX_METHOD
            and c.access_specifier == AccessSpecifier.PRIVATE
        ]
        if private_methods:
            report.skipped[name] = f"has {len(private_methods)} private method(s); not supported yet"
            return

        if not private_fields:
            report.skipped[name] = "has no private data members; nothing to move into Impl"
            return

        # Static data members surface as VAR_DECL (not FIELD_DECL — they aren't
        # per-instance state), so private_fields never includes them; check separately.
        private_static_vars = [c for c in children if c.kind == CursorKind.VAR_DECL and c.access_specifier == AccessSpecifier.PRIVATE]
        if private_static_vars:
            report.skipped[name] = "has static private member(s); not supported"
            return

        field_names = {f.spelling for f in private_fields}

        methods = [
            c
            for c in children
            if c.kind in (CursorKind.CXX_METHOD, CursorKind.CONSTRUCTOR, CursorKind.DESTRUCTOR)
        ]

        field_accesses: list[FieldAccess] = []
        constructor_bodies: list[ConstructorBody] = []
        constructors = [c for c in children if c.kind == CursorKind.CONSTRUCTOR]

        for method in methods:
            definition = method.get_definition() or (method if _has_inline_body(method) else None)
            if definition is None:
                if _references_any_field(method, field_names):
                    # Declared but no definition visible in this TU — could touch a
                    # private field in a way we can't rewrite; be conservative.
                    report.skipped[name] = (
                        f"method '{method.spelling}' has no definition visible in this translation unit"
                    )
                    return
                if method.kind == CursorKind.CONSTRUCTOR:
                    report.skipped[name] = (
                        f"constructor '{method.displayname}' has no definition visible in this translation unit "
                        f"(impl_ must be constructed in its body)"
                    )
                    return
                continue

            if definition.kind == CursorKind.CONSTRUCTOR:
                if _has_member_initializer_for(definition, field_names):
                    # A member-initializer-list entry (`: x_(x)`) needs a structural
                    # move into Impl's own constructor, not a text substitution like a
                    # body access — out of scope for the mechanical rewriter. Skip the
                    # whole class rather than half-handle it.
                    report.skipped[name] = (
                        f"constructor initializes a private field via a member-initializer list "
                        f"(`: {next(iter(field_names))}(...)`-style); not supported, initialize in the body instead"
                    )
                    return
                constructor_bodies.append(_constructor_body_span(definition))

            accesses = _find_field_accesses(definition, field_names)
            field_accesses.extend(accesses)

        if not constructors:
            report.skipped[name] = (
                "has no user-declared constructor; the compiler-generated default "
                "constructor can't be given an impl_ initializer — add an explicit "
                "constructor first"
            )
            return

        has_ctor = True
        has_dtor = any(c.kind == CursorKind.DESTRUCTOR for c in children)

        class_extent = class_decl.extent
        semicolon_offset = _find_class_semicolon(header_path, class_extent.end.offset)

        report.candidates.append(
            FullPimplCandidate(
                class_name=name,
                header_path=header_path,
                class_body_start_offset=class_extent.start.offset,
                class_body_end_offset=semicolon_offset,
                private_fields=[_field_decl_text(f) for f in private_fields],
                field_accesses=field_accesses,
                constructor_bodies=constructor_bodies,
                has_user_declared_constructor=has_ctor,
                needs_out_of_line_destructor=not has_dtor,
                reason=f"{len(private_fields)} private field(s), all accesses in {'inline' if not field_accesses else 'analyzed'} method bodies",
            )
        )


def _walk(cursor: Cursor):
    yield cursor
    for child in cursor.get_children():
        yield from _walk(child)


def _has_inline_body(method: Cursor) -> bool:
    return any(c.kind == CursorKind.COMPOUND_STMT for c in method.get_children())


def _constructor_body_span(constructor: Cursor) -> ConstructorBody:
    body = next(c for c in constructor.get_children() if c.kind == CursorKind.COMPOUND_STMT)
    extent = body.extent
    # extent.start is the body's opening `{` itself; +1 lands right after it, where an
    # `impl_ = std::make_unique<Impl>();` statement can be inserted as the first line.
    return ConstructorBody(
        file=Path(extent.start.file.name).resolve(),
        body_open_offset=extent.start.offset + 1,
    )


def _references_any_field(method: Cursor, field_names: set[str]) -> bool:
    for node in _walk(method):
        if node.kind == CursorKind.MEMBER_REF_EXPR and node.spelling in field_names:
            return True
    return False


def _has_member_initializer_for(constructor: Cursor, field_names: set[str]) -> bool:
    """Constructor member-initializer-list entries (`Widget::Widget(int x) : x_(x) {}`)
    surface as MEMBER_REF children of the CONSTRUCTOR cursor (a different kind than the
    MEMBER_REF_EXPR used for in-body field access) — check those separately.
    """
    for child in constructor.get_children():
        if child.kind == CursorKind.MEMBER_REF and child.spelling in field_names:
            return True
    return False


def _find_field_accesses(method_definition: Cursor, field_names: set[str]) -> list[FieldAccess]:
    accesses = []
    for node in _walk(method_definition):
        if node.kind != CursorKind.MEMBER_REF_EXPR:
            continue
        if node.spelling not in field_names:
            continue
        referenced = node.referenced
        if referenced is None or referenced.kind != CursorKind.FIELD_DECL:
            continue
        extent = node.extent
        # The MEMBER_REF_EXPR's extent for an implicit-`this` access (`x_`, not
        # `this->x_`) covers exactly the field name token — rewriting that span to
        # `impl_->x_` is a precise, minimal edit.
        accesses.append(
            FieldAccess(
                field_name=node.spelling,
                file=Path(extent.start.file.name).resolve(),
                start_offset=extent.start.offset,
                end_offset=extent.end.offset,
            )
        )
    return accesses


def _field_decl_text(field_cursor: Cursor) -> str:
    """Full declaration INCLUDING the trailing `;` — a field's extent (like a method
    declaration's, elsewhere in this codebase) ends right after the type/initializer,
    not after the semicolon, so it must be located explicitly.
    """
    extent = field_cursor.extent
    text = Path(extent.start.file.name).read_text()
    semicolon = text.find(";", extent.end.offset)
    end = semicolon + 1 if semicolon != -1 else extent.end.offset
    return text[extent.start.offset : end]


def _find_class_semicolon(header_path: Path, class_extent_end_offset: int) -> int:
    text = header_path.read_text()
    semicolon = text.find(";", class_extent_end_offset)
    return semicolon + 1 if semicolon != -1 else class_extent_end_offset
