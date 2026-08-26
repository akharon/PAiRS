#!/usr/bin/env node
/**
 * pairs CLI — headless entry point (`pairs index`, `pairs query`,
 * `pairs stats`). Wires core/indexer to store/graph exactly
 * as the VS Code extension (Phase 1) and MCP server will, over the same
 * `Indexer`/`CodeStore` interfaces — no vscode import here (R10).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ParserRegistryImpl, fileQuerySource } from '../../core/indexer/parserRegistryImpl';
import { ExtractorImpl } from '../../core/indexer/extractorImpl';
import { IndexerImpl } from '../../core/indexer/codeIndexerImpl';
import { nodeListNamedFiles, nodeListWorkspaceFiles, nodeReadFile, nodeWatchWorkspace } from '../../core/indexer/nodeFsDeps';
import { WatchQueue } from '../../core/indexer/watchQueue';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import { impact } from '../../core/analyze/impact';
import { createExecutors } from '../../core/tools/executors';
import { codeToolSchemas, type CodeToolName } from '../../core/tools/tools';

const MAX_READ_BYTES = 1024 * 1024;

/** CLI arg → tool input, per tool: positional args mapped to the schema's fields in order. */
const TOOL_ARG_SPECS: Record<CodeToolName, string[]> = {
  find_symbol: ['name'],
  get_symbol: ['name', 'path'],
  outline: ['path'],
  impact: ['name', 'path', 'depth'],
  hierarchy: ['name', 'path', 'depth'],
  who_calls: ['name', 'direction', 'path'],
  file_deps: ['path', 'direction'],
  module_map: ['boundary'],
  analyze: ['kind', 'pathPrefix'],
  rename_symbol: ['name', 'newName', 'path', 'includeFuzzy'],
};

/** Fields that are numbers in the zod schema — CLI positionals arrive as strings. */
const NUMERIC_FIELDS = new Set(['depth', 'limit', 'offset']);

/** Fields that are booleans in the zod schema — CLI positionals arrive as strings. */
const BOOLEAN_FIELDS = new Set(['includeFuzzy']);

/**
 * `pairs impact --json`'s structured output — a compatibility contract with
 * scripts that depended on the pre-existing `case 'impact':` shape. The
 * ambiguous/miss shapes come straight from `store.lookup`, which distinguishes
 * them more richly than executors.ts's `resolveOne` (that helper collapses
 * both into one prose message, so it can't reproduce this).
 */
async function renderImpactJson(store: SqliteCodeStore, input: { name: string; depth: number }): Promise<string> {
  const hit = await store.lookup(input.name);
  if (!Array.isArray(hit)) {
    // AmbiguousSymbol — report candidates so the caller can qualify.
    return JSON.stringify({ ambiguous: hit }, null, 2);
  }
  if (hit.length === 0) {
    return JSON.stringify({ dependants: [], note: 'no such symbol' }, null, 2);
  }
  const result = await impact(store, hit[0]!.id, input.depth);
  return JSON.stringify(result, null, 2);
}

