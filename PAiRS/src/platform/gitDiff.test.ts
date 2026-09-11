/**
 * Unified-diff hunk parsing. The cases that matter are the ones where a naive
 * parser loses a change: a pure deletion (`+c,0`), a new file, and a deleted
 * file whose `+++ /dev/null` must not attribute hunks to the previous path.
 */

import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './gitDiff';

describe('parseUnifiedDiff', () => {
  it('reads a single-line change', () => {
    const d = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -12 +12 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseUnifiedDiff(d)).toEqual([{ path: 'src/a.ts', startLine: 12, endLine: 12 }]);
  });

  it('reads a multi-line range', () => {
    const d = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -10,2 +10,3 @@'].join('\n');
    expect(parseUnifiedDiff(d)).toEqual([{ path: 'src/a.ts', startLine: 10, endLine: 12 }]);
  });

  it('keeps a pure deletion as a one-line hunk at the deletion point', () => {
    // `+40,0`: nothing exists at line 40 in the new file, but the enclosing
    // symbol still changed and must seed a walk.
    const d = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -40,3 +40,0 @@'].join('\n');
    expect(parseUnifiedDiff(d)).toEqual([{ path: 'src/a.ts', startLine: 40, endLine: 40 }]);
  });

  it('handles several hunks in several files', () => {
    const d = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '@@ -20,2 +20,2 @@',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5 +5 @@',
    ].join('\n');
    expect(parseUnifiedDiff(d)).toEqual([
      { path: 'src/a.ts', startLine: 1, endLine: 1 },
      { path: 'src/a.ts', startLine: 20, endLine: 21 },
      { path: 'src/b.ts', startLine: 5, endLine: 5 },
    ]);
  });

  it('skips a deleted file without misattributing its hunks', () => {
    const d = [
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      '--- a/src/kept.ts',
      '+++ b/src/kept.ts',
      '@@ -3 +3 @@',
    ].join('\n');
    expect(parseUnifiedDiff(d)).toEqual([{ path: 'src/kept.ts', startLine: 3, endLine: 3 }]);
  });

  it('reads a new file as one whole-body hunk', () => {
    const d = ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,9 @@'].join('\n');
    expect(parseUnifiedDiff(d)).toEqual([{ path: 'src/new.ts', startLine: 1, endLine: 9 }]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
