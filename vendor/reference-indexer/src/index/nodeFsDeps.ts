/**
 * Node-fs implementations of CodeIndexerDeps' file access for headless use
 * (the standalone MCP server's --index-on-start mode). extension.ts keeps its
 * vscode.workspace-backed versions; tests can exercise these over a temp dir.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { langForPath } from './parserRegistry';

/** Directories never worth walking, mirroring the extension's default excludes. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.pairs', '.vscode']);

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

export function nodeReadFile(
  workspaceRoot: string
): (relPath: string) => Promise<{ source: string; mtimeMs: number; size: number }> {
  return async (relPath) => {
    const abs = path.join(workspaceRoot, relPath);
    const [stat, source] = await Promise.all([fs.promises.stat(abs), fs.promises.readFile(abs, 'utf8')]);
    return { source, mtimeMs: stat.mtimeMs, size: stat.size };
  };
}
