/**
 * Node-fs workspace enumeration + file reads for the headless CLI/MCP path.
 *
 * Adapted from vendor/reference-indexer/src/index/nodeFsDeps.ts as-is, with
 * `.pairs` swapped for `.gizem` in the skip set (`.gizem/` holds GIZEM's own
 * disposable index — never walk into it).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { langForPath } from './parserRegistry';

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.gizem', '.vscode', 'target']);

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