/** Commands that only ever read the graph — safe to serve from a snapshot copy. */

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const root = process.cwd();
  const dbPath = path.join(root, '.pairs', 'index.db');
  // This file ships bundled as dist/cli.js, so grammars/queries sit alongside
  // it in dist/ — resolve from __dirname, not from the src/ tree layout.
  const grammarsDir = path.join(__dirname, 'grammars');
  const queriesDir = path.join(__dirname, 'queries');

  // SQLite creates the database file itself but not its parent directory.
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  // No lock dance here: SQLite in WAL mode allows concurrent readers, so the
  // CLI can read an index the VS Code extension has open. (Kuzu took an
  // exclusive lock even for read-only opens, which forced a snapshot-copy
  // fallback — deleted along with it.)
  const store: SqliteCodeStore = await SqliteCodeStore.open(dbPath, nodeSqlDriver);
  const parsers = new ParserRegistryImpl(grammarsDir, fileQuerySource(queriesDir));
  const extractor = new ExtractorImpl();
  const indexer = new IndexerImpl({
    store,
    parsers,
    extractor,
    listWorkspaceFiles: nodeListWorkspaceFiles(root),
    readFile: nodeReadFile(root),
    listNamedFiles: nodeListNamedFiles(root),
  });
  const executors = createExecutors({ store, root });

  try {
    // --json is stripped here (same place as --include-fuzzy) so it's
    // available to every tool the generic dispatch handles, but today only
    // `impact` has a defined structured shape to emit — see renderImpactJson.
    // Every other tool keeps rendering prose regardless of the flag.
    const jsonIdx = rest.indexOf('--json');
    const asJson = jsonIdx !== -1;
    if (asJson) rest.splice(jsonIdx, 1);

    if ((codeToolSchemas as Record<string, unknown>)[command] !== undefined) {
      const toolName = command as CodeToolName;
      const fields = TOOL_ARG_SPECS[toolName];
      const raw: Record<string, string | number | boolean> = {};
      if (toolName === 'rename_symbol') {
        const idx = rest.indexOf('--include-fuzzy');
        if (idx !== -1) {
          rest.splice(idx, 1);
          raw.includeFuzzy = true;
        }
      }
      for (let i = 0; i < fields.length && i < rest.length; i++) {
        const field = fields[i]!;
        const value = rest[i]!;
        if (NUMERIC_FIELDS.has(field)) raw[field] = Number(value);
        else if (BOOLEAN_FIELDS.has(field)) raw[field] = value === 'true' || value === '1';
        else raw[field] = value;
      }
      const parsed = codeToolSchemas[toolName].input.safeParse(raw);
      if (!parsed.success) {
        process.stderr.write(`Usage: pairs ${toolName} ${fields.map((f) => `<${f}>`).join(' ')} [--json]\n`);
        process.stderr.write(`${parsed.error.message}\n`);
        process.exitCode = 1;
      } else if (asJson && toolName === 'impact') {
        // Compatibility contract: this must emit BYTE-IDENTICAL JSON to the
        // pre-existing `case 'impact':` shape below, including its own
        // ambiguous/miss shapes — `resolveOne` (used by the prose path)
        // collapses both into one message string, so it can't reproduce them.
        process.stdout.write(`${await renderImpactJson(store, parsed.data as { name: string; depth: number })}\n`);
      } else {
        const out = await (executors[toolName] as (input: unknown) => Promise<string>)(parsed.data);
        process.stdout.write(`${out}\n`);
      }
      return;
    }
    switch (command) {
      case 'index': {
        // --rebuild: a plain fullIndex short-circuits unchanged files and can
        // write nothing at all, so it can't recover from a corrupted or
        // stale-shaped store. Drop everything and reparse from scratch.
        if (rest.includes('--rebuild')) await store.reset();
        const report = await indexer.fullIndex(root);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        break;
      }
      case 'query': {
        const sql = rest.join(' ');
        if (!sql) {
          process.stderr.write("Usage: pairs query '<sql>'\n");
          process.exitCode = 1;
          break;
        }
        const rows = await store.query(sql);
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        break;
      }
      case 'stats': {
        const stats = await indexer.stats();
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        break;
      }
      case 'watch': {
        // pairs watch — incremental re-index on save.
        process.stderr.write('Indexing…\n');
        const report = await indexer.fullIndex(root);
        process.stderr.write(`Indexed ${report.files} files in ${report.elapsedMs} ms. Watching (Ctrl-C to stop).\n`);
        const queue = new WatchQueue({
          indexFile: (p) => indexer.indexFile(p),
          removeFile: (p) => indexer.removeFile(p),
          async onFlushed(changed, removed) {
            await store.checkpoint();
            for (const p of [...changed, ...removed]) process.stderr.write(`  ~ ${p}\n`);
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
      case 'read': {
        // pairs read <path> [startLine] [endLine] — 1-indexed, inclusive.
        // No line args: whole file. startLine only: from there to EOF.
        // Both: that inclusive range. Out-of-range clamps rather than erroring.
        const target = rest[0];
        if (!target) {
          process.stderr.write('Usage: pairs read <path> [startLine] [endLine]\n');
          process.exitCode = 1;
          break;
        }
        const startLine = rest[1] ? Number(rest[1]) : undefined;
        const endLine = rest[2] ? Number(rest[2]) : undefined;
        if ((startLine !== undefined && !Number.isInteger(startLine)) || (endLine !== undefined && !Number.isInteger(endLine))) {
          process.stderr.write('startLine/endLine must be integers.\n');
          process.exitCode = 1;
          break;
        }
        const absTarget = path.join(root, target);
        try {
          const st = await fs.stat(absTarget);
          if (st.size > MAX_READ_BYTES) {
            process.stderr.write(
              `${target} is ${st.size} bytes, over the ${MAX_READ_BYTES}-byte read limit. Use startLine/endLine to read a slice.\n`
            );
            process.exitCode = 1;
            break;
          }
        } catch (err) {
          process.stderr.write(`Cannot read ${target}: ${(err as Error).message}\n`);
          process.exitCode = 1;
          break;
        }
        let contents: string;
        try {
          contents = await fs.readFile(absTarget, 'utf8');
        } catch (err) {
          process.stderr.write(`Cannot read ${target}: ${(err as Error).message}\n`);
          process.exitCode = 1;
          break;
        }
        if (startLine === undefined) {
          process.stdout.write(contents);
          break;
        }
        const lines = contents.split('\n');
        const from = Math.max(1, startLine);
        const to = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
        process.stdout.write(lines.slice(from - 1, to).join('\n') + '\n');
        break;
      }
      case 'files': {
        // pairs files [pattern] [--paths] — list/search indexed non-source filenames.
        // pattern is a filename glob (*.txt, Pic*.svg); --paths also matches full paths.
        const withPaths = rest.includes('--paths');
        const pattern = rest.find((a) => a !== '--paths');
        const files = await store.findNamedFiles(pattern, { withPaths });
        if (files.length === 0) {
          process.stdout.write('No matching files.\n');
          break;
        }
        process.stdout.write(files.map((f) => f.path).join('\n') + '\n');
        break;
      }
      default:
        process.stderr.write(
          `Usage: pairs <index|query|stats|watch|files|read|${Object.keys(codeToolSchemas).join('|')}> [--json]\n`
        );
        process.exitCode = 1;
    }
  } finally {
    // Checkpoint before exit so a one-shot invocation (e.g. `pairs index`)
    // leaves the WAL merged rather than growing it every run — dispose()
    // Skipped for a read-only snapshot copy: nothing writes to it, and its
    // scratch dir is discarded on process exit anyway.
    await store.checkpoint();
    store.dispose();
    parsers.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
