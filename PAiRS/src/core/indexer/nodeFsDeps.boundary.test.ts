/**
 * Repository boundaries + the shared workspace filter.
 *
 * A dir whose `.git` is a FILE (linked worktree / submodule) is a duplicate copy
 * of code that lives elsewhere — never indexed. A nested `.git` DIRECTORY is an
 * independent repo: skipped when the root is a repo (vendored clone), indexed
 * when the root is a plain multi-repo parent folder. The watcher filter must
 * agree with the walker.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspaceFilter, nodeListWorkspaceFiles, nodeStatFile, nodeWatchWorkspace } from './nodeFsDeps';

function mkRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-boundary-')));
}
function write(root: string, rel: string, body = 'export const a = 1;\n'): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
const list = async (root: string): Promise<string[]> => (await nodeListWorkspaceFiles(root)()).sort();

describe('repo boundaries in the walker', () => {
  it('never descends into a linked worktree / submodule (.git FILE)', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'src/main.ts');
    write(root, 'worktrees/wt/.git', 'gitdir: /somewhere/.git/worktrees/wt\n');
    write(root, 'worktrees/wt/src/main.ts');
    write(root, 'vendor/sub/.git', 'gitdir: ../../.git/modules/sub\n');
    write(root, 'vendor/sub/lib.ts');
    expect(await list(root)).toEqual(['src/main.ts']);
  });

  it('skips a nested independent repo when the root is itself a repo', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'src/main.ts');
    fs.mkdirSync(path.join(root, 'third_party', 'clone', '.git'), { recursive: true });
    write(root, 'third_party/clone/x.ts');
    expect(await list(root)).toEqual(['src/main.ts']);
  });

  it('indexes nested independent repos when the root is NOT a repo (multi-repo parent)', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'PAiRS', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'SaRp', '.git'), { recursive: true });
    write(root, 'PAiRS/a.ts');
    write(root, 'SaRp/b.ts');
    // ...but a linked worktree inside the parent is still a duplicate
    write(root, 'PAiRS-wt/.git', 'gitdir: x\n');
    write(root, 'PAiRS-wt/a.ts');
    expect(await list(root)).toEqual(['PAiRS/a.ts', 'SaRp/b.ts']);
  });

  it('scopes a nested .gitignore to its own directory', async () => {
    const root = mkRoot();
    write(root, 'pkg/.gitignore', 'gen.ts\n');
    write(root, 'pkg/gen.ts');
    write(root, 'pkg/keep.ts');
    write(root, 'other/gen.ts');
    expect(await list(root)).toEqual(['other/gen.ts', 'pkg/keep.ts']);
  });
});

describe('createWorkspaceFilter', () => {
  it('excludes SKIP_DIRS, dot dirs and dotfiles', () => {
    const root = mkRoot();
    const f = createWorkspaceFilter(root);
    expect(f.isExcluded('node_modules/x/a.ts')).toBe(true);
    expect(f.isExcluded('.claude/worktrees/x/a.ts')).toBe(true);
    expect(f.isExcluded('src/a.ts')).toBe(false);
    expect(f.isExcluded('')).toBe(false);
  });

  it('applies root and nested .gitignore', () => {
    const root = mkRoot();
    write(root, '.gitignore', '*.generated.ts\nbuildout/\n');
    write(root, 'pkg/.gitignore', 'local.ts\n');
    const f = createWorkspaceFilter(root);
    expect(f.isExcluded('a.generated.ts')).toBe(true);
    expect(f.isExcluded('buildout/x.ts')).toBe(true);
    expect(f.isExcluded('pkg/local.ts')).toBe(true);
    expect(f.isExcluded('other/local.ts')).toBe(false);
    expect(f.isExcluded('pkg/ok.ts')).toBe(false);
  });

  it('agrees with the walker on repo boundaries', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, 'src/main.ts');
    write(root, 'wt/.git', 'gitdir: x\n');
    write(root, 'wt/a.ts');
    fs.mkdirSync(path.join(root, 'clone', '.git'), { recursive: true });
    write(root, 'clone/b.ts');
    const f = createWorkspaceFilter(root);
    expect(f.rootIsRepo).toBe(true);
    const walked = await list(root);
    for (const p of ['src/main.ts', 'wt/a.ts', 'clone/b.ts']) {
      expect(f.isExcluded(p)).toBe(!walked.includes(p));
    }
    expect(f.isExcluded('wt')).toBe(true);
  });

  it('keeps nested repos when the root is not a repo', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'A', '.git'), { recursive: true });
    write(root, 'A/a.ts');
    write(root, 'W/.git', 'gitdir: x\n');
    write(root, 'W/w.ts');
    const f = createWorkspaceFilter(root);
    expect(f.rootIsRepo).toBe(false);
    expect(f.isExcluded('A/a.ts')).toBe(false);
    expect(f.isExcluded('W/w.ts')).toBe(true);
  });

  it('notices a newly added worktree marker after the cache TTL', () => {
    const root = mkRoot();
    write(root, 'wt/a.ts');
    let t = 0;
    const f = createWorkspaceFilter(root, { ttlMs: 1000, now: () => t });
    expect(f.isExcluded('wt/a.ts')).toBe(false);
    write(root, 'wt/.git', 'gitdir: x\n');
    expect(f.isExcluded('wt/a.ts')).toBe(false); // cached
    t = 2000;
    expect(f.isExcluded('wt/a.ts')).toBe(true);
  });
});

describe('nodeStatFile', () => {
  it('returns mtimeMs and size without reading', async () => {
    const root = mkRoot();
    write(root, 'a.ts', '12345');
    const st = await nodeStatFile(root)('a.ts');
    expect(st.size).toBe(5);
    expect(st.mtimeMs).toBeGreaterThan(0);
  });
});

describe('nodeWatchWorkspace boundaries', () => {
  it('does not report events inside a linked worktree or a gitignored file', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.git'));
    write(root, '.gitignore', 'ignored.ts\n');
    write(root, 'src/a.ts');
    write(root, 'wt/.git', 'gitdir: x\n');
    write(root, 'wt/b.ts');
    const seen: string[] = [];
    const stop = nodeWatchWorkspace(root, { changed: (p) => seen.push(p), deleted: (p) => seen.push(`-${p}`) });
    try {
      await new Promise((r) => setTimeout(r, 50));
      write(root, 'wt/b.ts', 'export const b = 2;\n');
      write(root, 'ignored.ts', 'export const i = 2;\n');
      write(root, 'src/a.ts', 'export const a = 2;\n');
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      stop();
    }
    expect(seen).toContain('src/a.ts');
    expect(seen.some((p) => p.includes('wt/'))).toBe(false);
    expect(seen).not.toContain('ignored.ts');
  });
});
