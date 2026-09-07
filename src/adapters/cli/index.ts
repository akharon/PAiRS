#!/usr/bin/env node
/**
 * pairs CLI — headless entry point (`pairs index`, `pairs query`,
 * `pairs stats`). Wires core/indexer to store/graph exactly
 * as the VS Code extension (Phase 1) and MCP server will, over the same
 * `Indexer`/`CodeStore` interfaces — no vscode import here (R10).
 */

import * as fs from 'node:fs/promises';
// Synchronous counterpart: ExecutorDeps.readSource returns `string | null`,
// not a Promise, so the preview reader cannot use the promises API above.
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { ParserRegistryImpl, fileQuerySource } from '../../core/indexer/parserRegistryImpl';
import { ExtractorImpl } from '../../core/indexer/extractorImpl';
import { IndexerImpl } from '../../core/indexer/codeIndexerImpl';
import { nodeListNamedFiles, nodeListWorkspaceFiles, nodeReadFile, nodeWatchWorkspace } from '../../core/indexer/nodeFsDeps';
import { WatchQueue } from '../../core/indexer/watchQueue';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import { IMPACT_EDGE_KINDS } from '../../core/analyze/impact';
import { createExecutors } from '../../core/tools/executors';
import { codeToolSchemas, type CodeToolInput, type CodeToolName } from '../../core/tools/tools';
import {
  jsonAnalyze,
  jsonContextPack,
  jsonFileDeps,
  jsonFindSymbol,
  jsonGetSymbol,
  jsonGrepSymbols,
  jsonHierarchy,
  jsonImpact,
  jsonModuleMap,
  jsonOutline,
  jsonRenameSymbol,
  jsonWhoCalls,
} from './json';

const MAX_READ_BYTES = 1024 * 1024;

/** CLI arg → tool input, per tool: positional args mapped to the schema's fields in order. */
const TOOL_ARG_SPECS: Record<CodeToolName, string[]> = {
  find_symbol: ['name'],
  get_symbol: ['name', 'path'],
  outline: ['path'],
  impact: ['name', 'path', 'depth', 'includeTests'],
  hierarchy: ['name', 'path', 'depth'],
  who_calls: ['name', 'direction', 'path', 'includeTests'],
  file_deps: ['path', 'direction'],
  module_map: ['boundary'],
  analyze: ['kind', 'pathPrefix'],
  rename_symbol: ['name', 'newName', 'path', 'includeFuzzy'],
  grep_symbols: ['pattern', 'pathPrefix'],
  // No positional `path`: context_pack takes EITHER name or path, and `name`
  // sits first, so `pairs context_pack somefile.ts` would try to resolve
  // "somefile.ts" as a symbol name. Use --path to pass a file instead — see
  // the --path handling below.
  context_pack: ['name', 'limit'],
};

/** Fields that are numbers in the zod schema — CLI positionals arrive as strings. */
const NUMERIC_FIELDS = new Set(['depth', 'limit', 'offset']);

/** Fields that are booleans in the zod schema — CLI positionals arrive as strings. */
const BOOLEAN_FIELDS = new Set(['includeFuzzy', 'includeTests']);

