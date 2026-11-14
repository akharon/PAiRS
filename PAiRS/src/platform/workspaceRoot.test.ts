import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverWorkspaceRoot, gitWorktreeInfo, resolveGitPath } from './workspaceRoot';

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-root-')));
const mk = (...p: string[]): string => {
  fs.mkdirSync(path.join(...p), { recursive: true });
  return path.join(...p);
};

describe('discoverWorkspaceRoot', () => {
  it('prefers --root over PAIRS_ROOT over the walk', () => {
    const t = tmp();
    mk(t, '.git');
    expect(discoverWorkspaceRoot(t, { explicit: '/x/y', env: { PAIRS_ROOT: '/a/b' } })).toBe(path.resolve('/x/y'));
    expect(discoverWorkspaceRoot(t, { env: { PAIRS_ROOT: '/a/b' } })).toBe(path.resolve('/a/b'));
    expect(discoverWorkspaceRoot(t, { env: {} })).toBe(t);
  });

  it('walks up from a subdirectory to the repo root', () => {
    const t = tmp();
    mk(t, '.git');
    const sub = mk(t, 'src', 'deep');
    expect(discoverWorkspaceRoot(sub, { env: {} })).toBe(t);
  });

  it('stops at an existing .pairs/index.db even without .git', () => {
    const t = tmp();
    mk(t, '.pairs');
    fs.writeFileSync(path.join(t, '.pairs', 'index.db'), '');
    const sub = mk(t, 'a', 'b');
    expect(discoverWorkspaceRoot(sub, { env: {} })).toBe(t);
  });

  it('stops at a linked worktree (.git FILE) nested inside the main repo', () => {
    const main = tmp();
    mk(main, '.git');
    fs.mkdirSync(path.join(main, '.pairs'));
    fs.writeFileSync(path.join(main, '.pairs', 'index.db'), '');
    const wt = mk(main, '.claude', 'worktrees', 'x');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'x')}\n`);
    const sub = mk(wt, 'src');
    expect(discoverWorkspaceRoot(sub, { env: {} })).toBe(wt);
  });

  it('prefers the nearest .git over an ancestor holding a stray .pairs/index.db', () => {
    const parent = tmp();
    mk(parent, '.pairs');
    fs.writeFileSync(path.join(parent, '.pairs', 'index.db'), '');
    const repo = mk(parent, 'repo');
    mk(repo, '.git');
    expect(discoverWorkspaceRoot(mk(repo, 'src'), { env: {} })).toBe(repo);
  });

  it('falls back to startDir when nothing is found', () => {
    const t = tmp();
    // Walks all the way up; tmp dirs have no .git/.pairs above them on a sane box.
    const r = discoverWorkspaceRoot(t, { env: {} });
    expect(r === t || fs.existsSync(path.join(r, '.git')) || fs.existsSync(path.join(r, '.pairs', 'index.db'))).toBe(true);
  });
});

describe('gitWorktreeInfo', () => {
  it('none without .git', () => {
    expect(gitWorktreeInfo(tmp())).toEqual({ kind: 'none' });
  });

  it('main for a .git directory', () => {
    const t = tmp();
    mk(t, '.git');
    expect(gitWorktreeInfo(t)).toEqual({ kind: 'main', mainRoot: t });
  });

  it('linked worktree with absolute gitdir + commondir', () => {
    const main = tmp();
    const gitdir = mk(main, '.git', 'worktrees', 'wt');
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(gitWorktreeInfo(wt)).toEqual({ kind: 'linked', mainRoot: main });
  });

  it('linked worktree with a relative gitdir', () => {
    const main = tmp();
    const gitdir = mk(main, '.git', 'worktrees', 'wt');
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..');
    const wt = mk(main, '.claude', 'worktrees', 'wt');
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../../../.git/worktrees/wt\n');
    expect(gitWorktreeInfo(wt)).toEqual({ kind: 'linked', mainRoot: main });
  });

  it('linked worktree without a commondir file falls back to ../..', () => {
    const main = tmp();
    const gitdir = mk(main, '.git', 'worktrees', 'wt');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(gitWorktreeInfo(wt)).toEqual({ kind: 'linked', mainRoot: main });
  });

  it('submodule gitdir under .git/modules', () => {
    const sup = tmp();
    const gitdir = mk(sup, '.git', 'modules', 'lib');
    const sub = mk(sup, 'lib');
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${gitdir}\n`);
    expect(gitWorktreeInfo(sub)).toEqual({ kind: 'submodule' });
  });

  it('submodule with the usual relative gitdir', () => {
    const sup = tmp();
    mk(sup, '.git', 'modules', 'lib');
    const sub = mk(sup, 'vendor', 'lib');
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n');
    expect(gitWorktreeInfo(sub)).toEqual({ kind: 'submodule' });
  });

  it('garbage .git file is none', () => {
    const t = tmp();
    fs.writeFileSync(path.join(t, '.git'), 'nonsense');
    expect(gitWorktreeInfo(t)).toEqual({ kind: 'none' });
  });
});

describe('resolveGitPath', () => {
  it('handles Windows drive paths with either slash on win32', () => {
    expect(resolveGitPath('C:\\x', 'D:/repo/.git/worktrees/a', 'win32')).toBe('D:\\repo\\.git\\worktrees\\a');
    expect(resolveGitPath('C:\\x', 'D:\\repo\\.git', 'win32')).toBe('D:\\repo\\.git');
  });
  it('maps drive paths to /mnt on POSIX hosts (WSL)', () => {
    expect(resolveGitPath('/mnt/d/x', 'D:/repo/.git/worktrees/a', 'linux')).toBe('/mnt/d/repo/.git/worktrees/a');
  });
  it('resolves relative paths against base', () => {
    expect(resolveGitPath('/r/wt', '../../.git/worktrees/wt', 'linux')).toBe('/.git/worktrees/wt');
    expect(resolveGitPath('/r/a/wt', '../../.git/worktrees/wt', 'linux')).toBe('/r/.git/worktrees/wt');
  });
});
