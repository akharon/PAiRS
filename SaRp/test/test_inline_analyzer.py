from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.inline_analyzer import InlineAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = InlineAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_plain_function_defined_in_header_is_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nint plainFunc(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].function_name == "plainFunc"


def test_already_inline_function_is_not_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\ninline int plainFunc(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_constexpr_function_is_not_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nconstexpr int plainFunc(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_static_function_is_not_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstatic int plainFunc(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_template_function_is_not_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\ntemplate<typename T> T identity(T x) { return x; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_declaration_only_is_not_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nint declOnly(int x);\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\nint declOnly(int x) { return x; }\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
