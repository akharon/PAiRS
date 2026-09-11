/**
 * One test per tool: the CLI's JSON builder (Step 5) emits parseable,
 * JSON.stringify-safe data containing the key fields for that tool. Uses the
 * real parse -> extract -> store pipeline (indexProject) rather than a fake
 * store, since these builders reuse the same store/analyze calls the prose
 * executors use — the point is proving the JSON shape holds real data, not
 * re-testing impact()/hierarchy()/moduleMap() themselves.
 */

import { describe, expect, it } from 'vitest';
import { indexProject } from '../../test/indexProject';
import {
  jsonAnalyze,
  jsonContextPack,
  jsonFileDeps,
  jsonFindSymbol,
  jsonGetSymbol,
  jsonGrepSymbols,
  jsonHierarchy,
  jsonImpact,
  jsonModuleMap,
  jsonOutline,
  jsonRenameSymbol,
  jsonWhoCalls,
} from './json';

/** Every builder returns a value JSON.stringify round-trips without throwing or dropping data. */
function assertJsonSafe(value: unknown): void {
  expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
}

describe('CLI JSON builders (Step 5)', () => {
  it('jsonFindSymbol: returns the matching symbol with pagination fields', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function helperAlpha(): number { return 1; }\n`,
    });
    const out = (await jsonFindSymbol(store, { name: 'helperAlpha', limit: 20, offset: 0, preview: false })) as {
      total: number;
      hasMore: boolean;
      symbols: Array<{ name: string; file: string }>;
    };
    assertJsonSafe(out);
    expect(out.total).toBe(1);
    expect(out.hasMore).toBe(false);
    expect(out.symbols[0]?.name).toBe('helperAlpha');
    expect(out.symbols[0]?.file).toBe('src/a.ts');
  });

  it('jsonGetSymbol: returns the full symbol record', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function helperAlpha(): number { return 1; }\n`,
    });
    const out = (await jsonGetSymbol(store, { name: 'helperAlpha', includeMembers: true })) as { symbol: { name: string } | null };
    assertJsonSafe(out);
    expect(out.symbol?.name).toBe('helperAlpha');
  });

  it('jsonOutline: returns the file’s symbols in order', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function first(): void {}\nexport function second(): void {}\n`,
    });
    const out = (await jsonOutline(store, { path: 'src/a.ts' })) as { path: string; symbols: Array<{ name: string }> };
    assertJsonSafe(out);
    expect(out.path).toBe('src/a.ts');
    expect(out.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['first', 'second']));
  });

  it('jsonImpact: returns the seed and dependants', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
      'src/b.ts': `import { target } from './a';\nexport function caller(): void { target(); }\n`,
    });
    const out = (await jsonImpact(store, { name: 'target', depth: 3, limit: 50, includeTests: true })) as {
      seed: { name: string } | null;
      dependants: Array<{ symbol: { name: string } }>;
    };
    assertJsonSafe(out);
    expect(out.seed?.name).toBe('target');
    expect(out.dependants.some((d) => d.symbol.name === 'caller')).toBe(true);
  });

  it('jsonHierarchy: returns ancestors/descendants buckets', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export class Base {}\nexport class Derived extends Base {}\n`,
    });
    const out = (await jsonHierarchy(store, { name: 'Derived', depth: 3, limit: 50 })) as {
      seed: { name: string } | null;
      ancestors: { items: Array<{ symbol: { name: string } }> };
    };
    assertJsonSafe(out);
    expect(out.seed?.name).toBe('Derived');
    expect(out.ancestors.items.some((a) => a.symbol.name === 'Base')).toBe(true);
  });

  it('jsonWhoCalls: returns caller edges with symbol and edge data', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
      'src/b.ts': `import { target } from './a';\nexport function caller(): void { target(); }\n`,
    });
    const out = (await jsonWhoCalls(store, {
      name: 'target',
      direction: 'callers',
      includeFuzzy: true,
      includeTests: true,
      limit: 30,
    })) as { symbol: { name: string } | null; items: Array<{ symbol: { name: string } }> };
    assertJsonSafe(out);
    expect(out.symbol?.name).toBe('target');
    expect(out.items.some((i) => i.symbol.name === 'caller')).toBe(true);
  });

  it('jsonFileDeps: returns the file dependency list', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
      'src/b.ts': `import { target } from './a';\n`,
    });
    const out = (await jsonFileDeps(store, { path: 'src/a.ts', direction: 'importers', transitive: false, limit: 50 })) as {
      path: string;
      deps: Array<{ path: string }>;
    };
    assertJsonSafe(out);
    expect(out.path).toBe('src/a.ts');
    expect(out.deps.some((d) => d.path === 'src/b.ts')).toBe(true);
  });

  it('jsonModuleMap: returns modules and edges', async () => {
    const { store } = await indexProject({
      'src/a/x.ts': `export function target(): void {}\n`,
      'src/b/y.ts': `import { target } from '../a/x';\n`,
    });
    const out = (await jsonModuleMap(store, { limit: 20, resolution: 1 })) as { modules: string[]; edges: unknown[] };
    assertJsonSafe(out);
    expect(out.modules.length).toBeGreaterThan(0);
  });

  it('jsonAnalyze: dead_code returns candidates', async () => {
    const { store } = await indexProject({
      'src/a.ts': `function unused(): void {}\n`,
    });
    const out = (await jsonAnalyze(store, {
      kind: 'dead_code',
      scope: 'module',
      includeExported: false,
      limit: 30,
      offset: 0,
    })) as { kind: string; candidates: Array<{ symbol: { name: string } }> };
    assertJsonSafe(out);
    expect(out.kind).toBe('dead_code');
    expect(out.candidates.some((c) => c.symbol.name === 'unused')).toBe(true);
  });

  it('jsonRenameSymbol: reports the rename plan without a root', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
    });
    const out = (await jsonRenameSymbol(store, undefined, { name: 'target', newName: 'renamed' })) as {
      renamed: boolean;
      message: string;
    };
    assertJsonSafe(out);
    expect(out.renamed).toBe(false);
  });

  it('jsonGrepSymbols: substring-matches name/qualified/signature/doc', async () => {
    const { store } = await indexProject({
      'src/a.ts': `/** Widget renderer. */\nexport function renderWidget(): void {}\nexport function unrelated(): void {}\n`,
    });
    const out = (await jsonGrepSymbols(store, { pattern: 'widget', isRegex: false, limit: 30 })) as {
      total: number;
      symbols: Array<{ name: string }>;
    };
    assertJsonSafe(out);
    expect(out.symbols.some((s) => s.name === 'renderWidget')).toBe(true);
    expect(out.symbols.some((s) => s.name === 'unrelated')).toBe(false);
  });

  it('jsonGrepSymbols: regex mode', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function getFoo(): void {}\nexport function setFoo(): void {}\nexport function other(): void {}\n`,
    });
    const out = (await jsonGrepSymbols(store, { pattern: '^(get|set)Foo$', isRegex: true, limit: 30 })) as {
      symbols: Array<{ name: string }>;
    };
    assertJsonSafe(out);
    expect(out.symbols.map((s) => s.name).sort()).toEqual(['getFoo', 'setFoo']);
  });

  it('jsonContextPack: by symbol name returns callers/callees/module', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
      'src/b.ts': `import { target } from './a';\nexport function caller(): void { target(); }\n`,
    });
    const out = (await jsonContextPack(store, { name: 'target', limit: 10 })) as {
      symbol: { name: string } | null;
      callers: { items: Array<{ symbol: { name: string } }> };
      module: string;
    };
    assertJsonSafe(out);
    expect(out.symbol?.name).toBe('target');
    expect(out.callers.items.some((c) => c.symbol.name === 'caller')).toBe(true);
  });

  it('jsonContextPack: by file path returns symbols and module edges', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
      'src/b.ts': `import { target } from './a';\n`,
    });
    const out = (await jsonContextPack(store, { path: 'src/a.ts', limit: 10 })) as {
      path: string;
      symbols: Array<{ name: string }>;
    };
    assertJsonSafe(out);
    expect(out.path).toBe('src/a.ts');
    expect(out.symbols.some((s) => s.name === 'target')).toBe(true);
  });

  it('jsonContextPack: neither name nor path returns a message', async () => {
    const { store } = await indexProject({ 'src/a.ts': `export function target(): void {}\n` });
    const out = (await jsonContextPack(store, { limit: 10 })) as { message: string };
    assertJsonSafe(out);
    expect(out.message).toMatch(/name.*path/i);
  });
});
