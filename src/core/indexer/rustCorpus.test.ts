/**
 * Golden corpus for Rust extraction (plan.md deliverable 0.6 / Phase 0 exit
 * criterion: "40+ fixtures covering fns, impl blocks, traits, `use` forms,
 * method calls, macros").
 *
 * Rust is v1's only *validated* language (types.ts V1_VALIDATED_LANGS), so it
 * gets a corpus rather than the one-fixture-per-language smoke sweep in
 * pipeline.test.ts. Each case is a minimal snippet plus an assertion about what
 * the extractor must produce from it.
 *
 * Cases are marked where they pin a **known v1 limitation** rather than desired
 * behaviour. Those are deliberate: they document the gap and fail loudly the day
 * someone fixes it. Every such case names the plan.md decision it follows from.
 *
 * Requires dist/grammars (npm run fetch-grammars) — real tree-sitter wasm.
 */

import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtractorImpl } from './extractorImpl';
import { fileQuerySource, ParserRegistryImpl } from './parserRegistryImpl';
import type { FileExtraction, RawRef, SymbolKind } from './types';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, 'queries');

let extract: (src: string) => FileExtraction;

beforeAll(async () => {
  const registry = new ParserRegistryImpl(GRAMMARS_DIR, fileQuerySource(QUERIES_DIR));
  await registry.init();
  const loaded = await registry.load('rust');
  const extractor = new ExtractorImpl();
  extract = (src) => extractor.extract(loaded, 'fixture.rs', src, { mtimeMs: 1, size: src.length }, null);
});

/** Non-module symbols; the extractor always synthesizes a module symbol at [0]. */
function symbols(x: FileExtraction): Array<{ name: string; qualified: string; kind: SymbolKind; exported: boolean }> {
  return x.symbols.filter((s) => s.kind !== 'module').map((s) => ({ name: s.name, qualified: s.qualified, kind: s.kind, exported: s.exported }));
}

function find(x: FileExtraction, name: string, kind?: SymbolKind) {
  return symbols(x).find((s) => s.name === name && (kind === undefined || s.kind === kind));
}

function calls(x: FileExtraction): RawRef[] {
  return x.refs.filter((r) => r.kind === 'CALLS');
}

describe('rust corpus: functions', () => {
  it('extracts a bare free function', () => {
    expect(find(extract(`fn solo() {}`), 'solo')).toMatchObject({ kind: 'function', qualified: 'solo', exported: false });
  });

  it('marks pub functions exported', () => {
    expect(find(extract(`pub fn open() {}`), 'open')!.exported).toBe(true);
  });

  it('treats pub(crate) as exported', () => {
    expect(find(extract(`pub(crate) fn internal() {}`), 'internal')!.exported).toBe(true);
  });

  it('captures a parameter list and return type as the signature', () => {
    const x = extract(`fn add(a: i32, b: i32) -> i32 { a + b }`);
    const sym = x.symbols.find((s) => s.name === 'add')!;
    expect(sym.signature).toContain('a: i32');
    expect(sym.signature).toContain('i32');
  });

  it('extracts a generic function with a where clause', () => {
    expect(find(extract(`fn map_it<T, U>(v: Vec<T>) -> Vec<U> where T: Into<U> { unimplemented!() }`), 'map_it')).toBeDefined();
  });

  it('extracts an async function', () => {
    expect(find(extract(`async fn fetch() -> u8 { 0 }`), 'fetch')).toBeDefined();
  });

  it('extracts an unsafe function', () => {
    expect(find(extract(`unsafe fn raw() {}`), 'raw')).toBeDefined();
  });

  it('extracts an extern "C" function', () => {
    expect(find(extract(`pub extern "C" fn ffi() {}`), 'ffi')).toBeDefined();
  });

  it('extracts a const fn', () => {
    expect(find(extract(`const fn zero() -> u8 { 0 }`), 'zero')).toBeDefined();
  });

  it('extracts a function taking a closure parameter', () => {
    expect(find(extract(`fn apply<F: Fn(i32) -> i32>(f: F) -> i32 { f(1) }`), 'apply')).toBeDefined();
  });

  it('extracts a function with a lifetime parameter', () => {
    expect(find(extract(`fn longest<'a>(x: &'a str) -> &'a str { x }`), 'longest')).toBeDefined();
  });

  it('does not extract a local variable as a symbol', () => {
    // v1: only module/impl/trait-scope declarations are symbols (extractors.ts).
    const x = extract(`fn outer() { let inner = 5; }`);
    expect(find(x, 'inner')).toBeUndefined();
  });

  it('does not extract a nested fn as a top-level function', () => {
    // The top-level pattern is anchored under source_file.
    const x = extract(`fn outer() { fn nested() {} }`);
    expect(find(x, 'outer')).toBeDefined();
    expect(find(x, 'nested')).toBeUndefined();
  });
});

