/**
 * Code graph store contract. Backed by KuzuDB (Cypher) under `.pairs/index/`
 * (ADR-009) — the index is derived data: rebuildable, disposable, no write
 * guards (subsystem_graph_store_spec.md §4).
 *
 * Interface shape adapted from vendor/reference-indexer/src/index/codeStore.ts
 * (its `CodeStoreImpl` over SQLite is the algorithmic reference for
 * `resolvePending`, `findCycles` (Tarjan), `unreferenced`, `fileEdges`,
 * `hotspots`, `untested` — see vendor/reference-indexer/REUSE.md). Trimmed:
 * no FTS (`ftsSearch`), no embeddings (`setEmbedding`/`semanticSearch`/
 * `similarPairs`) — out of PAiRS's scope. `findCycles` operates on the
 * DEPENDS_ON graph at Module or Type scope (subsystem_mcp_rules_spec.md's
 * `NoCycles` rule kind), not just file imports.
 *
 * Schema (nodes/edges — see subsystem_graph_store_spec.md for the Kuzu DDL):
 *
 *   File(id, path UNIQUE, lang, mtimeMs, size, hash, indexedAt, crate, parseError)
 *   Symbol(id, fileId, name, qualified, kind, lang, startLine, endLine,
 *          signature, doc, parentId, exported)
 *   DECLARES / PARAM / OF_TYPE / RETURNS / OWNS  -- structural edges (Pass 1)
 *   CALLS / READS / WRITES / DEPENDS_ON / IMPLEMENTS  -- reference edges
 *          (Pass 2), each carrying {line, confidence}
 *   PendingRef(fileId, fromSymbolId, name, kind, line)  -- unresolved refs,
 *          retried by resolvePending as new files arrive
 *
 * Invariants:
 *  - `applyExtraction` is transactional: delete-old-rows + insert-new must be
 *    atomic (the sole write path — subsystem_graph_store_spec.md §2's
 *    `writeFileSubgraph`).
 *  - Unresolvable refs go to PendingRef, never dropped: `resolvePending`
 *    retries them as new files arrive (a definition may index after its uses).
 *  - Schema versioning: a mismatched schema_version means an old index —
 *    DROP and recreate (the index is rebuildable derived data — never write
 *    migration code for it).
 */

import type { DeadCodeCandidate, DeadCodeFilter, EdgeKind, EdgeRecord, FileDep, FileRecord, FileExtraction, HotspotQuery, IndexStats, SymbolRecord, AmbiguousSymbol } from '../../core/indexer/types';

/**
 * Blank out Cypher string literals and comments so keyword scans (`query()`'s
 * read-only guard, config.ts's assertReadOnlyCypher) don't false-positive on
 * words like "delete" appearing inside quoted data (`WHERE s.doc CONTAINS
 * 'create'`). Replacement preserves length/newlines so any reported positions
 * still line up. Handles single/double-quoted strings with backslash escapes,
 * `//` line comments, and `/* *\/` block comments.
 */
