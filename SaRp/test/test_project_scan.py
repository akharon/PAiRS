from __future__ import annotations

from sarp.compdb import CompileDatabase
from sarp.project_scan import discover_headers


def test_discovers_all_project_headers(cpp_project):
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {};\n")
    cpp_project.write("gadget.cpp", '#include "gadget.h"\n')
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    targets = discover_headers(compdb, cpp_project.root)

    headers = {t.header for t in targets}
    assert (cpp_project.root / "gadget.h").resolve() in headers
    assert (cpp_project.root / "widget.h").resolve() in headers


def test_transitively_included_header_is_discovered(cpp_project):
    cpp_project.write("gadget.h", "#pragma once\nclass Gadget {};\n")
    cpp_project.write(
        "widget.h",
        '#pragma once\n#include "gadget.h"\nclass Widget { Gadget* g_; };\n',
    )
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    targets = discover_headers(compdb, cpp_project.root)

    headers = {t.header for t in targets}
    # gadget.h is only reachable transitively (widget.cpp includes widget.h includes gadget.h)
    assert (cpp_project.root / "gadget.h").resolve() in headers


def test_system_headers_are_excluded(cpp_project):
    cpp_project.write("widget.h", "#pragma once\n#include <string>\nclass Widget { std::string s_; };\n")
    cpp_project.write("widget.cpp", '#include "widget.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    targets = discover_headers(compdb, cpp_project.root)

    headers = {t.header for t in targets}
    assert not any("string" in str(h) and "Workspace" not in str(h) for h in headers)
    assert all(cpp_project.root in h.parents or h.parent == cpp_project.root for h in headers)


def test_each_header_gets_exactly_one_via(cpp_project):
    cpp_project.write("shared.h", "#pragma once\nclass Shared {};\n")
    cpp_project.write("a.cpp", '#include "shared.h"\n')
    cpp_project.write("b.cpp", '#include "shared.h"\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    targets = discover_headers(compdb, cpp_project.root)

    shared_targets = [t for t in targets if t.header == (cpp_project.root / "shared.h").resolve()]
    assert len(shared_targets) == 1  # not once per includer


def test_prefers_same_basename_cpp_over_first_includer(cpp_project):
    """Regression test: when a header is transitively included by an unrelated TU
    BEFORE its own implementing .cpp appears in compdb order, the same-basename .cpp
    must still win — it's the only TU containing out-of-line method definitions, which
    the free-function analyzer needs (a TU that only sees the header declaration finds
    nothing, silently producing zero candidates for a header that has real ones).
    """
    cpp_project.write("calculator.h", "#pragma once\nclass Calculator { public: int sumTwo(int a, int b) const; };\n")
    cpp_project.write(
        "calculator.cpp",
        '#include "calculator.h"\nint Calculator::sumTwo(int a, int b) const { return a + b; }\n',
    )
    # main.cpp only sees the declaration (never the definition) but is written to
    # compdb BEFORE calculator.cpp isn't guaranteed here, so instead assert directly
    # that calculator.cpp is chosen regardless of compdb iteration order.
    cpp_project.write("main.cpp", '#include "calculator.h"\nint main() { return 0; }\n')
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    targets = discover_headers(compdb, cpp_project.root)

    calc_target = next(t for t in targets if t.header == (cpp_project.root / "calculator.h").resolve())
    assert calc_target.via == (cpp_project.root / "calculator.cpp").resolve()


def test_unparseable_source_is_skipped_not_fatal(cpp_project):
    cpp_project.write("good.h", "#pragma once\nclass Good {};\n")
    cpp_project.write("good.cpp", '#include "good.h"\n')
    cpp_project.write("broken.cpp", "this is not valid c++ &&&& @@@ {{{\n")
    compdb = CompileDatabase.load(cpp_project.compile_commands_path())

    targets = discover_headers(compdb, cpp_project.root)  # should not raise

    headers = {t.header for t in targets}
    assert (cpp_project.root / "good.h").resolve() in headers
