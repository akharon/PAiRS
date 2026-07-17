/**
 * IndexProvenanceService implementation over the `generations`/`meta` tables
 * added to code.db by SqliteCodeStore.migrate() (see codeStoreImpl.ts). Shares
 * the same DatabaseSync as the CodeStore it's constructed alongside — no
 * separate connection, no separate lifecycle (dispose() is owned by
 * SqliteCodeStore, mirroring the note in docs/MemoryIndexSynergy.md §4).
 */

import { DatabaseSync } from '../core/sqliteStore';
import type { GitOps } from './codeIndexer';
import type { IndexFreshness, IndexGeneration, IndexProvenanceService, MetaStore } from './provenance';

interface GenerationRow {
  id: number;
  commit_sha: string | null;
  branch: string | null;
  dirty_paths: string;
  started_at: number;
  completed_at: number | null;
  tool_version: string;
}

function rowToGeneration(r: GenerationRow): IndexGeneration {
  return {
    id: r.id,
    commit: r.commit_sha,
    branch: r.branch,
    dirtyPaths: JSON.parse(r.dirty_paths) as string[],
    startedAt: r.started_at,
    completedAt: r.completed_at,
    toolVersion: r.tool_version,
  };
}

export class SqliteIndexProvenanceService implements IndexProvenanceService, MetaStore {
  constructor(private readonly db: DatabaseSync) {}

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  async current(): Promise<IndexGeneration | null> {
    const row = this.db.prepare(`SELECT * FROM generations ORDER BY id DESC LIMIT 1`).get() as
      | GenerationRow
      | undefined;
    return row ? rowToGeneration(row) : null;
  }

  private async lastCompleted(): Promise<IndexGeneration | null> {
    const row = this.db
      .prepare(`SELECT * FROM generations WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get() as GenerationRow | undefined;
    return row ? rowToGeneration(row) : null;
  }

  async beginGeneration(input: { git?: GitOps; dirtyPaths?: string[]; toolVersion: string }): Promise<number> {
    const commit = (await input.git?.headSha().catch(() => null)) ?? null;
    const branch = (await input.git?.branchName().catch(() => null)) ?? null;
    const dirtyPaths = input.dirtyPaths ?? [];
    const info = this.db
      .prepare(
        `INSERT INTO generations (commit_sha, branch, dirty_paths, started_at, completed_at, tool_version)
         VALUES (?, ?, ?, ?, NULL, ?)`
      )
      .run(commit, branch, JSON.stringify(dirtyPaths), Date.now(), input.toolVersion);
    return Number(info.lastInsertRowid);
  }

  async completeGeneration(id: number): Promise<void> {
    this.db
      .prepare(`UPDATE generations SET completed_at = ? WHERE id = ? AND completed_at IS NULL`)
      .run(Date.now(), id);
  }

  async needsFullRebuild(toolVersion: string): Promise<boolean> {
    const last = await this.lastCompleted();
    return last !== null && last.toolVersion !== toolVersion;
  }

  async freshness(input: { git?: GitOps; queued?: number }): Promise<IndexFreshness> {
    // Called on every code-tool response — this method is a hot path, so the
    // 4 independent lookups (2 sqlite reads, up to 2 git subprocess spawns)
    // run in parallel rather than sequentially awaited one at a time.
    const [generation, inFlight, headSha, dirtyNow] = await Promise.all([
      this.lastCompleted(),
      this.current(),
      input.git?.headSha().catch(() => null) ?? Promise.resolve(null),
      input.git?.dirtyPaths().catch(() => []) ?? Promise.resolve([]),
    ]);

    let commitsBehind: number | null = null;
    if (generation?.commit && headSha && input.git) {
      commitsBehind =
        generation.commit === headSha ? 0 : await input.git.commitsBetween(generation.commit, headSha).catch(() => null);
    }

    const covered = new Set(generation?.dirtyPaths ?? []);
    const dirtyUnindexed = dirtyNow.filter((p) => !covered.has(p));

    return {
      generation,
      headSha,
      commitsBehind,
      dirtyUnindexed,
      indexing: inFlight !== null && inFlight.completedAt === null,
      queued: input.queued ?? 0,
    };
  }
}
