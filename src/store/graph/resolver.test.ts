/**
 * Resolver-ladder contract, against a real SQLite database in a temp dir.
 *
 * These assertions are the S1 precision fix: they encode *which*
 * confidence a ref earns, which is the difference between a graph an agent can
 * trust and one it can't. A fake store would only test the fake, since the
 * ladder is SQL.
 *
 * Temp dirs are left to the OS.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteCodeStore } from './sqliteCodeStore';
import { nodeSqlDriver } from './sqliteDriver';
import type { CodeStore } from './codeStore';
import type { EdgeConfidence, FileExtraction, NewSymbol, RawRef, SymbolRecord } from '../../core/indexer/types';
import { impact } from '../../core/analyze/impact';
import { moduleMap } from '../../core/analyze/moduleMap';

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'method'): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 1, endLine: 1, signature: null, doc: null, exported: true, parentIndex: null };
}

/** symbols[0] is the implicit module symbol, mirroring the extractor. */
function extraction(pathName: string, symbols: NewSymbol[], refs: RawRef[] = [], uses: FileExtraction['uses'] = []): FileExtraction {
  return {
    path: pathName,
    lang: 'rust',
    mtimeMs: 1,
    size: 1,
    hash: `hash-${pathName}-${Math.random()}`,
    crate: null,
    parseError: false,
    symbols: [sym(pathName, pathName, 'module'), ...symbols],
    refs,
    uses,
  };
}

function use_(specifier: string, line = 1): FileExtraction['uses'][number] {
  return { specifier, boundNames: [specifier.split('::').pop()!], isGlob: false, line };
}

function call(name: string, qualifiedName: string | null): RawRef {
  return { fromIndex: 0, name, qualifiedName, kind: 'CALLS', line: 1 };
}

/**
 * A `this.name()`/`self.name()` call from method `fromIndex`. `name` is the
 * bare method name, matching what the extractor's stripReceiver/bareRefName
 * already produce by the time a RawRef reaches the store.
 */
function selfCall(name: string, fromIndex: number): RawRef {
  return { fromIndex, name, qualifiedName: null, kind: 'CALLS', line: 1, methodCall: true, selfReceiver: true };
}

/** A `x.name()` call whose receiver `x` has a written declared type (Step 2.3, TS only). */
function typedReceiverCall(name: string, receiverType: string): RawRef {
  return { fromIndex: 0, name, qualifiedName: null, kind: 'CALLS', line: 1, methodCall: true, receiverType };
}

