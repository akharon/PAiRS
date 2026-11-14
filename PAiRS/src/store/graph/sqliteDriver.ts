/**
 * Adapter from `node:sqlite` (built into Node 22+, which package.json already
 * requires) to the SqlDriver interface sqliteCodeStore.ts talks to.
 *
 * Kept separate so one file owns the runtime dependency: tests can inject a
 * fake, and the bundler has a single place to treat as external. This is not
 * a native addon — nothing to compile, nothing to ship per-platform, and one
 * `.vsix` covers every architecture.
 *
 * `node:sqlite` is flagged experimental in Node 22 (it emits a warning on
 * first use, silenced below). It is stable enough for a rebuildable local
 * index: worst case the index is deleted and re-derived from source.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, SQLOutputValue } from 'node:sqlite';

/**
 * Loaded through `createRequire` rather than a static import because Vite (so
 * vitest) does not recognise `node:sqlite` as a builtin: it strips the `node:`
 * prefix, looks for a package named `sqlite` on disk, and fails to resolve.
 * Going through require keeps the specifier out of the bundler's module graph
 * and hands it straight to Node.
 */
const nodeRequire = createRequire(__filename);
type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType };
let cached: SqliteModule | null = null;
function sqlite(): SqliteModule {
  if (cached === null) cached = nodeRequire('node:sqlite') as SqliteModule;
  return cached;
}

export interface SqlStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  /** Row-at-a-time iteration: use over big tables so rows are not all materialized first. */
  iterate(...params: unknown[]): Iterable<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface SqlConnectionLike {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Register a scalar SQL function (used for `regexp_matches` in rules). */
  addFunction(name: string, fn: (...args: unknown[]) => unknown): void;
  close(): void;
}

export interface ReadOnlyOpenOptions {
  /**
   * Open with SQLite's `immutable=1`: no locks, no `-shm`/`-wal` access, the
   * file is assumed not to change underneath us. The only way to read a WAL
   * database whose `-shm` is held by a process on the other side of a
   * WSL <-> Windows (9p/drvfs) boundary. Anything still in the `-wal` is invisible.
   */
  immutable: boolean;
}

export interface SqlDriver {
  open(dbPath: string): SqlConnectionLike;
  /**
   * Read-only handle that runs no write pragmas (journal_mode, auto_vacuum, ...).
   * Optional so test fakes need not implement it.
   */
  openReadOnly?(dbPath: string, opts: ReadOnlyOpenOptions): SqlConnectionLike;
}

/**
 * `file:` URI for an absolute filesystem path (POSIX `/x/y` -> `file:/x/y`,
 * Windows `C:\x` -> `file:///C:/x`), with the characters that would start the
 * query string or an escape percent-encoded.
 */
export function fileUri(absPath: string, query = ''): string {
  let p = absPath.replace(/\\/g, '/');
  p = p.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const head = /^[A-Za-z]:/.test(p) ? `file:///${p}` : p.startsWith('//') ? `file:${p}` : `file:${p.startsWith('/') ? '' : '/'}${p}`;
  return query === '' ? head : `${head}?${query}`;
}

/**
 * True for the error class that means "this file cannot be used by us right
 * now" rather than "this file is bad": I/O errors (SQLITE_IOERR, e.g. -shm
 * cannot be mapped across the WSL/Windows boundary), cantopen, busy, locked,
 * protocol and readonly-cantinit. Uses the numeric result code when
 * `node:sqlite` provides it, the message otherwise.
 */
export function isLockClassError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { errcode?: unknown; message?: unknown };
  if (typeof e.errcode === 'number') {
    const primary = e.errcode & 0xff;
    if ([5, 6, 8, 10, 14, 15].includes(primary)) return true;
  }
  return /disk I\/O error|unable to open database|database is locked|database table is locked|database schema is locked|attempt to write a readonly|locking protocol/i.test(
    String(e.message ?? '')
  );
}

