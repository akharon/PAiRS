/**
 * GENERATED FILE — do not edit.
 *
 * Source: .claude/skills/pairs/SKILL.md
 * Regenerate: npm run sync-skill
 *
 * Edit the markdown, not this file. See scripts/sync-skill.mjs for why the
 * skill has a generated twin rather than one hand-written copy.
 */

export const SKILL_MD = `---
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
  Pass \`preview: true\` to also get each hit's doc line and first body lines —
  that usually answers "is this the right symbol?" without a follow-up Read.
- **get_symbol** — full declaration: signature, doc, members.
- **outline** — file structure: all symbols in order.
- **impact** — blast radius of a symbol (all dependants, transitive). Call BEFORE
  renaming/removing/changing. Pass \`kinds: ["CALLS"]\` (or \`["READS","WRITES"]\`,
  etc.) to slice by edge type when you only want callers or only data access;
  the header states the restriction, so a filtered empty result is never
  mistaken for "nothing depends on this".
- **hierarchy** — inheritance tree: what a type EXTENDS/IMPLEMENTS (ancestors)
  and what EXTENDS/IMPLEMENTS it (descendants). Call before changing a base
  class/interface to see every subclass affected.
- **who_calls** — direct callers or callees of a function/method.
- **file_deps** — which files depend on this one, and what it depends on.
- **module_map** — detected subsystems, module cycles, each module's dependency
  layer and fan-in/fan-out, and architectural drift. Pass
  \`boundary: "src/a -> src/b"\` to drill into one edge: the symbols of the
  target that the source actually uses, with reference sites — what breaking
  that dependency would require.
- **analyze** — dead code, cycles, hotspots, untested exports.
- **rename_symbol** — rename a symbol and all direct reference sites consistently
  in one pass. Aborts if any site can't be matched safely (stale index, ambiguous
  text), or if the new name is already declared in the same file or impl block.
  Same-named symbols in other files are reported as a note, not blocked. Revert
  via git or your own backups.

## In the CLI (from workspace root)

For automation and CI/CD, use \`pairs\` commands:

- \`pairs find_symbol <name> [--preview]\` — locate a definition. \`--preview\` adds the doc line and first body lines, which usually removes the follow-up Read.
- \`pairs get_symbol <name>\` — full declaration: signature, doc, a body excerpt, and members.
- \`pairs impact <name> [depth] [--kinds CALLS,READS] [--json]\` — blast radius (same as the tool above). \`--kinds\` restricts the walk to specific edge kinds. Prints prose like every other CLI tool by default; pass \`--json\` for the structured result (breaking change from the old bare-JSON default — update any script that parsed \`pairs impact\` output directly).
- \`pairs query '<sql>'\` — raw read-only SQL for anything not covered above.
- \`pairs stats\` — index size and resolution quality.
- \`pairs index\` — full re-index (rarely needed; extension keeps it live).

## When to Use PAiRS

- **Finding definitions** — \`find_symbol\` / \`outline\` instead of grep/Read. Add
  \`preview: true\` to \`find_symbol\` when you would otherwise Read the file next.
- **Checking impact before a change** — \`impact\` shows callers, readers, type
  references, etc. that might break.
- **Refactoring safely** — \`rename_symbol\` renames definition + all reference
  sites together.
- **Understanding module structure** — \`module_map\` shows subsystems, cycles,
  layers and drift; \`module_map\` with \`boundary\` shows why one module depends
  on another. Ask it "where does this code belong" before adding a new file.
`;
