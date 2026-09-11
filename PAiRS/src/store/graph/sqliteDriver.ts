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
type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSyncType };
let cached: SqliteModule | null = null;
function sqlite(): SqliteModule {
  if (cached === null) cached = nodeRequire('node:sqlite') as SqliteModule;
  return cached;
}

export interface SqlStatement {
  all(...params: unknown[]): Record<string, unknown>[];
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

export interface SqlDriver {
  open(dbPath: string): SqlConnectionLike;
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

export const nodeSqlDriver: SqlDriver = {
  open(dbPath: string): SqlConnectionLike {
    silenceSqliteExperimentalWarning();
    const db = new (sqlite().DatabaseSync)(dbPath);
    // WAL: the indexer writes while readers (rule checks, tools) query.
    // synchronous=NORMAL is the right trade for derived data — a torn write
    // after a crash costs a re-index, not user data.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql) as unknown as SqlStatement,
      // `varargs: true` is required: SQLite takes the callback's declared
      // arity from `fn.length`, and a rest-parameter reports 0 — so without
      // this every call fails with "wrong number of arguments".
      addFunction: (name, fn) =>
        db.function(name, { varargs: true, deterministic: true }, (...args: SQLOutputValue[]): SQLInputValue => fn(...args) as SQLInputValue),
      close: () => db.close(),
    };
  },
};
