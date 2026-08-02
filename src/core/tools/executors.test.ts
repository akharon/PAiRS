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
import type { CodeStore } from '../../store/graph/codeStore';
import type { FileExtraction, NewSymbol, RawRef } from '../indexer/types';

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'function'): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 10, endLine: 12, signature: '()', doc: null, exported: true, parentIndex: null };
}
function ext(p: string, symbols: NewSymbol[], refs: RawRef[] = []): FileExtraction {
  return { path: p, lang: 'rust', mtimeMs: 1, size: 1, hash: `h-${p}-${Math.random()}`, crate: null, parseError: false, symbols: [sym(p, p, 'module'), ...symbols], refs, uses: [] };
}
const fromFn = (name: string, qualifiedName: string | null): RawRef => ({ fromIndex: 1, name, qualifiedName, kind: 'CALLS', line: 5 });

describe('tool executors', () => {
  let x: Executors;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-exec-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    await store.applyExtraction(ext('core.rs', [sym('core', 'core')]));
    await store.applyExtraction(ext('mid.rs', [sym('mid', 'mid')], [fromFn('core', null)]));
    // Two same-named `login` to exercise the ambiguity path.
    await store.applyExtraction(ext('a.rs', [sym('login', 'auth::login')]));
    await store.applyExtraction(ext('b.rs', [sym('login', 'admin::login')]));
    // Base <- Sub via EXTENDS, for the hierarchy executor.
    await store.applyExtraction(ext('base.rs', [sym('Base', 'Base', 'class')]));
    await store.applyExtraction(
      ext('sub.rs', [sym('Sub', 'Sub', 'class')], [{ fromIndex: 1, name: 'Base', qualifiedName: null, kind: 'EXTENDS', line: 5 }])
    );
    x = createExecutors({ store });
  });

  it('find_symbol cites file:line', async () => {
    const out = await x.find_symbol({ name: 'core', limit: 20, offset: 0 });
    expect(out).toContain('core.rs:10');
    expect(out).toContain('[function]');
  });

  it('impact reaches transitive callers', async () => {
    const out = await x.impact({ name: 'core', depth: 3, limit: 50 });
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
    const out = await x.who_calls({ name: 'core', direction: 'callers', includeFuzzy: true, limit: 30 });
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

describe('rule tool executors', () => {
  let x: Executors;
  let rulesPath: string;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-ruletool-'));
    const store = await SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
    // busy() calls two targets; MaxFanOut(max: 1) flags it.
    await store.applyExtraction(ext('u/t.rs', [sym('t1', 't1'), sym('t2', 't2')]));
    await store.applyExtraction(ext('u/busy.rs', [sym('busy', 'busy')], [fromFn('t1', null), fromFn('t2', null)]));
    rulesPath = path.join(dir, 'rules.ron');
    fs.writeFileSync(
      rulesPath,
      '( rules: [ (id: "fanout", tier: 2, severity: warning, kind: MaxFanOut(max: 1), explain: "Keep functions focused.") ] )'
    );
    x = createExecutors({ store, rulesPath });
  });

  it('check_rules reports the violation with the explain payload', async () => {
    const out = await x.check_rules({ limit: 30 });
    expect(out).toContain('fanout');
    expect(out).toContain('Keep functions focused.');
    expect(out).toContain('u/busy.rs:10');
    expect(out).toContain('warning');
  });

  it('list_rules and explain_rule render the ruleset', async () => {
    expect(await x.list_rules({})).toContain('MaxFanOut(max: 1)');
    const out = await x.explain_rule({ rule: 'fanout' });
    expect(out).toContain('tier 2');
    expect(out).toContain('Keep functions focused.');
    expect(await x.explain_rule({ rule: 'nope' })).toContain('No rule "nope"');
  });

  it('missing/invalid rules.ron degrades to a helpful message', async () => {
    // Rules load is checked before any store access, so a stub store suffices.
    const noRules = createExecutors({ store: {} as never, rulesPath: '/nonexistent/rules.ron' });
    expect(await noRules.check_rules({ limit: 30 })).toContain('No ruleset at');
    fs.writeFileSync(rulesPath + '.bad', '( rules: [ (id: "x", kind: NoCycles()) ] )');
    const bad = createExecutors({ store: {} as never, rulesPath: rulesPath + '.bad' });
    expect(await bad.check_rules({ limit: 30 })).toContain('missing mandatory "explain"');
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
