# Changelog

## 0.28.0

### Marketplace readiness, footprint

- **Smaller and faster to load.** Production bundles are minified: `dist/extension.js` and `dist/cli.js` drop from ~490 KB / ~510 KB to ~260 KB each. The `.vsix` ships only the two bundles, grammars, queries, icon and docs (it previously also carried CI files and a skill copy). CLI output is byte-identical to 0.27.
- **Lower idle memory.** After a full index, and 60 s after the last file-change flush, the extension now also releases the loaded tree-sitter grammars (the largest resident cost), not just the store caches. They reload lazily on the next index. Release never runs while an indexing operation is in flight.
- **Cheaper file watching.** The watcher rejects non-source files before any path or ignore-rule work.
- **Workspace Trust.** The extension declares limited support for untrusted workspaces: `diff_impact` (which runs `git`) is disabled there; everything else works. Virtual workspaces are declared unsupported (the index needs a local disk).
- Manifest: categories, keywords, homepage/bugs/repository (monorepo `directory`), gallery banner, shorter description.

### Build / CI

- **CI now runs.** The workflow lived in `PAiRS/.github/`, which GitHub ignores because the repository root is one level up; it moved to `.github/workflows/pairs-ci.yml` (typecheck, lint, tests and a CLI smoke test on Linux/macOS/Windows, plus a `.vsix` packaging job). `pairs-release.yml` publishes on a `pairs-v<version>` tag when `VSCE_PAT` / `OVSX_PAT` secrets exist.
- `package-lock.json` is tracked (CI uses `npm ci`, which needs it; it was git-ignored).
- **npm lifecycle fix.** The `install` and `postinstall` scripts ran on every `npm install`/`npm ci` (full build+test+package+`code --install-extension`, then writing launchers into `$HOME`). Renamed to `install:vscode`; `link-cli` / `unlink-cli` are now opt-in. The extension itself still links the CLI on activation.
- `npm run package` calls `vsce` directly with `--no-dependencies` and monorepo link bases; `vscode:prepublish` builds. Runtime libraries (`web-tree-sitter`, `zod`) are `devDependencies` because they are bundled.
- `fetch-grammars.mjs` builds the GDScript grammar on Windows (`npx` is `npx.cmd`).
- Tests: default timeout raised to 30 s for slow CI disks.
- Removed the committed `pairs-0.26.0.vsix`, a SQLite WAL file, local Claude settings and the `.code-workspace` file from version control; added `.gitattributes`, issue/PR templates, security policy, contributing guide and Dependabot config.

## 0.27.0

### Token cost (breaking CLI output changes)

- **CLI default output is now prose** (what `--naked` printed). `--json` prints compact JSON (no indentation); `--pretty` prints indented JSON. `--naked` is still accepted as a no-op. Scripts that parsed the old default JSON must add `--json`. Applies to `stats` (two prose lines by default) and `files` (one path per line; JSON is `{pattern, files: [path]}`). `query` stays JSON, compact unless `--pretty`.
- **Slim JSON shapes** (`--json`). Top-level keys per tool are unchanged, but records are slimmed:
  - symbols are `{name, qualified?, kind, file, line, endLine?, signature?, doc?, exported?}`; `id`, `fileId`, `parentId`, `lang`, `startLine` (now `line`), null/empty fields and `exported:false` are gone; `qualified` only when it differs from `name`.
  - dependants, callers and hierarchy nodes are flattened into the symbol (`{...symbol, depth, confidence?}`), `who_calls` items carry `refLine`/`confidence`/`test` only when non-default (no `{symbol, edge}` nesting).
  - `hasMore`/`nextOffset` appear only when more results exist; `truncated`, `hiddenTestEdges`, `capped` only when set; `total` is always present.
  - `module_map` rounds weights, trims per-module metrics and bounds its lists by `limit` (`more` reports what was dropped); `rename_symbol` sites are `{file, line, confidence?}`.
- **Bounded lists.** Lower defaults: impact/diff_impact/hierarchy/file_deps 25, who_calls/grep_symbols/analyze 20. Every truncated list ends with `… +N more (pass limit=M)`. CLI gained `--limit`, `--offset`, `--depth` for every tool that has the field. List rows for impact/who_calls/hierarchy/analyze no longer repeat signatures; callers are cited at the call site.
- **Empty index is explicit.** With zero indexed files every tool (and `stats`) answers with one line telling you to run `pairs index`, instead of "No symbol named X".
- `context_pack` no longer clusters the whole module graph per call (new `moduleNeighbours` query, same results); `impact` walks stop at 5000 nodes and report `capped`.
- Tool descriptions and field docs cut by about half (shipped with every Copilot request); Claude Code skill rewritten and shortened.

### Windows + WSL

- **`pairs` in WSL on a Windows-held index no longer dies with `disk I/O error` and a stack.** SQLite's WAL `-shm` cannot be shared across the 9p/drvfs boundary while the other side has the index open. Query commands (all code tools, `stats`, `query`, `files`) now fall back to a read-only snapshot (`immutable=1` on the live file, else a temp copy of `index.db` + `-wal`), print one `pairs: index is in use by another OS/process ...` line, skip auto-refresh, never checkpoint, and delete any temp copy on exit. `index` / `watch` print one line explaining the situation and exit 1. A schema-version mismatch with the running extension is reported in one line (a snapshot cannot be upgraded). Any other open failure is one `pairs: cannot open the index at ...` line. Writes in WSL still work when no Windows process has the index open.

## 0.24.0

- Code-graph index (symbols, calls, imports, type hierarchies) for C, C++, Python, JavaScript, TypeScript, Java, Go, Ruby, Dart, Rust, CSS, HTML, GDScript.
- VS Code Language Model Tools for Copilot agent mode: `find_symbol`, `get_symbol`, `outline`, `grep_symbols`, `impact`, `hierarchy`, `who_calls`, `file_deps`, `module_map`, `analyze`, `rename_symbol`, `diff_impact`, `context_pack`.
- Standalone `pairs` CLI sharing the same SQLite index as the extension.
- Auto-generated Claude Code skill, synced from the CLI.
- Module map webview showing subsystems, cycles, and drift.
