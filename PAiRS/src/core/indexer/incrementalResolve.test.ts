/**
 * Real-stack incremental re-index tests (store + indexer + tree-sitter).
 * Covers cross-file edges surviving `indexFile`, the stat-first and
 * hash-before-parse short-circuits (what makes a worktree seeded from another
 * index cheap), and that repeated re-indexing does not grow the database.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExtractorImpl } from './extractorImpl';
import { IndexerImpl } from './codeIndexerImpl';
import { nodeListWorkspaceFiles, nodeReadFile } from './nodeFsDeps';
import { fileQuerySource, ParserRegistryImpl } from './parserRegistryImpl';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import type { IndexerDeps } from './codeIndexer';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, 'queries');

function write(root: string, rel: string, contents: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

async function harness(
  files: Record<string, string>,
  opts: { root?: string; dbPath?: string; stat?: boolean } = {}
) {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-incr-'));
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  fs.mkdirSync(path.join(root, '.pairs'), { recursive: true });
  const dbPath = opts.dbPath ?? path.join(root, '.pairs', 'index.db');
  const store = await SqliteCodeStore.open(dbPath, nodeSqlDriver);
  const parsers = new ParserRegistryImpl(GRAMMARS_DIR, fileQuerySource(QUERIES_DIR));
  const real = new ExtractorImpl();
  const counts = { extract: 0, read: 0, stat: 0 };
  const extractor = {
    extract: (...args: Parameters<ExtractorImpl['extract']>) => {
      counts.extract++;
      return real.extract(...args);
    },
  };
  const read = nodeReadFile(root);
  const extra: Partial<IndexerDeps> = {};
  if (opts.stat !== false) {
    extra.statFile = async (p: string) => {
      counts.stat++;
      const st = fs.statSync(path.join(root, p));
      return { mtimeMs: st.mtimeMs, size: st.size };
    };
  }
  const indexer = new IndexerImpl({
    store,
    parsers,
    extractor,
    listWorkspaceFiles: nodeListWorkspaceFiles(root),
    readFile: async (p: string) => {
      counts.read++;
      return read(p);
    },
    ...extra,
  });
  return { root, dbPath, store, indexer, counts };
}

/** `caller>target.qualified:confidence` for every CALLS edge, sorted. */
async function callEdges(store: SqliteCodeStore): Promise<string[]> {
  const rows = await store.query(
    `SELECT a.name AS fromName, b.qualified AS toQ, e.confidence AS conf FROM Edge e
     JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'CALLS' ORDER BY 1, 2`
  );
  return rows.map((r) => `${r.fromName}>${r.toQ}:${r.conf}`);
}

async function dependsOn(store: SqliteCodeStore): Promise<string[]> {
  const rows = await store.query(
    `SELECT a.file AS af, b.file AS bf FROM Edge e
     JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'DEPENDS_ON' ORDER BY 1, 2`
  );
  return rows.map((r) => `${r.af}>${r.bf}`);
}

const A = `export function run(x: any) {\n  x.foo();\n}\n`;
const B = `export class Widget {\n  foo(): number {\n    return 1;\n  }\n}\n`;

