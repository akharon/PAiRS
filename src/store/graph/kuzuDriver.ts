/**
 * Thin adapter from the `kuzu` npm package to codeStoreImpl.ts's KuzuDriver
 * interface — kept separate so tests can inject a fake without loading the
 * native addon, and so the R4 native-addon packaging boundary (esbuild
 * `external: ['kuzu']`) has exactly one file that imports it.
 */

import kuzu from 'kuzu';
import type { KuzuConnectionLike, KuzuDriver } from './codeStoreImpl';

/**
 * Kuzu 0.11.3 defaults to a 16 MB autoCheckpoint threshold with no way to
 * force one on close (dispose() is a no-op — see codeStoreImpl.ts), so the
 * WAL grows unbounded across a session unless something merges it sooner.
 * Lowering the threshold bounds how large the WAL gets between the explicit
 * `checkpoint()` calls (fullIndex, watch idle, deactivate) — belt-and-braces,
 * not a substitute for them.
 */
const CHECKPOINT_THRESHOLD_BYTES = 4 * 1024 * 1024;

export const nodeKuzuDriver: KuzuDriver = {
  async openDatabase(dbPath: string) {
    return new kuzu.Database(dbPath, undefined, undefined, undefined, undefined, true, CHECKPOINT_THRESHOLD_BYTES);
  },
  async openConnection(db) {
    // kuzu.Connection already exposes query/prepare/execute with the shapes
    // KuzuConnectionLike expects — pass it through directly so the store's
    // parameterized-UNWIND fast path (execRows) is live in production.
    return new kuzu.Connection(db as InstanceType<typeof kuzu.Database>) as unknown as KuzuConnectionLike;
  },
};

/**
 * Read-only variant for a *snapshot copy* of the db (see cli/index.ts's
 * lock-fallback path). Kuzu 0.11.3 takes an exclusive file lock even for
 * `readOnly` opens, so this still can't share a live db with another
 * process — it only helps once the files have been copied elsewhere.
 */
export const nodeKuzuReadOnlyDriver: KuzuDriver = {
  async openDatabase(dbPath: string) {
    return new kuzu.Database(dbPath, undefined, undefined, true);
  },
  async openConnection(db) {
    return new kuzu.Connection(db as InstanceType<typeof kuzu.Database>) as unknown as KuzuConnectionLike;
  },
};
