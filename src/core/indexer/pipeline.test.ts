/**
 * End-to-end pipeline test: parse fixture source per language, verify
 * extraction shape. Adapted from vendor/reference-indexer/src/index/
 * pipeline.test.ts — the multi-language "extracts symbols and calls" sweep
 * is the golden-corpus model (plan.md 0.6); complexity assertions are
 * dropped (out of scope, see extractors.ts). Requires dist/grammars to exist
 * (npm run fetch-grammars) since it loads real tree-sitter wasm.
 */

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtractorImpl } from './extractorImpl';
import { fileQuerySource, ParserRegistryImpl } from './parserRegistryImpl';
import type { CodeLang } from './types';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', '..', 'dist', 'grammars');
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

/** CSS/HTML have no call expressions — skip the generic "has calls" assertion for these. */
const NO_CALLS_LANGS: ReadonlySet<CodeLang> = new Set(['css', 'html']);

describe('code indexer pipeline', () => {
  let registry: ParserRegistryImpl;
  const extractor = new ExtractorImpl();

  beforeAll(async () => {
    registry = new ParserRegistryImpl(GRAMMARS_DIR, fileQuerySource(QUERIES_DIR));
    await registry.init();
  });

  for (const lang of Object.keys(FIXTURES) as CodeLang[]) {
    it(`extracts symbols and calls for ${lang}`, async () => {
      const loaded = await registry.load(lang);
      const source = FIXTURES[lang];
      const extraction = extractor.extract(loaded, EXT[lang], source, { mtimeMs: 1, size: source.length }, null);

      const names = extraction.symbols.map((s) => s.name);
      for (const expected of EXPECTED_NAMES[lang]) expect(names).toContain(expected);

      if (NO_CALLS_LANGS.has(lang)) {
        const useSpecs = extraction.uses.map((u) => u.specifier);
        expect(useSpecs.length).toBeGreaterThan(0);
      } else {
        const callNames = extraction.refs.filter((r) => r.kind === 'CALLS').map((r) => r.name);
        expect(callNames.length).toBeGreaterThan(0);
      }
    });
  }

  describe('rust precision contract (subsystem_indexer_spec.md §4)', () => {
    it('extracts impl-block methods, distinguishing them from free functions by kind', async () => {
      const loaded = await registry.load('rust');
      const extraction = extractor.extract(loaded, 'greeter.rs', FIXTURES.rust, { mtimeMs: 1, size: FIXTURES.rust.length }, null);

      const greetMethod = extraction.symbols.find((s) => s.name === 'greet' && s.kind === 'method');
      expect(greetMethod).toBeDefined();

      const greetFn = extraction.symbols.find((s) => s.name === 'greet' && s.kind === 'function');
      expect(greetFn).toBeDefined();
      expect(greetFn!.exported).toBe(true);
    });

    // The impl block is a @scope capture: it qualifies its methods without
    // emitting a symbol that would duplicate the struct_item. This is what
    // keeps `Greeter::greet` from colliding with the free `greet` fn and
    // landing in resolveOneRef's "fuzzy" bucket — it is the S1 precision fix,
    // so it stays pinned here.
    it('qualifies impl-block methods through the impl scope', async () => {
      const loaded = await registry.load('rust');
      const extraction = extractor.extract(loaded, 'greeter.rs', FIXTURES.rust, { mtimeMs: 1, size: FIXTURES.rust.length }, null);

      const greetMethod = extraction.symbols.find((s) => s.name === 'greet' && s.kind === 'method');
      expect(greetMethod!.qualified).toBe('Greeter::greet');
      // The scope qualifies but is not itself a symbol: `greet`'s parent is
      // the struct captured separately, not an impl_item node.
      const structs = extraction.symbols.filter((s) => s.name === 'Greeter');
      expect(structs).toHaveLength(1);
      expect(structs[0]!.kind).toBe('struct');
    });

    it('marks trait-method calls unresolved by design, plain calls resolved by name', async () => {
      const loaded = await registry.load('rust');
      const extraction = extractor.extract(loaded, 'greeter.rs', FIXTURES.rust, { mtimeMs: 1, size: FIXTURES.rust.length }, null);

      const calls = extraction.refs.filter((r) => r.kind === 'CALLS');
      expect(calls.some((c) => c.name === 'helper')).toBe(true);
      expect(calls.some((c) => c.name === 'greet')).toBe(true);
    });

    it('marks a syntax-broken file parseError without throwing', async () => {
      const loaded = await registry.load('rust');
      const broken = 'fn broken( {';
      const extraction = extractor.extract(loaded, 'broken.rs', broken, { mtimeMs: 1, size: broken.length }, null);
      expect(extraction.parseError).toBe(true);
    });

    it('threads the crate property through', async () => {
      const loaded = await registry.load('rust');
      const extraction = extractor.extract(loaded, 'greeter.rs', FIXTURES.rust, { mtimeMs: 1, size: FIXTURES.rust.length }, 'pairs_core');
      expect(extraction.crate).toBe('pairs_core');
    });
  });

  // Calls through a parameter (callbacks, injected ports) name a local
  // binding, not a workspace symbol. Parameters are not indexed as symbols, so
  // emitting a ref lets the resolver's global name ladder bind it to the only
  // same-named symbol anywhere — a *confirmed* cross-module CALLS edge. In
  // this repo `pick(e)` in analyze/hierarchy.ts bound to adapters/bench's
  // `pick` and raised a false Tier-1 layering error.
  describe('parameter-shadowed calls emit no edge', () => {
    const cases: Array<[CodeLang, string, string]> = [
      ['typescript', 'function walk(pick: F) { return pick(1); }', 'ts'],
      ['python', 'def walk(pick):\n    return pick(1)\n', 'py'],
      ['rust', 'fn walk(pick: F) -> u32 { pick(1) }', 'rs'],
    ];
    for (const [lang, src, ext] of cases) {
      it(`suppresses the callback ref in ${lang}`, async () => {
        const loaded = await registry.load(lang);
        const extraction = extractor.extract(loaded, `cb.${ext}`, src, { mtimeMs: 1, size: src.length }, null);
        const picks = extraction.refs.filter((r) => r.kind === 'CALLS' && r.name === 'pick');
        expect(picks).toHaveLength(0);
      });
    }

    // Only the shadowed scope is suppressed — a call to the same name from a
    // function that does NOT bind it is a real reference and must survive.
    it('keeps a same-named call made outside the shadowing function', async () => {
      const loaded = await registry.load('typescript');
      const src = 'function walk(pick: F) { return pick(1); }\nfunction other() { return pick(2); }';
      const extraction = extractor.extract(loaded, 'cb2.ts', src, { mtimeMs: 1, size: src.length }, null);
      // `other` binds no `pick`, so its call is a genuine workspace ref.
      const fromOther = extraction.refs.filter((r) => r.kind === 'CALLS' && r.name === 'pick');
      expect(fromOther.length).toBeGreaterThan(0);
    });
  });
});
