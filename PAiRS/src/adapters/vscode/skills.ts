/**
 * Writes a Claude Code skill into the opened workspace on activation, so
 * Claude drives `pairs` via its own CLI subcommands instead of a protocol
 * server. Copilot instead uses the in-process Language Model Tools
 * (registerLmTools in extension.ts) — this file only concerns Claude.
 *
 * The skill body lives in `./skillContent.ts`, generated from this repo's own
 * `.claude/skills/pairs/SKILL.md` by `npm run sync-skill`, rather than being
 * duplicated here as a hand-maintained string literal. That literal had
 * already drifted from the shipped tool schemas — it advertised neither
 * `find_symbol`'s preview nor `impact`'s kinds — and because this file
 * overwrites the workspace copy on every activation, any edit made to the
 * markdown was silently reverted on the next window reload. One source now.
 *
 * Idempotent: overwrites `.claude/skills/pairs/SKILL.md` every activation so
 * it always matches the installed extension version, but never touches other
 * files under `.claude/` a user may have of their own.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { SKILL_MD } from './skillContent';

export async function writeSkillFiles(workspaceRoot: string): Promise<void> {
  const dir = path.join(workspaceRoot, '.claude', 'skills', 'pairs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
}
