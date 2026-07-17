/**
 * `GitOps` implementation over the `git` CLI + a sidecar JSON file for the
 * last-indexed commit sha. No vscode import — extension.ts wires this,
 * tests can inject a fake.
 *
 * Rationale for the sidecar file rather than a CodeStore table: the
 * last-indexed sha is cache, not derived index data — losing it just falls
 * back to the normal "record baseline on first observation" path in
 * CodeIndexerImpl.onGitHeadChanged(), never corrupts the index.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { GitOps } from './codeIndexer';

const execFileAsync = promisify(execFile);

export function createGitOps(workspaceRoot: string, statePath: string): GitOps {
  return {
    async headSha(): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
        return stdout.trim() || null;
      } catch {
        return null; // not a git repo, or no commits yet
      }
    },

    async branchName(): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot });
        const name = stdout.trim();
        return !name || name === 'HEAD' ? null : name; // detached HEAD -> 'HEAD'
      } catch {
        return null;
      }
    },

    async dirtyPaths(): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: workspaceRoot,
          maxBuffer: 10 * 1024 * 1024,
        });
        const paths: string[] = [];
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          // Porcelain format: "XY path" or "XY path -> newPath" for renames.
          const rest = line.slice(3);
          const arrow = rest.indexOf(' -> ');
          paths.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
        }
        return paths;
      } catch {
        return [];
      }
    },

    async commitsBetween(fromSha: string, toSha: string): Promise<number | null> {
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${fromSha}..${toSha}`], {
          cwd: workspaceRoot,
        });
        const n = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(n) ? n : null;
      } catch {
        return null; // sha pruned (shallow clone, gc) or unknown
      }
    },

    async diffNames(fromSha, toSha) {
      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--name-status', '--no-renames', fromSha, toSha],
          { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 }
        );
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const [status, ...rest] = line.split('\t');
          const filePath = rest[rest.length - 1];
          if (!status || !filePath) continue;
          if (status === 'A') added.push(filePath);
          else if (status === 'D') deleted.push(filePath);
          else modified.push(filePath);
        }
      } catch {
        // fromSha may have been pruned (shallow clone, gc) — caller's queue
        // stays empty; next commit's diff recovers once shas are valid again.
      }
      return { added, modified, deleted };
    },

    async getLastIndexedSha(): Promise<string | null> {
      try {
        const raw = await fs.promises.readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw) as { lastSha?: string };
        return parsed.lastSha ?? null;
      } catch {
        return null;
      }
    },

    async setLastIndexedSha(sha: string): Promise<void> {
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
      await fs.promises.writeFile(statePath, JSON.stringify({ lastSha: sha }), 'utf8');
    },
  };
}
