/**
 * Self-index smoke test: run PAiRS's own src/**\/*.ts through the real
 * pipeline and assert module_map finds a real, non-degenerate dependency
 * graph. This repo's own TypeScript imports are exactly the shape
 * ('../store/graph/codeStore') that the path-style-import bug broke on every
 * non-Rust repo — indexing PAiRS itself is the most direct regression guard
 * for that bug class, on top of polyglot.test.ts's synthetic per-language
 * cases.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { moduleMap } from '../core/analyze/moduleMap';
import { indexProject } from './indexProject';

const REPO_ROOT = path.join(__dirname, '..', '..');

function ownTsFiles(): Record<string, string> {
  const relPaths = execSync('git ls-files "src/**/*.ts"', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const files: Record<string, string> = {};
  for (const rel of relPaths) {
    // git ls-files reports staged deletions too; skip anything already gone.
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    files[rel] = fs.readFileSync(abs, 'utf8');
  }
  return files;
}

describe('self-index smoke test', () => {
  it('indexes this repo\'s own source and finds a real, non-degenerate module graph', async () => {
    const files = ownTsFiles();
    expect(Object.keys(files).length).toBeGreaterThan(20); // sanity: git ls-files actually found the tree

    const { store } = await indexProject(files);

    const map = await moduleMap(store);
    expect(map.modules.length).toBeGreaterThanOrEqual(5);
    expect(map.edges.length).toBeGreaterThanOrEqual(10);
    expect(map.driftRatio).toBeLessThan(1);

    // Ratchet: fails the build if precision regresses. Measured on the
    // self-index, 2026-08-26 (after the Edge(src,dst,kind,line) unique index
    // started collapsing same-site duplicate ref edges — e.g. a name called
    // twice on one line — into one row, which is correct: the schema has no
    // per-occurrence granularity beyond that key, so it was never counting
    // distinct call sites): fuzzyRate ~0.48, unresolvedRatio ~0.615, both
    // with run-to-run noise of a few tenths of a percent (file processing
    // order affects ambiguous-fuzzy tie-breaks). Ceilings sit above the
    // observed noise band so they don't flake.
    const stats = await store.stats();
    expect(stats.fuzzyRate).toBeLessThanOrEqual(0.51);
    expect(stats.unresolvedRatio).toBeLessThanOrEqual(0.63);
  });
});
