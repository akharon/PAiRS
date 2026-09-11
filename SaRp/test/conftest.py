"""Shared pytest fixtures: a temp-dir C++ "project" builder that writes source files and
a matching compile_commands.json, without needing a real CMake configure/build per test
(SaRp's CompileDatabase only needs the JSON shape — this constructs it directly).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest


class CppProject:
    def __init__(self, root: Path):
        self.root = root
        self._sources: list[Path] = []

    def write(self, rel_path: str, content: str) -> Path:
        path = self.root / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        if path.suffix in (".cpp", ".cc"):
            self._sources.append(path)
        return path

    def compile_commands_path(self) -> Path:
        compiler = shutil.which("g++") or shutil.which("clang++")
        entries = [
            {
                "directory": str(self.root),
                "file": str(source),
                "arguments": [compiler, "-std=c++17", "-c", str(source), "-o", str(source.with_suffix(".o"))],
            }
            for source in self._sources
        ]
        cc_path = self.root / "compile_commands.json"
        cc_path.write_text(json.dumps(entries))
        return cc_path

    def assert_compiles(self, source: str = None) -> None:
        """Sanity check a rewrite didn't produce invalid C++ (used sparingly — most tests
        assert on the rewritten text directly; this is for the handful of tests that need
        end-to-end proof the whole file still builds).
        """
        compiler = shutil.which("g++") or shutil.which("clang++")
        sources = [self.root / source] if source else self._sources
        for src in sources:
            result = subprocess.run(
                [compiler, "-std=c++17", "-fsyntax-only", str(src)],
                capture_output=True,
                text=True,
                timeout=15,
            )
            assert result.returncode == 0, f"{src} failed to compile:\n{result.stderr}"


@pytest.fixture
def cpp_project(tmp_path: Path) -> CppProject:
    return CppProject(tmp_path)