export function stripCypherLiterals(cypher: string): string {
  let out = '';
  let i = 0;
  const n = cypher.length;
  while (i < n) {
    const c = cypher[i]!;
    if (c === "'" || c === '"') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n) {
        if (cypher[i] === '\\') { out += '  '; i += 2; continue; }
        if (cypher[i] === quote) { out += ' '; i++; break; }
        out += cypher[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else if (c === '/' && cypher[i + 1] === '/') {
      while (i < n && cypher[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && cypher[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(cypher[i] === '*' && cypher[i + 1] === '/')) {
        out += cypher[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export interface CodeStore {
  // -- Indexing (called by the Indexer) --------------------------------------
  /**
   * Replace all graph rows for `extraction.path` in one transaction: delete
   * prior symbols (cascades to structural/reference edges), insert new
   * symbols, resolve refs it can (same-file scope first), park the rest in
   * PendingRef. Returns the stored file row.
   */
  applyExtraction(extraction: FileExtraction): Promise<FileRecord>;
  /** Remove a deleted file's rows entirely. No-op if unknown. */
  removeFile(path: string): Promise<void>;
  /**
   * Pass 2: retry PendingRef rows against the current symbol table using
   * (a) `use`-scoped match, (b) unique-global-name match → 'resolved',
   * (c) multi-candidate name match → one 'fuzzy' edge per candidate. Refs
   * that still match nothing stay pending (confidence 'unresolved').
   * Returns #edges created.
   * @param namesHint retry only refs whose name is in the hint (cheap
   *        incremental call after one file indexed); omit for a full pass.
   */
  resolvePending(namesHint?: string[]): Promise<number>;
  /** Known files with their hash/mtime — the indexer diffs against disk on startup. */
  listFiles(): Promise<FileRecord[]>;

  // -- Symbol lookup ----------------------------------------------------------
  get(id: number): Promise<SymbolRecord | null>;
  /**
   * Resolve a user/agent-supplied name to symbols. Matches `qualified`
   * exactly first, then bare `name`. Multiple hits → AmbiguousSymbol (tools
   * render the candidate list and ask the agent to qualify).
   */
  lookup(nameOrQualified: string): Promise<SymbolRecord[] | AmbiguousSymbol>;
  /** All symbols of a file ordered by startLine. */
  outline(path: string): Promise<SymbolRecord[]>;
  /** Direct children of a symbol (method → containing impl block), ordered by startLine. */
  membersOf(parentId: number): Promise<SymbolRecord[]>;

  // -- Graph queries -----------------------------------------------------------
  /** Edges pointing AT these symbols (impact/who-calls, direction='callers'). */
  edgesTo(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]>;
  /** Edges leaving these symbols (direction='callees'). */
  edgesFrom(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]>;
  /** Arbitrary read-only Cypher (the rule engine's escape hatch — must RETURN nodes). */
  /** Raw read-only Cypher. Rows come back untyped — Kuzu cannot verify a caller-supplied row type. */
  query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;

  // -- Analysis (core/analyze, subsystem_mcp_rules_spec.md §5) -----------------
  /**
   * Symbols with ZERO incoming reference edges of any kind. Exclusions:
   *  - kind 'module' (files are entry points, not dead code)
   *  - Rust entry-point names ('main') and test-attributed items (best-effort,
   *    path-based — see isTestPath in core/indexer/types.ts)
   *  - exported (`pub`) symbols unless filter.includeExported (returned with
   *    note='exported')
   * Ordered by file path then startLine.
   */
  unreferenced(filter: DeadCodeFilter): Promise<DeadCodeCandidate[]>;
  /**
   * File-level dependency query over DEPENDS_ON edges joined through
   * Symbol.fileId → DISTINCT File.
   *  - direction 'imports': files this file depends on
   *  - direction 'importers': files that depend on this file
   * transitive=true walks up to `maxDepth` (default 5) hops breadth-first.
   */
  fileEdges(path: string, direction: 'imports' | 'importers', opts?: { transitive?: boolean; maxDepth?: number; limit?: number }): Promise<FileDep[]>;
  /** Top-N functions/methods by CALLS out-degree (fan_out rule / code_hotspots). */
  hotspots(query: HotspotQuery): Promise<SymbolRecord[]>;
  /**
   * Exported (`pub`) non-test symbols with no incoming edge from a test-file
   * symbol at depth 1 (direct callers only). Mirrors unreferenced()'s
   * entry-point/test-path exclusions.
   */
  untested(filter: { pathPrefix?: string; excludePath?: string; limit?: number; offset?: number }): Promise<SymbolRecord[]>;
  /**
   * Detect cycles via Tarjan's SCC over a chosen edge kind, at Module or Type
   * scope (subsystem_mcp_rules_spec.md's `NoCycles` rule kind). Returns
   * cycles of length ≥ 2; self-cycles suppressed.
   */
  findCycles(opts: { edge: EdgeKind; scope: 'module' | 'type'; pathPrefix?: string; limit?: number; confirmedOnly?: boolean; excludeTest?: boolean }): Promise<string[][]>;
  stats(): Promise<IndexStats>;
  /** Drop and recreate all tables (`pairs index --rebuild`). */
  reset(): Promise<void>;
  /**
   * Force-merge the WAL into the main index file. Kuzu's autoCheckpoint only
   * fires once the WAL crosses its threshold, and the store is never
   * explicitly closed (dispose() is a no-op — see dispose() below), so
   * without an explicit checkpoint the WAL can only ever grow across a
   * session. Cheap to call when there's nothing to merge.
   */
  checkpoint(): Promise<void>;
  dispose(): void;
}

/** Factory — the only place that knows Kuzu specifics. */
export interface CodeStoreFactory {
  /** @param dbPath absolute path to `.pairs/index/` (Kuzu database directory) */
  open(dbPath: string): Promise<CodeStore>;
}
