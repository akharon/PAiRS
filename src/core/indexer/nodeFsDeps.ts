/**
 * Node-fs workspace enumeration + file reads for the headless CLI/MCP path.
 *
 * Adapted from vendor/reference-indexer/src/index/nodeFsDeps.ts as-is, with
 * `.pairs` swapped for `.pairs` in the skip set (`.pairs/` holds PAiRS's own
 * disposable index — never walk into it).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { langForPath } from './parserRegistry';

/** Directories never worth walking (also the watcher's ignore set). */
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.pairs', '.vscode', 'target']);

/** Is any segment of this workspace-relative path a skipped directory? */
export function isSkippedPath(relPath: string): boolean {
  return relPath.split('/').some((seg) => SKIP_DIRS.has(seg) || (seg.startsWith('.') && seg !== '.'));
}

/**
 * Watch `workspaceRoot` and feed indexable-file events to the callbacks
 * (paths workspace-relative POSIX). One non-recursive fs.watch per
 * non-skipped directory, added/removed as directories appear/vanish —
 * `fs.watch({recursive})` is NOT used because Node's fallback recursive
 * implementation watches every directory including `target/`/`.pairs/`,
 * which exhausts the inotify watcher limit on real Rust workspaces (seen on
 * ARES) and crashes on the resulting unhandled 'error' event.
 * fs.watch cannot distinguish create/modify from delete on 'rename', so
 * existence decides. Returns a disposer. Pair with core WatchQueue for
 * debouncing (plan.md 3.1).
 */
export function nodeWatchWorkspace(
  workspaceRoot: string,
  cb: { changed(relPath: string): void; deleted(relPath: string): void }
): () => void {
  const watchers = new Map<string, fs.FSWatcher>(); // relDir ('' = root) → watcher
  let disposed = false;

  const onFsEvent = (relDir: string, filename: string | null): void => {
    if (disposed || filename === null) return;
    const rel = (relDir ? `${relDir}/` : '') + String(filename).split(path.sep).join('/');
    if (isSkippedPath(rel)) return;
    const abs = path.join(workspaceRoot, rel);
    fs.promises
      .stat(abs)
      .then((st) => {
        if (st.isDirectory()) addDir(rel); // new subdir → start watching it
        else if (langForPath(rel)) cb.changed(rel);
      })
      .catch(() => {
        // Gone: could be a file or a whole directory.
        if (watchers.has(rel)) removeDirTree(rel);
        if (langForPath(rel)) cb.deleted(rel);
      });
  };

  const addDir = (relDir: string): void => {
    if (disposed || watchers.has(relDir) || (relDir !== '' && isSkippedPath(relDir))) return;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(path.join(workspaceRoot, relDir), (_ev, fn) => onFsEvent(relDir, fn as string | null));
    } catch {
      return; // dir vanished between event and watch — fine
    }
    w.on('error', () => watchers.delete(relDir)); // never crash the host on EMFILE etc.
    watchers.set(relDir, w);
    // Recurse into existing children.
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(workspaceRoot, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        addDir(relDir ? `${relDir}/${e.name}` : e.name);
      }
    }
  };

  const removeDirTree = (relDir: string): void => {
    for (const [d, w] of watchers) {
      if (d === relDir || d.startsWith(relDir + '/')) {
        w.close();
        watchers.delete(d);
      }
    }
  };

  addDir('');
  return () => {
    disposed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

/** Recursive workspace enumeration of indexable source files, workspace-relative POSIX paths. */
export function nodeListWorkspaceFiles(workspaceRoot: string): () => Promise<string[]> {
  return async () => {
    const results: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(abs);
        } else if (entry.isFile()) {
          const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
          if (langForPath(rel)) results.push(rel);
        }
      }
    };
    await walk(workspaceRoot);
    return results;
  };
}

export function nodeReadFile(workspaceRoot: string): (relPath: string) => Promise<{ source: string; mtimeMs: number; size: number }> {
  return async (relPath) => {
    const abs = path.join(workspaceRoot, relPath);
    const [stat, source] = await Promise.all([fs.promises.stat(abs), fs.promises.readFile(abs, 'utf8')]);
    return { source, mtimeMs: stat.mtimeMs, size: stat.size };
  };
}
