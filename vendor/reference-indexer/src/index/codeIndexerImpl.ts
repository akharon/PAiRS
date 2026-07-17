/**
 * CodeIndexer implementation. No vscode import — deps.listWorkspaceFiles /
 * readFile are injected so extension.ts supplies the gitignore-aware,
 * FileSystemWatcher-backed versions and tests supply in-memory ones.
 */

import { langForPath } from './parserRegistry';
import { symbolCard, type CodeIndexer, type CodeIndexerDeps, type CodeIndexerOptions, type IndexerStatus } from './codeIndexer';
import type { CodeLang, FileExtraction } from './types';
import type { IndexFreshness } from './provenance';
import { logger } from '../core/logger';

const DEFAULT_MAX_FILE_SIZE_KB = 1024;
const DEFAULT_DEBOUNCE_MS = 2000;

export class CodeIndexerImpl implements CodeIndexer {
  private readonly deps: CodeIndexerDeps;
  private readonly options: CodeIndexerOptions;
  private readonly listeners = new Set<(s: IndexerStatus) => void>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly queue = new Set<string>();
  private phase: IndexerStatus['phase'] = 'idle';
  private lastError: string | undefined;
  private processing = false;
  /** Set once embedding backfill has failed — skips further attempts so a
   *  permanently broken embedding backend (e.g. a native binding that can't
   *  load) doesn't retry and re-report an error on every scan. Symbol
   *  indexing (FTS, dead code, deps, etc.) is unaffected either way. */
  private embeddingsDisabledAfterError = false;
  /** Skip-check cache so a queue drain doesn't call store.listFiles() per file (O(files²)). */
  private fileCache: Map<string, { mtimeMs: number; size: number; hash: string }> | null = null;

  constructor(deps: CodeIndexerDeps, options: CodeIndexerOptions) {
    this.deps = deps;
    this.options = options;
  }

  async start(): Promise<void> {
    await this.deps.parsers.init();
    // Fire-and-forget: callers observe completion via onStatus, per the
    // CodeIndexer contract (start() resolves once the scan is queued).
    void this.runActivationScan();
  }

  private async runActivationScan(): Promise<void> {
    this.setPhase('scanning');
    const generationId = await this.beginGeneration();
    try {
      const diskPaths = await this.deps.listWorkspaceFiles();
      const known = new Map((await this.deps.store.listFiles()).map((f) => [f.path, f]));
      this.fileCache = new Map(
        [...known.values()].map((f) => [f.path, { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash }])
      );
      const diskSet = new Set(diskPaths);

      for (const path of known.keys()) {
        if (!diskSet.has(path)) {
          await this.deps.store.removeFile(path);
          this.fileCache.delete(path);
        }
      }

      for (const path of diskPaths) {
        const lang = langForPath(path);
        if (!lang) continue;
        if (this.isExcluded(path)) continue;
        this.queue.add(path);
      }

      await this.drainQueue();
      await this.deps.store.resolvePending();

      await this.tryBackfillEmbeddings();
      this.setPhase('idle');
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setPhase('error');
    } finally {
      await this.completeGeneration(generationId);
    }
  }

  /**
   * Starts a generation stamp when `deps.provenance` is wired; no-op (null)
   * otherwise. Never throws — a provenance DB hiccup (locked file, disk
   * full) must degrade to "no stamp for this scan", not block indexing
   * itself (same must-not-block contract as tryBackfillEmbeddings).
   */
  private async beginGeneration(): Promise<number | null> {
    if (!this.deps.provenance) return null;
    try {
      const dirtyPaths = (await this.deps.git?.dirtyPaths().catch(() => [])) ?? [];
      return await this.deps.provenance.beginGeneration({
        git: this.deps.git,
        dirtyPaths,
        toolVersion: this.options.toolVersion ?? 'unknown',
      });
    } catch (err) {
      logger.warn('beginGeneration failed (continuing without a stamp)', err);
      return null;
    }
  }

  private async completeGeneration(id: number | null): Promise<void> {
    if (id === null) return;
    try {
      await this.deps.provenance?.completeGeneration(id);
    } catch (err) {
      logger.warn('completeGeneration failed', err);
    }
  }

  /**
   * Embedding backfill failures (e.g. a native binding that can't load in
   * this environment) must not fail symbol indexing, which already
   * succeeded by the time this runs. Reported via lastError/status() but
   * never sets phase to 'error' — semantic search degrades, everything else
   * (find_dead_code, file_deps, code_hotspots, find_duplicates) still works.
   */
  private async tryBackfillEmbeddings(): Promise<void> {
    if (!this.options.embeddingsEnabled || !this.deps.embed || this.embeddingsDisabledAfterError) return;
    try {
      await this.backfillEmbeddings();
    } catch (err) {
      this.embeddingsDisabledAfterError = true;
      this.lastError = `Embeddings unavailable: ${(err as Error).message}`;
    }
  }

  private isExcluded(path: string): boolean {
    return this.options.exclude.some((glob) => simpleGlobMatch(glob, path));
  }

