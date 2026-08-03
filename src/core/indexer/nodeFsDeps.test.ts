/**
 * Workspace enumeration over symlinks.
 *
 * `readdir(withFileTypes)` reports symlinks as neither file nor directory, so
 * a walk branching on isDirectory()/isFile() alone drops linked source trees
 * silently — no error, no log. These tests pin the follow behaviour and the
 * cycle protection that following requires.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeListWorkspaceFiles } from './nodeFsDeps';

/** Fresh temp workspace; `ws/` is the root passed to the walker. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-symlink-'));
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true });
  return root;
}

const list = (root: string): Promise<string[]> => nodeListWorkspaceFiles(path.join(root, 'ws'))();

describe('nodeListWorkspaceFiles symlink support', () => {
  it('indexes files inside a symlinked directory, addressed through the link', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'external', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'external', 'lib', 'ext.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'ws', 'main.ts'), 'export const b = 2;\n');
    fs.symlinkSync('../external/lib', path.join(root, 'ws', 'linkedDir'));

    // Relative to the workspace, not the link target's real path: that is the
    // identity the store, watcher and rule globs all key on.
    expect((await list(root)).sort()).toEqual(['linkedDir/ext.ts', 'main.ts']);
  });

  it('indexes a symlinked file', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'external'), { recursive: true });
    fs.writeFileSync(path.join(root, 'external', 'single.ts'), 'export const c = 3;\n');
    fs.symlinkSync('../external/single.ts', path.join(root, 'ws', 'linkedFile.ts'));

    expect(await list(root)).toEqual(['linkedFile.ts']);
  });

  it('terminates when a link points back into its own descent', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'ws', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ws', 'sub', 'a.ts'), 'export const d = 4;\n');
    fs.symlinkSync(path.join(root, 'ws'), path.join(root, 'ws', 'sub', 'loop')); // self-referential

    // The real assertion is that this returns at all rather than hanging or
    // blowing the stack; vitest's timeout catches a regression.
    expect(await list(root)).toEqual(['sub/a.ts']);
  });

  it('enumerates both of two distinct links to one shared tree', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared', 'x.ts'), 'export const e = 5;\n');
    fs.symlinkSync('../shared', path.join(root, 'ws', 'one'));
    fs.symlinkSync('../shared', path.join(root, 'ws', 'two'));

    // Deduping on real path (rather than on the current descent) would drop
    // whichever link the walk reached second.
    expect((await list(root)).sort()).toEqual(['one/x.ts', 'two/x.ts']);
  });

  it('skips a dangling link without throwing', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'ws', 'main.ts'), 'export const f = 6;\n');
    fs.symlinkSync('/nonexistent-target', path.join(root, 'ws', 'broken'));
    fs.symlinkSync('/nonexistent-target.ts', path.join(root, 'ws', 'broken.ts'));

    expect(await list(root)).toEqual(['main.ts']);
  });

  it('still honours SKIP_DIRS when reached through a link', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'external', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'external', 'node_modules', 'dep.ts'), 'export const g = 7;\n');
    fs.writeFileSync(path.join(root, 'external', 'keep.ts'), 'export const h = 8;\n');
    fs.symlinkSync('../external', path.join(root, 'ws', 'linked'));

    expect(await list(root)).toEqual(['linked/keep.ts']);
  });
});
