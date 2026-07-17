/**
 * DaemonProxyImpl.connectOrSpawn() — no real daemon process or network I/O;
 * isHealthy/shutdown/spawnDaemon/runInProcessFallback are all injected fakes
 * so these tests exercise only the decision logic (version skew, spawn-race,
 * fallback) fast and deterministically.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonProxyImpl } from './proxy';
import { FileDaemonDiscovery, generateToken } from './discovery';
import type { DaemonInfo, ProxyConfig } from './types';

let homeDir: string;
let discovery: FileDaemonDiscovery;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-proxy-test-'));
  discovery = new FileDaemonDiscovery(homeDir);
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

const config: ProxyConfig = { workspaceRoot: '/some/workspace', version: '1.0.0' };

function makeInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return { pid: process.pid, port: 4000, token: generateToken(), version: '1.0.0', startedAt: new Date().toISOString(), ...overrides };
}

describe('DaemonProxyImpl fallback and spawn logic', () => {
  it('falls back in-process when no daemon exists and spawning never produces a healthy one', async () => {
    const runInProcessFallback = vi.fn(async () => {});
    const proxy = new DaemonProxyImpl(discovery, '/bundle', {
      spawnDaemon: async () => {},
      isHealthy: async () => false,
      spawnPollIntervalMs: 5,
      spawnPollTimeoutMs: 20,
      runInProcessFallback,
    });

    await proxy.run(config);

    expect(runInProcessFallback).toHaveBeenCalledWith(config);
  });

  it('throws instead of falling back when fallbackInProcess is false and no daemon is reachable', async () => {
    const proxy = new DaemonProxyImpl(discovery, '/bundle', {
      spawnDaemon: async () => {},
      isHealthy: async () => false,
      spawnPollIntervalMs: 5,
      spawnPollTimeoutMs: 20,
    });

    await expect(proxy.run({ ...config, fallbackInProcess: false })).rejects.toThrow(/disabled/);
  });

  it('shuts down and replaces a daemon with a different version before proceeding', async () => {
    const oldInfo = makeInfo({ version: '0.9.0' });
    await discovery.write(oldInfo);

    const shutdown = vi.fn(async () => {});
    const runInProcessFallback = vi.fn(async () => {});
    const proxy = new DaemonProxyImpl(discovery, '/bundle', {
      shutdown,
      spawnDaemon: async () => {},
      isHealthy: async () => false, // new spawn never comes healthy in this test
      spawnPollIntervalMs: 5,
      spawnPollTimeoutMs: 20,
      runInProcessFallback,
    });

    await proxy.run(config); // config.version = '1.0.0', mismatches oldInfo

    expect(shutdown).toHaveBeenCalledWith(oldInfo);
    expect(await discovery.read()).toBeNull(); // clear() ran
    expect(runInProcessFallback).toHaveBeenCalled();
  });

  it('does not spawn when a live same-version daemon is already discoverable, and relays through it', async () => {
    // A bare HTTP server standing in for the daemon: the proxy should reach
    // it, never attempt to spawn a new one, and never fall back in-process.
    const server = http.createServer((_req, res) => res.writeHead(200).end('{}'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const info = makeInfo({ port });
    await discovery.write(info);

    const spawnDaemon = vi.fn(async () => {});
    const runInProcessFallback = vi.fn(async () => {});
    const proxy = new DaemonProxyImpl(discovery, '/bundle', {
      spawnDaemon,
      isHealthy: async () => true,
      runInProcessFallback,
    });

    // The relay itself runs until the (fake) daemon connection closes, which
    // never happens here deliberately — we only need to observe that spawn
    // was skipped and fallback wasn't triggered, so race run() against a timer.
    const runPromise = proxy.run(config);
    await Promise.race([runPromise, new Promise((resolve) => setTimeout(resolve, 300))]);

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(runInProcessFallback).not.toHaveBeenCalled();

    server.close();
  });

  it('spawn-lock loser never spawns and instead polls discovery until the winner publishes daemon.json', async () => {
    // Simulate two proxies racing: hold the lock ourselves (standing in for
    // a winning proxy) so this proxy's tryLock() fails and it must poll.
    await discovery.tryLock();

    const spawnDaemon = vi.fn(async () => {});
    const runInProcessFallback = vi.fn(async () => {});
    const proxy = new DaemonProxyImpl(discovery, '/bundle', {
      spawnDaemon,
      isHealthy: async () => false, // never healthy -> falls back once polling times out
      spawnPollIntervalMs: 5,
      spawnPollTimeoutMs: 30,
      runInProcessFallback,
    });

    await proxy.run(config);

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(runInProcessFallback).toHaveBeenCalledWith(config);
  });
});
