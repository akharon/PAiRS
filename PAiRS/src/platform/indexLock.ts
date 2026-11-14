/**
 * Cross-process full-index lock. Several agents / windows / CLI runs can
 * target the same root; without coordination they all full-index at once and
 * collide on SQLite's single writer ("database is locked").
 *
 * The lock is `.pairs/index.lock`, created exclusively (`wx`) and holding
 * `{pid, startedAt, token}`. It is stale when its pid is dead or it is older
 * than `staleMs`. Always released in `finally`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IndexLockOptions {
  /** true: poll until the lock frees (or `timeoutMs`); false: give up immediately. */
  wait: boolean;
  /** A lock older than this is considered abandoned even if its pid is alive. Default 30 min. */
  staleMs?: number;
  /** wait:true only — give up after this long. Default 10 min. */
  timeoutMs?: number;
  /** wait:true only — poll interval. Default 250 ms. */
  pollMs?: number;
}

export type LockResult<T> = { skipped: true } | { skipped: false; value: T };

interface LockBody {
  pid: number;
  startedAt: number;
  token: string;
}

export const LOCK_FILE = 'index.lock';

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours
  }
}

function readBody(file: string): { body: LockBody | null; mtimeMs: number } | null {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // vanished
  }
  try {
    const b = JSON.parse(raw) as Partial<LockBody>;
    if (typeof b.pid === 'number' && typeof b.startedAt === 'number') {
      return { body: { pid: b.pid, startedAt: b.startedAt, token: String(b.token ?? '') }, mtimeMs };
    }
  } catch {
    /* empty or half-written */
  }
  return { body: null, mtimeMs };
}

function isStale(cur: { body: LockBody | null; mtimeMs: number }, staleMs: number, now: number): boolean {
  // Unparseable: the creator may be between open() and write(). Only stale once clearly old.
  if (cur.body === null) return now - cur.mtimeMs > 10_000;
  if (now - cur.body.startedAt > staleMs) return true;
  return !pidAlive(cur.body.pid);
}

/** Try once. Returns the token we hold, or null if somebody else does. */
function tryAcquire(file: string, staleMs: number): string | null {
  const token = crypto.randomBytes(8).toString('hex');
  const body: LockBody = { pid: process.pid, startedAt: Date.now(), token };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(body));
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const cur = readBody(file);
    if (cur === null) continue; // vanished between EEXIST and read — retry
    if (!isStale(cur, staleMs, Date.now())) return null;
    // Break the stale lock, but only if it is still the one we judged stale.
    const again = readBody(file);
    if (again !== null && again.body?.token === cur.body?.token && again.body?.pid === cur.body?.pid) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else broke it first */
      }
    }
  }
  return null;
}

function release(file: string, token: string): void {
  const cur = readBody(file);
  if (cur?.body?.token !== token) return; // not ours any more (stolen as stale) — leave it
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding `<pairsDir>/index.lock`. `{ skipped: true }` means the
 * lock was held elsewhere (wait:false) or the wait timed out; `fn` did not run.
 * Creates `pairsDir` if missing.
 */
export async function withIndexLock<T>(
  pairsDir: string,
  fn: () => Promise<T>,
  opts: IndexLockOptions
): Promise<LockResult<T>> {
  const staleMs = opts.staleMs ?? 30 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 250;
  fs.mkdirSync(pairsDir, { recursive: true });
  const file = path.join(pairsDir, LOCK_FILE);

  const deadline = Date.now() + timeoutMs;
  let token = tryAcquire(file, staleMs);
  while (token === null) {
    if (!opts.wait || Date.now() >= deadline) return { skipped: true };
    await sleep(pollMs);
    token = tryAcquire(file, staleMs);
  }
  try {
    return { skipped: false, value: await fn() };
  } finally {
    release(file, token);
  }
}

/** Is an index lock currently held by a live holder? (diagnostics / tests) */
export function isIndexLocked(pairsDir: string, staleMs = 30 * 60_000): boolean {
  const cur = readBody(path.join(pairsDir, LOCK_FILE));
  return cur !== null && !isStale(cur, staleMs, Date.now());
}
