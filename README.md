# PAiRS

**Derived code-graph index for AI coding agents.**

PAiRS parses your workspace into a queryable code graph (symbols, calls, imports, type hierarchy). It ships as a VS Code extension and a standalone `pairs` CLI that share the same index, so navigation and refactoring-safety checks all see the same graph.

Supported languages: C, C++, Python, JavaScript, TypeScript, Java, Go, Ruby, Dart, Rust, CSS, HTML.

---

## 1. Installing the VS Code extension

1. Open VS Code → **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **PAiRS** and install (or install the `.vsix` directly: `code --install-extension pairs-<version>.vsix`).
3. **Reload the window** if prompted.
4. Open a workspace folder — PAiRS activates automatically (`onStartupFinished`) and indexes it in the background. Progress shows in the bottom-right notification area.

The index lives in `.pairs/index.db` (SQLite) inside your workspace. It's safe to add `.pairs/` to `.gitignore` — everything in it is derived and rebuilt on demand.

A multi-root workspace gets one independent index per folder.

## 2. Using it in VS Code

### Commands (Command Palette → `Ctrl+Shift+P` / `Cmd+Shift+P`)

| Command | What it does |
|---|---|
| **PAiRS: Re-index Workspace** | Incremental re-index (also runs automatically on activation and on every file save/create/delete). |
| **PAiRS: Rebuild Index From Scratch** | Drops the SQLite store and reparses everything. Use this if the index looks stale or corrupted — a plain re-index short-circuits unchanged files and can't recover from a broken store. |
| **PAiRS: Find Symbol** | Quick-pick search by symbol name (bare or qualified, e.g. `login` or `AuthService::login`); jumps to its definition. |
| **PAiRS: Show Module Map** | Opens a webview visualizing detected subsystems (as columns, ordered by dependency layer), cross-module dependency edges, cycles (amber), and drift — dependencies that cross a subsystem boundary the folder layout implies (red). Click/Enter a node to reveal it in the Explorer. |

### Status bar

Bottom-right shows `pairs <N> sym · <P>% fuzzy` — total indexed symbols and the percentage resolved by fuzzy (name-only) matching rather than a verified reference. Lower fuzzy % means more reliable `impact`/`who_calls` results. Hover for a breakdown (files, symbols, edges, unresolved references); click to trigger a re-index.

### Copilot agent-mode tools

PAiRS registers its analysis functions as native VS Code Language Model Tools, so **GitHub Copilot in agent mode can call them directly** (no MCP server needed) — `find_symbol`, `get_symbol`, `outline`, `impact`, `hierarchy`, `who_calls`, `file_deps`, `module_map`, `analyze`, `rename_symbol`. See §5 for what each does.

### Claude Code integration

On every activation, PAiRS writes `.claude/skills/pairs/SKILL.md` into the workspace. If you use Claude Code in that workspace, it auto-discovers this skill and drives the same functionality through the `pairs` CLI instead of an in-process tool call. This file is regenerated on each activation to track your installed extension version — don't hand-edit it.

## 3. Using the `pairs` CLI

The extension bundles a CLI (`dist/cli.js`) for terminal use, CI pipelines, and Claude Code. If you have the repo/npm package rather than just the `.vsix`, it's exposed as the `pairs` binary. Run all commands from your workspace root — the index lives at `./.pairs/index.db` relative to your current directory.

```
pairs <command> [args]
```

| Command | Usage | Description |
|---|---|---|
| `index` | `pairs index [--rebuild]` | Full index (or full rebuild with `--rebuild`, dropping the store first). Prints a JSON report. |
| `stats` | `pairs stats` | Index size and resolution quality (files, symbols, edges, fuzzy rate) as JSON. |
| `find` (via `query`) | `pairs query '<sql>'` | Raw read-only SQL against the graph schema (`File`, `Symbol`, `Edge`, `PendingRef`) for anything not covered by a dedicated command. |
| `impact` | `pairs impact <name> [depth] [--kinds CALLS,READS] [--json]` | Everything that transitively depends on a symbol, up to `depth` hops (default 3). Run this before renaming/removing something. `--kinds` restricts the walk to specific edge kinds (`CALLS`, `READS`, `WRITES`, `IMPLEMENTS`, `EXTENDS`, `REFERENCES`) — e.g. `--kinds CALLS` for callers only; the header states the restriction so a filtered empty result can't be mistaken for "nothing depends on this". Prints prose by default (like every other tool below); pass `--json` for the structured result, which existing scripts should use instead of relying on bare `pairs impact` output. |
| `watch` | `pairs watch` | Indexes once, then watches the workspace and incrementally re-indexes on save. `Ctrl-C` to stop. |
| `files` | `pairs files [pattern] [--paths]` | Lists/searches indexed non-source filenames (a glob like `*.txt` or `Pic*.svg`). `--paths` also matches against full paths. |
| `read` | `pairs read <path> [startLine] [endLine]` | Prints a file, or a 1-indexed inclusive line range. Out-of-range values clamp rather than error. |

## 4. Reference: agent tools / CLI commands

These are the same operations, exposed as VS Code Language Model Tools (Copilot) or CLI subcommands (Claude Code / scripts):

| Tool | Purpose |
|---|---|
| `find_symbol` | Locate a symbol's definition(s) by name. Pass `preview: true` (CLI: `--preview`) to inline each hit's doc line and first body lines — usually removes the follow-up `Read`. |
| `get_symbol` | Full declaration (signature, doc, span, members) without reading the whole file. |
| `outline` | A file's symbols in order — its structural shape. |
| `impact` | Everything that transitively depends on a symbol ("blast radius"). Call before changing/removing it. Pass `kinds: ["CALLS"]` to slice by edge type. |
| `hierarchy` | Type ancestors (extends/implements) and descendants. |
| `who_calls` | Direct callers or callees, one hop. |
| `file_deps` | File-level importers or imports, optionally transitive. |
| `module_map` | Subsystems, cycles, layers, fan-in/fan-out, and drift; pass a `boundary` to see exactly what one module uses from another. |
| `analyze` | Workspace-wide: `dead_code`, `fan_out`, `cycles`, `test_gap`. |
| `rename_symbol` | Rename a symbol and every reference site in one pass. Aborts untouched if any site can't be matched safely, or if the new name is already declared in the same file/impl block — re-index and retry, or pick another name. Same-named symbols in *other* files are reported, not blocked. No built-in undo; revert via git. |

## 5. Configuration

**Settings** (VS Code Settings → search "PAiRS"):
- **`pairs.disabledTools`** — array of tool names (e.g. `["analyze"]`) to skip registering as Copilot Language Model Tools.

## 6. Troubleshooting

**"PAiRS: ... command not found"**
Run **Developer: Reload Window**. Check **Help → Toggle Developer Tools → Console** for activation errors.

**Index looks stale or wrong**
Run **PAiRS: Rebuild Index From Scratch** (a plain re-index skips unchanged files and can't self-heal a corrupted store).

**Node version errors when building/installing from source**
The store uses Node's built-in `node:sqlite`, which requires **Node ≥ 22**.

## 7. Building from source

```bash
npm install
npm run build          # esbuild → dist/
npm run fetch-grammars # tree-sitter grammars → dist/grammars
npm test
npm run package         # → pairs-<version>.vsix
npm run install          # build + package + code --install-extension, end to end
```

---

**License:** MIT | **GitHub:** [mkyr/pairs](https://github.com/mkyr/pairs)
