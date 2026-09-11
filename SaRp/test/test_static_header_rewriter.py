from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.static_header_analyzer import StaticHeaderAnalyzer
from sarp.static_header_rewriter import apply as apply_static_header


def _report(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = StaticHeaderAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_dry_run_replaces_static_with_inline(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstatic int helper(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")
    original = (cpp_project.root / "widget.h").read_text()

    new_text, safety = apply_static_header(report, dry_run=True)

    assert safety is None
    assert "inline int helper" in new_text
    assert "static" not in new_text
    assert (cpp_project.root / "widget.h").read_text() == original


def test_apply_rewrites_header_and_compiles(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstatic int helper(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")

    _, safety = apply_static_header(report)

    new_text = (cpp_project.root / "widget.h").read_text()
    assert "inline int helper" in new_text
    assert safety.patch_path.exists()
    cpp_project.assert_compiles("widget.cpp")


def test_static_variable_rewrite_compiles(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nstatic int counter = 0;\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")

    new_text, _ = apply_static_header(report, dry_run=True)

    assert "inline int counter = 0;" in new_text