describe('incremental re-index: edges survive', () => {
  it('keeps a cross-file method-call edge after re-indexing the calling file alone', async () => {
    const h = await harness({ 'a.ts': A, 'b.ts': B });
    await h.indexer.fullIndex(h.root);
    expect(await callEdges(h.store)).toEqual(['run>Widget.foo:resolved']);

    write(h.root, 'a.ts', A + `\n// touched\n`);
    await h.indexer.indexFile('a.ts');
    expect(await callEdges(h.store)).toEqual(['run>Widget.foo:resolved']);
  });

  it('keeps edges INTO a file whose target method was edited', async () => {
    const h = await harness({ 'a.ts': A, 'b.ts': B });
    await h.indexer.fullIndex(h.root);
    write(h.root, 'b.ts', B + `\n// touched\n`);
    await h.indexer.indexFile('b.ts');
    expect(await callEdges(h.store)).toEqual(['run>Widget.foo:resolved']);
  });

  it('keeps a typed-receiver edge precise (resolved, one target) when its target file is edited', async () => {
    const types = `export class Widget {\n  foo(): number {\n    return 1;\n  }\n}\nexport class Gadget {\n  foo(): number {\n    return 2;\n  }\n}\n`;
    const use = `import { Widget } from './types';\nexport function run(w: Widget) {\n  w.foo();\n}\n`;
    const h = await harness({ 'types.ts': types, 'use.ts': use });
    await h.indexer.fullIndex(h.root);
    const before = await callEdges(h.store);
    expect(before).toEqual(['run>Widget.foo:resolved']);

    write(h.root, 'types.ts', types + `\n// touched\n`);
    await h.indexer.indexFile('types.ts');
    expect(await callEdges(h.store)).toEqual(before);
  });

  it('keeps a file-level import (DEPENDS_ON) edge when the imported file is edited', async () => {
    const h = await harness({
      'lib/util.ts': `export function helper(): number {\n  return 1;\n}\n`,
      'app.ts': `import { helper } from './lib/util';\nexport function main() {\n  return helper();\n}\n`,
    });
    await h.indexer.fullIndex(h.root);
    expect(await dependsOn(h.store)).toEqual(['app.ts>lib/util.ts']);

    write(h.root, 'lib/util.ts', `export function helper(): number {\n  return 2;\n}\n`);
    await h.indexer.indexFile('lib/util.ts');
    expect(await dependsOn(h.store)).toEqual(['app.ts>lib/util.ts']);
    expect(await callEdges(h.store)).toEqual(['main>helper:resolved']);
  });

  it('does not delete an unrelated file’s DECLARES edges when file ids collide with symbol ids', async () => {
    const h = await harness({ 'a.ts': A, 'b.ts': B, 'c.ts': `export const c = 1;\nexport function cc() {}\n` });
    await h.indexer.fullIndex(h.root);
    const declares = async (): Promise<number> => Number((await h.store.query(`SELECT COUNT(*) AS n FROM Edge WHERE kind = 'DECLARES'`))[0]!.n);
    const symbols = Number((await h.store.query(`SELECT COUNT(*) AS n FROM Symbol`))[0]!.n);
    expect(await declares()).toBe(symbols); // every symbol (incl. module) has exactly one DECLARES
    for (const f of ['a.ts', 'b.ts', 'c.ts']) {
      write(h.root, f, (await fs.promises.readFile(path.join(h.root, f), 'utf8')) + `\n// touched\n`);
      await h.indexer.indexFile(f);
    }
    const symbolsAfter = Number((await h.store.query(`SELECT COUNT(*) AS n FROM Symbol`))[0]!.n);
    expect(await declares()).toBe(symbolsAfter);
  });
});

