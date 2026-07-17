/**
 * FileDaemonDiscovery — file-based discovery/lock for the shared daemon.
 * Each test gets its own temp ~/.pairs-equivalent dir so lock/pid state
 * never leaks across tests.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileDaemonDiscovery, generateToken } from './discovery';

let homeDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-daemon-test-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('FileDaemonDiscovery', () => {
  it('read() returns null when no file exists', async () => {
    const discovery = new FileDaemonDiscovery(homeDir);
    expect(await discovery.read()).toBeNull();
  });

  it('write() then read() round-trips info, and unlock() removes the lock without touching the info file', async () => {
    const discovery = new FileDaemonDiscovery(homeDir);
    expect(await discovery.tryLock()).toBe(true);

    const info = { pid: process.pid, port: 12345, token: generateToken(), version: '0.1.0', startedAt: new Date().toISOString() };
    await discovery.write(info);
    await discovery.unlock();

    expect(await discovery.read()).toEqual(info);
    expect(fs.existsSync(path.join(homeDir, 'daemon.json.lock'))).toBe(false);
  });

  it('read() treats a dead pid as absent (stale entry)', async () => {
    const discovery = new FileDaemonDiscovery(homeDir);
    // A pid essentially guaranteed not to exist.
    const deadPid = 999999;
    await discovery.write({ pid: deadPid, port: 1, token: 't', version: '0.1.0', startedAt: new Date().toISOString() });
    expect(await discovery.read()).toBeNull();
  });

  it('tryLock() is exclusive: a second caller fails while the lock is held by a live pid', async () => {
    const a = new FileDaemonDiscovery(homeDir);
    const b = new FileDaemonDiscovery(homeDir);
    expect(await a.tryLock()).toBe(true);
    expect(await b.tryLock()).toBe(false);
  });

  it('tryLock() reclaims a lock held by a dead pid', async () => {
    const homeLockPath = path.join(homeDir, 'daemon.json.lock');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(homeLockPath, '999999');

    const discovery = new FileDaemonDiscovery(homeDir);
    expect(await discovery.tryLock()).toBe(true);
  });

  it('clear() removes both the info file and the lock', async () => {
    const discovery = new FileDaemonDiscovery(homeDir);
    await discovery.tryLock();
    await discovery.write({ pid: process.pid, port: 1, token: 't', version: '0.1.0', startedAt: new Date().toISOString() });
    await discovery.clear();
    expect(await discovery.read()).toBeNull();
    expect(fs.existsSync(path.join(homeDir, 'daemon.json.lock'))).toBe(false);
  });
});
