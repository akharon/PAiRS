# SaRp — Semantic Analysis Recursive Processor

SaRp is a libclang-based CLI for detecting (and safely rewriting) three C++ refactor
patterns that need real semantic analysis, not just text/syntax matching:

1. **Forward-declaration / pimpl-style include pruning** — find `#include`s in a
   header that are only ever needed as an incomplete type (pointer/reference members,
   pointer/reference parameters — never a value, never member access inline), and
   replace them with a forward declaration.
2. **Member function → free function** — find non-static, non-virtual methods whose
   bodies never touch instance state (no field access, no calls to other non-static
   member functions, no `this`), and convert them into free functions.
3. **Full pimpl idiom** — find classes whose entire private state can be moved into a
   `struct Impl` (defined in the `.cpp`), replaced by a single
   `std::unique_ptr<Impl> impl_` member in the header, and rewrite both files.
4. **Missing `inline` on header functions** — find non-template, non-`static`,
   non-`constexpr` free functions *defined* (not just declared) in a header, and add
   `inline`. Without it, every translation unit that includes the header gets its own
   definition — an ODR violation that either silently misbehaves or fails to link.
5. **`static` in headers → `inline` (C++17)** — find `static` free functions and
   namespace-scope variables in a header (each including TU gets a private copy) and
   convert them to C++17 `inline`, which gives a single shared definition instead.
   Skipped entirely (reported as a rejection, not silently ignored) when the target
   isn't compiled as C++17 or later.
6. **Include-guard audit** (report only) — flags headers with no guard at all, guard
   macros that collide across two different files (a silent "header vanishes" bug), and
   guard names that don't match the project's path-derived naming convention.
7. **`extern "C"` guard check** (report only) — flags C++ headers pulled in by a `.c`
   translation unit that have no `extern "C"` guard, which compiles fine under C but
   fails to link once the C++ side name-mangles the same declarations.
8. **`noexcept` inference for move constructors** — find user-provided (has a body)
   move constructors that aren't `noexcept` even though every base/member's own move
   operation is, and add it. `std::vector` and friends silently fall back to copying
   instead of moving when a type's move constructor isn't `noexcept`, which is often
   the single biggest hidden performance bug in code that "already uses move
   semantics." (Implicitly-defaulted move constructors are left alone — the compiler
   already derives their noexcept-ness correctly.)
9. **`const` propagation** — find non-const, non-virtual member functions whose bodies
   never write a member (no assignment, `++`/`--`, or address-of on a field) and never
   call another non-const member function, and add `const`.
10. **Struct padding report** (report only) — uses Clang's actual computed layout
    (`Type.get_size`/`get_align`/`get_offset`, exact byte counts, not a heuristic) to
    find classes that would be smaller under a descending-alignment member reordering,
    and reports the proposed order and byte savings. Never auto-applied: reordering
    members is an ABI change (serialization, `offsetof`, anything reading raw memory).
