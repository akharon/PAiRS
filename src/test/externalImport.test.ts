/**
 * Imported external names must never bind to a workspace namesake.
 *
 * The bare-name rung treats "only one workspace match" as proof and returns
 * `resolved`. Uniqueness inside the workspace says nothing about whether the
 * call targets it: on this repo `Parser.expect` (core/rules/ron.ts) was the
 * only `expect` indexed, so all 385 vitest `expect()` calls bound to it as
 * CONFIRMED — inflating the tools→rules boundary from ~13 refs to 107 and
 * putting a false Tier-1 dependency in front of every agent that asked.
 *
 * Runs the real parse → extract → resolve pipeline, since the bug lived in the
 * seam between extraction (which knows the imports) and resolvePending (which
 * re-resolves parked refs after that knowledge is gone).
 */

import { describe, expect, it } from 'vitest';
import { indexProject } from './indexProject';

/** CALLS edges into `name`, as `file:confidence` pairs. */
async function callsInto(store: { query: (sql: string) => Promise<Record<string, unknown>[]> }, name: string): Promise<string[]> {
  const rows = await store.query(
    `SELECT s.file AS file, e.confidence AS confidence
       FROM Edge e JOIN Symbol s ON s.id = e.src JOIN Symbol d ON d.id = e.dst
      WHERE e.kind = 'CALLS' AND d.name = '${name}'`
  );
  return rows.map((r) => `${String(r.file)}:${String(r.confidence)}`);
}

describe('external imports do not bind to workspace namesakes', () => {
  it('does not bind an imported external name to the only workspace symbol of that name', async () => {
    const { store } = await indexProject({
      // The only `expect` in the workspace.
      'src/ron.ts': 'export class Parser {\n  expect(s: string): string {\n    return s;\n  }\n}\n',
      // Imports `expect` from a package, so its call is external.
      'src/a.test.ts': "import { expect } from 'vitest';\nexport function t(): void {\n  expect(1);\n}\n",
    });
    expect(await callsInto(store, 'expect')).toEqual([]);
  });

  // The guard must key on the imported NAME, not merely on the file importing
  // something external — a test file also makes real workspace calls.
  it('still resolves genuine workspace calls from a file that imports externals', async () => {
    const { store } = await indexProject({
      'src/util.ts': 'export function helper(): number {\n  return 1;\n}\n',
      'src/a.test.ts':
        "import { expect } from 'vitest';\nimport { helper } from './util';\nexport function t(): void {\n  expect(helper());\n}\n",
    });
    expect(await callsInto(store, 'expect')).toEqual([]);
    expect(await callsInto(store, 'helper')).toEqual(['src/a.test.ts:resolved']);
  });

  // Regression: classifying externality by "does the specifier resolve to an
  // indexed file" made this depend on index order, and marked `helper`
  // external whenever util.ts happened to be indexed after main.ts.
  it('keeps a relative import resolvable regardless of index order', async () => {
    const { store } = await indexProject({
      'app/main.ts': "import { helper } from '../lib/util';\nexport function run(): number {\n  return helper();\n}\n",
      'lib/util.ts': 'export function helper(): number {\n  return 1;\n}\n',
    });
    expect(await callsInto(store, 'helper')).toEqual(['app/main.ts:resolved']);
  });
});
