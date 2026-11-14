/**
 * Regression: `impact` / `who_calls` must not report "nothing depends on this"
 * for classes reached via `new X()`, types reached via annotations, or static
 * methods reached via `Cls.m()`. Real parse -> extract -> store pipeline.
 */

import { describe, expect, it } from 'vitest';
import { indexProject } from './indexProject';
import { impact } from '../core/analyze/impact';
import type { CodeStore } from '../store/graph/codeStore';

async function id(store: CodeStore, name: string): Promise<number> {
  const r = await store.lookup(name);
  if (!Array.isArray(r) || r.length !== 1) throw new Error(`expected one symbol for ${name}`);
  return r[0]!.id;
}

async function dependantNames(store: CodeStore, name: string): Promise<string[]> {
  const res = await impact(store, await id(store, name));
  return (res?.dependants ?? []).map((d) => d.symbol.qualified);
}

const FILES = {
  'src/engine.ts': `
export class Engine {
  static create(): Engine { return new Engine(); }
  run(): void {}
}
export interface Config { name: string }
export type Id = string;
`,
  'src/app.ts': `
import { Engine, Config } from './engine';
export function boot(): void { const e = new Engine(); e.run(); }
export function describeIt(cfg: Config): string { return cfg.name; }
export function make(): Engine { return Engine.create(); }
export class Holder { private cfg: Config | undefined; }
export const o: Config = { name: 'x' };
`,
};

describe('constructor / type-annotation / static-call edges', () => {
  it('impact of a class reaches code that only does `new X()`', async () => {
    const { store } = await indexProject(FILES);
    expect(await dependantNames(store, 'Engine')).toContain('boot');
  });

  it('impact of an interface reaches parameter, field and variable annotations', async () => {
    const { store } = await indexProject(FILES);
    const deps = await dependantNames(store, 'Config');
    expect(deps).toContain('describeIt');
    expect(deps).toContain('Holder.cfg');
  });

  it('who_calls of a static method finds `Cls.m()` call sites as resolved', async () => {
    const { store } = await indexProject(FILES);
    const create = await id(store, 'Engine.create');
    const edges = await store.edgesTo([create], ['CALLS']);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.confidence === 'resolved')).toBe(true);
  });

  it('a structural `const x: I = {...}` emits IMPLEMENTS only, not also REFERENCES', async () => {
    const { store } = await indexProject(FILES);
    const cfg = await id(store, 'Config');
    const rows = await store.query(`SELECT kind, COUNT(*) n FROM Edge WHERE dst = ${cfg} AND src IN (SELECT id FROM Symbol WHERE name = 'app.ts') GROUP BY kind`);
    const byKind = Object.fromEntries(rows.map((r) => [String(r.kind), Number(r.n)]));
    expect(byKind['IMPLEMENTS']).toBe(1);
    expect(byKind['REFERENCES']).toBeUndefined();
  });

  it('a member that mentions its own enclosing type adds no self-dependency', async () => {
    const { store } = await indexProject(FILES);
    // `static create(): Engine` names Engine in its return type; only the `new Engine()` CALLS edge may exist.
    const eng = await id(store, 'Engine');
    const rows = await store.query(`SELECT COUNT(*) n FROM Edge WHERE dst = ${eng} AND kind = 'REFERENCES' AND src = ${await id(store, 'Engine.create')}`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
