import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKILL_MD } from './skillContent';
import { skillTargetPath, writeSkillFiles } from './skills';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-skills-'));

describe('writeSkillFiles', () => {
  it('user (default) writes ~/.claude/skills/pairs/SKILL.md and nothing in the workspace', async () => {
    const home = tmp();
    const ws = tmp();
    const written = await writeSkillFiles(ws, 'user', home);
    expect(written).toBe(path.join(home, '.claude', 'skills', 'pairs', 'SKILL.md'));
    expect(fs.readFileSync(written!, 'utf8')).toBe(SKILL_MD);
    expect(fs.existsSync(path.join(ws, '.claude'))).toBe(false);
  });

  it('workspace writes under the workspace root', async () => {
    const home = tmp();
    const ws = tmp();
    const written = await writeSkillFiles(ws, 'workspace', home);
    expect(written).toBe(path.join(ws, '.claude', 'skills', 'pairs', 'SKILL.md'));
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('off writes nothing', async () => {
    const home = tmp();
    const ws = tmp();
    expect(await writeSkillFiles(ws, 'off', home)).toBeNull();
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(ws)).toEqual([]);
  });

  it('only writes when content differs', async () => {
    const home = tmp();
    const ws = tmp();
    const target = skillTargetPath('user', ws, home)!;
    await writeSkillFiles(ws, 'user', home);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(target, past, past);
    expect(await writeSkillFiles(ws, 'user', home)).toBeNull();
    expect(Math.abs(fs.statSync(target).mtimeMs - past.getTime())).toBeLessThan(2000);
    fs.writeFileSync(target, 'stale');
    expect(await writeSkillFiles(ws, 'user', home)).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(SKILL_MD);
  });
});
