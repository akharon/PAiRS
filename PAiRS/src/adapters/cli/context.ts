/**
 * CLI bootstrap: global flags, workspace-root discovery, lazy index creation
 * and refresh, plus the `index` / `watch` commands. Split out of index.ts so
 * the command router stays thin. No `vscode` import (G1).
 *
 * Behaviour in one paragraph: the root is discovered (`--root` > PAIRS_ROOT >
 * nearest dir holding `.pairs/index.db` or `.git`), never blindly cwd. A
 * read-only command never creates `.pairs/` in a directory without an index
 * unless it is about to auto-index it. The first graph query against an empty
 * index seeds from the main worktree's index when run in a linked worktree,
 * then full-indexes under a cross-process lock. Subsequent graph queries run a
 * stat-first refresh at most every 30 s, unless a live watcher (extension or
 * `pairs watch`) already keeps the index fresh.
 *
 * Windows + WSL: when the index is open in a process on the other side of the
 * boundary (VS Code on Windows, the CLI in WSL), SQLite's WAL `-shm` cannot be
 * shared and every open fails with "disk I/O error". Read-only commands then
 * fall back to an immutable (or copied) snapshot; write commands stop with one
 * explanatory line. See `openSnapshotStore`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExtractorImpl } from '../../core/indexer/extractorImpl';
import { IndexerImpl } from '../../core/indexer/codeIndexerImpl';
import type { IndexReport } from '../../core/indexer/codeIndexer';
import {
  nodeListNamedFiles,
  nodeListWorkspaceFiles,
  nodeReadFile,
  nodeStatFile,
  nodeWatchWorkspace,
} from '../../core/indexer/nodeFsDeps';
import { fileQuerySource, ParserRegistryImpl } from '../../core/indexer/parserRegistryImpl';
import { WatchQueue } from '../../core/indexer/watchQueue';
import { codeToolSchemas } from '../../core/tools/tools';
import { withIndexLock } from '../../platform/indexLock';
import {
  ensurePairsDir,
  hasLiveWatcher,
  markRefreshed,
  refreshDue,
  startHeartbeat,
} from '../../platform/pairsDir';
import { discoverWorkspaceRoot, gitWorktreeInfo } from '../../platform/workspaceRoot';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { isLockClassError, nodeSqlDriver, type SqlConnectionLike, type SqlDriver } from '../../store/graph/sqliteDriver';

// -- Global flags --------------------------------------------------------------------

export interface GlobalFlags {
  command: string | undefined;
  /** Remaining args after the command, with the global flags removed. */
  rest: string[];
  explicitRoot?: string;
  noRefresh: boolean;
  /** Set when a global flag was malformed (e.g. `--root` without a value). */
  error?: string;
}

/**
 * Strips `--root <dir>` / `--root=<dir>` and `--no-refresh` from anywhere in
 * `args` (argv without node/script), then takes the first remaining token as
 * the command. Everything else is left to the command's own parsing.
 */
export function parseGlobalFlags(args: readonly string[]): GlobalFlags {
  const kept: string[] = [];
  let explicitRoot: string | undefined;
  let noRefresh = false;
  let error: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--no-refresh') {
      noRefresh = true;
    } else if (a === '--root') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) error = '--root needs a directory.';
      else {
        explicitRoot = v;
        i++;
      }
    } else if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      if (v === '') error = '--root needs a directory.';
      else explicitRoot = v;
    } else {
      kept.push(a);
    }
  }
  const [command, ...rest] = kept;
  const out: GlobalFlags = { command, rest, noRefresh };
  if (explicitRoot !== undefined) out.explicitRoot = explicitRoot;
  if (error !== undefined) out.error = error;
  return out;
}

// -- Command classification -------------------------------------------------------------

export type CommandKind =
  | 'graph' // every code tool: auto-index when empty, throttled refresh
  | 'stats' // auto-index when empty, no refresh (it reports the index as it is)
  | 'sql' // query, files: need an existing index, never create one
  | 'index'
  | 'watch'
  | 'read' // filesystem only; no store needed
  | 'unknown';

export function classifyCommand(command: string | undefined): CommandKind {
  if (command === undefined) return 'unknown';
  if ((codeToolSchemas as Record<string, unknown>)[command] !== undefined) return 'graph';
  switch (command) {
    case 'stats':
      return 'stats';
    case 'query':
    case 'files':
      return 'sql';
    case 'index':
      return 'index';
    case 'watch':
      return 'watch';
    case 'read':
      return 'read';
    default:
      return 'unknown';
  }
}

