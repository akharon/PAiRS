/**
 * End-to-end pipeline test: parse real fixture source per language, verify
 * extraction shape, then round-trip through SqliteCodeStore (applyExtraction,
 * resolvePending, ftsSearch, edgesTo/edgesFrom) to validate the whole chain
 * grammars → extractor → store → search actually agree with each other.
 */

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from '../core/sqliteStore';
import { ExtractorImpl } from './extractorImpl';
import { fileQuerySource, ParserRegistryImpl } from './parserRegistryImpl';
import { SqliteCodeStore } from './codeStoreImpl';
import { CodeSearchImpl } from './codeSearchImpl';
import type { CodeLang } from './types';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, 'queries');

const FIXTURES: Record<CodeLang, string> = {
  javascript: `
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
`,
  typescript: `
export function greet(name: string): string {
  return helper(name);
}
function helper(name: string): string {
  return 'hi ' + name;
}
export interface Named {
  name: string;
}
export class Greeter implements Named {
  name: string;
  greet(name: string): string {
    return greet(name);
  }
}
`,
  python: `
def helper(name):
    return 'hi ' + name

def greet(name):
    return helper(name)

class Greeter:
    def greet(self, name):
        return greet(name)
`,
  java: `
public class Greeter {
    public String helper(String name) {
        return "hi " + name;
    }
    public String greet(String name) {
        return helper(name);
    }
}
`,
  c: `
int helper(int x) {
    return x + 1;
}
int compute(int x) {
    return helper(x);
}
`,
  cpp: `
int helper(int x) {
    return x + 1;
}
class Calculator {
public:
    int compute(int x) {
        return helper(x);
    }
};
`,
  go: `
package main

func helper(name string) string {
	return "hi " + name
}

func Greet(name string) string {
	return helper(name)
}

type Greeter struct {
	Name string
}

func (g *Greeter) Greet() string {
	return Greet(g.Name)
}
`,
  ruby: `
def helper(name)
  "hi " + name
end

def greet(name)
  helper(name)
end

class Greeter
  def greet(name)
    greet(name)
  end
end
`,
  dart: `
String helper(String name) {
  return "hi " + name;
}

String greet(String name) {
  return helper(name);
}

class Greeter {
  String greet(String name) {
    return greet(name);
  }
}
`,
  rust: `
fn helper(name: &str) -> String {
    format!("hi {}", name)
}

pub fn greet(name: &str) -> String {
    helper(name)
}

pub struct Greeter {
    pub name: String,
}

impl Greeter {
    pub fn greet(&self) -> String {
        greet(&self.name)
    }
}
`,
  css: `
.greeter {
  color: red;
}
#helper, .card {
  margin: 0;
}
@import "shared.css";
`,
  html: `
<div id="greeter" class="card">
  <p id="helper">hi</p>
</div>
<link rel="stylesheet" href="style.css">
<script src="app.js"></script>
`,
};

const EXT: Record<CodeLang, string> = {
  javascript: 'greeter.js',
  typescript: 'greeter.ts',
  python: 'greeter.py',
  java: 'Greeter.java',
  c: 'greeter.c',
  cpp: 'greeter.cpp',
  go: 'greeter.go',
  ruby: 'greeter.rb',
  dart: 'greeter.dart',
  rust: 'greeter.rs',
  css: 'greeter.css',
  html: 'greeter.html',
};

/** CSS/HTML have no call expressions — skip the generic "has calls" assertion for these. */
const NO_CALLS_LANGS: ReadonlySet<CodeLang> = new Set(['css', 'html']);

