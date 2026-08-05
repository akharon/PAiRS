/**
 * NamedFile store methods: replaceNamedFiles/listNamedFiles/findNamedFiles.
 * Against a real SQLite database — the glob matching in findNamedFiles reuses
 * globToRegExp, but the round-trip through the table (replace-all semantics,
 * ordering) is worth pinning against the real store.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteCodeStore } from './sqliteCodeStore';
import { nodeSqlDriver } from './sqliteDriver';
import type { CodeStore } from './codeStore';

describe('NamedFile store methods', () => {
  let store: CodeStore;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-namedfile-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
  });

  it('lists what was replaced, ordered by path', async () => {
    await store.replaceNamedFiles([
      { path: 'docs/README.md', name: 'README.md', mtimeMs: 1, size: 10 },
      { path: 'assets/logo.svg', name: 'logo.svg', mtimeMs: 2, size: 20 },
    ]);

    const files = await store.listNamedFiles();
    expect(files.map((f) => f.path)).toEqual(['assets/logo.svg', 'docs/README.md']);
  });

  it('replaceNamedFiles fully replaces the prior contents', async () => {
    await store.replaceNamedFiles([{ path: 'old.txt', name: 'old.txt', mtimeMs: 1, size: 1 }]);
    await store.replaceNamedFiles([{ path: 'new.txt', name: 'new.txt', mtimeMs: 1, size: 1 }]);

    const files = await store.listNamedFiles();
    expect(files.map((f) => f.path)).toEqual(['new.txt']);
  });

  it('findNamedFiles with no pattern returns everything', async () => {
    await store.replaceNamedFiles([
      { path: 'a.txt', name: 'a.txt', mtimeMs: 1, size: 1 },
      { path: 'b.svg', name: 'b.svg', mtimeMs: 1, size: 1 },
    ]);
    expect((await store.findNamedFiles()).length).toBe(2);
  });

  it('matches a glob pattern against the basename, case-insensitively', async () => {
    await store.replaceNamedFiles([
      { path: 'assets/Picture1.svg', name: 'Picture1.svg', mtimeMs: 1, size: 1 },
      { path: 'assets/photo.png.txt', name: 'photo.png.txt', mtimeMs: 1, size: 1 },
      { path: 'notes.txt', name: 'notes.txt', mtimeMs: 1, size: 1 },
    ]);

    expect((await store.findNamedFiles('pic*.svg')).map((f) => f.path)).toEqual(['assets/Picture1.svg']);
    expect((await store.findNamedFiles('*.txt')).map((f) => f.path).sort()).toEqual(['assets/photo.png.txt', 'notes.txt']);
  });

  it('withPaths also matches the glob against the full path', async () => {
    await store.replaceNamedFiles([
      { path: 'assets/star.svg', name: 'star.svg', mtimeMs: 1, size: 1 },
      { path: 'other/star.svg', name: 'star.svg', mtimeMs: 1, size: 1 },
    ]);

    // A pattern containing '/' can never match a bare name (names hold no
    // slash), so without withPaths a path-shaped glob matches nothing.
    expect(await store.findNamedFiles('assets/*')).toEqual([]);
    // With withPaths, the same glob is also tried against the full path.
    expect((await store.findNamedFiles('assets/*', { withPaths: true })).map((f) => f.path)).toEqual(['assets/star.svg']);
  });
});
