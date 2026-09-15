# SaRp Codebase Documentation

## Session preferences

- Keep chat responses silent/minimal to save tokens — avoid narration, progress updates, or verbose explanations unless asked.
- Use `/pairs` skill for code navigation instead of Read/grep — saves 40-60% of lookup tokens.
- Batch independent Read/Edit/Bash calls together to reduce round-trips.
- Trust diffs on edits — never ask to verify changes after Edit tool succeeds.
- Ask for specific line ranges when reading large files, not whole files.
- Reference code by `file:line` markdown links instead of quoting content.
- **Save project context to memory** → `/home/mkyr/.claude/projects/-home-mkyr/memory/` (e.g., architectural decisions, common patterns, token optimizations learned).

---

**SaRp** (Semantic Analysis Recursive Processor) is a libclang-based CLI tool for detecting and safely rewriting C++ refactoring patterns that require real semantic analysis. It analyzes your project's `compile_commands.json` to build a real AST and identify opportunities for safe, automated refactoring.

---

## Supported Analyses

SaRp performs 12 analyses across a C++ codebase, grouped into three categories:

### Automated Rewrites (with `--apply` flag)

1. **Forward-declaration / pimpl-style include pruning**
   - Finds `#include`s in headers only needed as incomplete types
   - Replaces with forward declarations when safe
   - Conservative: keeps includes if *any* usage needs the complete type

2. **Member function → free function**
   - Detects non-static, non-virtual methods that never touch instance state
   - Converts to free functions in both declaration and definition
   - With `--rewrite-call-sites`, updates all call sites project-wide
   - Skips call sites inside macro expansions (libclang extent untrust safety)

3. **Full pimpl idiom**
   - Finds classes whose entire private state can move into a `struct Impl`
   - Replaces with single `std::unique_ptr<Impl> impl_` member
   - Rewrites both header and `.cpp` file atomically
   - Skipped if any private method exists or structural issues detected

4. **Missing `inline` on header functions**
   - Finds non-template, non-static, non-constexpr free functions *defined* in headers
   - Adds `inline` keyword to prevent ODR violations
   - One translation unit shouldn't redefine the same symbol

5. **`static` in headers → `inline` (C++17)**
   - Finds `static` free functions and namespace-scope variables in headers
   - Converts to C++17 `inline` for single shared definition
   - Skipped entirely if target compiled as C++14 or earlier

### Report-Only Analyses (no rewrites)

6. **Include-guard audit**
   - Flags headers with no guard
   - Detects guard macro collisions across files (silent "header vanishes" bug)
   - Checks guard names against project's path-derived naming convention

7. **`extern "C"` guard check**
   - Flags C++ headers pulled in by `.c` translation units
   - Missing `extern "C"` guard causes compile-fine but link failure

8. **`noexcept` inference for move constructors**
   - Finds user-provided move constructors missing `noexcept`
   - Detects when all bases/members have noexcept move operations
   - `std::vector` falls back to copying without this — major hidden perf bug
   - Skips implicitly-defaulted constructors (compiler handles those)

9. **`const` propagation**
   - Finds non-const, non-virtual member functions that never write to members
   - Also skips methods calling other non-const members
   - Candidates for `const` annotation

10. **Struct padding report**
    - Uses Clang's actual computed layout (byte counts, not heuristic)
    - Shows proposed reordering under descending-alignment strategy
    - Reports exact byte savings
    - Never auto-applied (ABI-breaking change)

11. **Macro → `constexpr` report**
    - Object-like macros that are a single literal value
    - Function-like macros evaluating each parameter exactly once
    - Rejects macros in `#if`/`#ifdef`, using `#`/`##`, or multi-eval bugs

12. **Analysis-coverage report**
    - Lists translation units that fail to parse (invisible to all other analyses)
    - Lists project headers never reached by any parseable TU
    - Diagnostic for compile database correctness

---

## Golden Comments (Key Invariants)