// -- Bootstrap ----------------------------------------------------------------------------

export interface BootstrapOptions {
  grammarsDir: string;
  queriesDir: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.stderr. */
  log?: (line: string) => void;
  /** Defaults to `nodeSqlDriver`; tests inject a failing one. */
  driver?: SqlDriver;
  /** Where a copied snapshot goes. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
}

export interface CliContext {
  root: string;
  pairsDir: string;
  kind: CommandKind;
  store: SqliteCodeStore;
  /** True when the store is a read-only snapshot of an index another process holds: nothing may write it. */
  snapshot: boolean;
  parsers: ParserRegistryImpl;
  indexer: IndexerImpl;
  log: (line: string) => void;
  /** Checkpoint + dispose store and parsers. Call from `finally`. */
  close(): Promise<void>;
}

const defaultLog = (line: string): void => void process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);

/** Copy the main worktree's index to `dbPath` so only files that differ get re-parsed. Never throws. */
function seedFromMainWorktree(root: string, dbPath: string): boolean {
  try {
    const info = gitWorktreeInfo(root);
    if ((info.kind !== 'linked' && info.kind !== 'submodule') || !info.mainRoot) return false;
    const mainDb = path.join(info.mainRoot, '.pairs', 'index.db');
    if (path.resolve(info.mainRoot) === path.resolve(root) || !fs.existsSync(mainDb)) return false;
    SqliteCodeStore.snapshot(mainDb, dbPath, nodeSqlDriver);
    return true;
  } catch {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    return false;
  }
}

export const SNAPSHOT_NOTICE =
  'pairs: index is in use by another OS/process (VS Code on Windows?); answering from a read-only snapshot — may miss unsaved changes since the last checkpoint.';

const oneLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();

interface SnapshotStore {
  store: SqliteCodeStore;
  /** Removes the temp copy, if one was made. */
  cleanup(): void;
}

/**
 * Open `dbPath` read-only without touching its lock/shm files: first as an
 * `immutable=1` URI on the live file, then (if even that fails) on a copy of
 * index.db (+ -wal) in the temp dir. Runs no writes: a stale-schema index
 * fails with a clear message instead of being reset. Throws if neither works.
 */
async function openSnapshotStore(dbPath: string, driver: SqlDriver, tmpBase: string): Promise<SnapshotStore> {
  const openWith = async (file: string, immutable: boolean): Promise<SqliteCodeStore> => {
    let conn: SqlConnectionLike | undefined;
    const ro: SqlDriver = {
      open: () => (conn = driver.openReadOnly!(file, { immutable })),
      openReadOnly: (p, o) => driver.openReadOnly!(p, o),
    };
    try {
      return await SqliteCodeStore.open(file, ro);
    } catch (err) {
      try {
        conn?.close();
      } catch {
        /* already closed */
      }
      // SqliteCodeStore.open migrates; a different schema_version means "reset", which a read-only handle cannot do.
      if (/readonly/i.test(oneLine(err))) {
        throw new Error(
          'the index was written by a different pairs version (schema mismatch) and a read-only snapshot cannot be upgraded; ' +
            'update/reload the VS Code extension so both sides run the same version'
        );
      }
      throw err;
    }
  };
  if (typeof driver.openReadOnly !== 'function') throw new Error('driver has no read-only mode');
  try {
    return { store: await openWith(dbPath, true), cleanup: () => {} };
  } catch (first) {
    let dir: string | undefined;
    try {
      dir = fs.mkdtempSync(path.join(tmpBase, 'pairs-snapshot-'));
      const made = dir;
      const copy = path.join(made, 'index.db');
      fs.copyFileSync(dbPath, copy);
      try {
        fs.copyFileSync(dbPath + '-wal', copy + '-wal');
      } catch {
        /* no WAL (or unreadable): the main file alone is a consistent checkpoint */
      }
      const cleanup = (): void => fs.rmSync(made, { recursive: true, force: true });
      try {
        return { store: await openWith(copy, false), cleanup };
      } catch {
        return { store: await openWith(copy, true), cleanup };
      }
    } catch {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      throw first;
    }
  }
}

/**
 * Resolve the root, ensure/seed/open the store and (for graph commands)
 * auto-index or refresh. Returns null after printing an error when the
 * command cannot proceed (caller just returns).
 */
