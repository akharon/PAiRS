/**
 * Indexer implementation: diff → parse → applyExtraction → resolvePending,
 * matching subsystem_indexer_spec.md §3. Adapted from the reference project's
 * codeIndexerImpl.ts — the diff/drain/incremental-resolve shape is carried
 * over; watcher debouncing, embedding backfill, git-diff scans, and
 * provenance generations are dropped (Phase 1+/out of scope, see
 * codeIndexer.ts here).
 *
 * Full index runs Pass 1 for all files before any Pass 2 resolution
 * (subsystem_indexer_spec.md §3: "forward references"); incremental
 * indexFile() resolves only the names the changed file just declared.
 */

import { langForPath } from './parserRegistry';
import type { FileIndexResult, Indexer, IndexerDeps, IndexReport, SpanError } from './codeIndexer';
import type { CodeLang, FileExtraction, SymbolKind } from './types';

const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024;

export class IndexerImpl implements Indexer {
  private readonly deps: IndexerDeps;
  /** path → {mtimeMs, size, hash}, populated from store.listFiles() on first use. */
  private fileCache: Map<string, { mtimeMs: number; size: number; hash: string }> | null = null;
  /**
   * Serializes index operations within this process. The store is single-writer
   * by design (ADR-009), but that invariant is *per store*, and the VS Code
   * extension can trigger a `gizem.reindex` while the activation-time fullIndex
   * is still running — two interleaved fullIndex runs would corrupt the store's
   * in-memory symbol mirror and duplicate edges. Chain every index op behind
   * the previous one instead.
   */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(deps: IndexerDeps) {
    this.deps = deps;
  }

  /** Run `fn` after every previously enqueued index op has settled. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => undefined); // errors surface to the caller, not the chain
    return next;
  }

  async fullIndex(root: string): Promise<IndexReport> {
    return this.serialize(() => this.fullIndexInner(root));
  }

  private async fullIndexInner(root: string): Promise<IndexReport> {
    const start = Date.now();
    await this.deps.parsers.init();

    const diskPaths = await this.deps.listWorkspaceFiles();
    const known = await this.deps.store.listFiles();
    this.fileCache = new Map(known.map((f) => [f.path, { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash }]));
    const diskSet = new Set(diskPaths);

    for (const f of known) {
      if (!diskSet.has(f.path)) {
        await this.deps.store.removeFile(f.path);
        this.fileCache.delete(f.path);
      }
    }

    const errors: SpanError[] = [];
    for (const path of diskPaths) {
      const result = await this.indexOneFile(path, { skipResolve: true });
      errors.push(...result.parseErrors);
    }

    // Full pass over every pending ref only after all files have declared —
    // forward references resolve here, not per-file.
    await this.deps.store.resolvePending();

    const stats = await this.deps.store.stats();
    const kindCount = (...kinds: SymbolKind[]): number =>
      kinds.reduce((sum, k) => sum + (stats.byKind[k] ?? 0), 0);

    return {
      files: stats.files,
      functions: kindCount('function', 'method'),
      types: kindCount('struct', 'enum', 'trait', 'class', 'interface'),
      unresolvedRatio: stats.unresolvedRatio,
      fuzzyRate: stats.fuzzyRate,
      externalRefs: stats.externalRefs,
      resolvableMisses: stats.resolvableMisses,
      errors,
      elapsedMs: Date.now() - start,
    };
  }

  async indexFile(path: string): Promise<FileIndexResult> {
    return this.serialize(() => this.indexOneFile(path, { skipResolve: false }));
  }

  async removeFile(path: string): Promise<void> {
    return this.serialize(async () => {
      await this.deps.store.removeFile(path);
      this.fileCache?.delete(path);
    });
  }

  onFileChanged(path: string): void {
    // v1 CLI has no watcher; VS Code extension (Phase 1) debounces and calls
    // indexFile() directly. This hook exists to satisfy the Indexer contract.
    void this.indexFile(path);
  }

  async stats(): Promise<import('./types').IndexStats> {
    return this.deps.store.stats();
  }

  private async indexOneFile(path: string, opts: { skipResolve: boolean }): Promise<FileIndexResult> {
    const start = Date.now();
    const lang = langForPath(path);
    if (!lang) {
      return { declared: [], edges: { resolved: 0, unresolved: 0 }, parseErrors: [], elapsedMs: 0 };
    }

    let file: { source: string; mtimeMs: number; size: number };
    try {
      file = await this.deps.readFile(path);
    } catch (err) {
      return {
        declared: [],
        edges: { resolved: 0, unresolved: 0 },
        parseErrors: [{ path, message: (err as Error).message }],
        elapsedMs: Date.now() - start,
      };
    }
    if (file.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
      return { declared: [], edges: { resolved: 0, unresolved: 0 }, parseErrors: [], elapsedMs: Date.now() - start };
    }

    if (!this.fileCache) {
      const known = await this.deps.store.listFiles();
      this.fileCache = new Map(known.map((f) => [f.path, { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash }]));
    }
    const prior = this.fileCache.get(path);
    if (prior && prior.mtimeMs === file.mtimeMs && prior.size === file.size) {
      return { declared: [], edges: { resolved: 0, unresolved: 0 }, parseErrors: [], elapsedMs: Date.now() - start };
    }

    const loaded = await this.deps.parsers.load(lang as CodeLang);
    const crate = this.deps.crateForPath?.(path) ?? null;
    const extraction: FileExtraction = this.deps.extractor.extract(loaded, path, file.source, file, crate);

    if (prior && prior.hash === extraction.hash) {
      return { declared: [], edges: { resolved: 0, unresolved: 0 }, parseErrors: [], elapsedMs: Date.now() - start };
    }

    const fileRecord = await this.deps.store.applyExtraction(extraction);
    this.fileCache.set(path, { mtimeMs: file.mtimeMs, size: file.size, hash: extraction.hash });

    let resolvedCount = 0;
    if (!opts.skipResolve) {
      const names = extraction.symbols.map((s) => s.name);
      if (names.length) resolvedCount = await this.deps.store.resolvePending(names);
    }

    const parseErrors: SpanError[] = extraction.parseError ? [{ path, message: 'syntax error (partial tree indexed)' }] : [];

    return {
      declared: fileRecord ? [fileRecord.id] : [],
      edges: { resolved: resolvedCount, unresolved: extraction.refs.length - resolvedCount },
      parseErrors,
      elapsedMs: Date.now() - start,
    };
  }
}
