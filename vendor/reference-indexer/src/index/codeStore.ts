/**
 * Code index store contract. Backed by `node:sqlite` (same DatabaseSync driver
 * as core/sqliteStore.ts) in a SEPARATE `code-index.db` under workspace
 * storage — the index is derived data: rebuildable, never exported to the OKF
 * bundle, no event log / rewind.
 *
 * Schema (see docs/ArchSpec.md for the indexer design and storage outline):
 *
 *   files(id PK, path UNIQUE, lang, mtime_ms, size, hash, indexed_at)
 *   symbols(id PK, file_id FK→files CASCADE, name, qualified, kind, lang,
 *           start_line, end_line, signature, doc, parent_id FK→symbols, exported,
 *           complexity, cognitive)   -- v4: per-symbol metrics, INTEGER NOT NULL
 *   edges(from_id FK, to_id FK, kind, line, confidence,
 *         PK(from_id,to_id,kind,line))                  -- both FKs CASCADE
 *   pending_refs(file_id FK CASCADE, from_id, name, kind, line)
 *   pending_imports(file_id FK CASCADE, from_id, specifier, line) -- 'imports'
 *         edges are resolved by PATH (relative specifiers only), not name;
 *         unresolved ones (target file not yet indexed) retry here
 *   symbols_fts — contentless FTS5(name_terms, qualified, signature, doc),
 *                 rowid = symbols.id; name_terms is the camelCase/snake_case-
 *                 split name ('parseConfigFile' → 'parse config file')
 *   symbol_embeddings(symbol_id PK FK CASCADE, vector BLOB)  -- Float32, L2-normalized
 *
 * Invariants:
 *  - `applyExtraction` is transactional: delete-old-rows + insert-new must be
 *    atomic, and FTS rows must be kept in sync inside the same transaction.
 *  - Unresolvable refs go to pending_refs, never dropped: `resolvePending`
 *    retries them as new files arrive (a definition may index after its uses).
 *  - Schema versioning: the impl sets `PRAGMA user_version = <SCHEMA_VERSION>`
 *    on create. On open, a mismatched non-zero user_version means an old
 *    index: DROP everything and recreate (the index is rebuildable derived
 *    data — never write migration code for it). Bump SCHEMA_VERSION whenever
 *    the DDL changes (the v4 complexity columns are such a bump).
 */

import type {
  AmbiguousSymbol,
  CodeLang,
  CodeQuery,
  DeadCodeCandidate,
  DeadCodeFilter,
  EdgeConfidence,
  EdgeKind,
  EdgeRecord,
  FileDep,
  FileExtraction,
  FileRecord,
  HotspotQuery,
  IndexStats,
  ScoredSymbol,
  SimilarPair,
  SymbolKind,
  SymbolRecord,
} from './types';

export interface CodeStore {
  // -- Indexing (called by CodeIndexer) --------------------------------------
  /**
   * Replace all index rows for `extraction.path` in one transaction:
   * delete prior symbols (CASCADE cleans edges/embeddings/FTS), insert new
   * symbols + FTS rows, resolve refs it can (same-file scope first), park the
   * rest in pending_refs. Returns the stored file row.
   */
  applyExtraction(extraction: FileExtraction): Promise<FileRecord>;
  /** Remove a deleted file's rows entirely. No-op if unknown. */
  removeFile(path: string): Promise<void>;
  /**
   * Pass 2: retry pending_refs against the current symbol table using
   * (a) importing-module match, (b) unique-global-name match → 'resolved',
   * (c) multi-candidate name match → one 'fuzzy' edge per candidate.
   * Refs that still match nothing stay pending. Returns #edges created.
   * @param namesHint retry only refs whose name is in the hint (cheap
   *        incremental call after one file indexed); omit for a full pass.
   */
  resolvePending(namesHint?: string[]): Promise<number>;
  /** Known files with their hash/mtime — indexer diffs against disk on startup. */
  listFiles(): Promise<FileRecord[]>;

  // -- Symbol lookup ----------------------------------------------------------
  get(id: number): Promise<SymbolRecord | null>;
  /**
   * Resolve a user/agent-supplied name to symbols. Matches `qualified`
   * exactly first, then bare `name`. Multiple hits → AmbiguousSymbol (tools
   * render the candidate list and ask the agent to qualify).
   */
  lookup(nameOrQualified: string): Promise<SymbolRecord[] | AmbiguousSymbol>;
  /** All symbols of a file ordered by startLine, for code_outline. */
  outline(path: string): Promise<SymbolRecord[]>;
  /** Direct children of a symbol (method/field → containing class), ordered by startLine, for get_declaration. */
  membersOf(parentId: number): Promise<SymbolRecord[]>;

  // -- Search primitives (ranking/fusion lives in codeSearch.ts) --------------
  /** BM25 over symbols_fts with metadata filters. Scores are raw bm25() (lower=better). */
  ftsSearch(query: CodeQuery): Promise<Array<{ symbol: SymbolRecord; bm25: number }>>;

