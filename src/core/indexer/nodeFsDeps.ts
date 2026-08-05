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
import { globToRegExp } from '../rules/evaluate';

/** Directories never worth walking (also the watcher's ignore set). */
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.pairs', '.vscode', 'target']);

/**
 * Extensions never worth filename-indexing: compiled/binary artifacts and
 * common media/archives. Source extensions (langForPath) are excluded from
 * NamedFile separately — this list only keeps true binary noise out.
 */
export const BINARY_EXTS = new Set([
  '.so', '.lib', '.exe', '.a', '.dll', '.dylib', '.o', '.obj', '.bin', '.pyc', '.class', '.jar', '.wasm',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
]);

function isBinaryPath(relPath: string): boolean {
  return BINARY_EXTS.has(path.extname(relPath).toLowerCase());
}

/**
 * Minimal `.gitignore` reader: `#` comments, blank lines, plain glob patterns
 * (via globToRegExp — `*` = one path segment, `**` = any depth), and
 * directory-only patterns (trailing `/`, matched as a path prefix). No `!`
 * negation, no anchored (`/`-prefixed) patterns — covers the common case
 * without reimplementing full git semantics.
 */
export function parseGitignore(contents: string): (relPath: string) => boolean {
  const filePatterns: RegExp[] = [];
  const dirPatterns: RegExp[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const isDir = line.endsWith('/');
    const pattern = isDir ? line.slice(0, -1) : line;
    const anchored = pattern.includes('/') ? pattern.replace(/^\//, '') : `**/${pattern}`;
    (isDir ? dirPatterns : filePatterns).push(globToRegExp(anchored));
  }
  return (relPath: string): boolean => {
    if (filePatterns.some((re) => re.test(relPath))) return true;
    if (dirPatterns.length === 0) return false;
    const segs = relPath.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (dirPatterns.some((re) => re.test(prefix))) return true;
    }
    return false;
  };
}

/** Loads and parses `<root>/.gitignore`, or a match-nothing predicate if absent. */
async function loadGitignore(root: string): Promise<(relPath: string) => boolean> {
  try {
    const contents = await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8');
    return parseGitignore(contents);
  } catch {
    return () => false;
  }
}

/**
 * What a directory entry is, following symlinks one level.
 *
 * `readdir(withFileTypes)` builds Dirents from lstat-style metadata, so a
 * symlink answers false to BOTH isDirectory() and isFile() — walking on those
 * alone silently drops linked source trees. Resolve the link to classify it by
 * its target instead. Broken links and unreadable targets classify as 'other'
 * (skipped), never throw.
 */
async function classifyEntry(entry: fs.Dirent, abs: string): Promise<'dir' | 'file' | 'other'> {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return 'other';
  try {
    const st = await fs.promises.stat(abs); // follows the link; throws if dangling
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch {
    return 'other'; // dangling or unreadable target
  }
}

/** Sync counterpart of `classifyEntry` for the watcher's setup path. */
function classifyEntrySync(entry: fs.Dirent, abs: string): 'dir' | 'file' | 'other' {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return 'other';
  try {
    const st = fs.statSync(abs);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Canonical path for cycle detection, or null if unresolvable. Symlinks can
 * point at an ancestor (`ws/link -> ws`) or at each other, which would make a
 * naive recursive walk loop forever — dedupe on real path so each physical
 * directory is visited once.
 */
async function realPathOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(abs);
  } catch {
    return null;
  }
}

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
  const realOfWatched = new Map<string, string>(); // relDir → real path
  const watchedReal = new Set<string>(); // real paths of watched dirs — breaks symlink cycles
  let disposed = false;

  const onFsEvent = (relDir: string, filename: string | null): void => {
    if (disposed || filename === null) return;
    const rel = (relDir ? `${relDir}/` : '') + String(filename).split(path.sep).join('/');
    if (isSkippedPath(rel)) return;
    const abs = path.join(workspaceRoot, rel);
    fs.promises
      .stat(abs) // follows symlinks: a linked dir/file is treated as its target
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
    const absDir = path.join(workspaceRoot, relDir);
    // Two links to one physical dir would otherwise mean two watchers and
    // duplicate events; an ancestor link would recurse forever.
    let real: string;
    try {
      real = fs.realpathSync(absDir);
    } catch {
      return; // dangling link or vanished dir
    }
    if (watchedReal.has(real)) return;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(absDir, (_ev, fn) => onFsEvent(relDir, fn as string | null));
    } catch {
      return; // dir vanished between event and watch — fine
    }
    w.on('error', () => {
      watchers.delete(relDir);
      realOfWatched.delete(relDir);
      watchedReal.delete(real);
    }); // never crash the host on EMFILE etc.
    watchers.set(relDir, w);
    realOfWatched.set(relDir, real);
    watchedReal.add(real);
    // Recurse into existing children (symlinked dirs included).
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (classifyEntrySync(e, path.join(absDir, e.name)) === 'dir') {
        addDir(relDir ? `${relDir}/${e.name}` : e.name);
      }
    }
  };

  const removeDirTree = (relDir: string): void => {
    for (const [d, w] of watchers) {
      if (d === relDir || d.startsWith(relDir + '/')) {
        w.close();
        watchers.delete(d);
        watchedReal.delete(realOfWatched.get(d) ?? '');
        realOfWatched.delete(d);
      }
    }
  };

  addDir('');
  return () => {
    disposed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
    realOfWatched.clear();
    watchedReal.clear();
  };
}

