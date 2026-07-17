import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from '../core/sqliteStore';
import { SqliteCodeStore } from './codeStoreImpl';
import { SqliteIndexProvenanceService } from './provenanceImpl';
import type { GitOps } from './codeIndexer';

function fakeGit(overrides: Partial<GitOps> = {}): GitOps {
  return {
    headSha: async () => 'abc1234',
    branchName: async () => 'main',
    diffNames: async () => ({ added: [], modified: [], deleted: [] }),
    dirtyPaths: async () => [],
    commitsBetween: async () => 0,
    getLastIndexedSha: async () => null,
    setLastIndexedSha: async () => {},
    ...overrides,
  };
}

describe('SqliteIndexProvenanceService', () => {
  let db: DatabaseSync;
  let store: SqliteCodeStore;
  let provenance: SqliteIndexProvenanceService;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new SqliteCodeStore(db); // migrate() creates generations/meta alongside symbols/files
    provenance = new SqliteIndexProvenanceService(db);
  });

  afterEach(() => store.dispose());

  it('current() is null before any generation is started', async () => {
    expect(await provenance.current()).toBeNull();
  });

  it('beginGeneration captures commit/branch/dirtyPaths and leaves completedAt null', async () => {
    const id = await provenance.beginGeneration({
      git: fakeGit(),
      dirtyPaths: ['src/a.ts'],
      toolVersion: '1.0.0',
    });
    const gen = await provenance.current();
    expect(gen).toMatchObject({
      id,
      commit: 'abc1234',
      branch: 'main',
      dirtyPaths: ['src/a.ts'],
      completedAt: null,
      toolVersion: '1.0.0',
    });
  });

  it('completeGeneration stamps completedAt; is idempotent', async () => {
    const id = await provenance.beginGeneration({ toolVersion: '1.0.0' });
    await provenance.completeGeneration(id);
    const first = (await provenance.current())!.completedAt;
    expect(first).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    await provenance.completeGeneration(id); // no-op: already completed
    const second = (await provenance.current())!.completedAt;
    expect(second).toBe(first);
  });

  it('beginGeneration works with no git (non-git workspace) — all-null stamp', async () => {
    const id = await provenance.beginGeneration({ toolVersion: '1.0.0' });
    const gen = await provenance.current();
    expect(gen).toMatchObject({ id, commit: null, branch: null, dirtyPaths: [] });
  });

  it('needsFullRebuild is false with no prior generation', async () => {
    expect(await provenance.needsFullRebuild('1.0.0')).toBe(false);
  });

  it('needsFullRebuild is true when the last COMPLETED generation has a different toolVersion', async () => {
    const id = await provenance.beginGeneration({ toolVersion: '1.0.0' });
    await provenance.completeGeneration(id);
    expect(await provenance.needsFullRebuild('2.0.0')).toBe(true);
    expect(await provenance.needsFullRebuild('1.0.0')).toBe(false);
  });

  it('freshness() reports commitsBehind=0 when generation commit equals live HEAD', async () => {
    const git = fakeGit({ headSha: async () => 'abc1234' });
    const id = await provenance.beginGeneration({ git, toolVersion: '1.0.0' });
    await provenance.completeGeneration(id);

    const f = await provenance.freshness({ git, queued: 0 });
    expect(f.commitsBehind).toBe(0);
    expect(f.indexing).toBe(false);
    expect(f.headSha).toBe('abc1234');
  });

  it('freshness() reports commitsBehind via GitOps.commitsBetween when HEAD has moved', async () => {
    const git = fakeGit({
      headSha: async () => 'def5678',
      commitsBetween: async () => 3,
    });
    const id = await provenance.beginGeneration({ git: fakeGit({ headSha: async () => 'abc1234' }), toolVersion: '1.0.0' });
    await provenance.completeGeneration(id);

    const f = await provenance.freshness({ git, queued: 2 });
    expect(f.commitsBehind).toBe(3);
    expect(f.queued).toBe(2);
  });

  it('freshness() reports indexing=true while a generation is in flight', async () => {
    await provenance.beginGeneration({ toolVersion: '1.0.0' }); // never completed
    const f = await provenance.freshness({});
    expect(f.indexing).toBe(true);
  });

  it('freshness() computes dirtyUnindexed as live-dirty minus the generation overlay', async () => {
    const git = fakeGit({ dirtyPaths: async () => ['src/a.ts', 'src/b.ts'] });
    const id = await provenance.beginGeneration({ git, dirtyPaths: ['src/a.ts'], toolVersion: '1.0.0' });
    await provenance.completeGeneration(id);

    const f = await provenance.freshness({ git });
    expect(f.dirtyUnindexed).toEqual(['src/b.ts']);
  });

  it('freshness() with no generation ever built reports generation: null', async () => {
    const f = await provenance.freshness({ git: fakeGit() });
    expect(f.generation).toBeNull();
  });

  it('meta get/set round-trips and INSERT OR REPLACE overwrites', async () => {
    expect(await provenance.getMeta('foo')).toBeNull();
    await provenance.setMeta('foo', 'bar');
    expect(await provenance.getMeta('foo')).toBe('bar');
    await provenance.setMeta('foo', 'baz');
    expect(await provenance.getMeta('foo')).toBe('baz');
  });

  it('generations/meta tables survive SqliteCodeStore.reset() (schema-version rebuild path)', async () => {
    const id = await provenance.beginGeneration({ toolVersion: '1.0.0' });
    await provenance.completeGeneration(id);
    await provenance.setMeta('k', 'v');

    await store.reset(); // drop-and-rebuild of derived-data tables only

    // generations/meta are NOT in dropAll()'s table list — must survive.
    expect(await provenance.current()).not.toBeNull();
    expect(await provenance.getMeta('k')).toBe('v');
  });
});
