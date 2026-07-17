/**
 * Root -> WorkspaceHandle map inside the daemon. `acquire()` lazily opens a
 * workspace's `.pairs/memory.db` (+ `.pairs/code.db` when present), builds the
 * same MemoryToolExecutor/CodeToolExecutor used by every other transport, and
 * starts AT MOST ONE headless indexer per root regardless of how many
 * sessions share it. See docs/DaemonDesign.md.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteMemoryStoreFactory } from '../../core/sqliteStore';
import { SqliteCodeStoreFactory } from '../../index/codeStoreImpl';
import { CodeSearchImpl } from '../../index/codeSearchImpl';
import { createGitOps } from '../../index/gitOps';
import { startHeadlessIndexer } from '../../index/headlessIndexer';
import type { CodeStore } from '../../index/codeStore';
import type { GitOps } from '../../index/codeIndexer';
import type { HeadlessIndexerOptions } from '../../index/headlessIndexer';
import type { IndexFreshness, IndexProvenanceService } from '../../index/provenance';
import type { MemoryStore } from '../../core/store';
import type { MemoryToolExecutorImpl } from '../toolExecutor';
import type { CodeToolExecutorImpl } from '../codeToolExecutor';
import { createExecutors } from '../createExecutors';
import type { WorkspaceHandle, WorkspaceInfo, WorkspaceRegistry } from './types';

class WorkspaceHandleImpl implements WorkspaceHandle {
  readonly memory: MemoryToolExecutorImpl;
  readonly code?: CodeToolExecutorImpl;
  indexing = false;
  lastUsedAt = Date.now();
  readonly openedAt = new Date().toISOString();
  /** Set once startIndexer resolves, so close() can dispose its embedding provider. */
  indexerHandle: { dispose(): void } | undefined;
  /** Set once startIndexer resolves, when it returns a live freshness() getter (real headless indexer only). */
  liveFreshness: (() => Promise<IndexFreshness | null>) | undefined;

  constructor(
    readonly root: string,
    private readonly memoryStore: MemoryStore,
    private readonly codeStore: CodeStore | undefined,
    git?: GitOps,
    provenance?: IndexProvenanceService
  ) {
    const executors = createExecutors({
      store: memoryStore,
      git,
      code: codeStore
        ? {
            store: codeStore,
            search: new CodeSearchImpl({ store: codeStore }),
            provenance,
            freshness: provenance
              ? () => (this.liveFreshness ? this.liveFreshness() : provenance.freshness({ git }))
              : undefined,
          }
        : undefined,
    });
    this.memory = executors.memory;
    this.code = executors.code;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  async stats(): Promise<{ files?: number; symbols?: number }> {
    if (!this.codeStore) return {};
    const s = await this.codeStore.stats();
    return { files: s.files, symbols: s.symbols };
  }

  async close(): Promise<void> {
    this.indexerHandle?.dispose();
    this.memoryStore.dispose();
    this.codeStore?.dispose();
  }
}

export interface WorkspaceRegistryDeps {
  /** Directory the running bundle lives in — grammars/queries sit next to it. */
  bundleDir: string;
  /** Overridable for tests; defaults to the real sqlite factory. */
  openMemoryStore?: (dbPath: string) => Promise<MemoryStore>;
  /** Overridable for tests; defaults to the real sqlite factory. */
  openCodeStore?: (dbPath: string) => Promise<CodeStore>;
  /**
   * Overridable for tests; defaults to the real sqlite factory. Enables
   * generation stamps (docs/MemoryIndexSynergy.md §F1). When omitted (test
   * fakes that only set openCodeStore), provenance/git are simply undefined
   * — the workspace still works, just without freshness footers.
   */
  openCodeStoreWithProvenance?: (dbPath: string) => Promise<{ store: CodeStore; provenance: IndexProvenanceService }>;
  /**
   * Overridable for tests; defaults to the real `git` CLI + sidecar-file
   * GitOps (docs/MemoryIndexSynergy.md §F1/§F2). Constructed eagerly per
   * workspace so commit stamps and freshness work immediately rather than
   * only after the (async, possibly-never-resolving on error) headless
   * indexer's own GitOps happens to be wired back.
   */
  createGit?: (root: string) => GitOps;
  /** Overridable for tests; defaults to the real headless indexer. */
  startIndexer?: (
    codeStore: CodeStore,
    root: string,
    bundleDir: string,
    options?: HeadlessIndexerOptions
  ) => Promise<{ dispose(): void; git?: GitOps; freshness?: () => Promise<IndexFreshness | null> }>;
  /** Passed through to startIndexer (embeddings default on, gated by env). */
  indexerOptions?: HeadlessIndexerOptions;
  /** Extension/daemon version — stamped on generations to force rebuild on upgrade (§F1). */
  toolVersion?: string;
  /** Overridable for tests; defaults to `~/.pairs/workspaces.json`. */
  knownRootsPath?: string;
}