export async function bootstrapCli(
  command: string | undefined,
  flags: GlobalFlags,
  opts: BootstrapOptions
): Promise<CliContext | null> {
  const log = opts.log ?? defaultLog;
  const root = discoverWorkspaceRoot(opts.cwd ?? process.cwd(), {
    ...(flags.explicitRoot !== undefined ? { explicit: flags.explicitRoot } : {}),
    env: opts.env ?? process.env,
  });
  const pairsDir = path.join(root, '.pairs');
  const dbPath = path.join(pairsDir, 'index.db');
  const kind = classifyCommand(command);
  const dbExists = fs.existsSync(dbPath);

  if (kind === 'sql' && !dbExists) {
    log(`pairs: no index at ${root}. Run \`pairs index\` there first (or pass --root <dir>).`);
    process.exitCode = 1;
    return null;
  }

  // read / unknown commands never touch the on-disk index: give them a
  // throwaway in-memory store so the shared plumbing below stays uniform
  // without minting a `.pairs/` directory.
  const ephemeral = kind === 'read' || kind === 'unknown';
  if (!ephemeral) {
    ensurePairsDir(root);
    const rebuild = kind === 'index' && flags.rest.includes('--rebuild');
    if (!dbExists && !rebuild) seedFromMainWorktree(root, dbPath);
  }
  const driver = opts.driver ?? nodeSqlDriver;
  let store: SqliteCodeStore;
  let snapshot = false;
  let cleanupSnapshot = (): void => {};
  try {
    store = await SqliteCodeStore.open(ephemeral ? ':memory:' : dbPath, driver);
  } catch (err) {
    if (ephemeral || !isLockClassError(err)) {
      throw new Error(
        ephemeral ? oneLine(err) : `cannot open the index at ${dbPath}: ${oneLine(err)}. If it is damaged, delete ${pairsDir} and re-run.`
      );
    }
    if (kind === 'index' || kind === 'watch') {
      log(
        `pairs: the index at ${dbPath} is held by another process across the WSL/Windows boundary (VS Code on Windows?), so \`pairs ${command}\` cannot write it (${oneLine(err)}). ` +
          'Let the VS Code extension index it, or run pairs from a native checkout of the repo (or pass --root <dir>).'
      );
      process.exitCode = 1;
      return null;
    }
    if (!dbExists) throw new Error(`cannot open the index at ${dbPath}: ${oneLine(err)}`);
    try {
      const snap = await openSnapshotStore(dbPath, driver, opts.tmpDir ?? os.tmpdir());
      store = snap.store;
      cleanupSnapshot = snap.cleanup;
      snapshot = true;
      log(SNAPSHOT_NOTICE);
    } catch (second) {
      throw new Error(`cannot open the index at ${dbPath} (${oneLine(err)}), and no read-only snapshot either: ${oneLine(second)}`);
    }
  }
  const parsers = new ParserRegistryImpl(opts.grammarsDir, fileQuerySource(opts.queriesDir));
  const indexer = new IndexerImpl({
    store,
    parsers,
    extractor: new ExtractorImpl(),
    listWorkspaceFiles: nodeListWorkspaceFiles(root),
    readFile: nodeReadFile(root),
    statFile: nodeStatFile(root),
    listNamedFiles: nodeListNamedFiles(root),
  });
  const ctx: CliContext = {
    root,
    pairsDir,
    kind,
    store,
    snapshot,
    parsers,
    indexer,
    log,
    async close() {
      try {
        // A snapshot is read-only (and may be a temp copy): nothing to checkpoint.
        if (!snapshot) await store.checkpoint();
      } finally {
        store.dispose();
        parsers.dispose();
        cleanupSnapshot();
      }
    },
  };

  try {
    if (snapshot) {
      if (kind !== 'sql' && (await store.fileCount()) === 0) {
        log(
          `pairs: the index at ${dbPath} has no files yet and cannot be built from a read-only snapshot; open the workspace in VS Code (or run \`pairs index\` where it can write).`
        );
        process.exitCode = 1;
        await ctx.close();
        return null;
      }
    } else if (kind === 'graph' || kind === 'stats') {
      if ((await store.fileCount()) === 0) {
        // First use: index under the lock; if another process indexed while we
        // waited, fileCount() is no longer 0 and there is nothing to do.
        const r = await withIndexLock(
          pairsDir,
          async () => {
            if ((await store.fileCount()) > 0) return null;
            const report = await indexer.fullIndex(root);
            markRefreshed(pairsDir);
            return report;
          },
          { wait: true }
        );
        if (!r.skipped && r.value) log(`pairs: indexed ${r.value.files} files in ${r.value.elapsedMs} ms (${root})`);
      } else if (kind === 'graph' && !flags.noRefresh && !hasLiveWatcher(pairsDir) && refreshDue(pairsDir)) {
        // Stat-first, so an unchanged tree costs about one directory walk. If
        // someone else is indexing right now, just use the index as it is.
        try {
          await withIndexLock(
            pairsDir,
            async () => {
              await indexer.fullIndex(root);
              markRefreshed(pairsDir);
            },
            { wait: false }
          );
        } catch (err) {
          // The refresh is a convenience: if the index turned unwritable (another
          // process holds it), answer from what is there.
          if (!isLockClassError(err)) throw err;
        }
      }
    }
  } catch (err) {
    await ctx.close();
    throw err;
  }
  return ctx;
}