describe('rust corpus: types', () => {
  it('extracts a struct with named fields', () => {
    expect(find(extract(`pub struct Point { x: f64, y: f64 }`), 'Point')).toMatchObject({ kind: 'struct', exported: true });
  });

  it('extracts a tuple struct', () => {
    expect(find(extract(`struct Meters(f64);`), 'Meters')).toMatchObject({ kind: 'struct' });
  });

  it('extracts a unit struct', () => {
    expect(find(extract(`struct Marker;`), 'Marker')).toMatchObject({ kind: 'struct' });
  });

  it('extracts a generic struct', () => {
    expect(find(extract(`pub struct Wrapper<T> { inner: T }`), 'Wrapper')).toMatchObject({ kind: 'struct' });
  });

  it('extracts an enum', () => {
    expect(find(extract(`pub enum State { On, Off }`), 'State')).toMatchObject({ kind: 'enum', exported: true });
  });

  it('extracts an enum with data-carrying variants', () => {
    expect(find(extract(`enum Shape { Circle(f64), Rect { w: f64, h: f64 } }`), 'Shape')).toMatchObject({ kind: 'enum' });
  });

  it('extracts a trait as an interface', () => {
    expect(find(extract(`pub trait Draw { fn draw(&self); }`), 'Draw')).toMatchObject({ kind: 'interface', exported: true });
  });

  it('extracts a const item', () => {
    expect(find(extract(`pub const MAX: u32 = 10;`), 'MAX')).toMatchObject({ kind: 'var', exported: true });
  });

  it('attaches a doc comment to a struct', () => {
    const x = extract(`// A point in space.\npub struct Point { x: f64 }`);
    expect(x.symbols.find((s) => s.name === 'Point')!.doc).toContain('A point in space.');
  });

  it('records a struct’s line span', () => {
    const x = extract(`\n\nstruct Multi {\n  a: u8,\n}`);
    const sym = x.symbols.find((s) => s.name === 'Multi')!;
    expect(sym.startLine).toBe(3);
    expect(sym.endLine).toBe(5);
  });
});

describe('rust corpus: impl blocks', () => {
  const IMPL = `
pub struct Greeter { name: String }
impl Greeter {
    pub fn new(name: String) -> Self { Greeter { name } }
    fn greet(&self) -> String { format(&self.name) }
}
fn format(s: &str) -> String { s.to_string() }
`;

  it('qualifies impl methods through the impl scope', () => {
    // The S1 precision fix: `impl` is a @scope capture, so methods qualify by
    // their type instead of colliding on a bare name (plan.md S1).
    expect(find(extract(IMPL), 'new', 'method')!.qualified).toBe('Greeter::new');
    expect(find(extract(IMPL), 'greet', 'method')!.qualified).toBe('Greeter::greet');
  });

  it('does not emit a duplicate symbol for the impl block itself', () => {
    const greeters = symbols(extract(IMPL)).filter((s) => s.name === 'Greeter');
    expect(greeters).toHaveLength(1);
    expect(greeters[0]!.kind).toBe('struct');
  });

  it('classifies impl methods as method, not function', () => {
    expect(find(extract(IMPL), 'new')!.kind).toBe('method');
  });

  it('respects per-method visibility inside an impl', () => {
    const x = extract(IMPL);
    expect(find(x, 'new', 'method')!.exported).toBe(true);
    expect(find(x, 'greet', 'method')!.exported).toBe(false);
  });

  it('extracts every method of a multi-method impl', () => {
    // Regression: an earlier query form silently dropped all but the first.
    const x = extract(`struct S;\nimpl S {\n fn m1(&self) {}\n fn m2(&self) {}\n fn m3(&self) {}\n}`);
    expect(symbols(x).filter((s) => s.kind === 'method').map((s) => s.qualified)).toEqual(['S::m1', 'S::m2', 'S::m3']);
  });

  it('qualifies a trait impl’s method by the type, keeping it distinct from the trait’s own signature', () => {
    // `impl T for S` must scope by `type:` (S), not `trait:` (T) — otherwise the
    // impl's method collides with the trait signature it implements.
    const x = extract(`struct S;\ntrait T { fn go(&self); }\nimpl T for S { fn go(&self) {} }`);
    expect(symbols(x).filter((s) => s.kind === 'method').map((s) => s.qualified).sort()).toEqual(['S::go', 'T::go']);
  });

  it('records an IMPLEMENTS ref for a trait impl', () => {
    const x = extract(`struct S;\nimpl Draw for S {}`);
    expect(x.refs.some((r) => r.kind === 'IMPLEMENTS' && r.name === 'Draw')).toBe(true);
  });

  it('extracts trait method signatures without bodies', () => {
    const x = extract(`pub trait Draw { fn draw(&self); fn area(&self) -> f64; }`);
    expect(symbols(x).filter((s) => s.kind === 'method').map((s) => s.qualified)).toEqual(['Draw::draw', 'Draw::area']);
  });

  it('records a supertrait as an EXTENDS-style ref', () => {
    const x = extract(`pub trait Shape: Draw {}`);
    expect(x.refs.some((r) => r.name === 'Draw')).toBe(true);
  });

  it('qualifies methods inside an inherent impl on a generic type', () => {
    const x = extract(`struct Wrapper<T> { v: T }\nimpl<T> Wrapper<T> { fn get(&self) -> &T { &self.v } }`);
    expect(find(x, 'get', 'method')!.qualified).toBe('Wrapper::get');
  });
});

