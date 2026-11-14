/**
 * Installs the Claude Code skill so Claude drives `pairs` via its own CLI
 * subcommands instead of a protocol server. Copilot instead uses the
 * in-process Language Model Tools (registerLmTools in extension.ts) — this
 * file only concerns Claude.
 *
 * The skill body lives in `./skillContent.ts`, generated from this repo's own
 * `.claude/skills/pairs/SKILL.md` by `npm run sync-skill`, so there is one
 * source of truth.
 *
 * Where it goes is the `pairs.skillLocation` setting:
 *  - `user` (default): `~/.claude/skills/pairs/SKILL.md` — one copy for every
 *    project and git worktree, nothing added to any working tree.
 *  - `workspace`: `<root>/.claude/skills/pairs/SKILL.md` (the old behaviour;
 *    dirties every checkout it is written into).
 *  - `off`: write nothing.
 * In every case the file is only rewritten when its content differs, so an
 * activation never touches mtimes or git status needlessly.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { SKILL_MD } from './skillContent';

export type SkillLocation = 'user' | 'workspace' | 'off';

/** Absolute SKILL.md path for a location, or null for `off`. */
export function skillTargetPath(location: SkillLocation, workspaceRoot: string, home: string = os.homedir()): string | null {
  switch (location) {
    case 'off':
      return null;
    case 'workspace':
      return path.join(workspaceRoot, '.claude', 'skills', 'pairs', 'SKILL.md');
    case 'user':
    default:
      return path.join(home, '.claude', 'skills', 'pairs', 'SKILL.md');
  }
}

/**
 * Writes the skill when it is missing or differs. Returns the path written, or
 * null when nothing was written (setting `off`, or content already current).
 */
export async function writeSkillFiles(
  workspaceRoot: string,
  location: SkillLocation = 'user',
  home: string = os.homedir()
): Promise<string | null> {
  const target = skillTargetPath(location, workspaceRoot, home);
  if (target === null) return null;
  try {
    if ((await fs.readFile(target, 'utf8')) === SKILL_MD) return null;
  } catch {
    /* missing — write it */
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, SKILL_MD, 'utf8');
  return target;
}
