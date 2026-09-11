/**
 * Tool executor rendering, against a real SQLite store in a temp dir. These
 * pin the agent-facing text: the `file:line`
 * citation, the ambiguity prompt, and that impact/analyze reach the store.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import { createExecutors, type Executors } from './executors';
import { codeToolSchemas } from './tools';
import type { CodeStore } from '../../store/graph/codeStore';
import type { FileExtraction, NewSymbol, RawRef } from '../indexer/types';

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'function', doc: string | null = null): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 10, endLine: 12, signature: '()', doc, exported: true, parentIndex: null };
}
function ext(p: string, symbols: NewSymbol[], refs: RawRef[] = []): FileExtraction {
  return { path: p, lang: 'rust', mtimeMs: 1, size: 1, hash: `h-${p}-${Math.random()}`, crate: null, parseError: false, symbols: [sym(p, p, 'module'), ...symbols], refs, uses: [] };
}
const fromFn = (name: string, qualifiedName: string | null): RawRef => ({ fromIndex: 1, name, qualifiedName, kind: 'CALLS', line: 5 });

describe('tool executors', () => {
  let x: Executors;
  // Hoisted so the preview tests can build sibling executors over the same
  // fixture store with different readSource injections.
  let store: SqliteCodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-exec-'));
    store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    await store.applyExtraction(ext('core.rs', [sym('core', 'core')]));
    await store.applyExtraction(ext('mid.rs', [sym('mid', 'mid')], [fromFn('core', null)]));
    // Two same-named `login` to exercise the ambiguity path.
    await store.applyExtraction(ext('a.rs', [sym('login', 'auth::login')]));
    await store.applyExtraction(ext('b.rs', [sym('login', 'admin::login')]));
    // A doc-bearing symbol: `sym` defaults doc to null, and the preview tests
    // need one symbol whose doc line is actually renderable.
    await store.applyExtraction(ext('documented.rs', [sym('documented', 'documented', 'function', 'Explains itself.')]));
    // Base <- Sub via EXTENDS, for the hierarchy executor.
    await store.applyExtraction(ext('base.rs', [sym('Base', 'Base', 'class')]));
    await store.applyExtraction(
      ext('sub.rs', [sym('Sub', 'Sub', 'class')], [{ fromIndex: 1, name: 'Base', qualifiedName: null, kind: 'EXTENDS', line: 5 }])
    );
    x = createExecutors({ store });
  });

  it('find_symbol cites file:line', async () => {
    const out = await x.find_symbol({ name: 'core', limit: 20, offset: 0, preview: false });
    expect(out).toContain('core.rs:10');
    expect(out).toContain('[function]');
  });

  it('find_symbol without preview emits one line per hit and no continuation', async () => {
    const out = await x.find_symbol({ name: 'core', limit: 20, offset: 0, preview: false });
    expect(out.split('\n')[0]).toBe('1 definition(s) for "core":');
    expect(out.split('\n').length).toBe(2); // header + the single result line
    expect(out).toContain('  - core [function] ()  core.rs:10');
  });

  it('find_symbol with preview inlines the doc and the injected body lines', async () => {
    // sym() spans lines 10-12, so the stub must be at least 12 lines long for
    // lines.slice(9, 12) to land on real content.
    const body = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');
    const withRead = createExecutors({ store, readSource: () => body });
    const out = await withRead.find_symbol({ name: 'documented', limit: 20, offset: 0, preview: true });
    expect(out).toContain('      doc: Explains itself.');
    expect(out).toContain('      line10');
    expect(out).toContain('      line11');
    expect(out).toContain('      line12');
    // The span is exactly PREVIEW_MAX_LINES, so nothing is elided.
    expect(out).not.toContain('more line(s)');
  });

  it('find_symbol with preview and no readSource shows the doc only, without throwing', async () => {
    const out = await x.find_symbol({ name: 'documented', limit: 20, offset: 0, preview: true });
    expect(out).toContain('      doc: Explains itself.');
    expect(out).toContain('documented.rs:10');
    expect(out.split('\n').length).toBe(3); // header + hit + doc line, no body
  });

  it('find_symbol with preview degrades to the bare hit when the file is unreadable', async () => {
    const unreadable = createExecutors({ store, readSource: () => null });
    const out = await unreadable.find_symbol({ name: 'core', limit: 20, offset: 0, preview: true });
    // `core` has no doc and no readable file, so preview adds nothing at all.
    expect(out.split('\n').length).toBe(2);
    expect(out).toContain('core.rs:10');
  });

  it('find_symbol survives a readSource that throws', async () => {
    const throwing = createExecutors({
      store,
      readSource: () => {
        throw new Error('boom');
      },
    });
    const out = await throwing.find_symbol({ name: 'documented', limit: 20, offset: 0, preview: true });
    expect(out).toContain('documented.rs:10');
    expect(out).toContain('      doc: Explains itself.');
  });

  it('impact kinds:[CALLS] drops an EXTENDS-only dependant the unfiltered walk finds', async () => {
    const all = await x.impact({ name: 'Base', depth: 3, limit: 50, includeTests: true });
    expect(all).toContain('Sub');

    const callsOnly = await x.impact({ name: 'Base', depth: 3, limit: 50, includeTests: true, kinds: ['CALLS'] });
    expect(callsOnly).not.toContain('Sub');
    // An empty filtered result must never read as "safe to delete".
    expect(callsOnly).toContain('Nothing depends on');
    expect(callsOnly).toContain('via CALLS only');
  });

  it('impact kinds:[CALLS] keeps a real CALLS dependant and states the restriction', async () => {
    const out = await x.impact({ name: 'core', depth: 3, limit: 50, includeTests: true, kinds: ['CALLS'] });
    expect(out).toContain('mid');
    expect(out).toContain('dependant(s) via CALLS only of core');
  });

  it('impact kinds:[] means unrestricted, not "no dependants"', async () => {
    const unfiltered = await x.impact({ name: 'core', depth: 3, limit: 50, includeTests: true });
    const emptyKinds = await x.impact({ name: 'core', depth: 3, limit: 50, includeTests: true, kinds: [] });
    expect(emptyKinds).toBe(unfiltered);
    expect(emptyKinds).not.toContain('Nothing depends on');
  });

  it('impact reaches transitive callers', async () => {
    const out = await x.impact({ name: 'core', depth: 3, limit: 50, includeTests: true });
    expect(out).toContain('mid');
    expect(out).toContain('d1');
  });

  it('hierarchy lists descendants from the base and ancestors from the sub', async () => {
    const fromBase = await x.hierarchy({ name: 'Base', depth: 3, limit: 50 });
    expect(fromBase).toContain('descendant');
    expect(fromBase).toContain('Sub');
    expect(fromBase).toContain('No ancestors');

    const fromSub = await x.hierarchy({ name: 'Sub', depth: 3, limit: 50 });
    expect(fromSub).toContain('ancestor');
    expect(fromSub).toContain('Base');
    expect(fromSub).toContain('No descendants');
  });

  it('who_calls lists callers', async () => {
    const out = await x.who_calls({ name: 'core', direction: 'callers', includeFuzzy: true, includeTests: true, limit: 30 });
    expect(out).toContain('mid');
  });

  it('ambiguous name returns the candidate list, not a pick', async () => {
    const out = await x.get_symbol({ name: 'login', includeMembers: true });
    expect(out).toContain('ambiguous');
    expect(out).toContain('auth::login');
    expect(out).toContain('admin::login');
  });

  it('path hint disambiguates', async () => {
    const out = await x.get_symbol({ name: 'login', path: 'a.rs', includeMembers: true });
    expect(out).toContain('auth::login');
    expect(out).not.toContain('ambiguous');
  });

  it('analyze dead_code runs and renders', async () => {
    const out = await x.analyze({ kind: 'dead_code', includeExported: true, scope: 'module', limit: 30, offset: 0 });
    expect(out).toMatch(/dead-code candidate|No dead-code/);
  });

  it('module_map renders subsystems and drift', async () => {
    const out = await x.module_map({ limit: 20, resolution: 1 });
    expect(out).toMatch(/subsystem|No inter-module/);
  });
});

describe('signature truncation in cite() (Task 5)', () => {
  let x: Executors;

  const MULTILINE_SIG = `(
    name: string,
    qualifiedName: string | null,
    useSpecifiers: string[],
    methodCall = false,
    fromPath: string | null = null,
    externalNames?: ReadonlySet<string>,
    selfReceiver = false,
    callerQualified: string | null = null
  ): { ids: number[]; confidence: 'resolved' | 'fuzzy' } | 'unresolved'`;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-exec-sig-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    const longSigSym: NewSymbol = {
      name: 'resolveOneRef',
      qualified: 'SqliteCodeStore.resolveOneRef',
      kind: 'method',
      lang: 'rust',
      startLine: 617,
      endLine: 700,
      signature: MULTILINE_SIG,
      doc: null,
      exported: true,
      parentIndex: null,
    };
    await store.applyExtraction(ext('sig.rs', [longSigSym]));
    x = createExecutors({ store });
  });

  it('find_symbol renders a multi-line signature on exactly one line, with file:line at the end', async () => {
    const out = await x.find_symbol({ name: 'resolveOneRef', limit: 20, offset: 0, preview: false });
    const resultLine = out.split('\n').find((l) => l.startsWith('  - '));
    expect(resultLine).toBeDefined();
    expect(resultLine).not.toContain('\n');
    // Every line the raw signature spanned is now folded into one, and the
    // file:line citation is the trailing token, not buried mid-signature.
    expect(resultLine!.trim().endsWith('sig.rs:617')).toBe(true);
    expect(out.split('\n').length).toBe(2); // header + the one result line
  });

  it('get_symbol still returns the complete, untruncated multi-line signature', async () => {
    const out = await x.get_symbol({ name: 'resolveOneRef', includeMembers: true });
    // Every parameter name from the full signature must survive verbatim.
    expect(out).toContain('qualifiedName: string | null');
    expect(out).toContain('callerQualified: string | null = null');
    expect(out).toContain("{ ids: number[]; confidence: 'resolved' | 'fuzzy' } | 'unresolved'");
    // The newlines/indentation from the source are preserved (not collapsed).
    expect(out).toContain('\n    name: string,\n');
  });
});

describe('includeTests filtering (Task 2)', () => {
  let store: CodeStore;
  let x: Executors;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-exec-tests-'));
    store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    await store.applyExtraction(ext('target2.rs', [sym('target2', 'target2')]));
    // One production caller, one test caller.
    await store.applyExtraction(ext('prod-caller.rs', [sym('prodCaller', 'prodCaller')], [{ fromIndex: 1, name: 'target2', qualifiedName: null, kind: 'CALLS', line: 5, inTest: false }]));
    await store.applyExtraction(ext('test-caller.rs', [sym('testCaller', 'testCaller')], [{ fromIndex: 1, name: 'target2', qualifiedName: null, kind: 'CALLS', line: 6, inTest: true }]));
    x = createExecutors({ store });
  });

  it('edgesTo returns test:true on exactly the test-file caller edge', async () => {
    const targetRows = await store.query(`SELECT id FROM Symbol WHERE qualified='target2'`);
    const targetId = Number(targetRows[0]!.id);
    const edges = await store.edgesTo([targetId], ['CALLS']);
    expect(edges.length).toBe(2);
    const testEdges = edges.filter((e) => e.test);
    const prodEdges = edges.filter((e) => !e.test);
    expect(testEdges.length).toBe(1);
    expect(prodEdges.length).toBe(1);
    expect(testEdges[0]!.line).toBe(6);
    expect(prodEdges[0]!.line).toBe(5);
  });

  it('who_calls with includeTests:false omits the test caller and states the hidden count', async () => {
    const out = await x.who_calls({ name: 'target2', direction: 'callers', includeFuzzy: true, includeTests: false, limit: 30 });
    expect(out).toContain('prodCaller');
    expect(out).not.toContain('testCaller');
    expect(out).toContain('1 test-file caller(s) hidden; pass includeTests to see them');
  });

  it('who_calls default (flag absent from the raw call) is byte-identical to includeTests:true', async () => {
    // Regression guard: an agent/CLI call that never mentions includeTests
    // must render exactly what it did before this flag existed. Parse through
    // the real zod schema (not a hand-built object) so a default change would
    // actually be caught.
    const parsed = codeToolSchemas.who_calls.input.parse({ name: 'target2', direction: 'callers', includeFuzzy: true, limit: 30 });
    expect(parsed.includeTests).toBe(true); // default is unchanged
    const withDefault = await x.who_calls(parsed);
    const explicit = await x.who_calls({ name: 'target2', direction: 'callers', includeFuzzy: true, includeTests: true, limit: 30 });
    expect(withDefault).toBe(explicit);
    expect(withDefault).toContain('testCaller');
    expect(withDefault).toContain('prodCaller');
    expect(withDefault).not.toContain('hidden');
  });
});

describe('rename_symbol executor', () => {
  let x: Executors;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-rename-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    // core.rs: line 10 has the def line (module stub occupies lines 1-3, blank
    // padding brings `core` itself to line 10, matching the `sym` fixture).
    const coreLines = Array.from({ length: 9 }, () => '').concat('fn core() {}');
    fs.writeFileSync(path.join(dir, 'src/core.rs'), coreLines.join('\n') + '\n');
    const midLines = Array.from({ length: 4 }, () => '').concat('    core();').concat(Array.from({ length: 5 }, () => ''));
    fs.writeFileSync(path.join(dir, 'src/mid.rs'), midLines.join('\n') + '\n');

    await store.applyExtraction(ext('src/core.rs', [sym('core', 'core')]));
    await store.applyExtraction(ext('src/mid.rs', [sym('mid', 'mid')], [fromFn('core', null)]));

    x = createExecutors({ store, root: dir });
  });

  it('renames the definition and every direct reference site', async () => {
    const out = await x.rename_symbol({ name: 'core', newName: 'core_v2', path: undefined });
    expect(out).toContain('Renamed');
    expect(out).toContain('core_v2');

    const coreText = fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8');
    expect(coreText).toContain('fn core_v2() {}');
    expect(coreText).not.toContain('fn core()');

    const midText = fs.readFileSync(path.join(dir, 'src/mid.rs'), 'utf8');
    expect(midText).toContain('core_v2();');
  });

  it('rejects an invalid new identifier without touching files', async () => {
    const before = fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8');
    const out = await x.rename_symbol({ name: 'core', newName: '123bad', path: undefined });
    expect(out).toContain('not a valid identifier');
    expect(fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8')).toBe(before);
  });

  it('reports unavailable without a root', async () => {
    const store = await SqliteCodeStore.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-rename-noroot-')), 'g.db'), nodeSqlDriver);
    const noRoot = createExecutors({ store });
    expect(await noRoot.rename_symbol({ name: 'anything', newName: 'x', path: undefined })).toContain('unavailable');
  });
});

describe('rename_symbol collision pre-flight', () => {
  // A dedicated store and temp dir: the block above renames core -> core_v2 in
  // its own beforeAll, so sharing that fixture would make these assertions
  // depend on test ordering.
  let x: Executors;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-collide-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    // Both `alpha` and `taken` live in src/one.rs, so renaming alpha -> taken
    // is a same-file collision. `elsewhere` sits in its own file, so renaming
    // alpha -> elsewhere is legal but worth reporting.
    const nine = Array.from({ length: 9 }, () => '');
    fs.writeFileSync(path.join(dir, 'src/one.rs'), nine.concat('fn alpha() {}', 'fn taken() {}').join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'src/two.rs'), nine.concat('fn elsewhere() {}').join('\n') + '\n');

    await store.applyExtraction(ext('src/one.rs', [sym('alpha', 'alpha'), sym('taken', 'taken')]));
    await store.applyExtraction(ext('src/two.rs', [sym('elsewhere', 'elsewhere')]));

    x = createExecutors({ store, root: dir });
  });

  it('aborts on a same-file collision and leaves the file byte-identical', async () => {
    const before = fs.readFileSync(path.join(dir, 'src/one.rs'), 'utf8');
    const out = await x.rename_symbol({ name: 'alpha', newName: 'taken', path: undefined });
    expect(out).toContain('Aborted: "taken" is already declared in the same scope');
    expect(out).toContain('src/one.rs:10');
    expect(out).toContain('No files were modified.');
    expect(fs.readFileSync(path.join(dir, 'src/one.rs'), 'utf8')).toBe(before);
  });

  it('succeeds on a different-file same-name symbol but reports it', async () => {
    const out = await x.rename_symbol({ name: 'alpha', newName: 'elsewhere', path: undefined });
    expect(out).toContain('Renamed');
    expect(out).toContain('1 other symbol(s) named "elsewhere" already exist elsewhere');
    expect(out).toContain('src/two.rs:10');
    expect(fs.readFileSync(path.join(dir, 'src/one.rs'), 'utf8')).toContain('fn elsewhere() {}');
  });
});

describe('moduleMap clustering', () => {
  // moduleMap reads only store.query(); a canned-row stub pins the Louvain +
  // drift logic deterministically without depending on edge-creation internals
  // (real DEPENDS_ON edges come from `use` statements, exercised on ripgrep in
  // the integration smoke test — here we isolate the graph algorithm).
  // moduleMap's query now aggregates in Cypher (`count(*) AS n`, grouped by
  // confidence), so the fake rows already carry the grouped shape.
  // Two queries now: the dep aggregation, and the per-file symbol counts that
  // size the map's nodes — dispatch on the Cypher so each gets its own shape.
  function fakeStore(fileDeps: Array<[string, string, number] | [string, string, number, string]>): CodeStore {
    const rows = fileDeps.map(([af, bf, n, conf]) => ({ af, bf, n, conf: conf ?? 'resolved' }));
    const files = [...new Set(fileDeps.flatMap(([af, bf]) => [af, bf]))].map((f) => ({ f, n: 1 }));
    return {
      query: async (cypher: string) => (cypher.includes('DEPENDS_ON') ? rows : files),
    } as unknown as CodeStore;
  }

  it('aggregates file deps to directory modules and clusters them', async () => {
    const { moduleMap } = await import('../analyze/moduleMap');
    // Modules a, b, c. a<->b densely coupled (weight 5 total), c hangs off a
    // by a single edge — Louvain should keep {a,b} together and c is a bridge.
    const map = await moduleMap(
      fakeStore([
        ['a/1.rs', 'b/1.rs', 3],
        ['b/1.rs', 'a/1.rs', 2],
        ['a/1.rs', 'c/1.rs', 1],
      ])
    );
    expect(map.modules).toEqual(['a', 'b', 'c']);
    // a<->b folds to weight 5 (3 a→b + 2 b→a); a→c weight 1.
    const ab = map.edges.find((e) => e.from === 'a' && e.to === 'b');
    expect(ab?.weight).toBe(3);
    expect(map.edges.find((e) => e.from === 'b' && e.to === 'a')?.weight).toBe(2);
    // a and b belong to the same cluster; c is weakly attached.
    const clusterOf = (m: string) => map.clusters.find((c) => c.modules.includes(m))!.id;
    expect(clusterOf('a')).toBe(clusterOf('b'));
    // driftRatio is a valid fraction.
    expect(map.driftRatio).toBeGreaterThanOrEqual(0);
    expect(map.driftRatio).toBeLessThanOrEqual(1);
  });

  it('handles an empty graph', async () => {
    const { moduleMap } = await import('../analyze/moduleMap');
    const map = await moduleMap(fakeStore([]));
    expect(map.modules).toEqual([]);
    expect(map.driftRatio).toBe(0);
  });
});

/**
 * diff_impact's rendering, with the diff source stubbed — the executor must
 * never shell out to git itself, so injecting hunks is the whole contract.
 */
