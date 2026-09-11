from __future__ import annotations

from sarp.call_site_rewriter import apply as apply_call_sites
from sarp.call_sites import find_call_sites
from sarp.compdb import CompileDatabase
from sarp.free_function_analyzer import FreeFunctionAnalyzer
from sarp.free_function_rewriter import apply as apply_free_function


def _setup_calculator(cpp_project):
    header = cpp_project.write(
        "calculator.h",
        "#pragma once\nclass Calculator {\npublic:\n    explicit Calculator(int base);\n"
        "    int sumTwo(int a, int b) const;\n};\n",
    )
    cpp = cpp_project.write(
        "calculator.cpp",
        '#include "calculator.h"\nCalculator::Calculator(int base) {}\n'
        "int Calculator::sumTwo(int a, int b) const { return a + b; }\n",
    )
    return header, cpp


def test_dot_call_rewritten_to_free_function_syntax(cpp_project):
    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n'
        "int main() {\n    Calculator c(1);\n    return c.sumTwo(2, 3);\n}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    sites = find_call_sites(compdb, "Calculator", "sumTwo", header)

    results = apply_call_sites(sites, "sumTwo")

    text = main_cpp.read_text()
    assert "sumTwo(c, 2, 3)" in text
    assert "c.sumTwo(2, 3)" not in text
    assert main_cpp in results


def test_arrow_call_rewritten_with_dereference(cpp_project):
    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n'
        "int main() {\n    Calculator c(1);\n    Calculator* cp = &c;\n    return cp->sumTwo(2, 3);\n}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    sites = find_call_sites(compdb, "Calculator", "sumTwo", header)

    apply_call_sites(sites, "sumTwo")

    text = main_cpp.read_text()
    assert "sumTwo(*cp, 2, 3)" in text


def test_multiple_call_sites_same_line_both_rewritten(cpp_project):
    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n'
        "int main() {\n    Calculator c(1);\n    Calculator* cp = &c;\n"
        "    return c.sumTwo(2, 3) + cp->sumTwo(4, 5);\n}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    sites = find_call_sites(compdb, "Calculator", "sumTwo", header)

    apply_call_sites(sites, "sumTwo")

    text = main_cpp.read_text()
    assert "sumTwo(c, 2, 3)" in text
    assert "sumTwo(*cp, 4, 5)" in text


def test_macro_wrapped_call_site_is_left_untouched(cpp_project):
    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n#include <cassert>\n'
        "int main() {\n    Calculator c(1);\n    assert(c.sumTwo(2, 3) == 5);\n    return 0;\n}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    sites = find_call_sites(compdb, "Calculator", "sumTwo", header)
    original = main_cpp.read_text()

    results = apply_call_sites(sites, "sumTwo")

    # No rewritable sites in this file -> file is never touched, not even opened for writing.
    assert main_cpp not in results
    assert main_cpp.read_text() == original


def test_mixed_rewritable_and_macro_sites_only_rewritable_ones_change(cpp_project):
    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n#include <cassert>\n'
        "int main() {\n"
        "    Calculator c(1);\n"
        "    int x = c.sumTwo(2, 3);\n"
        "    assert(c.sumTwo(2, 3) == 5);\n"
        "    return x;\n"
        "}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    sites = find_call_sites(compdb, "Calculator", "sumTwo", header)
    assert len(sites) == 2

    apply_call_sites(sites, "sumTwo")

    text = main_cpp.read_text()
    assert "int x = sumTwo(c, 2, 3);" in text
    assert "assert(c.sumTwo(2, 3) == 5);" in text  # macro-wrapped one untouched


def test_dry_run_does_not_write_files(cpp_project):
    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n'
        "int main() {\n    Calculator c(1);\n    return c.sumTwo(2, 3);\n}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    sites = find_call_sites(compdb, "Calculator", "sumTwo", header)
    before = main_cpp.read_text()

    results = apply_call_sites(sites, "sumTwo", dry_run=True)

    assert main_cpp.read_text() == before
    new_text, safety = results[main_cpp]
    assert safety is None
    assert "sumTwo(c, 2, 3)" in new_text


def test_full_free_function_plus_call_site_rewrite_compiles_and_runs(cpp_project):
    import shutil
    import subprocess

    header, cpp = _setup_calculator(cpp_project)
    main_cpp = cpp_project.write(
        "main.cpp",
        '#include "calculator.h"\n#include <cassert>\n'
        "int main() {\n"
        "    Calculator c(1);\n"
        "    Calculator* cp = &c;\n"
        "    int x = c.sumTwo(2, 3);\n"
        "    int y = cp->sumTwo(4, 5);\n"
        "    assert(x == 5 && y == 9);\n"
        "    return 0;\n"
        "}\n",
    )
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = FreeFunctionAnalyzer(compdb)
    report = analyzer.analyze_header(header, cpp)
    candidate = report.candidates[0]

    sites = find_call_sites(compdb, candidate.class_name, candidate.method_name, candidate.declaration_span.file)
    apply_free_function(candidate)
    apply_call_sites(sites, candidate.method_name)

    compiler = shutil.which("g++")
    binary = cpp_project.root / "test_bin"
    result = subprocess.run(
        [compiler, "-std=c++17", str(cpp), str(main_cpp), "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    run_result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert run_result.returncode == 0, run_result.stderr
