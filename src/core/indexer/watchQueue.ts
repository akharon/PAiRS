/**
 * Debounced incremental-index queue (plan.md 3.1). Pure core (R10): no fs, no
 * vscode — an adapter feeds it raw change/delete events (from fs.watch or
 * VS Code's FileSystemWatcher) and it coalesces bursts (editor saves fire
 * 2–4 events per file) into one indexFile/removeFile per settled file.
 *
 * Ordering: events for the SAME path collapse to the latest kind (a change
 * followed by a delete is just a delete). Distinct paths flush together after
 * `debounceMs` of quiet. Flushes chain behind each other — combined with the
 * indexer's own opChain this keeps the single-writer invariant (ADR-009).
 */

export interface WatchSink {
  indexFile(path: string): Promise<unknown>;
  removeFile(path: string): Promise<unknown>;
  /** Called once per flush after all files settled (drive rule re-check / UI refresh). */
  onFlushed?(changed: string[], removed: string[]): void | Promise<void>;
  onError?(path: string, err: Error): void;
}

export class WatchQueue {
  private pending = new Map<string, 'change' | 'delete'>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly sink: WatchSink,
    private readonly debounceMs = 150
  ) {}

  /** File created or modified. */
  changed(path: string): void {
    if (this.disposed) return;
    this.pending.set(path, 'change');
    this.arm();
  }

  /** File deleted (or renamed away). */
  deleted(path: string): void {
    if (this.disposed) return;
    this.pending.set(path, 'delete');
    this.arm();
  }

  /** Resolves when every event enqueued so far has been fully processed. */
  async settle(): Promise<void> {
    while (this.pending.size > 0 || this.timer !== null) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
        this.enqueueFlush();
      }
      await this.flushChain;
    }
    await this.flushChain;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueFlush();
    }, this.debounceMs);
  }

  private enqueueFlush(): void {
    const batch = new Map(this.pending);
    this.pending.clear();
    if (batch.size === 0) return;
    this.flushChain = this.flushChain.then(async () => {
      const changed: string[] = [];
      const removed: string[] = [];
      for (const [path, kind] of batch) {
        try {
          if (kind === 'delete') {
            await this.sink.removeFile(path);
            removed.push(path);
          } else {
            await this.sink.indexFile(path);
            changed.push(path);
          }
        } catch (err) {
          this.sink.onError?.(path, err as Error);
        }
      }
      if (changed.length || removed.length) await this.sink.onFlushed?.(changed, removed);
    });
  }
}
