/**
 * onGitHeadChanged() — commit-triggered incremental indexing. Store/parsers/
 * extractor/git are all in-memory fakes; no real DB or grammars needed since
 * we're only asserting which paths the indexer decides to (re)index/remove.
 */

import { describe, expect, it, vi } from 'vitest';
import { CodeIndexerImpl } from './codeIndexerImpl';
import type { CodeIndexerDeps, CodeIndexerOptions, GitOps } from './codeIndexer';
import type { CodeStore } from './codeStore';
import type { Extractor } from './extractors';
import type { ParserRegistry } from './parserRegistry';
import type { FileExtraction, FileRecord, IndexStats } from './types';
import type { IndexProvenanceService } from './provenance';

const EMPTY_STATS: IndexStats = {
  files: 0,
  symbols: 0,
  edges: 0,
  pendingRefs: 0,
  pendingEmbeddings: 0,
  lastIndexedAt: null,
};

function fakeStore(): CodeStore & { applied: string[]; removed: string[] } {
  const store = {
    applied: [] as string[],
    removed: [] as string[],
    async applyExtraction(extraction: FileExtraction): Promise<FileRecord> {
      store.applied.push(extraction.path);
      return {
        id: 1,
        path: extraction.path,
        lang: extraction.lang,
        mtimeMs: extraction.mtimeMs,
        size: extraction.size,
        hash: extraction.hash,
        indexedAt: Date.now(),
      };
    },
    async removeFile(path: string): Promise<void> {
      store.removed.push(path);
    },
    async resolvePending(): Promise<number> {
      return 0;
    },
    async listFiles(): Promise<FileRecord[]> {
      return [];
    },
    async stats(): Promise<IndexStats> {
      return EMPTY_STATS;
    },
  } as unknown as CodeStore & { applied: string[]; removed: string[] };
  return store;
}

function fakeParsers(): ParserRegistry {
  return {
    async init() {},
    async load() {
      return {} as never;
    },
    loadedLangs() {
      return [];
    },
    dispose() {},
  };
}

function fakeExtractor(): Extractor {
  return {
    extract(_loaded, path, _source, stat): FileExtraction {
      return {
        path,
        lang: 'typescript',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: `hash-${path}-${stat.mtimeMs}`,
        symbols: [],
        refs: [],
        imports: [],
      };
    },
  };
}

