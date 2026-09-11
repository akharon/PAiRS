from __future__ import annotations

from sarp.call_sites import find_call_sites
from sarp.compdb import CompileDatabase


def _setup_calculator_with_caller(cpp_project):
    cpp_project.write(
        "calculator.h",
        "#pragma once\n"
        "class Calculator {\n"
        "public:\n"
        "    explicit Calculator(int base);\n"
        "    int sumTwo(int a, int b) const;\n"
        "};\n",
    )
    cpp_project.write(
        "calculator.cpp",
        '#include "calculator.h"\n'
        "Calculator::Calculator(int base) {}\n"
        "int Calculator::sumTwo(int a, int b) const { return a + b; }\n",
    )
    cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n'
        "int main() {\n"
        "    Calculator c(1);\n"
        "    return c.sumTwo(2, 3);\n"
        "}\n",
    )


def test_finds_call_site_in_another_translation_unit(cpp_project):
    _setup_calculator_with_caller(cpp_project)
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    sites = find_call_sites(compdb, "Calculator", "sumTwo", cpp_project.root / "calculator.h")

    assert len(sites) == 1
    assert sites[0].file == (cpp_project.root / "main.cpp").resolve()
    assert "sumTwo" in sites[0].source_line


def test_no_call_sites_when_method_unused(cpp_project):
    cpp_project.write(
        "calculator.h",
        "#pragma once\nclass Calculator {\npublic:\n    int sumTwo(int a, int b) const;\n};\n",
    )
    cpp_project.write(
        "calculator.cpp",
        '#include "calculator.h"\nint Calculator::sumTwo(int a, int b) const { return a + b; }\n',
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    sites = find_call_sites(compdb, "Calculator", "sumTwo", cpp_project.root / "calculator.h")

    assert sites == []


def test_does_not_match_same_method_name_on_different_class(cpp_project):
    _setup_calculator_with_caller(cpp_project)
    cpp_project.write(
        "other.h",
        "#pragma once\nclass Other {\npublic:\n    int sumTwo(int a, int b) const;\n};\n",
    )
    cpp_project.write(
        "other.cpp",
        '#include "other.h"\n'
        "int Other::sumTwo(int a, int b) const { return a - b; }\n"
        "int callOther() {\n"
        "    Other o;\n"
        "    return o.sumTwo(4, 5);\n"
        "}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    sites = find_call_sites(compdb, "Calculator", "sumTwo", cpp_project.root / "calculator.h")

    # Only Calculator's sumTwo call site, not Other's.
    assert len(sites) == 1
    assert sites[0].file == (cpp_project.root / "main.cpp").resolve()


def test_finds_multiple_call_sites_across_files(cpp_project):
    _setup_calculator_with_caller(cpp_project)
    cpp_project.write(
        "second_caller.cpp",
        '#include "calculator.h"\n'
        "int second() {\n"
        "    Calculator c(2);\n"
        "    return c.sumTwo(10, 20);\n"
        "}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    sites = find_call_sites(compdb, "Calculator", "sumTwo", cpp_project.root / "calculator.h")

    files = {s.file for s in sites}
    assert (cpp_project.root / "main.cpp").resolve() in files
    assert (cpp_project.root / "second_caller.cpp").resolve() in files