describe('rust corpus: modules', () => {
  it('qualifies items through a mod scope', () => {
    const x = extract(`mod inner { pub fn helper() {} }`);
    expect(find(x, 'helper')!.qualified).toBe('inner::helper');
  });

  it('qualifies through nested mod scopes', () => {
    const x = extract(`mod a { mod b { fn deep() {} } }`);
    expect(find(x, 'deep')!.qualified).toBe('a::b::deep');
  });

  it('qualifies an impl inside a mod by both scopes', () => {
    const x = extract(`mod shapes { struct C; impl C { fn area(&self) {} } }`);
    expect(find(x, 'area', 'method')!.qualified).toBe('shapes::C::area');
  });
});

describe('rust corpus: use forms', () => {
  it('records a simple use path', () => {
    expect(extract(`use std::io::Read;`).uses.map((u) => u.specifier)).toEqual(['std::io::Read']);
  });

  it('records a braced use list', () => {
    expect(extract(`use std::io::{Read, Write};`).uses).toHaveLength(1);
  });

  it('flags a glob use', () => {
    expect(extract(`use bevy::prelude::*;`).uses[0]!.isGlob).toBe(true);
  });

  it('records an aliased use', () => {
    expect(extract(`use std::io::Result as IoResult;`).uses[0]!.specifier).toContain('Result');
  });

  it('records a crate-relative use', () => {
    expect(extract(`use crate::map::loader;`).uses[0]!.specifier).toBe('crate::map::loader');
  });

  it('records multiple use statements separately', () => {
    expect(extract(`use std::io::Read;\nuse std::fmt::Debug;`).uses).toHaveLength(2);
  });
});

describe('rust corpus: calls and refs', () => {
  it('records a bare call with no qualifier', () => {
    const x = extract(`fn a() { b(); }\nfn b() {}`);
    expect(calls(x).find((r) => r.name === 'b')).toMatchObject({ qualifiedName: null });
  });

  it('keeps the qualifier on a scoped call', () => {
    // The S1 fix: `Foo::new` must reach the resolver qualified, or every
    // `X::new()` collapses onto one bare `new` (plan.md S1).
    const x = extract(`fn a() { Greeter::new(); }`);
    expect(calls(x).find((r) => r.name === 'new')).toMatchObject({ qualifiedName: 'Greeter::new' });
  });

  it('keeps the full path on an absolute call', () => {
    const x = extract(`fn a() { crate::map::loader::load_map(); }`);
    expect(calls(x).find((r) => r.name === 'load_map')!.qualifiedName).toBe('crate::map::loader::load_map');
  });

  it('records a method call, unqualified', () => {
    // Known v1 limitation (plan.md S1, deferred to v1.1): a `.` receiver is a
    // *value*, and v1 does not infer its type — so this reaches the resolver
    // bare and can only resolve fuzzily. `qualifiedName` stays null on purpose:
    // `engine.start` would never match a `qualified` and would silently disable
    // the bare-name fallback.
    const x = extract(`fn a(e: Engine) { e.start(); }`);
    expect(calls(x).find((r) => r.name === 'start')).toMatchObject({ qualifiedName: null });
  });

  it('strips a self receiver from a method call', () => {
    const x = extract(`struct S;\nimpl S { fn a(&self) { self.b(); } fn b(&self) {} }`);
    expect(calls(x).find((r) => r.name === 'b')).toMatchObject({ qualifiedName: null });
  });

  it('attributes a call to its enclosing function', () => {
    const x = extract(`fn caller() { callee(); }\nfn callee() {}`);
    const ref = calls(x).find((r) => r.name === 'callee')!;
    expect(x.symbols[ref.fromIndex]!.name).toBe('caller');
  });

  it('attributes a call inside an impl method to that method', () => {
    const x = extract(`struct S;\nimpl S { fn m(&self) { helper(); } }\nfn helper() {}`);
    const ref = calls(x).find((r) => r.name === 'helper')!;
    expect(x.symbols[ref.fromIndex]!.qualified).toBe('S::m');
  });

  it('attributes a ref to the innermost enclosing def, else the module', () => {
    // `compute()` sits inside the const initializer, so it attributes to X, not
    // the module — the module symbol is the fallback only when nothing encloses.
    const x = extract(`const X: u8 = compute();\nuse_at_top!();`);
    const inConst = x.refs.find((r) => r.name === 'compute')!;
    expect(x.symbols[inConst.fromIndex]!.name).toBe('X');
    const atFileScope = x.refs.find((r) => r.name === 'use_at_top');
    if (atFileScope) expect(x.symbols[atFileScope.fromIndex]!.kind).toBe('module');
  });

  it('records the call site line', () => {
    const x = extract(`fn a() {\n\n  target();\n}`);
    expect(calls(x).find((r) => r.name === 'target')!.line).toBe(3);
  });

  it('records a chained call’s final segment', () => {
    const x = extract(`fn a(s: String) { s.trim().to_string(); }`);
    expect(calls(x).some((r) => r.name === 'to_string')).toBe(true);
  });
});

