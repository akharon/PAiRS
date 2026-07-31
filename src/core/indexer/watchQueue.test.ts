/**
 * WatchQueue debounce/coalesce behavior (plan.md 3.1) and the V8 property:
 * after a burst of random edits, the incrementally-maintained graph must be
 * isomorphic to a cold full index of the same final tree (plan.md 3.2 / R7).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WatchQueue } from './watchQueue';
import { IndexerImpl } from './codeIndexerImpl';
import { ExtractorImpl } from './extractorImpl';
import { ParserRegistryImpl, fileQuerySource } from './parserRegistryImpl';
import { nodeListWorkspaceFiles, nodeReadFile } from './nodeFsDeps';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import type { CodeStore } from '../../store/graph/codeStore';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('WatchQueue', () => {
  it('coalesces a burst into one call per file, latest kind wins', async () => {
    const calls: string[] = [];
    const q = new WatchQueue(
      {
        indexFile: async (p) => void calls.push(`index:${p}`),
        removeFile: async (p) => void calls.push(`remove:${p}`),
      },
      20
    );
    q.changed('a.rs');
    q.changed('a.rs');
    q.changed('b.rs');
    q.deleted('b.rs'); // change→delete collapses to delete
    await q.settle();
    expect(calls.sort()).toEqual(['index:a.rs', 'remove:b.rs']);
    q.dispose();
  });

  it('debounces: events inside the window flush together, onFlushed fires once', async () => {
    const flushes: Array<[string[], string[]]> = [];
    const q = new WatchQueue(
      {
        indexFile: async () => undefined,
        removeFile: async () => undefined,
        onFlushed: (c, r) => void flushes.push([c, r]),
      },
      30
    );
    q.changed('x.rs');
    await wait(10);
    q.changed('y.rs'); // still within the re-armed window
    await q.settle();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]![0].sort()).toEqual(['x.rs', 'y.rs']);
    q.dispose();
  });

  it('reports per-file errors without dropping the rest of the batch', async () => {
    const errs: string[] = [];
    const ok: string[] = [];
    const q = new WatchQueue(
      {
        indexFile: async (p) => {
          if (p === 'bad.rs') throw new Error('boom');
          ok.push(p);
        },
        removeFile: async () => undefined,
        onError: (p) => void errs.push(p),
      },
      10
    );
    q.changed('bad.rs');
    q.changed('good.rs');
    await q.settle();
    expect(errs).toEqual(['bad.rs']);
    expect(ok).toEqual(['good.rs']);
    q.dispose();
  });
});

// -- V8: incremental ≡ full ------------------------------------------------------

/** Canonical graph fingerprint: sorted symbols + sorted edges by stable keys. */
async function fingerprint(store: CodeStore): Promise<string> {
  const syms = await store.query(
    `MATCH (s:Symbol) RETURN s.file AS f, s.qualified AS q, s.kind AS k, s.startLine AS l ORDER BY f, q, k, l`
  );
  const edges = await store.query(
    `MATCH (a:Symbol)-[e:CALLS|READS|WRITES|DEPENDS_ON|IMPLEMENTS|EXTENDS|REFERENCES]->(b:Symbol)
     RETURN label(e) AS t, a.qualified AS aq, a.file AS af, b.qualified AS bq, b.file AS bf, e.confidence AS c, e.test AS tt
     ORDER BY t, af, aq, bf, bq, c`
  );
  return JSON.stringify({ syms, edges });
}

function makeWorkspace(dir: string, files: Record<string, string>): void {
  for (const [rel, src] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  }
}

async function openIndexer(root: string): Promise<{ store: CodeStore; indexer: IndexerImpl; dispose(): void }> {
  const store = await KuzuCodeStore.open(path.join(root, '.pairs', 'index'), nodeKuzuDriver);
  const parsers = new ParserRegistryImpl(
    path.join(__dirname, '../../../dist/grammars'),
    fileQuerySource(path.join(__dirname, '../../../dist/queries'))
  );
  const indexer = new IndexerImpl({
    store,
    parsers,
    extractor: new ExtractorImpl(),
    listWorkspaceFiles: nodeListWorkspaceFiles(root),
    readFile: nodeReadFile(root),
  });
  return { store, indexer, dispose: () => parsers.dispose() };
}