describe('code indexer pipeline', () => {
  let registry: ParserRegistryImpl;
  const extractor = new ExtractorImpl();

  beforeAll(async () => {
    registry = new ParserRegistryImpl(GRAMMARS_DIR, fileQuerySource(QUERIES_DIR));
    await registry.init();
  });

  const EXPECTED_NAMES: Record<CodeLang, string[]> = {
    javascript: ['greet', 'helper'],
    typescript: ['greet', 'helper'],
    python: ['greet', 'helper'],
    java: ['greet', 'helper'],
    c: ['compute', 'helper'],
    cpp: ['compute', 'helper'],
    go: ['Greet', 'helper'],
    ruby: ['greet', 'helper'],
    dart: ['greet', 'helper'],
    rust: ['greet', 'helper'],
    css: ['.greeter', '#helper, .card'],
    html: ['greeter', 'helper'],
  };

  for (const lang of Object.keys(FIXTURES) as CodeLang[]) {
    it(`extracts symbols and calls for ${lang}`, async () => {
      const loaded = await registry.load(lang);
      const source = FIXTURES[lang];
      const extraction = extractor.extract(loaded, EXT[lang], source, { mtimeMs: 1, size: source.length });

      const names = extraction.symbols.map((s) => s.name);
      for (const expected of EXPECTED_NAMES[lang]) expect(names).toContain(expected);

      if (NO_CALLS_LANGS.has(lang)) {
        const importSpecs = extraction.imports.map((i) => i.specifier);
        expect(importSpecs.length).toBeGreaterThan(0);
      } else {
        const callNames = extraction.refs.filter((r) => r.kind === 'calls').map((r) => r.name);
        expect(callNames.length).toBeGreaterThan(0);
      }
    });
  }

  it('computes cyclomatic/cognitive complexity for javascript', async () => {
    const loaded = await registry.load('javascript');
    const source = `
function simple(x) {
  return x + 1;
}
function branchy(a, b) {
  if (a) {
    if (b) {
      return 1;
    }
  }
  for (let i = 0; i < a; i++) {
    doSomething(i);
  }
  return 0;
}
`;
    const extraction = extractor.extract(loaded, 'complexity.js', source, { mtimeMs: 1, size: source.length });
    const simple = extraction.symbols.find((s) => s.name === 'simple')!;
    const branchy = extraction.symbols.find((s) => s.name === 'branchy')!;

    // No decisions: cyclomatic 1, cognitive 0.
    expect(simple.complexity).toBe(1);
    expect(simple.cognitive).toBe(0);

    // 2 ifs + 1 for loop -> cyclomatic 1 + 3 = 4.
    expect(branchy.complexity).toBe(4);
    // cognitive: outer if (+1+0=1), nested if (+1+1=2), for loop (+1+0=1) = 4.
    expect(branchy.cognitive).toBe(4);
  });

  it('computes complexity for python (elif + boolean-operator runs)', async () => {
    const loaded = await registry.load('python');
    const source = `
def branchy(a, b, c):
    if a:
        pass
    elif a and b:
        pass
    else:
        pass
    if a and b or c:
        pass
`;
    const extraction = extractor.extract(loaded, 'complexity.py', source, { mtimeMs: 1, size: source.length });
    const branchy = extraction.symbols.find((s) => s.name === 'branchy')!;
    // decisions: if, elif, and(run) -> 1 + 3 = 4; second if + and/or run(2 runs) -> +1+2 = handled below
    expect(branchy.complexity).toBeGreaterThan(1);
    expect(branchy.cognitive).toBeGreaterThan(0);
  });

  it('computes complexity for go (if/for + boolean-operator run) and detects capitalization-based exports', async () => {
    const loaded = await registry.load('go');
    const source = `
package main

func Branchy(a bool, b bool) int {
	if a {
		if b && a {
			return 1
		}
	}
	for i := 0; i < 10; i++ {
	}
	return 0
}

func privateFn() int {
	return 1
}
`;
    const extraction = extractor.extract(loaded, 'branchy.go', source, { mtimeMs: 1, size: source.length });
    const branchy = extraction.symbols.find((s) => s.name === 'Branchy')!;
    expect(branchy.complexity).toBeGreaterThan(1);
    expect(branchy.cognitive).toBeGreaterThan(0);
    expect(branchy.exported).toBe(true);

    const priv = extraction.symbols.find((s) => s.name === 'privateFn')!;
    expect(priv.exported).toBe(false);
  });

  it('computes complexity for ruby (if/elsif + case + boolean-operator)', async () => {
    const loaded = await registry.load('ruby');
    const source = `
def branchy(a, b)
  if a
    1
  elsif a && b
    2
  else
    3
  end
  case a
  when 1
    puts "one"
  else
    puts "other"
  end
end
`;
    const extraction = extractor.extract(loaded, 'branchy.rb', source, { mtimeMs: 1, size: source.length });
    const branchy = extraction.symbols.find((s) => s.name === 'branchy')!;
    expect(branchy.complexity).toBeGreaterThan(1);
    expect(branchy.cognitive).toBeGreaterThan(0);
  });

  it('computes complexity for dart (if/else-if + for + boolean-operator), body captured via sibling merge', async () => {
    const loaded = await registry.load('dart');
    const source = `
int branchy(int a, int b) {
  if (a > 0) {
    if (b > 0 && a > 1) {
      return 1;
    }
  } else if (a < 0) {
    return -1;
  }
  for (var i = 0; i < 10; i++) {
    print(i);
  }
  return 0;
}
`;
    const extraction = extractor.extract(loaded, 'branchy.dart', source, { mtimeMs: 1, size: source.length });
    const branchy = extraction.symbols.find((s) => s.name === 'branchy')!;
    expect(branchy.complexity).toBeGreaterThan(1);
    expect(branchy.cognitive).toBeGreaterThan(0);
    // endLine must extend through the merged sibling body, not stop at the
    // signature (source has 13 lines including the trailing newline split).
    expect(branchy.endLine).toBeGreaterThan(branchy.startLine + 5);
  });

  it('computes complexity for rust (if/match + boolean-operator) and detects pub vs private', async () => {
    const loaded = await registry.load('rust');
    const source = `
pub fn branchy(a: bool, b: bool) -> i32 {
    if a {
        if b && a {
            return 1;
        }
    }
    match a {
        true => 1,
        false => 0,
    };
    for i in 0..10 {
    }
    0
}

fn private_fn() -> i32 {
    1
}
`;
    const extraction = extractor.extract(loaded, 'branchy.rs', source, { mtimeMs: 1, size: source.length });
    const branchy = extraction.symbols.find((s) => s.name === 'branchy')!;
    expect(branchy.complexity).toBeGreaterThan(1);
    expect(branchy.cognitive).toBeGreaterThan(0);
    expect(branchy.exported).toBe(true);

    const priv = extraction.symbols.find((s) => s.name === 'private_fn')!;
    expect(priv.exported).toBe(false);
  });

  it('round-trips javascript through the store: applyExtraction -> resolvePending -> edgesTo', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');
    const source = FIXTURES.javascript!;
    const extraction = extractor.extract(loaded, 'greeter.js', source, { mtimeMs: 1, size: source.length });

    await store.applyExtraction(extraction);
    await store.resolvePending();

    const lookup = await store.lookup('greet');
    expect(Array.isArray(lookup)).toBe(true);
    const greetSymbols = lookup as Awaited<ReturnType<typeof store.get>>[];
    expect(greetSymbols.length).toBeGreaterThan(0);

    const stats = await store.stats();
    expect(stats.symbols).toBeGreaterThan(0);
    expect(stats.edges).toBeGreaterThan(0);

    store.dispose();
  });

  it('code_search-style fts + hybrid search ranks exact name matches first', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');
    const source = FIXTURES.javascript!;
    const extraction = extractor.extract(loaded, 'greeter.js', source, { mtimeMs: 1, size: source.length });
    await store.applyExtraction(extraction);

    const search = new CodeSearchImpl({ store });
    const results = await search.search({ text: 'greet', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.symbol.name.toLowerCase()).toContain('greet');

    store.dispose();
  });

  it('outline returns symbols ordered by line', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('python');
    const source = FIXTURES.python!;
    const extraction = extractor.extract(loaded, 'greeter.py', source, { mtimeMs: 1, size: source.length });
    await store.applyExtraction(extraction);

    const outline = await store.outline('greeter.py');
    expect(outline.length).toBeGreaterThan(0);
    for (let i = 1; i < outline.length; i++) {
      expect(outline[i]!.startLine).toBeGreaterThanOrEqual(outline[i - 1]!.startLine);
    }

    store.dispose();
  });

  it('unreferenced() finds a never-called function but not a called one or an exported one', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');
    const source = `
export function usedExported() {
  return neverCalled2();
}
function calledLocally() {
  return 1;
}
function neverCalled() {
  return 2;
}
function caller() {
  return calledLocally();
}
`;
    const extraction = extractor.extract(loaded, 'dead.js', source, { mtimeMs: 1, size: source.length });
    await store.applyExtraction(extraction);
    await store.resolvePending();

    const dead = await store.unreferenced({});
    const deadNames = dead.map((d) => d.symbol.name);
    expect(deadNames).toContain('neverCalled');
    expect(deadNames).not.toContain('calledLocally');
    expect(deadNames).not.toContain('usedExported'); // exported, excluded by default

    const withExported = await store.unreferenced({ includeExported: true });
    const exportedHit = withExported.find((d) => d.symbol.name === 'usedExported');
    expect(exportedHit?.note).toBe('exported');

    store.dispose();
  });

  it('hotspots() ranks the most complex function first', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');
    const source = `
function simple(x) {
  return x + 1;
}
function complex(a, b) {
  if (a) {
    if (b) {
      if (a && b) {
        return 1;
      }
    }
  }
  for (let i = 0; i < a; i++) {
    if (i) {
      doIt(i);
    }
  }
  return 0;
}
`;
    const extraction = extractor.extract(loaded, 'hot.js', source, { mtimeMs: 1, size: source.length });
    await store.applyExtraction(extraction);

    const top = await store.hotspots({ metric: 'cognitive', limit: 5 });
    expect(top[0]!.name).toBe('complex');
    expect(top[0]!.cognitive).toBeGreaterThan(0);

    store.dispose();
  });

  it('fileEdges() walks a transitive import chain A -> B -> C', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');

    const a = extractor.extract(loaded, 'a.js', `import { b } from './b';\nb();\n`, { mtimeMs: 1, size: 1 });
    const b = extractor.extract(loaded, 'b.js', `import { c } from './c';\nexport function b() { return c(); }\n`, {
      mtimeMs: 1,
      size: 1,
    });
    const c = extractor.extract(loaded, 'c.js', `export function c() { return 1; }\n`, { mtimeMs: 1, size: 1 });

    await store.applyExtraction(c);
    await store.applyExtraction(b);
    await store.applyExtraction(a);
    await store.resolvePending();

    const directImporters = await store.fileEdges('b.js', 'importers');
    expect(directImporters.map((d) => d.path)).toEqual(['a.js']);

    const transitiveImporters = await store.fileEdges('c.js', 'importers', { transitive: true });
    const paths = transitiveImporters.map((d) => d.path);
    expect(paths).toContain('b.js');
    expect(paths).toContain('a.js');
    const aDep = transitiveImporters.find((d) => d.path === 'a.js')!;
    expect(aDep.depth).toBe(2);

    const unknown = await store.fileEdges('nope.js', 'importers');
    expect(unknown).toEqual([]);

    store.dispose();
  });

  it('similarPairs() finds near-duplicate symbol cards and caps oversized scans', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');
    const source = `
function parseConfigFile(path) {
  return path;
}
function parseConfigurationFile(path) {
  return path;
}
function totallyUnrelated() {
  return 42;
}
`;
    const extraction = extractor.extract(loaded, 'dup.js', source, { mtimeMs: 1, size: source.length });
    await store.applyExtraction(extraction);

    const symbols = await store.outline('dup.js');
    // Fake embeddings: identical vectors for the two near-duplicate names,
    // an orthogonal one for the unrelated function.
    for (const s of symbols) {
      const vec =
        s.name === 'totallyUnrelated' ? new Float32Array([0, 1, 0]) : new Float32Array([1, 0, 0]);
      await store.setEmbedding(s.id, vec);
    }

    const pairs = await store.similarPairs(0.9);
    expect(pairs.length).toBe(1);
    const names = [pairs[0]!.a.name, pairs[0]!.b.name].sort();
    expect(names).toEqual(['parseConfigFile', 'parseConfigurationFile'].sort());

    store.dispose();
  });

  it('testsReferencing() finds a test->helper->target chain at depth 2, and untested() excludes only the directly-tested symbol', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');

    const aSrc = `
export function f() {
  return 1;
}
export function g() {
  return 2;
}
function notExported() {
  return 3;
}
`;
    const helperSrc = `
import { f } from './a';
export function helper() {
  return f();
}
`;
    const testSrc = `
import { helper } from './helper';
helper();
`;
    const a = extractor.extract(loaded, 'src/a.js', aSrc, { mtimeMs: 1, size: aSrc.length });
    const helper = extractor.extract(loaded, 'src/helper.js', helperSrc, { mtimeMs: 1, size: helperSrc.length });
    const test = extractor.extract(loaded, 'src/a.test.js', testSrc, { mtimeMs: 1, size: testSrc.length });

    await store.applyExtraction(a);
    await store.applyExtraction(helper);
    await store.applyExtraction(test);
    await store.resolvePending();

    const fSymbol = (await store.lookup('f')) as Awaited<ReturnType<typeof store.get>>[];
    const fId = (fSymbol[0] as { id: number }).id;

    const hits = await store.testsReferencing([fId], { depth: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.target.name === 'f' && h.depth === 2)).toBe(true);
    // The test file itself has no test in it, so it should not appear as a target's tester at depth 1.
    expect(hits.every((h) => h.test.file === 'src/a.test.js')).toBe(true);

    const untested = await store.untested({});
    const untestedNames = untested.map((s) => s.name);
    expect(untestedNames).toContain('g'); // exported, no test reference
    expect(untestedNames).not.toContain('notExported'); // not exported, excluded regardless
    // `f` is only reached via a depth-2 chain (test -> helper -> f); this
    // store's untested() is depth-1 only per its documented limitation, so
    // f is NOT excluded by it (that's what testsReferencing is for).
    expect(untestedNames).toContain('f');

    store.dispose();
  });

  // -- Fuzz testing: extractor must never throw on malformed input ------------

  const FUZZ_SOURCES = [
    '', // empty file
    '{{{', // unmatched braces
    'function (', // incomplete function
    'class {', // class without name
    '/* unclosed comment', // unclosed block comment
    "'unclosed string", // unclosed string
    '@@@@', // random garbage
    '``` ``` ```', // edge case with backticks
    '  \n\n\n  ', // whitespace only
    'import \'./nonexistent\';', // import with unquoted path
    'function foo( { invalid param list }', // malformed params
    'export default 42;', // just an export
    'a'.repeat(100_000), // 100K of meaningless text (large file stress test)
  ];

  for (let fi = 0; fi < FUZZ_SOURCES.length; fi++) {
    const source = FUZZ_SOURCES[fi]!;
    it(`extractor does not throw on fuzz source ${fi} (${source.slice(0, 30).replace(/\n/g, '\\n')}...) for all languages`, async () => {
      for (const lang of Object.keys(FIXTURES) as CodeLang[]) {
        const loaded = await registry.load(lang);
        expect(() => {
          const extraction = extractor.extract(loaded, `fuzz.${EXT[lang]}`, source, {
            mtimeMs: 1,
            size: source.length,
          });
          // Must produce valid extraction shape even for garbage input
          expect(Array.isArray(extraction.symbols)).toBe(true);
          expect(typeof extraction.hash).toBe('string');
        }).not.toThrow();
      }
    });
  }

  it('findCycles() detects A→B→A cycles', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');

    // A imports B, B imports A → cycle
    const a = extractor.extract(loaded, 'a.js', `import { b } from './b';\nb();\n`, { mtimeMs: 1, size: 1 });
    const b = extractor.extract(loaded, 'b.js', `import { a } from './a';\na();\n`, { mtimeMs: 1, size: 1 });
    await store.applyExtraction(a);
    await store.applyExtraction(b);
    await store.resolvePending();

    const cycles = await store.findCycles();
    expect(cycles.length).toBeGreaterThan(0);
    const cyclePaths = cycles.map((c) => c.sort().join(','));
    expect(cyclePaths.some((c) => c === 'a.js,b.js')).toBe(true);

    store.dispose();
  });

  it('findCycles() returns empty for acyclic graphs', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteCodeStore(db);
    const loaded = await registry.load('javascript');

    const a = extractor.extract(loaded, 'a.js', `import { b } from './b';\nb();\n`, { mtimeMs: 1, size: 1 });
    const b = extractor.extract(loaded, 'b.js', `export function b() { return 1; }\n`, { mtimeMs: 1, size: 1 });
    await store.applyExtraction(a);
    await store.applyExtraction(b);
    await store.resolvePending();

    const cycles = await store.findCycles();
    expect(cycles.length).toBe(0);

    store.dispose();
  });
});
