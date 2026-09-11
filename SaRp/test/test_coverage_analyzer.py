from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.coverage_analyzer import analyze_coverage


def test_reached_header_is_covered(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    report = analyze_coverage(compdb, cpp_project.root)

    assert report.total_tus == 1
    assert report.unparseable_tus == []
    assert any(h.name == "widget.h" for h in report.covered_headers)
    assert report.uncovered_headers == []


def test_unreached_header_is_uncovered(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("orphan.h", "#pragma once\nclass Orphan {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    report = analyze_coverage(compdb, cpp_project.root)

    assert any(h.name == "orphan.h" for h in report.uncovered_headers)
    assert all(h.name != "orphan.h" for h in report.covered_headers)


def test_unparseable_tu_is_reported_and_excluded(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    cpp_project.write("broken.cpp", "this is not valid C++ &&& !!! syntax_error(\n")
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    report = analyze_coverage(compdb, cpp_project.root)

    assert report.total_tus == 2
    assert len(report.unparseable_tus) == 1
    assert report.unparseable_tus[0][0].name == "broken.cpp"
    assert any(h.name == "widget.h" for h in report.covered_headers)
