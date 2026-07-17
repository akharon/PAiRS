/**
 * Indexer interface — matches subsystem_indexer_spec.md §2 exactly. Built
 * fresh against that spec rather than ported from the reference project's
 * richer CodeIndexer (which also owns VS Code watcher wiring, embedding
 * backfill, and git-diff-based incremental scans — all Phase 1+ concerns).
 * The orchestration *shape* (diff listFiles() against disk, extract, apply,
 * resolve) is adapted from codeIndexerImpl.ts; see codeIndexerImpl.ts here.
 */

import type { CodeStore } from '../../store/graph/codeStore';
import type { Extractor } from './extractors';
import type { ParserRegistry } from './parserRegistry';
import type { IndexStats } from './types';

export interface SpanError {
  path: string;
  message: string;
}

export interface FileIndexResult {
  declared: number[]; // symbol ids now DECLAREd by this file
  edges: { resolved: number; unresolved: number };
  parseErrors: SpanError[];
  elapsedMs: number;
}

export interface IndexReport {
  files: number;
  functions: number;
  types: number;
  /** See IndexStats.unresolvedRatio — dominated by external calls, not a precision metric. */
  unresolvedRatio: number;
  /** fuzzy / (fuzzy + resolved) over reference edges — the precision metric (R1). */
  fuzzyRate: number;
  /** Unresolved refs naming nothing in the workspace: stdlib/dependency calls, excluded from precision. */
  externalRefs: number;
  /** Unresolved refs that name a workspace symbol — genuine misses. Expected 0. */
  resolvableMisses: number;
  errors: SpanError[];
  elapsedMs: number;
}

export interface Indexer {
  fullIndex(root: string): Promise<IndexReport>;
  indexFile(path: string): Promise<FileIndexResult>;
  onFileChanged(path: string): void;
  stats(): Promise<IndexStats>;
}

export interface IndexerDeps {
  store: CodeStore;
  parsers: ParserRegistry;
  extractor: Extractor;
  listWorkspaceFiles(): Promise<string[]>;
  readFile(path: string): Promise<{ source: string; mtimeMs: number; size: number }>;
  /** Crate name for a workspace-relative path (O6 monorepo scoping). Null for single-crate projects. */
  crateForPath?(path: string): string | null;
}