const MAX_KNOWN_ROOTS = 50;

export class WorkspaceRegistryImpl implements WorkspaceRegistry {
  private readonly handles = new Map<string, WorkspaceHandleImpl>();
  private readonly sessionCounts = new Map<string, number>();
  private readonly pending = new Map<string, Promise<WorkspaceHandleImpl>>();
  private readonly openMemoryStore: (dbPath: string) => Promise<MemoryStore>;
  private readonly openCodeStore: (dbPath: string) => Promise<CodeStore>;
  private readonly openCodeStoreWithProvenance:
    | ((dbPath: string) => Promise<{ store: CodeStore; provenance: IndexProvenanceService }>)
    | undefined;
  private readonly startIndexer: (
    codeStore: CodeStore,
    root: string,
    bundleDir: string,
    options?: HeadlessIndexerOptions
  ) => Promise<{ dispose(): void; git?: GitOps; freshness?: () => Promise<IndexFreshness | null> }>;
  private readonly knownRootsPath: string;
  private readonly createGit: (root: string) => GitOps;

  constructor(private readonly deps: WorkspaceRegistryDeps) {
    this.openMemoryStore = deps.openMemoryStore ?? ((dbPath) => new SqliteMemoryStoreFactory().open(dbPath));
    this.openCodeStore = deps.openCodeStore ?? ((dbPath) => new SqliteCodeStoreFactory().open(dbPath));
    // Only default to the real provenance-aware open() when the caller hasn't
    // supplied its own openCodeStore override (tests that fake openCodeStore
    // expect no provenance — freshness footers simply degrade to absent).
    this.openCodeStoreWithProvenance =
      deps.openCodeStoreWithProvenance ??
      (deps.openCodeStore ? undefined : (dbPath) => new SqliteCodeStoreFactory().openWithProvenance(dbPath));
    this.startIndexer = deps.startIndexer ?? startHeadlessIndexer;
    this.createGit =
      deps.createGit ?? ((root) => createGitOps(root, path.join(root, '.pairs', 'code-index-git-state.json')));
    this.knownRootsPath = deps.knownRootsPath ?? path.join(os.homedir(), '.pairs', 'workspaces.json');
  }

  async acquire(root: string): Promise<WorkspaceHandle> {
    const resolved = path.resolve(root);
    const existing = this.handles.get(resolved);
    if (existing) {
      existing.touch();
      return existing;
    }
    const inflight = this.pending.get(resolved);
    if (inflight) return inflight;

    const openPromise = this.open(resolved);
    this.pending.set(resolved, openPromise);
    try {
      const handle = await openPromise;
      this.handles.set(resolved, handle);
      return handle;
    } finally {
      this.pending.delete(resolved);
    }
  }