- **G1: Conservative rewrites only** — Every rewrite aborts if *anything* looks unsafe. Partial pimpl only if no private methods/initializers. Forward-decl only if NO usage needs complete type.
- **G2: Analyzer/rewriter split enforced** — Analyzers are pure (no side effects, always safe). Rewriters apply text substitutions (can fail, logged). CLI runs analyzer first; user approves before apply.
- **G3: Macro expansion safety critical** — Clang source extents inside macros can be degenerate. `safety.is_safe_extent()` validates before rewriting. Call sites inside macros reported for manual review.
- **G4: Real AST, not regex** — libclang provides full semantic analysis (overload resolution, type completeness, access checking). Text/syntax approaches fail on methods calling other methods indirectly, forward-declared types, macro-expanded code.

---

## Scripts & Automation

Available in `/scripts/`:
- `install.sh` — Create `.venv`, install dev dependencies
- `test.sh` — Run pytest suite (all analyses)
- `test-one.sh <name>` — Run single analysis test
- `lint.sh` — Mypy + Black
- `analyze-project.sh <compile_commands.json>` — Dry run on real project
- `apply-refactoring.sh <analysis> <compile_commands.json>` — Apply refactoring

**Bash aliases** (add to session):
```bash
alias install='./scripts/install.sh'
alias test='./scripts/test.sh'
alias test-one='./scripts/test-one.sh'
alias lint='./scripts/lint.sh'
alias analyze='./scripts/analyze-project.sh'
```

---

## Architecture Overview

### Directory Structure

```
src/sarp/
├── cli.py                         # Entry point, subcommand router
├── project_scan.py                # Workspace scanning, TU collection
├── compdb.py                      # compile_commands.json parser
├── safety.py                      # Common safety checks, file I/O
│
├── [analysis_name]_analyzer.py    # Detection logic (libclang AST walk)
├── [analysis_name]_rewriter.py    # Rewrite logic (text substitution)
│
├── free_function_analyzer.py      # Detects methods safe to convert
├── free_function_rewriter.py      # Updates decl/def + call sites
├── call_sites.py                  # Call site discovery utilities
├── call_site_rewriter.py          # Rewrites obj.method() → method(obj)
│
├── pimpl_analyzer.py              # Partial pimpl detection
├── pimpl_rewriter.py              # Partial pimpl rewrite
├── full_pimpl_analyzer.py         # Full pimpl detection
├── full_pimpl_rewriter.py         # Full pimpl rewrite (header + .cpp)
│
└── __init__.py
```

### Key Layers

1. **CLI Entry Point** (`cli.py`)
   - Subcommand router (`analyze`, `list-analyses`, `apply`, `--help`)
   - Argument parsing, compile database loading
   - Orchestrates analysis pipeline

2. **Project Scanner** (`project_scan.py`)
   - Discovers all translation units (`.cpp`, `.cc`, `.c++`, `.cxx`)
   - Scans includes, resolves header paths
   - Returns list of TU paths for libclang indexing

3. **Compile Database** (`compdb.py`)
   - Parses `compile_commands.json`
   - Extracts compiler flags, include paths, language standard
   - Handles relative path resolution

4. **Analyzers** (`*_analyzer.py`)
   - Each file is one analysis module
   - Uses libclang Python bindings to walk AST
   - Returns list of `Finding` objects (file, line, reason, rewrite metadata)
   - Never touches disk; purely analysis

5. **Rewriters** (`*_rewriter.py`)
   - Receives `Finding` objects and applies text substitutions
   - Uses safety checks (source span validation, macro detection)
   - Performs atomic rewrites (aborts if any site looks unsafe)
   - Writes updated files back to disk

6. **Safety Module** (`safety.py`)
   - File I/O utilities (read, write with backup)
   - Source span validation (is this cursor extent trustworthy?)
   - Macro expansion detection (skips rewriting inside macros)
   - Line/column-based text replacement

---

## PAiRS Skill Shortcuts

While SaRp is Python-based (less tree-sitter coverage), use `/pairs` for C++ analysis discovery and cross-project navigation.

**Common queries for SaRp (self-discovery):**
```bash
# Find all analyzer implementations (1 per analysis)
/pairs find_symbol ".*_analyzer" --regex --preview

# Verify conservative rewrite pattern (G2 rule)
/pairs grep_symbols "abort|unsafe|safety" --regex

# Check macro expansion safety (G3 rule critical)
/pairs find_symbol "is_safe_extent" --preview

# Trace analyzer→rewriter pipeline
/pairs impact "Finding" --depth 2

# Audit test fixture strategy
/pairs find_symbol "conftest" --preview
```

