"""Loads a compile_commands.json compilation database and exposes per-file clang args."""
from __future__ import annotations

import json
import re
import shlex
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass
class CompileEntry:
    file: Path
    directory: Path
    args: list[str]


class CompileDatabase:
    def __init__(self, entries: dict[Path, CompileEntry]):
        self._entries = entries

    @classmethod
    def load(cls, compile_commands_path: Path) -> "CompileDatabase":
        raw = json.loads(compile_commands_path.read_text())
        entries: dict[Path, CompileEntry] = {}
        for item in raw:
            directory = Path(item["directory"])
            file_path = Path(item["file"])
            if not file_path.is_absolute():
                file_path = (directory / file_path).resolve()
            else:
                file_path = file_path.resolve()

            if "arguments" in item:
                raw_args = list(item["arguments"])
            else:
                raw_args = shlex.split(item["command"])

            compiler = raw_args[0] if raw_args else "c++"
            args = _strip_compiler_and_output(raw_args, source_file=file_path)
            args += _system_include_args(compiler)
            entries[file_path] = CompileEntry(file=file_path, directory=directory, args=args)
        return cls(entries)

    def args_for(self, file_path: Path) -> list[str] | None:
        entry = self._entries.get(file_path.resolve())
        return list(entry.args) if entry else None

    def files(self) -> list[Path]:
        return list(self._entries.keys())


def _strip_compiler_and_output(args: list[str], source_file: Path) -> list[str]:
    """Drop argv[0] (compiler binary), -o/-c flags, and the source file path itself
    (libclang's parse() takes the file path separately; leaving it in args duplicates it).
    """
    out: list[str] = []
    skip_next = False
    source_names = {str(source_file), source_file.name}
    for i, arg in enumerate(args):
        if i == 0:
            continue  # compiler binary
        if skip_next:
            skip_next = False
            continue
        if arg == "-o":
            skip_next = True
            continue
        if arg == "-c":
            continue
        if arg in source_names:
            continue
        out.append(arg)
    return out


@lru_cache(maxsize=None)
def _system_include_args(compiler: str) -> tuple[str, ...]:
    """libclang doesn't know gcc/g++'s bundled system header search paths, so ask the
    real compiler for them and pass them through as -isystem. Clang compilers already
    know their own paths, so this is a no-op for them.
    """
    if "clang" in Path(compiler).name:
        return ()

    try:
        proc = subprocess.run(
            [compiler, "-E", "-x", "c++", "-v", "/dev/null"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ()

    output = proc.stderr
    match = re.search(
        r"#include <\.\.\.> search starts here:\n(.*?)\nEnd of search list",
        output,
        re.DOTALL,
    )
    if not match:
        return ()

    paths = [line.strip() for line in match.group(1).splitlines() if line.strip()]
    result: list[str] = []
    for p in paths:
        result.extend(["-isystem", p])
    return tuple(result)
