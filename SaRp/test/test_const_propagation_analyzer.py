from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.const_propagation_analyzer import ConstPropagationAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = ConstPropagationAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_read_only_method_is_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    int peek() { return x_; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].method_name == "peek"


def test_write_via_assignment_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    void setX(int v) { x_ = v; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_increment_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    void incr() { x_++; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_address_taken_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    int* addr() { return &x_; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_virtual_method_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    virtual int peek() { return x_; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_already_const_method_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    int peek() const { return x_; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_calling_non_const_member_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    void setX(int v) { x_ = v; }\n"
        "    void resetX() { setX(0); }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    names = [c.method_name for c in report.candidates]
    assert "resetX" not in names
