import { describe, expect, it } from 'vitest';
import { moduleKeyOf, moduleMapFromEdges } from './moduleMap';

describe('moduleKeyOf', () => {
  it('uses the parent directory as the module', () => {
    expect(moduleKeyOf('src/a/b.ts')).toBe('src/a');
    expect(moduleKeyOf('root.ts')).toBe('.');
  });

  it('rolls up monorepo containers to container/name', () => {
    expect(moduleKeyOf('crates/globset/src/lib.rs')).toBe('crates/globset');
    expect(moduleKeyOf('packages/core/src/index.ts')).toBe('packages/core');
  });

  it('collapses to the requested depth', () => {
    expect(moduleKeyOf('src/a/b/c/d.ts', { depth: 2 })).toBe('src/a');
  });
});

describe('moduleMapFromEdges', () => {
  it('clusters two cliques joined by a bridge into 2 subsystems with expected drift', () => {
    const modules = ['x/a', 'x/b', 'y/c', 'y/d'];
    const edges = [
      { from: 'x/a', to: 'x/b', weight: 10 },
      { from: 'x/b', to: 'x/a', weight: 10 },
      { from: 'y/c', to: 'y/d', weight: 10 },
      { from: 'y/d', to: 'y/c', weight: 10 },
      { from: 'x/a', to: 'y/c', weight: 1 },
    ];
    const map = moduleMapFromEdges(modules, edges);
    expect(map.clusters).toHaveLength(2);
    const clusterOf = new Map<string, number>();
    map.clusters.forEach((c) => c.modules.forEach((m) => clusterOf.set(m, c.id)));
    expect(clusterOf.get('x/a')).toBe(clusterOf.get('x/b'));
    expect(clusterOf.get('y/c')).toBe(clusterOf.get('y/d'));
    expect(clusterOf.get('x/a')).not.toBe(clusterOf.get('y/c'));
    expect(map.driftRatio).toBeCloseTo(1 / 41, 3);
    expect(map.drift).toEqual([{ from: 'x/a', to: 'y/c', weight: 1 }]);
  });

  it('reports perfect layoutDrift agreement when clusters match top-level directories', () => {
    const modules = ['x/a', 'x/b', 'y/c', 'y/d'];
    const edges = [
      { from: 'x/a', to: 'x/b', weight: 10 },
      { from: 'y/c', to: 'y/d', weight: 10 },
    ];
    const map = moduleMapFromEdges(modules, edges);
    expect(map.layoutDrift).toBeCloseTo(1, 5);
  });

  it('returns singleton clusters for a graph with no edges', () => {
    const map = moduleMapFromEdges(['a', 'b'], []);
    expect(map.clusters).toHaveLength(2);
    expect(map.driftRatio).toBe(0);
  });

  it('reports fan-in/fan-out, instability and dependency layer per module', () => {
    // app → svc → util, plus app → util: util is the foundation, app the leaf.
    const map = moduleMapFromEdges(
      ['app', 'svc', 'util'],
      [
        { from: 'app', to: 'svc', weight: 2 },
        { from: 'svc', to: 'util', weight: 3 },
        { from: 'app', to: 'util', weight: 1 },
      ]
    );
    const m = (name: string) => map.metrics.find((x) => x.module === name)!;
    expect(m('util')).toMatchObject({ fanIn: 2, fanOut: 0, weightIn: 4, instability: 0, layer: 0 });
    expect(m('svc')).toMatchObject({ fanIn: 1, fanOut: 1, instability: 0.5, layer: 1 });
    // layer is the LONGEST path, so app sits above svc even though it also
    // reaches util directly.
    expect(m('app')).toMatchObject({ fanIn: 0, fanOut: 2, instability: 1, layer: 2 });
  });

  it('finds module cycles and gives every module in one the same layer', () => {
    const map = moduleMapFromEdges(
      ['a', 'b', 'c', 'leaf'],
      [
        { from: 'a', to: 'b', weight: 1 },
        { from: 'b', to: 'c', weight: 1 },
        { from: 'c', to: 'a', weight: 1 },
        { from: 'c', to: 'leaf', weight: 1 },
      ]
    );
    expect(map.cycles).toEqual([['a', 'b', 'c']]);
    const layer = (name: string) => map.metrics.find((x) => x.module === name)!.layer;
    expect(layer('leaf')).toBe(0);
    // No ordering exists inside a cycle — all three condense to one layer.
    expect(new Set([layer('a'), layer('b'), layer('c')])).toEqual(new Set([1]));
  });

  it('reports no cycles for a DAG', () => {
    const map = moduleMapFromEdges(['a', 'b'], [{ from: 'a', to: 'b', weight: 1 }]);
    expect(map.cycles).toEqual([]);
    expect(map.cycleCuts).toEqual([]);
  });

  it('suggests the lightest edges whose removal makes the graph acyclic', () => {
    // Two independent cycles: a↔b (back edge weight 1) and c→d→e→c (weight 2
    // on the return leg). One cut each, and each cut is the cheap edge.
    const map = moduleMapFromEdges(
      ['a', 'b', 'c', 'd', 'e'],
      [
        { from: 'a', to: 'b', weight: 9 },
        { from: 'b', to: 'a', weight: 1 },
        { from: 'c', to: 'd', weight: 8 },
        { from: 'd', to: 'e', weight: 7 },
        { from: 'e', to: 'c', weight: 2 },
      ]
    );
    expect(map.cycles).toHaveLength(2);
    expect(map.cycleCuts).toEqual([
      { from: 'b', to: 'a', weight: 1 },
      { from: 'e', to: 'c', weight: 2 },
    ]);
    // The cut is real: removing it leaves an acyclic graph.
    const cut = new Set(map.cycleCuts.map((e) => `${e.from} ${e.to}`));
    const after = moduleMapFromEdges(map.modules, map.edges.filter((e) => !cut.has(`${e.from} ${e.to}`)));
    expect(after.cycles).toEqual([]);
  });

  it('resolution > 1 favors more, smaller clusters on a weakly-bridged graph', () => {
    const modules = ['x/a', 'x/b', 'y/c', 'y/d'];
    const edges = [
      { from: 'x/a', to: 'x/b', weight: 3 },
      { from: 'y/c', to: 'y/d', weight: 3 },
      { from: 'x/b', to: 'y/c', weight: 2 },
    ];
    const loose = moduleMapFromEdges(modules, edges, { resolution: 3 });
    expect(loose.clusters.length).toBeGreaterThanOrEqual(2);
  });
});
