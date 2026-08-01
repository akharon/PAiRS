import { describe, expect, it } from 'vitest';
import { importCandidatePaths, parentDir } from './importPath';

describe('importCandidatePaths', () => {
  it('resolves a relative TS specifier against the importing file', () => {
    const out = importCandidatePaths('src/adapters/vscode/extension.ts', '../../store/graph/codeStore');
    expect(out).toContain('src/store/graph/codeStore.ts');
    // Directory entry points are probed too, after the direct file.
    expect(out).toContain('src/store/graph/codeStore/index.ts');
    expect(out.indexOf('src/store/graph/codeStore.ts')).toBeLessThan(out.indexOf('src/store/graph/codeStore/index.ts'));
  });

  it('rewrites a TS-ESM .js specifier to its source extension first', () => {
    const out = importCandidatePaths('src/a/b.ts', './c.js');
    expect(out[0]).toBe('src/a/c.ts');
    expect(out).toContain('src/a/c.js');
  });

  it('keeps a sibling import inside the importing directory', () => {
    expect(importCandidatePaths('src/core/tools/executors.ts', './tools')).toContain('src/core/tools/tools.ts');
  });

  it('returns nothing for Rust use paths and node builtins', () => {
    expect(importCandidatePaths('src/lib.rs', 'crate::store::codeStore')).toEqual([]);
    expect(importCandidatePaths('src/a.ts', 'node:fs/promises')).toEqual([]);
  });

  it('resolves Python relative and absolute dotted imports', () => {
    expect(importCandidatePaths('pkg/sub/mod.py', '.sibling')).toContain('pkg/sub/sibling.py');
    expect(importCandidatePaths('pkg/sub/mod.py', '..other.thing')).toContain('pkg/other/thing.py');
    // Absolute dotted: package root may be the repo root or any ancestor.
    const abs = importCandidatePaths('src/pkg/sub/mod.py', 'pkg.util');
    expect(abs).toContain('src/pkg/util.py');
    expect(abs).toContain('pkg/util.py');
    expect(abs).toContain('pkg/util/__init__.py');
  });

  it('probes a C include as a sibling and from the repo root', () => {
    const out = importCandidatePaths('src/core/parse.c', '"util.h"');
    expect(out).toContain('src/core/util.h');
    expect(out).toContain('util.h');
  });

  it('never escapes the repo root', () => {
    expect(importCandidatePaths('a.ts', '../../outside')).toEqual([]);
  });
});

describe('parentDir', () => {
  it('returns the empty string for a repo-root file', () => {
    expect(parentDir('esbuild.mjs')).toBe('');
    expect(parentDir('src/a/b.ts')).toBe('src/a');
  });
});
