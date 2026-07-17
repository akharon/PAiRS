/**
 * Index provenance — generation stamps recording WHAT code state the index
 * describes (commit + dirty-file overlay), stored inside code.db so the
 * extension host, stdio MCP server, and shared daemon all read one truth.
 *
 * Design: docs/MemoryIndexSynergy.md §F1/§F5. Interfaces only — the
 * implementation lives beside codeStoreImpl.ts and shares its DatabaseSync.
 */

import type { GitOps } from './codeIndexer';

/** One completed (or in-flight) index scan and the repo state it captured. */
export interface IndexGeneration {
  /** Monotonic id (AUTOINCREMENT); higher = newer. */
  id: number;
  /** HEAD sha at scan start; null in non-git workspaces. */
  commit: string | null;
  /** Branch name at scan start (best-effort; null when detached/non-git). */
  branch: string | null;
  /**
   * Workspace-relative paths that were uncommitted (modified/added) when the
   * scan ran — the overlay on top of `commit` that makes the stamp honest:
   * a working tree is never exactly a commit.
   */
  dirtyPaths: string[];
  startedAt: number;
  /** null while the scan is in flight — lets tools report "reindexing now". */
  completedAt: number | null;
  /**
   * Extension version + grammar-set hash. A mismatch with the running tool
   * forces a full rebuild so extraction-logic changes can't silently serve
   * stale symbol data across upgrades.
   */
  toolVersion: string;
}

/** Live comparison of the last completed generation against the repo now. */
export interface IndexFreshness {
  /** Last completed generation, or null when the index has never been built. */
  generation: IndexGeneration | null;
  /** HEAD sha right now (null: non-git). */
  headSha: string | null;
  /** Commits on HEAD since `generation.commit`; 0 = same commit; null = unknown. */
  commitsBehind: number | null;
  /** Files dirty right now that are NOT covered by the generation's overlay. */
  dirtyUnindexed: string[];
  /** True while a scan is in flight (a generation exists with completedAt null). */
  indexing: boolean;
  /** Files currently queued for incremental re-index (from the indexer, best-effort). */
  queued: number;
}

/**
 * Generic key-value metadata on code.db (backs provenance; also available for
 * future per-db flags). `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY
 * KEY, value TEXT)` — additive, no schema-version bump.
 */
export interface MetaStore {
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export interface IndexProvenanceService {
  /** Most recent generation regardless of completion state, or null if none. */
  current(): Promise<IndexGeneration | null>;
  /**
   * Record the start of a scan. Captures commit/branch/dirty overlay via the
   * provided git ops (all-null stamp when git is unavailable — never throws
   * for non-git workspaces). Returns the new generation id.
   */
  beginGeneration(input: {
    git?: GitOps;
    /** Uncommitted files the caller is about to index (from `git status`). */
    dirtyPaths?: string[];
    toolVersion: string;
  }): Promise<number>;
  /** Mark a generation finished. Idempotent. */
  completeGeneration(id: number): Promise<void>;
  /**
   * Compare the last completed generation against the live repo. `queued` is
   * supplied by the caller (the indexer knows its queue; this service knows
   * the db). Cheap enough to call per tool response.
   */
  freshness(input: { git?: GitOps; queued?: number }): Promise<IndexFreshness>;
  /**
   * True when `toolVersion` differs from the last generation's — the caller
   * (CodeIndexerImpl.start) must then reset + full-rescan.
   */
  needsFullRebuild(toolVersion: string): Promise<boolean>;
}
