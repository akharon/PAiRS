/**
 * diff_impact: line-range → symbol attribution, seed merging, and the
 * unattributed-hunk escape hatch (a changed line inside no symbol must never
 * be silently dropped — that would turn a real risk into a false all-clear).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import { diffImpact, resolveChangedSymbols } from './diffImpact';
import type { FileExtraction, NewSymbol, RawRef } from '../indexer/types';

function sym(name: string, qualified: string, startLine: number, endLine: number, kind: NewSymbol['kind'] = 'function'): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine, endLine, signature: '()', doc: null, exported: true, parentIndex: null };
}
function ext(p: string, symbols: NewSymbol[], refs: RawRef[] = []): FileExtraction {
  return {
    path: p,
    lang: 'rust',
    mtimeMs: 1,
    size: 1,
    hash: `h-${p}`,
    crate: null,
    parseError: false,
    // The module symbol spans line 1 only, so it never swallows hunks aimed
    // at the functions below it.
    symbols: [sym(p, p, 1, 1, 'module'), ...symbols],
    refs,
    uses: [],
  };
}
const calls = (name: string): RawRef => ({ fromIndex: 1, name, qualifiedName: null, kind: 'CALLS', line: 5 });

describe('diff_impact', () => {
  let store: SqliteCodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-diff-'));
    store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    // core.rs holds two functions, alpha and beta, both called by shared.rs —
    // the overlap case the merge exists for.
    await store.applyExtraction(ext('core.rs', [sym('alpha', 'alpha', 10, 20), sym('beta', 'beta', 30, 40)]));
    await store.applyExtraction(ext('shared.rs', [sym('shared', 'shared', 5, 15)], [calls('alpha'), calls('beta')]));
    await store.applyExtraction(ext('onlyalpha.rs', [sym('onlyAlpha', 'onlyAlpha', 5, 15)], [calls('alpha')]));
    await store.resolvePending(undefined, { retireUnresolved: true });
  });

  it('attributes a hunk to the symbol whose span contains it', async () => {
    const { changed, unattributed } = await resolveChangedSymbols(store, [{ path: 'core.rs', startLine: 12, endLine: 13 }]);
    expect(changed.map((c) => c.symbol.name)).toEqual(['alpha']);
    expect(unattributed).toEqual([]);
  });

  it('reports a hunk that lands in no symbol rather than dropping it', async () => {
    // Line 25 sits between alpha (10-20) and beta (30-40) — an import or a
    // module-level constant. It must surface for manual review.
    const { changed, unattributed } = await resolveChangedSymbols(store, [{ path: 'core.rs', startLine: 25, endLine: 25 }]);
    expect(changed).toEqual([]);
    expect(unattributed).toEqual([{ path: 'core.rs', startLine: 25, endLine: 25, reason: 'no-symbol-at-line' }]);
  });

  it('flags a change in an unindexed file', async () => {
    const { unattributed } = await resolveChangedSymbols(store, [{ path: 'README.md', startLine: 1, endLine: 3 }]);
    expect(unattributed[0]).toMatchObject({ path: 'README.md', reason: 'file-not-indexed' });
  });

  it('attributes a hunk spanning two symbols to both', async () => {
    const { changed } = await resolveChangedSymbols(store, [{ path: 'core.rs', startLine: 18, endLine: 32 }]);
    expect(changed.map((c) => c.symbol.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('merges a shared dependant into one entry tagged with both seeds', async () => {
    const res = await diffImpact(store, [
      { path: 'core.rs', startLine: 12, endLine: 12 },
      { path: 'core.rs', startLine: 33, endLine: 33 },
    ]);
    expect(res.changed.map((c) => c.symbol.name).sort()).toEqual(['alpha', 'beta']);
    const shared = res.dependants.find((d) => d.symbol.name === 'shared');
    expect(shared).toBeDefined();
    // The whole point: one row, not one per changed symbol.
    expect(res.dependants.filter((d) => d.symbol.name === 'shared')).toHaveLength(1);
    expect(shared!.viaSeeds).toHaveLength(2);
    // onlyAlpha reaches only one seed, so it stays single-tagged.
    expect(res.dependants.find((d) => d.symbol.name === 'onlyAlpha')!.viaSeeds).toHaveLength(1);
  });

  it('lists the files a reviewer has to re-check', async () => {
    const res = await diffImpact(store, [{ path: 'core.rs', startLine: 12, endLine: 12 }]);
    expect(res.affectedFiles).toContain('shared.rs');
    expect(res.affectedFiles).toContain('onlyalpha.rs');
    // The changed file itself is not a "re-check" item.
    expect(res.affectedFiles).not.toContain('core.rs');
  });

  it('returns no dependants for a change nothing references', async () => {
    const res = await diffImpact(store, [{ path: 'shared.rs', startLine: 7, endLine: 7 }]);
    expect(res.changed.map((c) => c.symbol.name)).toEqual(['shared']);
    expect(res.dependants).toEqual([]);
    expect(res.unattributed).toEqual([]);
  });

  describe('module symbol spanning the whole file (production shape)', () => {
    let wideStore: SqliteCodeStore;
    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-diff-wide-'));
      wideStore = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
      // The module symbol spans the entire file, as extractorImpl.ts really
      // produces it (endLine = last line of the source), not line 1 only.
      await wideStore.applyExtraction({
        path: 'wide.rs',
        lang: 'rust',
        mtimeMs: 1,
        size: 1,
        hash: 'h-wide.rs',
        crate: null,
        parseError: false,
        symbols: [sym('wide.rs', 'wide.rs', 1, 50, 'module'), sym('gamma', 'gamma', 10, 20)],
        refs: [],
        uses: [],
      });
      await wideStore.resolvePending(undefined, { retireUnresolved: true });
    });

    it('attributes a hunk inside a function to the function only, not also the whole-file module symbol', async () => {
      const { changed } = await resolveChangedSymbols(wideStore, [{ path: 'wide.rs', startLine: 12, endLine: 13 }]);
      expect(changed.map((c) => c.symbol.name)).toEqual(['gamma']);
    });

    it('falls back to the module symbol for a hunk outside every function', async () => {
      const { changed, unattributed } = await resolveChangedSymbols(wideStore, [{ path: 'wide.rs', startLine: 2, endLine: 2 }]);
      expect(changed.map((c) => c.symbol.name)).toEqual(['wide.rs']);
      expect(unattributed).toEqual([]);
    });
  });
});
