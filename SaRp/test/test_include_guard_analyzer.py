from __future__ import annotations

from sarp.include_guard_analyzer import audit_headers


def test_missing_guard_is_reported(cpp_project):
    cpp_project.write("widget.h", "class Widget {};\n")

    report = audit_headers(cpp_project.root)

    issues = [i for i in report.issues if i.header.name == "widget.h"]
    assert any(i.issue == "missing_guard" for i in issues)


def test_pragma_once_has_no_issues(cpp_project):
    cpp_project.write("widget.h", "#pragma once\nclass Widget {};\n")

    report = audit_headers(cpp_project.root)

    assert report.issues == []


def test_correct_ifndef_guard_has_no_issues(cpp_project):
    cpp_project.write(
        "widget.h",
        "#ifndef WIDGET_H\n#define WIDGET_H\nclass Widget {};\n#endif\n",
    )

    report = audit_headers(cpp_project.root)

    assert report.issues == []


def test_naming_mismatch_is_reported(cpp_project):
    cpp_project.write(
        "widget.h",
        "#ifndef FOO_BAR\n#define FOO_BAR\nclass Widget {};\n#endif\n",
    )

    report = audit_headers(cpp_project.root)

    assert any(i.issue == "naming_mismatch" for i in report.issues)


def test_guard_collision_across_files_is_reported(cpp_project):
    cpp_project.write("a.h", "#ifndef SHARED_GUARD\n#define SHARED_GUARD\n#endif\n")
    cpp_project.write("b.h", "#ifndef SHARED_GUARD\n#define SHARED_GUARD\n#endif\n")

    report = audit_headers(cpp_project.root)

    collisions = [i for i in report.issues if i.issue == "guard_collision"]
    assert len(collisions) == 2
    headers = {i.header.name for i in collisions}
    assert headers == {"a.h", "b.h"}
