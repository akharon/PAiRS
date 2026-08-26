---
name: pairs
description: Leverage PAiRS's code graph. Use instead of grep/Read for definitions, dependencies, and refactoring safety. In VS Code with Copilot, prefer the language model tools (find_symbol, impact, rename_symbol, etc.); for CLI use the pairs commands.
---

# PAiRS: Code Graph

PAiRS maintains a live code graph (symbols, call/import edges, dependencies)
for this workspace, updated by the VS Code extension while it's open. Use
PAiRS instead of grep/Read for code navigation and refactoring — it catches
renamed-import references grep misses and understands module structure.

## In VS Code with Copilot (Language Model Tools)

Copilot has direct access to PAiRS tools — use these for navigation and refactoring:

- **find_symbol** — locate where a symbol is defined (by name, bare or qualified).
- **get_symbol** — full declaration: signature, doc, members.
- **outline** — file structure: all symbols in order.
- **impact** — blast radius of a symbol (all dependants, transitive). Call BEFORE
  renaming/removing/changing.
- **hierarchy** — inheritance tree: what a type EXTENDS/IMPLEMENTS (ancestors)
  and what EXTENDS/IMPLEMENTS it (descendants). Call before changing a base
  class/interface to see every subclass affected.
- **who_calls** — direct callers or callees of a function/method.
- **file_deps** — which files depend on this one, and what it depends on.
- **module_map** — detected subsystems, module cycles, each module's dependency
  layer and fan-in/fan-out, and architectural drift. Pass
  `boundary: "src/a -> src/b"` to drill into one edge: the symbols of the
  target that the source actually uses, with reference sites — what breaking
  that dependency would require.
- **analyze** — dead code, cycles, hotspots, untested exports.
- **rename_symbol** — rename a symbol and all direct reference sites consistently
  in one pass. Aborts if any site can't be matched safely (stale index, ambiguous
  text). Revert via git or your own backups.

## In the CLI (from workspace root)

For automation and CI/CD, use `pairs` commands:

- `pairs impact <name> [depth] [--json]` — blast radius (same as the tool above). Prints prose like every other CLI tool by default; pass `--json` for the structured result (this is a breaking change from the old bare-JSON default — update any script that parsed `pairs impact` output directly).
- `pairs query '<sql>'` — raw read-only SQL for anything not covered above.
- `pairs stats` — index size and resolution quality.
- `pairs index` — full re-index (rarely needed; extension keeps it live).

## When to Use PAiRS

- **Finding definitions** — `find_symbol` / `outline` instead of grep/Read.
- **Checking impact before a change** — `impact` shows callers, readers, type
  references, etc. that might break.
- **Refactoring safely** — `rename_symbol` renames definition + all reference
  sites together.
- **Understanding module structure** — `module_map` shows subsystems, cycles,
  layers and drift; `module_map` with `boundary` shows why one module depends
  on another. Ask it "where does this code belong" before adding a new file.