**For C++ codebases being analyzed by SaRp**, use SaRp itself:
```bash
sarp analyze /path/to/compile_commands.json --all
sarp apply const-propagation /path/to/compile_commands.json
```

---

## How to Navigate & Modify the Code

### Finding an Analysis

All 12 analyses follow a consistent pattern:

1. **Detection**: `[name]_analyzer.py` — libclang AST walk, returns `List[Finding]`
2. **Rewrite** (if applicable): `[name]_rewriter.py` — applies text substitutions
3. **CLI routing**: `cli.py` — registers analysis, calls analyzer/rewriter

For example, to understand const propagation:
- Read `const_propagation_analyzer.py` to see how methods are analyzed
- Read `const_propagation_rewriter.py` to see where `const` is inserted
- Check `test/test_const_propagation_analyzer.py` for expected detections

### Reading an Analyzer

All analyzers follow this structure:

```python
def analyze(tu: clang.TranslationUnit) -> List[Finding]:
    """Walk AST, collect findings."""
    findings = []
    for cursor in walk_children(tu.cursor):
        if matches_pattern(cursor):
            finding = Finding(
                file=cursor.location.file.name,
                line=cursor.location.line,
                reason="...",
                rewrite_data={...}
            )
            findings.append(finding)
    return findings
```

Key libclang APIs used:

- `cursor.kind` — Check if FUNCTION_DECL, CLASS_DECL, etc.
- `cursor.type` — Get resolved type information
- `cursor.get_children()` — Walk AST nodes
- `cursor.location` — File, line, column
- `cursor.extent` — Source span (validated by `safety.is_safe_extent()`)
- `cursor.definition()` — Get method body definition
- `cursor.access_specifier` — private/protected/public
- `cursor.is_virtual_method()` — Check virtual
- `cursor.referenced` — Follow name references

### Reading a Rewriter

All rewriters receive a list of `Finding` objects (from the analyzer) and apply changes:

```python
def rewrite(findings: List[Finding]) -> None:
    """Apply text substitutions."""
    by_file = group_by_file(findings)
    for filepath, file_findings in by_file.items():
        content = read_file(filepath)
        for finding in file_findings:
            # Validate finding can be applied
            if not is_safe_to_apply(finding, content):
                report_skipped(finding)
                continue
            # Apply substitution
            content = apply_substitution(content, finding)
        write_file(filepath, content)
```

Key patterns:

- **Atomic**: All findings for one file are applied together or not at all
- **Safe spans**: Rewriter validates each finding's source span before rewriting
- **Macro awareness**: Skips rewriting if cursor extent overlaps with macro expansion
- **Dry-run reporting**: `analyze` is always safe (no side effects); `rewrite` can fail

### Understanding Call Sites

The `call_sites.py` and `call_site_rewriter.py` modules handle the most complex case: rewriting `obj.method(x)` to `method(obj, x)` across a whole project.

**Key challenge**: libclang's source extents for macro-expanded code can be empty/degenerate. During dev, trusting them corrupted a test file. Solution:

1. `call_sites.analyze_call_sites(tu, method_name)` — Uses libclang to find all references
2. For each call site, `safety.is_safe_extent()` validates the cursor extent
3. `call_site_rewriter.py` applies only to sites with trustworthy extents
4. Untrusted sites are reported by file:line for manual review

---

## Key Files & Entry Points

### Main Entry
- **[src/sarp/cli.py](src/sarp/cli.py)** — Argument parser, subcommand dispatcher

### Project Scanning
- **[src/sarp/project_scan.py](src/sarp/project_scan.py)** — Find all `.cpp`, `.h` files
- **[src/sarp/compdb.py](src/sarp/compdb.py)** — Parse `compile_commands.json`

### Analysis Pipeline (Detection)
- **[src/sarp/free_function_analyzer.py](src/sarp/free_function_analyzer.py)** — Method → free function candidates
- **[src/sarp/full_pimpl_analyzer.py](src/sarp/full_pimpl_analyzer.py)** — Full pimpl candidates
- **[src/sarp/inline_analyzer.py](src/sarp/inline_analyzer.py)** — Missing `inline` detection
- **[src/sarp/const_propagation_analyzer.py](src/sarp/const_propagation_analyzer.py)** — Methods safe to mark `const`
- Similar `*_analyzer.py` for all 12 analyses

