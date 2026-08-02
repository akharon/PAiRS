/**
 * SQLite DDL for the derived code graph.
 *
 * Two deliberate departures from the previous Kuzu schema:
 *
 *  1. **One `Edge` table, not thirteen.** Kuzu needed a REL TABLE per edge
 *     kind; that cost ~2 MB of page allocation on first write to *each*, which
 *     is why a 50 KB graph occupied a 50 MB file. Here `kind` is a column, so
 *     an unused edge kind costs nothing and the whole index is ~0.3 MB.
 *  2. **No PendingRef id counter.** SQLite hands out rowids, so the
 *     `next_id`/`next_pending_id` Meta counters Kuzu forced on us are gone —
 *     ids come from `INTEGER PRIMARY KEY` / `last_insert_rowid()`.
 *
 * Schema versioning is unchanged in spirit: a mismatched SCHEMA_VERSION means
 * an old index — drop and recreate. The index is derived data, never migrated.
 */

export const SCHEMA_VERSION = 4;

export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS File(
     id INTEGER PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     lang TEXT,
     mtimeMs REAL,
     size INTEGER,
     hash TEXT,
     indexedAt INTEGER,
     crate TEXT,
     parseError INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS Symbol(
     id INTEGER PRIMARY KEY,
     fileId INTEGER NOT NULL REFERENCES File(id) ON DELETE CASCADE,
     file TEXT NOT NULL,
     name TEXT NOT NULL,
     qualified TEXT,
     kind TEXT,
     lang TEXT,
     startLine INTEGER,
     endLine INTEGER,
     signature TEXT,
     doc TEXT,
     parentId INTEGER,
     exported INTEGER DEFAULT 0
   )`,
  /**
   * All edge kinds in one table. `src`/`dst` are Symbol ids except for
   * DECLARES, whose src is a File id (it is the one File→Symbol edge; kept
   * here rather than in its own table so the edge model stays single).
   */
  `CREATE TABLE IF NOT EXISTS Edge(
     src INTEGER NOT NULL,
     dst INTEGER NOT NULL,
     kind TEXT NOT NULL,
     line INTEGER DEFAULT 0,
     confidence TEXT DEFAULT 'resolved',
     test INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS PendingRef(
     id INTEGER PRIMARY KEY,
     fileId INTEGER NOT NULL REFERENCES File(id) ON DELETE CASCADE,
     fromSymbolId INTEGER NOT NULL,
     name TEXT NOT NULL,
     qualifiedName TEXT DEFAULT '',
     kind TEXT NOT NULL,
     line INTEGER DEFAULT 0,
     methodCall INTEGER DEFAULT 0,
     inTest INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS Meta(key TEXT PRIMARY KEY, value TEXT)`,
];

/**
 * Created after the bulk insert, not before: building indexes once at the end
 * of a full index beats maintaining them across every row insert.
 */
export const SCHEMA_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_symbol_file ON Symbol(file)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_fileId ON Symbol(fileId)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_name ON Symbol(name)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_qualified ON Symbol(qualified)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_parent ON Symbol(parentId)`,
  `CREATE INDEX IF NOT EXISTS idx_edge_src ON Edge(src, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_edge_dst ON Edge(dst, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_edge_kind ON Edge(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_file ON PendingRef(fileId)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_name ON PendingRef(name)`,
];

/** Reference (Pass 2) edge kinds — carry line/confidence/test. */
export const REFERENCE_EDGE_KINDS: readonly string[] = ['CALLS', 'READS', 'WRITES', 'DEPENDS_ON', 'IMPLEMENTS', 'EXTENDS', 'REFERENCES', 'IMPORTS'];
/** Structural (Pass 1) edge kinds — always resolved. */
export const STRUCTURAL_EDGE_KINDS: readonly string[] = ['DECLARES', 'OWNS', 'PARAM', 'OF_TYPE', 'RETURNS'];

export const ALL_TABLES: readonly string[] = ['Edge', 'PendingRef', 'Symbol', 'File', 'Meta'];
