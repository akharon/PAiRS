from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.static_header_analyzer import StaticHeaderAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = StaticHeaderAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_static_function_is_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstatic int helper(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].name == "helper"
    assert report.candidates[0].kind == "function"


def test_static_variable_is_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstatic int counter = 0;\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].name == "counter"
    assert report.candidates[0].kind == "variable"


def test_static_class_member_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    static int count;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nint Widget::count = 0;\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_already_inline_variable_is_not_a_candidate(cpp_project):
    cpp_project.write("widget.h", "#pragma once\ninline int counter = 0;\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_pre_cxx17_target_rejects_entirely(cpp_project, monkeypatch):
    cpp_project.write("widget.h", "#pragma once\nstatic int helper(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    import json

    cc_path = cpp_project.compile_commands_path()
    entries = json.loads(cc_path.read_text())
    for entry in entries:
        entry["arguments"] = [a for a in entry["arguments"] if not a.startswith("-std=")]
        entry["arguments"].insert(1, "-std=c++14")
    cc_path.write_text(json.dumps(entries))

    compdb = CompileDatabase.load(cc_path)
    analyzer = StaticHeaderAnalyzer(compdb)
    report = analyzer.analyze_header(cpp_project.root / "widget.h", cpp_project.root / "widget.cpp")

    assert report.rejected_pre_cxx17
    assert report.candidates == []