### Rewrite Pipeline (Application)
- **[src/sarp/free_function_rewriter.py](src/sarp/free_function_rewriter.py)** — Apply method → free function rewrite
- **[src/sarp/full_pimpl_rewriter.py](src/sarp/full_pimpl_rewriter.py)** — Apply pimpl rewrite
- **[src/sarp/call_site_rewriter.py](src/sarp/call_site_rewriter.py)** — Rewrite `obj.method()` call sites
- Similar `*_rewriter.py` for all applicable analyses

### Utilities
- **[src/sarp/safety.py](src/sarp/safety.py)** — File I/O, span validation, macro detection
- **[src/sarp/call_sites.py](src/sarp/call_sites.py)** — Utilities for finding/rewriting call sites

### Testing
- **[test/](test/)** — pytest suite with one test file per analyzer/rewriter
- **[test/conftest.py](test/conftest.py)** — Pytest fixtures (compile database builder, temporary files)
- **[test/fixtures/](test/fixtures/)** — C++ test projects (simple programs with known analyses)

---

## Testing

Each analysis has corresponding tests:

```bash
pytest test/test_free_function_analyzer.py          # Run one analyzer's tests
pytest test/test_free_function_rewriter.py          # Run one rewriter's tests
pytest -k "pimpl"                                   # Run all pimpl-related tests
pytest test/ -v                                     # Run entire suite
```

### Fixture Strategy

Test fixtures are minimal C++ projects in `test/fixtures/`. Each fixture:

1. Has a `compile_commands.json` (generated by `conftest.py`)
2. Contains a few `.cpp` and `.h` files
3. Tests one analysis at a time

Example: `test_free_function_analyzer.py`:

```python
def test_finds_method_with_no_state_access(free_func_fixture):
    analyzer = free_function_analyzer.analyze(free_func_fixture.tu)
    assert len(analyzer) == 1
    assert analyzer[0].line == 10  # Expected line with method
```

The `free_func_fixture` is created by `conftest.py`, which:
1. Writes C++ files to a temp dir
2. Generates `compile_commands.json`
3. Runs libclang on the TU
4. Yields the `TranslationUnit`

---

## Key Design Decisions

1. **Real AST, not regex**: libclang provides full semantic analysis (overload resolution, type completeness, access checking). Text/syntax approaches fail on:
   - Methods calling other methods indirectly
   - Forward-declared types (need semantic resolution to know if complete)
   - Macro-expanded code (libclang unwraps it)

2. **Conservative rewrites**: Every rewrite aborts if *anything* looks unsafe:
   - Partial pimpl if a private method exists or members have initializers
   - Forward-decl only if *no* usage needs the complete type
   - Call-site rewrites only if source extent is trustworthy (not in macro expansion)

3. **Analyzer/Rewriter split**: Analyzers are pure functions (no side effects, always safe to run). Rewriters apply text substitutions (can fail, logged as skipped). CLI always runs analyzer first, then asks user before applying rewrites.

4. **One analyzer per file**: 12 analyses = 12 analyzer modules. Each is self-contained, testable, and runnable independently.

5. **Macro expansion safety**: Clang's source extents inside macro expansions can be empty or degenerate. Solution: `safety.is_safe_extent()` validates before rewriting. Call sites inside macros are reported for manual review.

---

## Useful Commands