describe('stat-first and hash-before-parse', () => {
  const files = { 'a.ts': A, 'b.ts': B };

  it('an unchanged workspace costs stats only: no reads, no parses', async () => {
    const h = await harness(files);
    await h.indexer.fullIndex(h.root);
    const { read, extract } = h.counts;
    expect(read).toBe(2);
    await h.indexer.fullIndex(h.root);
    expect(h.counts.read).toBe(read);
    expect(h.counts.extract).toBe(extract);
  });

  it('a moved mtime with identical content touches the row and skips the parse', async () => {
    const h = await harness(files);
    await h.indexer.fullIndex(h.root);
    const extracts = h.counts.extract;
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(h.root, 'a.ts'), future, future);

    await h.indexer.fullIndex(h.root);
    expect(h.counts.extract).toBe(extracts); // content hash matched: no parse
    const row = (await h.store.query(`SELECT mtimeMs FROM File WHERE path = 'a.ts'`))[0]!;
    expect(Number(row.mtimeMs)).toBeCloseTo(future.getTime(), -2);

    // ...and the NEXT run short-circuits on stat alone.
    const reads = h.counts.read;
    await h.indexer.fullIndex(h.root);
    expect(h.counts.read).toBe(reads);
    expect(await callEdges(h.store)).toEqual(['run>Widget.foo:resolved']);
  });

  it('behaves the same without statFile (read-then-compare)', async () => {
    const h = await harness(files, { stat: false });
    await h.indexer.fullIndex(h.root);
    const extracts = h.counts.extract;
    await h.indexer.fullIndex(h.root);
    expect(h.counts.extract).toBe(extracts);
    expect(h.counts.read).toBe(4); // read every run, parse never again
  });

  it('a worktree seeded from a snapshot of another index re-parses nothing', async () => {
    const main = await harness(files);
    await main.indexer.fullIndex(main.root);
    const before = await callEdges(main.store);
    await main.store.checkpoint();

    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-wt-'));
    fs.mkdirSync(path.join(wtRoot, '.pairs'), { recursive: true });
    const dst = path.join(wtRoot, '.pairs', 'index.db');
    SqliteCodeStore.snapshot(main.dbPath, dst, nodeSqlDriver);

    // Same content, fresh mtimes — exactly what `git worktree add` produces.
    const wt = await harness(files, { root: wtRoot, dbPath: dst });
    await wt.indexer.fullIndex(wt.root);
    expect(wt.counts.extract).toBe(0);
    expect(await callEdges(wt.store)).toEqual(before);
    expect(await wt.store.fileCount()).toBe(2);
  });
});

describe('database growth under repeated re-indexing', () => {
  /** Pages actually holding data: page_count - freelist_count. */
  async function usedPages(store: SqliteCodeStore): Promise<number> {
    const r = (await store.query(`SELECT (SELECT page_count FROM pragma_page_count) - (SELECT freelist_count FROM pragma_freelist_count) AS used`))[0]!;
    return Number(r.used);
  }

  const gen = (rev: number): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let f = 0; f < 12; f++) {
      let src = `import { ext${f} } from 'external-pkg';\n`;
      for (let i = 0; i < 25; i++) {
        src += `export function fn${f}_${i}(x: any): number {\n  console.log(x);\n  ext${f}(x);\n  x.method${(i + 1) % 25}();\n  return fn${(f + 1) % 12}_${(i + 3) % 25}(x) + ${rev};\n}\n`;
      }
      out[`src/m${f}.ts`] = src;
    }
    return out;
  };

  it('stays within a small bound of a cold index of the same content', async () => {
    const cold = await harness(gen(5));
    await cold.indexer.fullIndex(cold.root);
    await cold.store.checkpoint();
    const coldPages = await usedPages(cold.store);

    const warm = await harness(gen(0));
    await warm.indexer.fullIndex(warm.root);
    for (let rev = 1; rev <= 5; rev++) {
      for (const [rel, src] of Object.entries(gen(rev))) write(warm.root, rel, src);
      await warm.indexer.fullIndex(warm.root);
      // Interleave single-file saves, the extension's hot path.
      write(warm.root, 'src/m3.ts', gen(rev)['src/m3.ts']! + `\n// save ${rev}\n`);
      await warm.indexer.indexFile('src/m3.ts');
    }
    // Normalise content to the cold index's final text (rev 5, no trailing comment).
    for (const [rel, src] of Object.entries(gen(5))) write(warm.root, rel, src);
    await warm.indexer.fullIndex(warm.root);
    await warm.store.checkpoint();
    await warm.store.compact();

    const warmPages = await usedPages(warm.store);
    expect(warmPages).toBeLessThanOrEqual(Math.ceil(coldPages * 1.15) + 8);
    // Same logical content, same graph.
    expect(await warm.store.stats()).toMatchObject({ files: 12, symbols: (await cold.store.stats()).symbols, edges: (await cold.store.stats()).edges });
    // Nothing external is left parked after a full pass.
    expect(Number((await warm.store.query(`SELECT COUNT(*) AS n FROM PendingRef`))[0]!.n)).toBe(0);
  }, 60_000);
});
