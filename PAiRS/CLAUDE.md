# PAiRS Codebase Documentation

## Session preferences

- Keep chat responses silent/minimal to save tokens — avoid narration, progress updates, or verbose explanations unless asked.
- Use `/pairs` skill for code navigation instead of Read/grep — saves 40-60% of lookup tokens.
- Batch independent Read/Edit/Bash calls together to reduce round-trips.
- Trust diffs on edits — never ask to verify changes after Edit tool succeeds.
- Ask for specific line ranges when reading large files, not whole files.
- Reference code by `file:line` markdown links instead of quoting content.
- **Save project context to memory** → `/home/mkyr/.claude/projects/-home-mkyr/memory/` (e.g., architectural decisions, common patterns, token optimizations learned).

---

**PAiRS** (Parsed AI-Readable Semantic Index) is a code-graph indexing system for AI coding agents and developers. It parses workspaces into queryable code graphs containing symbols, calls, imports, and type hierarchies, exposing them as:
- **VS Code extension** with Language Model Tools (for Copilot agent mode)
- **Standalone CLI** (`pairs` binary)
- **Claude Code skill** (auto-generated, synced from CLI)

Both extension and CLI share the same SQLite index store (`.pairs/index.db`), ensuring consistent graph views across all interfaces.

---

## Supported Languages

C, C++, Python, JavaScript, TypeScript, Java, Go, Ruby, Dart, Rust, CSS, HTML, GDScript.

---

## Golden Comments (Key Invariants)

- **G1: Adapter layer is the boundary** — `adapters/` is the ONLY place that imports VS Code. Everything below is editor-agnostic core. Enforced by eslint `no-restricted-imports`.
- **G2: One-pass rename, no partial edits** — `rename_symbol` validates ALL sites before writing ANY file. If any site can't be matched safely, whole operation aborts untouched.
- **G3: Confidence labels on all edges** — `resolved` (AST-verified, safe for refactoring) vs. `fuzzy` (name-only, requires explicit opt-in). Default excludes fuzzy.
- **G4: Shared store = single source of truth** — Extension and CLI both read/write `.pairs/index.db`. Indexer runs on extension activation + file save; CLI runs manually/CI.

---

## Scripts & Automation

Available in `/scripts/`:
- `build.sh` — Compile TS → JS (esbuild), typecheck
- `test.sh` — Run integration tests (index/parse validation)
- `package.sh` — Build `.vsix` extension
- `install.sh` — Build + test + package + install to VS Code
- `lint.sh` — ESLint + Prettier

**Bash aliases** (add to session):
```bash
alias build='npm run build'
alias test='npm run test'
alias typecheck='npm run typecheck'
alias lint='./scripts/lint.sh'
alias package='npm run package'
```

---

## Architecture Overview

### Directory Structure

```
src/
├── adapters/
│   ├── cli/          # CLI entry point (JSON/text rendering, subcommands)
│   └── vscode/       # VS Code extension host (activates, registers tools, writes skill)
├── core/
│   ├── indexer/      # Workspace parsing, tree-sitter integration, incremental re-indexing
│   ├── tools/        # Agent tool definitions (find_symbol, impact, rename_symbol, etc.)
│   └── analyze/      # Graph analysis: module maps, dead code, cycles, hierarchies
├── platform/         # Platform-specific (git diff parsing)
├── store/
│   └── graph/        # SQLite schema, schema migrations, query builders, path resolution
└── test/             # Integration tests + index/parsing validation
```

### Key Layers

1. **Adapter Layer** (`adapters/`)
   - `vscode/extension.ts`: Activates the extension, opens workspace store, indexes, registers tools, writes Claude Code skill
   - `cli/index.ts`: CLI subcommand router; converts tool outputs to JSON (default) or prose (`--naked`)
   - Adapter **never imports `vscode`** except in extension.ts (enforced by eslint `no-restricted-imports`)

