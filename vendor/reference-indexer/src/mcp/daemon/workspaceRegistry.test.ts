/**
 * WorkspaceRegistryImpl — root->handle lifecycle, session-count-aware
 * eviction, and single-indexer-per-root dedup. Store factories/indexer are
 * injected fakes; only file-existence (`.pairs/` presence) touches real fs
 * via a temp dir.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistryImpl } from './workspaceRegistry';
import type { MemoryStore } from '../../core/store';
import type { CodeStore } from '../../index/codeStore';
import type { GitOps } from '../../index/codeIndexer';
import type { NewMemory } from '../../core/types';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-ws-'));
  fs.mkdirSync(path.join(root, '.pairs'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeMemoryStore(): MemoryStore & { disposed: boolean } {
  return {
    disposed: false,
    dispose(this: { disposed: boolean }) {
      this.disposed = true;
    },
  } as unknown as MemoryStore & { disposed: boolean };
}

function fakeCodeStore(): CodeStore & { disposed: boolean } {
  return {
    disposed: false,
    dispose(this: { disposed: boolean }) {
      this.disposed = true;
    },
    async stats() {
      return { files: 3, symbols: 10, edges: 0, pendingRefs: 0, pendingEmbeddings: 0, lastIndexedAt: null };
    },
  } as unknown as CodeStore & { disposed: boolean };
}

describe('WorkspaceRegistryImpl', () => {
  it('rejects a root with no .pairs/ directory', async () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-bare-'));
    const registry = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => fakeMemoryStore(),
    });
    await expect(registry.acquire(bareDir)).rejects.toThrow(/No \.pairs/);
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('acquire() returns the same handle for the same root without re-opening stores', async () => {
    const openMemoryStore = vi.fn(async () => fakeMemoryStore());
    const registry = new WorkspaceRegistryImpl({ bundleDir: '/unused', openMemoryStore });

    const a = await registry.acquire(root);
    const b = await registry.acquire(root);

    expect(a).toBe(b);
    expect(openMemoryStore).toHaveBeenCalledTimes(1);
  });

  it('starts the indexer at most once per root even under concurrent acquire()', async () => {
    fs.writeFileSync(path.join(root, '.pairs', 'code.db'), '');
    const startIndexer = vi.fn(async () => ({ dispose: () => {} }));
    const registry = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => fakeMemoryStore(),
      openCodeStore: async () => fakeCodeStore(),
      startIndexer,
    });

    await Promise.all([registry.acquire(root), registry.acquire(root), registry.acquire(root)]);

    expect(startIndexer).toHaveBeenCalledTimes(1);
  });

  it('closeAll() disposes the indexer handle returned by startIndexer', async () => {
    fs.writeFileSync(path.join(root, '.pairs', 'code.db'), '');
    const dispose = vi.fn();
    const registry = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => fakeMemoryStore(),
      openCodeStore: async () => fakeCodeStore(),
      startIndexer: async () => ({ dispose }),
    });

    await registry.acquire(root);
    // startIndexer runs fire-and-forget; wait a tick for the .then() to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await registry.closeAll();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('evictIdle() closes handles with no sessions past maxIdleMs, and skips ones with active sessions', async () => {
    const registry = new WorkspaceRegistryImpl({ bundleDir: '/unused', openMemoryStore: async () => fakeMemoryStore() });
    const busyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-busy-'));
    fs.mkdirSync(path.join(busyRoot, '.pairs'));

    await registry.acquire(root);
    await registry.acquire(busyRoot);
    registry.retain(busyRoot);

    // Force both handles to look idle by evicting with maxIdleMs=0 (age since acquire is >=0ms).
    const closed = await registry.evictIdle(0);

    expect(closed).toBe(1);
    const infos = await registry.list();
    expect(infos.map((w) => w.root)).toEqual([busyRoot]);

    fs.rmSync(busyRoot, { recursive: true, force: true });
  });

  it('list() reports code stats and session counts', async () => {
    fs.writeFileSync(path.join(root, '.pairs', 'code.db'), '');
    const registry = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => fakeMemoryStore(),
      openCodeStore: async () => fakeCodeStore(),
      startIndexer: async () => ({ dispose: () => {} }),
    });

    await registry.acquire(root);
    registry.retain(root);
    registry.retain(root);
    registry.release(root);

    const infos = await registry.list();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ root, files: 3, symbols: 10, sessions: 1 });
  });

  it('knownRoots() persists across instances and drops roots whose .pairs/ no longer exists', async () => {
    const knownRootsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-known-')), 'workspaces.json');
    const registryA = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => fakeMemoryStore(),
      knownRootsPath,
    });
    await registryA.acquire(root);

    const registryB = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => fakeMemoryStore(),
      knownRootsPath,
    });
    expect(await registryB.knownRoots()).toEqual([root]);

    fs.rmSync(root, { recursive: true, force: true });
    expect(await registryB.knownRoots()).toEqual([]);
  });

  it('wires a real GitOps into the memory executor so memory_save captures a commit stamp (regression: git was hardcoded undefined)', async () => {
    const saved: NewMemory[] = [];
    const memoryStore: MemoryStore = {
      ...fakeMemoryStore(),
      async save(memory: NewMemory) {
        saved.push(memory);
        return {
          id: 'gotchas/x',
          type: memory.type,
          title: memory.title,
          description: memory.description ?? '',
          body: memory.body,
          tags: memory.tags ?? [],
          importance: memory.importance ?? 0.5,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          accessCount: 0,
          lastAccessedAt: null,
          links: [],
          provenance: memory.provenance ?? { actor: 'mcp' },
          stale: false,
        };
      },
    } as unknown as MemoryStore;

    const fakeGit: GitOps = {
      headSha: async () => 'deadbeef',
      branchName: async () => 'main',
      diffNames: async () => ({ added: [], modified: [], deleted: [] }),
      dirtyPaths: async () => [],
      commitsBetween: async () => 0,
      getLastIndexedSha: async () => null,
      setLastIndexedSha: async () => {},
    };

    const registry = new WorkspaceRegistryImpl({
      bundleDir: '/unused',
      openMemoryStore: async () => memoryStore,
      createGit: () => fakeGit,
    });

    const handle = await registry.acquire(root);
    await handle.memory.execute('memory_save', { type: 'gotcha', title: 'test', body: 'body', tags: [] }, 'mcp');

    expect(saved).toHaveLength(1);
    expect(saved[0]!.provenance).toMatchObject({ commit: 'deadbeef', branch: 'main' });
  });

  it('closeAll() disposes every open store', async () => {
    const memoryStore = fakeMemoryStore();
    const registry = new WorkspaceRegistryImpl({ bundleDir: '/unused', openMemoryStore: async () => memoryStore });
    await registry.acquire(root);
    await registry.closeAll();
    expect(memoryStore.disposed).toBe(true);
    expect(await registry.list()).toEqual([]);
  });
});