function fakeGit(overrides: Partial<GitOps> = {}): GitOps {
  return {
    headSha: vi.fn(async () => 'HEAD'),
    branchName: vi.fn(async () => 'main'),
    diffNames: vi.fn(async () => ({ added: [], modified: [], deleted: [] })),
    dirtyPaths: vi.fn(async () => []),
    commitsBetween: vi.fn(async () => 0),
    getLastIndexedSha: vi.fn(async () => null),
    setLastIndexedSha: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeIndexer(deps: Partial<CodeIndexerDeps>, optionsOverrides: Partial<CodeIndexerOptions> = {}) {
  const store = deps.store ?? fakeStore();
  const options: CodeIndexerOptions = {
    workspaceRoot: '/ws',
    exclude: [],
    embeddingsEnabled: false,
    ...optionsOverrides,
  };
  const fullDeps: CodeIndexerDeps = {
    store,
    parsers: fakeParsers(),
    extractor: fakeExtractor(),
    listWorkspaceFiles: async () => [],
    readFile: async (path: string) => ({ source: '', mtimeMs: 1, size: 10 }),
    ...deps,
  };
  return new CodeIndexerImpl(fullDeps, options);
}

describe('CodeIndexerImpl.onGitHeadChanged', () => {
  it('no-ops when deps.git is not supplied', async () => {
    const indexer = makeIndexer({});
    await expect(indexer.onGitHeadChanged()).resolves.toBeUndefined();
  });

  it('no-ops when git repo has no HEAD yet', async () => {
    const git = fakeGit({ headSha: vi.fn(async () => null) });
    const indexer = makeIndexer({ git });
    await indexer.onGitHeadChanged();
    expect(git.getLastIndexedSha).not.toHaveBeenCalled();
  });

  it('records a baseline sha on first observation without diffing', async () => {
    const git = fakeGit({ headSha: vi.fn(async () => 'abc123') });
    const indexer = makeIndexer({ git });
    await indexer.onGitHeadChanged();
    expect(git.diffNames).not.toHaveBeenCalled();
    expect(git.setLastIndexedSha).toHaveBeenCalledWith('abc123');
  });

  it('is a no-op when HEAD has not moved since the last indexed sha', async () => {
    const git = fakeGit({
      headSha: vi.fn(async () => 'same-sha'),
      getLastIndexedSha: vi.fn(async () => 'same-sha'),
    });
    const indexer = makeIndexer({ git });
    await indexer.onGitHeadChanged();
    expect(git.diffNames).not.toHaveBeenCalled();
    expect(git.setLastIndexedSha).not.toHaveBeenCalled();
  });

  it('reindexes only added/modified source files and removes deleted ones, filtering non-source paths', async () => {
    const store = fakeStore();
    const git = fakeGit({
      headSha: vi.fn(async () => 'new-sha'),
      getLastIndexedSha: vi.fn(async () => 'old-sha'),
      diffNames: vi.fn(async () => ({
        added: ['src/new.ts', 'README.md'], // README filtered: not a source postfix
        modified: ['src/existing.py'],
        deleted: ['src/gone.js', 'notes.txt'], // notes.txt filtered on delete too
      })),
    });
    const indexer = makeIndexer({ store, git });

    await indexer.onGitHeadChanged();

    expect(store.applied.sort()).toEqual(['src/existing.py', 'src/new.ts']);
    expect(store.removed).toEqual(['src/gone.js']);
    expect(git.setLastIndexedSha).toHaveBeenCalledWith('new-sha');
  });

  it('respects the exclude globs for added/modified files from the diff', async () => {
    const store = fakeStore();
    const git = fakeGit({
      headSha: vi.fn(async () => 'new-sha'),
      getLastIndexedSha: vi.fn(async () => 'old-sha'),
      diffNames: vi.fn(async () => ({
        added: ['sub/dist/bundle.js', 'src/keep.ts'],
        modified: [],
        deleted: [],
      })),
    });
    const options: CodeIndexerOptions = {
      workspaceRoot: '/ws',
      exclude: ['**/dist/**'],
      embeddingsEnabled: false,
    };
    const indexer = new CodeIndexerImpl(
      {
        store,
        parsers: fakeParsers(),
        extractor: fakeExtractor(),
        listWorkspaceFiles: async () => [],
        readFile: async () => ({ source: '', mtimeMs: 1, size: 10 }),
        git,
      },
      options
    );

    await indexer.onGitHeadChanged();

    expect(store.applied).toEqual(['src/keep.ts']);
  });
});

describe('file-cache skip check (no O(files²) listFiles)', () => {
  it('calls store.listFiles at most once per queue drain', async () => {
    const store = fakeStore();
    const listFiles = vi.fn(async () => [] as FileRecord[]);
    (store as unknown as { listFiles: typeof listFiles }).listFiles = listFiles;
    const git = fakeGit({
      headSha: vi.fn(async () => 'new-sha'),
      getLastIndexedSha: vi.fn(async () => 'old-sha'),
      diffNames: vi.fn(async () => ({
        added: ['a.ts', 'b.ts', 'c.ts'],
        modified: [],
        deleted: [],
      })),
    });
    const indexer = makeIndexer({ store, git });

    await indexer.onGitHeadChanged();

    expect(store.applied.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(listFiles.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('skips a re-queued file whose mtime/size are unchanged (cache updated after apply)', async () => {
    const store = fakeStore();
    const git = fakeGit({
      headSha: vi.fn(async () => 'sha-2'),
      getLastIndexedSha: vi.fn(async () => 'sha-1'),
      diffNames: vi.fn(async () => ({ added: ['a.ts'], modified: [], deleted: [] })),
    });
    const indexer = makeIndexer({ store, git });

    await indexer.onGitHeadChanged();
    expect(store.applied).toEqual(['a.ts']);

    // Same file again with identical mtime/size — must be skipped via the cache.
    (git.headSha as ReturnType<typeof vi.fn>).mockResolvedValue('sha-3');
    (git.getLastIndexedSha as ReturnType<typeof vi.fn>).mockResolvedValue('sha-2');
    await indexer.onGitHeadChanged();
    expect(store.applied).toEqual(['a.ts']);
  });
});

describe('embedding backfill resilience', () => {
  function fakeStoreWithPending(): CodeStore & { applied: string[]; removed: string[] } {
    const store = fakeStore();
    (store as unknown as { pendingEmbeddings: () => Promise<never[]> }).pendingEmbeddings = async () => [];
    return store;
  }

  it('a failing embed() does not put the indexer into the error phase', async () => {
    const store = fakeStoreWithPending();
    (store as unknown as { pendingEmbeddings: () => Promise<unknown[]> }).pendingEmbeddings = async () => [
      { id: 1, name: 'foo', kind: 'function', qualified: 'foo', signature: null, doc: null, file: 'a.ts' },
    ];
    const embed = vi.fn(async () => {
      throw new Error('GLIBC_2.38 not found');
    });
    const indexer = makeIndexer({ store, embed }, { embeddingsEnabled: true });

    await indexer.start();
    await new Promise((r) => setImmediate(r));

    const status = indexer.status();
    expect(status.phase).not.toBe('error');
    expect(status.lastError).toContain('GLIBC_2.38');
  });

  it('does not retry embed() again once it has failed once', async () => {
    const store = fakeStoreWithPending();
    (store as unknown as { pendingEmbeddings: () => Promise<unknown[]> }).pendingEmbeddings = async () => [
      { id: 1, name: 'foo', kind: 'function', qualified: 'foo', signature: null, doc: null, file: 'a.ts' },
    ];
    const embed = vi.fn(async () => {
      throw new Error('boom');
    });
    const git = fakeGit({
      headSha: vi.fn(async () => 'sha-2'),
      getLastIndexedSha: vi.fn(async () => 'sha-1'),
      diffNames: vi.fn(async () => ({ added: ['a.ts'], modified: [], deleted: [] })),
    });
    const indexer = makeIndexer({ store, embed, git }, { embeddingsEnabled: true });

    await indexer.start();
    await new Promise((r) => setImmediate(r));
    expect(embed.mock.calls.length).toBe(1);

    await indexer.onGitHeadChanged();
    expect(embed.mock.calls.length).toBe(1);
  });
});

describe('generation-stamp resilience (docs/MemoryIndexSynergy.md §F1)', () => {
  function fakeThrowingProvenance(): IndexProvenanceService {
    return {
      current: async () => null,
      beginGeneration: async () => {
        throw new Error('database is locked');
      },
      completeGeneration: async () => {},
      needsFullRebuild: async () => false,
      freshness: async () => ({
        generation: null,
        headSha: null,
        commitsBehind: null,
        dirtyUnindexed: [],
        indexing: false,
        queued: 0,
      }),
    };
  }

  it('a failing beginGeneration() does not block activation scanning or leave the indexer stuck in "scanning"', async () => {
    const provenance = fakeThrowingProvenance();
    const indexer = makeIndexer({ provenance });

    await indexer.start();
    await new Promise((r) => setImmediate(r));

    // Regression: beginGeneration() used to run before the try block in
    // runActivationScan(), so a throw here left phase stuck at 'scanning'
    // forever and produced an unhandled promise rejection (start() calls
    // runActivationScan() fire-and-forget).
    expect(indexer.status().phase).toBe('idle');
  });

  it('a failing beginGeneration() does not block onGitHeadChanged()\'s incremental index', async () => {
    const provenance = fakeThrowingProvenance();
    const git = fakeGit({
      headSha: vi.fn(async () => 'sha-2'),
      getLastIndexedSha: vi.fn(async () => 'sha-1'),
      diffNames: vi.fn(async () => ({ added: ['a.ts'], modified: [], deleted: [] })),
    });
    const store = fakeStore();
    const indexer = makeIndexer({ store, git, provenance });

    await indexer.onGitHeadChanged();

    expect(store.applied).toContain('a.ts');
    expect(git.setLastIndexedSha).toHaveBeenCalledWith('sha-2');
  });

  it('a failing completeGeneration() does not throw out of runActivationScan()', async () => {
    const provenance: IndexProvenanceService = {
      ...fakeThrowingProvenance(),
      beginGeneration: async () => 1,
      completeGeneration: async () => {
        throw new Error('database is locked');
      },
    };
    const indexer = makeIndexer({ provenance });

    await indexer.start();
    await new Promise((r) => setImmediate(r));

    expect(indexer.status().phase).toBe('idle');
  });
});
