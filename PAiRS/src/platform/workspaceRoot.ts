/**
 * Workspace-root discovery and git-worktree awareness. Pure node fs — no
 * editor imports (G1), usable from the CLI and the extension alike.
 *
 * Why this exists: the CLI used to treat `process.cwd()` as the root, so
 * running `pairs` from a subdirectory or from a linked git worktree created a
 * brand new (empty) `.pairs/index.db` right there. Discovery pins the root to
 * the nearest enclosing repo (or an existing index) instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DiscoverOptions {
  /** `--root <dir>` — highest precedence. */
  explicit?: string;
  /** Environment to read `PAIRS_ROOT` from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

function existsSync(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Precedence: `--root` > `PAIRS_ROOT` > walk up from `startDir`, stopping at
 * the FIRST directory holding either `.pairs/index.db` or a `.git` entry
 * (a directory, or the FILE a linked worktree/submodule has). Stopping at the
 * first `.git` of either kind is what keeps a worktree nested inside the main
 * repo (`<repo>/.claude/worktrees/x`) from escaping to the main repo's index,
 * and keeps subdirectories from minting stray `.pairs/` folders. Falls back
 * to `startDir` when nothing is found.
 */
export function discoverWorkspaceRoot(startDir: string, opts: DiscoverOptions = {}): string {
  const env = opts.env ?? process.env;
  if (opts.explicit) return path.resolve(opts.explicit);
  if (env.PAIRS_ROOT) return path.resolve(env.PAIRS_ROOT);

  const start = path.resolve(startDir);
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, '.pairs', 'index.db')) || existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export interface GitWorktreeInfo {
  kind: 'main' | 'linked' | 'submodule' | 'none';
  /** For a linked worktree: the main worktree's root (when the common dir is a `<main>/.git`). */
  mainRoot?: string;
}

/**
 * Resolve a path found inside a git metadata file. Handles relative paths
 * (against `base`), POSIX absolutes and Windows drive paths with either slash
 * style. On a non-Windows host a `C:\x` path (e.g. a repo created by Windows
 * git and read from WSL) maps to `/mnt/c/x`.
 */
export function resolveGitPath(base: string, p: string, platform: NodeJS.Platform = process.platform): string {
  const win = /^([A-Za-z]):[\\/]/.exec(p);
  if (win) {
    if (platform === 'win32') return path.win32.normalize(p);
    return path.posix.normalize(`/mnt/${win[1]!.toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`);
  }
  if (platform === 'win32') return path.win32.resolve(base, p);
  return path.posix.resolve(base, p.replace(/\\/g, '/'));
}

function readTrim(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Classify `root`'s git situation. A linked worktree has a `.git` FILE
 * `gitdir: <common>/worktrees/<name>`; that gitdir's `commondir` file (usually
 * `../..`) leads back to the common dir, whose parent is the main worktree.
 * A submodule's gitdir lives under `<super>/.git/modules/`.
 */
export function gitWorktreeInfo(root: string): GitWorktreeInfo {
  const dotGit = path.join(root, '.git');
  let st: fs.Stats;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return { kind: 'none' };
  }
  if (st.isDirectory()) return { kind: 'main', mainRoot: root };

  const text = readTrim(dotGit);
  const m = text === null ? null : /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return { kind: 'none' };
  const gitdir = resolveGitPath(root, m[1]!.trim());
  const norm = gitdir.replace(/\\/g, '/');

  if (/\/worktrees\/[^/]+\/?$/.test(norm)) {
    const commonRaw = readTrim(path.join(gitdir, 'commondir'));
    const common = commonRaw ? resolveGitPath(gitdir, commonRaw) : resolveGitPath(gitdir, '../..');
    const normCommon = common.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/\/modules\//.test(normCommon)) return { kind: 'linked' }; // worktree of a submodule: no single main root
    const info: GitWorktreeInfo = { kind: 'linked' };
    if (path.basename(common) === '.git') info.mainRoot = path.dirname(common);
    return info;
  }
  if (/\/\.git\/modules\//.test(norm) || /\/modules\/[^/]+/.test(norm)) return { kind: 'submodule' };
  // `git init --separate-git-dir` and friends: a plain repo whose gitdir lives elsewhere.
  return { kind: 'main', mainRoot: root };
}
