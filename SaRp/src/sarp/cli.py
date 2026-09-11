"""SaRp CLI: semantic C++ refactor detection (and, for pimpl/forward-decl, safe rewriting)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .compdb import CompileDatabase
from .free_function_analyzer import FreeFunctionAnalyzer
from .pimpl_analyzer import PimplAnalyzer
from .pimpl_rewriter import apply as apply_pimpl


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sarp")
    parser.add_argument(
        "--compile-commands",
        required=True,
        type=Path,
        help="Path to compile_commands.json",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    pimpl_cmd = sub.add_parser("forward-decl", help="Detect/apply forward-decl candidates")
    pimpl_cmd.add_argument("header", type=Path)
    pimpl_cmd.add_argument("--via", required=True, type=Path, help="A .cpp/.cc that includes this header")
    pimpl_cmd.add_argument("--apply", action="store_true", help="Rewrite the header in place")

    ff_cmd = sub.add_parser("free-function", help="Detect member functions that could be free functions")
    ff_cmd.add_argument("header", type=Path)
    ff_cmd.add_argument("--via", required=True, type=Path)

    args = parser.parse_args(argv)
    compdb = CompileDatabase.load(args.compile_commands)

    if args.command == "forward-decl":
        analyzer = PimplAnalyzer(compdb)
        report = analyzer.analyze_header(args.header, args.via)
        if not report.candidates:
            print(f"No forward-decl candidates found in {report.header_path}")
            return 0

        print(f"Forward-decl candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.include_line}: #include for '{c.type_name}' -> forward decl ({c.reason})")

        if args.apply:
            _, safety = apply_pimpl(report)
            print(f"Applied {len(report.candidates)} rewrite(s) to {report.header_path}")
            print(f"Patch saved to {safety.patch_path} (revert: patch -R < {safety.patch_path.name})")
            if safety.git_commit:
                print(f"Committed as {safety.git_commit[:12]} (revert: git revert {safety.git_commit[:12]})")
            else:
                print(f"No git commit made ({safety.git_skipped_reason})")
        else:
            print("(dry run; pass --apply to rewrite the header)")
        return 0

    if args.command == "free-function":
        analyzer = FreeFunctionAnalyzer(compdb)
        report = analyzer.analyze_header(args.header, args.via)
        if not report.candidates:
            print(f"No free-function candidates found in {report.header_path}")
            return 0

        print(f"Free-function candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.header_line}: {c.class_name}::{c.method_name} -> free function ({c.reason})")
        print("(report only; no automatic rewrite for this refactor)")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
