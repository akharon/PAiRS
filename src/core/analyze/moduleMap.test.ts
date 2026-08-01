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