2. **Indexer** (`core/indexer/`)
   - `parserRegistryImpl.ts`: Language registry (tree-sitter WASM parsers)
   - `extractorImpl.ts`: Symbol extraction (walk parse tree, emit symbol/edge records)
   - `codeIndexerImpl.ts`: Orchestrates file parsing, merges new symbols/edges into the store
   - `watchQueue.ts`: Batches file changes (save/create/delete) for incremental re-indexing

3. **Code Tools** (`core/tools/`)
   - `tools.ts`: Zod schemas for each tool (input validation, type safety)
   - `executors.ts`: Query builders that call the store; output adapters (JSON or prose)
   - Tools exposed via:
     - VS Code Language Model Tools (Copilot agent mode)
     - CLI subcommands (`pairs find_symbol name`, `pairs impact`, etc.)
     - Claude Code skill (auto-generated `.claude/skills/pairs/SKILL.md`)

4. **Analysis** (`core/analyze/`)
   - `moduleMap.ts`: Louvain clustering (subsystems), layer detection, drift calculation, cycle detection
   - `hierarchy.ts`: Type ancestor/descendant trees (extends/implements)
   - `impact.ts`: Transitive dependants (callers, readers, writers, implementers)

5. **Store** (`store/graph/`)
   - `sqliteCodeStore.ts`: Facade for all queries (find symbols, list callers, check impact, etc.)
   - `sqlSchema.ts`: Schema + migrations (`File`, `Symbol`, `Edge`, `PendingRef` tables)
   - `resolver.ts`: Path resolution (workspace-relative → normalized imports)

---

## How to Navigate & Modify the Code

### **Use PAiRS Skill for Code Navigation** ⭐

**Default preference: Use `/pairs` skill (or equivalent) for symbol/dependency queries instead of grep/Read.** This saves 40-60% of token budget per task.

**Common queries for PAiRS (meta!):**
```bash
# Find adapter layer violations (G1 rule: adapters/ only)
/pairs grep_symbols "import.*vscode" --regex --preview

# Trace tool registration pipeline
/pairs impact "codeToolSchemas" --depth 2

# Verify confidence label usage (resolved vs fuzzy)
/pairs grep_symbols "resolved|fuzzy|confidence" --regex

# Check index store facade usage
/pairs who_calls "sqliteCodeStore" --direction callers --preview

# Audit extension activation flow
/pairs find_symbol "extension.ts" --path "src/adapters/vscode" --preview
```

**Usage examples for users:**

- Find a symbol: `pairs find_symbol SymbolName` (with `preview:true` to inline doc + code)
- Get full declaration: `pairs get_symbol SymbolName`
- See file structure: `pairs outline path/to/file.ts`
- Check what calls a function: `pairs who_calls FunctionName`
- Check what breaks if I change this: `pairs impact SymbolName`
- Rename consistently: `pairs rename_symbol OldName NewName`

These CLI commands are the same ones exposed via VS Code Language Model Tools and Claude Code skill.

### Manual Code Reading (when PAiRS doesn't apply)

1. **Find a top-level concept**: Grep for exports or class names.
2. **Understand a module**: Read `core/*/README` (if present) or browse `index.ts` files (entry points).
3. **Trace a call chain**: Use `pairs who_calls` → read the callees.
4. **Refactor**: Use `pairs impact` first to see dependants, then `pairs rename_symbol` to apply the change atomically.

---

## Key Files & Entry Points

### Extension
- **[src/adapters/vscode/extension.ts](src/adapters/vscode/extension.ts)** — Activates, indexes workspace, registers Language Model Tools, writes Claude Code skill
- **[src/adapters/vscode/skills.ts](src/adapters/vscode/skills.ts)** — Generates `.claude/skills/pairs/SKILL.md` (auto-synced skill file)

### CLI
- **[src/adapters/cli/index.ts](src/adapters/cli/index.ts)** — Subcommand router, output formatting (JSON default, `--naked` for prose)