describe('re-park on target change (R7)', () => {
  it('an edited file keeps its incoming cross-file edges', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-repark-'));
    fs.mkdirSync(path.join(root, '.pairs'), { recursive: true });
    makeWorkspace(root, {
      'src/lib.rs': `pub fn target() {}\n`,
      'src/user.rs': `use crate::lib::target;\npub fn caller() { target(); }\n`,
    });
    const w = await openIndexer(root);
    await w.indexer.fullIndex(root);
    const before = await w.store.query(`MATCH (:Symbol)-[e:CALLS]->(s:Symbol {name:'target'}) RETURN count(e) AS c`);
    expect(Number(before[0]!.c)).toBe(1);

    // Edit lib.rs WITHOUT touching user.rs: the old `target` symbol is
    // deleted; the incoming CALLS edge must re-park and re-resolve onto the
    // new symbol, not silently vanish.
    fs.writeFileSync(path.join(root, 'src/lib.rs'), `pub fn target() { let _x = 1; }\npub fn extra() {}\n`);
    await w.indexer.indexFile('src/lib.rs');
    const after = await w.store.query(`MATCH (:Symbol)-[e:CALLS]->(s:Symbol {name:'target'}) RETURN count(e) AS c`);
    expect(Number(after[0]!.c)).toBe(1);

    // Delete lib.rs entirely: the edge is gone but the claim survives as a
    // PendingRef, so re-creating the file restores the edge.
    fs.rmSync(path.join(root, 'src/lib.rs'));
    await w.indexer.removeFile('src/lib.rs');
    fs.writeFileSync(path.join(root, 'src/lib.rs'), `pub fn target() {}\n`);
    await w.indexer.indexFile('src/lib.rs');
    const restored = await w.store.query(`MATCH (:Symbol)-[e:CALLS]->(s:Symbol {name:'target'}) RETURN count(e) AS c`);
    expect(Number(restored[0]!.c)).toBe(1);
    w.dispose();
  }, 60_000);
});

describe('V8: incremental graph ≡ cold full index', () => {
  it('random create/edit/delete bursts converge to the cold-index graph', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-v8-'));
    fs.mkdirSync(path.join(root, '.pairs'), { recursive: true });

    const gen = (n: number, calls: string[]): string =>
      `pub fn f${n}() { ${calls.map((c) => `${c}();`).join(' ')} }\n`;

    makeWorkspace(root, {
      'src/a.rs': gen(1, []) + gen(2, ['f1']),
      'src/b.rs': `use crate::a::f1;\n` + gen(3, ['f1']),
      'src/c.rs': gen(4, ['f3']),
    });

    const inc = await openIndexer(root);
    await inc.indexer.fullIndex(root);

    // Deterministic pseudo-random edit script (seeded LCG) — 30 mutations.
    let seed = 42;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
    const paths = ['src/a.rs', 'src/b.rs', 'src/c.rs', 'src/d.rs', 'src/e.rs'];
    const queue = new WatchQueue(
      { indexFile: (p) => inc.indexer.indexFile(p), removeFile: (p) => inc.indexer.removeFile(p) },
      10
    );

    for (let i = 0; i < 30; i++) {
      const p = paths[Math.floor(rnd() * paths.length)]!;
      const abs = path.join(root, p);
      const op = rnd();
      if (op < 0.2 && fs.existsSync(abs)) {
        fs.rmSync(abs);
        queue.deleted(p);
      } else {
        const nFns = 1 + Math.floor(rnd() * 3);
        let src = '';
        for (let k = 0; k < nFns; k++) {
          const id = i * 10 + k;
          const callee = rnd() < 0.5 ? [`f${Math.floor(rnd() * 5) + 1}`] : [];
          src += gen(id, callee);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, src);
        queue.changed(p);
      }
      if (rnd() < 0.3) await queue.settle(); // sometimes let batches interleave
    }
    await queue.settle();
    queue.dispose();
    const incremental = await fingerprint(inc.store);
    inc.dispose();

    // Cold index of the same final tree into a fresh store.
    const coldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-v8-cold-'));
    fs.mkdirSync(path.join(coldRoot, '.pairs'), { recursive: true });
    for (const p of paths) {
      const src = path.join(root, p);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(coldRoot, p)), { recursive: true });
        fs.copyFileSync(src, path.join(coldRoot, p));
      }
    }
    const cold = await openIndexer(coldRoot);
    await cold.indexer.fullIndex(coldRoot);
    const coldPrint = await fingerprint(cold.store);
    cold.dispose();

    expect(incremental).toBe(coldPrint);
  }, 120_000);
});
