from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.free_function_analyzer import FreeFunctionAnalyzer


def _report(cpp_project, header_rel, via_rel):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = FreeFunctionAnalyzer(compdb)
    return analyzer.analyze_header(cpp_project.root / header_rel, cpp_project.root / via_rel)


def _setup_calculator(cpp_project):
    cpp_project.write(
        "calculator.h",
        "#pragma once\n"
        "class Calculator {\n"
        "public:\n"
        "    explicit Calculator(int base);\n"
        "    int addToBase(int value) const;\n"
        "    int sumTwo(int a, int b) const;\n"
        "private:\n"
        "    int base_ = 0;\n"
        "};\n",
    )
    cpp_project.write(
        "calculator.cpp",
        '#include "calculator.h"\n'
        "Calculator::Calculator(int base) : base_(base) {}\n"
        "int Calculator::addToBase(int value) const { return base_ + value; }\n"
        "int Calculator::sumTwo(int a, int b) const { return a + b; }\n",
    )


def test_stateless_method_is_a_candidate(cpp_project):
    _setup_calculator(cpp_project)
    report = _report(cpp_project, "calculator.h", "calculator.cpp")

    names = {c.method_name for c in report.candidates}
    assert names == {"sumTwo"}


def test_method_touching_field_is_not_a_candidate(cpp_project):
    _setup_calculator(cpp_project)
    report = _report(cpp_project, "calculator.h", "calculator.cpp")

    names = {c.method_name for c in report.candidates}
    assert "addToBase" not in names


def test_constructor_is_excluded(cpp_project):
    _setup_calculator(cpp_project)
    report = _report(cpp_project, "calculator.h", "calculator.cpp")

    names = {c.method_name for c in report.candidates}
    assert "Calculator" not in names


def test_static_method_is_excluded(cpp_project):
    cpp_project.write(
        "util.h",
        "#pragma once\nclass Util {\npublic:\n    static int sum(int a, int b);\n};\n",
    )
    cpp_project.write("util.cpp", '#include "util.h"\nint Util::sum(int a, int b) { return a + b; }\n')

    report = _report(cpp_project, "util.h", "util.cpp")

    assert report.candidates == []


def test_virtual_method_is_excluded(cpp_project):
    cpp_project.write(
        "shape.h",
        "#pragma once\nclass Shape {\npublic:\n    virtual int area(int side) const { return side * side; }\n};\n",
    )
    cpp_project.write("shape.cpp", '#include "shape.h"\n')

    report = _report(cpp_project, "shape.h", "shape.cpp")

    assert report.candidates == []


def test_operator_overload_is_excluded(cpp_project):
    cpp_project.write(
        "point.h",
        "#pragma once\nclass Point {\npublic:\n    int add(int x, int y) const { return x + y; }\n"
        "    int operator+(int x) const { return x + 1; }\n};\n",
    )
    cpp_project.write("point.cpp", '#include "point.h"\n')

    report = _report(cpp_project, "point.h", "point.cpp")

    names = {c.method_name for c in report.candidates}
    assert "add" in names
    assert not any(n.startswith("operator") for n in names)


def test_method_calling_another_member_method_is_not_a_candidate(cpp_project):
    cpp_project.write(
        "chain.h",
        "#pragma once\nclass Chain {\npublic:\n    int helper() const { return 1; }\n"
        "    int caller() const { return helper() + 1; }\nprivate:\n    int x_ = 0;\n};\n",
    )
    cpp_project.write("chain.cpp", '#include "chain.h"\n')

    report = _report(cpp_project, "chain.h", "chain.cpp")

    names = {c.method_name for c in report.candidates}
    assert "caller" not in names
    assert "helper" in names  # helper itself touches nothing


def test_declaration_span_covers_full_line(cpp_project):
    _setup_calculator(cpp_project)
    report = _report(cpp_project, "calculator.h", "calculator.cpp")

    candidate = report.candidates[0]
    header_text = (cpp_project.root / "calculator.h").read_text()
    span_text = header_text[candidate.declaration_span.start_offset : candidate.declaration_span.end_offset]
    assert span_text.strip() == "int sumTwo(int a, int b) const;"
