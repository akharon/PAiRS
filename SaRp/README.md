# SaRp — Semantic Analysis Recursive Processor

SaRp is a libclang-based CLI for detecting (and safely rewriting) two C++ refactor
patterns that need real semantic analysis, not just text/syntax matching:

1. **Forward-declaration / pimpl-style include pruning** — find `#include`s in a
   header that are only ever needed as an incomplete type (pointer/reference members,
   pointer/reference parameters — never a value, never member access inline), and
   replace them with a forward declaration.
2. **Member function → free function** — find non-static, non-virtual methods whose
   bodies never touch instance state (no field access, no calls to other non-static
   member functions, no `this`), and convert them into free functions.

Both analyses use [libclang](https://clang.llvm.org/docs/Tooling.html) to build a real
AST from your project's `compile_commands.json` — not tree-sitter or regex — because
correctly answering "does this only need an incomplete type" or "does this method
touch instance state" requires actual semantic resolution (overload resolution, type
completeness, access checking), not syntax.

## Why not just automate everything?

Both refactors are conservative by design:

- **Forward-decl** only ever proposes a rewrite when it's certain: if *any* usage of a
  type across the class needs the complete type (by value, member access, sizeof), the
  `#include` is kept. `rename_symbol`-style "abort untouched if anything looks unsafe"
  — no partial edits.
- **Free-function** conversion rewrites the declaration and definition, but **never**
  touches call sites automatically. Finding and atomically rewriting every
  `obj.method(x)` → `method(obj, x)` call site across an entire project is a much
  larger, riskier operation than this tool currently attempts. Instead, `--apply`
  prints every call site that needs a manual update, with file:line and the source
  line itself.

## Installation

```bash
cd SaRp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

This installs the `sarp` command into `.venv/bin/sarp` and pulls in `libclang` (the
Python bindings, which bundle their own `libclang.so` — no separate LLVM/Clang install
required beyond what your project's compiler already provides).

Your project needs a `compile_commands.json` (CMake: add
`-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`; other build systems have equivalents, or use
[Bear](https://github.com/rizsotto/Bear) to generate one from any build).

## Usage

### Single header

```bash
# Dry run — report only, no files touched
sarp --compile-commands build/compile_commands.json \
    forward-decl src/widget.h --via src/widget.cpp

# Apply the rewrite
sarp --compile-commands build/compile_commands.json \
    forward-decl src/widget.h --via src/widget.cpp --apply
```

`--via` must be a `.cpp`/`.cc` file whose translation unit includes the header. For
`free-function`, `--via` should ideally be the file that actually **defines** the
methods (usually the same-basename `.cpp`, e.g. `widget.cpp` for `widget.h`) — a TU
that only sees the header's declarations (via a transitive include) can't see method
bodies, and will silently report zero candidates.

```bash
sarp --compile-commands build/compile_commands.json \
    free-function src/calculator.h --via src/calculator.cpp --apply
```

### Batch mode

Scan every header reachable from `compile_commands.json` in one pass, instead of one
`--via` pair at a time:

```bash
sarp --compile-commands build/compile_commands.json forward-decl --batch .
sarp --compile-commands build/compile_commands.json free-function --batch .
```

For each header, SaRp picks a `--via` file automatically: the same-basename `.cpp` if
one includes it (e.g. `widget.cpp` for `widget.h`), otherwise the first `.cpp` (in
`compile_commands.json` order) that reaches it.

## Safety net for `--apply`

Every real (non-dry-run) rewrite is revertable two ways:

1. **Always**: a unified-diff `.sarp.patch` file is written next to the rewritten file.
   ```bash
   patch -R < widget.h.sarp.patch   # revert
   ```
2. **When the file is in a clean git working tree** (no pre-existing uncommitted
   changes to that specific file): the change is additionally committed, and the SHA
   is printed.
   ```bash
   git revert <sha>   # revert
   ```
   If the file already had uncommitted changes before the rewrite, or isn't in a git
   repo at all, SaRp skips the commit and says why — it never bundles its own edit
   together with your in-progress work, and never fails the rewrite itself just
   because a commit couldn't be made.

## Example

```
$ sarp --compile-commands build/compile_commands.json \
    forward-decl src/widget.h --via src/widget.cpp --apply

Forward-decl candidates in src/widget.h:
  line 6: #include for 'Gadget' -> forward decl (only used by pointer/reference (no member access, no value semantics))
  Applied 1 rewrite(s) to src/widget.h
  Patch saved to src/widget.h.sarp.patch (revert: patch -R < widget.h.sarp.patch)
  Committed as a17b85219f41 (revert: git revert a17b85219f41)
```

```
$ sarp --compile-commands build/compile_commands.json \
    free-function src/calculator.h --via src/calculator.cpp --apply

Free-function candidates in src/calculator.h:
  line 8: Calculator::sumTwo -> free function (body references no instance fields or non-static member calls; usable via public API only)
    Rewrote src/calculator.h
    Patch saved to src/calculator.h.sarp.patch (revert: patch -R < calculator.h.sarp.patch)
    Committed as 3b90dad1a2c3 (revert: git revert 3b90dad1a2c3)
    Rewrote src/calculator.cpp
    Patch saved to src/calculator.cpp.sarp.patch (revert: patch -R < calculator.cpp.sarp.patch)
    Committed as 9f8e7d6c5b4a (revert: git revert 9f8e7d6c5b4a)
    WARNING: 1 call site(s) need manual updates (old obj.sumTwo(...) syntax will not compile):
      src/main.cpp:9  std::cout << "sumTwo: " << calc.sumTwo(2, 3) << std::endl;
```

## Limitations

- **No `#ifdef`/macro-conditional awareness.** If a header behaves differently across
  translation units (rare, but possible with heavy conditional compilation), SaRp
  analyzes it via a single TU and won't catch the divergence.
- **Free-function call sites are reported, never rewritten.** You update them by hand
  (or with your editor's find/replace) using the printed file:line list.
- **No `#include`-what-you-use for `.cpp` files** — only header `#include`s are
  analyzed for forward-decl candidates, not a `.cpp`'s own includes.
- **No full pimpl pattern** (moving all private members into a `struct Impl`) — only
  the narrower forward-decl-and-prune step.
- Both analyses require the target header/method to be reachable from at least one
  parseable translation unit in `compile_commands.json`; unparseable files are skipped
  (batch mode) or reported as an error (single-file mode), never silently miscounted.

## Development

```bash
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest          # 48 tests, ~1.5s — no real project needed, uses a
                           # temp-dir C++ project harness (test/conftest.py)
```
