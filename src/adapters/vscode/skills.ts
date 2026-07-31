/**
 * Writes a Claude Code skill into the opened workspace on activation, so
 * Claude drives `gizem` via its own CLI subcommands instead of a protocol
 * server. Copilot instead uses the in-process Language Model Tools
 * (registerLmTools in extension.ts) — this file only concerns Claude.
 *
 * Idempotent: overwrites `.claude/skills/gizem/SKILL.md` every activation so
 * it always matches the installed extension version, but never touches other
 * files under `.claude/` a user may have of their own.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const SKILL_MD = `---
name: gizem
description: Leverage GIZEM's code graph and architectural rules. Use instead of grep/Read for definitions, dependencies, refactoring safety, and rule compliance. In VS Code with Copilot, prefer the language model tools (find_symbol, impact, check_rules, rename_symbol, etc.); for CLI use the gizem commands.
---

# GIZEM: Code Graph & Architectural Rules

GIZEM maintains a live code graph (symbols, call/import edges, dependencies) and
architectural rule engine for this workspace, updated by the VS Code extension
while it's open. Use GIZEM instead of grep/Read for code navigation and
refactoring — it catches renamed-import references grep misses, understands
module structure, and enforces architecture rules.

## In VS Code with Copilot (Language Model Tools)

Copilot has direct access to GIZEM tools — use these for navigation and refactoring:

- **find_symbol** — locate where a symbol is defined (by name, bare or qualified).
- **get_symbol** — full declaration: signature, doc, members.
- **outline** — file structure: all symbols in order.
- **impact** — blast radius of a symbol (all dependants, transitive). Call BEFORE
  renaming/removing/changing.
- **who_calls** — direct callers or callees of a function/method.
- **file_deps** — which files depend on this one, and what it depends on.
- **module_map** — subsystems detected in the codebase and architectural drift.
- **analyze** — dead code, cycles, hotspots, untested exports.
- **check_rules** — verify \`.gizem/rules.ron\` against the graph (call AFTER
  editing to catch rule violations early).
- **list_rules** — summarize the active ruleset: ids, kinds, severities.
- **explain_rule** — detail of one rule, including its explanation.
- **rename_symbol** — rename a symbol and all direct reference sites consistently
  in one pass. Aborts if any site can't be matched safely (stale index, ambiguous
  text). Revert via git or your own backups.

## In the CLI (from workspace root)

For automation and CI/CD, use \`gizem\` commands:

- \`gizem impact <name> [depth]\` — blast radius (same as the tool above).
- \`gizem check [--ci] [--format human|sarif|json]\` — evaluate
  \`.gizem/rules.ron\` against the graph. Non-zero exit only on new confirmed
  error-severity violations.
- \`gizem rules [path]\` — summarize the ruleset.
- \`gizem baseline update\` — snapshot current violations so \`check\` only flags
  new ones going forward.
- \`gizem query '<cypher>'\` — raw Cypher for anything not covered above.
- \`gizem stats\` — index size and resolution quality.
- \`gizem index\` — full re-index (rarely needed; extension keeps it live).
- \`gizem init [--force]\` — bootstrap \`.gizem/rules.ron\` from inferred layers.

## When to Use GIZEM

- **Finding definitions** — \`find_symbol\` / \`outline\` instead of grep/Read.
- **Checking impact before a change** — \`impact\` shows callers, readers, type
  references, etc. that might break.
- **Refactoring safely** — \`rename_symbol\` renames definition + all reference
  sites together; \`check_rules\` catches architecture violations.
- **Understanding module structure** — \`module_map\` shows subsystems and drift.
- **Enforcing architecture** — \`check_rules\` in CI ensures no layering,
  circular, or visibility rule violations.
`;

export async function writeSkillFiles(workspaceRoot: string): Promise<void> {
  const dir = path.join(workspaceRoot, '.claude', 'skills', 'gizem');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
}