11. **Macro → `constexpr` report** (report only) — flags object-like macros that are a
    single literal value, and function-like macros whose expansion is one expression
    evaluating each parameter exactly once, as safe to convert to a typed `constexpr`
    equivalent (shown in the report). Rejects macros used in `#if`/`#ifdef`, using
    `#`/`##`, or evaluating a parameter more than once (a real bug class the "convert
    to a function" fix would silently break the behavior of).
12. **Analysis-coverage report** (report only) — every other whole-program-flavored
    claim SaRp makes is only as true as the compile database it was given; this reports
    which TUs fail to parse (and are therefore invisible to every other analysis) and
    which project headers are never reached by any parseable TU.

All three analyses use [libclang](https://clang.llvm.org/docs/Tooling.html) to build a
real AST from your project's `compile_commands.json` — not tree-sitter or regex —
because correctly answering "does this only need an incomplete type" or "does this
method touch instance state" requires actual semantic resolution (overload resolution,
type completeness, access checking), not syntax.

## Why not just automate everything?

All three refactors are conservative by design:

- **Forward-decl** only ever proposes a rewrite when it's certain: if *any* usage of a
  type across the class needs the complete type (by value, member access, sizeof), the
  `#include` is kept. `rename_symbol`-style "abort untouched if anything looks unsafe"
  — no partial edits.
- **Free-function** conversion rewrites the declaration and definition; call sites
  (`obj.method(x)`) are found project-wide and, with `--rewrite-call-sites`, rewritten
  to `method(obj, x)` / `method(*obj, x)` — but only sites whose source spans can be
  trusted for a mechanical text edit. A call site sitting inside a macro expansion
  (`assert(obj.method(x))`, a custom logging macro, etc.) is never auto-rewritten,
  because libclang's cursor extents for macro-expanded code can be
  empty/degenerate — trusting them corrupted a test file during development, which is
  exactly the failure mode this check exists to prevent. Such sites are still reported
  by file:line for a manual update. Without `--rewrite-call-sites`, `--apply` only
  touches the declaration/definition and reports every call site as before.
- **Full pimpl** only offers a class as a candidate when the rewrite can be applied by
  pure text substitution with no risk of changing behavior: every private member must
  be a data field (no private methods), no protected members, no member-initializer-list
  entries for private fields (`: x_(x)` needs a structural move into `Impl`'s own
  constructor, not a substitution — such a class is skipped, not half-rewritten), and
  every method touching a private field must have its definition visible in the
  translation unit being analyzed. A class is skipped, with a stated reason, rather
  than partially converted.

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

# Also rewrite obj.method(x) call sites, project-wide, to method(obj, x):
sarp --compile-commands build/compile_commands.json \
    free-function src/calculator.h --via src/calculator.cpp --apply --rewrite-call-sites
```

`full-pimpl` follows the same `--via` rule as `free-function` — it needs to see method
*definitions*, not just declarations, to know exactly which field accesses to rewrite:

```bash
sarp --compile-commands build/compile_commands.json \
    full-pimpl src/counter.h --via src/counter.cpp --apply
```

`missing-inline` and `static-header` follow the same single-header `--via` shape as
`forward-decl`:

```bash
sarp --compile-commands build/compile_commands.json \
    missing-inline src/widget.h --via src/widget.cpp --apply

sarp --compile-commands build/compile_commands.json \
    static-header src/widget.h --via src/widget.cpp --apply
```

`noexcept-move` and `const-propagation` also follow that shape:

```bash
sarp --compile-commands build/compile_commands.json \
    noexcept-move src/widget.h --via src/widget.cpp --apply

sarp --compile-commands build/compile_commands.json \
    const-propagation src/widget.h --via src/widget.cpp --apply
```

`padding-report` and `macro-to-constexpr` are single-header report-only checks (no
`--apply`, but still take `--via`/`--batch` like the others):

```bash
sarp --compile-commands build/compile_commands.json padding-report src/widget.h --via src/widget.cpp
sarp --compile-commands build/compile_commands.json macro-to-constexpr src/widget.h --via src/widget.cpp
```

`include-guards`, `extern-c-check`, and `coverage` are project-wide, report-only audits
(no `--apply`, no `--via`):

```bash
sarp --compile-commands build/compile_commands.json include-guards .
sarp --compile-commands build/compile_commands.json extern-c-check .
sarp --compile-commands build/compile_commands.json coverage .
```

### Batch mode

Scan every header reachable from `compile_commands.json` in one pass, instead of one
`--via` pair at a time:

```bash
sarp --compile-commands build/compile_commands.json forward-decl --batch .
sarp --compile-commands build/compile_commands.json free-function --batch .
sarp --compile-commands build/compile_commands.json full-pimpl --batch .
sarp --compile-commands build/compile_commands.json missing-inline --batch .
sarp --compile-commands build/compile_commands.json static-header --batch .
sarp --compile-commands build/compile_commands.json noexcept-move --batch .
sarp --compile-commands build/compile_commands.json const-propagation --batch .
sarp --compile-commands build/compile_commands.json padding-report --batch .
sarp --compile-commands build/compile_commands.json macro-to-constexpr --batch .
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
    free-function src/calculator.h --via src/calculator.cpp --apply --rewrite-call-sites

Free-function candidates in src/calculator.h:
  line 8: Calculator::sumTwo -> free function (body references no instance fields or non-static member calls; usable via public API only)
    Rewrote src/calculator.h
    Patch saved to src/calculator.h.sarp.patch (revert: patch -R < calculator.h.sarp.patch)
    Committed as 3b90dad1a2c3 (revert: git revert 3b90dad1a2c3)
    Rewrote src/calculator.cpp
    Patch saved to src/calculator.cpp.sarp.patch (revert: patch -R < calculator.cpp.sarp.patch)
    Committed as 9f8e7d6c5b4a (revert: git revert 9f8e7d6c5b4a)
    Rewrote 1 call site(s) to free-function syntax:
      src/main.cpp
        Patch saved to src/main.cpp.sarp.patch (revert: patch -R < main.cpp.sarp.patch)
        Committed as a1b2c3d4e5f6 (revert: git revert a1b2c3d4e5f6)
```
`src/main.cpp:9` goes from `calc.sumTwo(2, 3)` to `sumTwo(calc, 2, 3)` — verified end to
end against a real CMake project (the whole project still builds and runs correctly
after the rewrite).

Without `--rewrite-call-sites`, the same command instead prints each call site for a
manual update:
```
    WARNING: 1 call site(s) need manual updates (old obj.sumTwo(...) syntax will not compile):
      src/main.cpp:9  std::cout << "sumTwo: " << calc.sumTwo(2, 3) << std::endl;
```

```
$ sarp --compile-commands build/compile_commands.json \
    full-pimpl src/counter.h --via src/counter.cpp --apply

Full-pimpl candidates in src/counter.h:
  class Counter: 1 private field(s), all accesses in analyzed method bodies
    Rewrote src/counter.h
    Patch saved to src/counter.h.sarp.patch (revert: patch -R < counter.h.sarp.patch)
    Committed as f4a2b8c91d0e (revert: git revert f4a2b8c91d0e)
    Rewrote src/counter.cpp
    Patch saved to src/counter.cpp.sarp.patch (revert: patch -R < counter.cpp.sarp.patch)
    Committed as 7c3e9f1a2b5d (revert: git revert 7c3e9f1a2b5d)
```

Before:
```cpp
// counter.h
class Counter {
public:
    explicit Counter(int start);
    int value() const;
    void increment();
private:
    int value_ = 0;
};
```
After:
```cpp
// counter.h
#include <memory>
class Counter {
public:
    ~Counter();
    explicit Counter(int start);
    int value() const;
    void increment();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// counter.cpp
struct Counter::Impl {
    int value_ = 0;
};
Counter::~Counter() = default;
Counter::Counter(int start) {
    impl_ = std::make_unique<Impl>();
    impl_->value_ = start;
}
// ...impl_->value_ everywhere value_ used to appear
```

## Limitations

- **No `#ifdef`/macro-conditional awareness.** If a header behaves differently across
  translation units (rare, but possible with heavy conditional compilation), SaRp
  analyzes it via a single TU and won't catch the divergence.
- **Free-function call sites are reported by default; `--rewrite-call-sites` rewrites
  the ones it can trust.** A call site inside a macro expansion (`assert(...)`, a
  logging macro, etc.) is always excluded from the rewrite and reported instead — its
  source spans aren't reliable for a text edit. Update those by hand.
- **No `#include`-what-you-use for `.cpp` files** — only header `#include`s are
  analyzed for forward-decl candidates, not a `.cpp`'s own includes. (A true
  "is this include entirely unused" check was attempted and dropped: `#pragma once`/
  include-guard semantics mean a header is only textually included once per
  translation unit, via whichever top-level `#include` reaches it first in
  preprocessing order — so the include graph doesn't reliably show which top-level
  include is "responsible" for a given symbol, causing real false positives on
  standard library headers.)
- **`full-pimpl` doesn't handle private methods, protected members, or
  member-initializer-list field initialization** — a class using any of these is
  skipped with a stated reason rather than partially rewritten. It also requires an
  explicit user-declared constructor (the compiler-generated default constructor can't
  be given an `impl_` initializer).
- All three analyses require the target header/method to be reachable from at least
  one parseable translation unit in `compile_commands.json`; unparseable files are
  skipped (batch mode) or reported as an error (single-file mode), never silently
  miscounted.

## Deliberately not implemented

A few candidate features were evaluated and rejected or deferred rather than shipped
half-working:

- **Friend reduction / access narrowing** — need a whole-program usage scan across
  every TU (not just one `--via` file per header), which is materially more machinery
  than the single-header analyses above. Worth building once, since narrowing access
  also enables anonymous-namespace extraction and more pimpl candidates.
- **Cross-TU ODR detection, internal-linkage promotion, `final` inference** — all need
  the same whole-program scan as above (safe use of any of them requires seeing every
  translation unit that could reference the symbol/class in question, not one).
- **Include-path explanation** — needs a persistent include graph (KuzuDB or
  equivalent) that doesn't exist in this project yet.
- **Compile-time regression attribution** — needs `-ftime-trace` diffing across two
  git commits, a build-timing subsystem unrelated to the AST-based analyses here.
- **`constinit`/constant-initialization enforcement** — libclang's stable C API has no
  `isConstantInitializer` (or `clang_Cursor_Evaluate`) entry point in this version;
  approximating it with a token-level heuristic was rejected rather than risk a wrong
  answer on a feature this project's own design doc flags as safety-critical
  (MISRA/ISO 26262 relevant).

## Development

```bash
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest          # 132 tests, ~8s — no real project needed, uses a
                           # temp-dir C++ project harness (test/conftest.py)
```
