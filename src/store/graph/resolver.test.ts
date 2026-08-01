/**
 * Resolver-ladder contract, against a real Kuzu database in a temp dir.
 *
 * These assertions are the S1 precision fix (plan.md): they encode *which*
 * confidence a ref earns, which is the difference between a graph an agent can
 * trust and one it can't. A fake store would only test the fake, since the
 * ladder is Cypher.
 *
 * Stores are never closed — kuzu 0.11.3 segfaults on db.close()
 * (spikes/s2-kuzu-concurrency.mjs). Temp dirs are left to the OS.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KuzuCodeStore } from './codeStoreImpl';
import { nodeKuzuDriver } from './kuzuDriver';
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

describe('resolveOneRef ladder', () => {
  let store: CodeStore;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-resolver-'));
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);

    // Two workspace types with a same-named `new`, plus a uniquely-named free fn.
    await store.applyExtraction(
      extraction('shapes.rs', [sym('Circle', 'Circle', 'struct'), sym('new', 'Circle::new'), sym('Square', 'Square', 'struct'), sym('new', 'Square::new')])
    );
    await store.applyExtraction(extraction('util.rs', [sym('helper', 'helper', 'function')]));
  });

  /** Confidence of the single CALLS edge out of `file`, or 'unresolved'. */
  async function confidenceOf(file: string, ref: RawRef): Promise<EdgeConfidence | 'unresolved'> {
    await store.applyExtraction(extraction(file, [], [ref]));
    const rows = await store.query(
      `MATCH (a:Symbol)-[e:CALLS]->(b:Symbol) WHERE a.qualified = '${file}' RETURN e.confidence AS conf`
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

  // R1 leak fix: a bare METHOD call (`x.helper()`) is capped at fuzzy even
  // when only one workspace symbol shares the name — the receiver's type is
  // unknown and the true target is often a derive impl / stdlib method not in
  // the graph at all. On ripgrep, `.clone()` in globset resolved "confirmed"
  // onto ignore's `Error::clone`, leaking 207 false confirmed layering
  // violations into `pairs check`.
  it('caps a bare method call at fuzzy even with a unique name match', async () => {
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
      `MATCH (a:Symbol)-[e:CALLS]->(b:Symbol) WHERE a.qualified = 'crates/alpha/src/main.rs' RETURN e.confidence AS conf`
    );
    expect(String(noUse[0]!.conf)).toBe('fuzzy');
    // Same call WITH `use beta::Widget` → corroborated, stays resolved.
    await store.applyExtraction(
      extraction('crates/alpha/src/other.rs', [], [call('spawn', 'Widget::spawn')], [use_('beta::Widget')])
    );
    const withUse = await store.query(
      `MATCH (a:Symbol)-[e:CALLS]->(b:Symbol) WHERE a.qualified = 'crates/alpha/src/other.rs' RETURN e.confidence AS conf`
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
});

describe('stats precision buckets', () => {
  it('counts a qualified external call as external, not a resolvable miss', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-stats-'));
    const store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
    await store.applyExtraction(extraction('shapes.rs', [sym('Circle', 'Circle', 'struct'), sym('new', 'Circle::new')]));
    // `Vec::new` is glam/std. The workspace having *a* `new` must not make it
    // look like a miss the resolver should have caught.
    await store.applyExtraction(extraction('use.rs', [], [call('new', 'Vec::new')]));

    const stats = await store.stats();
    expect(stats.resolvableMisses).toBe(0);
    expect(stats.externalRefs).toBe(1);
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
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
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
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
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

describe('use statements create cross-file DEPENDS_ON edges', () => {
  // Regression: for Rust, DEPENDS_ON was never populated (rust.scm captures
  // `use` as an import specifier, not a @ref.reference), leaving module_map /
  // file_deps / analyze(cycles) silently empty on every Rust corpus. `use`
  // specifiers now resolve into DEPENDS_ON edges from the importing file's
  // module symbol to the imported symbol.
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-depends-'));
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
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
      `MATCH (a:Symbol)-[e:DEPENDS_ON]->(b:Symbol) WHERE a.file <> b.file RETURN a.file AS af, b.file AS bf, e.line AS line`
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
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
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
      `MATCH (a:Symbol)-[e:DEPENDS_ON]->(b:Symbol) WHERE a.file <> b.file RETURN a.file AS af, b.file AS bf, e.line AS line ORDER BY af`
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

describe('in-memory symbol mirror stays consistent across re-apply and remove', () => {
  // applyExtraction patches the loaded mirror in place instead of rebuilding
  // it from Kuzu per file (the rebuild made fullIndex O(files × symbols)).
  // These pin that the patched mirror resolves identically to a fresh one.
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-mirror-'));
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
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
      `MATCH (:Symbol {name: 'caller2.rs'})-[:CALLS]->(b:Symbol) RETURN b.name AS name`
    );
    expect(edges.map((r) => r.name)).toEqual(['beta']);
    // Two claims on the vanished alpha: caller.rs's old edge re-parked when
    // a.rs was re-applied (R7 — referrers keep their claim), plus caller2's
    // fresh unresolved ref.
    const pend = await store.query(`MATCH (p:PendingRef {name: 'alpha'}) RETURN p.name AS name`);
    expect(pend).toHaveLength(2);
  });

  it('removeFile drops the file from the mirror', async () => {
    await store.removeFile('a.rs');
    await store.applyExtraction(extraction('caller3.rs', [sym('c3', 'c3', 'function')], [call('beta', null)]));
    const edges = await store.query(`MATCH (:Symbol {name: 'caller3.rs'})-[:CALLS]->(b:Symbol) RETURN b.name AS name`);
    expect(edges).toHaveLength(0); // beta gone → parked as pending, not resolved via stale mirror
  });
});
