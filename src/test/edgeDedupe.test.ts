/**
 * Task 1 regression tests: Edge has a unique (src,dst,kind,line) constraint,
 * and nothing upstream of it can emit a duplicate row — not a re-index of the
 * same file, not repeated resolvePending calls over the same parked ref, and
 * a fuzzy hit must never survive alongside (or instead of) a resolved one for
 * the same site.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteCodeStore } from '../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../store/graph/sqliteDriver';
import type { CodeStore } from '../store/graph/codeStore';
import type { FileExtraction, NewSymbol, RawRef } from '../core/indexer/types';

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'method'): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 1, endLine: 1, signature: null, doc: null, exported: true, parentIndex: null };
}

function extraction(pathName: string, symbols: NewSymbol[], refs: RawRef[] = [], uses: FileExtraction['uses'] = []): FileExtraction {
  return {
    path: pathName,
    lang: 'rust',
    mtimeMs: 1,
    size: 1,
    hash: `hash-${pathName}`,
    crate: null,
    parseError: false,
    symbols: [sym(pathName, pathName, 'module'), ...symbols],
    refs,
    uses,
  };
}

/** Bare (unqualified) call — matches the resolver's bare-name ladder rungs. */
function call(name: string, line = 7): RawRef {
  return { fromIndex: 0, name, qualifiedName: null, kind: 'CALLS', line };
}

async function dupGap(store: CodeStore): Promise<number> {
  const rows = await store.query(`SELECT COUNT(*) total, COUNT(DISTINCT src||'|'||dst||'|'||kind||'|'||line) d FROM Edge`);
  const row = rows[0]!;
  return Number(row.total) - Number(row.d);
}

describe('Edge dedupe (Task 1)', () => {
  let store: CodeStore;
  let dbPath: string;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-edgededupe-'));
    dbPath = path.join(dir, 'graph.db');
    store = await SqliteCodeStore.open(dbPath, nodeSqlDriver);
  });

  it('re-indexing the same file without --rebuild produces no duplicate (src,dst,kind,line) rows', async () => {
    await store.applyExtraction(extraction('lib.rs', [sym('helper', 'helper', 'function')]));
    await store.applyExtraction(extraction('caller.rs', [sym('doIt', 'doIt', 'function')], [call('helper')]));

    // Re-index caller.rs again (simulates an incremental re-index, not --rebuild).
    await store.applyExtraction(extraction('caller.rs', [sym('doIt', 'doIt', 'function')], [call('helper')]));

    expect(await dupGap(store)).toBe(0);
  });

  it('a ref that parks and later resolves produces exactly one edge across repeated resolvePending calls', async () => {
    // park.rs refers to a symbol ('later') that does not exist yet, so the ref parks.
    await store.applyExtraction(extraction('park.rs', [sym('user', 'user', 'function')], [call('later', 77)]));

    let rows = await store.query(`SELECT COUNT(*) n FROM Edge WHERE kind='CALLS' AND line=77`);
    expect(Number(rows[0]!.n)).toBe(0);

    // Now the target appears; resolvePending should resolve and create the edge.
    await store.applyExtraction(extraction('later.rs', [sym('later', 'later', 'function')]));
    const created1 = await store.resolvePending();
    expect(created1).toBeGreaterThan(0);

    rows = await store.query(`SELECT COUNT(*) n FROM Edge WHERE kind='CALLS' AND line=77`);
    const countAfterFirst = Number(rows[0]!.n);
    expect(countAfterFirst).toBe(1);

    // Calling resolvePending again (e.g. a second incremental pass) must not
    // create a second edge for the same site — the PendingRef row is gone,
    // but this guards the mechanism even if a stray park recurs.
    const created2 = await store.resolvePending();
    expect(created2).toBe(0);

    rows = await store.query(`SELECT COUNT(*) n FROM Edge WHERE kind='CALLS' AND line=77`);
    expect(Number(rows[0]!.n)).toBe(countAfterFirst);
    expect(await dupGap(store)).toBe(0);
  });

  it('when the same (src,dst,kind,line) is reachable as both fuzzy and resolved, the surviving row is resolved', async () => {
    // A parked ref that will resolve to a unique bare-name target -> 'resolved'.
    // `call()`'s fromIndex is 0, i.e. the file's implicit module symbol (see
    // `extraction()` above) — so the edge's src is the module symbol, not a
    // named function in the file.
    await store.applyExtraction(extraction('collide-caller.rs', [sym('collideUser', 'collideUser', 'function')], [call('collideTarget', 500)]));
    const callerRows = await store.query(`SELECT id FROM Symbol WHERE qualified='collide-caller.rs'`);
    const fromId = Number(callerRows[0]!.id);

    await store.applyExtraction(extraction('collide-target.rs', [sym('collideTarget', 'collideTarget', 'function')]));
    const targetRows = await store.query(`SELECT id FROM Symbol WHERE qualified='collideTarget'`);
    const toId = Number(targetRows[0]!.id);

    // Simulate a fuzzy row already sitting at the EXACT same site (src,dst,kind,line)
    // from an earlier pass, via a second raw connection to the same db file.
    const raw = nodeSqlDriver.open(dbPath);
    try {
      raw.prepare(`INSERT OR IGNORE INTO Edge(src, dst, kind, line, confidence, test) VALUES(?,?,?,?,?,?)`).run(fromId, toId, 'CALLS', 500, 'fuzzy', 0);
    } finally {
      raw.close();
    }
    let rows = await store.query(`SELECT confidence FROM Edge WHERE kind='CALLS' AND line=500 AND src=${fromId} AND dst=${toId}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.confidence).toBe('fuzzy');

    // resolvePending resolves the parked ref to the SAME (fromId,toId,'CALLS',500)
    // key as 'resolved'. OR IGNORE alone would lose to the fuzzy row already on
    // disk; the backstop UPDATE (which runs whenever this pass has work) must
    // promote it in place.
    await store.resolvePending();

    rows = await store.query(`SELECT confidence, COUNT(*) n FROM Edge WHERE kind='CALLS' AND line=500 AND src=${fromId} AND dst=${toId} GROUP BY confidence`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.confidence).toBe('resolved');
    expect(await dupGap(store)).toBe(0);
  });
});
