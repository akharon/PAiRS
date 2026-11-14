# Changelog

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