  // -- Graph queries -----------------------------------------------------------
  /** Edges pointing AT these symbols (who_calls direction='callers'). */
  edgesTo(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]>;
  /** Edges leaving these symbols (direction='callees'). */
  edgesFrom(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]>;

  // -- Embeddings (optional layer; same flag as memory embeddings) ------------
  setEmbedding(symbolId: number, vector: Float32Array): Promise<void>;
  /** Symbols lacking an embedding, oldest file first. */
  pendingEmbeddings(limit: number): Promise<SymbolRecord[]>;
  /**
   * Cosine top-k over symbol_embeddings against a query vector (brute-force
   * scan, same approach as the memory embedding index).
   */
  semanticSearch(vector: Float32Array, limit: number): Promise<Array<{ symbol: SymbolRecord; cosine: number }>>;

  // -- Analysis (v4 tools; see docs/ArchSpec.md for the indexer analysis notes) --
  /**
   * Symbols with ZERO incoming edges of any kind (`LEFT JOIN edges ON to_id`,
   * to_id IS NULL). Exclusions the impl must apply:
   *  - kind 'module' (files are entry points, not dead code)
   *  - names in ENTRY_POINT_NAMES (a small denylist const in the impl:
   *    'main', 'activate', 'deactivate', constructors — language ctor names —
   *    plus names starting with 'test'/'Test')
   *  - files matching common test-path patterns ('.test.', '.spec.', '_test.',
   *    '/tests/', '/__tests__/')
   *  - exported symbols unless filter.includeExported (then returned with
   *    note='exported')
   * Ordered by file path then startLine. Applies pathPrefix/kinds/limit.
   */
  unreferenced(filter: DeadCodeFilter): Promise<DeadCodeCandidate[]>;
  /**
   * File-level dependency query over `imports` edges joined through
   * symbols.file_id → DISTINCT files.
   *  - direction 'imports': files this file imports (edges FROM its symbols)
   *  - direction 'importers': files that import this file (edges TO its symbols)
   * transitive=true walks up to `maxDepth` (default 5) hops breadth-first,
   * de-duplicating; each FileDep carries its depth. Unknown path → [].
   */
  fileEdges(
    path: string,
    direction: 'imports' | 'importers',
    opts?: { transitive?: boolean; maxDepth?: number; limit?: number }
  ): Promise<FileDep[]>;
  /**
   * Near-duplicate symbol pairs by cosine over symbol_embeddings, restricted
   * to kinds function|method. Brute-force pairwise scan batched with the same
   * approach as semanticSearch; O(n²) on embedded function count — the impl
   * must cap the scan (e.g. skip when > 5000 embedded functions and signal
   * that in the result) to protect low-end hardware. Pairs are unique
   * (a.id < b.id), sorted by similarity desc, cut at minCosine and limit.
   */
  similarPairs(
    minCosine: number,
    opts?: { pathPrefix?: string; kinds?: SymbolKind[]; limit?: number; offset?: number }
  ): Promise<SimilarPair[]>;
  /**
   * Top-N symbols by complexity metric (see HotspotQuery). Only kinds with
   * meaningful counts (function|method); ordered by the chosen metric desc,
   * ties by file/startLine.
   */
  hotspots(query: HotspotQuery): Promise<SymbolRecord[]>;
  /**
   * Symbols in TEST files (see isTestPath in types.ts) whose call/reference
   * edges reach any of `ids`, up to `depth` hops walking callers-of-callers
   * (a test usually calls a helper that calls the target). Returns one entry
   * per (test symbol, target) pair found.
   */
  testsReferencing(
    ids: number[],
    opts?: { depth?: number; includeFuzzy?: boolean }
  ): Promise<Array<{ test: SymbolRecord; target: SymbolRecord; depth: number; confidence: EdgeConfidence }>>;
  /**
   * Exported non-test symbols (kinds function|method by default) with no
   * incoming edge from a test-file symbol at depth 1 (direct callers only —
   * see find_untested's tool description for this caveat). Mirrors
   * unreferenced()'s entry-point/test-path exclusions.
   */
  untested(filter: {
    pathPrefix?: string;
    excludePath?: string;
    kinds?: SymbolKind[];
    langs?: CodeLang[];
    limit?: number;
    offset?: number;
  }): Promise<SymbolRecord[]>;

  /**
   * Detect circular import dependencies using Tarjan's SCC algorithm over
   * the file-level import graph. Returns cycles of length ≥ 2 (self-imports
   * are suppressed). Each cycle lists files in the order they form the cycle.
   */
  findCycles(opts?: { pathPrefix?: string; limit?: number }): Promise<string[][]>;
  stats(): Promise<IndexStats>;
  /** Drop and recreate all tables (user command "rebuild code index"). */
  reset(): Promise<void>;
  dispose(): void;
}

/** Factory — the only place that knows SQLite specifics (mirrors MemoryStoreFactory). */
export interface CodeStoreFactory {
  /** @param dbPath absolute path to code-index.db inside workspace storage */
  open(dbPath: string): Promise<CodeStore>;
}

/** Re-exported for executor rendering without a types import. */
export type { ScoredSymbol };
