"""SaRp CLI: semantic C++ refactor detection (and, for pimpl/forward-decl, safe rewriting)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .call_site_rewriter import apply as apply_call_sites
from .call_sites import find_call_sites
from .compdb import CompileDatabase
from .const_propagation_analyzer import ConstPropagationAnalyzer
from .const_propagation_rewriter import apply as apply_const_propagation
from .coverage_analyzer import analyze_coverage
from .extern_c_analyzer import audit_headers as audit_extern_c
from .free_function_analyzer import FreeFunctionAnalyzer
from .free_function_rewriter import apply as apply_free_function
from .full_pimpl_analyzer import FullPimplAnalyzer
from .full_pimpl_rewriter import apply as apply_full_pimpl
from .include_guard_analyzer import audit_headers as audit_include_guards
from .inline_analyzer import InlineAnalyzer
from .inline_rewriter import apply as apply_inline
from .macro_to_constexpr_analyzer import MacroToConstexprAnalyzer
from .noexcept_move_analyzer import NoexceptMoveAnalyzer
from .noexcept_move_rewriter import apply as apply_noexcept_move
from .padding_analyzer import PaddingAnalyzer
from .pimpl_analyzer import PimplAnalyzer
from .pimpl_rewriter import apply as apply_pimpl
from .project_scan import HeaderTarget, discover_headers
from .static_header_analyzer import StaticHeaderAnalyzer
from .static_header_rewriter import apply as apply_static_header


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
        help="Rewrite the declaration/definition to a free function; call sites are reported, not rewritten unless --rewrite-call-sites is also passed",
    )
    ff_cmd.add_argument(
        "--rewrite-call-sites",
        action="store_true",
        help="With --apply, also rewrite every obj.method(...) call site found project-wide to free-function syntax "
        "(sites inside a macro expansion, e.g. assert(...), are never rewritten — reported instead, since their "
        "source spans can't be trusted for a text edit)",
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

    inline_cmd = sub.add_parser(
        "missing-inline", help="Detect/apply missing 'inline' on header-defined free functions"
    )
    inline_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    inline_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    inline_cmd.add_argument("--apply", action="store_true", help="Rewrite the header(s) in place")
    inline_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    static_cmd = sub.add_parser(
        "static-header", help="Detect/apply static->inline (C++17) for namespace-scope functions/variables in headers"
    )
    static_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    static_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    static_cmd.add_argument("--apply", action="store_true", help="Rewrite the header(s) in place")
    static_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    noexcept_cmd = sub.add_parser(
        "noexcept-move",
        help="Detect/apply missing noexcept on move constructors whose bases/members are all nothrow-movable",
    )
    noexcept_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    noexcept_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    noexcept_cmd.add_argument("--apply", action="store_true", help="Rewrite the header(s) in place")
    noexcept_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    const_cmd = sub.add_parser(
        "const-propagation",
        help="Detect/apply missing const on member functions that never write instance state",
    )
    const_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    const_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    const_cmd.add_argument("--apply", action="store_true", help="Rewrite the header(s) in place")
    const_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    padding_cmd = sub.add_parser(
        "padding-report",
        help="Report struct/class padding waste and a proposed member order (report only)",
    )
    padding_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    padding_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    padding_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    macro_cmd = sub.add_parser(
        "macro-to-constexpr",
        help="Report macros that could become constexpr values/functions (report only)",
    )
    macro_cmd.add_argument("header", type=Path, nargs="?", help="A single header to analyze")
    macro_cmd.add_argument("--via", type=Path, help="A .cpp/.cc that includes this header")
    macro_cmd.add_argument(
        "--batch",
        type=Path,
        metavar="PROJECT_ROOT",
        help="Scan every project header reachable from compile_commands.json instead of a single header",
    )

    guard_cmd = sub.add_parser(
        "include-guards", help="Report include-guard collisions, missing guards, and naming mismatches (report only)"
    )
    guard_cmd.add_argument("project_root", type=Path, help="Project root to scan for headers")

    extern_c_cmd = sub.add_parser(
        "extern-c-check", help='Report headers included by C TUs but missing an extern "C" guard (report only)'
    )
    extern_c_cmd.add_argument("project_root", type=Path, help="Project root to scan for headers")

    coverage_cmd = sub.add_parser(
        "coverage",
        help="Report which TUs/headers are (not) covered by the compile database (report only)",
    )
    coverage_cmd.add_argument("project_root", type=Path, help="Project root to scan for headers")

    args = parser.parse_args(argv)

    if args.command in ("include-guards", "extern-c-check", "coverage"):
        compdb = CompileDatabase.load(args.compile_commands)
        if args.command == "include-guards":
            return _run_include_guards(args)
        if args.command == "extern-c-check":
            return _run_extern_c(args, compdb)
        return _run_coverage(args, compdb)

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
    if args.command == "missing-inline":
        return _run_missing_inline(args, compdb)
    if args.command == "static-header":
        return _run_static_header(args, compdb)
    if args.command == "noexcept-move":
        return _run_noexcept_move(args, compdb)
    if args.command == "const-propagation":
        return _run_const_propagation(args, compdb)
    if args.command == "padding-report":
        return _run_padding_report(args, compdb)
    if args.command == "macro-to-constexpr":
        return _run_macro_to_constexpr(args, compdb)
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

                if not sites:
                    print("    No call sites found in the scanned translation units.")
                elif args.rewrite_call_sites:
                    call_results = apply_call_sites(sites, c.method_name)
                    rewritten = [s for s in sites if s.rewritable]
                    not_rewritable = [s for s in sites if not s.rewritable]
                    if rewritten:
                        print(f"    Rewrote {len(rewritten)} call site(s) to free-function syntax:")
                        for file, (_, safety) in call_results.items():
                            print(f"      {file}")
                            print(f"        Patch saved to {safety.patch_path} (revert: patch -R < {safety.patch_path.name})")
                            if safety.git_commit:
                                print(f"        Committed as {safety.git_commit[:12]} (revert: git revert {safety.git_commit[:12]})")
                            else:
                                print(f"        No git commit made ({safety.git_skipped_reason})")
                    if not_rewritable:
                        print(
                            f"    WARNING: {len(not_rewritable)} call site(s) could NOT be auto-rewritten "
                            f"(inside a macro expansion — e.g. assert(...) — where the source span can't be "
                            f"trusted for a text edit) and need manual updates:"
                        )
                        for s in not_rewritable:
                            print(f"      {s.file}:{s.line}  {s.source_line}")
                else:
                    print(f"    WARNING: {len(sites)} call site(s) need manual updates (old obj.{c.method_name}(...) syntax will not compile):")
                    for s in sites:
                        print(f"      {s.file}:{s.line}  {s.source_line}")

    if args.batch:
        print(
            f"\n{total_candidates} candidate(s) found across {headers_with_candidates} header(s) "
            f"(of {len(targets)} scanned)."
        )
    if not args.apply:
        print("(report only; pass --apply to rewrite the declaration/definition — call sites are always reported, "
              "never auto-rewritten unless --rewrite-call-sites is also passed)")
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


def _run_missing_inline(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = InlineAnalyzer(compdb)
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
                print(f"No missing-inline candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Missing-inline candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.line}: {c.function_name} -> add inline ({c.reason})")

        if args.apply:
            _, safety = apply_inline(report)
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


def _run_static_header(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = StaticHeaderAnalyzer(compdb)
    targets = _targets(args, compdb)
    total_candidates = 0
    headers_with_candidates = 0

    for target in targets:
        try:
            report = analyzer.analyze_header(target.header, target.via)
        except (ValueError, RuntimeError) as err:
            print(f"  {target.header}: skipped ({err})")
            continue

        if report.rejected_pre_cxx17:
            if not args.batch:
                print(f"  {report.header_path}: skipped (REJECT: target is not compiled as C++17 or later)")
            continue

        if not report.candidates:
            if not args.batch:
                print(f"No static-header candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Static-header candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.line}: {c.kind} '{c.name}' -> static to inline ({c.reason})")

        if args.apply:
            _, safety = apply_static_header(report)
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


def _run_noexcept_move(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = NoexceptMoveAnalyzer(compdb)
    targets = _targets(args, compdb)
    total_candidates = 0
    headers_with_candidates = 0

    for target in targets:
        try:
            report = analyzer.analyze_header(target.header, target.via)
        except (ValueError, RuntimeError) as err:
            print(f"  {target.header}: skipped ({err})")
            continue

        if report.skipped and not args.batch:
            for class_name, reason in report.skipped.items():
                print(f"Skipped {class_name} in {report.header_path}: {reason}")

        if not report.candidates:
            if not args.batch:
                print(f"No noexcept-move candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Noexcept-move candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.move_ctor_line}: {c.class_name} -> add noexcept ({c.reason})")

        if args.apply:
            _, safety = apply_noexcept_move(report)
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


def _run_const_propagation(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = ConstPropagationAnalyzer(compdb)
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
                print(f"No const-propagation candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Const-propagation candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.line}: {c.class_name}::{c.method_name} -> add const ({c.reason})")

        if args.apply:
            _, safety = apply_const_propagation(report)
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


def _run_padding_report(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = PaddingAnalyzer(compdb)
    targets = _targets(args, compdb)
    total_candidates = 0
    headers_with_candidates = 0

    for target in targets:
        try:
            report = analyzer.analyze_header(target.header, target.via)
        except (ValueError, RuntimeError) as err:
            print(f"  {target.header}: skipped ({err})")
            continue

        if report.skipped and not args.batch:
            for class_name, reason in report.skipped.items():
                print(f"Skipped {class_name} in {report.header_path}: {reason}")

        if not report.candidates:
            if not args.batch:
                print(f"No padding candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Padding report for {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.line}: {c.class_name} -- {c.reason}")
            print(f"    current order:  {[f.name for f in c.current_fields]}")
            print(f"    proposed order: {c.proposed_order}")

    if args.batch:
        print(
            f"\n{total_candidates} candidate(s) found across {headers_with_candidates} header(s) "
            f"(of {len(targets)} scanned)."
        )
    print("(report only; no auto-fix -- reordering members is an ABI change)")
    return 0


def _run_macro_to_constexpr(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    analyzer = MacroToConstexprAnalyzer(compdb)
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
                print(f"No macro-to-constexpr candidates found in {report.header_path}")
            continue

        headers_with_candidates += 1
        total_candidates += len(report.candidates)
        print(f"Macro-to-constexpr candidates in {report.header_path}:")
        for c in report.candidates:
            print(f"  line {c.line}: {c.macro_name} -> {c.proposed}")

    if args.batch:
        print(
            f"\n{total_candidates} candidate(s) found across {headers_with_candidates} header(s) "
            f"(of {len(targets)} scanned)."
        )
    print("(report only; no auto-fix -- replacing a macro can subtly change call-site semantics)")
    return 0


def _run_include_guards(args: argparse.Namespace) -> int:
    report = audit_include_guards(args.project_root)
    if not report.issues:
        print(f"No include-guard issues found under {args.project_root}")
        return 0

    print(f"Include-guard issues under {args.project_root}:")
    for issue in report.issues:
        print(f"  {issue.header} [{issue.issue}]: {issue.detail}")
    print(f"\n{len(report.issues)} issue(s) found. (report only; no auto-fix)")
    return 0


def _run_extern_c(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    report = audit_extern_c(compdb, args.project_root)
    if not report.issues:
        print(f"No extern \"C\" guard issues found under {args.project_root}")
        return 0

    print(f"extern \"C\" guard issues under {args.project_root}:")
    for issue in report.issues:
        consumers = ", ".join(str(c) for c in issue.c_consumers)
        print(f"  {issue.header}: {issue.reason}")
        print(f"    consumed by: {consumers}")
    print(f"\n{len(report.issues)} issue(s) found. (report only; no auto-fix)")
    return 0


def _run_coverage(args: argparse.Namespace, compdb: CompileDatabase) -> int:
    report = analyze_coverage(compdb, args.project_root)

    print(f"Analysis coverage for {args.project_root}:")
    print(f"  {report.total_tus} TU(s) in the compile database")
    if report.unparseable_tus:
        print(f"  {len(report.unparseable_tus)} unparseable (excluded from every analysis):")
        for file, message in report.unparseable_tus:
            print(f"    {file}: {message}")
    else:
        print("  0 unparseable")

    print(f"  {len(report.covered_headers)} header(s) covered (reachable from a parseable TU)")
    print(f"  {len(report.uncovered_headers)} header(s) NOT covered:")
    for header in report.uncovered_headers:
        print(f"    {header}")

    print(
        "\n(report only; whole-program analyses are only as trustworthy as this "
        "coverage — an uncovered header/TU is invisible to them)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
