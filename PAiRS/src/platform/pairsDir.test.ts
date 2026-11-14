import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensurePairsDir,
  hasLiveWatcher,
  markRefreshed,
  refreshDue,
  removeHeartbeat,
  startHeartbeat,
  writeHeartbeat,
} from './pairsDir';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-dir-'));

describe('ensurePairsDir', () => {
  it('creates .pairs with a self-ignoring .gitignore and never touches the root .gitignore', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
    const dir = ensurePairsDir(root);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');
    // idempotent, preserves an existing file
    fs.writeFileSync(path.join(dir, '.gitignore'), 'custom\n');
    ensurePairsDir(root);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('custom\n');
  });
});

describe('watcher heartbeat', () => {
  it('is live when fresh and the pid is alive', () => {
    const d = ensurePairsDir(tmp());
    expect(hasLiveWatcher(d)).toBe(false);
    writeHeartbeat(d);
    expect(hasLiveWatcher(d)).toBe(true);
  });

  it('is not live when stale (> 90 s) or the pid is dead', () => {
    const d = ensurePairsDir(tmp());
    writeHeartbeat(d, Date.now() - 120_000);
    expect(hasLiveWatcher(d)).toBe(false);
    fs.writeFileSync(path.join(d, 'watcher.json'), JSON.stringify({ pid: 2_000_000_000, updatedAt: Date.now() }));
    expect(hasLiveWatcher(d)).toBe(false);
  });

  it('startHeartbeat writes immediately and stop() removes the file', () => {
    const d = ensurePairsDir(tmp());
    const stop = startHeartbeat(d, 60_000);
    expect(hasLiveWatcher(d)).toBe(true);
    stop();
    expect(fs.existsSync(path.join(d, 'watcher.json'))).toBe(false);
  });

  it('removeHeartbeat leaves another process\'s heartbeat alone', () => {
    const d = ensurePairsDir(tmp());
    fs.writeFileSync(path.join(d, 'watcher.json'), JSON.stringify({ pid: process.pid + 1, updatedAt: Date.now() }));
    removeHeartbeat(d);
    expect(fs.existsSync(path.join(d, 'watcher.json'))).toBe(true);
  });
});

describe('refresh throttle', () => {
  it('is due when never refreshed, then not due for 30 s', () => {
    const d = ensurePairsDir(tmp());
    expect(refreshDue(d)).toBe(true);
    markRefreshed(d);
    expect(refreshDue(d)).toBe(false);
    expect(refreshDue(d, Date.now() + 31_000)).toBe(true);
  });
});
