import { describe, expect, it } from 'vitest';
import { moduleMapHtml } from './moduleMapHtml';
import { moduleMapFromEdges } from './moduleMap';
import type { ModuleMap } from './moduleMap';

/** Build through moduleMapFromEdges so the fixture can't drift from the real shape. */
function mapOf(modules: string[], edges: Array<[string, string, number]>): ModuleMap {
  return moduleMapFromEdges(
    modules,
    edges.map(([from, to, weight]) => ({ from, to, weight }))
  );
}

describe('moduleMapHtml', () => {
  it('renders modules, edges, and marks drift', () => {
    // Two tightly-coupled pairs joined by one weak edge: Louvain finds two
    // subsystems, so the bridge is drift and the pair edges are ordinary deps.
    const map = mapOf(
      ['src/a', 'src/b', 'src/c', 'src/d'],
      [
        ['src/a', 'src/b', 10],
        ['src/c', 'src/d', 10],
        ['src/a', 'src/c', 1],
      ]
    );
    const html = moduleMapHtml(map);
    expect(html).toContain('src/a');
    expect(html).toContain('class="edge drift"'); // cross-subsystem edge is red
    expect(html).toContain('class="edge dep"');
    expect(html).toContain(`drift ${(map.driftRatio * 100).toFixed(0)}%`);
    expect(html).toContain('layout agreement');
    expect(html).toContain('<script'); // interactive: search, weight slider, collapse, focus, reveal
    expect(html).toContain('data-module="src/a"');
    expect(html).toContain('acquireVsCodeApi');
  });

  it('draws cycle edges as cycles, not as ordinary drift', () => {
    const map = mapOf(
      ['a', 'b'],
      [
        ['a', 'b', 4],
        ['b', 'a', 4],
      ]
    );
    const html = moduleMapHtml(map);
    expect(map.cycles).toEqual([['a', 'b']]);
    expect(html).toContain('class="edge cyc"');
    expect(html).not.toContain('class="edge drift"');
    expect(html).toContain('1 cycle(s)');
    expect(html).toContain('incycle');
  });

  it('shows per-module fan-in/fan-out and arrow direction', () => {
    const html = moduleMapHtml(mapOf(['a', 'b', 'c'], [['a', 'b', 2], ['c', 'b', 2]]));
    expect(html).toContain('marker-end="url(#arrow-'); // edges are directed, visibly
    expect(html).toContain('2 module(s) depend on it'); // b's tooltip
    expect(html).toContain('instability');
  });

  it('emits a syntactically valid inline script', () => {
    // The webview fails silently on a script syntax error — the map renders
    // and simply stops responding to every control. Compile it here (Function
    // parses without executing) so a typo can't ship as "the filters broke".
    const body = /<script>([\s\S]*?)<\/script>/.exec(moduleMapHtml(mapOf(['a', 'b'], [['a', 'b', 1]])))?.[1];
    expect(body).toBeTruthy();
    expect(() => new Function(body!)).not.toThrow();
  });

  it('escapes module names', () => {
    expect(moduleMapHtml(mapOf(['a<b'], []))).toContain('a&lt;b');
  });

  it('renders an empty map without crashing', () => {
    const html = moduleMapHtml(mapOf([], []));
    expect(html).toContain('0 modules');
    expect(html).toContain('0 cycle(s)');
  });
});
