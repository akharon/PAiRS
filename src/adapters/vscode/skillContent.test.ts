/**
 * Pins the generated skill body to the authored markdown.
 *
 * `writeSkillFiles` overwrites `.claude/skills/pairs/SKILL.md` in the user's
 * workspace on every activation. When the body was a second, hand-maintained
 * copy inside skills.ts, that made markdown edits look like they applied and
 * then silently reverted on the next window reload — and the embedded copy
 * drifted away from the tools actually shipped. This test fails the build
 * instead, pointing at `npm run sync-skill`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKILL_MD } from './skillContent';

const repoRoot = path.join(__dirname, '..', '..', '..');
const authored = path.join(repoRoot, '.claude', 'skills', 'pairs', 'SKILL.md');

describe('claude skill content', () => {
  it('matches .claude/skills/pairs/SKILL.md byte for byte', () => {
    expect(SKILL_MD).toBe(fs.readFileSync(authored, 'utf8'));
  });

  it('documents the tool surface the extension actually registers', () => {
    // A skill that omits a tool is a tool an agent never calls, which is the
    // whole failure mode this file guards: PAiRS only saves tokens if the
    // agent knows the capability exists.
    for (const tool of [
      'find_symbol',
      'get_symbol',
      'outline',
      'impact',
      'hierarchy',
      'who_calls',
      'file_deps',
      'module_map',
      'analyze',
      'rename_symbol',
    ]) {
      expect(SKILL_MD).toContain(tool);
    }
    // The parameters added alongside this test — omitted from the skill, they
    // are invisible to the agent and the follow-up Read happens anyway.
    expect(SKILL_MD).toContain('preview');
    expect(SKILL_MD).toContain('kinds');
  });
});
