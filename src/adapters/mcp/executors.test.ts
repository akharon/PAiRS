/**
 * MCP executor rendering, against a real Kuzu store (temp dir, never closed —
 * kuzu segfaults on close). These pin the agent-facing text: the `file:line`
 * citation, the ambiguity prompt, and that impact/analyze reach the store.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import { createExecutors, type Executors } from './executors';
import type { CodeStore } from '../../store/graph/codeStore';
import type { FileExtraction, NewSymbol, RawRef } from '../../core/indexer/types';

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'function'): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 10, endLine: 12, signature: '()', doc: null, exported: true, parentIndex: null };
}
function ext(p: string, symbols: NewSymbol[], refs: RawRef[] = []): FileExtraction {
  return { path: p, lang: 'rust', mtimeMs: 1, size: 1, hash: `h-${p}-${Math.random()}`, crate: null, parseError: false, symbols: [sym(p, p, 'module'), ...symbols], refs, uses: [] };
}
const fromFn = (name: string, qualifiedName: string | null): RawRef => ({ fromIndex: 1, name, qualifiedName, kind: 'CALLS', line: 5 });

describe('mcp executors', () => {
  let x: Executors;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gizem-exec-'));
    const store = await KuzuCodeStore.open(path.join(dir, 'g.kz'), nodeKuzuDriver);
    await store.applyExtraction(ext('core.rs', [sym('core', 'core')]));
    await store.applyExtraction(ext('mid.rs', [sym('mid', 'mid')], [fromFn('core', null)]));
    // Two same-named `login` to exercise the ambiguity path.
    await store.applyExtraction(ext('a.rs', [sym('login', 'auth::login')]));
    await store.applyExtraction(ext('b.rs', [sym('login', 'admin::login')]));
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
    const out = await x.module_map({ limit: 20 });
    expect(out).toMatch(/subsystem|No inter-module/);
  });
});

describe('moduleMap clustering', () => {
  // moduleMap reads only store.query(); a canned-row stub pins the Louvain +
  // drift logic deterministically without depending on edge-creation internals
  // (real DEPENDS_ON edges come from `use` statements, exercised on ripgrep in
  // the integration smoke test — here we isolate the graph algorithm).
  function fakeStore(fileDeps: Array<[string, string]>): CodeStore {
    const rows = fileDeps.map(([af, bf]) => ({ af, bf }));
    return { query: async () => rows } as unknown as CodeStore;
  }

  it('aggregates file deps to directory modules and clusters them', async () => {
    const { moduleMap } = await import('../../core/analyze/moduleMap');
    // Modules a, b, c. a<->b densely coupled (weight 5 total), c hangs off a
    // by a single edge — Louvain should keep {a,b} together and c is a bridge.
    const map = await moduleMap(
      fakeStore([
        ['a/1.rs', 'b/1.rs'], ['a/2.rs', 'b/2.rs'], ['a/3.rs', 'b/3.rs'],
        ['b/1.rs', 'a/1.rs'], ['b/2.rs', 'a/2.rs'],
        ['a/1.rs', 'c/1.rs'],
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
    const { moduleMap } = await import('../../core/analyze/moduleMap');
    const map = await moduleMap(fakeStore([]));
    expect(map.modules).toEqual([]);
    expect(map.driftRatio).toBe(0);
  });
});
