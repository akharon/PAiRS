from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.extern_c_analyzer import audit_headers


def test_header_without_guard_included_by_c_tu_is_reported(cpp_project):
    cpp_project.write("api.h", "#pragma once\nvoid foo(int x);\n")
    cpp_project.write("consumer.c", '#include "api.h"\nint main(void) { return 0; }\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    report = audit_headers(compdb, cpp_project.root)

    assert len(report.issues) == 1
    assert report.issues[0].header.name == "api.h"
    assert report.issues[0].c_consumers[0].name == "consumer.c"


def test_header_with_extern_c_guard_is_not_reported(cpp_project):
    cpp_project.write(
        "api.h",
        '#pragma once\n#ifdef __cplusplus\nextern "C" {\n#endif\nvoid foo(int x);\n'
        "#ifdef __cplusplus\n}\n#endif\n",
    )
    cpp_project.write("consumer.c", '#include "api.h"\nint main(void) { return 0; }\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    report = audit_headers(compdb, cpp_project.root)

    assert report.issues == []


def test_header_not_included_by_any_c_tu_is_not_reported(cpp_project):
    cpp_project.write("api.h", "#pragma once\nvoid foo(int x);\n")
    cpp_project.write("consumer.cpp", '#include "api.h"\n')

    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    report = audit_headers(compdb, cpp_project.root)

    assert report.issues == []