/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` on
 * first use. It is noise on every CLI invocation and every extension
 * activation, so drop that one warning and let every other through.
 */
function silenceSqliteExperimentalWarning(): void {
  const anyProc = process as NodeJS.Process & { __pairsSqliteWarnPatched?: boolean };
  if (anyProc.__pairsSqliteWarnPatched === true) return;
  anyProc.__pairsSqliteWarnPatched = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    (original as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

function wrap(db: DatabaseSyncType): SqlConnectionLike {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        all: (...p: unknown[]) => st.all(...(p as SQLInputValue[])) as Record<string, unknown>[],
        run: (...p: unknown[]) => st.run(...(p as SQLInputValue[])),
        get: (...p: unknown[]) => st.get(...(p as SQLInputValue[])) as Record<string, unknown> | undefined,
        // StatementSync.iterate landed in Node 22.13; older 22.x falls back to all().
        iterate: (...p: unknown[]) =>
          typeof (st as { iterate?: unknown }).iterate === 'function'
            ? ((st as unknown as { iterate(...a: SQLInputValue[]): Iterable<Record<string, unknown>> }).iterate(...(p as SQLInputValue[])))
            : (st.all(...(p as SQLInputValue[])) as Record<string, unknown>[]),
      };
    },
    // `varargs: true` is required: SQLite takes the callback's declared
    // arity from `fn.length`, and a rest-parameter reports 0 — so without
    // this every call fails with "wrong number of arguments".
    addFunction: (name, fn) =>
      db.function(name, { varargs: true, deterministic: true }, (...args: SQLOutputValue[]): SQLInputValue => fn(...args) as SQLInputValue),
    close: () => db.close(),
  };
}

export const nodeSqlDriver: SqlDriver = {
  open(dbPath: string): SqlConnectionLike {
    silenceSqliteExperimentalWarning();
    const db = new (sqlite().DatabaseSync)(dbPath);
    try {
      // Multi-process: the extension host, a `pairs watch` and ad-hoc CLI runs can
      // all hold this file. A writer that meets another writer must wait, not fail
      // with SQLITE_BUSY ("database is locked"). Set first so it also covers the
      // journal_mode switch below.
      db.exec('PRAGMA busy_timeout = 5000');
      // auto_vacuum is baked into the file header at creation: it must be chosen
      // before the first table (and before the WAL switch writes page 1). Only a
      // brand-new file (zero pages) can take it for free; an existing file is
      // converted by SqliteCodeStore's schema-reset path (needs a VACUUM).
      // INCREMENTAL (not FULL): freed pages go to the freelist and are returned to
      // the OS on demand via `incremental_vacuum` (store.compact()), instead of
      // FULL's per-commit truncation cost during bulk indexing.
      const pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? 0);
      if (pageCount === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      // WAL: the indexer writes while readers (rule checks, tools) query.
      // synchronous=NORMAL is the right trade for derived data — a torn write
      // after a crash costs a re-index, not user data.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');
      // Cap the -wal file at 64 MB after a checkpoint instead of letting one big
      // index burst leave it at its high-water mark forever.
      db.exec('PRAGMA journal_size_limit = 67108864');
      // 16 MB page cache (default is ~2 MB): the resolver and bulk insert touch
      // the same hot B-tree pages repeatedly. Per-connection, bounded, cheap.
      // temp_store is left at its default (file): MEMORY would pin the big
      // DISTINCT/ORDER BY temp b-trees of analysis queries in the extension host.
      db.exec('PRAGMA cache_size = -16000');
    } catch (err) {
      // Don't leak the handle (and its WAL/shm fds) when the file is unusable.
      try {
        db.close();
      } catch {
        /* already closed */
      }
      throw err;
    }
    return wrap(db);
  },

  /**
   * Read-only handle for when the normal open fails (see `isLockClassError`).
   * Runs no journal_mode / auto_vacuum / synchronous pragmas, which all write.
   * The filename is a URI so `immutable=1` can be passed.
   */
  openReadOnly(dbPath: string, opts: ReadOnlyOpenOptions): SqlConnectionLike {
    silenceSqliteExperimentalWarning();
    const db = new (sqlite().DatabaseSync)(fileUri(dbPath, opts.immutable ? 'immutable=1' : 'mode=ro'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA cache_size = -16000');
      // Surface "cannot read this file" now (open() is lazy about the first page).
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (err) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      throw err;
    }
    return wrap(db);
  },
};
