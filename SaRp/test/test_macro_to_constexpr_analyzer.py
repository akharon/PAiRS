from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.macro_to_constexpr_analyzer import MacroToConstexprAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = MacroToConstexprAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_object_like_literal_macro_is_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\n#define MAX_SIZE 100\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].macro_name == "MAX_SIZE"
    assert report.candidates[0].kind == "object_like"
    assert "constexpr auto MAX_SIZE = 100;" == report.candidates[0].proposed


def test_single_use_function_like_macro_is_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\n#define DOUBLE_IT(x) ((x) * 2)\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].macro_name == "DOUBLE_IT"
    assert report.candidates[0].kind == "function_like"


def test_multiple_evaluation_macro_is_rejected(cpp_project):
    cpp_project.write("widget.h", "#pragma once\n#define SQUARE(x) ((x) * (x))\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert len(report.rejected) == 1
    assert report.rejected[0].macro_name == "SQUARE"


def test_stringize_macro_is_rejected(cpp_project):
    cpp_project.write("widget.h", "#pragma once\n#define STRINGIZE(x) #x\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert any(r.macro_name == "STRINGIZE" for r in report.rejected)


def test_macro_used_in_if_is_rejected(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\n#define FEATURE_FLAG 1\n#if FEATURE_FLAG\nint y;\n#endif\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert any(r.macro_name == "FEATURE_FLAG" for r in report.rejected)


def test_non_literal_object_like_macro_is_rejected(cpp_project):
    cpp_project.write("widget.h", "#pragma once\n#define TWO_TOKENS 1 + 2\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
