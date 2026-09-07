/**
 * Real-extraction coverage for extractor logic too structural to unit-test
 * against hand-built RawRefs — tree-sitter capture shapes, CST walks. Uses
 * the real parse → extract → store pipeline via indexProject.
 */

import { describe, expect, it } from 'vitest';
import { indexProject } from '../../test/indexProject';

describe('tsReceiverDeclaredType (Step 2.3)', () => {
  it('resolves a method call through a typed parameter to that type’s own member', async () => {
    const { store } = await indexProject({
      'src/widget.ts': `export class Widget {\n  render(): void {}\n}\n`,
      'src/other.ts': `export class OtherThing {\n  render(): void {}\n}\n`,
      'src/app.ts': `import { Widget } from './widget';\nexport function run(w: Widget): void {\n  w.render();\n}\n`,
    });
    const rows = await store.query(
      `SELECT b.qualified AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'run'`
    );
    expect(rows.map((r) => String(r.dst))).toEqual(['Widget.render']);
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  it('resolves a method call through a typed const to that type’s own member', async () => {
    const { store } = await indexProject({
      'src/widget.ts': `export class Widget {\n  render(): void {}\n}\n`,
      'src/other.ts': `export class OtherThing {\n  render(): void {}\n}\n`,
      'src/app.ts': `import { Widget } from './widget';\nexport function run(): void {\n  const w: Widget = new Widget();\n  w.render();\n}\n`,
    });
    const rows = await store.query(
      `SELECT b.qualified AS dst, e.confidence AS conf FROM Edge e
       JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE e.kind = 'CALLS' AND a.qualified = 'run'`
    );
    expect(rows.map((r) => String(r.dst))).toEqual(['Widget.render']);
    expect(String(rows[0]!.conf)).toBe('resolved');
  });

  it('falls back to the fuzzy-capped ladder for an untyped receiver', async () => {
    const { store } = await indexProject({
      'src/widget.ts': `export class Widget {\n  render(): void {}\n}\n`,
      'src/other.ts': `export class OtherThing {\n  render(): void {}\n}\n`,
      'src/app.ts': `export function run(w): void {\n  w.render();\n}\n`,
    });
    const rows = await store.query(
      `SELECT e.confidence AS conf FROM Edge e JOIN Symbol a ON a.id = e.src WHERE e.kind = 'CALLS' AND a.qualified = 'run'`
    );
    expect(String(rows[0]!.conf)).toBe('fuzzy');
  });
});