// -- `pairs index` -------------------------------------------------------------------------

/** Full index under the lock (waiting for any other indexer); prints the report as JSON. */
export async function runIndexCommand(ctx: CliContext, rest: readonly string[]): Promise<void> {
  const r = await withIndexLock(
    ctx.pairsDir,
    async () => {
      // --rebuild: a plain fullIndex short-circuits unchanged files and can
      // write nothing at all, so it can't recover from a corrupted or
      // stale-shaped store. Drop everything and reparse from scratch.
      if (rest.includes('--rebuild')) await ctx.store.reset();
      const report: IndexReport = await ctx.indexer.fullIndex(ctx.root);
      markRefreshed(ctx.pairsDir);
      return report;
    },
    { wait: true }
  );
  if (r.skipped) {
    ctx.log(`pairs: gave up waiting for another indexer on ${ctx.root} (see ${path.join(ctx.pairsDir, 'index.lock')}).`);
    process.exitCode = 1;
    return;
  }
  const v = r.value;
  process.stdout.write(
    `indexed ${v.files} files (${v.functions} functions, ${v.types} types) in ${v.elapsedMs} ms; ` +
      `fuzzy ${(v.fuzzyRate * 100).toFixed(1)}%, misses ${v.resolvableMisses}, errors ${v.errors.length}\n` +
      v.errors
        .slice(0, 5)
        .map((e) => `  ${e.path}: ${e.message}\n`)
        .join('') +
      (v.errors.length > 5 ? `  … +${v.errors.length - 5} more\n` : '')
  );
}

// -- `pairs watch` -------------------------------------------------------------------------

/** Release the store's in-memory caches after this much idle time. */
const WATCH_IDLE_RELEASE_MS = 60_000;

/**
 * Index once, then watch and re-index on save until SIGINT/SIGTERM. Writes the
 * `.pairs/watcher.json` heartbeat every 30 s (so one-shot CLIs skip their own
 * refresh) and removes it on exit. It is the long-lived writer, so it only
 * drops caches after a minute of quiet.
 */
export async function runWatchCommand(ctx: CliContext): Promise<void> {
  const stopHeartbeat = startHeartbeat(ctx.pairsDir);
  let stopWatching: (() => void) | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => ctx.store.releaseCaches(), WATCH_IDLE_RELEASE_MS);
    idleTimer.unref?.();
  };
  try {
    ctx.log('Indexing…');
    const r = await withIndexLock(
      ctx.pairsDir,
      async () => {
        const report = await ctx.indexer.fullIndex(ctx.root);
        markRefreshed(ctx.pairsDir);
        return report;
      },
      { wait: true }
    );
    if (!r.skipped) ctx.store.releaseCaches();
    ctx.log(
      r.skipped
        ? 'Another indexer held the lock; watching with the current index (Ctrl-C to stop).'
        : `Indexed ${r.value.files} files in ${r.value.elapsedMs} ms. Watching (Ctrl-C to stop).`
    );
    const queue = new WatchQueue({
      indexFile: (p) => ctx.indexer.indexFile(p),
      removeFile: (p) => ctx.indexer.removeFile(p),
      async onFlushed(changed, removed) {
        await ctx.store.checkpoint();
        for (const p of [...changed, ...removed]) ctx.log(`  ~ ${p}`);
        armIdle();
      },
      onError: (p, err) => ctx.log(`  ! ${p}: ${err.message}`),
    });
    stopWatching = nodeWatchWorkspace(ctx.root, {
      changed: (p) => {
        clearIdle();
        queue.changed(p);
      },
      deleted: (p) => {
        clearIdle();
        queue.deleted(p);
      },
    });
    armIdle();
    // Keep the process alive until a signal.
    await new Promise<void>((resolve) => {
      const done = (): void => {
        stopWatching?.();
        queue.dispose();
        resolve();
      };
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  } finally {
    clearIdle();
    stopWatching?.();
    stopHeartbeat();
  }
}
