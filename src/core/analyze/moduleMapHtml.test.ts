import { describe, expect, it } from 'vitest';
import { moduleMapHtml } from './moduleMapHtml';
import type { ModuleMap } from './moduleMap';

describe('moduleMapHtml', () => {
  it('renders modules, edges, and marks drift', () => {
    const map: ModuleMap = {
      modules: ['src/a', 'src/b', 'src/c'],
      edges: [
        { from: 'src/a', to: 'src/b', weight: 3 },
        { from: 'src/a', to: 'src/c', weight: 1 },
      ],
      clusters: [
        { id: 0, modules: ['src/a', 'src/b'] },
        { id: 1, modules: ['src/c'] },
      ],
      driftRatio: 0.25,
      drift: [{ from: 'src/a', to: 'src/c', weight: 1 }],
    };
    const html = moduleMapHtml(map);
    expect(html).toContain('src/a');
    expect(html).toContain('class="drift"'); // cross-subsystem edge is red
    expect(html).toContain('class="dep"');
    expect(html).toContain('drift 25%');
    expect(html).not.toContain('<script'); // CSP: no scripts, read-only
  });

  it('escapes module names', () => {
    const map: ModuleMap = {
      modules: ['a<b'],
      edges: [],
      clusters: [{ id: 0, modules: ['a<b'] }],
      driftRatio: 0,
      drift: [],
    };
    expect(moduleMapHtml(map)).toContain('a&lt;b');
  });
});
