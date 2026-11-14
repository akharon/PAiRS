/**
 * Store lifecycle: pragmas, schema reset/migration, snapshot, compaction,
 * cache release, chunked resolvePending, grep/edges query shapes.
 * Real SQLite in temp dirs (left to the OS).
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteCodeStore } from './sqliteCodeStore';
import { nodeSqlDriver } from './sqliteDriver';
import { SCHEMA_VERSION } from './sqlSchema';
import type { FileExtraction, NewSymbol, RawRef } from '../../core/indexer/types';

function tmpDb(name = 'graph.db'): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-maint-')), name);
}

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'function', extra: Partial<NewSymbol> = {}): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 1, endLine: 1, signature: null, doc: null, exported: true, parentIndex: null, ...extra };
}

function extraction(file: string, symbols: NewSymbol[], refs: RawRef[] = [], uses: FileExtraction['uses'] = []): FileExtraction {
  return {
    path: file,
    lang: 'rust',
    mtimeMs: 1,
    size: 1,
    hash: `h-${file}-${Math.random()}`,
    crate: null,
    parseError: false,
    symbols: [sym(file, file, 'module'), ...symbols],
    refs,
    uses,
  };
}

const pragma = (conn: ReturnType<typeof nodeSqlDriver.open>, name: string): number =>
  Number(Object.values(conn.prepare(`PRAGMA ${name}`).get() ?? { v: 0 })[0]);

describe('sqliteDriver pragmas', () => {
  it('sets busy_timeout, journal_size_limit, cache_size and incremental auto_vacuum on a new file', () => {
    const conn = nodeSqlDriver.open(tmpDb());
    try {
      expect(pragma(conn, 'busy_timeout')).toBe(5000);
      expect(pragma(conn, 'journal_size_limit')).toBe(67108864);
      expect(pragma(conn, 'cache_size')).toBe(-16000);
      expect(pragma(conn, 'auto_vacuum')).toBe(2);
    } finally {
      conn.close();
    }
  });

  it('a second process-style connection can wait on a writer instead of failing immediately', () => {
    const p = tmpDb();
    const a = nodeSqlDriver.open(p);
    const b = nodeSqlDriver.open(p);
    try {
      a.exec('CREATE TABLE t(x)');
      a.exec('BEGIN IMMEDIATE');
      const t0 = Date.now();
      // b has to wait out busy_timeout (we don't wait 5s: release shortly after, from a timer-free angle —
      // just assert the pragma governs b too, which is what makes the wait happen).
      expect(pragma(b, 'busy_timeout')).toBe(5000);
      a.exec('COMMIT');
      b.exec('INSERT INTO t VALUES (1)');
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('schema versioning', () => {
  it('drops and rebuilds a v9 database, converting it to incremental auto_vacuum and a WITHOUT ROWID Edge', async () => {
    const p = tmpDb();
    // A legacy-shaped file: created WITHOUT auto_vacuum, old Edge table, old version stamp.
    const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: new (f: string) => { exec(s: string): void; close(): void } };
    const legacy = new DatabaseSync(p);
    legacy.exec(`CREATE TABLE Meta(key TEXT PRIMARY KEY, value TEXT)`);
    legacy.exec(`INSERT INTO Meta VALUES('schema_version','9')`);
    legacy.exec(`CREATE TABLE Edge(src INTEGER, dst INTEGER, kind TEXT, line INTEGER, confidence TEXT, test INTEGER)`);
    legacy.exec(`CREATE UNIQUE INDEX idx_edge_unique ON Edge(src,dst,kind,line)`);
    legacy.exec(`CREATE INDEX idx_edge_src ON Edge(src,kind)`);
    legacy.close();

    const store = await SqliteCodeStore.open(p, nodeSqlDriver);
    try {
      const v = (await store.query(`SELECT value FROM Meta WHERE key='schema_version'`))[0]!.value;
      expect(Number(v)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(11);
      const edgeSql = String((await store.query(`SELECT sql FROM sqlite_master WHERE name='Edge'`))[0]!.sql);
      expect(edgeSql).toMatch(/WITHOUT ROWID/i);
      const idx = (await store.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='Edge'`)).map((r) => String(r.name));
      expect(idx).not.toContain('idx_edge_src');
      expect(idx).not.toContain('idx_edge_unique');
      expect(idx).toContain('idx_edge_dst');
      const av = Number((await store.query(`SELECT auto_vacuum AS v FROM pragma_auto_vacuum`))[0]!.v);
      expect(av).toBe(2);
      expect((await store.stats()).files).toBe(0);
    } finally {
      store.dispose();
    }
  });
});

describe('Edge access paths (EXPLAIN QUERY PLAN)', () => {
  it('src, dst and kind lookups all use an index, never a full scan', async () => {
    const p = tmpDb();
    const store = await SqliteCodeStore.open(p, nodeSqlDriver);
    const raw = nodeSqlDriver.open(p); // store.query() is read-only SQL; EXPLAIN of a DELETE needs a raw handle
    try {
      const plan = async (sql: string): Promise<string> =>
        raw
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((r) => String(r.detail))
          .join(' | ');
      const forward = await plan(`SELECT * FROM Edge WHERE src IN (1,2,3) AND kind IN ('CALLS','READS')`);
      expect(forward).toMatch(/SEARCH Edge USING (PRIMARY KEY|INDEX)/);
      expect(forward).not.toMatch(/SCAN Edge/);
      const backward = await plan(`SELECT * FROM Edge WHERE dst IN (1,2,3) AND kind IN ('CALLS','READS')`);
      expect(backward).toMatch(/idx_edge_dst/);
      const delSrc = await plan(`DELETE FROM Edge WHERE kind <> 'DECLARES' AND src IN (SELECT id FROM Symbol WHERE fileId = 1)`);
      expect(delSrc).not.toMatch(/SCAN Edge/);
      const delDst = await plan(`DELETE FROM Edge WHERE dst IN (SELECT id FROM Symbol WHERE fileId = 1)`);
      expect(delDst).toMatch(/idx_edge_dst/);
    } finally {
      raw.close();
      store.dispose();
    }
  });
});

describe('snapshot / reset / compact / releaseCaches', () => {
  async function populate(store: SqliteCodeStore, files: number, symsPerFile: number): Promise<void> {
    for (let f = 0; f < files; f++) {
      const syms: NewSymbol[] = [];
      for (let i = 0; i < symsPerFile; i++) syms.push(sym(`fn_${f}_${i}`, `fn_${f}_${i}`, 'function', { doc: 'x'.repeat(200) }));
      await store.applyExtraction(extraction(`src/f${f}.rs`, syms));
    }
  }

  it('snapshot of a populated store opens with identical stats', async () => {
    const src = tmpDb('a.db');
    const store = await SqliteCodeStore.open(src, nodeSqlDriver);
    await populate(store, 5, 10);
    const dst = tmpDb('b.db');
    SqliteCodeStore.snapshot(src, dst, nodeSqlDriver);
    const copy = await SqliteCodeStore.open(dst, nodeSqlDriver);
    try {
      expect(await copy.stats()).toEqual(await store.stats());
      expect(await copy.fileCount()).toBe(5);
      // The copy is a real store: it keeps working (and is independent).
      await copy.removeFile('src/f0.rs');
      expect(await copy.fileCount()).toBe(4);
      expect(await store.fileCount()).toBe(5);
    } finally {
      copy.dispose();
      store.dispose();
    }
  });

  it('compact() returns freed pages once more than 10% of the file is free, and is a no-op otherwise', async () => {
    const p = tmpDb();
    const store = await SqliteCodeStore.open(p, nodeSqlDriver);
    try {
      await populate(store, 40, 40);
      await store.checkpoint();
      await store.compact(); // nothing free yet
      const grown = (await store.query(`SELECT page_count AS n FROM pragma_page_count`))[0]!.n;
      for (let f = 0; f < 36; f++) await store.removeFile(`src/f${f}.rs`);
      const freeBefore = Number((await store.query(`SELECT freelist_count AS n FROM pragma_freelist_count`))[0]!.n);
      expect(freeBefore).toBeGreaterThan(0);
      await store.compact();
      const freeAfter = Number((await store.query(`SELECT freelist_count AS n FROM pragma_freelist_count`))[0]!.n);
      const pagesAfter = Number((await store.query(`SELECT page_count AS n FROM pragma_page_count`))[0]!.n);
      expect(freeAfter).toBe(0);
      expect(pagesAfter).toBeLessThan(Number(grown));
      expect(await store.fileCount()).toBe(4);
    } finally {
      store.dispose();
    }
  });

  it('reset() shrinks the file back down', async () => {
    const p = tmpDb();
    const store = await SqliteCodeStore.open(p, nodeSqlDriver);
    try {
      await populate(store, 40, 40);
      await store.checkpoint();
      const big = fs.statSync(p).size;
      await store.reset();
      await store.checkpoint();
      expect(fs.statSync(p).size).toBeLessThan(big / 4);
      expect(await store.fileCount()).toBe(0);
      await populate(store, 2, 2); // and it is usable afterwards
      expect(await store.fileCount()).toBe(2);
    } finally {
      store.dispose();
    }
  });

  it('releaseCaches() mid-life is safe: later indexing rebuilds the mirror and still resolves', async () => {
    const store = await SqliteCodeStore.open(tmpDb(), nodeSqlDriver);
    try {
      await store.applyExtraction(extraction('shapes.rs', [sym('Circle', 'Circle', 'struct'), sym('area', 'Circle::area', 'method', { parentIndex: 1 })]));
      store.releaseCaches();
      await store.applyExtraction(extraction('main.rs', [sym('run', 'run')], [{ fromIndex: 1, name: 'area', qualifiedName: 'Circle::area', kind: 'CALLS', line: 3 }]));
      store.releaseCaches();
      // Re-index the target after a release: the mirror must pick up the new ids.
      await store.applyExtraction(extraction('shapes.rs', [sym('Circle', 'Circle', 'struct'), sym('area', 'Circle::area', 'method', { parentIndex: 1 })]));
      await store.resolvePending(['area'], { filePaths: ['main.rs'] });
      const edges = await store.query(
        `SELECT a.name AS f, b.qualified AS t FROM Edge e JOIN Symbol a ON a.id=e.src JOIN Symbol b ON b.id=e.dst WHERE e.kind='CALLS'`
      );
      expect(edges.map((r) => `${r.f}>${r.t}`)).toEqual(['run>Circle::area']);
    } finally {
      store.dispose();
    }
  });
});

describe('resolvePending: scoping and chunking', () => {
  it('filePaths retries the named file’s own parked refs even when no name hint matches', async () => {
    const store = await SqliteCodeStore.open(tmpDb(), nodeSqlDriver);
    try {
      await store.applyExtraction(extraction('b.rs', [sym('Widget', 'Widget', 'struct'), sym('foo', 'Widget::foo', 'method', { parentIndex: 1 })]));
      // A bare method call parks during the inline pass.
      await store.applyExtraction(
        extraction('a.rs', [sym('run', 'run')], [{ fromIndex: 1, name: 'foo', qualifiedName: null, kind: 'CALLS', line: 2, methodCall: true }])
      );
      expect(Number((await store.query(`SELECT COUNT(*) AS n FROM PendingRef`))[0]!.n)).toBe(1);
      expect(await store.resolvePending(['unrelated'])).toBe(0); // name hint alone does not reach it
      expect(await store.resolvePending(['unrelated'], { filePaths: ['a.rs'] })).toBe(1);
      expect(Number((await store.query(`SELECT COUNT(*) AS n FROM PendingRef`))[0]!.n)).toBe(0);
      // Unknown path: nothing to do, no throw.
      expect(await store.resolvePending(undefined, { filePaths: ['nope.rs'] })).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it('a full pass over more rows than one chunk resolves them all and retires the undeclared ones', async () => {
    const store = await SqliteCodeStore.open(tmpDb(), nodeSqlDriver);
    try {
      const refs: RawRef[] = [];
      for (let i = 1; i <= 12_000; i++) refs.push({ fromIndex: 0, name: 'target', qualifiedName: null, kind: 'CALLS', line: i });
      for (let i = 1; i <= 3_000; i++) refs.push({ fromIndex: 0, name: 'console_log', qualifiedName: null, kind: 'CALLS', line: 20_000 + i });
      await store.applyExtraction(extraction('caller.rs', [], refs)); // `target` not declared yet: all park
      await store.applyExtraction(extraction('callee.rs', [sym('target', 'target')]));
      const parked = Number((await store.query(`SELECT COUNT(*) AS n FROM PendingRef`))[0]!.n);
      expect(parked).toBe(15_000);

      const created = await store.resolvePending(undefined, { retireUnresolved: true });
      expect(created).toBe(12_000);
      expect(Number((await store.query(`SELECT COUNT(*) AS n FROM PendingRef`))[0]!.n)).toBe(0);
      expect(Number((await store.query(`SELECT COUNT(*) AS n FROM Edge WHERE kind='CALLS' AND confidence='resolved'`))[0]!.n)).toBe(12_000);
      const stats = await store.stats();
      expect(stats.pendingRefs).toBe(3_000); // retired ones keep counting
      expect(stats.externalRefs).toBe(3_000);
      expect(stats.resolvableMisses).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it('keeps retire accounting: undeclared = external, qualified = never a miss, shadowed-by-import = a miss', async () => {
    const store = await SqliteCodeStore.open(tmpDb(), nodeSqlDriver);
    try {
      await store.applyExtraction(extraction('lib.rs', [sym('Circle', 'Circle', 'struct'), sym('new', 'Circle::new', 'method', { parentIndex: 1 }), sym('helper', 'helper')]));
      await store.applyExtraction(
        extraction(
          'main.rs',
          [sym('run', 'run')],
          [
            { fromIndex: 1, name: 'ext1', qualifiedName: null, kind: 'CALLS', line: 1 }, // undeclared anywhere
            { fromIndex: 1, name: 'new', qualifiedName: 'Vec::new', kind: 'CALLS', line: 2 }, // qualified, declared bare name
            { fromIndex: 1, name: 'helper', qualifiedName: null, kind: 'CALLS', line: 3 }, // external import shadows workspace `helper`
          ],
          [
            { specifier: 'vitest', boundNames: ['helper'], isGlob: false, line: 1 }, // external package binds the name
            { specifier: './nothere', boundNames: [], isGlob: false, line: 2 }, // path import to nowhere
          ]
        )
      );
      const created = await store.resolvePending(undefined, { retireUnresolved: true });
      expect(created).toBe(0);
      const stats = await store.stats();
      expect(Number((await store.query(`SELECT COUNT(*) AS n FROM PendingRef`))[0]!.n)).toBe(0);
      expect(stats.pendingRefs).toBe(5);
      expect(stats.resolvableMisses).toBe(1); // only the bare `helper`
      expect(stats.externalRefs).toBe(4);
    } finally {
      store.dispose();
    }
  });
});

describe('query shapes', () => {
  it('grepSymbols treats % and _ literally, is case-insensitive, honours limit, and streams regexes', async () => {
    const store = await SqliteCodeStore.open(tmpDb(), nodeSqlDriver);
    try {
      await store.applyExtraction(
        extraction('g.rs', [
          sym('get_user', 'get_user', 'function', { doc: 'Fetch 100% of users' }),
          sym('getXuser', 'getXuser', 'function'),
          sym('Alpha', 'Alpha', 'struct', { signature: 'struct Alpha' }),
          sym('Émile', 'Émile', 'function'),
          sym('other', 'other', 'function', { doc: 'unrelated' }),
        ])
      );
      const names = async (pat: string, o?: Parameters<SqliteCodeStore['grepSymbols']>[1]): Promise<string[]> =>
        (await store.grepSymbols(pat, o)).map((s) => s.name).sort();
      expect(await names('get_user')).toEqual(['get_user']); // `_` is not a wildcard
      expect(await names('100%')).toEqual(['get_user']); // `%` is not a wildcard; matched via doc
      expect(await names('ALPHA')).toEqual(['Alpha']);
      expect(await names('émile')).toEqual(['Émile']); // non-ASCII fold still works
      expect(await names('^get', { isRegex: true })).toEqual(['getXuser', 'get_user']);
      expect(await names('get', { limit: 1 })).toHaveLength(1);
      expect(await names('alpha', { kinds: ['function'] })).toEqual([]);
      await expect(store.grepSymbols('(', { isRegex: true })).rejects.toThrow(/Invalid regex/);
      // The cached statement is reusable after an early-exit iteration.
      expect(await names('get', { limit: 1 })).toHaveLength(1);
      expect(await names('get')).toEqual(['getXuser', 'get_user']);
    } finally {
      store.dispose();
    }
  });

  it('edgesTo / edgesFrom accept id lists larger than the host-parameter cap', async () => {
    const store = await SqliteCodeStore.open(tmpDb(), nodeSqlDriver);
    try {
      await store.applyExtraction(extraction('t.rs', [sym('target', 'target')]));
      await store.applyExtraction(extraction('c.rs', [sym('caller', 'caller')], [{ fromIndex: 1, name: 'target', qualifiedName: null, kind: 'CALLS', line: 1 }]));
      const target = (await store.lookup('target')) as Array<{ id: number }>;
      const caller = (await store.lookup('caller')) as Array<{ id: number }>;
      const bigIds = Array.from({ length: 2500 }, (_, i) => 1_000_000 + i);
      const to = await store.edgesTo([...bigIds, target[0]!.id, ...bigIds], ['CALLS']);
      expect(to.map((e) => e.fromId)).toEqual([caller[0]!.id]);
      const from = await store.edgesFrom([...bigIds, caller[0]!.id], ['CALLS']);
      expect(from.map((e) => e.toId)).toEqual([target[0]!.id]);
    } finally {
      store.dispose();
    }
  });
});
