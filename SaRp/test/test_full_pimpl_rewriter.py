from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.full_pimpl_analyzer import FullPimplAnalyzer
from sarp.full_pimpl_rewriter import apply as apply_full_pimpl


def _setup_widget(cpp_project):
    header = cpp_project.write(
        "widget.h",
        "#pragma once\n#include <string>\n"
        "class Widget {\npublic:\n    explicit Widget(std::string name);\n"
        "    const std::string& name() const;\n    void rename(std::string n);\n"
        "private:\n    std::string name_;\n    int counter_ = 0;\n};\n",
    )
    cpp = cpp_project.write(
        "widget.cpp",
        '#include "widget.h"\n\n'
        "Widget::Widget(std::string name) {\n    name_ = std::move(name);\n}\n\n"
        "const std::string& Widget::name() const {\n    return name_;\n}\n\n"
        "void Widget::rename(std::string n) {\n    name_ = std::move(n);\n    counter_++;\n}\n",
    )
    return header, cpp


def _candidate(cpp_project, header, cpp):
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    analyzer = FullPimplAnalyzer(compdb)
    report = analyzer.analyze_header(header, cpp)
    assert len(report.candidates) == 1
    return report.candidates[0]


def test_dry_run_does_not_write_files(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)
    header_before = header.read_text()
    cpp_before = cpp.read_text()

    results = apply_full_pimpl(candidate, cpp, dry_run=True)

    assert header.read_text() == header_before
    assert cpp.read_text() == cpp_before
    header_new, header_safety = results[header]
    assert header_safety is None
    assert "std::unique_ptr<Impl> impl_;" in header_new
    assert "std::string name_;" not in header_new


def test_apply_removes_private_fields_from_header(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)

    apply_full_pimpl(candidate, cpp)

    header_text = header.read_text()
    assert "std::string name_;" not in header_text
    assert "int counter_ = 0;" not in header_text
    assert "struct Impl;" in header_text
    assert "std::unique_ptr<Impl> impl_;" in header_text


def test_apply_adds_destructor_declaration_when_missing(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)

    apply_full_pimpl(candidate, cpp)

    assert "~Widget();" in header.read_text()


def test_apply_emits_impl_struct_definition(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)

    apply_full_pimpl(candidate, cpp)

    cpp_text = cpp.read_text()
    assert "struct Widget::Impl {" in cpp_text
    assert "std::string name_;" in cpp_text
    assert "int counter_ = 0;" in cpp_text


def test_apply_constructs_impl_in_constructor(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)

    apply_full_pimpl(candidate, cpp)

    cpp_text = cpp.read_text()
    assert "impl_ = std::make_unique<Impl>();" in cpp_text


def test_apply_rewrites_field_accesses_to_impl_arrow(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)

    apply_full_pimpl(candidate, cpp)

    cpp_text = cpp.read_text()
    assert "impl_->name_" in cpp_text
    assert "impl_->counter_" in cpp_text
    # Method bodies (everything after the Impl struct definition) should have no bare
    # `name_` left — only impl_->name_. The Impl struct's OWN field declaration is the
    # sole legitimate remaining bare occurrence, so scope the check to what follows it.
    method_bodies = cpp_text.split("};", 1)[1]
    import re

    bare_refs = re.findall(r"(?<!impl_->)\bname_\b", method_bodies)
    assert bare_refs == []


def test_rewritten_project_compiles_and_runs_correctly(cpp_project):
    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)

    apply_full_pimpl(candidate, cpp)

    cpp_project.write(
        "main.cpp",
        '#include "widget.h"\n#include <cassert>\n\n'
        "int main() {\n"
        '    Widget w("hello");\n'
        '    assert(w.name() == "hello");\n'
        '    w.rename("world");\n'
        '    assert(w.name() == "world");\n'
        "    return 0;\n"
        "}\n",
    )

    import shutil
    import subprocess

    compiler = shutil.which("g++")
    binary = cpp_project.root / "test_bin"
    result = subprocess.run(
        [compiler, "-std=c++17", str(cpp), str(cpp_project.root / "main.cpp"), "-o", str(binary)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    run_result = subprocess.run([str(binary)], capture_output=True, text=True)
    assert run_result.returncode == 0, run_result.stderr


def test_patch_files_revert_cleanly(cpp_project):
    import subprocess

    header, cpp = _setup_widget(cpp_project)
    candidate = _candidate(cpp_project, header, cpp)
    header_before = header.read_text()
    cpp_before = cpp.read_text()

    results = apply_full_pimpl(candidate, cpp)
    header_safety = results[header][1]
    cpp_safety = results[cpp][1]

    r1 = subprocess.run(
        ["patch", "-R", header.name],
        cwd=cpp_project.root,
        input=header_safety.patch_path.read_text(),
        capture_output=True,
        text=True,
    )
    assert r1.returncode == 0, r1.stderr
    r2 = subprocess.run(
        ["patch", "-R", cpp.name],
        cwd=cpp_project.root,
        input=cpp_safety.patch_path.read_text(),
        capture_output=True,
        text=True,
    )
    assert r2.returncode == 0, r2.stderr

    assert header.read_text() == header_before
    assert cpp.read_text() == cpp_before
