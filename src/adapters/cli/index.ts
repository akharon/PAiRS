#!/usr/bin/env node
/**
 * gizem CLI — headless entry point (plan.md Phase 0: `gizem index`,
 * `gizem query`, `gizem stats`). Wires core/indexer to store/graph exactly
 * as the VS Code extension (Phase 1) and MCP server will, over the same
 * `Indexer`/`CodeStore` interfaces — no vscode import here (R10).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ParserRegistryImpl, fileQuerySource } from '../../core/indexer/parserRegistryImpl';
import { ExtractorImpl } from '../../core/indexer/extractorImpl';
import { IndexerImpl } from '../../core/indexer/codeIndexerImpl';
import { nodeListWorkspaceFiles, nodeReadFile, nodeWatchWorkspace } from '../../core/indexer/nodeFsDeps';
import { WatchQueue } from '../../core/indexer/watchQueue';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import { impact } from '../../core/analyze/impact';
import { parseRuleSet } from '../../core/rules/config';
import { checkRules } from '../../core/rules/evaluate';
import { renderViolation, summarizeRule } from '../../core/rules/render';
import { toSarif } from '../../core/rules/sarif';
import { ciFailures, createBaseline, diffAgainstBaseline, parseBaseline } from '../../core/rules/baseline';

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const root = process.cwd();
  const dbPath = path.join(root, '.gizem', 'index');
  // This file ships bundled as dist/cli.js, so grammars/queries sit alongside
  // it in dist/ — resolve from __dirname, not from the src/ tree layout.
  const grammarsDir = path.join(__dirname, 'grammars');
  const queriesDir = path.join(__dirname, 'queries');

  // Kuzu creates the database file itself but not its parent directory.
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const store = await KuzuCodeStore.open(dbPath, nodeKuzuDriver);
  const parsers = new ParserRegistryImpl(grammarsDir, fileQuerySource(queriesDir));
  const extractor = new ExtractorImpl();
  const indexer = new IndexerImpl({
    store,
    parsers,
    extractor,
    listWorkspaceFiles: nodeListWorkspaceFiles(root),
    readFile: nodeReadFile(root),
  });

  try {
    switch (command) {
      case 'index': {
        const report = await indexer.fullIndex(root);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        break;
      }
      case 'query': {
        const cypher = rest.join(' ');
        if (!cypher) {
          process.stderr.write("Usage: gizem query '<cypher>'\n");
          process.exitCode = 1;
          break;
        }
        const rows = await store.query(cypher);
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        break;
      }
      case 'stats': {
        const stats = await indexer.stats();
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        break;
      }
      case 'impact': {
        // gizem impact <nameOrQualified> [depth]
        const target = rest[0];
        const depth = rest[1] ? Number(rest[1]) : 5;
        if (!target) {
          process.stderr.write('Usage: gizem impact <name> [depth]\n');
          process.exitCode = 1;
          break;
        }
        const hit = await store.lookup(target);
        if (!Array.isArray(hit)) {
          // AmbiguousSymbol — report candidates so the caller can qualify.
          process.stdout.write(`${JSON.stringify({ ambiguous: hit }, null, 2)}\n`);
          break;
        }
        if (hit.length === 0) {
          process.stdout.write(`${JSON.stringify({ dependants: [], note: 'no such symbol' }, null, 2)}\n`);
          break;
        }
        const result = await impact(store, hit[0].id, depth);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        break;
      }
      case 'check': {
        // gizem check [--ci] [--baseline <f>] [--format human|sarif|json] [--rules <f>]
        const opt = (name: string): string | undefined => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const ci = rest.includes('--ci');
        const format = opt('--format') ?? 'human';
        const rulesPath = opt('--rules') ?? path.join(root, '.gizem', 'rules.ron');
        const baselinePath = opt('--baseline');

        let src: string;
        try {
          src = await fs.readFile(rulesPath, 'utf8');
        } catch {
          process.stderr.write(`No ruleset at ${rulesPath}. Create .gizem/rules.ron first.\n`);
          process.exitCode = 2;
          break;
        }
        const ruleset = parseRuleSet(src); // ConfigError propagates with the fixable message

        if (ci) await indexer.fullIndex(root); // a gate must never judge a stale graph
        else {
          // Non-CI check against an empty graph would report a hollow OK —
          // refuse rather than silently pass a gate over nothing.
          const s = await store.stats();
          if (s.files === 0) {
            process.stderr.write('Index is empty — run `gizem index` (or `gizem check --ci`) first.\n');
            process.exitCode = 2;
            break;
          }
        }
        const { violations, checkedRules } = await checkRules(store, ruleset);

        // Baseline: only violations NOT in the snapshot can fail the run.
        let fresh = violations;
        let known = 0;
        if (baselinePath) {
          const b = parseBaseline(await fs.readFile(baselinePath, 'utf8'));
          const diff = diffAgainstBaseline(violations, b);
          fresh = diff.fresh;
          known = diff.known.length;
          if (diff.fixedKeys.length > 0 && format === 'human') {
            process.stderr.write(`${diff.fixedKeys.length} baselined violation(s) fixed — run \`gizem baseline update\` to ratchet.\n`);
          }
        }

        if (format === 'sarif') process.stdout.write(`${toSarif(fresh, ruleset.rules, '0.3.0')}\n`);
        else if (format === 'json') process.stdout.write(`${JSON.stringify({ violations: fresh, known, checkedRules }, null, 2)}\n`);
        else {
          if (fresh.length === 0) {
            process.stdout.write(`OK — ${checkedRules.length} rule(s), ${known} baselined, no new violations.\n`);
          } else {
            process.stdout.write(fresh.map(renderViolation).join('\n\n') + '\n');
            process.stdout.write(`\n${fresh.length} new violation(s) (${known} baselined).\n`);
          }
        }

        // Exit 1 only on new CONFIRMED error-severity violations (R1).
        if (ciFailures(fresh).length > 0) process.exitCode = 1;
        break;
      }
      case 'baseline': {
        // gizem baseline update [--rules <f>] [--out <f>]
        if (rest[0] !== 'update') {
          process.stderr.write('Usage: gizem baseline update [--rules <f>] [--out <f>]\n');
          process.exitCode = 1;
          break;
        }
        const opt = (name: string): string | undefined => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const rulesPath = opt('--rules') ?? path.join(root, '.gizem', 'rules.ron');
        const outPath = opt('--out') ?? path.join(root, '.gizem', 'baseline.json');
        const ruleset = parseRuleSet(await fs.readFile(rulesPath, 'utf8'));
        const { violations } = await checkRules(store, ruleset);
        const baseline = createBaseline(violations);
        await fs.writeFile(outPath, `${JSON.stringify(baseline, null, 2)}\n`);
        process.stdout.write(`Baseline written: ${outPath} (${baseline.keys.length} accepted violation(s)).\n`);
        break;
      }
      case 'init': {
        // gizem init [--force] — index, infer layers, write starter rules.ron
        // + a findings report (plan.md 3.4 / R5). Never overwrites an existing
        // ruleset without --force.
        const rulesPath = path.join(root, '.gizem', 'rules.ron');
        const exists = await fs.access(rulesPath).then(() => true, () => false);
        if (exists && !rest.includes('--force')) {
          process.stderr.write(`${rulesPath} already exists — review it, or re-run with --force to overwrite.\n`);
          process.exitCode = 2;
          break;
        }
        process.stderr.write('Indexing…\n');
        const report = await indexer.fullIndex(root);
        process.stderr.write(`Indexed ${report.files} files in ${report.elapsedMs} ms.\n`);
        const { proposeInit } = await import('../../core/analyze/initProposal');
        const proposal = await proposeInit(store);
        await fs.writeFile(rulesPath, proposal.rulesRon);
        const nLayers = Object.keys(proposal.layers).length;
        process.stdout.write(`Wrote ${rulesPath}: ${nLayers} inferred layer(s) over ${proposal.map.modules.length} module(s).\n`);
        if (proposal.findings.length) {
          process.stdout.write(`\nReview these before trusting the proposal:\n`);
          for (const f of proposal.findings) process.stdout.write(`  - ${f}\n`);
        }
        process.stdout.write(`\nNext: \`gizem check\` to see day-1 violations, \`gizem baseline update\` to accept them.\n`);
        break;
      }
      case 'watch': {
        // gizem watch [--check] — incremental re-index on save (plan.md 3.1);
        // with --check, re-evaluate rules after each settled batch (3.3-lite).
        const withCheck = rest.includes('--check');
        const rulesPath = path.join(root, '.gizem', 'rules.ron');
        process.stderr.write('Indexing…\n');
        const report = await indexer.fullIndex(root);
        process.stderr.write(`Indexed ${report.files} files in ${report.elapsedMs} ms. Watching (Ctrl-C to stop).\n`);
        const queue = new WatchQueue({
          indexFile: (p) => indexer.indexFile(p),
          removeFile: (p) => indexer.removeFile(p),
          async onFlushed(changed, removed) {
            const t0 = Date.now();
            for (const p of [...changed, ...removed]) process.stderr.write(`  ~ ${p}\n`);
            if (!withCheck) return;
            let src: string;
            try {
              src = await fs.readFile(rulesPath, 'utf8');
            } catch {
              return; // no ruleset — watch is still useful for the index alone
            }
            const { violations } = await checkRules(store, parseRuleSet(src));
            const line = violations.length === 0 ? 'OK' : violations.map(renderViolation).join('\n\n');
            process.stdout.write(`${line}\n[check ${Date.now() - t0} ms]\n`);
          },
          onError: (p, err) => process.stderr.write(`  ! ${p}: ${err.message}\n`),
        });
        const stop = nodeWatchWorkspace(root, queue);
        // Keep the process alive until SIGINT.
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => {
            stop();
            queue.dispose();
            resolve();
          });
        });
        break;
      }
      case 'rules': {
        const rulesPath = rest[0] ?? path.join(root, '.gizem', 'rules.ron');
        const ruleset = parseRuleSet(await fs.readFile(rulesPath, 'utf8'));
        process.stdout.write(ruleset.rules.map((r) => `${summarizeRule(r)}\n`).join(''));
        break;
      }
      default:
        process.stderr.write('Usage: gizem <index|init|query|stats|impact|check|baseline|rules|watch>\n');
        process.exitCode = 1;
    }
  } finally {
    store.dispose();
    parsers.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
