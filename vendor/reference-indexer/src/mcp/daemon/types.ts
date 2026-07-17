/**
 * Contracts for the shared PAiRS daemon (see docs/DaemonDesign.md).
 *
 * One daemon per user serves all workspaces over localhost HTTP; stdio MCP
 * clients spawn a thin proxy that connects-or-spawns the daemon and forwards.
 * Workspace routing is per-SESSION (proxy sends `X-Pairs-Workspace` on
 * connect), never a per-tool parameter — the 13 tool schemas are unchanged.
 *
 * Interfaces only; implementations live in discovery.ts / workspaceRegistry.ts /
 * daemon.ts / proxy.ts (pending).
 */

import type { MemoryToolExecutor, CodeToolExecutor } from '../tools';

/** HTTP header carrying the session's workspace root on MCP connect. */
export const WORKSPACE_HEADER = 'X-Pairs-Workspace';

/** Contents of the discovery file `~/.pairs/daemon.json` (mode 0600). */
export interface DaemonInfo {
  pid: number;
  /** Loopback port the daemon listens on (OS-assigned at start). */
  port: number;
  /** Bearer token required on every HTTP request. */
  token: string;
  /** Daemon bundle version; proxies with a different version replace it. */
  version: string;
  startedAt: string; // ISO
}

/**
 * Reads/writes the discovery file. Implementations must validate liveness
 * (pid exists) on read and write atomically under an exclusive lock so two
 * racing proxies spawn at most one daemon.
 */
export interface DaemonDiscovery {
  /** Returns null when absent, stale (dead pid), or unparsable. */
  read(): Promise<DaemonInfo | null>;
  /** Acquire the spawn lock; returns false if another spawner holds it. */
  tryLock(): Promise<boolean>;
  write(info: DaemonInfo): Promise<void>;
  /** Remove file + lock (daemon shutdown, or stale-state cleanup). */
  clear(): Promise<void>;
  /** Release the spawn lock once `write` has succeeded, without clearing the info file. */
  unlock(): Promise<void>;
}

/** One open workspace inside the daemon: stores + executors + indexer state. */
export interface WorkspaceHandle {
  /** Absolute workspace root (contains `.pairs/`). */
  readonly root: string;
  readonly memory: MemoryToolExecutor;
  /** Undefined when the workspace has no code.db and indexing is disabled. */
  readonly code?: CodeToolExecutor;
  /** True while the headless activation scan for this root is in flight. */
  readonly indexing: boolean;
  readonly lastUsedAt: number; // epoch ms, bumped on every tool call
  close(): Promise<void>;
}

export interface WorkspaceInfo {
  root: string;
  openedAt: string; // ISO
  indexing: boolean;
  /** From CodeStore.stats() when a code db is open. */
  files?: number;
  symbols?: number;
  sessions: number;
}

/**
 * Daemon-side root → handle map. `acquire` is the only entry point sessions
 * use; it lazily opens `.pairs/` stores and starts AT MOST ONE headless
 * indexer per root regardless of how many sessions share it.
 */
export interface WorkspaceRegistry {
  /**
   * Open (or return the existing) handle for `root`. Rejects when `root` has
   * no `.pairs/` directory — the daemon never creates indexes for arbitrary
   * paths on request.
   */
  acquire(root: string): Promise<WorkspaceHandle>;
  /** Mark a root as having one more/fewer active session, so evictIdle never closes a root still in use. */
  retain(root: string): void;
  release(root: string): void;
  list(): Promise<WorkspaceInfo[]>;
  /** Close handles idle longer than maxIdleMs; returns count closed. */
  evictIdle(maxIdleMs: number): Promise<number>;
  closeAll(): Promise<void>;
  /**
   * Roots ever acquired by this user's daemon, persisted to
   * `~/.pairs/workspaces.json` (deduped, capped ~50, most-recent-first).
   * Roots whose `.pairs/` no longer exists at read time are dropped.
   * Used by `memory_search scope:"all"` fan-out and `workspace_list`'s
   * closed-roots listing.
   */
  knownRoots(): Promise<string[]>;
}

export interface DaemonConfig {
  /** 0 = OS-assigned (default). */
  port?: number;
  /** Exit when no sessions and no indexing for this long. Default 30 min. */
  idleExitMs?: number;
  /** Close idle workspace handles after this long. Default 10 min. */
  workspaceIdleMs?: number;
  version: string;
}

/**
 * The daemon process. Serves MCP per-session over StreamableHTTPServerTransport
 * plus `/health` and token-authed `/shutdown`; registers the 13 standard tools
 * (dispatching through the session's WorkspaceHandle) and the two daemon-only
 * meta-tools `workspace_list` / `workspace_use`.
 */
export interface PairsDaemon {
  /** Bind, write the discovery file, start the idle timer. */
  start(): Promise<DaemonInfo>;
  /** Drain sessions, closeAll workspaces, clear discovery file. */
  stop(): Promise<void>;
}

export interface ProxyConfig {
  /** Workspace this client is bound to (sent as WORKSPACE_HEADER). */
  workspaceRoot: string;
  /** Own bundle version, compared against DaemonInfo.version for skew. */
  version: string;
  /**
   * When the daemon can neither be reached nor spawned, serve single-workspace
   * in-process (today's server.ts main()) instead of failing. Default true.
   */
  fallbackInProcess?: boolean;
}

/**
 * stdio side, spawned by MCP clients. connect-or-spawn sequence:
 * read discovery → live+version-match? connect : (tryLock? spawn : wait) →
 * forward stdio↔HTTP. On version skew: POST /shutdown, spawn fresh.
 */
export interface DaemonProxy {
  /** Runs until the stdio client disconnects. */
  run(config: ProxyConfig): Promise<void>;
}