### Core Indexing
- **[src/core/indexer/codeIndexerImpl.ts](src/core/indexer/codeIndexerImpl.ts)** — Orchestrates parsing + store writes
- **[src/core/indexer/parserRegistryImpl.ts](src/core/indexer/parserRegistryImpl.ts)** — Tree-sitter WASM language registry
- **[src/core/indexer/extractorImpl.ts](src/core/indexer/extractorImpl.ts)** — Parse tree → symbols + edges

### Tools & Queries
- **[src/core/tools/tools.ts](src/core/tools/tools.ts)** — Zod schemas, tool names/descriptions
- **[src/core/tools/executors.ts](src/core/tools/executors.ts)** — Implementations (query builders, output adapters)

### Analysis
- **[src/core/analyze/moduleMap.ts](src/core/analyze/moduleMap.ts)** — Louvain subsystems, cycles, layers
- **[src/core/analyze/hierarchy.ts](src/core/analyze/hierarchy.ts)** — Type hierarchy walks
- **[src/core/analyze/impact.ts](src/core/analyze/impact.ts)** — Transitive dependant walks

### Store & Schema
- **[src/store/graph/sqliteCodeStore.ts](src/store/graph/sqliteCodeStore.ts)** — Query facade
- **[src/store/graph/sqlSchema.ts](src/store/graph/sqlSchema.ts)** — Schema, migrations, table builders

---

## Testing

- **[src/test/indexProject.ts](src/test/indexProject.ts)** — Test helper (indexes a fixture and returns store)
- **[src/test/](src/test/)** — Integration tests validating parsing, edge extraction, impact walks, etc.
- **Unit tests** co-located (e.g., `impact.test.ts` next to `impact.ts`)

Run tests:
```bash
npm test           # Run once
npm run test:watch # Watch mode
```

---

## Build & Package

```bash
npm run build         # Compile TS → JS (esbuild)
npm run build:watch   # Watch mode

npm run typecheck     # tsc --noEmit
npm run lint          # eslint src

npm run package       # Build .vsix (VS Code extension)
npm run install       # Install locally to VS Code (full pipeline: build → test → package → install)
```

### CLI Auto-Installation

When the extension is installed (via `npm install` or VS Code extension marketplace), the `postinstall` hook automatically:
1. Creates a symlink `~/.local/bin/pairs` → `<projectRoot>/dist/cli.js`
2. Makes the `pairs` CLI immediately available in any terminal
3. Warns if `~/.local/bin` isn't in `PATH` (with instructions to add it)

When the package is removed/uninstalled, the `postrm` hook cleans up the symlink.

**Result**: No need to manually run `npm link` — the CLI is ready to use after installation.

---

## Key Design Decisions

1. **Shared Indexer, Multiple Interfaces**: Extension and CLI read/write the same `.pairs/index.db` SQLite store. Indexer runs in the extension on every activation and file save; CLI `pairs index` runs manually or in CI.

2. **One-Pass Rename (No Partial Edits)**: `rename_symbol` walks all reference sites and validates them all *before* writing to any file. If any site can't be matched safely, the whole operation aborts untouched — no partial renames.

3. **Confidence Labels on Edges**: Each edge is marked `resolved` (AST-verified) or `fuzzy` (name-only). Automated refactoring (`rename_symbol`) only uses resolved edges by default; fuzzy edges require explicit `includeFuzzy: true` opt-in.

4. **Language Agnostic**: New languages plug in via tree-sitter WASM parsers + extractor rules (language-specific query strings). The indexer, tools, and store are language-neutral.

5. **Adapter Boundary**: The `adapters/` layer is the *only* place that imports VS Code. Everything below is editor-agnostic core, so both CLI and extension see the same behavior.

---

## Useful Commands

### Workspace Indexing
```bash
pairs index                    # Full index (or rebuild if store exists)
pairs index --rebuild          # Drop store, reparses everything
pairs watch                    # Index once, then watch & re-index on save
```

