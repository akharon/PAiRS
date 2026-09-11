from __future__ import annotations

import json

from sarp.compdb import CompileDatabase


def test_loads_args_for_known_file(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    args = compdb.args_for(cpp_project.root / "widget.cpp")

    assert args is not None
    assert "-std=c++17" in args


def test_unknown_file_returns_none(cpp_project):
    cpp_project.write("widget.cpp", "")
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    assert compdb.args_for(cpp_project.root / "nonexistent.cpp") is None


def test_source_file_path_stripped_from_args(cpp_project):
    """The source file must NOT appear in args — libclang's parse() takes the path
    separately, and a duplicate causes a parse failure (regression test for a real bug).
    """
    source = cpp_project.write("widget.cpp", "")
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    args = compdb.args_for(source)

    assert str(source) not in args
    assert source.name not in args


def test_output_flag_stripped_from_args(cpp_project):
    cpp_project.write("widget.cpp", "")
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())
    args = compdb.args_for(cpp_project.root / "widget.cpp")

    assert "-o" not in args


def test_command_string_form_is_parsed(cpp_project):
    """compile_commands.json entries can use a "command" string instead of "arguments"."""
    source = cpp_project.write("widget.cpp", "")
    cc_path = cpp_project.root / "compile_commands.json"
    cc_path.write_text(
        json.dumps(
            [
                {
                    "directory": str(cpp_project.root),
                    "file": str(source),
                    "command": f"/usr/bin/g++ -std=c++17 -c {source} -o {source}.o",
                }
            ]
        )
    )
    compdb = CompileDatabase.load(cc_path)

    args = compdb.args_for(source)

    assert args is not None
    assert "-std=c++17" in args


def test_files_lists_all_entries(cpp_project):
    cpp_project.write("a.cpp", "")
    cpp_project.write("b.cpp", "")
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    files = compdb.files()

    assert len(files) == 2
