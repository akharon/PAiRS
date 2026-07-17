/**
 * Thin adapter from the `kuzu` npm package to codeStoreImpl.ts's KuzuDriver
 * interface — kept separate so tests can inject a fake without loading the
 * native addon, and so the R4 native-addon packaging boundary (esbuild
 * `external: ['kuzu']`) has exactly one file that imports it.
 */

import kuzu from 'kuzu';
import type { KuzuDriver } from './codeStoreImpl';

export const nodeKuzuDriver: KuzuDriver = {
  async openDatabase(dbPath: string) {
    return new kuzu.Database(dbPath);
  },
  async openConnection(db) {
    return new kuzu.Connection(db as InstanceType<typeof kuzu.Database>);
  },
};
