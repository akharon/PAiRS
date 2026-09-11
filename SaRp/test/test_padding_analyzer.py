from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.padding_analyzer import PaddingAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = PaddingAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_poorly_packed_struct_is_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Bad {\n    char a;\n    int b;\n    char c;\n    double d;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    candidate = report.candidates[0]
    assert candidate.class_name == "Bad"
    assert candidate.savings_bytes > 0
    assert candidate.proposed_order == ["d", "b", "a", "c"]


def test_already_optimally_packed_struct_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Good {\n    double d;\n    int b;\n    char a;\n    char c;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_class_with_base_is_skipped(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Base { int x; };\n"
        "struct Derived : Base {\n    char a;\n    int b;\n    char c;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert "Derived" in report.skipped
    assert all(c.class_name != "Derived" for c in report.candidates)


def test_class_with_virtual_is_skipped(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    virtual ~Widget() = default;\n    char a;\n    int b;\n    char c;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert "Widget" in report.skipped


def test_single_field_struct_is_skipped(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstruct Widget {\n    int x;\n};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert "Widget" in report.skipped
    assert report.candidates == []
