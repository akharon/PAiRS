/**
 * Best-effort structured logger shared by every entrypoint (extension host,
 * stdio MCP server, headless indexer). Errors and warnings are appended to
 * `<workspace>/.pairs/error_log.txt` for postmortem analysis, and always
 * mirrored to the console so headless/pre-init failures aren't lost.
 *
 * Contract: logging must NEVER throw into a caller's error path, and the log
 * file is self-capped below 10 KB (oldest entries trimmed) so it never grows
 * unbounded inside a user's repo.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 10_000; // hard cap for .pairs/error_log.txt
const TRIM_TO = 7_000; // when over cap, keep roughly the last 7 KB

type Level = 'ERROR' | 'WARN' | 'INFO';

class PairsLogger {
  private filePath: string | undefined;
  private sink: ((line: string) => void) | undefined;

  /**
   * Point the logger at a workspace `.pairs/` directory. Safe to call more
   * than once (later entrypoints re-point at the same dir). Until called, log
   * entries go to the console only.
   */
  init(storageDir: string | undefined): void {
    this.filePath = storageDir ? path.join(storageDir, 'error_log.txt') : undefined;
  }

  /**
   * Optional extra sink for surfacing entries in-editor (e.g. a VS Code
   * OutputChannel). Kept as a plain callback so `core/` stays free of any
   * `vscode` dependency and usable from the headless servers. The sink is
   * deliberately passive — it must never show modals/toasts or block the UI.
   */
  setSink(sink: (line: string) => void): void {
    this.sink = sink;
  }

  error(context: string, err: unknown): void {
    this.write('ERROR', context, err);
  }

  warn(context: string, err: unknown): void {
    this.write('WARN', context, err);
  }

  info(context: string, message: string): void {
    this.write('INFO', context, message);
  }

  private write(level: Level, context: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Console is always available and is the only sink before init() / in
    // headless processes whose stderr the client surfaces.
    if (level === 'ERROR') console.error(`[Memory] ${context}:`, err);
    else if (level === 'WARN') console.warn(`[Memory] ${context}:`, err);

    const line = `[${new Date().toISOString()}] ${level} ${context}: ${detail.replace(/\n/g, ' ⏎ ')}`;
    if (this.sink) {
      try {
        this.sink(line);
      } catch {
        // A misbehaving sink must not break logging or the caller.
      }
    }

    if (!this.filePath) return;
    try {
      fs.appendFileSync(this.filePath, `${line}\n`);
      this.trimIfNeeded();
    } catch {
      // Never let a logging failure escape into the caller.
    }
  }

  private trimIfNeeded(): void {
    if (!this.filePath) return;
    try {
      if (fs.statSync(this.filePath).size <= MAX_BYTES) return;
      const buf = fs.readFileSync(this.filePath);
      const tail = buf.subarray(buf.length - TRIM_TO);
      // Drop the leading partial line so the file starts on a clean entry.
      const nl = tail.indexOf(0x0a);
      fs.writeFileSync(this.filePath, nl >= 0 ? tail.subarray(nl + 1) : tail);
    } catch {
      // best-effort
    }
  }
}

/** Process-wide singleton; call `logger.init(<.pairs dir>)` at each entrypoint. */
export const logger = new PairsLogger();
