"""Textual, project-wide audit of header include guards. No AST needed: guard style is
a preprocessor-level property, not a semantic one, so this is safe to do without libclang.

Three checks:
- **Collision**: two different headers use the same `#ifndef FOO_H` / `#define FOO_H`
  guard macro. Whichever file loses the race to be preprocessed first "wins" per TU;
  the other header silently vanishes for that translation unit for the rest of the
  build. This is a zero-false-positive bug report, never an APPLY (a machine-picked
  replacement macro name could collide with something else the project doesn't scan).
- **Missing**: header has neither `#pragma once` nor an `#ifndef`/`#define` guard pair.
- **Naming mismatch**: guard macro name doesn't derive from the file's path (project
  convention: uppercase, path separators and `.` become `_`). Reported, not rewritten,
  since renaming a guard macro is safe by itself but this tool doesn't verify nothing
  else references the old macro name (e.g. a build script grepping for it).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

_HEADER_SUFFIXES = {".h", ".hpp", ".hh", ".hxx"}
_IFNDEF_RE = re.compile(r"^\s*#\s*ifndef\s+(\w+)\s*$")
_DEFINE_RE = re.compile(r"^\s*#\s*define\s+(\w+)\s*$")
_PRAGMA_ONCE_RE = re.compile(r"^\s*#\s*pragma\s+once\s*$")


@dataclass
class GuardIssue:
    header: Path
    issue: str
    detail: str


@dataclass
class GuardAuditReport:
    issues: list[GuardIssue] = field(default_factory=list)


def audit_headers(project_root: Path) -> GuardAuditReport:
    project_root = project_root.resolve()
    headers = sorted(
        p for p in project_root.rglob("*") if p.suffix in _HEADER_SUFFIXES and p.is_file()
    )

    report = GuardAuditReport()
    macro_to_headers: dict[str, list[Path]] = {}

    for header in headers:
        style, macro = _detect_guard_style(header)

        if style == "none":
            report.issues.append(
                GuardIssue(header=header, issue="missing_guard", detail="no #pragma once or #ifndef guard found")
            )
            continue

        if style == "pragma_once":
            continue

        # style == "ifndef_define"
        macro_to_headers.setdefault(macro, []).append(header)
        expected = _expected_guard_name(header, project_root)
        if macro != expected:
            report.issues.append(
                GuardIssue(
                    header=header,
                    issue="naming_mismatch",
                    detail=f"guard '{macro}' does not match project convention '{expected}'",
                )
            )

    for macro, owners in macro_to_headers.items():
        if len(owners) > 1:
            names = ", ".join(str(h) for h in owners)
            for header in owners:
                report.issues.append(
                    GuardIssue(
                        header=header,
                        issue="guard_collision",
                        detail=f"guard macro '{macro}' also used by: {names}",
                    )
                )

    report.issues.sort(key=lambda i: (str(i.header), i.issue))
    return report


def _detect_guard_style(header: Path) -> tuple[str, str | None]:
    lines = header.read_text(errors="replace").splitlines()
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("//") or stripped.startswith("/*"):
            continue
        if _PRAGMA_ONCE_RE.match(line):
            return "pragma_once", None
        ifndef_match = _IFNDEF_RE.match(line)
        if ifndef_match:
            macro = ifndef_match.group(1)
            for later in lines[lines.index(line) + 1 : lines.index(line) + 3]:
                define_match = _DEFINE_RE.match(later)
                if define_match and define_match.group(1) == macro:
                    return "ifndef_define", macro
            return "ifndef_define", macro
        # First non-blank, non-comment, non-guard line: no guard found before real content.
        break
    return "none", None


def _expected_guard_name(header: Path, project_root: Path) -> str:
    try:
        rel = header.relative_to(project_root)
    except ValueError:
        rel = Path(header.name)
    normalized = re.sub(r"[^A-Za-z0-9]", "_", str(rel)).upper()
    return normalized
