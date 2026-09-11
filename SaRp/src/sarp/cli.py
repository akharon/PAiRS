"""SaRp CLI: semantic C++ refactor detection (and, for pimpl/forward-decl, safe rewriting)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .call_sites import find_call_sites
from .compdb import CompileDatabase
from .free_function_analyzer import FreeFunctionAnalyzer
from .free_function_rewriter import apply as apply_free_function
from .full_pimpl_analyzer import FullPimplAnalyzer
from .full_pimpl_rewriter import apply as apply_full_pimpl
from .pimpl_analyzer import PimplAnalyzer
from .pimpl_rewriter import apply as apply_pimpl
from .project_scan import HeaderTarget, discover_headers


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
    pimpl_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    pimpl_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    pimpl_cmd.add_argument("--apply", action="store_true", help="Rewrite the header(s) in place")
    pimpl_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    ff_cmd = sub.add_parser("free-function", help="Detect member functions that could be free functions")
    ff_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    ff_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that DEFINES this header's methods (not just includes it)")
    ff_cmd.add_argument(
        "--apply",
        action="store_true",
        help="Rewrite the declaration/definition to a free function; call sites are reported, not rewritten",
    )
    ff_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    fp_cmd = sub.add_parser(
        "full-pimpl", help="Detect/apply the full pimpl idiom (move private fields into a struct Impl)"
    )
    fp_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    fp_cmd.add_argument(
        "--via", type=Path, help="A .cpp/.cc that DEFINES this header's methods (not just includes it)"
    )
    fp_cmd.add_argument("--apply", action="store_true", help="Rewrite the header and .cpp in place")
    fp_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    args = parser.parse_args(argv)

    if args.batch and (args.header or args.via):
        parser.error("--batch cannot be combined with a single header/--via")
    if not args.batch and (args.header is None or args.via is None):
        parser.error("either provide both HEADER and --via, or use --batch PROJECT_ROOT")

    compdb = CompileDatabase.load(args.compile_commands)

    if args.command == "forward-decl":
        return _run_forward_decl(args, compdb)
    if args.command == "free-function":
        return _run_free_function(args, compdb)
    if args.command == "full-pimpl":
        return _run_full_pimpl(args, compdb)
    return 1


def _targets(args: argparse.Namespace, compdb: CompileDatabase) -> list[HeaderTarget]:
    if args.batch:
        targets = discover_headers(compdb, args.batch)
        print(f"Scanning {len(targets)} header(s) under {args.batch}...")
        return targets
    return [HeaderTarget(header=args.header, via=args.via)]


def _run_forward_decl(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = PimplAnalyzer(compdb)
    targets = _targets(args, compdb)
    total_candidates = 0
    headers_with_candidates = 0

    for target in targets:
        try:
            report = analyzer.analyze_header(target.header, target.via)
        except (ValueError, RuntimeError) as err:
            print(f"  {target.header}: skipped ({err})")
            continue

        if not report.candidates:
            if not args.batch:
                print(f"No forward-decl candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Forward-decl candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.include_line}: #include for '{c.type_name}' -> forward decl ({c.reason})")

        if args.apply:
            _, safety = apply_pimpl(report)
            print(f"  Applied {len(report.candidates)} rewrite(s) to {report.header_path}")
            print(f"  Patch saved to {safety.patch_path} (revert: patch -R < {safety.patch_path.name})")
            if safety.git_commit:
                print(f"  Committed as {safety.git_commit[:12]} (revert: git revert {safety.git_commit[:12]})")
            else:
                print(f"  No git commit made ({safety.git_skipped_reason})")

    if args.batch:
        print(
            f"\n{total_candidates} candidate(s) found across {headers_with_candidates} header(s) "
            f"(of {len(targets)} scanned)."
        )
        if not args.apply and total_candidates:
            print("(dry run; pass --apply to rewrite the headers)")
    elif not args.apply and total_candidates:
        print("(dry run; pass --apply to rewrite the header)")

    return 0


def _run_free_function(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = FreeFunctionAnalyzer(compdb)
    targets = _targets(args, compdb)
    total_candidates = 0
    headers_with_candidates = 0

    for target in targets:
        try:
            report = analyzer.analyze_header(target.header, target.via)
        except (ValueError, RuntimeError) as err:
            print(f"  {target.header}: skipped ({err})")
            continue

        if not report.candidates:
            if not args.batch:
                print(f"No free-function candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Free-function candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.header_line}: {c.class_name}::{c.method_name} -> free function ({c.reason})")

            if args.apply:
                # Must run BEFORE the rewrite: it re-parses every TU in the project and
                # resolves sumTwo as a *member* of the class, which no longer exists
                # once the declaration has been rewritten to a free function.
                sites = find_call_sites(compdb, c.class_name, c.method_name, c.declaration_span.file)

                changed = apply_free_function(c)
                for file, (_, safety) in changed.items():
                    print(f"    Rewrote {file}")
                    print(f"    Patch saved to {safety.patch_path} (revert: patch -R < {safety.patch_path.name})")
                    if safety.git_commit:
                        print(f"    Committed as {safety.git_commit[:12]} (revert: git revert {safety.git_commit[:12]})")
                    else:
                        print(f"    No git commit made ({safety.git_skipped_reason})")

                if sites:
                    print(f"    WARNING: {len(sites)} call site(s) need manual updates (old obj.{c.method_name}(...) syntax will not compile):")
                    for s in sites:
                        print(f"      {s.file}:{s.line}  {s.source_line}")
                else:
                    print("    No call sites found in the scanned translation units.")

    if args.batch:
        print(
            f"\n{total_candidates} candidate(s) found across {headers_with_candidates} header(s) "
            f"(of {len(targets)} scanned)."
        )
    if not args.apply:
        print("(report only; pass --apply to rewrite the declaration/definition — call sites are always reported, never auto-rewritten)")
    return 0


def _run_full_pimpl(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = FullPimplAnalyzer(compdb)
    targets = _targets(args, compdb)
    total_candidates = 0
    headers_with_candidates = 0

    for target in targets:
        try:
            report = analyzer.analyze_header(target.header, target.via)
        except (ValueError, RuntimeError) as err:
            print(f"  {target.header}: skipped ({err})")
            continue

        if not report.candidates and not report.skipped:
            if not args.batch:
                print(f"No full-pimpl candidates found in {report.header_path}")
            continue

        if report.skipped and not args.batch:
            for class_name, reason in report.skipped.items():
                print(f"Skipped {class_name} in {report.header_path}: {reason}")

        if not report.candidates:
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Full-pimpl candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  class {c.class_name}: {c.reason}")

            if args.apply:
                changed = apply_full_pimpl(c, target.via)
                for file, (_, safety) in changed.items():
                    print(f"    Rewrote {file}")
                    print(f"    Patch saved to {safety.patch_path} (revert: patch -R < {safety.patch_path.name})")
                    if safety.git_commit:
                        print(f"    Committed as {safety.git_commit[:12]} (revert: git revert {safety.git_commit[:12]})")
                    else:
                        print(f"    No git commit made ({safety.git_skipped_reason})")

    if args.batch:
        print(
            f"\n{total_candidates} candidate(s) found across {headers_with_candidates} header(s) "
            f"(of {len(targets)} scanned)."
        )
    if not args.apply and total_candidates:
        print("(dry run; pass --apply to rewrite the header and .cpp)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
