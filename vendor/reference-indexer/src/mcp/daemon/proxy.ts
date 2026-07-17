/**
 * DaemonProxy: the process every MCP client actually spawns. It never talks
 * to a workspace's stores directly — it either relays stdio↔HTTP to a shared
 * daemon, or (if the daemon is unreachable/unspawnable) falls back to running
 * today's single-workspace server in-process. See docs/DaemonDesign.md.
 *
 * Connect-or-spawn sequence:
 *  1. Read ~/.pairs/daemon.json. If a live daemon of the SAME version exists,
 *     connect and relay.
 *  2. Version mismatch: POST /shutdown (token-authed) to the old daemon, then
 *     proceed to spawn a fresh one.
 *  3. No daemon: try to win the spawn lock. Winner spawns (detached) and
 *     polls /health until ready. Losers poll the discovery file until the
 *     winner has written it, then connect.
 *  4. Any failure in 1-3: fall back to in-process single-workspace mode
 *     (server.ts main()) unless fallbackInProcess === false.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { FileDaemonDiscovery } from './discovery';
import { WORKSPACE_HEADER, type DaemonInfo, type DaemonProxy, type ProxyConfig } from './types';
import { main as runServerInProcess, parseArgs } from '../server';

const SPAWN_POLL_INTERVAL_MS = 200;
const SPAWN_POLL_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthy(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function shutdown(info: DaemonInfo): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best-effort; a dead/unreachable daemon needs no shutdown.
  }
}

/** Relays messages 1:1 between two Transport implementations until either side closes. */
function relay(a: Transport, b: Transport): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      void a.close();
      void b.close();
      resolve();
    };
    a.onmessage = (msg: JSONRPCMessage) => void b.send(msg);
    b.onmessage = (msg: JSONRPCMessage) => void a.send(msg);
    a.onclose = finish;
    b.onclose = finish;
    a.onerror = (err) => {
      console.error('[PAIRS proxy] stdio transport error:', err);
      finish();
    };
    b.onerror = (err) => {
      console.error('[PAIRS proxy] daemon connection error:', err);
      finish();
    };
  });
}

export interface DaemonProxyTestDeps {
  /** Overridable for tests; defaults to the real `mcp-daemon.js` child_process spawn. */
  spawnDaemon?: () => Promise<void>;
  /** Overridable for tests; defaults to the real fetch-based check. */
  isHealthy?: (info: DaemonInfo) => Promise<boolean>;
  /** Overridable for tests; defaults to the real fetch-based shutdown. */
  shutdown?: (info: DaemonInfo) => Promise<void>;
  /** Overridable for tests; defaults to running server.ts main() in-process. */
  runInProcessFallback?: (config: ProxyConfig) => Promise<void>;
  spawnPollIntervalMs?: number;
  spawnPollTimeoutMs?: number;
}

export class DaemonProxyImpl implements DaemonProxy {
  private readonly spawnDaemonFn: () => Promise<void>;
  private readonly isHealthyFn: (info: DaemonInfo) => Promise<boolean>;
  private readonly shutdownFn: (info: DaemonInfo) => Promise<void>;
  private readonly spawnPollIntervalMs: number;
  private readonly spawnPollTimeoutMs: number;
  private readonly runInProcessFallbackFn: (config: ProxyConfig) => Promise<void>;

  constructor(
    private readonly discovery = new FileDaemonDiscovery(),
    /** Directory the running proxy bundle lives in; passed through to the in-process fallback for grammars/queries. */
    private readonly bundleDir: string = __dirname,
    testDeps: DaemonProxyTestDeps = {}
  ) {
    this.spawnDaemonFn = testDeps.spawnDaemon ?? (() => this.spawnDaemonChildProcess());
    this.isHealthyFn = testDeps.isHealthy ?? isHealthy;
    this.shutdownFn = testDeps.shutdown ?? shutdown;
    this.spawnPollIntervalMs = testDeps.spawnPollIntervalMs ?? SPAWN_POLL_INTERVAL_MS;
    this.spawnPollTimeoutMs = testDeps.spawnPollTimeoutMs ?? SPAWN_POLL_TIMEOUT_MS;
    this.runInProcessFallbackFn = testDeps.runInProcessFallback ?? ((config) => this.runInProcessFallback(config));
  }

  async run(config: ProxyConfig): Promise<void> {
    let info: DaemonInfo | null = null;
    try {
      info = await this.connectOrSpawn(config.version);
    } catch (err) {
      console.error(`[PAIRS proxy] could not connect to or spawn shared daemon: ${(err as Error).message}`);
    }

    if (!info) {
      if (config.fallbackInProcess === false) {
        throw new Error('No shared PAiRS daemon available and in-process fallback disabled.');
      }
      console.error('[PAIRS proxy] falling back to in-process single-workspace server.');
      await this.runInProcessFallbackFn(config);
      return;
    }

    const stdio = new StdioServerTransport();
    const httpClient = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + info.port + '/mcp'), {
      requestInit: {
        headers: {
          authorization: `Bearer ${info.token}`,
          [WORKSPACE_HEADER]: config.workspaceRoot,
        },
      },
    });

    await stdio.start();
    try {
      await httpClient.start();
    } catch (err) {
      console.error(`[PAIRS proxy] daemon reachable but connect failed, falling back in-process: ${(err as Error).message}`);
      await stdio.close();
      if (config.fallbackInProcess === false) throw err;
      await this.runInProcessFallbackFn(config);
      return;
    }

    await relay(stdio, httpClient);
  }

  private async connectOrSpawn(version: string): Promise<DaemonInfo | null> {
    let info = await this.discovery.read();

    if (info && info.version !== version) {
      await this.shutdownFn(info);
      await this.discovery.clear();
      info = null;
    }

    if (info && (await this.isHealthyFn(info))) return info;
    if (info) info = null; // stale entry (dead process didn't clean up)

    // Losers of the lock race simply poll below until the winner's daemon.json appears.
    const gotLock = await this.discovery.tryLock();
    if (gotLock) await this.spawnDaemonFn();

    const deadline = Date.now() + this.spawnPollTimeoutMs;
    while (Date.now() < deadline) {
      const candidate = await this.discovery.read();
      if (candidate && (await this.isHealthyFn(candidate))) return candidate;
      await sleep(this.spawnPollIntervalMs);
    }
    return null;
  }

  private async spawnDaemonChildProcess(): Promise<void> {
    const daemonScript = path.join(this.bundleDir, 'mcp-daemon.js');
    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private async runInProcessFallback(config: ProxyConfig): Promise<void> {
    const argv = ['--db', path.join(config.workspaceRoot, '.pairs', 'memory.db'), '--code-db', path.join(config.workspaceRoot, '.pairs', 'code.db')];
    await runServerInProcess(parseArgs(argv));
  }
}
