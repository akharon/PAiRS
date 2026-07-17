/**
 * Process entry for the V3 token benchmark. Opens the repo's indexed store and
 * runs runV3Bench against it, printing a table + verdict (and JSON on --json).
 *
 * Usage: node dist/v3-bench.js <indexed-repo-dir> [--json]
 *   repo must already be indexed (`cd <repo> && node <gizem>/dist/cli.js index`).
 */

import * as path from 'node:path';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import { runV3Bench } from './v3Bench';

async function main(): Promise<void> {
  const repo = path.resolve(process.argv[2] ?? '.');
  const asJson = process.argv.includes('--json');
  const dbPath = path.join(repo, '.gizem', 'index');
  const store = await KuzuCodeStore.open(dbPath, nodeKuzuDriver);
  const res = await runV3Bench(store, repo);

  if (asJson) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log(`V3 token benchmark — ${res.rows.length} questions on ${repo}\n`);
  console.log(`${pad('#', 3)} ${pad('tool', 11)} ${pad('gizem', 7)} ${pad('baseline', 9)} ${pad('files', 6)} ${pad('ratio', 7)} question`);
  for (const r of res.rows) {
    console.log(
      `${pad(String(r.id), 3)} ${pad(r.tool, 11)} ${pad(String(r.gizemTokens), 7)} ` +
        `${pad(String(r.baselineTokens), 9)} ${pad(String(r.baselineFiles), 6)} ` +
        `${pad((r.ratio * 100).toFixed(1) + '%', 7)} ${r.question}`
    );
  }
  const pct = (n: number): string => (n * 100).toFixed(2) + '%';
  console.log(
    `\nTotals: gizem ${res.totalGizem} tok vs baseline ${res.totalBaseline} tok\n` +
      `Aggregate ratio: ${pct(res.ratio)} of baseline (mean per-question ${pct(res.meanRatio)})\n` +
      `Gate (≤10% aggregate): ${res.passed ? 'PASS ✅' : 'FAIL ❌'}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
