import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileUri, isLockClassError, nodeSqlDriver, type SqlConnectionLike } from './sqliteDriver';

const dirs: string[] = [];
const conns: SqlConnectionLike[] = [];
afterEach(() => {
  while (conns.length) {
    try {
      conns.pop()!.close();
    } catch {
      /* closed */
    }
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seededDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-drv-'));
  dirs.push(dir);
  const p = path.join(dir, 'index.db');
  const c = nodeSqlDriver.open(p);
  c.exec('CREATE TABLE t(x INTEGER)');
  c.exec('INSERT INTO t VALUES (1),(2),(3)');
  c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  c.close();
  return p;
}

describe('fileUri', () => {
  it('maps POSIX and Windows paths and escapes URI metacharacters', () => {
    expect(fileUri('/mnt/d/x/index.db')).toBe('file:/mnt/d/x/index.db');
    expect(fileUri('C:\\a b\\i.db', 'immutable=1')).toBe('file:///C:/a b/i.db?immutable=1');
    expect(fileUri('/a/b#c?d%e')).toBe('file:/a/b%23c%3Fd%25e');
  });
});

describe('isLockClassError', () => {
  it('recognises I/O, busy, locked, cantopen by code or message', () => {
    expect(isLockClassError(Object.assign(new Error('x'), { errcode: 4618 }))).toBe(true); // IOERR_*
    expect(isLockClassError(Object.assign(new Error('x'), { errcode: 5 }))).toBe(true); // BUSY
    expect(isLockClassError(Object.assign(new Error('x'), { errcode: 14 }))).toBe(true); // CANTOPEN
    expect(isLockClassError(new Error('disk I/O error'))).toBe(true);
    expect(isLockClassError(new Error('database is locked'))).toBe(true);
  });
  it('does not claim corruption or ordinary errors', () => {
    expect(isLockClassError(Object.assign(new Error('file is not a database'), { errcode: 26 }))).toBe(false);
    expect(isLockClassError(new Error('no such table: Foo'))).toBe(false);
    expect(isLockClassError('boom')).toBe(false);
    expect(isLockClassError(null)).toBe(false);
  });
});

describe('nodeSqlDriver.openReadOnly', () => {
  it('reads an index via an immutable URI and refuses writes', () => {
    const p = seededDb();
    const c = nodeSqlDriver.openReadOnly!(p, { immutable: true });
    conns.push(c);
    expect(c.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
    expect(() => c.exec('INSERT INTO t VALUES (4)')).toThrow(/readonly/i);
  });

  it('reads the same file in non-immutable read-only mode, and leaves no -wal/-shm behind a checkpointed file', () => {
    const p = seededDb();
    const c = nodeSqlDriver.openReadOnly!(p, { immutable: false });
    conns.push(c);
    expect(c.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
  });

  it('works for a path with URI metacharacters', () => {
    const p = seededDb();
    const odd = path.join(path.dirname(p), 'we#ird name.db');
    fs.copyFileSync(p, odd);
    const c = nodeSqlDriver.openReadOnly!(odd, { immutable: true });
    conns.push(c);
    expect(c.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
  });

  it('throws (and does not leak) for a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-drv-'));
    dirs.push(dir);
    expect(() => nodeSqlDriver.openReadOnly!(path.join(dir, 'nope.db'), { immutable: true })).toThrow();
  });
});
