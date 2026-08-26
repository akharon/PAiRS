/**
 * Filename-only indexing of non-source files: nodeListNamedFiles skips source
 * extensions (already in File), binary/media extensions (BINARY_EXTS), and
 * anything the workspace's root .gitignore excludes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeListNamedFiles, parseGitignore } from './nodeFsDeps';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-namedfiles-'));
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  return root;
}

const list = async (root: string): Promise<string[]> =>
  (await nodeListNamedFiles(path.join(root, 'ws'))()).map((f) => f.path).sort();

describe('nodeListNamedFiles', () => {
  it('indexes non-source files but not source files already covered by File', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'ws', 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(root, 'ws', 'main.ts'), 'export const a = 1;\n');

    expect(await list(root)).toEqual(['README.md']);
  });

  it('skips binary/media extensions', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'ws', 'notes.txt'), 'hi\n');
    fs.writeFileSync(path.join(root, 'ws', 'lib.so'), 'binary\n');
    fs.writeFileSync(path.join(root, 'ws', 'photo.png'), 'binary\n');

    expect(await list(root)).toEqual(['notes.txt']);
  });

  it('honours SKIP_DIRS and dotfiles', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'ws', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ws', 'node_modules', 'dep.txt'), 'x\n');
    fs.writeFileSync(path.join(root, 'ws', '.env'), 'x\n');
    fs.writeFileSync(path.join(root, 'ws', 'keep.txt'), 'x\n');

    expect(await list(root)).toEqual(['keep.txt']);
  });

  it('honours the root .gitignore', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'ws', '.gitignore'), '*.log\nbuild-artifacts/\n');
    fs.writeFileSync(path.join(root, 'ws', 'app.log'), 'x\n');
    fs.writeFileSync(path.join(root, 'ws', 'keep.txt'), 'x\n');
    fs.mkdirSync(path.join(root, 'ws', 'build-artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ws', 'build-artifacts', 'out.txt'), 'x\n');

    expect(await list(root)).toEqual(['keep.txt']);
  });

  it('captures size/mtime alongside path', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'ws', 'data.json'), '{"a":1}');

    const [entry] = await nodeListNamedFiles(path.join(root, 'ws'))();
    expect(entry).toBeDefined();
    expect(entry!.path).toBe('data.json');
    expect(entry!.size).toBe(7);
    expect(typeof entry!.mtimeMs).toBe('number');
  });
});

describe('parseGitignore', () => {
  it('matches plain filename patterns anywhere in the tree', () => {
    const isIgnored = parseGitignore('*.log\n');
    expect(isIgnored('app.log')).toBe(true);
    expect(isIgnored('nested/deep/app.log')).toBe(true);
    expect(isIgnored('app.txt')).toBe(false);
  });

  it('matches directory-only patterns as a path prefix', () => {
    const isIgnored = parseGitignore('build/\n');
    expect(isIgnored('build/out.txt')).toBe(true);
    expect(isIgnored('build/nested/out.txt')).toBe(true);
    expect(isIgnored('rebuild/out.txt')).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const isIgnored = parseGitignore('# comment\n\n*.log\n');
    expect(isIgnored('app.log')).toBe(true);
    expect(isIgnored('# comment')).toBe(false);
  });

  it('applies `!` negation to re-include a path an earlier pattern excluded', () => {
    const isIgnored = parseGitignore('*.log\n!keep.log\n');
    expect(isIgnored('keep.log')).toBe(false);
    expect(isIgnored('other.log')).toBe(true);
  });
});
