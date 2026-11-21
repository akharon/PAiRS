# PAiRS

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/mkyr.pairs?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=mkyr.pairs)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/mkyr.pairs)](https://marketplace.visualstudio.com/items?itemName=mkyr.pairs)
[![CI](https://github.com/akharon/PAiRS/actions/workflows/pairs-ci.yml/badge.svg)](https://github.com/akharon/PAiRS/actions/workflows/pairs-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Derived code-graph index for AI coding agents.**

PAiRS parses your workspace into a queryable code graph (symbols, calls, imports, type hierarchy). It ships as a VS Code extension and a standalone `pairs` CLI that share the same index, so navigation and refactoring-safety checks all see the same graph.

Supported languages: C, C++, Python, JavaScript, TypeScript, Java, Go, Ruby, Dart, Rust, CSS, HTML, GDScript.

**The one thing neither Copilot's built-in graph nor most agent code-search tools do: PAiRS can write.** `rename_symbol` renames a symbol and every reference site the graph can verify â€” callers, readers, writers, implementers â€” in one atomic pass, and aborts untouched (no partial edit) if any site can't be matched safely. Every edge it walks carries a confidence label (`resolved` / `fuzzy` / `unresolved`), so a rename backed only by name-matched guesses is refused unless you explicitly opt in with `includeFuzzy`. Read-only graph queries tell an agent what's true; `rename_symbol` is the one PAiRS command that changes what's true, with the graph itself as the safety check.

---

## 0. 60-second quickstart

```bash
# Get the CLI: install the VS Code extension (Â§1, bundles dist/cli.js) or build from source (Â§7).
cd your-project
pairs index                 # builds .pairs/index.db (SQLite, safe to .gitignore)
pairs find_symbol login     # where is it defined?
pairs impact login          # what breaks if I change it?
pairs diff_impact           # what does my current, uncommitted change break?
pairs rename_symbol login signIn   # renames every reference site, one atomic pass
```

Every command prints compact prose by default (cheapest for agents and humans); `--json` gives compact JSON for scripts, `--pretty` indented JSON. Don't know the exact symbol name? `pairs grep_symbols <pattern>` searches names/signatures/doc text; `pairs context_pack <name>` bundles a symbol's definition, callers, callees, and module position into one call instead of four.

---

## 1. Installing the VS Code extension

**Requirements:** VS Code 1.101 or newer. Nothing else to install â€” the extension bundles its parsers and runs the CLI on VS Code's own runtime, so no separate Node.js is needed. Works on Windows, macOS and Linux (one platform-independent package).

1. Open VS Code â†’ **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **PAiRS** and install (or install the `.vsix` directly: `code --install-extension pairs-<version>.vsix`).
3. **Reload the window** if prompted.
4. Open a workspace folder â€” PAiRS activates automatically (`onStartupFinished`) and indexes it in the background. Progress shows in the bottom-right notification area.

The index lives in `.pairs/index.db` (SQLite) inside your workspace. `.pairs/` ignores itself, so your `.gitignore` and working tree stay untouched; everything in it is derived and rebuilt on demand.

On activation PAiRS also puts a `pairs` launcher in `~/.local/bin` (`%LOCALAPPDATA%\Pairs\bin` on Windows) so the CLI works in any terminal â€” add that directory to `PATH` if it is not already.

**Footprint.** The package is ~1.6 MB. Grammars load lazily per language and are released after a minute of inactivity, caches are dropped when idle, unchanged files are skipped on re-index, and edits are debounced and applied incrementally.

**Privacy.** Everything runs locally: no network requests, no telemetry. Source code never leaves your machine through PAiRS (what an agent does with a tool's answer is up to that agent).

A multi-root workspace gets one independent index per folder.

## 2. Using it in VS Code

### Commands (Command Palette â†’ `Ctrl+Shift+P` / `Cmd+Shift+P`)

| Command | What it does |
|---|---|
| **PAiRS: Re-index Workspace** | Incremental re-index (also runs automatically on activation and on every file save/create/delete). |
| **PAiRS: Rebuild Index From Scratch** | Drops the SQLite store and reparses everything. Use this if the index looks stale or corrupted â€” a plain re-index short-circuits unchanged files and can't recover from a broken store. |
| **PAiRS: Find Symbol** | Quick-pick search by symbol name (bare or qualified, e.g. `login` or `AuthService::login`); jumps to its definition. |
| **PAiRS: Show Module Map** | Opens a webview visualizing detected subsystems (as columns, ordered by dependency layer), cross-module dependency edges, cycles (amber), and drift â€” dependencies that cross a subsystem boundary the folder layout implies (red). Click/Enter a node to reveal it in the Explorer. |

### Status bar

Bottom-right shows `pairs <N> sym Â· <P>% fuzzy` â€” total indexed symbols and the percentage resolved by fuzzy (name-only) matching rather than a verified reference. Lower fuzzy % means more reliable `impact`/`who_calls` results. Hover for a breakdown (files, symbols, edges, unresolved references); click to trigger a re-index.

### Copilot agent-mode tools

PAiRS registers its analysis functions as native VS Code Language Model Tools, so **GitHub Copilot in agent mode can call them directly** (no MCP server needed) â€” `find_symbol`, `get_symbol`, `outline`, `grep_symbols`, `context_pack`, `impact`, `diff_impact`, `hierarchy`, `who_calls`, `file_deps`, `module_map`, `analyze`, `rename_symbol`. See Â§4 for what each does. In **untrusted workspaces** (Workspace Trust restricted mode) `diff_impact` is disabled because it runs `git`; everything else works.

### Claude Code integration

On activation, PAiRS installs a Claude Code skill (`SKILL.md`) so Claude Code drives the same functionality through the `pairs` CLI. By default it goes to `~/.claude/skills/pairs/` (setting `pairs.skillLocation`: `user` | `workspace` | `off`) and is rewritten only when its content changes, so worktrees stay clean.

## 3. Using the `pairs` CLI

The extension bundles a CLI (`dist/cli.js`) for terminal use, CI pipelines, and Claude Code. If you have the repo/npm package rather than just the `.vsix`, it's exposed as the `pairs` binary. Commands work from any subdirectory or git worktree: the root is the nearest ancestor containing `.pairs/index.db` or `.git` (override with `--root` or `PAIRS_ROOT`). A linked worktree is seeded from the main worktree's index on first use.

```
pairs <command> [args]
```

| Command | Usage | Description |
|---|---|---|
| `index` | `pairs index [--rebuild]` | Full index (or full rebuild with `--rebuild`, dropping the store first). Prints a JSON report. |
| `stats` | `pairs stats [--json]` | Index size and resolution quality (files, symbols, edges, fuzzy rate): two lines of prose, or JSON with `--json`. |
| `find` (via `query`) | `pairs query '<sql>'` | Raw read-only SQL against the graph schema (`File`, `Symbol`, `Edge`, `PendingRef`) for anything not covered by a dedicated command. |
| `watch` | `pairs watch` | Indexes once, then watches the workspace and incrementally re-indexes on save. `Ctrl-C` to stop. |
| `files` | `pairs files [pattern] [--paths] [--json]` | Lists/searches indexed non-source filenames (a glob like `*.txt` or `Pic*.svg`), one path per line. `--paths` also matches against full paths. |
| `read` | `pairs read <path> [startLine] [endLine]` | Prints a file, or a 1-indexed inclusive line range. Out-of-range values clamp rather than error. |

Every tool below (`find_symbol` through `context_pack`) is also a subcommand: `pairs <tool> [args]`. **Output is compact prose by default** â€” the same text Copilot's Language Model Tools return (see Â§4). Pass `--json` for compact, slimmed JSON (no internal ids; default-valued fields omitted) to pipe into `jq` or a script, or `--pretty` for indented JSON. `--naked` is accepted and ignored (it was the old opt-in for prose). `pairs query` always prints JSON, compact unless `--pretty`.

Lists are bounded (default 20â€“25 rows) and end with `â€¦ +N more (pass limit=M)`; re-run with `--limit M` / `--offset N`. Every tool input field is a `--flag` (also `--kebab-case` / `--flag=value`; booleans `--flag` / `--no-flag` / `--flag false`; lists comma-separated; `--kind`, `--lang`, `--regex` are shorthands for `kinds`, `langs`, `isRegex`), unknown flags are rejected with the valid list, and `pairs <tool> --help` / `pairs --help` print usage generated from the tool schemas. An empty index answers with one line telling you to run `pairs index`.

## 4. Reference: agent tools / CLI commands

These are the same operations, exposed as VS Code Language Model Tools (Copilot, prose output) or CLI subcommands (Claude Code / scripts / CI; prose by default, `--json` for structured output):

| Tool | Purpose |
|---|---|
| `find_symbol` | Locate a symbol's definition(s) by name. Pass `preview: true` (CLI: `--preview`) to inline each hit's doc line and first body lines â€” usually removes the follow-up `Read`. |
| `get_symbol` | Full declaration (signature, doc, span, members) without reading the whole file. |
| `outline` | A file's symbols in order â€” its structural shape. |
| `grep_symbols` | Search names/qualified names/signatures/doc text by substring or regex (CLI: `--regex`) â€” for "I don't know the exact symbol name" instead of grep-and-Read. |
| `context_pack` | One bundle for a symbol or file (CLI: `--path <file>` for the latter): definition, direct callers, direct callees, type hierarchy, and enclosing module boundary â€” replaces several separate calls when you need broad context fast. |
| `impact` | Everything that transitively depends on a symbol ("blast radius"). Call before changing/removing it. Pass `kinds: ["CALLS"]` (CLI: `--kinds CALLS,READS`) to slice by edge type. |
| `diff_impact` | Blast radius of the **current change**: maps the git diff's changed line ranges to the symbols containing them, then walks all of their dependants in one merged pass. Use instead of reading the diff and calling `impact` per changed function â€” a dependant reached from several changed symbols appears once, tagged with how many reach it. Defaults to the working tree; `--rev main...HEAD` for a range, `--staged` for the index. Changed lines inside no symbol (imports, module-level code, unindexed files) are listed separately, never silently dropped. |
| `hierarchy` | Type ancestors (extends/implements) and descendants. |
| `who_calls` | Direct callers or callees, one hop. |
| `file_deps` | File-level importers or imports, optionally transitive. |
| `module_map` | Subsystems, cycles, layers, fan-in/fan-out, and drift; pass a `boundary` to see exactly what one module uses from another. |
| `analyze` | Workspace-wide: `dead_code`, `fan_out`, `cycles`, `test_gap`. |
| **`rename_symbol`** | **The headline feature.** Renames a symbol and every reference site the graph can verify â€” callers, readers, writers, implementers â€” in one atomic pass. Aborts untouched if any site can't be matched safely, or if the new name is already declared in the same file/impl block â€” re-index and retry, or pick another name. A fuzzy (name-only, unverified) reference site is excluded by default; pass `includeFuzzy` to include it anyway. Same-named symbols in *other* files are reported, not blocked. No built-in undo; revert via git. |

## 5. Configuration

**Settings** (VS Code Settings â†’ search "PAiRS"):
- **`pairs.disabledTools`** â€” array of tool names (e.g. `["analyze"]`) to skip registering as Copilot Language Model Tools.
- **`pairs.skillLocation`** â€” where the Claude Code skill is written: `user` (default, `~/.claude/skills/pairs/`), `workspace` (each folder's `.claude/skills/pairs/`) or `off`.

Not indexed: `.gitignore`d paths, dot-directories, `node_modules` and other build/vendor directories, and nested git repositories.

## 6. Troubleshooting

**"PAiRS: ... command not found"**
Run **Developer: Reload Window**. Check **Help â†’ Toggle Developer Tools â†’ Console** for activation errors.

**Index looks stale or wrong**
Run **PAiRS: Rebuild Index From Scratch** (a plain re-index skips unchanged files and can't self-heal a corrupted store).

**`pairs` is not found in a terminal**
Make sure `~/.local/bin` (`%LOCALAPPDATA%\Pairs\bin` on Windows) is on `PATH`, then open a new terminal. The launcher is rewritten on every activation.

**Node version errors when building/running from source**
The store uses Node's built-in `node:sqlite`, which requires **Node â‰¥ 22**.

Still stuck? [Open an issue](https://github.com/akharon/PAiRS/issues/new/choose) with the PAiRS version, your OS and the output of `pairs stats`.

## 7. Building from source

Requires Node â‰¥ 22.

```bash
npm ci
npm run build          # minified bundles â†’ dist/, grammars â†’ dist/grammars (npm run build:dev for unminified)
npm run check          # typecheck + lint + tests
npm run package        # â†’ pairs-<version>.vsix
npm run install:vscode # build + test + package + code --install-extension, end to end
npm run link-cli       # optional: put the dev `pairs` on PATH (npm run unlink-cli to remove)
```

The first build compiles the GDScript grammar to wasm (no prebuilt exists), which downloads a small toolchain once and caches the result. See [CONTRIBUTING](https://github.com/akharon/PAiRS/blob/main/.github/CONTRIBUTING.md).

---

**License:** [MIT](LICENSE) | **Changelog:** [CHANGELOG.md](CHANGELOG.md) | **GitHub:** [akharon/PAiRS](https://github.com/akharon/PAiRS)
