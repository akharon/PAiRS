from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.inline_analyzer import InlineAnalyzer
from sarp.inline_rewriter import apply as apply_inline


def _report(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = InlineAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_dry_run_inserts_inline_without_writing(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nint plainFunc(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")
    original = (cpp_project.root / "widget.h").read_text()

    new_text, safety = apply_inline(report, dry_run=True)

    assert safety is None
    assert "inline int plainFunc" in new_text
    assert (cpp_project.root / "widget.h").read_text() == original


def test_apply_rewrites_header_and_compiles(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nint plainFunc(int x) { return x * 2; }\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")

    _, safety = apply_inline(report)

    new_text = (cpp_project.root / "widget.h").read_text()
    assert "inline int plainFunc" in new_text
    assert safety.patch_path.exists()
    cpp_project.assert_compiles("widget.cpp")


def test_multiple_candidates_all_rewritten(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nint plainFunc(int x) { return x * 2; }\nint otherFunc(int x) { return x * 3; }\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")

    new_text, _ = apply_inline(report, dry_run=True)

    assert "inline int plainFunc" in new_text
    assert "inline int otherFunc" in new_text
