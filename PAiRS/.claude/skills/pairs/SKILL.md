---
name: pairs
description: Code-graph queries (definitions, callers, impact, outlines) via the `pairs` CLI or Copilot tools. Prefer over grep/Read for navigation and safe refactors.
---

# PAiRS

`pairs <tool> ...` answers from a prebuilt code graph in a few hundred tokens. Prose by default; `--json` = compact JSON, `--pretty` = indented. Copilot gets the same tools as language model tools.

- Works from any subdirectory or git worktree: root = nearest dir with `.pairs/index.db` or `.git` (`--root <dir>` / `PAIRS_ROOT` override).
- First use auto-indexes (a worktree seeds from the main worktree's index); queries refresh changed files first (`--no-refresh` skips).
- Lists are capped; the last line `… +N more (pass limit=M)` means add `--limit M` (or `--offset`). `[fuzzy]` = name-matched, unverified.
- Every tool input is a `--flag` (`--kind function`, `--lang go`, `--include-tests false`, `--no-preview`, `--direction callees`); `pairs <tool> --help` lists them, unknown flags error.

## Cheapest call for the job

| Need | Command |
|---|---|
| Where is X defined | `pairs find_symbol X --preview` (not grep + Read) |
| Shape of a file | `pairs outline path` (not Read) |
| Signature, doc, members | `pairs get_symbol X` |
| Name unknown | `pairs grep_symbols "pat" [--regex]` |
| Callers / callees | `pairs who_calls X [callers\|callees]` |
| Before editing or deleting X | `pairs impact X [--depth N] [--kinds CALLS]` |
| Reviewing a change | `pairs diff_impact [--rev main...HEAD] [--staged]` |
| Base types / subclasses | `pairs hierarchy T` |
| Importers of a file | `pairs file_deps path [importers\|imports]` |
| Broad context, one call | `pairs context_pack X` or `--path file` |
| Architecture | `pairs module_map [src/a -> src/b]`, `pairs analyze dead_code\|fan_out\|cycles\|test_gap` |
| Rename everywhere | `pairs rename_symbol Old New` (all-or-nothing; fuzzy sites need `--include-fuzzy`) |
| Slice of a file | `pairs read path [start] [end]` |

Also: `pairs query '<sql>'`, `pairs stats`, `pairs index`. "index is empty" means run `pairs index`.
