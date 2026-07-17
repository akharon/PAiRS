import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { DatabaseSync } from '../core/sqliteStore';
import { ExtractorImpl } from '../index/extractorImpl';
import { fileQuerySource, ParserRegistryImpl } from '../index/parserRegistryImpl';
import { SqliteCodeStore } from '../index/codeStoreImpl';
import { CodeSearchImpl } from '../index/codeSearchImpl';
import type { CodeStore } from '../index/codeStore';
import { CodeToolExecutorImpl } from './codeToolExecutor';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, '..', 'index', 'queries');

const SOURCE = `
export function greet(name) {
  return helper(name);
}
function helper(name) {
  return 'hi ' + name;
}
class Greeter {
  greet(name) {
    return greet(name);
  }
}
`;

describe('CodeToolExecutorImpl', () => {
  let registry: ParserRegistryImpl;
  const extractor = new ExtractorImpl();
  let store: CodeStore;
  let executor: CodeToolExecutorImpl;

  beforeAll(async () => {
    registry = new ParserRegistryImpl(GRAMMARS_DIR, fileQuerySource(QUERIES_DIR));
    await registry.init();
  });

  beforeEach(async () => {
    store = new SqliteCodeStore(new DatabaseSync(':memory:'));
    const loaded = await registry.load('javascript');
    const extraction = extractor.extract(loaded, 'greeter.js', SOURCE, { mtimeMs: 1, size: SOURCE.length });
    await store.applyExtraction(extraction);
    await store.resolvePending();
    executor = new CodeToolExecutorImpl({ store, search: new CodeSearchImpl({ store }) });
  });

  afterEach(() => store.dispose());

  it('code_search finds a symbol by name', async () => {
    const result = await executor.execute('code_search', { query: 'greet', exportedOnly: false, limit: 10 }, 'mcp');
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('greet');
  });

  it('code_outline lists symbols in line order', async () => {
    const result = await executor.execute('code_outline', { path: 'greeter.js' }, 'mcp');
    expect(result.text).toContain('greet');
    expect(result.text).toContain('helper');
    expect(result.text.indexOf('greet')).toBeLessThan(result.text.indexOf('Greeter'));
  });

  it('who_calls callers finds the caller of helper', async () => {
    const result = await executor.execute(
      'who_calls',
      { symbol: 'helper', direction: 'callers', depth: 1, includeFuzzy: true, limit: 30 },
      'mcp'
    );
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('Callers of');
  });

  it('who_calls reports no callees found for a leaf symbol', async () => {
    const result = await executor.execute(
      'who_calls',
      { symbol: 'helper', direction: 'callees', depth: 1, includeFuzzy: true, limit: 30 },
      'mcp'
    );
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('No callees found');
  });

  it('who_calls reports no symbol found for an unknown name', async () => {
    const result = await executor.execute(
      'who_calls',
      { symbol: 'doesNotExist', direction: 'callers', depth: 1, includeFuzzy: true, limit: 30 },
      'mcp'
    );
    expect(result.text).toContain('No symbol found');
  });

  it('code_outline reports not-indexed for an unknown path', async () => {
    const result = await executor.execute('code_outline', { path: 'nope.js' }, 'mcp');
    expect(result.text).toContain('No indexed symbols');
  });

  it('find_dead_code carries the verify-before-deleting caveat and finds the unreferenced class', async () => {
    const result = await executor.execute(
      'find_dead_code',
      { includeExported: false, limit: 30 },
      'mcp'
    );
    expect(result.text).toContain('verify before deleting');
    expect(result.text).toContain('Greeter'); // class is never referenced in the fixture
  });

  it('find_dead_code reports none found when everything is referenced', async () => {
    const noDeadStore = new SqliteCodeStore(new DatabaseSync(':memory:'));
    const loaded = await registry.load('javascript');
    const src = `
export function a() { return b(); }
export function b() { return 1; }
a();
`;
    const extraction = extractor.extract(loaded, 'live.js', src, { mtimeMs: 1, size: src.length });
    await noDeadStore.applyExtraction(extraction);
    await noDeadStore.resolvePending();
    const noDeadExecutor = new CodeToolExecutorImpl({ store: noDeadStore, search: new CodeSearchImpl({ store: noDeadStore }) });

    const result = await noDeadExecutor.execute('find_dead_code', { includeExported: true, limit: 30 }, 'mcp');
    expect(result.text).toContain('No unreferenced symbols found');
    noDeadStore.dispose();
  });

  it('file_deps reports not-indexed for an unknown file', async () => {
    const result = await executor.execute(
      'file_deps',
      { path: 'nope.js', direction: 'importers', transitive: false, limit: 50 },
      'mcp'
    );
    expect(result.text).toContain('No indexed symbols');
  });

  it('file_deps reports no dependencies for an indexed file with none', async () => {
    const result = await executor.execute(
      'file_deps',
      { path: 'greeter.js', direction: 'importers', transitive: false, limit: 50 },
      'mcp'
    );
    expect(result.text).toContain('No importers found');
  });

  it('code_hotspots reports none above an unreachable threshold', async () => {
    const result = await executor.execute(
      'code_hotspots',
      { metric: 'cognitive', threshold: 9999, limit: 20 },
      'mcp'
    );
    expect(result.text).toContain('No functions at or above');
  });

  it('find_duplicates reports the embeddings-required message when no embeddings exist', async () => {
    const result = await executor.execute(
      'find_duplicates',
      { threshold: 0.85, limit: 20 },
      'mcp'
    );
    expect(result.text).toContain('requires code-index embeddings');
  });

  it('get_declaration renders a function signature', async () => {
    const result = await executor.execute('get_declaration', { name: 'helper', includeMembers: true }, 'mcp');
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('helper');
    expect(result.text).toContain('greeter.js');
  });

  it('get_declaration lists members for a class', async () => {
    const result = await executor.execute('get_declaration', { name: 'Greeter', includeMembers: true }, 'mcp');
    expect(result.text).toContain('Members:');
    expect(result.text).toContain('greet');
  });

  it('get_declaration omits members when includeMembers is false', async () => {
    const result = await executor.execute('get_declaration', { name: 'Greeter', includeMembers: false }, 'mcp');
    expect(result.text).not.toContain('Members:');
  });

  it('get_declaration reports no symbol found for an unknown name', async () => {
    const result = await executor.execute('get_declaration', { name: 'doesNotExist', includeMembers: true }, 'mcp');
    expect(result.text).toContain('No symbol found');
  });

  it('appends the index-freshness footer to successful responses', async () => {
    const result = await executor.execute('code_search', { query: 'greet' }, 'mcp');
    expect(result.text).toMatch(/_index: \d+ files, \d+ symbols, updated /);
  });

  it('returns the empty-index warning instead of "no results" when nothing is indexed', async () => {
    const emptyStore = new SqliteCodeStore(new DatabaseSync(':memory:'));
    const emptyExecutor = new CodeToolExecutorImpl({ store: emptyStore, search: new CodeSearchImpl({ store: emptyStore }) });
    const result = await emptyExecutor.execute('code_search', { query: 'greet' }, 'mcp');
    expect(result.text).toContain('Code index is empty');
    expect(result.text).toContain('NOT evidence');
    emptyStore.dispose();
  });

  it('code_search pages with offset (disjoint results, offset noted in header)', async () => {
    const page1 = await executor.execute('code_search', { query: 'greet', limit: 1 }, 'mcp');
    const page2 = await executor.execute('code_search', { query: 'greet', limit: 1, offset: 1 }, 'mcp');
    expect(page2.text).toContain('(offset 1)');
    const first = (t: string) => t.split('\n').find((l) => l.startsWith('- '));
    expect(first(page1.text)).toBeDefined();
    expect(first(page1.text)).not.toEqual(first(page2.text));
  });

  it('get_declaration resolves an ambiguous name with a path hint', async () => {
    // Add a second file that also declares `helper` to force ambiguity.
    const loaded = await registry.load('javascript');
    const src = `function helper(x) { return x; }`;
    await store.applyExtraction(extractor.extract(loaded, 'other.js', src, { mtimeMs: 1, size: src.length }));
    await store.resolvePending();

    const ambiguous = await executor.execute('get_declaration', { name: 'helper', includeMembers: false }, 'mcp');
    expect(ambiguous.text).toContain('Multiple symbols match');

    const hinted = await executor.execute(
      'get_declaration',
      { name: 'helper', path: 'other.js', includeMembers: false },
      'mcp'
    );
    expect(hinted.text).toContain('other.js');
    expect(hinted.text).not.toContain('Multiple symbols match');
  });

  it('find_dead_code excludePath filters out matching files', async () => {
    const result = await executor.execute('find_dead_code', { excludePath: 'greeter', includeExported: false }, 'mcp');
    expect(result.text).toContain('No unreferenced symbols found');
  });

  describe('change_impact', () => {
    let ciStore: CodeStore;
    let ciExecutor: CodeToolExecutorImpl;

    beforeEach(async () => {
      ciStore = new SqliteCodeStore(new DatabaseSync(':memory:'));
      const loaded = await registry.load('javascript');

      const baseSrc = `
export class Base {
  greet() {
    return 1;
  }
}
export function useBase(b) {
  return b.greet();
}
`;
      const subSrc = `
import { Base } from './base';
export class Sub extends Base {
  greet() {
    return 2;
  }
}
`;
      const importerSrc = `
import { Sub } from './sub';
export function makeSub() {
  return new Sub();
}
`;
      await ciStore.applyExtraction(extractor.extract(loaded, 'base.js', baseSrc, { mtimeMs: 1, size: baseSrc.length }));
      await ciStore.applyExtraction(extractor.extract(loaded, 'sub.js', subSrc, { mtimeMs: 1, size: subSrc.length }));
      await ciStore.applyExtraction(
        extractor.extract(loaded, 'importer.js', importerSrc, { mtimeMs: 1, size: importerSrc.length })
      );
      await ciStore.resolvePending();
    });

    afterEach(() => ciStore.dispose());

    it('reports callers, subtypes, and importers for a class', async () => {
      ciExecutor = new CodeToolExecutorImpl({ store: ciStore, search: new CodeSearchImpl({ store: ciStore }) });
      const result = await ciExecutor.execute(
        'change_impact',
        { symbol: 'Base', depth: 2, includeFuzzy: true, limit: 40 },
        'mcp'
      );
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('## Subtypes/implementations');
      expect(result.text).toContain('Sub');
      expect(result.text).toContain('## Importing files');
      expect(result.text).toContain('sub.js');
      expect(result.text).toContain('Syntactic analysis');
    });

    it('includes a Linked memories section when memoryAnchors is provided', async () => {
      ciExecutor = new CodeToolExecutorImpl({
        store: ciStore,
        search: new CodeSearchImpl({ store: ciStore }),
        memoryAnchors: async (qualified) =>
          qualified === 'Base' ? [{ id: 'decisions/base-design', title: 'Why Base is shaped this way', type: 'decision' }] : [],
      });
      const result = await ciExecutor.execute('change_impact', { symbol: 'Base', depth: 2, includeFuzzy: true, limit: 40 }, 'mcp');
      expect(result.text).toContain('## Linked memories');
      expect(result.text).toContain('Why Base is shaped this way');
    });

    it('omits Linked memories and does not throw when memoryAnchors is absent', async () => {
      ciExecutor = new CodeToolExecutorImpl({ store: ciStore, search: new CodeSearchImpl({ store: ciStore }) });
      const result = await ciExecutor.execute('change_impact', { symbol: 'Base', depth: 2, includeFuzzy: true, limit: 40 }, 'mcp');
      expect(result.isError).toBeFalsy();
      expect(result.text).not.toContain('## Linked memories');
    });

    it('omits Subtypes/implementations for a function-kind symbol', async () => {
      ciExecutor = new CodeToolExecutorImpl({ store: ciStore, search: new CodeSearchImpl({ store: ciStore }) });
      const result = await ciExecutor.execute('change_impact', { symbol: 'useBase', depth: 2, includeFuzzy: true, limit: 40 }, 'mcp');
      expect(result.text).not.toContain('## Subtypes/implementations');
    });

    it('returns the ambiguous-candidate list, not an error, for an ambiguous name', async () => {
      const loaded = await registry.load('javascript');
      const dupSrc = `export class Base {}`;
      await ciStore.applyExtraction(extractor.extract(loaded, 'dup.js', dupSrc, { mtimeMs: 1, size: dupSrc.length }));
      await ciStore.resolvePending();

      ciExecutor = new CodeToolExecutorImpl({ store: ciStore, search: new CodeSearchImpl({ store: ciStore }) });
      const result = await ciExecutor.execute('change_impact', { symbol: 'Base', depth: 2, includeFuzzy: true, limit: 40 }, 'mcp');
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('Multiple symbols match');
    });
  });

  describe('who_tests / find_untested', () => {
    let ttStore: CodeStore;
    let ttExecutor: CodeToolExecutorImpl;

    beforeEach(async () => {
      ttStore = new SqliteCodeStore(new DatabaseSync(':memory:'));
      const loaded = await registry.load('javascript');

      const aSrc = `
export function tested() {
  return 1;
}
export function untested() {
  return 2;
}
`;
      const testSrc = `
import { tested } from './a';
tested();
`;
      await ttStore.applyExtraction(extractor.extract(loaded, 'a.js', aSrc, { mtimeMs: 1, size: aSrc.length }));
      await ttStore.applyExtraction(extractor.extract(loaded, 'a.test.js', testSrc, { mtimeMs: 1, size: testSrc.length }));
      await ttStore.resolvePending();
      ttExecutor = new CodeToolExecutorImpl({ store: ttStore, search: new CodeSearchImpl({ store: ttStore }) });
    });

    afterEach(() => ttStore.dispose());

    it('who_tests finds the direct test caller, grouped by test file', async () => {
      const result = await ttExecutor.execute(
        'who_tests',
        { symbol: 'tested', depth: 2, includeFuzzy: true, limit: 30 },
        'mcp'
      );
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('## a.test.js');
      expect(result.text).toContain('reaches');
    });

    it('who_tests reports none found for an untested symbol', async () => {
      const result = await ttExecutor.execute(
        'who_tests',
        { symbol: 'untested', depth: 2, includeFuzzy: true, limit: 30 },
        'mcp'
      );
      expect(result.text).toContain('No tests found');
    });

    it('find_untested lists the untested exported function but not the tested one', async () => {
      const result = await ttExecutor.execute('find_untested', { limit: 30, offset: 0 }, 'mcp');
      expect(result.isError).toBeFalsy();
      expect(result.text).toContain('untested');
      expect(result.text).not.toMatch(/\btested\(/);
    });

    it('find_untested reports none found when everything is tested', async () => {
      const allTestedStore = new SqliteCodeStore(new DatabaseSync(':memory:'));
      const loaded = await registry.load('javascript');
      const src = `export function onlyOne() { return 1; }`;
      const testSrc = `import { onlyOne } from './only'; onlyOne();`;
      await allTestedStore.applyExtraction(extractor.extract(loaded, 'only.js', src, { mtimeMs: 1, size: src.length }));
      await allTestedStore.applyExtraction(extractor.extract(loaded, 'only.test.js', testSrc, { mtimeMs: 1, size: testSrc.length }));
      await allTestedStore.resolvePending();
      const allTestedExecutor = new CodeToolExecutorImpl({ store: allTestedStore, search: new CodeSearchImpl({ store: allTestedStore }) });

      const result = await allTestedExecutor.execute('find_untested', { limit: 30, offset: 0 }, 'mcp');
      expect(result.text).toContain('No untested exported symbols found');
      allTestedStore.dispose();
    });
  });
});
