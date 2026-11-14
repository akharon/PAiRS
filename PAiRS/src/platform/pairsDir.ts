/**
 * Small helpers around the `.pairs/` state directory shared by the CLI and the
 * extension: self-ignoring creation, the watcher heartbeat and the CLI's
 * auto-refresh throttle. Plain node fs — editor-agnostic (G1).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Create `<root>/.pairs/` containing a `.gitignore` of `*`, so the directory
 * ignores itself and PAiRS never has to edit the user's tracked .gitignore
 * (which dirtied every worktree). Returns the directory path.
 */
export function ensurePairsDir(root: string): string {
  const dir = path.join(root, '.pairs');
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) {
    try {
      fs.writeFileSync(gi, '*\n', 'utf8');
    } catch {
      /* best effort */
    }
  }
  return dir;
}

// -- Watcher heartbeat -----------------------------------------------------------

export const HEARTBEAT_FILE = 'watcher.json';
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_FRESH_MS = 90_000;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function writeHeartbeat(pairsDir: string, now = Date.now()): void {
  try {
    fs.mkdirSync(pairsDir, { recursive: true });
    fs.writeFileSync(path.join(pairsDir, HEARTBEAT_FILE), JSON.stringify({ pid: process.pid, updatedAt: now }), 'utf8');
  } catch {
    /* best effort */
  }
}

/** Remove the heartbeat, but only if it is ours (another window may own it now). */
export function removeHeartbeat(pairsDir: string): void {
  const file = path.join(pairsDir, HEARTBEAT_FILE);
  try {
    const hb = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    if (hb.pid !== process.pid) return;
    fs.unlinkSync(file);
  } catch {
    /* absent or unreadable */
  }
}

/** A watcher (extension or `pairs watch`) is keeping this index fresh: heartbeat < 90 s old and its pid alive. */
export function hasLiveWatcher(pairsDir: string, now = Date.now()): boolean {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(pairsDir, HEARTBEAT_FILE), 'utf8')) as {
      pid?: number;
      updatedAt?: number;
    };
    if (typeof hb.pid !== 'number' || typeof hb.updatedAt !== 'number') return false;
    return now - hb.updatedAt < HEARTBEAT_FRESH_MS && pidAlive(hb.pid);
  } catch {
    return false;
  }
}

/** Write a heartbeat now and every 30 s; the returned stop() clears the timer and removes the file. */
export function startHeartbeat(pairsDir: string, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  writeHeartbeat(pairsDir);
  const timer = setInterval(() => writeHeartbeat(pairsDir), intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    removeHeartbeat(pairsDir);
  };
}

// -- Refresh throttle ----------------------------------------------------------------

export const LAST_REFRESH_FILE = 'last-refresh';
export const REFRESH_THROTTLE_MS = 30_000;

export function markRefreshed(pairsDir: string, now = Date.now()): void {
  try {
    fs.writeFileSync(path.join(pairsDir, LAST_REFRESH_FILE), String(now), 'utf8');
  } catch {
    /* best effort */
  }
}

/** True when the last full refresh/index was more than `throttleMs` ago (or never happened). */
export function refreshDue(pairsDir: string, now = Date.now(), throttleMs = REFRESH_THROTTLE_MS): boolean {
  try {
    const file = path.join(pairsDir, LAST_REFRESH_FILE);
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    const last = Number.isFinite(n) && n > 0 ? n : fs.statSync(file).mtimeMs;
    return now - last > throttleMs;
  } catch {
    return true;
  }
}