describe('diff_impact executor', () => {
  let store: SqliteCodeStore;
  const args = { rev: undefined, staged: false, depth: 3, limit: 50, offset: 0, includeTests: true } as const;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-diffexec-'));
    store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    const at = (name: string, start: number, end: number): NewSymbol => ({
      name, qualified: name, kind: 'function', lang: 'rust', startLine: start, endLine: end,
      signature: '()', doc: null, exported: true, parentIndex: null,
    });
    await store.applyExtraction({
      path: 'core.rs', lang: 'rust', mtimeMs: 1, size: 1, hash: 'h1', crate: null, parseError: false,
      symbols: [at('coremod', 1, 1), at('target', 10, 20)], refs: [], uses: [],
    });
    await store.applyExtraction({
      path: 'caller.rs', lang: 'rust', mtimeMs: 1, size: 1, hash: 'h2', crate: null, parseError: false,
      symbols: [at('callermod', 1, 1), at('caller', 5, 15)],
      refs: [{ fromIndex: 1, name: 'target', qualifiedName: null, kind: 'CALLS', line: 7 }], uses: [],
    });
    await store.resolvePending(undefined, { retireUnresolved: true });
  });

  it('reports the dependants of a changed symbol', async () => {
    const x = createExecutors({ store, collectDiff: async () => [{ path: 'core.rs', startLine: 12, endLine: 12 }] });
    const out = await x.diff_impact({ ...args });
    expect(out).toContain('1 changed symbol(s)');
    expect(out).toContain('target');
    expect(out).toContain('caller');
    expect(out).toContain('file(s) to re-check');
  });

  it('says so plainly when the diff is empty', async () => {
    const x = createExecutors({ store, collectDiff: async () => [] });
    expect(await x.diff_impact({ ...args })).toContain('No changes');
  });

  it('surfaces a hunk that matched no symbol instead of implying safety', async () => {
    const x = createExecutors({ store, collectDiff: async () => [{ path: 'core.rs', startLine: 25, endLine: 25 }] });
    const out = await x.diff_impact({ ...args });
    expect(out).toContain('matched no indexed symbol');
    expect(out).toContain('core.rs:25-25');
  });

  it('reports an unavailable diff source rather than an empty blast radius', async () => {
    const x = createExecutors({ store });
    expect(await x.diff_impact({ ...args })).toContain('unavailable');
  });

  it('surfaces a git failure as a message, not a throw', async () => {
    const x = createExecutors({
      store,
      collectDiff: async () => { throw new Error('not a git repository'); },
    });
    expect(await x.diff_impact({ ...args })).toContain('not a git repository');
  });
});