### Installation
```bash
cd SaRp
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

### Run All Analyses (report only)
```bash
sarp analyze /path/to/compile_commands.json
sarp analyze --all /path/to/compile_commands.json  # All 12 analyses
```

### List Supported Analyses
```bash
sarp list-analyses
```

### Apply a Specific Analysis
```bash
sarp apply free-function /path/to/compile_commands.json
sarp apply full-pimpl /path/to/compile_commands.json --rewrite-call-sites
sarp apply const-propagation /path/to/compile_commands.json
```

### Dry Run (report findings without applying)
```bash
sarp analyze /path/to/compile_commands.json  # Already reports; use for review
```

### Run Tests
```bash
pytest test/ -v                              # Full suite
pytest test/test_const_propagation*.py -v    # Const propagation only
pytest -k "pimpl" -v                         # All pimpl tests
```

---

## Common Tasks

### Adding a New Analysis

1. Create `src/sarp/[name]_analyzer.py`:
   ```python
   def analyze(tu: clang.TranslationUnit) -> List[Finding]:
       findings = []
       for cursor in walk_ast(tu.cursor):
           if matches_pattern(cursor):
               findings.append(Finding(...))
       return findings
   ```

2. (Optional) Create `src/sarp/[name]_rewriter.py`:
   ```python
   def rewrite(findings: List[Finding]) -> None:
       # Apply text substitutions
   ```

3. Register in `cli.py`:
   ```python
   analysis_registry['name'] = {
       'analyzer': analyzer_module.analyze,
       'rewriter': rewriter_module.rewrite if applicable else None,
       'description': '...'
   }
   ```

4. Add tests in `test/test_[name]_analyzer.py` and `test/test_[name]_rewriter.py`
5. Update README.md

### Debugging an Analysis

```bash
# 1. Check if compile database is valid
sarp analyze /path/to/compile_commands.json --verbose

# 2. Add print statements to analyzer
# 3. Run pytest with output capture disabled
pytest test/test_[name]_analyzer.py -s -v

# 4. Inspect individual TU
python3
>>> import clang.cindex
>>> clang.cindex.conf.set_library_file(...)
>>> tu = clang.cindex.Index.create().parse(...)
>>> for cursor in tu.cursor.get_children(): print(cursor)
```

### Handling Unsafe Rewrites

If a finding can't be rewritten safely (e.g., call site in macro expansion):

1. `rewriter.py` checks `safety.is_safe_extent()`
2. If not safe, finding is skipped with reason logged
3. User sees report: `Skipped: file.cpp:42 (source extent inside macro expansion)`
4. User manually reviews and updates if needed

---

## Architecture & Best Practices

### Analyzer Pattern

All analyzers:
- Take a `TranslationUnit` (from libclang)
- Return `List[Finding]` (never raise, never mutate disk)
- Walk the AST using `clang.cindex` APIs
- Record findings with file, line, reason, rewrite metadata

### Rewriter Pattern

All rewriters:
- Take `List[Finding]` (from analyzer)
- Group by file
- For each file, read → validate each finding → apply → write back
- If *any* finding is unsafe, report but continue (partial apply ok if explicitly requested)

### Testing Pattern

Each analyzer/rewriter has a test file:
- Uses fixtures from `conftest.py`
- Tests detection accuracy and false-negatives
- Tests rewrite correctness and safety
- Covers edge cases (macros, template code, etc.)

### Safety Practices

- **Extent validation**: `safety.is_safe_extent(cursor)` before any text rewrite
- **Atomic file I/O**: Read → apply all → write (no partial files)
- **Macro detection**: Skip rewriting inside macro expansions
- **Backup**: Save `.bak` on first write to a file (disabled in tests)
- **Dry-run first**: Run `analyze` before `apply`

---

## References

- **README.md** — Installation, quick start, all 12 analyses explained
- **pyproject.toml** — Dependencies (libclang ≥18.0), entry point
- **[libclang Python bindings docs](https://github.com/sighingnow/libclang)** — API reference
- **[Clang AST reference](https://clang.llvm.org/doxygen/)** — Cursor kinds, types, navigation

---

## Differences from PAiRS

While **PAiRS** is a code-graph indexing system for code navigation and call-chain analysis:
- PAiRS uses tree-sitter (no semantic resolution)
- PAiRS builds a queryable symbol database
- PAiRS exposes tools via CLI and VS Code extension

**SaRp** is a semantic refactoring analyzer:
- SaRp uses libclang (full AST, semantic resolution)
- SaRp finds specific refactoring opportunities
- SaRp provides conservative automated rewrites (or reports for manual review)

The two tools can be used together: use PAiRS to navigate the codebase, then use SaRp to apply semantic refactorings.

---

**ADR Reference:** View architectural decisions:
```bash
git log --grep="ADR" --oneline
```

**Last updated:** 2026-09-15 (Token-optimized with memory enforcement)