describe('rust corpus: macros', () => {
  // Macros are allowed to be unresolved, but must be *counted* (plan.md 0.6).
  it('records a macro invocation as a ref', () => {
    const x = extract(`fn a() { println!("hi"); }`);
    expect(x.refs.some((r) => r.name === 'println')).toBe(true);
  });

  it('records vec! as a ref', () => {
    expect(extract(`fn a() { let v = vec![1, 2]; }`).refs.some((r) => r.name === 'vec')).toBe(true);
  });

  it('records assert_eq! as a ref', () => {
    expect(extract(`fn t() { assert_eq!(1, 1); }`).refs.some((r) => r.name === 'assert_eq')).toBe(true);
  });

  it('extracts items alongside a derive attribute', () => {
    const x = extract(`#[derive(Debug, Clone)]\npub struct Config { v: u8 }`);
    expect(find(x, 'Config')).toMatchObject({ kind: 'struct', exported: true });
  });

  it('extracts a function carrying an attribute', () => {
    expect(find(extract(`#[inline]\nfn fast() {}`), 'fast')).toBeDefined();
  });

  it('extracts a #[test] function', () => {
    expect(find(extract(`#[test]\nfn it_works() { assert!(true); }`), 'it_works')).toBeDefined();
  });

  it('extracts items from inside a cfg(test) mod', () => {
    const x = extract(`#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() {}\n}`);
    expect(find(x, 't')!.qualified).toBe('tests::t');
  });
});

describe('rust corpus: resilience', () => {
  it('flags a syntax error but still indexes what parsed', () => {
    const x = extract(`fn good() {}\nfn broken( {`);
    expect(x.parseError).toBe(true);
    expect(find(x, 'good')).toBeDefined();
  });

  it('handles an empty file', () => {
    const x = extract(``);
    expect(x.parseError).toBe(false);
    expect(symbols(x)).toEqual([]);
  });

  it('handles a comment-only file', () => {
    expect(extract(`// nothing here\n`).parseError).toBe(false);
  });

  it('handles CRLF line endings', () => {
    expect(find(extract(`fn a() {}\r\nfn b() {}\r\n`), 'b')).toBeDefined();
  });

  it('handles non-ASCII identifiers and string content', () => {
    const x = extract(`fn greet() -> &'static str { "héllo wörld" }`);
    expect(x.parseError).toBe(false);
    expect(find(x, 'greet')).toBeDefined();
  });

  it('is deterministic: same source, same hash', () => {
    const src = `fn a() { b(); }\nfn b() {}`;
    expect(extract(src).hash).toBe(extract(src).hash);
  });

  it('changes the hash when the source changes', () => {
    expect(extract(`fn a() {}`).hash).not.toBe(extract(`fn b() {}`).hash);
  });

  it('always synthesizes the module symbol at index 0', () => {
    expect(extract(`fn a() {}`).symbols[0]!.kind).toBe('module');
  });
});
