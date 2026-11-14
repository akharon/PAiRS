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
import { globToRegExp } from './types';

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
 * (via globToRegExp — `*` = one path segment, `**` = any depth), directory-only
 * patterns (trailing `/`, matched as a path prefix), anchored (`/`-prefixed)
 * patterns, and `!` negation (a later negated pattern re-includes a path an
 * earlier pattern excluded — evaluated in file order, matching git). Paths
 * passed to the returned predicate are relative to the `.gitignore`'s own
 * directory, not the workspace root — callers combining multiple gitignore
 * files must rebase accordingly.
 */
export function parseGitignore(contents: string): (relPath: string) => boolean {
  type Rule = { re: RegExp; negate: boolean; dir: boolean };
  const rules: Rule[] = [];
  for (const rawLine of contents.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const isDir = line.endsWith('/');
    const pattern = isDir ? line.slice(0, -1) : line;
    const anchored = pattern.includes('/') ? pattern.replace(/^\//, '') : `**/${pattern}`;
    rules.push({ re: globToRegExp(anchored), negate, dir: isDir });
  }
  return (relPath: string): boolean => {
    const segs = relPath.split('/');
    let ignored = false;
    for (const rule of rules) {
      const hit = rule.dir
        ? segs.some((_, i) => rule.re.test(segs.slice(0, i + 1).join('/')))
        : rule.re.test(relPath);
      if (hit) ignored = !rule.negate;
    }
    return ignored;
  };
}

const GITIGNORE_CACHE_MISS = () => false;

/** Loads and parses `<dir>/.gitignore`, or a match-nothing predicate if absent. */
async function loadGitignoreAt(dir: string): Promise<(relPath: string) => boolean> {
  try {
    const contents = await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8');
    return parseGitignore(contents);
  } catch {
    return GITIGNORE_CACHE_MISS;
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

/** One loaded .gitignore, scoped to the directory it lives in. */
interface GitignoreScope {
  relDir: string;
  test: (relPath: string) => boolean;
}

/**
 * Does any applicable gitignore (root down to the containing dir) ignore this
 * workspace-relative path? Shared by the walker and the watcher filter so
 * both apply identical `.gitignore` semantics. Each file's own `!` negations
 * are handled inside parseGitignore.
 */
function ignoredByStack(stack: ReadonlyArray<GitignoreScope>, rel: string): boolean {
  for (const g of stack) {
    const sub = g.relDir ? rel.slice(g.relDir.length + 1) : rel;
    if (sub === '' || sub.startsWith('..')) continue;
    if (g.test(sub)) return true;
  }
  return false;
}

/** What `<dir>/.git` is: a FILE (linked worktree / submodule), a DIRECTORY (independent repo) or absent. */
export type GitMarker = 'file' | 'dir' | 'none';

function gitMarkerSync(absDir: string): GitMarker {
  try {
    return fs.statSync(path.join(absDir, '.git')).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

async function gitMarker(absDir: string): Promise<GitMarker> {
  try {
    return (await fs.promises.stat(path.join(absDir, '.git'))).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

/**
 * Repository boundary rule for a NESTED directory (never the walk root).
 *  - `.git` FILE: a linked worktree or submodule — a duplicate copy of code
 *    that lives elsewhere. Never descend; indexing it multiplies every symbol.
 *  - `.git` DIRECTORY: an independent repo. Skipped when the walk root is itself
 *    a repo (a vendored clone inside a repo); indexed when the root is NOT a
 *    repo (a multi-repo parent folder holding several checkouts).
 */
function isRepoBoundary(marker: GitMarker, rootIsRepo: boolean): boolean {
  return marker === 'file' || (marker === 'dir' && rootIsRepo);
}

export interface WorkspaceFilter {
  /** Whether the workspace root itself is a git repo (has a `.git` entry). */
  readonly rootIsRepo: boolean;
  /**
   * Should this workspace-relative POSIX path (file OR directory) be left out of
   * the index? Covers SKIP_DIRS, dot-dirs, nested-repo boundaries and the root
   * plus nested `.gitignore`s — the same rules the full-index walker applies, so
   * a file watcher using it can't index what a full index would not.
   */
  isExcluded(relPath: string): boolean;
}

/**
 * Sync, cached counterpart of the walker's exclusion rules, for event-driven
 * callers (fs.watch, the VS Code FileSystemWatcher). Gitignore scopes and
 * `.git` marker lookups are cached for `ttlMs` so a burst of events costs a
 * handful of stats, while a newly added worktree or edited .gitignore is still
 * noticed within seconds.
 */
export function createWorkspaceFilter(
  root: string,
  opts: { ttlMs?: number; now?: () => number } = {}
): WorkspaceFilter {
  const ttlMs = opts.ttlMs ?? 5000;
  const now = opts.now ?? Date.now;
  const rootIsRepo = gitMarkerSync(root) !== 'none';
  const markers = new Map<string, { v: GitMarker; at: number }>();
  const scopes = new Map<string, { v: GitignoreScope | null; at: number }>();

  const markerOf = (relDir: string): GitMarker => {
    const hit = markers.get(relDir);
    const t = now();
    if (hit && t - hit.at < ttlMs) return hit.v;
    const v = gitMarkerSync(path.join(root, relDir));
    markers.set(relDir, { v, at: t });
    return v;
  };

  const scopeOf = (relDir: string): GitignoreScope | null => {
    const hit = scopes.get(relDir);
    const t = now();
    if (hit && t - hit.at < ttlMs) return hit.v;
    let v: GitignoreScope | null = null;
    try {
      v = { relDir, test: parseGitignore(fs.readFileSync(path.join(root, relDir, '.gitignore'), 'utf8')) };
    } catch {
      v = null;
    }
    scopes.set(relDir, { v, at: t });
    return v;
  };

  return {
    rootIsRepo,
    isExcluded(relPath: string): boolean {
      if (relPath === '' || relPath === '.') return false;
      if (isSkippedPath(relPath)) return true;
      const segs = relPath.split('/').filter(Boolean);
      const stack: GitignoreScope[] = [];
      const rootScope = scopeOf('');
      if (rootScope) stack.push(rootScope);
      let cur = '';
      for (let i = 0; i < segs.length; i++) {
        cur = cur ? `${cur}/${segs[i]}` : segs[i]!;
        if (ignoredByStack(stack, cur)) return true;
        if (isRepoBoundary(markerOf(cur), rootIsRepo)) return true;
        if (i < segs.length - 1) {
          const sc = scopeOf(cur);
          if (sc) stack.push(sc);
        }
      }
      return false;
    },
  };
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
 * debouncing.
 *
 * Applies {@link createWorkspaceFilter}: root + nested `.gitignore`s and
 * nested-repo boundaries, identical to the full-index walk.
 */
export function nodeWatchWorkspace(
  workspaceRoot: string,
  cb: { changed(relPath: string): void; deleted(relPath: string): void }
): () => void {
  const watchers = new Map<string, fs.FSWatcher>(); // relDir ('' = root) → watcher
  const realOfWatched = new Map<string, string>(); // relDir → real path
  const watchedReal = new Set<string>(); // real paths of watched dirs — breaks symlink cycles
  let disposed = false;
  const filter = createWorkspaceFilter(workspaceRoot);

  const onFsEvent = (relDir: string, filename: string | null): void => {
    if (disposed || filename === null) return;
    const rel = (relDir ? `${relDir}/` : '') + String(filename).split(path.sep).join('/');
    if (filter.isExcluded(rel)) return;
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
    if (disposed || watchers.has(relDir) || (relDir !== '' && filter.isExcluded(relDir))) return;
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

interface WalkCollectors {
  source: string[];
  named: Array<{ path: string; mtimeMs: number; size: number }>;
}

/**
 * Single recursive workspace walk shared by {@link nodeListWorkspaceFiles} and
 * {@link nodeListNamedFiles} — they differed only in their per-file predicate,
 * so walking the tree twice (once per caller) doubled real I/O for no reason.
 * This collects both source and named files in one pass; callers that only
 * want one just read the corresponding array back.
 *
 * Symlinked directories and files are followed (classifyEntry), so a workspace
 * that links in a shared source tree indexes it. Paths stay workspace-relative
 * *through* the link (`linkedDir/ext.ts`, not the target's real path) — that is
 * the identity the store, watcher and rule globs all use.
 *
 * `.gitignore` handling: every directory's own `.gitignore` (not just the
 * root's) is loaded and applied to its subtree, matching git's actual nested
 * semantics — monorepo packages with their own `.gitignore` get it honoured
 * instead of only the root's. Patterns from ancestor gitignores stack: a file
 * is ignored if any applicable gitignore (root down to its containing dir)
 * says so, and a closer `!`-negation can re-include it, again matching git.
 * Ignored *directories* are pruned before recursing into them rather than
 * walked and filtered file-by-file — this is the main win over the old
 * per-file check, since a large ignored subtree (e.g. `coverage/`) is no
 * longer enumerated at all.
 *
 * Cycle protection tracks the real paths of the CURRENT descent (`ancestors`),
 * not every directory ever visited: a link pointing at its own ancestor must
 * stop, but two distinct links to one shared tree are both legitimate workspace
 * paths and must each be enumerated. A global visited-set would silently drop
 * whichever link the walk reached second.
 */
async function walkWorkspace(workspaceRoot: string): Promise<WalkCollectors> {
  const results: WalkCollectors = { source: [], named: [] };
  const rootIsRepo = (await gitMarker(workspaceRoot)) !== 'none';
  // Stack of (relDir-prefix, predicate) pairs from root to current directory;
  // relPaths passed to `walk` are workspace-relative, so each ancestor
  // predicate needs the path rebased to *its own* directory before testing.
  const walk = async (
    dir: string,
    relDir: string,
    ancestors: ReadonlySet<string>,
    gitignores: ReadonlyArray<{ relDir: string; test: (p: string) => boolean }>
  ): Promise<void> => {
    const real = await realPathOrNull(dir);
    if (real === null || ancestors.has(real)) return; // unresolvable, or a link back into our own descent
    const nextAncestors = new Set(ancestors).add(real);

    const localIgnore = await loadGitignoreAt(dir);
    const stack =
      localIgnore === GITIGNORE_CACHE_MISS ? gitignores : [...gitignores, { relDir, test: localIgnore }];

    const isIgnored = (rel: string): boolean => ignoredByStack(stack, rel);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      const kind = await classifyEntry(entry, abs);
      if (kind === 'dir') {
        if (SKIP_DIRS.has(entry.name) || isIgnored(rel)) continue;
        // Linked worktrees / submodules (`.git` FILE) are duplicate copies of
        // code — never descend. Independent repos (`.git` dir) are skipped only
        // when the root is itself a repo. See isRepoBoundary.
        if (isRepoBoundary(await gitMarker(abs), rootIsRepo)) continue;
        // `rel` (not relDir) so a nested .gitignore is scoped to its own directory.
        await walk(abs, rel, nextAncestors, stack);
      } else if (kind === 'file') {
        if (isIgnored(rel)) continue;
        if (langForPath(rel)) {
          results.source.push(rel);
        } else if (!isBinaryPath(rel)) {
          try {
            const st = await fs.promises.stat(abs);
            results.named.push({ path: rel, mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            // vanished between readdir and stat — skip
          }
        }
      }
    }
  };
  await walk(workspaceRoot, '', new Set(), []);
  return results;
}

/**
 * Recursive workspace enumeration of indexable source files, workspace-relative
 * POSIX paths. See {@link walkWorkspace} for gitignore/symlink/pruning behaviour.
 */
export function nodeListWorkspaceFiles(workspaceRoot: string): () => Promise<string[]> {
  return async () => (await walkWorkspace(workspaceRoot)).source;
}

/**
 * Recursive enumeration of non-source-code files (filename indexing only —
 * no content is read). Skips everything nodeListWorkspaceFiles skips
 * (dotfiles/dirs, SKIP_DIRS, symlink cycles, gitignored paths), plus files
 * langForPath already covers (those live in File, not NamedFile) and
 * binary/media extensions (BINARY_EXTS). See {@link walkWorkspace}.
 */
export function nodeListNamedFiles(workspaceRoot: string): () => Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  return async () => (await walkWorkspace(workspaceRoot)).named;
}

/**
 * Stat without reading — contract for IndexerDeps.statFile, so the indexer can
 * skip unchanged files on mtime/size before ever opening them.
 */
export function nodeStatFile(workspaceRoot: string): (relPath: string) => Promise<{ mtimeMs: number; size: number }> {
  return async (relPath) => {
    const st = await fs.promises.stat(path.join(workspaceRoot, relPath));
    return { mtimeMs: st.mtimeMs, size: st.size };
  };
}

export function nodeReadFile(workspaceRoot: string): (relPath: string) => Promise<{ source: string; mtimeMs: number; size: number }> {
  return async (relPath) => {
    const abs = path.join(workspaceRoot, relPath);
    const [stat, source] = await Promise.all([fs.promises.stat(abs), fs.promises.readFile(abs, 'utf8')]);
    return { source, mtimeMs: stat.mtimeMs, size: stat.size };
  };
}
