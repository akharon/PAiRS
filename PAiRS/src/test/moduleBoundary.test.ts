/**
 * module_map's `boundary` drill-down over the real pipeline: a drift number is
 * only actionable if the tool can also name the symbols that make the edge
 * exist, so this pins that path end-to-end (parse → DEPENDS_ON/CALLS edges →
 * rendered text) rather than against a canned store.
 */

import { describe, expect, it } from 'vitest';
import { createExecutors } from '../core/tools/executors';
import { indexProject } from './indexProject';

describe('module_map boundary drill-down', () => {
  it('names the symbols that make one module depend on another', async () => {
    const { store } = await indexProject({
      'lib/util.ts': 'export function helper(): number {\n  return 1;\n}\n',
      'lib/other.ts': "import { helper } from './util';\nexport const two = helper() + 1;\n",
      'app/main.ts': "import { helper } from '../lib/util';\nexport function run(): number {\n  return helper();\n}\n",
    });
    const x = createExecutors({ store });

    const map = await x.module_map({ limit: 20, resolution: 1 });
    expect(map).toContain('app');
    expect(map).toContain('lib');

    const boundary = await x.module_map({ limit: 20, resolution: 1, boundary: 'app -> lib' });
    expect(boundary).toContain('app → lib');
    expect(boundary).toContain('helper');
    expect(boundary).toContain('app/main.ts:');

    // The reverse edge does not exist — say so instead of rendering an empty list.
    expect(await x.module_map({ limit: 20, resolution: 1, boundary: 'lib -> app' })).toContain('does not depend on');
    // Unknown module and malformed spec are user errors, not empty results.
    expect(await x.module_map({ limit: 20, resolution: 1, boundary: 'nope -> lib' })).toContain('Unknown module');
    expect(await x.module_map({ limit: 20, resolution: 1, boundary: 'app' })).toContain('must be');
  }, 60000);
});
