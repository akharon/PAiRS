/**
 * Thin adapter from the `kuzu` npm package to codeStoreImpl.ts's KuzuDriver
 * interface — kept separate so tests can inject a fake without loading the
 * native addon, and so the R4 native-addon packaging boundary (esbuild
 * `external: ['kuzu']`) has exactly one file that imports it.
 */

import kuzu from 'kuzu';
import type { KuzuConnectionLike, KuzuDriver } from './codeStoreImpl';

export const nodeKuzuDriver: KuzuDriver = {
  async openDatabase(dbPath: string) {
    return new kuzu.Database(dbPath);
  },
  async openConnection(db) {
    // kuzu.Connection already exposes query/prepare/execute with the shapes
    // KuzuConnectionLike expects — pass it through directly so the store's
    // parameterized-UNWIND fast path (execRows) is live in production.
    return new kuzu.Connection(db as InstanceType<typeof kuzu.Database>) as unknown as KuzuConnectionLike;
  },
};