/** Dispatches to the per-tool JSON builder in ./json — one shape per tool, built from the same store/analyze calls the prose executors use. */
async function renderToolJson(
  store: SqliteCodeStore,
  root: string,
  toolName: CodeToolName,
  data: unknown
): Promise<unknown> {
  switch (toolName) {
    case 'find_symbol':
      return jsonFindSymbol(store, data as CodeToolInput<'find_symbol'>);
    case 'get_symbol':
      return jsonGetSymbol(store, data as CodeToolInput<'get_symbol'>);
    case 'outline':
      return jsonOutline(store, data as CodeToolInput<'outline'>);
    case 'impact':
      return jsonImpact(store, data as CodeToolInput<'impact'>);
    case 'hierarchy':
      return jsonHierarchy(store, data as CodeToolInput<'hierarchy'>);
    case 'who_calls':
      return jsonWhoCalls(store, data as CodeToolInput<'who_calls'>);
    case 'file_deps':
      return jsonFileDeps(store, data as CodeToolInput<'file_deps'>);
    case 'module_map':
      return jsonModuleMap(store, data as CodeToolInput<'module_map'>);
    case 'analyze':
      return jsonAnalyze(store, data as CodeToolInput<'analyze'>);
    case 'rename_symbol':
      return jsonRenameSymbol(store, root, data as CodeToolInput<'rename_symbol'>);
    case 'grep_symbols':
      return jsonGrepSymbols(store, data as CodeToolInput<'grep_symbols'>);
    case 'context_pack':
      return jsonContextPack(store, data as CodeToolInput<'context_pack'>);
  }
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
  /**
   * Preview reader for find_symbol/get_symbol. Reuses MAX_READ_BYTES so a
   * generated or minified file can't cost megabytes of memory to produce a
   * three-line excerpt. Returns null on any failure — a preview is an
   * optimisation and must never be a reason for the tool itself to fail.
   */
  const readSource = (rel: string): string | null => {
    try {
      const abs = path.join(root, rel);
      if (fsSync.statSync(abs).size > MAX_READ_BYTES) return null;
      return fsSync.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  const executors = createExecutors({ store, root, readSource });

  try {
    // JSON is the CLI's default output (Step 5): a script or another agent
    // process invoking `pairs` should get parseable structured data without
    // having to remember a flag. `--naked` opts into the original prose
    // rendering (executors.ts) instead — the name signals "no JSON wrapper",
    // not "less output". `--json` is kept as a harmless no-op alias so
    // existing `pairs impact --json` invocations keep working unchanged now
    // that JSON is the default anyway.
    const nakedIdx = rest.indexOf('--naked');
    const naked = nakedIdx !== -1;
    if (naked) rest.splice(nakedIdx, 1);
    const jsonIdx = rest.indexOf('--json');
    if (jsonIdx !== -1) rest.splice(jsonIdx, 1);

    if ((codeToolSchemas as Record<string, unknown>)[command] !== undefined) {
      const toolName = command as CodeToolName;
      const fields = TOOL_ARG_SPECS[toolName];
      const raw: Record<string, string | number | boolean | string[]> = {};
      if (toolName === 'rename_symbol') {
        const idx = rest.indexOf('--include-fuzzy');
        if (idx !== -1) {
          rest.splice(idx, 1);
          raw.includeFuzzy = true;
        }
      }
      // Boolean flags can't ride the positional mapping either: `preview` sits
      // after `offset` in the schema, so reaching it positionally would mean
      // typing limit and offset first. It is the CLI's main token-saving
      // switch, so it gets a real flag.
      if (toolName === 'find_symbol') {
        const idx = rest.indexOf('--preview');
        if (idx !== -1) {
          rest.splice(idx, 1);
          raw.preview = true;
        }
      }
      if (toolName === 'grep_symbols') {
        const idx = rest.indexOf('--regex');
        if (idx !== -1) {
          rest.splice(idx, 1);
          raw.isRegex = true;
        }
      }
      if (toolName === 'context_pack') {
        const idx = rest.indexOf('--path');
        if (idx !== -1) {
          const value = rest[idx + 1];
          if (value === undefined || value.startsWith('--')) {
            process.stderr.write('--path needs a workspace-relative file path.\n');
            process.exitCode = 1;
            return;
          }
          rest.splice(idx, 2);
          raw.path = value;
        }
      }
      // `kinds` is a list, so it cannot ride the positional mapping below
      // (it would have to sit after includeTests and be unreachable). Spliced
      // out here, before that loop, or the flag and its value would be eaten
      // as positionals.
      if (toolName === 'impact') {
        const idx = rest.indexOf('--kinds');
        if (idx !== -1) {
          const value = rest[idx + 1];
          if (value === undefined || value.startsWith('--')) {
            process.stderr.write(
              `--kinds needs a comma-separated list, e.g. --kinds ${IMPACT_EDGE_KINDS.slice(0, 2).join(',')}\n`
            );
            process.exitCode = 1;
            return;
          }
          rest.splice(idx, 2);
          const requested = value
            .split(',')
            .map((k) => k.trim().toUpperCase())
            .filter(Boolean);
          // Validate here rather than deferring to zod: zod's error for a bad
          // member of an enum array is a nested JSON dump, unreadable at a
          // terminal, and this is the one flag a user is likely to mistype.
          const bad = requested.filter((k) => !(IMPACT_EDGE_KINDS as readonly string[]).includes(k));
          if (bad.length > 0) {
            process.stderr.write(
              `Unknown edge kind(s): ${bad.join(', ')}. Legal values: ${IMPACT_EDGE_KINDS.join(', ')}\n`
            );
            process.exitCode = 1;
            return;
          }
          raw.kinds = requested;
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
        const suffix =
          toolName === 'impact'
            ? ' [--kinds CALLS,READS] [--naked]'
            : toolName === 'find_symbol'
              ? ' [--preview] [--naked]'
              : toolName === 'grep_symbols'
                ? ' [--regex] [--naked]'
                : toolName === 'context_pack'
                  ? ' [--path <file>] [--naked]'
                  : ' [--naked]';
        process.stderr.write(`Usage: pairs ${toolName} ${fields.map((f) => `<${f}>`).join(' ')}${suffix}\n`);
        process.stderr.write(`${parsed.error.message}\n`);
        process.exitCode = 1;
      } else if (naked) {
        const out = await (executors[toolName] as (input: unknown) => Promise<string>)(parsed.data);
        process.stdout.write(`${out}\n`);
      } else {
        const data = await renderToolJson(store, root, toolName, parsed.data);
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
        // pairs files [pattern] [--paths] [--naked] — list/search indexed non-source filenames.
        // pattern is a filename glob (*.txt, Pic*.svg); --paths also matches full paths.
        const withPaths = rest.includes('--paths');
        const pattern = rest.find((a) => a !== '--paths');
        const files = await store.findNamedFiles(pattern, { withPaths });
        if (naked) {
          if (files.length === 0) {
            process.stdout.write('No matching files.\n');
            break;
          }
          process.stdout.write(files.map((f) => f.path).join('\n') + '\n');
          break;
        }
        process.stdout.write(`${JSON.stringify({ pattern: pattern ?? null, files }, null, 2)}\n`);
        break;
      }
      default:
        // Every tool defaults to JSON output (see renderToolJson above);
        // --naked switches to the original prose rendering.
        process.stderr.write(
          `Usage: pairs <index|query|stats|watch|files|read|${Object.keys(codeToolSchemas).join('|')}> [...args] [--naked]\n`
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