describe('resolveOneRef ladder', () => {
  let store: CodeStore;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-resolver-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);

    // Two workspace types with a same-named `new`, plus a uniquely-named free fn.
    await store.applyExtraction(
      extraction('shapes.rs', [sym('Circle', 'Circle', 'struct'), sym('new', 'Circle::new'), sym('Square', 'Square', 'struct'), sym('new', 'Square::new')])
    );
    await store.applyExtraction(extraction('util.rs', [sym('helper', 'helper', 'function')]));
  });

  /**
   * Confidence of the single CALLS edge out of `file`, or 'unresolved'.
   * Follows applyExtraction with a resolvePending pass: a plain method call
   * always parks during applyExtraction's inline resolve now (fullPass is
   * only true for resolvePending — see resolveOneRef), since full-index runs
   * files in parallel and "unique/known workspace-wide" is unreliable until
   * every file has declared. These tests set up the rest of the workspace in
   * beforeAll, so by the time resolvePending runs here everything relevant is
   * already known — the same shape a real fullIndex always resolves through.
   */
  async function confidenceOf(file: string, ref: RawRef): Promise<EdgeConfidence | 'unresolved'> {
    await store.applyExtraction(extraction(file, [], [ref]));
    await store.resolvePending();
    const rows = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src WHERE e.kind = 'CALLS' AND a.qualified = '${file}'`
    );
    return rows.length === 0 ? 'unresolved' : (String(rows[0]!.conf) as EdgeConfidence);
  }

  it('resolves a qualified call to the one type that declares it', async () => {
    expect(await confidenceOf('a.rs', call('new', 'Circle::new'))).toBe('resolved');
  });

  it('resolves a unique bare name', async () => {
    expect(await confidenceOf('b.rs', call('helper', null))).toBe('resolved');
  });

  it('marks an ambiguous bare name fuzzy', async () => {
    // Bare `new` genuinely could be either Circle::new or Square::new.
    expect(await confidenceOf('c.rs', call('new', null))).toBe('fuzzy');
  });

  // The S1 fix: a qualifier is a constraint, not a hint. `Vec3::new` is a call
  // into glam, not a fuzzy guess across every workspace `new` — treating it as
  // one produced ~1,000 of 1,833 bogus fuzzy edges on the ARES sample.
  it('reports a call through an unknown qualifier as unresolved, not fuzzy', async () => {
    expect(await confidenceOf('d.rs', call('new', 'Vec3::new'))).toBe('unresolved');
  });

  // Step 2.1: a bare METHOD call (`x.helper()`) resolves when its one
  // candidate's name is unique across the whole workspace — no other symbol
  // anywhere shares the name, so the receiver's unknown type cannot steer
  // the call onto a different target. This does reopen part of the R1 leak
  // (a common name like `.clone()` that happens to be workspace-unique would
  // also resolve here) — accepted per Step 2.1, and guarded against
  // regressing by the real-corpus fuzzy-rate ratchet in precision.test.ts
  // rather than a name blocklist.
  it('resolves a bare method call when its one candidate is unique workspace-wide', async () => {
    await store.applyExtraction(extraction('m.rs', [sym('helper', 'helper', 'function')]));
    expect(await confidenceOf('m.rs', { ...call('helper', null), methodCall: true })).toBe('resolved');
  });

  // Still capped when more than one workspace symbol shares the bare name —
  // uniqueness, not the presence of a candidate, is what justifies trust.
  it('caps a bare method call at fuzzy when the name is not unique workspace-wide', async () => {
    await store.applyExtraction(extraction('other.rs', [sym('helper', 'Other::helper')]));
    expect(await confidenceOf('m.rs', { ...call('helper', null), methodCall: true })).toBe('fuzzy');
  });

  // Cross-crate gate: same-named symbols in sibling Cargo crates must not
  // resolve "confirmed" onto each other without a corroborating `use`. On
  // ripgrep, `Parser::new` in grep-regex resolved confirmed onto core's
  // flag Parser (a different crate) — a false confirmed layering violation.
  it('downgrades an uncorroborated cross-crate resolution to fuzzy', async () => {
    await store.applyExtraction(
      extraction('crates/beta/src/lib.rs', [sym('Widget', 'Widget', 'struct'), sym('spawn', 'Widget::spawn')])
    );
    // Caller in a DIFFERENT crate, no `use` naming Widget → fuzzy.
    await store.applyExtraction(extraction('crates/alpha/src/main.rs', [], [call('spawn', 'Widget::spawn')]));
    const noUse = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src WHERE e.kind = 'CALLS' AND a.qualified = 'crates/alpha/src/main.rs'`
    );
    expect(String(noUse[0]!.conf)).toBe('fuzzy');
    // Same call WITH `use beta::Widget` → corroborated, stays resolved.
    await store.applyExtraction(
      extraction('crates/alpha/src/other.rs', [], [call('spawn', 'Widget::spawn')], [use_('beta::Widget')])
    );
    const withUse = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src WHERE e.kind = 'CALLS' AND a.qualified = 'crates/alpha/src/other.rs'`
    );
    expect(String(withUse[0]!.conf)).toBe('resolved');
  });

  it('resolves a qualified call whose declaration is stored under a longer path', async () => {
    await store.applyExtraction(extraction('deep.rs', [sym('Inner', 'outer::Inner', 'struct'), sym('build', 'outer::Inner::build')]));
    expect(await confidenceOf('e.rs', call('build', 'Inner::build'))).toBe('resolved');
  });

  // A free fn called by absolute path: `qualified` is bare (`load_map`) because
  // the module lives in the file path, so only the module→file correspondence
  // can connect the two.
  it('resolves an absolute crate path via the module’s file', async () => {
    await store.applyExtraction(extraction('src/map/loader.rs', [sym('load_map', 'load_map', 'function')]));
    expect(await confidenceOf('f.rs', call('load_map', 'crate::map::loader::load_map'))).toBe('resolved');
  });

  it('does not let a module path match a same-named fn in another module', async () => {
    await store.applyExtraction(extraction('src/audio/mixer.rs', [sym('reset', 'reset', 'function')]));
    // `crate::video::reset` names no workspace module declaring `reset`.
    expect(await confidenceOf('g.rs', call('reset', 'crate::video::reset'))).toBe('unresolved');
  });

  // Same-file shadowing: a bare ref in a file that declares `name` binds to
  // that local declaration. Lexical scope beats any workspace namesake, so the
  // global ladder must not run at all.
  //
  // Before this rung, a file-local `main()` fanned out to EVERY workspace
  // `main` — in this repo v3BenchCli.ts:44 got three CALLS edges (scripts/,
  // adapters/cli, and its own), and `pairs check` reported the cross-module
  // phantoms as layering violations. Same shape for a callback parameter
  // named `pick` in analyze/hierarchy.ts.
  it('binds a bare call to the calling file’s own declaration, not a namesake', async () => {
    await store.applyExtraction(extraction('scripts/tool.rs', [sym('main', 'main', 'function')]));
    await store.applyExtraction(
      extraction('src/bench/cli.rs', [sym('main', 'main', 'function')], [call('main', null)])
    );
    const rows = await store.query(
      `SELECT b.file AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'src/bench/cli.rs'`
    );
    // Exactly one edge, to itself, confirmed — no cross-module phantom.
    expect(rows.map((r) => String(r.dst))).toEqual(['src/bench/cli.rs']);
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  // The shadowing rung must not swallow the method-call cap: there the
  // receiver's static type is unknown, so a same-file namesake is coincidence
  // rather than lexical scope. It still falls through to the ordinary
  // (Step 2.1 gated) ladder, so a same-file name that is also unique
  // workspace-wide resolves there rather than staying fuzzy.
  it('does not resolve a same-file method call via the shadowing rung, but the ordinary ladder still can', async () => {
    await store.applyExtraction(
      extraction('src/recv.rs', [sym('flush', 'Buf::flush')], [{ ...call('flush', null), methodCall: true }])
    );
    await store.resolvePending();
    const rows = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src
       WHERE e.kind = 'CALLS' AND a.qualified = 'src/recv.rs'`
    );
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  // Same-file method call whose name is NOT unique workspace-wide: the
  // shadowing rung is skipped (methodCall excludes it) and the ordinary
  // ladder's Step 2.1 gate caps it at fuzzy since more than one workspace
  // symbol shares the name.
  it('caps a same-file method call at fuzzy when the name is not unique workspace-wide', async () => {
    await store.applyExtraction(extraction('other.rs', [sym('flush', 'Other::flush')]));
    await store.applyExtraction(
      extraction('src/recv.rs', [sym('flush', 'Buf::flush')], [{ ...call('flush', null), methodCall: true }])
    );
    await store.resolvePending();
    const rows = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src
       WHERE e.kind = 'CALLS' AND a.qualified = 'src/recv.rs'`
    );
    expect(String(rows[0]!.conf)).toBe('fuzzy');
  });

  // Rung 0: `this.helper()` inside a class that declares exactly one `helper`
  // — the receiver's type is known (the enclosing scope), so this is a
  // verified target, not a name-match guess.
  it('resolves a this.helper() call to the enclosing class’s own method', async () => {
    const callerSym = sym('greet', 'Greeter.greet', 'method');
    await store.applyExtraction(
      extraction('src/greeter.ts', [sym('Greeter', 'Greeter', 'class'), sym('helper', 'Greeter.helper', 'method'), callerSym], [selfCall('helper', 3)])
    );
    const rows = await store.query(
      `SELECT b.qualified AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'Greeter.greet'`
    );
    expect(rows.map((r) => String(r.dst))).toEqual(['Greeter.helper']);
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  // No `helper` on the caller's own class: falls through to the ordinary
  // ladder rather than reaching for an unrelated class's same-named method.
  it('falls through to fuzzy when the enclosing class has no matching method', async () => {
    await store.applyExtraction(extraction('src/other.ts', [sym('Other', 'Other', 'class'), sym('helper', 'Other.helper', 'method')]));
    const callerSym = sym('greet', 'Lonely.greet', 'method');
    await store.applyExtraction(extraction('src/lonely.ts', [sym('Lonely', 'Lonely', 'class'), callerSym], [selfCall('helper', 2)]));
    await store.resolvePending();
    const rows = await store.query(
      `SELECT b.qualified AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'Lonely.greet'`
    );
    expect(String(rows[0]!.conf)).toBe('fuzzy');
    expect(rows.map((r) => String(r.dst))).not.toContain('Other.helper');
  });

  // Regression guard for the whole task: a non-self receiver must still cap
  // at fuzzy. If this fails, the cap has been broadened, not narrowed.
  it('still caps a plain x.helper() (non-self receiver) at fuzzy', async () => {
    await store.applyExtraction(
      extraction('src/plain.ts', [], [{ ...call('helper', null), methodCall: true, selfReceiver: false }])
    );
    await store.resolvePending();
    const rows = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src WHERE e.kind = 'CALLS' AND a.qualified = 'src/plain.ts'`
    );
    expect(String(rows[0]!.conf)).toBe('fuzzy');
  });

  // Rust form: `self.helper()` inside an `impl Greeter` block.
  it('resolves self.helper() inside an impl block to Greeter::helper', async () => {
    const callerSym = sym('greet', 'Greeter::greet', 'method');
    await store.applyExtraction(
      extraction('src/greeter.rs', [sym('Greeter', 'Greeter', 'struct'), sym('helper', 'Greeter::helper', 'method'), callerSym], [selfCall('helper', 3)])
    );
    const rows = await store.query(
      `SELECT b.qualified AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'Greeter::greet'`
    );
    expect(rows.map((r) => String(r.dst))).toEqual(['Greeter::helper']);
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  // Step 2.3: a method call whose receiver has a declared type resolves to
  // that type's own member, even though `render` is not unique workspace-wide
  // (a same-named method exists on an unrelated type) — the Step 2.1
  // workspace-uniqueness gate alone could not resolve this case.
  it('resolves a typed-receiver method call to that type’s own member, even when the name is not workspace-unique', async () => {
    await store.applyExtraction(
      extraction('src/other-widget.ts', [sym('OtherWidget', 'OtherWidget', 'class'), sym('render', 'OtherWidget.render', 'method')])
    );
    await store.applyExtraction(
      extraction('src/widget.ts', [sym('Widget', 'Widget', 'class'), sym('render', 'Widget.render', 'method')])
    );
    await store.applyExtraction(extraction('src/app.ts', [], [typedReceiverCall('render', 'Widget')]));
    await store.resolvePending();
    const rows = await store.query(
      `SELECT b.qualified AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'src/app.ts'`
    );
    expect(rows.map((r) => String(r.dst))).toEqual(['Widget.render']);
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  // No member by that name on the declared type: falls through to the
  // ordinary (capped) ladder rather than treating the annotation as proof of
  // an edge that doesn't exist.
  it('falls through to the ordinary ladder when the declared type has no matching member', async () => {
    await store.applyExtraction(extraction('src/empty.ts', [sym('Empty', 'Empty', 'class')]));
    await store.applyExtraction(extraction('src/app2.ts', [], [typedReceiverCall('missing', 'Empty')]));
    await store.resolvePending();
    const rows = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src WHERE e.kind = 'CALLS' AND a.qualified = 'src/app2.ts'`
    );
    // No workspace symbol named `missing` at all → unresolved (parked), not an edge.
    expect(rows.length).toBe(0);
  });
});

describe('stats precision buckets', () => {
  it('counts a qualified external call as external, not a resolvable miss', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-stats-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    await store.applyExtraction(extraction('shapes.rs', [sym('Circle', 'Circle', 'struct'), sym('new', 'Circle::new')]));
    // `Vec::new` is glam/std. The workspace having *a* `new` must not make it
    // look like a miss the resolver should have caught.
    await store.applyExtraction(extraction('use.rs', [], [call('new', 'Vec::new')]));

    const stats = await store.stats();
    expect(stats.resolvableMisses).toBe(0);
    expect(stats.externalRefs).toBe(1);
  });

  it('resolvableMisses stays non-zero after retiring unresolved refs (Task 2)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-stats-retired-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    // A defines `helper`, which B also happens to bind from an external
    // package — so the bare `helper` ref in B is guarded to 'unresolved' by
    // the external-name rung, even though the workspace does define a
    // same-named symbol elsewhere. That guard makes it a genuine resolver
    // miss once retired, not an external ref.
    await store.applyExtraction(extraction('a.rs', [sym('helper', 'helper')]));
    await store.applyExtraction(
      extraction(
        'b.rs',
        [],
        [call('helper', null), call('trulyMissing', null)],
        [{ specifier: 'somepkg', boundNames: ['helper'], isGlob: false, line: 1 }]
      )
    );

    await store.resolvePending(undefined, { retireUnresolved: true });
    const stats = await store.stats();
    expect(stats.resolvableMisses).toBeGreaterThan(0);
  });

  it('a purely external ref (no workspace definition) does not count as a miss', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-stats-external-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    await store.applyExtraction(extraction('a.rs', [sym('helper', 'helper')]));
    await store.applyExtraction(extraction('b.rs', [], [call('trulyMissing', null)]));

    await store.resolvePending(undefined, { retireUnresolved: true });
    const stats = await store.stats();
    expect(stats.resolvableMisses).toBe(0);
  });
});

// Regression: `RETURN s.*` returns keys prefixed with the node variable
// (`s.id`, `s.name`, …), but the row→record mappers read bare keys. That made
// get/lookup/outline/listFiles silently return all-null records — every field
// null, `Number(undefined)` → NaN — which then poisoned any id-based query
// downstream (impact's edgesTo bound `Variable NaN`). These pin the mapped
// values so a reader can never regress to null again.
describe('row mappers read node-prefixed columns', () => {
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-readers-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    await store.applyExtraction(extraction('svc.rs', [sym('login', 'auth::login', 'function')]));
  });

  it('lookup returns a fully-populated record, not null fields', async () => {
    const hit = await store.lookup('auth::login');
    expect(Array.isArray(hit)).toBe(true);
    const rec = (hit as SymbolRecord[])[0]!;
    expect(rec.name).toBe('login');
    expect(rec.qualified).toBe('auth::login');
    expect(rec.file).toBe('svc.rs');
    expect(Number.isNaN(rec.id)).toBe(false);
    expect(rec.id).toBeGreaterThan(0);
  });

  it('get(id) round-trips the same record', async () => {
    const hit = (await store.lookup('auth::login')) as SymbolRecord[];
    const got = await store.get(hit[0]!.id);
    expect(got?.name).toBe('login');
    expect(got?.qualified).toBe('auth::login');
  });

  it('outline and listFiles return real values', async () => {
    const outline = await store.outline('svc.rs');
    expect(outline.some((s) => s.name === 'login')).toBe(true);
    const files = await store.listFiles();
    const f = files.find((r) => r.path === 'svc.rs');
    expect(f).toBeDefined();
    expect(f!.hash).toMatch(/^hash-svc\.rs-/);
    expect(Number.isNaN(f!.id)).toBe(false);
  });
});

describe('impact() transitive dependants', () => {
  let store: CodeStore;
  let coreId: number;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-impact-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    // core <- mid <- top  (top calls mid, mid calls core); free functions.
    // The ref must originate from the *function* (symbols[1]), not the module
    // (symbols[0]), so the CALLS edge chains function→function like real code.
    const fromFn = (name: string, qualifiedName: string | null): RawRef => ({ fromIndex: 1, name, qualifiedName, kind: 'CALLS', line: 1 });
    await store.applyExtraction(extraction('core.rs', [sym('core', 'core', 'function')]));
    await store.applyExtraction(extraction('mid.rs', [sym('mid', 'mid', 'function')], [fromFn('core', null)]));
    await store.applyExtraction(extraction('top.rs', [sym('top', 'top', 'function')], [fromFn('mid', null)]));
    const hit = (await store.lookup('core')) as SymbolRecord[];
    coreId = hit[0]!.id;
  });

  it('walks who-depends-on transitively, tagged by depth', async () => {
    const res = (await impact(store, coreId, 5))!;
    expect(res.seed.name).toBe('core');
    const byName = new Map(res.dependants.map((d) => [d.symbol.name, d.depth]));
    expect(byName.get('mid')).toBe(1);
    expect(byName.get('top')).toBe(2);
  });

  it('respects maxDepth and marks truncation', async () => {
    const res = (await impact(store, coreId, 1))!;
    expect(res.dependants.map((d) => d.symbol.name)).toEqual(['mid']);
    expect(res.truncated).toBe(true);
  });

  it('returns null for an unknown id', async () => {
    expect(await impact(store, 999999, 5)).toBeNull();
  });
});

describe('getMany() batch symbol fetch (Task 4)', () => {
  let store: CodeStore;
  let aId: number;
  let bId: number;
  let cId: number;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-getmany-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    await store.applyExtraction(extraction('gm-a.rs', [sym('gmA', 'gmA', 'function')]));
    await store.applyExtraction(extraction('gm-b.rs', [sym('gmB', 'gmB', 'function')]));
    await store.applyExtraction(extraction('gm-c.rs', [sym('gmC', 'gmC', 'function')]));
    aId = ((await store.lookup('gmA')) as SymbolRecord[])[0]!.id;
    bId = ((await store.lookup('gmB')) as SymbolRecord[])[0]!.id;
    cId = ((await store.lookup('gmC')) as SymbolRecord[])[0]!.id;
  });

  it('returns every requested id, keyed by id, regardless of query row order', async () => {
    const result = await store.getMany([cId, aId, bId]);
    expect(result.size).toBe(3);
    expect(result.get(aId)?.name).toBe('gmA');
    expect(result.get(bId)?.name).toBe('gmB');
    expect(result.get(cId)?.name).toBe('gmC');
  });

  it('omits ids that do not exist rather than erroring', async () => {
    const result = await store.getMany([aId, 999999]);
    expect(result.size).toBe(1);
    expect(result.has(999999)).toBe(false);
    expect(result.get(aId)?.name).toBe('gmA');
  });

  it('returns an empty map for an empty id list', async () => {
    const result = await store.getMany([]);
    expect(result.size).toBe(0);
  });

  it('chunks past the 999 SQLite host-parameter cap without erroring or dropping ids', async () => {
    // Only 3 real symbols are indexed, so pad with ids that don't exist —
    // this exercises the >500 chunking path (SQLITE_MAX_VARIABLE_NUMBER=999)
    // without needing 1500 real symbols in the fixture.
    const padded = [aId, bId, cId, ...Array.from({ length: 1500 }, (_, i) => 1_000_000 + i)];
    const result = await store.getMany(padded);
    expect(result.size).toBe(3);
    expect(result.get(aId)?.name).toBe('gmA');
    expect(result.get(bId)?.name).toBe('gmB');
    expect(result.get(cId)?.name).toBe('gmC');
  });
});

describe('use statements create cross-file DEPENDS_ON edges', () => {
  // Regression: for Rust, DEPENDS_ON was never populated (rust.scm captures
  // `use` as an import specifier, not a @ref.reference), leaving module_map /
  // file_deps / analyze(cycles) silently empty on every Rust corpus. `use`
  // specifiers now resolve into DEPENDS_ON edges from the importing file's
  // module symbol to the imported symbol.
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-depends-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    await store.applyExtraction(extraction('src/map/loader.rs', [sym('load_map', 'crate::map::loader::load_map', 'function')]));
    // consumer.rs imports load_map — a cross-file dependency.
    await store.applyExtraction(
      extraction('src/sim/driver.rs', [sym('drive', 'drive', 'function')], [], [use_('crate::map::loader::load_map', 7)])
    );
    // A glob import names no target and must not create an edge.
    await store.applyExtraction(
      extraction('src/glob.rs', [sym('g', 'g', 'function')], [], [{ specifier: 'crate::prelude', boundNames: [], isGlob: true, line: 1 }])
    );
  });

  it('links importer module → imported symbol at the use line', async () => {
    const rows = await store.query(
      `SELECT a.file AS af, b.file AS bf, e.line AS line FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'DEPENDS_ON' AND a.file <> b.file`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.af).toBe('src/sim/driver.rs');
    expect(rows[0]!.bf).toBe('src/map/loader.rs');
    expect(Number(rows[0]!.line)).toBe(7);
  });

  it('surfaces the dependency through fileEdges (file_deps tool path)', async () => {
    const importers = await store.fileEdges('src/map/loader.rs', 'importers', {});
    expect(importers.map((d) => d.path)).toContain('src/sim/driver.rs');
  });
});

describe('path-style imports create cross-file DEPENDS_ON edges', () => {
  // Regression: the `use` → DEPENDS_ON path split the specifier on `::` and
  // looked the tail up as a SYMBOL name. TypeScript/JS/Python specifiers are
  // file paths ('../store/codeStore'), which no symbol is named, so every
  // import parked in PendingRef forever — module_map reported zero modules on
  // any non-Rust repo. Path specifiers now resolve to the target file itself.
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-import-path-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    // Importer indexed FIRST: its target does not exist yet, so the edge must
    // come back through resolvePending (index order is arbitrary in practice).
    await store.applyExtraction(
      extraction('src/adapters/vscode/extension.ts', [sym('activate', 'activate', 'function')], [], [
        use_('../../store/graph/codeStore', 3),
        use_('vscode', 4), // external package: no workspace file, no edge
      ])
    );
    await store.applyExtraction(extraction('src/store/graph/codeStore.ts', [sym('CodeStore', 'CodeStore', 'class')]));
    // Directory entry point: './graph' means 'src/store/graph/index.ts'.
    await store.applyExtraction(extraction('src/store/graph/index.ts', [sym('open', 'open', 'function')]));
    await store.applyExtraction(
      extraction('src/core/tools/executors.ts', [sym('createExecutors', 'createExecutors', 'function')], [], [use_('../../store/graph', 1)])
    );
    await store.resolvePending();
  });

  it('links the importing file to the imported file, external packages aside', async () => {
    const rows = await store.query(
      `SELECT a.file AS af, b.file AS bf, e.line AS line FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'DEPENDS_ON' AND a.file <> b.file ORDER BY af`
    );
    expect(rows.map((r) => `${String(r.af)} -> ${String(r.bf)}`)).toEqual([
      'src/adapters/vscode/extension.ts -> src/store/graph/codeStore.ts',
      'src/core/tools/executors.ts -> src/store/graph/index.ts',
    ]);
    expect(Number(rows[0]!.line)).toBe(3);
  });

  it('feeds moduleMap, which is what went empty', async () => {
    const map = await moduleMap(store);
    expect(map.modules).toEqual(['src/adapters/vscode', 'src/core/tools', 'src/store/graph']);
    expect(map.edges).toHaveLength(2);
  });
});

describe('unreferenced() dead-code candidates (Task 6)', () => {
  let store: CodeStore;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-deadcode-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);

    // A genuinely dead top-level function: declared, never called.
    const deadFn: NewSymbol = { name: 'trulyDead', qualified: 'trulyDead', kind: 'function', lang: 'rust', startLine: 20, endLine: 22, signature: '()', doc: null, exported: false, parentIndex: null };
    // A private field, "used" only via `this.x` in real source — this
    // extractor emits no READS/WRITES edge for that, so it must never be
    // reported no matter how it's actually used.
    const privateField: NewSymbol = { name: 'cache', qualified: 'Widget.cache', kind: 'field', lang: 'rust', startLine: 5, endLine: 5, signature: null, doc: null, exported: false, parentIndex: null };
    // An interface used only as a type annotation — this extractor emits no
    // OF_TYPE/REFERENCES edge for that either, so it must not be flatly
    // reported as dead; it should survive with the type-only note instead.
    const typeOnlyInterface: NewSymbol = { name: 'Shape', qualified: 'Shape', kind: 'interface', lang: 'rust', startLine: 1, endLine: 3, signature: null, doc: null, exported: false, parentIndex: null };

    await store.applyExtraction(extraction('deadcode.rs', [deadFn, privateField, typeOnlyInterface]));
  });

  it('reports a genuinely-unreferenced top-level function', async () => {
    const candidates = await store.unreferenced({});
    const names = candidates.map((c) => c.symbol.name);
    expect(names).toContain('trulyDead');
  });

  it('does not report a private field even though it has zero reference edges', async () => {
    const candidates = await store.unreferenced({});
    const names = candidates.map((c) => c.symbol.name);
    expect(names).not.toContain('cache');
  });

  it('reports an interface used only as a type annotation, but qualified with a type-only note', async () => {
    const candidates = await store.unreferenced({});
    const shape = candidates.find((c) => c.symbol.name === 'Shape');
    expect(shape).toBeDefined();
    expect(shape!.note).toBe('type-only');
  });
});

describe('in-memory symbol mirror stays consistent across re-apply and remove', () => {
  // applyExtraction patches the loaded mirror in place instead of rebuilding
  // it from the database per file (the rebuild made fullIndex O(files × symbols)).
  // These pin that the patched mirror resolves identically to a fresh one.
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-mirror-'));
    store = await SqliteCodeStore.open(path.join(dir, 'graph.db'), nodeSqlDriver);
    await store.applyExtraction(extraction('a.rs', [sym('alpha', 'alpha', 'function')]));
    // Force the mirror to load by resolving through it.
    await store.applyExtraction(extraction('caller.rs', [sym('c', 'c', 'function')], [call('alpha', null)]));
  });

  it('re-applying a file swaps its old symbols out of the mirror', async () => {
    // a.rs now declares beta instead of alpha; a later call to alpha must
    // fall through to unresolved (stale mirror entry would resolve it).
    await store.applyExtraction(extraction('a.rs', [sym('beta', 'beta', 'function')]));
    await store.applyExtraction(extraction('caller2.rs', [sym('c2', 'c2', 'function')], [call('alpha', null), call('beta', null)]));
    const edges = await store.query(
      `SELECT b.name AS name FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'CALLS' AND a.name = 'caller2.rs'`
    );
    expect(edges.map((r) => r.name)).toEqual(['beta']);
    // Two claims on the vanished alpha: caller.rs's old edge re-parked when
    // a.rs was re-applied (R7 — referrers keep their claim), plus caller2's
    // fresh unresolved ref.
    const pend = await store.query(`SELECT name FROM PendingRef WHERE name = 'alpha'`);
    expect(pend).toHaveLength(2);
  });

  it('removeFile drops the file from the mirror', async () => {
    await store.removeFile('a.rs');
    await store.applyExtraction(extraction('caller3.rs', [sym('c3', 'c3', 'function')], [call('beta', null)]));
    const edges = await store.query(`SELECT b.name AS name FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'CALLS' AND a.name = 'caller3.rs'`);
    expect(edges).toHaveLength(0); // beta gone → parked as pending, not resolved via stale mirror
  });
});
