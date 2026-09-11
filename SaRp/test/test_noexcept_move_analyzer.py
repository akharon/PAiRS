from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.noexcept_move_analyzer import NoexceptMoveAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = NoexceptMoveAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_throwing_move_ctor_with_no_members_is_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    Widget(Widget&&) {}\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].class_name == "Widget"


def test_member_with_noexcept_move_makes_outer_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\n"
        "struct Inner {\n    Inner() = default;\n    Inner(Inner&&) noexcept = default;\n};\n"
        "struct Outer {\n    Inner i;\n    Outer() = default;\n    Outer(Outer&&) {}\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    names = [c.class_name for c in report.candidates]
    assert "Outer" in names


def test_member_with_throwing_move_disqualifies_outer(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\n"
        "struct ThrowingInner {\n    ThrowingInner() = default;\n    ThrowingInner(ThrowingInner&&) {}\n};\n"
        "struct Outer {\n    ThrowingInner t;\n    Outer() = default;\n    Outer(Outer&&) {}\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    outer_candidates = [c for c in report.candidates if c.class_name == "Outer"]
    assert outer_candidates == []
    assert "Outer" in report.skipped


def test_already_noexcept_move_ctor_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    Widget(Widget&&) noexcept {}\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_defaulted_move_ctor_is_not_a_candidate(cpp_project):
    """Implicitly-defaulted move ctors already get correct noexcept-ness from the
    compiler; Sarp only proposes edits for user-PROVIDED (has a body) move ctors.
    """
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    Widget(Widget&&) = default;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_out_of_line_move_ctor_is_not_a_candidate(cpp_project):
    """The move ctor's body isn't visible from the header declaration alone; Sarp
    doesn't attempt a header-signature-only edit for a definition it hasn't inspected.
    """
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    Widget() = default;\n    Widget(Widget&&);\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nWidget::Widget(Widget&&) {}\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
