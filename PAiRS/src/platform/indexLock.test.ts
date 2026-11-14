import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIndexLocked, withIndexLock } from './indexLock';

const tmpDir = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-lock-')), '.pairs');
const lockFile = (d: string): string => path.join(d, 'index.lock');
const DEAD_PID = 2_000_000_000;

describe('withIndexLock', () => {
  it('runs fn, returns its value and releases the lock', async () => {
    const d = tmpDir();
    const r = await withIndexLock(d, async () => 42, { wait: false });
    expect(r).toEqual({ skipped: false, value: 42 });
    expect(fs.existsSync(lockFile(d))).toBe(false);
  });

  it('releases the lock when fn throws', async () => {
    const d = tmpDir();
    await expect(withIndexLock(d, async () => { throw new Error('boom'); }, { wait: false })).rejects.toThrow('boom');
    expect(fs.existsSync(lockFile(d))).toBe(false);
  });

  it('wait:false skips while held by a live holder (and does not run fn)', async () => {
    const d = tmpDir();
    let ran = false;
    const outer = await withIndexLock(
      d,
      async () => {
        const inner = await withIndexLock(d, async () => { ran = true; }, { wait: false });
        expect(inner).toEqual({ skipped: true });
        expect(isIndexLocked(d)).toBe(true);
        return 'outer';
      },
      { wait: false }
    );
    expect(outer).toEqual({ skipped: false, value: 'outer' });
    expect(ran).toBe(false);
  });

  it('breaks a lock whose pid is dead', async () => {
    const d = tmpDir();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(lockFile(d), JSON.stringify({ pid: DEAD_PID, startedAt: Date.now(), token: 'x' }));
    const r = await withIndexLock(d, async () => 'ok', { wait: false });
    expect(r).toEqual({ skipped: false, value: 'ok' });
  });

  it('breaks a lock older than staleMs even if the pid is alive', async () => {
    const d = tmpDir();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(lockFile(d), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 10_000, token: 'x' }));
    const r = await withIndexLock(d, async () => 'ok', { wait: false, staleMs: 1000 });
    expect(r).toEqual({ skipped: false, value: 'ok' });
  });

  it('wait:true polls until the holder releases', async () => {
    const d = tmpDir();
    const order: string[] = [];
    const first = withIndexLock(
      d,
      async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 120));
        order.push('a-end');
      },
      { wait: false }
    );
    await new Promise((r) => setTimeout(r, 20));
    const second = await withIndexLock(d, async () => { order.push('b'); }, { wait: true, pollMs: 20 });
    await first;
    expect(second.skipped).toBe(false);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('wait:true gives up after timeoutMs', async () => {
    const d = tmpDir();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(lockFile(d), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'held' }));
    const r = await withIndexLock(d, async () => 1, { wait: true, pollMs: 10, timeoutMs: 60 });
    expect(r).toEqual({ skipped: true });
    // someone else's lock is left untouched
    expect(fs.existsSync(lockFile(d))).toBe(true);
  });

  it('does not delete a lock that was stolen from us', async () => {
    const d = tmpDir();
    await withIndexLock(
      d,
      async () => {
        fs.writeFileSync(lockFile(d), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'thief' }));
      },
      { wait: false }
    );
    expect(JSON.parse(fs.readFileSync(lockFile(d), 'utf8')).token).toBe('thief');
  });
});
