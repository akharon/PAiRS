from __future__ import annotations

import subprocess

from sarp.compdb import CompileDatabase
from sarp.pimpl_analyzer import PimplAnalyzer
from sarp.pimpl_rewriter import apply as apply_pimpl


def _report(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = PimplAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def _setup_widget_gadget(cpp_project):
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {\npublic:\n    void activate();\n};\n")
    cpp_project.write("gadget.cpp", '#include "gadget.h"\nvoid Gadget::activate() {}\n')
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\n'
        "class Widget {\npublic:\n    void attach(Gadget* g);\nprivate:\n    Gadget* g_ = nullptr;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nvoid Widget::attach(Gadget* g) { g_ = g; }\n')


def test_dry_run_does_not_write_file(cpp_project):
    _setup_widget_gadget(cpp_project)
    report = _report(cpp_project, "widget.h", "widget.cpp")
    original = (cpp_project.root / "widget.h").read_text()

    new_text, safety = apply_pimpl(report, dry_run=True)

    assert safety is None
    assert "class Gadget;" in new_text
    assert '#include "gadget.h"' not in new_text
    assert (cpp_project.root / "widget.h").read_text() == original  # untouched on disk


def test_apply_rewrites_header_and_compiles(cpp_project):
    _setup_widget_gadget(cpp_project)
    report = _report(cpp_project, "widget.h", "widget.cpp")

    _, safety = apply_pimpl(report)

    new_text = (cpp_project.root / "widget.h").read_text()
    assert "class Gadget;" in new_text
    assert '#include "gadget.h"' not in new_text
    assert safety.patch_path.exists()
    cpp_project.assert_compiles("widget.cpp")


def test_patch_file_reverts_cleanly(cpp_project):
    _setup_widget_gadget(cpp_project)
    report = _report(cpp_project, "widget.h", "widget.cpp")
    original = (cpp_project.root / "widget.h").read_text()

    _, safety = apply_pimpl(report)
    assert (cpp_project.root / "widget.h").read_text() != original

    result = subprocess.run(
        ["patch", "-R", "widget.h"],
        cwd=cpp_project.root,
        input=safety.patch_path.read_text(),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert (cpp_project.root / "widget.h").read_text() == original


def test_no_candidates_means_nothing_to_apply(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