  enqueue(path: string): void {
    const lang = langForPath(path);
    if (!lang || this.isExcluded(path)) return;

    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);
    const debounceMs = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      this.queue.add(path);
      void this.drainQueue();
    }, debounceMs);
    timer.unref?.();
    this.debounceTimers.set(path, timer);
  }

  async remove(path: string): Promise<void> {
    // Cancel any pending (re)index of this path first, so a debounce timer or
    // queued entry can't resurrect the file's symbols right after we delete them.
    const timer = this.debounceTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
    this.queue.delete(path);
    await this.deps.store.removeFile(path);
    this.fileCache?.delete(path);
    this.emitStatus();
  }

  async rebuild(): Promise<void> {
    await this.deps.store.reset();
    this.fileCache = null;
    await this.runActivationScan();
  }

  async onGitHeadChanged(): Promise<void> {
    const git = this.deps.git;
    if (!git) return;

    const newSha = await git.headSha();
    if (!newSha) return;

    const lastSha = await git.getLastIndexedSha();
    if (!lastSha) {
      // First observation: the activation scan already covered every file,
      // so just record the baseline instead of diffing against nothing.
      await git.setLastIndexedSha(newSha);
      return;
    }
    if (lastSha === newSha) return;

    const generationId = await this.beginGeneration();
    try {
      const { added, modified, deleted } = await git.diffNames(lastSha, newSha);

      for (const filePath of deleted) {
        if (langForPath(filePath)) {
          await this.deps.store.removeFile(filePath);
          this.fileCache?.delete(filePath);
        }
      }

      for (const filePath of [...added, ...modified]) {
        const lang = langForPath(filePath);
        if (!lang || this.isExcluded(filePath)) continue;
        this.queue.add(filePath);
      }

      await this.drainQueue();
      await this.deps.store.resolvePending();
      await this.tryBackfillEmbeddings();

      await git.setLastIndexedSha(newSha);
    } finally {
      await this.completeGeneration(generationId);
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    if (this.phase !== 'scanning') this.setPhase('indexing');
    try {
      while (this.queue.size > 0) {
        const path = this.queue.values().next().value as string;
        this.queue.delete(path);
        await this.indexOneFile(path);
        this.emitStatus();
        // Yield to the event loop between files so a large activation scan
        // never blocks the extension host on low-end hardware.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      this.processing = false;
      if (this.phase === 'indexing') this.setPhase('idle');
    }
  }

  private async indexOneFile(path: string): Promise<void> {
    const lang = langForPath(path);
    if (!lang) return;

    let file: { source: string; mtimeMs: number; size: number };
    try {
      file = await this.deps.readFile(path);
    } catch {
      // File vanished between enqueue and read (race with a delete); the
      // watcher's own delete event (or the next activation diff) handles it.
      return;
    }
    if (file.size > (this.options.maxFileSizeKb ?? DEFAULT_MAX_FILE_SIZE_KB) * 1024) return;

    if (!this.fileCache) {
      this.fileCache = new Map(
        (await this.deps.store.listFiles()).map((f) => [f.path, { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash }])
      );
    }
    const prior = this.fileCache.get(path);
    if (prior && prior.mtimeMs === file.mtimeMs && prior.size === file.size) return;

    const loaded = await this.deps.parsers.load(lang as CodeLang);
    const extraction: FileExtraction = this.deps.extractor.extract(loaded, path, file.source, file);

    if (prior && prior.hash === extraction.hash) return; // content unchanged despite mtime bump

    await this.deps.store.applyExtraction(extraction);
    this.fileCache.set(path, { mtimeMs: file.mtimeMs, size: file.size, hash: extraction.hash });
    // Cheap incremental resolution: only retry pending refs whose name this
    // file just declared, instead of a full pass over every pending_refs row.
    const names = extraction.symbols.map((s) => s.name);
    if (names.length) await this.deps.store.resolvePending(names);
  }

  private async backfillEmbeddings(): Promise<void> {
    if (!this.deps.embed) return;
    this.setPhase('embedding');
    const BATCH = 16;
    for (;;) {
      const pending = await this.deps.store.pendingEmbeddings(BATCH);
      if (pending.length === 0) break;
      const cards = pending.map((s) => symbolCard(s));
      const vectors = await this.deps.embed(cards);
      for (let i = 0; i < pending.length; i++) {
        await this.deps.store.setEmbedding(pending[i]!.id, vectors[i]!);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  status(): IndexerStatus {
    return {
      phase: this.phase,
      queued: this.queue.size,
      stats: this.cachedStats,
      lastError: this.lastError,
    };
  }

  private cachedStats: IndexerStatus['stats'] = {
    files: 0,
    symbols: 0,
    edges: 0,
    pendingRefs: 0,
    pendingEmbeddings: 0,
    lastIndexedAt: null,
  };

  private setPhase(phase: IndexerStatus['phase']): void {
    this.phase = phase;
    this.emitStatus();
  }

  private emitStatus(): void {
    // stats() can reject (SQLITE_BUSY under concurrent writes); a bare `void`
    // would surface as an unhandledRejection. Swallow to a log and skip the
    // status tick rather than crash the indexer.
    void this.deps.store
      .stats()
      .then((stats) => {
        this.cachedStats = stats;
        const status = this.status();
        for (const l of this.listeners) l(status);
      })
      .catch((err) => logger.warn('emitStatus stats() failed', err));
  }

  onStatus(listener: (s: IndexerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async freshness(): Promise<IndexFreshness | null> {
    if (!this.deps.provenance) return null;
    return this.deps.provenance.freshness({ git: this.deps.git, queued: this.queue.size });
  }

  dispose(): void {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.listeners.clear();
    this.deps.parsers.dispose();
  }
}

/** Minimal glob matcher for `pairs.codeIndex.exclude` (`**`, `*`, literal segments). */
function simpleGlobMatch(glob: string, path: string): boolean {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      // ** — zero or more path components (including none). When followed
      // by /, consume the slash as part of the construct so that a leading
      // **/ matches both "dist/file.ts" and "src/dist/file.ts".
      if (glob[i + 2] === '/') {
        re += '(.*\\/)?';
        i += 2; // skip **/
      } else if (i + 2 >= glob.length) {
        // trailing ** — optional path suffix
        re += '.*';
        i += 1; // skip second *
      } else {
        re += '.*';
        i += 1; // skip second *
      }
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '/') {
      re += '\\/';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re).test(path);
}