### Symbol Queries
```bash
pairs find_symbol login --preview
pairs get_symbol login --path src/auth.ts
pairs grep_symbols "^login" --regex
pairs who_calls login --direction callers
```

### Graph Analysis
```bash
pairs impact login --depth 3
pairs hierarchy AuthService
pairs file_deps src/auth.ts --direction importers --transitive
pairs module_map
pairs analyze dead_code --includeExported
pairs diff_impact --rev main...HEAD
```

### Refactoring
```bash
pairs rename_symbol login signIn --naked
pairs context_pack login
```

### Introspection
```bash
pairs stats                    # Index size & quality
pairs query 'SELECT * FROM Symbol LIMIT 10'  # Raw SQL
```

---

## Common Tasks

### Adding a New Language

1. Ensure tree-sitter WASM parser available in `tree-sitter-wasms` npm package.
2. Register in `parserRegistryImpl.ts` (language enum → parser + query strings).
3. Add extractor rules in `extractorImpl.ts` (AST queries for symbols/edges).
4. Test with `npm test` (fixtures in `src/test/`).

### Adding a New Tool

1. Define schema in `core/tools/tools.ts` (Zod + description).
2. Implement query logic in `core/tools/executors.ts`.
3. Register in `codeToolSchemas` export.
4. Extension auto-discovers it as a Language Model Tool.
5. CLI auto-discovers it as a subcommand.
6. Skill file regenerates on next extension activation.

### Debugging the Index

- `pairs stats` — See index size, symbol count, fuzzy rate.
- `pairs query 'SELECT COUNT(*) FROM Edge WHERE fuzzy'` — Raw SQL inspection.
- `pairs read <file>` — Print indexed source (useful for checking what was parsed).
- VS Code status bar — Hover for detailed breakdown.

---

## Architecture & Best Practices

### File Organization

- **Entry points** (`adapters/`) are thin: CLI router, extension host setup, Language Model Tool registration.
- **Core logic** (`core/`) is editor-agnostic and independently testable.
- **Store** (`store/`) is query-only from tools; indexer writes through it.
- **Tests** are co-located with modules they test; fixture projects in `src/test/`.

### Code Conventions

- No `vscode` imports outside `adapters/vscode/extension.ts`.
- All queries through `CodeStore` facade (single entry point).
- Tool descriptions (in schemas) are prose for agents; use them to guide tool choice.
- Fuzzy edges are low-confidence; mark them in output and default to excluding them.

---

## Relationship to SaRp

**SaRp** (Semantic Analysis Recursive Processor, in `../SaRp/`) is a complementary tool for C++ refactoring:
- PAiRS: Code-graph indexing (tree-sitter based, navigation + analysis)
- SaRp: Semantic refactoring (libclang based, safe automated rewrites)

Workflow: Use PAiRS to understand the codebase structure and call chains, then use SaRp to apply semantic-aware refactorings (pimpl, const propagation, free functions, etc.). SaRp's real AST analysis catches things regex/text patterns cannot.

For SaRp documentation, see `../SaRp/CLAUDE.md`.

---

**ADR Reference:** View architectural decisions:
```bash
git log --grep="ADR" --oneline
```

---

## Maintenance

**When adding new configuration or compiler options:**
1. Update [docs/CONFIG.md](docs/CONFIG.md) — document in relevant section
2. Add linting rule if needed to enforce the constraint

**When adding new language or tool:**
1. Update [docs/DATA.md](docs/DATA.md) — add to "Supported Languages" or "Symbol Kinds"
2. Add test fixtures showing extraction accuracy for new language
3. Document confidence levels for edges specific to that language

**Example:** If adding Kotlin support:
```markdown
**Supported Languages:**
- Kotlin (tree-sitter; high accuracy for classes, functions, interfaces)
```

And in fixtures:
```
src/test/fixtures/kotlin_project/
  ├── expected_symbols.json
  └── expected_edges.json
```

**Last updated:** 2026-09-15 (Token-optimized with memory enforcement)