/**
 * Recursive workspace enumeration of indexable source files, workspace-relative
 * POSIX paths.
 *
 * Symlinked directories and files are followed (classifyEntry), so a workspace
 * that links in a shared source tree indexes it. Paths stay workspace-relative
 * *through* the link (`linkedDir/ext.ts`, not the target's real path) — that is
 * the identity the store, watcher and rule globs all use.
 *
 * Cycle protection tracks the real paths of the CURRENT descent (`ancestors`),
 * not every directory ever visited: a link pointing at its own ancestor must
 * stop, but two distinct links to one shared tree are both legitimate workspace
 * paths and must each be enumerated. A global visited-set would silently drop
 * whichever link the walk reached second.
 */
export function nodeListWorkspaceFiles(workspaceRoot: string): () => Promise<string[]> {
  return async () => {
    const results: string[] = [];
    const walk = async (dir: string, ancestors: ReadonlySet<string>): Promise<void> => {
      const real = await realPathOrNull(dir);
      if (real === null || ancestors.has(real)) return; // unresolvable, or a link back into our own descent
      const nextAncestors = new Set(ancestors).add(real);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const abs = path.join(dir, entry.name);
        const kind = await classifyEntry(entry, abs);
        if (kind === 'dir') {
          if (!SKIP_DIRS.has(entry.name)) await walk(abs, nextAncestors);
        } else if (kind === 'file') {
          const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
          if (langForPath(rel)) results.push(rel);
        }
      }
    };
    await walk(workspaceRoot, new Set());
    return results;
  };
}

/**
 * Recursive enumeration of non-source-code files (filename indexing only —
 * no content is read). Skips everything nodeListWorkspaceFiles skips
 * (dotfiles/dirs, SKIP_DIRS, symlink cycles), plus files langForPath already
 * covers (those live in File, not NamedFile), binary/media extensions
 * (BINARY_EXTS), and anything the workspace's root `.gitignore` excludes.
 */
export function nodeListNamedFiles(workspaceRoot: string): () => Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  return async () => {
    const isIgnored = await loadGitignore(workspaceRoot);
    const results: Array<{ path: string; mtimeMs: number; size: number }> = [];
    const walk = async (dir: string, ancestors: ReadonlySet<string>): Promise<void> => {
      const real = await realPathOrNull(dir);
      if (real === null || ancestors.has(real)) return;
      const nextAncestors = new Set(ancestors).add(real);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const abs = path.join(dir, entry.name);
        const kind = await classifyEntry(entry, abs);
        if (kind === 'dir') {
          if (!SKIP_DIRS.has(entry.name)) await walk(abs, nextAncestors);
        } else if (kind === 'file') {
          const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
          if (langForPath(rel) || isBinaryPath(rel) || isIgnored(rel)) continue;
          try {
            const st = await fs.promises.stat(abs);
            results.push({ path: rel, mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            // vanished between readdir and stat — skip
          }
        }
      }
    };
    await walk(workspaceRoot, new Set());
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
