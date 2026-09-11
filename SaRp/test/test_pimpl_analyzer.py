from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.pimpl_analyzer import PimplAnalyzer


def _analyze(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = PimplAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_pointer_member_is_forward_decl_candidate(cpp_project):
    cpp_project.write(
        "gadget.h",
        "#pragma once\nclass Gadget {\npublic:\n    void activate();\n};\n",
    )
    cpp_project.write("gadget.cpp", '#include "gadget.h"\nvoid Gadget::activate() {}\n')
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\n'
        "class Widget {\npublic:\n    void attach(Gadget* g);\nprivate:\n    Gadget* g_ = nullptr;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nvoid Widget::attach(Gadget* g) { g_ = g; }\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].type_name == "Gadget"
    assert report.candidates[0].include_line == 2


def test_reference_member_is_forward_decl_candidate(cpp_project):
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {};\n")
    cpp_project.write("gadget.cpp", '#include "gadget.h"\n')
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\n'
        "class Widget {\npublic:\n    const Gadget& get() const;\nprivate:\n    Gadget* g_ = nullptr;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nconst Gadget& Widget::get() const { return *g_; }\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].type_name == "Gadget"


def test_value_member_is_not_a_candidate(cpp_project):
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {};\n")
    cpp_project.write("gadget.cpp", '#include "gadget.h"\n')
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\n'
        "class Widget {\npublic:\n    Gadget g_;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "Gadget" in report.kept_includes


def test_value_param_is_not_a_candidate(cpp_project):
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {};\n")
    cpp_project.write("gadget.cpp", '#include "gadget.h"\n')
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\n'
        "class Widget {\npublic:\n    void take(Gadget g);\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nvoid Widget::take(Gadget g) {}\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_mixed_pointer_and_value_usage_is_not_a_candidate(cpp_project):
    """If ANY usage needs the complete type, the include must be kept even if other
    usages of the same type only need a forward decl.
    """
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {};\n")
    cpp_project.write("gadget.cpp", '#include "gadget.h"\n')
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\n'
        "class Widget {\npublic:\n    void attach(Gadget* g);\n    Gadget makeOne();\n"
        "private:\n    Gadget* g_ = nullptr;\n};\n",
    )
    cpp_project.write(
        "widget.cpp",
        '#include "widget.h"\nvoid Widget::attach(Gadget* g) { g_ = g; }\nGadget Widget::makeOne() { return Gadget(); }\n',
    )

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "Gadget" in report.kept_includes


def test_no_local_includes_yields_no_candidates(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\n#include <string>\nclass Widget {\npublic:\n    std::string name_;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')

    report = _analyze(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []


def test_missing_compile_command_raises(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = PimplAnalyzer(compdb)

    import pytest

    with pytest.raises(ValueError):
        analyzer.analyze_header(cpp_project.root / "widget.h", cpp_project.root / "nonexistent.cpp")
