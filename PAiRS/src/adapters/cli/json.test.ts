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
  renderFilesProse,
  renderStatsProse,
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
    expect(out.hasMore).toBeUndefined();
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
      dependants: Array<{ name: string }>;
    };
    assertJsonSafe(out);
    expect(out.seed?.name).toBe('target');
    expect(out.dependants.some((d) => d.name === 'caller')).toBe(true);
  });

  it('jsonHierarchy: returns ancestors/descendants buckets', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export class Base {}\nexport class Derived extends Base {}\n`,
    });
    const out = (await jsonHierarchy(store, { name: 'Derived', depth: 3, limit: 50 })) as {
      seed: { name: string } | null;
      ancestors: { items: Array<{ name: string }> };
    };
    assertJsonSafe(out);
    expect(out.seed?.name).toBe('Derived');
    expect(out.ancestors.items.some((a) => a.name === 'Base')).toBe(true);
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
    })) as { symbol: { name: string } | null; items: Array<{ name: string }> };
    assertJsonSafe(out);
    expect(out.symbol?.name).toBe('target');
    expect(out.items.some((i) => i.name === 'caller')).toBe(true);
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
    })) as { kind: string; candidates: Array<{ name: string }> };
    assertJsonSafe(out);
    expect(out.kind).toBe('dead_code');
    expect(out.candidates.some((c) => c.name === 'unused')).toBe(true);
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
      callers: { items: Array<{ name: string }> };
      module: string;
    };
    assertJsonSafe(out);
    expect(out.symbol?.name).toBe('target');
    expect(out.callers.items.some((c) => c.name === 'caller')).toBe(true);
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

describe('slim JSON shapes', () => {
  it('drops internal ids, lang and default-valued fields from symbols', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function helperAlpha(): number { return 1; }\n`,
    });
    const out = (await jsonFindSymbol(store, { name: 'helperAlpha', limit: 20, offset: 0, preview: false })) as {
      symbols: Array<Record<string, unknown>>;
    };
    const s = out.symbols[0]!;
    for (const k of ['id', 'fileId', 'parentId', 'lang']) expect(s).not.toHaveProperty(k);
    expect(s).not.toHaveProperty('qualified'); // identical to name
    expect(s).toMatchObject({ name: 'helperAlpha', kind: 'function', file: 'src/a.ts', line: 1 });
    expect(Object.values(s).every((v) => v !== null && v !== undefined && v !== '')).toBe(true);
  });

  it('omits default edge fields (resolved confidence, test=false) from who_calls items', async () => {
    const { store } = await indexProject({
      'src/a.ts': `export function target(): void {}\n`,
      'src/b.ts': `import { target } from './a';\nexport function caller(): void { target(); }\n`,
    });
    const out = (await jsonWhoCalls(store, { name: 'target', direction: 'callers', includeFuzzy: true, includeTests: true, limit: 20 })) as {
      items: Array<Record<string, unknown>>;
    };
    const item = out.items.find((i) => i.name === 'caller')!;
    expect(item).not.toHaveProperty('confidence');
    expect(item).not.toHaveProperty('test');
    expect(item).not.toHaveProperty('n'); // a single call site carries no count
    expect(item.sites).toEqual([2]);
  });
});

