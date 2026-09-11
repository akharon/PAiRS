from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.noexcept_move_analyzer import NoexceptMoveAnalyzer
from sarp.noexcept_move_rewriter import apply as apply_noexcept


def _report(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = NoexceptMoveAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_dry_run_inserts_noexcept(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    Widget(Widget&&) {}\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")
    original = (cpp_project.root / "widget.h").read_text()

    new_text, safety = apply_noexcept(report, dry_run=True)

    assert safety is None
    assert "Widget(Widget&&) noexcept {}" in new_text
    assert (cpp_project.root / "widget.h").read_text() == original


def test_apply_rewrites_header_and_compiles(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nstruct Widget {\n    Widget(Widget&&) {}\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")

    _, safety = apply_noexcept(report)

    new_text = (cpp_project.root / "widget.h").read_text()
    assert "noexcept" in new_text
    assert safety.patch_path.exists()
    cpp_project.assert_compiles("widget.cpp")
