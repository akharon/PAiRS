/**
 * `git diff` → DiffHunk[], for `pairs diff_impact`.
 *
 * Lives in platform/ rather than in either adapter: both the CLI and the VS
 * Code extension need it, and core/analyze/diffImpact.ts must stay free of I/O
 * (R10), so it takes already-parsed hunks and this module owns the git call.
 *
 * Always invoked with --unified=0 so a hunk header's line range covers only
 * genuinely changed lines. With the default 3 lines of context a small edit
 * near a function boundary would report the neighbouring function as changed
 * too, seeding a walk the diff never justified.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiffHunk } from '../core/analyze/diffImpact';

const run = promisify(execFile);

/** `@@ -a,b +c,d @@` — only the +side matters; the -side is gone from the tree. */
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE_RE = /^\+\+\+ (?:b\/)?(.+)$/;

/**
 * Parse unified-diff text. Exported for testing without a git repository.
 *
 * A deleted file yields `+++ /dev/null` and is skipped: its symbols are gone
 * from the working tree, so there is nothing to seed a walk from. Deleting a
 * file is a `file_deps --direction importers` question, not a diff_impact one.
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  for (const line of text.split('\n')) {
    const f = NEW_FILE_RE.exec(line);
    if (f) {
      const p = f[1]!.trim();
      path = p === '/dev/null' ? null : p;
      continue;
    }
    if (path === null) continue;
    const h = HUNK_RE.exec(line);
    if (!h) continue;
    const start = Number(h[1]);
    // `+c,0` marks a pure deletion: no line exists at `c` in the new file, and
    // the edit sits between c and c+1. Attribute it to line c so it still
    // lands inside the enclosing symbol's span rather than being dropped.
    const count = h[2] === undefined ? 1 : Number(h[2]);
    const startLine = count === 0 ? Math.max(1, start) : start;
    const endLine = count === 0 ? startLine : start + count - 1;
    hunks.push({ path, startLine, endLine });
  }
  return hunks;
}

export interface DiffSource {
  /** Any git revision or range, e.g. "HEAD", "main...HEAD". Omit for the working tree. */
  rev?: string;
  /** Compare the index too (`git diff --staged`). Ignored when `rev` is set. */
  staged?: boolean;
}

/**
 * Collect changed hunks from git. Untracked files are not included — git does
 * not diff them; `--intent-to-add` them first if they should count.
 */
export async function collectDiffHunks(cwd: string, src: DiffSource = {}): Promise<DiffHunk[]> {
  const args = ['diff', '--unified=0', '--no-color', '--no-ext-diff'];
  if (src.rev) args.push(src.rev);
  else if (src.staged) args.push('--staged');
  // maxBuffer: a large refactor's diff can exceed node's 1 MB default and
  // would otherwise fail with an opaque ENOBUFS.
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return parseUnifiedDiff(stdout);
}
