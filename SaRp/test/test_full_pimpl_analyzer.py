from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.full_pimpl_analyzer import FullPimplAnalyzer


def _report(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = FullPimplAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def test_simple_class_is_a_candidate(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\n#include <string>\n"
        "class Widget {\npublic:\n    explicit Widget(std::string name);\n"
        "    const std::string& name() const;\nprivate:\n    std::string name_;\n};\n",
    )
    cpp_project.write(
        "widget.cpp",
        '#include "widget.h"\n'
        "Widget::Widget(std::string name) { name_ = std::move(name); }\n"
        "const std::string& Widget::name() const { return name_; }\n",
    )

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert report.candidates[0].class_name == "Widget"
    assert len(report.candidates[0].private_fields) == 1
    assert "std::string name_;" in report.candidates[0].private_fields[0]


def test_no_private_fields_is_skipped(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {\npublic:\n    void f();\n};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\nvoid Widget::f() {}\n')

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "no private data members" in report.skipped["Widget"]


def test_no_constructor_is_skipped(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    int get() const;\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nint Widget::get() const { return x_; }\n')

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "no user-declared constructor" in report.skipped["Widget"]


def test_protected_member_is_skipped(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int x);\nprotected:\n    int y_ = 0;\n"
        "private:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nWidget::Widget(int x) { x_ = x; }\n')

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "protected" in report.skipped["Widget"]


def test_private_method_is_skipped(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int x);\n"
        "private:\n    int x_ = 0;\n    void helper();\n};\n",
    )
    cpp_project.write(
        "widget.cpp",
        '#include "widget.h"\nWidget::Widget(int x) { x_ = x; }\nvoid Widget::helper() {}\n',
    )

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "private method" in report.skipped["Widget"]


def test_member_initializer_list_is_skipped(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int x);\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nWidget::Widget(int x) : x_(x) {}\n')

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates == []
    assert "member-initializer list" in report.skipped["Widget"]


def test_multiple_private_fields_all_captured(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int a, int b);\n"
        "private:\n    int a_ = 0;\n    int b_ = 0;\n};\n",
    )
    cpp_project.write(
        "widget.cpp",
        '#include "widget.h"\nWidget::Widget(int a, int b) { a_ = a; b_ = b; }\n',
    )

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert len(report.candidates) == 1
    assert len(report.candidates[0].private_fields) == 2
    field_names = {a.field_name for a in report.candidates[0].field_accesses}
    assert field_names == {"a_", "b_"}


def test_needs_out_of_line_destructor_when_none_declared(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int x);\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nWidget::Widget(int x) { x_ = x; }\n')

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates[0].needs_out_of_line_destructor is True


def test_existing_destructor_does_not_need_one_added(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int x);\n    ~Widget();\n"
        "private:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write(
        "widget.cpp",
        '#include "widget.h"\nWidget::Widget(int x) { x_ = x; }\nWidget::~Widget() = default;\n',
    )

    report = _report(cpp_project, "widget.h", "widget.cpp")

    assert report.candidates[0].needs_out_of_line_destructor is False


def test_constructor_body_span_located_for_impl_construction(cpp_project):
    cpp_project.write(
        "widget.h",
        "#pragma once\nclass Widget {\npublic:\n    explicit Widget(int x);\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\nWidget::Widget(int x) { x_ = x; }\n')

    report = _report(cpp_project, "widget.h", "widget.cpp")

    candidate = report.candidates[0]
    assert len(candidate.constructor_bodies) == 1
    cpp_text = (cpp_project.root / "widget.cpp").read_text()
    offset = candidate.constructor_bodies[0].body_open_offset
    assert cpp_text[offset - 1] == "{"