  private async open(root: string): Promise<WorkspaceHandleImpl> {
    const pairsDir = path.join(root, '.pairs');
    if (!fs.existsSync(pairsDir)) {
      throw new Error(`No .pairs/ directory at ${root} — open it in VS Code with PAiRS first, or run indexing there.`);
    }
    const dbPath = path.join(pairsDir, 'memory.db');
    const codeDbPath = path.join(pairsDir, 'code.db');

    const memoryStore = await this.openMemoryStore(dbPath);
    // Version guard: if the daemon (same version as the extension) was
    // upgraded, clear memory db so the new version starts fresh.
    if (this.deps.toolVersion) {
      await memoryStore.checkVersion(this.deps.toolVersion);
    }

    let codeStore: CodeStore | undefined;
    let provenance: IndexProvenanceService | undefined;
    if (fs.existsSync(codeDbPath)) {
      if (this.openCodeStoreWithProvenance) {
        const opened = await this.openCodeStoreWithProvenance(codeDbPath);
        codeStore = opened.store;
        provenance = opened.provenance;
      } else {
        codeStore = await this.openCodeStore(codeDbPath);
      }
    }

    // Constructed eagerly (not sourced from startIndexer's async result below)
    // so commit stamps (§F2) and freshness work from the first tool call,
    // not only after — or if — the headless indexer resolves.
    const git = this.createGit(root);
    const handle = new WorkspaceHandleImpl(root, memoryStore, codeStore, git, provenance);
    this.recordKnownRoot(root);

    if (codeStore) {
      handle.indexing = true;
      const options: HeadlessIndexerOptions = { ...this.deps.indexerOptions, provenance, toolVersion: this.deps.toolVersion };
      void this.startIndexer(codeStore, root, this.deps.bundleDir, options)
        .then((indexerHandle) => {
          handle.indexerHandle = indexerHandle;
          if (indexerHandle.freshness) handle.liveFreshness = indexerHandle.freshness;
        })
        .catch((err) => {
          console.error(`[PAIRS daemon] headless index failed for ${root}: ${(err as Error).stack ?? (err as Error).message}`);
        })
        .finally(() => {
          handle.indexing = false;
        });
    }

    return handle;
  }

  /** Session bookkeeping so idle eviction never closes a root with live sessions. */
  retain(root: string): void {
    const resolved = path.resolve(root);
    this.sessionCounts.set(resolved, (this.sessionCounts.get(resolved) ?? 0) + 1);
  }

  release(root: string): void {
    const resolved = path.resolve(root);
    const n = (this.sessionCounts.get(resolved) ?? 1) - 1;
    if (n <= 0) this.sessionCounts.delete(resolved);
    else this.sessionCounts.set(resolved, n);
  }

  async list(): Promise<WorkspaceInfo[]> {
    const out: WorkspaceInfo[] = [];
    for (const [root, handle] of this.handles) {
      const stats = await handle.stats();
      out.push({
        root,
        openedAt: handle.openedAt,
        indexing: handle.indexing,
        sessions: this.sessionCounts.get(root) ?? 0,
        ...stats,
      });
    }
    return out;
  }

  async evictIdle(maxIdleMs: number): Promise<number> {
    const now = Date.now();
    let closed = 0;
    for (const [root, handle] of this.handles) {
      const sessions = this.sessionCounts.get(root) ?? 0;
      if (sessions > 0 || handle.indexing) continue;
      if (now - handle.lastUsedAt < maxIdleMs) continue;
      await handle.close();
      this.handles.delete(root);
      closed++;
    }
    return closed;
  }

  async closeAll(): Promise<void> {
    for (const handle of this.handles.values()) await handle.close();
    this.handles.clear();
    this.sessionCounts.clear();
  }

  private readRawKnownRoots(): string[] {
    try {
      const text = fs.readFileSync(this.knownRootsPath, 'utf8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Most-recent-first, deduped, capped, persisted to knownRootsPath. */
  private recordKnownRoot(root: string): void {
    const existing = this.readRawKnownRoots();
    const next = [root, ...existing.filter((r) => r !== root)].slice(0, MAX_KNOWN_ROOTS);
    try {
      fs.mkdirSync(path.dirname(this.knownRootsPath), { recursive: true });
      fs.writeFileSync(this.knownRootsPath, JSON.stringify(next), 'utf8');
    } catch (err) {
      console.error(`[PAIRS daemon] failed to persist known workspace roots: ${(err as Error).message}`);
    }
  }

  async knownRoots(): Promise<string[]> {
    const roots = this.readRawKnownRoots();
    const live = roots.filter((root) => fs.existsSync(path.join(root, '.pairs')));
    if (live.length !== roots.length) {
      try {
        fs.writeFileSync(this.knownRootsPath, JSON.stringify(live), 'utf8');
      } catch {
        // Best-effort cleanup; a stale entry just gets re-filtered next read.
      }
    }
    return live;
  }
}
