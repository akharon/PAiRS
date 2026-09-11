from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.free_function_analyzer import FreeFunctionAnalyzer
from sarp.free_function_rewriter import apply as apply_free_function


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


def _candidate(cpp_project):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = FreeFunctionAnalyzer(compdb)
    report = analyzer.analyze_header(cpp_project.root / "calculator.h", cpp_project.root / "calculator.cpp")
    assert len(report.candidates) == 1
    return report.candidates[0]


def test_dry_run_does_not_write_files(cpp_project):
    _setup_calculator(cpp_project)
    candidate = _candidate(cpp_project)
    header_before = (cpp_project.root / "calculator.h").read_text()
    cpp_before = (cpp_project.root / "calculator.cpp").read_text()

    results = apply_free_function(candidate, dry_run=True)

    assert (cpp_project.root / "calculator.h").read_text() == header_before
    assert (cpp_project.root / "calculator.cpp").read_text() == cpp_before
    header_new, header_safety = results[cpp_project.root / "calculator.h"]
    assert header_safety is None
    assert "int sumTwo(const Calculator& self, int a, int b);" in header_new


def test_apply_removes_declaration_from_class_body(cpp_project):
    _setup_calculator(cpp_project)
    candidate = _candidate(cpp_project)

    apply_free_function(candidate)

    header = (cpp_project.root / "calculator.h").read_text()
    # sumTwo must no longer be declared INSIDE the class.
    class_body_start = header.index("class Calculator")
    class_body_end = header.index("};", class_body_start) + 2
    class_body = header[class_body_start:class_body_end]
    assert "sumTwo" not in class_body
    assert "addToBase" in class_body  # untouched sibling method stays


def test_apply_adds_free_declaration_after_class(cpp_project):
    _setup_calculator(cpp_project)
    candidate = _candidate(cpp_project)

    apply_free_function(candidate)

    header = (cpp_project.root / "calculator.h").read_text()
    class_end = header.index("};") + 2
    after_class = header[class_end:]
    assert "int sumTwo(const Calculator& self, int a, int b);" in after_class


def test_apply_rewritten_header_and_cpp_compile(cpp_project):
    _setup_calculator(cpp_project)
    candidate = _candidate(cpp_project)

    apply_free_function(candidate)

    # main.cpp uses the free function form to prove both files are consistent and valid.
    cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n'
        "int main() {\n"
        "    Calculator c(1);\n"
        "    return sumTwo(c, 2, 3);\n"
        "}\n",
    )
    cpp_project.assert_compiles("calculator.cpp")
    cpp_project.assert_compiles("main.cpp")


def test_apply_rewrites_definition_preserving_body(cpp_project):
    _setup_calculator(cpp_project)
    candidate = _candidate(cpp_project)

    apply_free_function(candidate)

    cpp_text = (cpp_project.root / "calculator.cpp").read_text()
    assert "int sumTwo(const Calculator& self, int a, int b) {" in cpp_text
    assert "return a + b;" in cpp_text
    assert "Calculator::sumTwo" not in cpp_text


def test_old_member_call_syntax_no_longer_compiles(cpp_project):
    """Confirms the rewrite is a real breaking change requiring call-site updates —
    this is exactly why call_sites.py's report exists.
    """
    _setup_calculator(cpp_project)
    candidate = _candidate(cpp_project)

    apply_free_function(candidate)

    cpp_project.write(
        "old_style.cpp",
        '#include "calculator.h"\n'
        "int main() {\n"
        "    Calculator c(1);\n"
        "    return c.sumTwo(2, 3);\n"  # old member-call syntax
        "}\n",
    )
    import pytest

    with pytest.raises(AssertionError):
        cpp_project.assert_compiles("old_style.cpp")
