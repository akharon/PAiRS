/**
 * Rendering/budgeting helpers shared by MemoryToolExecutor and
 * CodeToolExecutor — one truncation behavior for every tool response
 * (invariant #6: one behavior, all transports go through here).
 */

import type { ToolResult } from './tools';
import type { IndexFreshness } from '../index/provenance';
import { estimateTokens } from '../core/tokens';

/**
 * One-line trust header for code-tool responses (docs/MemoryIndexSynergy.md
 * §F1) — replaces the old bare "updated <ISO>" with a commit-aware lag
 * report so agents can decide whether to trust a result or re-query.
 */
export function freshnessFooter(f: IndexFreshness): string {
  if (!f.generation) return 'index: never built';

  const shaFrag = f.generation.commit ? ` @ ${f.generation.commit.slice(0, 7)}` : '';
  const branchFrag = f.generation.branch ? ` (${f.generation.branch})` : '';
  const dirtyFrag = f.generation.dirtyPaths.length > 0 ? ` +${f.generation.dirtyPaths.length} dirty` : '';
  const base = `index${shaFrag}${branchFrag}${dirtyFrag}`;

  const parts = [base];
  if (f.indexing) {
    parts.push(`reindexing now${f.queued > 0 ? ` (${f.queued} queued)` : ''}`);
  } else if (f.commitsBehind === 0) {
    parts.push('in sync with HEAD');
  } else if (f.commitsBehind !== null && f.commitsBehind > 0) {
    parts.push(`HEAD is ${f.commitsBehind} commit${f.commitsBehind === 1 ? '' : 's'} ahead — catching up`);
    if (f.queued > 0) parts.push(`${f.queued} file(s) queued`);
  } else if (f.headSha === null) {
    parts.push('not a git repo');
  }
  if (f.dirtyUnindexed.length > 0) {
    parts.push(`${f.dirtyUnindexed.length} dirty file(s) not yet indexed`);
  }

  return parts.join(' · ');
}

/** Uniform truncation trailer; when the tool supports pagination, include the offset to re-call with. */
export function truncationFooter(omitted: number, kind: 'result' | 'line', nextOffset?: number): string {
  const hint = nextOffset !== undefined ? ` — re-call with offset=${nextOffset} for more` : ' — token budget reached';
  return `\n_(${omitted} more ${kind}(s) omitted${hint})_`;
}

/**
 * Render items one-by-one until the token budget is exhausted. The first item
 * is always included so a single oversized result is never silently dropped.
 */
export function budgetItems<T>(
  items: readonly T[],
  render: (item: T) => string,
  tokenBudget: number
): { blocks: string[]; included: number } {
  const blocks: string[] = [];
  let budget = tokenBudget;
  let included = 0;
  for (const item of items) {
    const block = render(item);
    const cost = estimateTokens(block);
    if (included > 0 && cost > budget) break;
    blocks.push(block);
    budget -= cost;
    included += 1;
  }
  return { blocks, included };
}

/** Line-based budget for pre-rendered output (trees, outlines, lists). */
export function applyBudget(lines: string[], tokenBudget: number): ToolResult {
  let budget = tokenBudget;
  const out: string[] = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cost = estimateTokens(line);
    if (out.length > 1 && cost > budget) {
      omitted += lines.length - i;
      break;
    }
    out.push(line);
    budget -= cost;
  }
  if (omitted > 0) out.push(truncationFooter(omitted, 'line'));
  return { text: out.join('\n') };
}
