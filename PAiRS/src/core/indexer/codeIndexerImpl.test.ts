/**
 * IndexerImpl orchestration test: store/parsers/extractor are in-memory
 * fakes; no real Kuzu or grammars needed since we're only asserting which
 * files the indexer decides to (re)apply/remove/skip.
 *
 * Adapted from vendor/reference-indexer/src/index/codeIndexerImpl.test.ts —
 * the fake-store/fake-parsers/fake-extractor pattern is carried over;
 * onGitHeadChanged/watcher-debounce coverage is dropped (Phase 1+, not in
 * PAiRS's IndexerImpl — see codeIndexer.ts).
 */

import { describe, expect, it } from 'vitest';
import { IndexerImpl } from './codeIndexerImpl';
import type { IndexerDeps } from './codeIndexer';
import type { CodeStore } from '../../store/graph/codeStore';
import type { Extractor } from './extractors';
import type { ParserRegistry } from './parserRegistry';
import type { FileExtraction, FileRecord, IndexStats } from './types';
import { indexProject } from '../../test/indexProject';

const EMPTY_STATS: IndexStats = {
  files: 0,
  symbols: 0,
  edges: 0,
  pendingRefs: 0,
  unresolvedRatio: 0,
  externalRefs: 0,
  resolvableMisses: 0,
  fuzzyRate: 0,
  byKind: {},
  lastIndexedAt: null,
};

function fakeStore(initialFiles: FileRecord[] = []): CodeStore & { applied: string[]; removed: string[]; resolveCalls: number } {
  const files = new Map(initialFiles.map((f) => [f.path, f]));
  const store = {
    applied: [] as string[],
    removed: [] as string[],
    resolveCalls: 0,
    async applyExtraction(extraction: FileExtraction): Promise<FileRecord> {
      store.applied.push(extraction.path);
      const record: FileRecord = {
        id: files.size + 1,
        path: extraction.path,
        lang: extraction.lang,
        mtimeMs: extraction.mtimeMs,
        size: extraction.size,
        hash: extraction.hash,
        indexedAt: Date.now(),
        crate: extraction.crate,
        parseError: extraction.parseError,
      };
      files.set(extraction.path, record);
      return record;
    },
    async removeFile(path: string): Promise<void> {
      store.removed.push(path);
      files.delete(path);
    },
    async resolvePending(): Promise<number> {
      store.resolveCalls += 1;
      return 0;
    },
    async listFiles(): Promise<FileRecord[]> {
      return [...files.values()];
    },
    async stats(): Promise<IndexStats> {
      return { ...EMPTY_STATS, files: files.size };
    },
    async checkpoint(): Promise<void> {},
  } as unknown as CodeStore & { applied: string[]; removed: string[]; resolveCalls: number };
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
        lang: 'rust',
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: `hash-${path}-${stat.mtimeMs}`,
        crate: null,
        parseError: false,
        symbols: [{ name: 'f', qualified: 'f', kind: 'function', lang: 'rust', startLine: 1, endLine: 1, signature: null, doc: null, exported: true, parentIndex: null }],
        refs: [],
        uses: [],
      };
    },
  };
}

function makeIndexer(deps: Partial<IndexerDeps>, files: Record<string, string> = {}) {
  const store = deps.store ?? fakeStore();
  const indexer = new IndexerImpl({
    store,
    parsers: fakeParsers(),
    extractor: fakeExtractor(),
    listWorkspaceFiles: async () => Object.keys(files),
    readFile: async (p: string) => ({ source: files[p] ?? '', mtimeMs: 1, size: (files[p] ?? '').length }),
    ...deps,
  });
  return { indexer, store: store as ReturnType<typeof fakeStore> };
}

describe('IndexerImpl.fullIndex', () => {
  it('applies every discovered file and resolves once at the end', async () => {
    const { indexer, store } = makeIndexer({}, { 'a.rs': 'fn a() {}', 'b.rs': 'fn b() {}' });
    await indexer.fullIndex('/root');
    expect(store.applied.sort()).toEqual(['a.rs', 'b.rs']);
    expect(store.resolveCalls).toBe(1); // one full pass, not per-file
  });

  it('removes files that vanished from disk since the last index', async () => {
    const store = fakeStore([{ id: 1, path: 'gone.rs', lang: 'rust', mtimeMs: 1, size: 1, hash: 'h', indexedAt: 1, crate: null, parseError: false }]);
    const { indexer } = makeIndexer({ store }, { 'a.rs': 'fn a() {}' });
    await indexer.fullIndex('/root');
    expect(store.removed).toEqual(['gone.rs']);
  });

  it('skips a file whose mtime/size are unchanged since the last index', async () => {
    const store = fakeStore([{ id: 1, path: 'a.rs', lang: 'rust', mtimeMs: 1, size: 9, hash: 'h', indexedAt: 1, crate: null, parseError: false }]);
    const { indexer } = makeIndexer({ store }, { 'a.rs': 'fn a() {}' }); // 'fn a() {}' has length 9
    await indexer.fullIndex('/root');
    expect(store.applied).toEqual([]);
  });

  it('ignores files with no known language extension', async () => {
    const { indexer, store } = makeIndexer({}, { 'readme.md': 'hello' });
    await indexer.fullIndex('/root');
    expect(store.applied).toEqual([]);
  });

  it('reports functions/types from the store’s per-kind breakdown', async () => {
    const store = fakeStore();
    store.stats = async () => ({
      ...EMPTY_STATS,
      files: 1,
      byKind: { function: 3, method: 2, struct: 4, enum: 1, trait: 1, var: 7 },
    });
    const { indexer } = makeIndexer({ store });
    const report = await indexer.fullIndex('/root');
    expect(report.functions).toBe(5); // function + method
    expect(report.types).toBe(6); // struct + enum + trait, not var
  });

  // End-to-end regression guard: the test above only proves the report-
  // assembly arithmetic is correct against a hand-built byKind fixture, which
  // is exactly why a real extraction/storage break (wrong capture name, wrong
  // DEF_CAPTURE_TO_KIND lookup, stats() read before commit, ...) could survive
  // the suite undetected. This goes through the actual parser/extractor/store,
  // the same path `pairs index` uses.
  it('reports a non-zero types count for a real TypeScript class and interface (Task 2)', async () => {
    const { report } = await indexProject({
      'src/shapes.ts': `export interface Shape {\n  area(): number;\n}\n\nexport class Circle implements Shape {\n  area(): number {\n    return 1;\n  }\n}\n`,
    });
    expect(report.types).toBe(2); // Shape (interface) + Circle (class)
  });
});

describe('IndexerImpl.indexFile', () => {
  it('resolves pending refs against just this file’s declared names', async () => {
    const { indexer, store } = makeIndexer({}, { 'a.rs': 'fn a() {}' });
    const result = await indexer.indexFile('a.rs');
    expect(store.applied).toEqual(['a.rs']);
    expect(store.resolveCalls).toBe(1);
    expect(result.declared.length).toBe(1);
  });
});
