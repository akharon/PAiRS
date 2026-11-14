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
import type { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { commandList, parseToolArgs, toolHelp, wantsHelp } from './args';
import { bootstrapCli, parseGlobalFlags, runIndexCommand, runWatchCommand } from './context';
import { createExecutors } from '../../core/tools/executors';
import { collectDiffHunks } from '../../platform/gitDiff';
import { codeToolSchemas, type CodeToolInput, type CodeToolName } from '../../core/tools/tools';
import {
  jsonAnalyze,
  jsonContextPack,
  jsonDiffImpact,
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
  renderFilesProse,
  renderStatsProse,
} from './json';

const MAX_READ_BYTES = 1024 * 1024;

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
    case 'diff_impact':
      return jsonDiffImpact(store, (src) => collectDiffHunks(root, src), data as CodeToolInput<'diff_impact'>);
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
  // Global flags (--root, --no-refresh) are stripped before dispatch; root
  // discovery, seeding, auto-index/refresh and locking live in ./context.
  const globals = parseGlobalFlags(process.argv.slice(2));
  if (globals.error) {
    process.stderr.write(`${globals.error}\n`);
    process.exitCode = 1;
    return;
  }
  const { command, rest } = globals;

  // Output mode. Prose is the default (what agents read most reliably, and the
  // cheapest in tokens); `--json` is compact JSON, `--pretty` indented. `--naked`
  // (the old opt-in for prose) is accepted and ignored. Stripped here, before
  // tool-flag parsing, so they never reach parseToolArgs.
  const takeFlag = (flag: string): boolean => {
    let found = false;
    for (let i = rest.indexOf(flag); i !== -1; i = rest.indexOf(flag)) {
      rest.splice(i, 1);
      found = true;
    }
    return found;
  };
  takeFlag('--naked');
  const pretty = takeFlag('--pretty');
  const wantJson = takeFlag('--json') || pretty;
  const stringify = (data: unknown): string => JSON.stringify(data, null, pretty ? 2 : undefined);

  // Help and argument errors are answered before the workspace is touched, so a
  // typo never triggers an auto-index.
  const isTool = command !== undefined && (codeToolSchemas as Record<string, unknown>)[command] !== undefined;
  const toolHelpTarget = (name: string | undefined): name is CodeToolName =>
    name !== undefined && (codeToolSchemas as Record<string, unknown>)[name] !== undefined;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    const target = command === 'help' ? rest[0] : undefined;
    process.stdout.write(`${toolHelpTarget(target) ? toolHelp(target) : commandList()}\n`);
    if (command === undefined) process.exitCode = 1;
    return;
  }
  let toolName: CodeToolName | undefined;
  let toolRaw: Record<string, unknown> = {};
  if (isTool) {
    toolName = command as CodeToolName;
    if (wantsHelp(rest)) {
      process.stdout.write(`${toolHelp(toolName)}\n`);
      return;
    }
    const parsedArgs = parseToolArgs(toolName, rest);
    if (!parsedArgs.ok) {
      process.stderr.write(`${parsedArgs.error}\n`);
      process.exitCode = 1;
      return;
    }
    toolRaw = parsedArgs.raw;
  } else if (!['index', 'query', 'stats', 'watch', 'read', 'files'].includes(command)) {
    process.stderr.write(`Unknown command "${command}".\n${commandList()}\n`);
    process.exitCode = 1;
    return;
  }

  // This file ships bundled as dist/cli.js, so grammars/queries sit alongside
  // it in dist/ — resolve from __dirname, not from the src/ tree layout.
  const ctx = await bootstrapCli(command, globals, {
    grammarsDir: path.join(__dirname, 'grammars'),
    queriesDir: path.join(__dirname, 'queries'),
  });
  if (ctx === null) return;
  const { root, store } = ctx;
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
  const executors = createExecutors({
    store,
    root,
    readSource,
    collectDiff: (src) => collectDiffHunks(root, src),
  });

  try {
    if (toolName !== undefined) {
      const parsed = codeToolSchemas[toolName].input.parse(toolRaw);
      if (wantJson) {
        const data = await renderToolJson(store, root, toolName, parsed);
        process.stdout.write(`${stringify(data)}\n`);
      } else {
        const out = await (executors[toolName] as (input: unknown) => Promise<string>)(parsed);
        process.stdout.write(`${out}\n`);
      }
      return;
    }
    switch (command) {
      case 'index': {
        // Full index under the cross-process lock (see ./context).
        await runIndexCommand(ctx, rest);
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
        // Always JSON (it is raw rows), compact unless --pretty.
        process.stdout.write(`${stringify(rows)}\n`);
        break;
      }
      case 'stats': {
        const stats = await ctx.indexer.stats();
        process.stdout.write(`${wantJson ? stringify(stats) : renderStatsProse(stats)}\n`);
        break;
      }
      case 'watch': {
        // pairs watch — incremental re-index on save; heartbeat + idle cache
        // release live in ./context.
        await runWatchCommand(ctx);
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
        // pairs files [pattern] [--paths] [--json] — list/search indexed non-source filenames.
        // pattern is a filename glob (*.txt, Pic*.svg); --paths also matches full paths.
        const withPaths = rest.includes('--paths');
        const pattern = rest.find((a) => a !== '--paths');
        const files = await store.findNamedFiles(pattern, { withPaths });
        if (wantJson) {
          process.stdout.write(`${stringify({ pattern: pattern ?? null, files: files.map((f) => f.path) })}\n`);
          break;
        }
        process.stdout.write(renderFilesProse(files.map((f) => f.path)) + '\n');
        break;
      }
    }
  } finally {
    // Checkpoint before exit so a one-shot invocation (e.g. `pairs index`)
    // leaves the WAL merged rather than growing it every run, then dispose
    // the store and parsers.
    await ctx.close();
  }
}

main().catch((err) => {
  // One line for users and agents; the stack only when debugging the CLI itself.
  const e = err as Error;
  process.stderr.write(`pairs: ${process.env.PAIRS_DEBUG ? (e.stack ?? String(e)) : (e.message ?? String(err))}\n`);
  process.exitCode = 1;
});
