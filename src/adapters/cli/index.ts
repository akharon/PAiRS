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
import { nodeListWorkspaceFiles, nodeReadFile } from '../../core/indexer/nodeFsDeps';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import { impact } from '../../core/analyze/impact';

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
      default:
        process.stderr.write('Usage: gizem <index|query|stats|impact>\n');
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
