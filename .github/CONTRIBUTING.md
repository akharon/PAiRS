# Contributing

The repository holds two projects: **PAiRS** (`PAiRS/`, TypeScript, this extension) and
**SaRp** (`SaRp/`, Python). This guide covers PAiRS; see `SaRp/README.md` for the other.

## Setup

Requires Node 22+ (the index uses the built-in `node:sqlite`).

```bash
cd PAiRS
npm ci
npm run build        # bundles dist/, copies grammars (compiles the GDScript grammar on first run)
npm run check        # typecheck + lint + tests
```

Press `F5` in VS Code with `PAiRS/` open to launch an Extension Development Host
(run `npm run build:watch` alongside for unminified rebuilds).

## Ground rules

- **Adapter boundary:** only `src/adapters/vscode/` may import `vscode`. Everything else runs headless in the CLI; ESLint enforces it.
- **Rename is all-or-nothing:** `rename_symbol` validates every site before writing any file.
- **Confidence labels:** edges are `resolved` or `fuzzy`; automated edits default to resolved only.
- Tests live next to the code (`*.test.ts`); fixture-based integration tests are in `src/test/`.
- The tool descriptions in `src/core/tools/tools.ts` are the single source for the Copilot tool manifest and the Claude Code skill. After changing them run `npm run sync-lm-tools` and `npm run sync-skill`.
- Do not commit build output, `.vsix` files, `.pairs/` or editor-local files.

## Releasing

1. Update `PAiRS/CHANGELOG.md` and bump `version` in `PAiRS/package.json` (`npm install --package-lock-only`).
2. Merge to `main`, then `git tag pairs-v<version> && git push origin pairs-v<version>`.
3. The release workflow verifies the tag, builds, publishes to the registries whose token secrets are set (`VSCE_PAT`, `OVSX_PAT`) and attaches the `.vsix` to a GitHub release.
