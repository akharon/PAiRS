/**
 * CodeIndexer — orchestrates scanning, watching, extraction, and pass-2
 * resolution. Owns the low-end-hardware guarantees:
 *
 *  - Activation scan runs in the background, yielding between files
 *    (await setImmediate every file; batch DB writes per file, not per row)
 *    so the extension host never blocks.
 *  - Startup is incremental: diff CodeStore.listFiles() hash/mtime against
 *    disk; only changed/new files re-parse. Deleted files → removeFile.
 *  - Watcher events debounce (default 2000ms per path) — never re-index on
 *    keystroke, only on save/settle.
 *  - After each applyExtraction, call resolvePending(namesHint) with just the
 *    names the file declared, so new definitions link up pre-existing callers
 *    without a full pass. One full resolvePending() at end of activation scan.
 *  - File filters: respect .gitignore + `pairs.codeIndex.exclude` globs,
 *    skip files > maxFileSizeKb, skip when langForPath() is null.
 *  - Embedding backfill (optional flag) runs strictly after the FTS queue is
 *    idle, via the shared EmbeddingProvider, lowest priority.
 *
 * Wiring (extension.ts): construct with the workspace root, a CodeStore, a
 * ParserRegistry, an Extractor, and VS Code-shaped deps injected as plain
 * functions/interfaces so this module stays testable without vscode.
 */

import type { CodeStore } from './codeStore';
import type { Extractor } from './extractors';
import type { ParserRegistry } from './parserRegistry';
import type { IndexStats } from './types';
import type { IndexFreshness, IndexProvenanceService } from './provenance';

export type IndexerPhase =
  | 'idle' // up to date
  | 'scanning' // activation diff/scan in progress
  | 'indexing' // files in the work queue
  | 'embedding' // FTS done, embedding backfill running
  | 'error';

export interface IndexerStatus {
  phase: IndexerPhase;
  /** Files remaining in the queue (drives the status-bar spinner). */
  queued: number;
  stats: IndexStats;
  lastError?: string;
}

export interface CodeIndexerOptions {
  /** Absolute workspace root the index is relative to. */
  workspaceRoot: string;
  /** Extra exclude globs from `pairs.codeIndex.exclude` (gitignore always applies). */
  exclude: string[];
  /** Skip files larger than this. Default 1024 (1 MB). */
  maxFileSizeKb?: number;
  /** Watcher debounce per path. Default 2000. */
  debounceMs?: number;
  /** Mirror of the memory embeddings opt-in flag. */
  embeddingsEnabled: boolean;
  /**
   * Extension version + grammar-set hash (docs/MemoryIndexSynergy.md §F1).
   * Required only when `deps.provenance` is supplied — a generation is
   * stamped with it so a mismatch on next open forces a full rebuild.
   */
  toolVersion?: string;
}

export interface CodeIndexer {
  /**
   * Start: init parser registry, run the incremental activation scan in the
   * background, then attach the watcher. Resolves once the scan is QUEUED
   * (not finished) — callers observe completion via onStatus.
   */
  start(): Promise<void>;
  /** Queue one file (watcher change/create). Debounced internally. */
  enqueue(path: string): void;
  /** Watcher delete. */
  remove(path: string): Promise<void>;
  /** Full rebuild: CodeStore.reset() then fresh activation scan. User command. */
  rebuild(): Promise<void>;
  /**
   * Call when the workspace's git HEAD may have moved (e.g. a `.git/logs/HEAD`
   * watcher fired, meaning a commit/checkout/merge happened). Diffs the new
   * HEAD against the last-indexed commit and enqueues only the changed source
   * files instead of rescanning the whole workspace. No-op if `deps.git` was
   * not supplied, if HEAD didn't actually change, or if this is the very
   * first call (records the current HEAD as the baseline — the activation
   * scan already covered every file by then).
   */
  onGitHeadChanged(): Promise<void>;
  status(): IndexerStatus;
  /** Subscribe to phase/progress changes (status bar + tests). Returns unsubscribe. */
  onStatus(listener: (s: IndexerStatus) => void): () => void;
  /**
   * Live freshness snapshot (docs/MemoryIndexSynergy.md §F1): last completed
   * generation vs. the repo right now, with this indexer's current queue
   * depth folded in. Returns null when `deps.provenance` was not supplied.
   */
  freshness(): Promise<IndexFreshness | null>;
  dispose(): void;
}

export interface CodeIndexerDeps {
  store: CodeStore;
  parsers: ParserRegistry;
  extractor: Extractor;
  /**
   * Workspace file enumeration, injected so the impl doesn't import vscode:
   * extension.ts passes vscode.workspace.findFiles-backed impl honoring
   * gitignore + excludes; tests pass an in-memory one.
   */
  listWorkspaceFiles(): Promise<string[]>;
  readFile(path: string): Promise<{ source: string; mtimeMs: number; size: number }>;
  /** Optional — present only when embeddingsEnabled (shared MiniLM provider). */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  /**
   * Optional — present only when the workspace is a git repo. Enables
   * onGitHeadChanged() to diff by commit instead of rescanning every file.
   * extension.ts wires this over `git` CLI + a sidecar JSON file for the
   * last-indexed sha; tests can inject an in-memory fake.
   */
  git?: GitOps;
  /**
   * Optional — present when the CodeStore was opened via
   * SqliteCodeStoreFactory.openWithProvenance(). Brackets every scan
   * (runActivationScan / onGitHeadChanged's indexing branch) with a
   * generation stamp (docs/MemoryIndexSynergy.md §F1). Omitted entirely,
   * indexing behaves exactly as before — this is additive.
   */
  provenance?: IndexProvenanceService;
}

export interface GitOps {
  /** Current HEAD commit sha, or null if not a git repo / no commits yet. */
  headSha(): Promise<string | null>;
  /** Current branch name, or null if detached HEAD / not a git repo. */
  branchName(): Promise<string | null>;
  /** Files added/modified/deleted between two commits, workspace-relative paths. Renames count as added (new path). */
  diffNames(fromSha: string, toSha: string): Promise<{ added: string[]; modified: string[]; deleted: string[] }>;
  /** Workspace-relative paths with uncommitted changes right now (`git status --porcelain`). Empty array if clean or not a git repo. */
  dirtyPaths(): Promise<string[]>;
  /** Number of commits reachable from `toSha` but not `fromSha` (`git rev-list --count fromSha..toSha`). null if either sha is unknown/pruned. */
  commitsBetween(fromSha: string, toSha: string): Promise<number | null>;
  /** Last commit sha this indexer has processed (persisted outside the DB — cache, not source of truth). */
  getLastIndexedSha(): Promise<string | null>;
  setLastIndexedSha(sha: string): Promise<void>;
}

/**
 * Symbol card — the text embedded for a symbol (and conceptually what FTS
 * indexes). Doc-ish on purpose: MiniLM handles natural language, not raw
 * code bodies. Kept here so store, indexer, and search agree on one format.
 */
export function symbolCard(s: {
  name: string;
  kind: string;
  qualified: string;
  signature: string | null;
  doc: string | null;
  file: string;
}): string {
  return [s.kind, s.qualified, s.signature ?? '', s.doc ?? '', `in ${s.file}`]
    .filter(Boolean)
    .join(' — ');
}