describe('misses, path resolution and caller grouping (JSON)', () => {
  const files = {
    'src/core/tools/tools.ts': `export function target(): void {}\n`,
    'src/core/xtools.ts': `export function other(): void {}\n`,
    'src/a/dup.ts': `export function d1(): void {}\n`,
    'src/b/dup.ts': `export function d2(): void {}\n`,
    'src/use.ts':
      `import { target } from './core/tools/tools';\n` +
      `export function caller(): void {\n  target();\n  target();\n  target();\n}\n` +
      `export function once(): void {\n  target();\n}\n`,
  };

  it('outline resolves a unique path suffix and reports resolvedPath', async () => {
    const { store } = await indexProject(files);
    const out = (await jsonOutline(store, { path: 'tools.ts' })) as { path: string; resolvedPath?: string; symbols: Array<{ name: string }> };
    expect(out.resolvedPath).toBe('src/core/tools/tools.ts');
    expect(out.symbols.map((s) => s.name)).toContain('target');
    const exact = (await jsonOutline(store, { path: 'src/core/tools/tools.ts' })) as Record<string, unknown>;
    expect(exact).not.toHaveProperty('resolvedPath');
  });

  it('outline of an ambiguous or unknown path is an error, not an empty listing', async () => {
    const { store } = await indexProject(files);
    const amb = (await jsonOutline(store, { path: 'dup.ts' })) as { error: string; matches: string[] };
    expect(amb.error).toBe('ambiguous_path');
    expect(amb.matches.sort()).toEqual(['src/a/dup.ts', 'src/b/dup.ts']);
    const none = (await jsonOutline(store, { path: 'tool.ts' })) as { error: string; suggestions: string[] };
    expect(none.error).toBe('no_file');
    expect(none.suggestions).toContain('src/core/tools/tools.ts');
  });

  it('file_deps resolves a suffix path to the importers list', async () => {
    const { store } = await indexProject(files);
    const out = (await jsonFileDeps(store, { path: 'tools.ts', direction: 'importers', transitive: false, limit: 50 })) as {
      resolvedPath: string;
      deps: Array<{ path: string }>;
    };
    expect(out.resolvedPath).toBe('src/core/tools/tools.ts');
    expect(out.deps.map((d) => d.path)).toContain('src/use.ts');
  });

  it('symbol miss carries didYouMean', async () => {
    const { store } = await indexProject(files);
    const out = (await jsonGetSymbol(store, { name: 'targt', includeMembers: false })) as { symbol: null; didYouMean: string[] };
    expect(out.symbol).toBeNull();
    expect(out.didYouMean).toContain('target');
    const fs = (await jsonFindSymbol(store, { name: 'caler', limit: 20, offset: 0, preview: false })) as { didYouMean: string[] };
    expect(fs.didYouMean).toContain('caller');
    const nothing = (await jsonGetSymbol(store, { name: 'zzzzzzqq', includeMembers: false })) as Record<string, unknown>;
    expect(nothing).not.toHaveProperty('didYouMean');
  });

  it('who_calls groups repeat callers: one item with sites and n', async () => {
    const { store } = await indexProject(files);
    const out = (await jsonWhoCalls(store, { name: 'target', direction: 'callers', includeFuzzy: true, includeTests: true, limit: 20 })) as {
      total: number;
      items: Array<{ name: string; sites: number[]; n?: number }>;
    };
    expect(out.total).toBe(2);
    expect(out.items.find((i) => i.name === 'caller')).toMatchObject({ sites: [3, 4, 5], n: 3 });
    expect(out.items.find((i) => i.name === 'once')).toMatchObject({ sites: [8] });
    // limit counts callers, not call sites
    const one = (await jsonWhoCalls(store, { name: 'target', direction: 'callers', includeFuzzy: true, includeTests: true, limit: 1 })) as {
      total: number;
      hasMore?: boolean;
      items: unknown[];
    };
    expect(one.total).toBe(2);
    expect(one.hasMore).toBe(true);
    expect(one.items).toHaveLength(1);
  });

  it('context_pack groups callers and resolves a --path suffix', async () => {
    const { store } = await indexProject(files);
    const out = (await jsonContextPack(store, { name: 'target', limit: 10 })) as {
      callers: { total: number; items: Array<{ name: string; n?: number }> };
    };
    expect(out.callers.total).toBe(2);
    expect(out.callers.items.find((i) => i.name === 'caller')?.n).toBe(3);
    const byPath = (await jsonContextPack(store, { path: 'tools.ts', limit: 10 })) as { resolvedPath: string };
    expect(byPath.resolvedPath).toBe('src/core/tools/tools.ts');
  });
});

describe('slim JSON shapes (cont.)', () => {

  it('compact JSON is smaller than indented JSON', async () => {
    const { store } = await indexProject({ 'src/a.ts': `export function f(): void {}\nexport function g(): void {}\n` });
    const out = await jsonOutline(store, { path: 'src/a.ts' });
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(out, null, 2).length);
  });

  it('every builder answers an empty index with the single empty-index message', async () => {
    const { store } = await indexProject({});
    const outs = await Promise.all([
      jsonFindSymbol(store, { name: 'x', limit: 20, offset: 0, preview: false }),
      jsonImpact(store, { name: 'x', depth: 3, limit: 25 }),
      jsonModuleMap(store, { limit: 20, resolution: 1 }),
      jsonGrepSymbols(store, { pattern: 'x', isRegex: false, limit: 20 }),
    ]);
    for (const o of outs) expect((o as { message: string }).message).toMatch(/index for this workspace is empty.*pairs index/);
  });
});

describe('prose renderers for stats/files', () => {
  const stats = {
    files: 3,
    symbols: 20,
    edges: 10,
    pendingRefs: 4,
    unresolvedRatio: 0.28,
    externalRefs: 4,
    resolvableMisses: 0,
    fuzzyRate: 0.1,
    lastIndexedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    byKind: { function: 12, class: 3 },
  };
  it('renders stats in at most two lines', () => {
    const out = renderStatsProse(stats);
    expect(out.split('\n').length).toBeLessThanOrEqual(2);
    expect(out).toContain('3 files, 20 symbols, 10 edges (10% fuzzy)');
    expect(out).toContain('function 12');
  });
  it('renders an empty index as the empty-index message', () => {
    expect(renderStatsProse({ ...stats, files: 0 })).toMatch(/empty/);
  });
  it('renders files one per line', () => {
    expect(renderFilesProse(['a.svg', 'b.svg'])).toBe('a.svg\nb.svg');
    expect(renderFilesProse([])).toBe('No matching files.');
  });
});
