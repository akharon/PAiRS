/**
 * CodeStore implementation over node:sqlite. Lives in a separate
 * code-index.db (see codeStore.ts header for full rationale/DDL).
 */

import * as path from 'node:path';
import { DatabaseSync } from '../core/sqliteStore';
import { splitIdentifier } from './extractors';
import type { CodeStore, CodeStoreFactory } from './codeStore';
import { isTestPath } from './types';
import { SqliteIndexProvenanceService } from './provenanceImpl';
import type { IndexProvenanceService } from './provenance';
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
  SimilarPair,
  SymbolKind,
  SymbolRecord,
} from './types';

interface FileRow {
  id: number;
  path: string;
  lang: string;
  mtime_ms: number;
  size: number;
  hash: string;
  indexed_at: number;
}

interface SymbolRow {
  id: number;
  file_id: number;
  file_path: string;
  name: string;
  qualified: string;
  kind: string;
  lang: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc: string | null;
  parent_id: number | null;
  exported: number;
  complexity: number;
  cognitive: number;
}

function fileRowToRecord(r: FileRow): FileRecord {
  return {
    id: r.id,
    path: r.path,
    lang: r.lang as CodeLang,
    mtimeMs: r.mtime_ms,
    size: r.size,
    hash: r.hash,
    indexedAt: r.indexed_at,
  };
}

function symbolRowToRecord(r: SymbolRow): SymbolRecord {
  return {
    id: r.id,
    fileId: r.file_id,
    file: r.file_path,
    name: r.name,
    qualified: r.qualified,
    kind: r.kind as SymbolKind,
    lang: r.lang as CodeLang,
    startLine: r.start_line,
    endLine: r.end_line,
    signature: r.signature,
    doc: r.doc,
    parentId: r.parent_id,
    exported: !!r.exported,
    complexity: r.complexity,
    cognitive: r.cognitive,
  };
}

function float32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToFloat32(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are stored L2-normalized, so dot product == cosine
}

/** Bump on any DDL change — the store drops and rebuilds on mismatch. */
const SCHEMA_VERSION = 3; // v3: pending_imports (applyExtraction never created `imports` edges before)

/** Names that are entry points / framework hooks, never real dead code. */
const ENTRY_POINT_NAMES: readonly string[] = ['main', 'activate', 'deactivate', 'constructor', '__init__'];

/** LIKE patterns (SQLite %) identifying test files, excluded from find_dead_code. */
const TEST_PATH_PATTERNS: readonly string[] = ['%.test.%', '%.spec.%', '%_test.%', '%/tests/%', '%/__tests__/%'];

/**
 * Names that should never be parked as pending refs — test-framework globals,
 * JS built-in prototype methods, and Node.js globals. These are injected by
 * the runtime or test runner and will never resolve to a workspace symbol.
 * Parking them wastes storage and makes resolvePending() scan O(n) rows that
 * can never produce an edge.
 */
const UNRESOLVABLE_REF_NAMES: ReadonlySet<string> = new Set([
  // Test framework globals (Jest / Vitest / Mocha)
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'jest', 'vi', 'suite', 'bench', 'xdescribe', 'xit', 'xtest', 'fit', 'fdescribe',
  // Test matchers
  'toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toHaveLength', 'toHaveProperty',
  'toBeGreaterThan', 'toBeLessThan', 'toBeGreaterThanOrEqual', 'toBeLessThanOrEqual',
  'toThrow', 'toMatch', 'toMatchObject', 'toHaveBeenCalled', 'toHaveBeenCalledWith',
  'toHaveBeenCalledTimes', 'toHaveReturned', 'toBeDefined', 'toBeUndefined',
  'toBeNull', 'toBeTruthy', 'toBeFalsy', 'toBeInstanceOf', 'toMatchInlineSnapshot',
  'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot',
  'not', 'resolves', 'rejects',
  // JS built-in prototype methods (commonly referenced in source code)
  'push', 'pop', 'shift', 'unshift', 'map', 'filter', 'reduce', 'forEach',
  'find', 'findIndex', 'join', 'split', 'slice', 'splice', 'concat',
  'includes', 'indexOf', 'lastIndexOf', 'sort', 'reverse', 'flat', 'flatMap',
  'keys', 'values', 'entries', 'has', 'get', 'set', 'delete', 'size',
  'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'match', 'matchAll',
  'search', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase',
  'toString', 'valueOf', 'then', 'catch', 'finally', 'bind', 'call', 'apply',
  // Node.js / CommonJS globals
  'require', 'module', 'exports', '__dirname', '__filename',
  'console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask',
  'global', 'globalThis',
  // Common assertion library functions
  'assert', 'ok', 'equal', 'deepEqual', 'notEqual', 'strictEqual',
  'deepStrictEqual', 'throws', 'doesNotThrow', 'rejects',
  // Test utility / mocking
  'fn', 'spyOn', 'mock', 'mocked',
  // Common Node.js built-in module members
  'readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync', 'readdirSync',
  'statSync', 'unlinkSync', 'rmSync', 'createReadStream', 'createWriteStream',
  'resolve', 'dirname', 'basename', 'extname', 'format', 'parse',
]);

/** Cap on embedded function/method count for the O(n²) similarPairs scan. */
const MAX_SIMILAR_PAIRS_SCAN = 5000;

/** Extensions tried (in order) when a relative import specifier omits one. */
const IMPORT_EXTENSIONS: readonly string[] = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts', '.py', '.java', '.cpp', '.cc', '.h', '.hpp'];

/** Extensions for index-file resolution: `./foo` → `./foo/index.ts` etc. */
const INDEX_EXTENSIONS: readonly string[] = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts', 'cjs', 'cts'];

/**
 * Candidate workspace-relative paths for a relative import specifier
 * ('./foo', '../bar/baz'), tried in order against the files table. Only
 * called for specifiers starting with '.' — bare module names have no
 * candidate (see resolveImportTarget).
 */
function candidateImportPaths(fromPath: string, specifier: string): string[] {
  const dir = path.posix.dirname(fromPath.split(path.sep).join('/'));
  const base = path.posix.normalize(path.posix.join(dir, specifier));
  const candidates: string[] = [];
  for (const ext of IMPORT_EXTENSIONS) candidates.push(base + ext);
  for (const ext of INDEX_EXTENSIONS) candidates.push(path.posix.join(base, `index.${ext}`));
  return candidates;
}

export class SqliteCodeStore implements CodeStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrate();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    // Versioned derived data: on schema change we drop and rebuild rather
    // than migrate (the indexer repopulates from source on next scan).
    const row = this.db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    if (row.user_version !== 0 && row.user_version !== SCHEMA_VERSION) {
      this.dropAll();
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id        INTEGER PRIMARY KEY,
        path      TEXT NOT NULL UNIQUE,
        lang      TEXT NOT NULL,
        mtime_ms  INTEGER NOT NULL,
        size      INTEGER NOT NULL,
        hash      TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id         INTEGER PRIMARY KEY,
        file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        qualified  TEXT NOT NULL,
        kind       TEXT NOT NULL,
        lang       TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        signature  TEXT,
        doc        TEXT,
        parent_id  INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
        exported   INTEGER NOT NULL DEFAULT 0,
        complexity INTEGER NOT NULL DEFAULT 1,
        cognitive  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

      CREATE TABLE IF NOT EXISTS edges (
        from_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        to_id      INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        line       INTEGER NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'resolved',
        PRIMARY KEY (from_id, to_id, kind, line)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, kind);

      CREATE TABLE IF NOT EXISTS pending_refs (
        file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        from_id   INTEGER NOT NULL,
        name      TEXT NOT NULL,
        kind      TEXT NOT NULL,
        line      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_name ON pending_refs(name);

      CREATE TABLE IF NOT EXISTS pending_imports (
        file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        from_id   INTEGER NOT NULL,
        specifier TEXT NOT NULL,
        line      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_imports_specifier ON pending_imports(specifier);

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name_terms, qualified, signature, doc, content=''
      );

      CREATE TABLE IF NOT EXISTS symbol_embeddings (
        symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        vector    BLOB NOT NULL
      );
    `);
    // Provenance tables (docs/MemoryIndexSynergy.md §F1) — additive, NOT
    // versioned with SCHEMA_VERSION/dropAll: generation history must survive
    // a derived-data rebuild (schema-version bump) so "index @ <sha>" stays
    // meaningful across upgrades.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha   TEXT,
        branch       TEXT,
        dirty_paths  TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        completed_at INTEGER,
        tool_version TEXT NOT NULL
      );
    `);
  }

  // -- Indexing ---------------------------------------------------------------

  async applyExtraction(extraction: FileExtraction): Promise<FileRecord> {
    return this.transaction(() => {
      const now = Date.now();
      const existing = this.db.prepare(`SELECT id FROM files WHERE path = ?`).get(extraction.path) as
        | { id: number }
        | undefined;

      let fileId: number;
      if (existing) {
        fileId = existing.id;
        // CASCADE removes symbols -> edges/embeddings/pending_refs (but NOT
        // symbols_fts — virtual tables don't participate in FK cascades).
        this.db.prepare(`DELETE FROM symbols WHERE file_id = ?`).run(fileId);
        this.deleteFtsForFile(fileId);
        this.db.prepare(`DELETE FROM pending_refs WHERE file_id = ?`).run(fileId);
        this.db.prepare(`DELETE FROM pending_imports WHERE file_id = ?`).run(fileId);
        this.db
          .prepare(`UPDATE files SET lang=?, mtime_ms=?, size=?, hash=?, indexed_at=? WHERE id=?`)
          .run(extraction.lang, extraction.mtimeMs, extraction.size, extraction.hash, now, fileId);
      } else {
        const info = this.db
          .prepare(`INSERT INTO files (path, lang, mtime_ms, size, hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(extraction.path, extraction.lang, extraction.mtimeMs, extraction.size, extraction.hash, now);
        fileId = Number(info.lastInsertRowid);
      }

      // Insert symbols in extraction order (module symbol first at index 0),
      // remapping parentIndex -> real symbol id as we go so children can
      // reference already-inserted parents.
      const indexToId: number[] = [];
      const insertSym = this.db.prepare(
        `INSERT INTO symbols
           (file_id, name, qualified, kind, lang, start_line, end_line, signature, doc, parent_id, exported, complexity, cognitive)
         VALUES (@file_id, @name, @qualified, @kind, @lang, @start_line, @end_line, @signature, @doc, @parent_id, @exported, @complexity, @cognitive)`
      );
      const insertFts = this.db.prepare(
        `INSERT INTO symbols_fts (rowid, name_terms, qualified, signature, doc) VALUES (?, ?, ?, ?, ?)`
      );

      for (const sym of extraction.symbols) {
        const parentId = sym.parentIndex !== null ? indexToId[sym.parentIndex]! : null;
        const info = insertSym.run({
          file_id: fileId,
          name: sym.name,
          qualified: sym.qualified,
          kind: sym.kind,
          lang: sym.lang,
          start_line: sym.startLine,
          end_line: sym.endLine,
          signature: sym.signature,
          doc: sym.doc,
          parent_id: parentId,
          exported: sym.exported ? 1 : 0,
          complexity: sym.complexity,
          cognitive: sym.cognitive,
        });
        const id = Number(info.lastInsertRowid);
        indexToId.push(id);
        insertFts.run(id, splitIdentifier(sym.name), sym.qualified, sym.signature ?? '', sym.doc ?? '');
      }

      // Pass-2, phase A: try resolving each ref immediately against symbols
      // already known globally (cheap same-transaction attempt); anything
      // left unresolved is parked in pending_refs for the indexer to retry
      // via resolvePending() once more files have landed.
      // Collect relative import specifiers first so resolveOneRef can use
      // them to disambiguate multi-candidate name matches.
      const relativeImportSpecs = extraction.imports
        .filter((imp) => imp.specifier.startsWith('.'))
        .map((imp) => imp.specifier);
      const insertPending = this.db.prepare(
        `INSERT INTO pending_refs (file_id, from_id, name, kind, line) VALUES (?, ?, ?, ?, ?)`
      );
      for (const ref of extraction.refs) {
        const fromId = indexToId[ref.fromIndex]!;
        const resolved = this.resolveOneRef(ref.name, {
          fromPath: extraction.path,
          importSpecifiers: relativeImportSpecs,
        });
        if (resolved === 'unresolved') {
          // Never park names that can never resolve — test globals, JS
          // built-ins, Node.js globals. They would sit in pending_refs
          // forever, wasting storage and slowing resolvePending().
          if (!UNRESOLVABLE_REF_NAMES.has(ref.name)) {
            insertPending.run(fileId, fromId, ref.name, ref.kind, ref.line);
          }
        } else {
          this.insertEdgesIgnoreDup(fromId, resolved.ids, ref.kind, ref.line, resolved.confidence);
        }
      }

      // Imports: resolved by path (relative specifiers only — bare module
      // names/packages/system headers have no workspace file to point at and
      // are silently skipped, not parked). The edge is file-to-file, attached
      // to each file's module symbol (index 0 of that file's symbols).
      const moduleSymbolId = indexToId[0]!;
      const insertPendingImport = this.db.prepare(
        `INSERT INTO pending_imports (file_id, from_id, specifier, line) VALUES (?, ?, ?, ?)`
      );
      for (const imp of extraction.imports) {
        const targetModuleId = this.resolveImportTarget(extraction.path, imp.specifier);
        if (targetModuleId !== null) {
          this.insertEdgesIgnoreDup(moduleSymbolId, [targetModuleId], 'imports', imp.line, 'resolved');
        } else if (imp.specifier.startsWith('.')) {
          // Relative specifier whose target file hasn't indexed yet — retry
          // via resolvePending() once more files land.
          insertPendingImport.run(fileId, moduleSymbolId, imp.specifier, imp.line);
        }
      }

      const fileRow = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(fileId) as unknown as FileRow;
      return fileRowToRecord(fileRow);
    });
  }

  async removeFile(path: string): Promise<void> {
    this.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM files WHERE path = ?`).get(path) as { id: number } | undefined;
      if (!row) return;
      this.deleteFtsForFile(row.id);
      this.db.prepare(`DELETE FROM files WHERE id = ?`).run(row.id); // CASCADE handles the rest
    });
  }

  /** Resolve a bare/qualified name to symbol ids by exact qualified match,
   * then unique bare-name match. When there are multiple bare-name candidates,
   * narrows by import context: if the referencing file imports from specific
   * files, prefer candidates from those imported files. Returns 'unresolved'
   * when nothing matches. */
  private resolveOneRef(
    name: string,
    opts?: { fromPath?: string; importSpecifiers?: string[] }
  ): { ids: number[]; confidence: 'resolved' | 'fuzzy' } | 'unresolved' {
    const byQualified = this.db.prepare(`SELECT id FROM symbols WHERE qualified = ?`).all(name) as Array<{
      id: number;
    }>;
    if (byQualified.length === 1) return { ids: [byQualified[0]!.id], confidence: 'resolved' };
    if (byQualified.length > 1) return { ids: byQualified.map((r) => r.id), confidence: 'fuzzy' };

    const byName = this.db
      .prepare(`SELECT id, file_id FROM symbols WHERE name = ? AND kind != 'module'`)
      .all(name) as Array<{ id: number; file_id: number }>;
    if (byName.length === 0) return 'unresolved';
    if (byName.length === 1) return { ids: [byName[0]!.id], confidence: 'resolved' };

    // Multiple candidates — try to disambiguate using import context.
    // For each relative import specifier, resolve the target file and check
    // if any candidate lives in that file. If exactly one candidate is from
    // an imported file, treat it as resolved; otherwise all are fuzzy.
    if (opts?.fromPath && opts.importSpecifiers?.length) {
      const importedFileIds = new Set<number>();
      for (const spec of opts.importSpecifiers) {
        if (!spec.startsWith('.')) continue;
        for (const candidate of candidateImportPaths(opts.fromPath, spec)) {
          const f = this.db.prepare(`SELECT id FROM files WHERE path = ?`).get(candidate) as
            | { id: number }
            | undefined;
          if (f) importedFileIds.add(f.id);
        }
      }
      if (importedFileIds.size > 0) {
        const importedMatches = byName.filter((c) => importedFileIds.has(c.file_id));
        if (importedMatches.length === 1) {
          return { ids: [importedMatches[0]!.id], confidence: 'resolved' };
        }
      }
    }

    return { ids: byName.map((r) => r.id), confidence: 'fuzzy' };
  }

  /**
   * Resolve a relative import specifier to the target file's module symbol
   * id. Bare/package/system-header specifiers (no leading '.') never
   * resolve — there's no workspace file to point at. Returns null when the
   * target file isn't indexed (yet).
   */
  private resolveImportTarget(fromPath: string, specifier: string): number | null {
    if (!specifier.startsWith('.')) return null;
    for (const candidate of candidateImportPaths(fromPath, specifier)) {
      const fileRow = this.db.prepare(`SELECT id FROM files WHERE path = ?`).get(candidate) as
        | { id: number }
        | undefined;
      if (!fileRow) continue;
      const moduleRow = this.db
        .prepare(`SELECT id FROM symbols WHERE file_id = ? AND kind = 'module'`)
        .get(fileRow.id) as { id: number } | undefined;
      if (moduleRow) return moduleRow.id;
    }
    return null;
  }

  private insertEdgesIgnoreDup(
    fromId: number,
    toIds: number[],
    kind: EdgeKind,
    line: number,
    confidence: 'resolved' | 'fuzzy'
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO edges (from_id, to_id, kind, line, confidence) VALUES (?, ?, ?, ?, ?)`
    );
    for (const toId of toIds) {
      if (toId === fromId) continue; // skip self-edges (e.g. recursive calls resolved to own symbol)
      stmt.run(fromId, toId, kind, line, confidence);
    }
  }

  async resolvePending(namesHint?: string[]): Promise<number> {
    return this.transaction(() => {
      const rows = (
        namesHint?.length
          ? this.db
              .prepare(`SELECT rowid, * FROM pending_refs WHERE name IN (${namesHint.map(() => '?').join(',')})`)
              .all(...namesHint)
          : this.db.prepare(`SELECT rowid, * FROM pending_refs`).all()
      ) as Array<{ rowid: number; file_id: number; from_id: number; name: string; kind: string; line: number }>;

      // Pre-compute import specifiers per file so resolveOneRef can
      // disambiguate multi-candidate name matches using import context.
      const fileImportSpecs = new Map<number, string[]>();
      const getImportSpecs = (fileId: number): string[] => {
        if (fileImportSpecs.has(fileId)) return fileImportSpecs.get(fileId)!;
        // Resolved imports: edges from the file's module symbol.
        const moduleSym = this.db
          .prepare(`SELECT id FROM symbols WHERE file_id = ? AND kind = 'module'`)
          .get(fileId) as { id: number } | undefined;
        const specs: string[] = [];
        if (moduleSym) {
          const importEdges = this.db
            .prepare(`SELECT to_id FROM edges WHERE from_id = ? AND kind = 'imports'`)
            .all(moduleSym.id) as Array<{ to_id: number }>;
          for (const e of importEdges) {
            const targetSym = this.db
              .prepare(`SELECT file_id FROM symbols WHERE id = ?`)
              .get(e.to_id) as { file_id: number } | undefined;
            if (targetSym) {
              const targetPath = (
                this.db.prepare(`SELECT path FROM files WHERE id = ?`).get(targetSym.file_id) as
                  | { path: string }
                  | undefined
              )?.path;
              if (targetPath) specs.push(targetPath);
            }
          }
        }
        // Pending imports: still-unresolved specifiers.
        const pendingImports = this.db
          .prepare(`SELECT specifier FROM pending_imports WHERE file_id = ?`)
          .all(fileId) as Array<{ specifier: string }>;
        for (const pi of pendingImports) specs.push(pi.specifier);
        fileImportSpecs.set(fileId, specs);
        return specs;
      };

      let created = 0;
      const deleteResolved = this.db.prepare(`DELETE FROM pending_refs WHERE rowid = ?`);
      for (const row of rows) {
        // Clean up refs that can never resolve (test globals, JS built-ins,
        // Node.js globals) — these may have been parked before the
        // UNRESOLVABLE_REF_NAMES filter was added to applyExtraction.
        if (UNRESOLVABLE_REF_NAMES.has(row.name)) {
          deleteResolved.run(row.rowid);
          continue;
        }
        const filePath = (
          this.db.prepare(`SELECT path FROM files WHERE id = ?`).get(row.file_id) as
            | { path: string }
            | undefined
        )?.path;
        const resolved = this.resolveOneRef(row.name, {
          fromPath: filePath,
          importSpecifiers: getImportSpecs(row.file_id),
        });
        if (resolved === 'unresolved') continue;
        this.insertEdgesIgnoreDup(row.from_id, resolved.ids, row.kind as EdgeKind, row.line, resolved.confidence);
        deleteResolved.run(row.rowid);
        created += resolved.ids.length;
      }

      // Pending imports don't have a useful namesHint (they key on file
      // paths, not symbol names), so retry all of them on every call — the
      // set is one row per unresolved relative import, small in practice.
      const importRows = this.db.prepare(`SELECT rowid, * FROM pending_imports`).all() as Array<{
        rowid: number;
        file_id: number;
        from_id: number;
        specifier: string;
        line: number;
      }>;
      const deleteResolvedImport = this.db.prepare(`DELETE FROM pending_imports WHERE rowid = ?`);
      for (const row of importRows) {
        const fromPath = (this.db.prepare(`SELECT path FROM files WHERE id = ?`).get(row.file_id) as
          | { path: string }
          | undefined)?.path;
        if (!fromPath) {
          deleteResolvedImport.run(row.rowid); // orphaned (file removed)
          continue;
        }
        const targetModuleId = this.resolveImportTarget(fromPath, row.specifier);
        if (targetModuleId === null) continue;
        this.insertEdgesIgnoreDup(row.from_id, [targetModuleId], 'imports', row.line, 'resolved');
        deleteResolvedImport.run(row.rowid);
        created += 1;
      }

      return created;
    });
  }

  async listFiles(): Promise<FileRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM files`).all() as unknown as FileRow[];
    return rows.map(fileRowToRecord);
  }

  private deleteFtsForFile(fileId: number): void {
    const ids = this.db.prepare(`SELECT id FROM symbols WHERE file_id = ?`).all(fileId) as Array<{ id: number }>;
    const del = this.db.prepare(
      `INSERT INTO symbols_fts (rowid, name_terms, qualified, signature, doc) VALUES (?, '', '', '', '')`
    );
    for (const { id } of ids) del.run(id);
  }

  // -- Symbol lookup ------------------------------------------------------------

  async get(id: number): Promise<SymbolRecord | null> {
    const row = this.getSymbolRow(id);
    return row ? symbolRowToRecord(row) : null;
  }

  private getSymbolRow(id: number): SymbolRow | undefined {
    return this.db
      .prepare(
        `SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
      )
      .get(id) as SymbolRow | undefined;
  }

  async lookup(nameOrQualified: string): Promise<SymbolRecord[] | AmbiguousSymbol> {
    const byQualified = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.qualified = ? AND s.kind != 'module'`
      )
      .all(nameOrQualified) as unknown as SymbolRow[];
    const candidates =
      byQualified.length > 0
        ? byQualified
        : (this.db
            .prepare(
              `SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON f.id = s.file_id
               WHERE s.name = ? AND s.kind != 'module'`
            )
            .all(nameOrQualified) as unknown as SymbolRow[]);

    if (candidates.length === 0) return [];
    if (candidates.length === 1) return [symbolRowToRecord(candidates[0]!)];
    return { ambiguous: true, candidates: candidates.map(symbolRowToRecord) };
  }

  async outline(path: string): Promise<SymbolRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ? AND s.kind != 'module' ORDER BY s.start_line ASC`
      )
      .all(path) as unknown as SymbolRow[];
    return rows.map(symbolRowToRecord);
  }

  async membersOf(parentId: number): Promise<SymbolRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.parent_id = ? ORDER BY s.start_line ASC`
      )
      .all(parentId) as unknown as SymbolRow[];
    return rows.map(symbolRowToRecord);
  }

  // -- Search -------------------------------------------------------------------

  async ftsSearch(query: CodeQuery): Promise<Array<{ symbol: SymbolRecord; bm25: number }>> {
    const match = escapeFtsQuery(query.text);
    if (!match) return [];

    const filters: string[] = [];
    const params: unknown[] = [match];
    if (query.kinds?.length) {
      filters.push(`s.kind IN (${query.kinds.map(() => '?').join(',')})`);
      params.push(...query.kinds);
    }
    if (query.langs?.length) {
      filters.push(`s.lang IN (${query.langs.map(() => '?').join(',')})`);
      params.push(...query.langs);
    }
    if (query.pathPrefix) {
      filters.push(`f.path LIKE ?`);
      params.push(`${query.pathPrefix}%`);
    }
    if (query.excludePath) {
      filters.push(`f.path NOT LIKE ?`);
      params.push(`${query.excludePath}%`);
    }
    if (query.exportedOnly) filters.push(`s.exported = 1`);
    filters.push(`s.kind != 'module'`);

    const sql = `
      SELECT s.*, f.path AS file_path, bm25(symbols_fts) AS rank
      FROM symbols_fts
      JOIN symbols s ON s.id = symbols_fts.rowid
      JOIN files f ON f.id = s.file_id
      WHERE symbols_fts MATCH ? ${filters.length ? 'AND ' + filters.join(' AND ') : ''}
      ORDER BY rank
      LIMIT ${Math.min(Math.max((query.limit ?? 10) + (query.offset ?? 0), 50), 200)}
    `;
    const rows = this.db.prepare(sql).all(...(params as never[])) as unknown as Array<SymbolRow & { rank: number }>;
    return rows.map((r) => ({ symbol: symbolRowToRecord(r), bm25: r.rank }));
  }

  // -- Graph ----------------------------------------------------------------------

  async edgesTo(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]> {
    if (!ids.length || !kinds.length) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM edges WHERE to_id IN (${ids.map(() => '?').join(',')}) AND kind IN (${kinds
          .map(() => '?')
          .join(',')})`
      )
      .all(...ids, ...kinds) as Array<{ from_id: number; to_id: number; kind: string; line: number; confidence: string }>;
    return rows.map(edgeRowToRecord);
  }

  async edgesFrom(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]> {
    if (!ids.length || !kinds.length) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM edges WHERE from_id IN (${ids.map(() => '?').join(',')}) AND kind IN (${kinds
          .map(() => '?')
          .join(',')})`
      )
      .all(...ids, ...kinds) as Array<{ from_id: number; to_id: number; kind: string; line: number; confidence: string }>;
    return rows.map(edgeRowToRecord);
  }

  // -- Embeddings -------------------------------------------------------------------

  async setEmbedding(symbolId: number, vector: Float32Array): Promise<void> {
    this.db
      .prepare(`INSERT OR REPLACE INTO symbol_embeddings (symbol_id, vector) VALUES (?, ?)`)
      .run(symbolId, float32ToBuffer(vector));
  }

  async pendingEmbeddings(limit: number): Promise<SymbolRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path FROM symbols s
         JOIN files f ON f.id = s.file_id
         LEFT JOIN symbol_embeddings e ON e.symbol_id = s.id
         WHERE e.symbol_id IS NULL AND s.kind != 'module'
         ORDER BY f.indexed_at ASC
         LIMIT ?`
      )
      .all(limit) as unknown as SymbolRow[];
    return rows.map(symbolRowToRecord);
  }

  async semanticSearch(vector: Float32Array, limit: number): Promise<Array<{ symbol: SymbolRecord; cosine: number }>> {
    // Brute-force scan (same approach as the memory embedding index) — fine
    // at the symbol-card scale (thousands, not millions) this index targets.
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path, e.vector AS vector
         FROM symbol_embeddings e
         JOIN symbols s ON s.id = e.symbol_id
         JOIN files f ON f.id = s.file_id`
      )
      .all() as unknown as Array<SymbolRow & { vector: Buffer }>;
    const scored = rows.map((r) => ({
      symbol: symbolRowToRecord(r),
      cosine: cosine(vector, bufferToFloat32(r.vector)),
    }));
    scored.sort((a, b) => b.cosine - a.cosine);
    return scored.slice(0, limit);
  }

  async findCycles(opts?: { pathPrefix?: string; limit?: number }): Promise<string[][]> {
    // Build the file-level import graph: for each file, collect the files it imports.
    const fileRows = this.db.prepare(`SELECT id, path FROM files ORDER BY path`).all() as Array<{
      id: number;
      path: string;
    }>;
    if (fileRows.length === 0) return [];

    const fileById = new Map(fileRows.map((r) => [r.id, r.path]));
    const pathPrefix = opts?.pathPrefix;
    const maxCycles = opts?.limit ?? 20;

    // Pre-filter: only IDs we want to scan
    const allIds = pathPrefix
      ? fileRows.filter((r) => r.path.startsWith(pathPrefix)).map((r) => r.id)
      : fileRows.map((r) => r.id);
    const idSet = new Set(allIds);
    if (allIds.length === 0) return [];

    // Build adjacency: for each file, which OTHER files does it import?
    const adj = new Map<number, number[]>();
    const importEdges = this.db
      .prepare(
        `SELECT DISTINCT s1.file_id AS from_file, s2.file_id AS to_file
         FROM edges ed
         JOIN symbols s1 ON s1.id = ed.from_id
         JOIN symbols s2 ON s2.id = ed.to_id
         WHERE ed.kind = 'imports'`
      )
      .all() as Array<{ from_file: number; to_file: number }>;

    for (const { from_file, to_file } of importEdges) {
      if (!idSet.has(from_file) || !idSet.has(to_file)) continue;
      if (from_file === to_file) continue; // skip self-imports
      if (!adj.has(from_file)) adj.set(from_file, []);
      adj.get(from_file)!.push(to_file);
    }

    // Tarjan SCC
    const index = new Map<number, number>();
    const lowlink = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];
    const cycles: number[][] = [];
    let currentIndex = 0;

    const strongconnect = (v: number) => {
      index.set(v, currentIndex);
      lowlink.set(v, currentIndex);
      currentIndex += 1;
      stack.push(v);
      onStack.add(v);

      const neighbors = adj.get(v) ?? [];
      for (const w of neighbors) {
        if (!index.has(w)) {
          strongconnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
        }
      }

      if (lowlink.get(v) === index.get(v)) {
        const component: number[] = [];
        let w: number | undefined;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        // Only interested in cycles of length ≥ 2
        if (component.length >= 2) cycles.push(component);
      }
    };

    for (const id of allIds) {
      if (!index.has(id)) strongconnect(id);
    }

    // Convert IDs to paths, deduplicate by sorted members, cap at limit
    const seen = new Set<string>();
    const result: string[][] = [];
    for (const comp of cycles) {
      const paths = comp.map((id) => fileById.get(id)!).sort();
      const key = paths.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(paths);
      if (result.length >= maxCycles) break;
    }

    return result;
  }

  async stats(): Promise<IndexStats> {
    const files = (this.db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number }).c;
    const symbols = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM symbols WHERE kind != 'module'`).get() as { c: number }
    ).c;
    const edges = (this.db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number }).c;
    const pendingRefs = (this.db.prepare(`SELECT COUNT(*) AS c FROM pending_refs`).get() as { c: number }).c;
    const pendingEmbeddings = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM symbols s LEFT JOIN symbol_embeddings e ON e.symbol_id = s.id
           WHERE e.symbol_id IS NULL AND s.kind != 'module'`
        )
        .get() as { c: number }
    ).c;
    const last = this.db.prepare(`SELECT MAX(indexed_at) AS m FROM files`).get() as { m: number | null };
    return { files, symbols, edges, pendingRefs, pendingEmbeddings, lastIndexedAt: last.m };
  }

  // -- Analysis (v4) ------------------------------------------------------------

  async unreferenced(filter: DeadCodeFilter): Promise<DeadCodeCandidate[]> {
    const conditions: string[] = [`s.kind != 'module'`, `e.to_id IS NULL`];
    const params: unknown[] = [];

    // Entry points / conventional framework hooks: never real dead code.
    conditions.push(
      `s.name NOT IN (${ENTRY_POINT_NAMES.map(() => '?').join(',')})`,
      `s.name NOT LIKE 'test%'`,
      `s.name NOT LIKE 'Test%'`
    );
    params.push(...ENTRY_POINT_NAMES);

    // Test files: their symbols are exercised by a test runner, not by edges
    // our syntactic analysis can see.
    for (const pattern of TEST_PATH_PATTERNS) {
      conditions.push(`f.path NOT LIKE ?`);
      params.push(pattern);
    }

    if (filter.kinds?.length) {
      conditions.push(`s.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    if (filter.pathPrefix) {
      conditions.push(`f.path LIKE ?`);
      params.push(`${filter.pathPrefix}%`);
    }
    if (filter.excludePath) {
      conditions.push(`f.path NOT LIKE ?`);
      params.push(`${filter.excludePath}%`);
    }
    if (filter.langs?.length) {
      conditions.push(`s.lang IN (${filter.langs.map(() => '?').join(',')})`);
      params.push(...filter.langs);
    }
    if (!filter.includeExported) {
      conditions.push(`s.exported = 0`);
    }

    const limit = filter.limit ?? 30;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         LEFT JOIN edges e ON e.to_id = s.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY f.path ASC, s.start_line ASC
         LIMIT ? OFFSET ?`
      )
      .all(...(params as never[]), limit, offset) as unknown as SymbolRow[];

    return rows.map((r) => {
      const symbol = symbolRowToRecord(r);
      return { symbol, note: symbol.exported ? 'exported' : null } as DeadCodeCandidate;
    });
  }

  async testsReferencing(
    ids: number[],
    opts?: { depth?: number; includeFuzzy?: boolean }
  ): Promise<Array<{ test: SymbolRecord; target: SymbolRecord; depth: number; confidence: EdgeConfidence }>> {
    if (!ids.length) return [];
    const maxDepth = Math.min(opts?.depth ?? 2, 3);
    const includeFuzzy = opts?.includeFuzzy ?? true;

    const targetById = new Map<number, SymbolRecord>();
    for (const id of ids) {
      const row = this.getSymbolRow(id);
      if (row) targetById.set(id, symbolRowToRecord(row));
    }

    const results: Array<{ test: SymbolRecord; target: SymbolRecord; depth: number; confidence: EdgeConfidence }> = [];
    const visited = new Set<number>(ids);
    let frontier = ids.map((id) => ({ id, targetId: id }));

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const frontierIds = frontier.map((f) => f.id);
      const edges = await this.edgesTo(frontierIds, ['calls', 'references']);
      const next: Array<{ id: number; targetId: number }> = [];
      for (const edge of edges) {
        if (edge.confidence === 'fuzzy' && !includeFuzzy) continue;
        if (visited.has(edge.fromId)) continue;
        const callerRow = this.getSymbolRow(edge.fromId);
        if (!callerRow) continue;
        const targetId = frontier.find((f) => f.id === edge.toId)?.targetId ?? edge.toId;
        const target = targetById.get(targetId);
        if (!target) continue;
        if (isTestPath(callerRow.file_path)) {
          results.push({ test: symbolRowToRecord(callerRow), target, depth, confidence: edge.confidence });
        } else {
          visited.add(edge.fromId);
          next.push({ id: edge.fromId, targetId });
        }
      }
      frontier = next;
    }
    return results;
  }

  async untested(filter: {
    pathPrefix?: string;
    excludePath?: string;
    kinds?: SymbolKind[];
    langs?: CodeLang[];
    limit?: number;
    offset?: number;
  }): Promise<SymbolRecord[]> {
    const conditions: string[] = [`s.exported = 1`, `s.kind != 'module'`];
    const params: unknown[] = [];

    const kinds = filter.kinds?.length ? filter.kinds : (['function', 'method'] as SymbolKind[]);
    conditions.push(`s.kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);

    if (filter.pathPrefix) {
      conditions.push(`f.path LIKE ?`);
      params.push(`${filter.pathPrefix}%`);
    }
    if (filter.excludePath) {
      conditions.push(`f.path NOT LIKE ?`);
      params.push(`${filter.excludePath}%`);
    }
    if (filter.langs?.length) {
      conditions.push(`s.lang IN (${filter.langs.map(() => '?').join(',')})`);
      params.push(...filter.langs);
    }
    // Exclude the symbol's own file from the "not tested" check when IT is a
    // test file (a helper defined inside a test file isn't "untested" in the
    // sense this tool cares about).
    for (const pattern of TEST_PATH_PATTERNS) {
      conditions.push(`f.path NOT LIKE ?`);
      params.push(pattern);
    }

    // Depth-1 only: no direct edge from a symbol living in a test file.
    // Deeper (test -> helper -> target) chains are covered by
    // testsReferencing/who_tests, not by this exclusion — documented in the
    // find_untested tool description.
    const testFileConditions = TEST_PATH_PATTERNS.map(() => `tf.path LIKE ?`).join(' OR ');
    const notTestedSql = `NOT EXISTS (
      SELECT 1 FROM edges e2
      JOIN symbols s2 ON s2.id = e2.from_id
      JOIN files tf ON tf.id = s2.file_id
      WHERE e2.to_id = s.id AND (${testFileConditions})
    )`;
    conditions.push(notTestedSql);
    params.push(...TEST_PATH_PATTERNS);

    const limit = filter.limit ?? 30;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY f.path ASC, s.start_line ASC
         LIMIT ? OFFSET ?`
      )
      .all(...(params as never[]), limit, offset) as unknown as SymbolRow[];

    return rows.map(symbolRowToRecord);
  }

  async fileEdges(
    filePath: string,
    direction: 'imports' | 'importers',
    opts?: { transitive?: boolean; maxDepth?: number; limit?: number }
  ): Promise<FileDep[]> {
    const fileRow = this.db.prepare(`SELECT id FROM files WHERE path = ?`).get(filePath) as
      | { id: number }
      | undefined;
    if (!fileRow) return [];

    const maxDepth = opts?.transitive ? (opts.maxDepth ?? 5) : 1;
    const limit = opts?.limit ?? 50;

    // direction 'imports': edges FROM this file's symbols (kind='imports'),
    // to_id lands on the imported file's module symbol.
    // direction 'importers': edges TO this file's symbols, from_id is the
    // importing file's module symbol.
    const nextFileIdsQuery =
      direction === 'imports'
        ? `SELECT DISTINCT s2.file_id AS file_id
           FROM edges ed
           JOIN symbols s1 ON s1.id = ed.from_id
           JOIN symbols s2 ON s2.id = ed.to_id
           WHERE ed.kind = 'imports' AND s1.file_id = ?`
        : `SELECT DISTINCT s1.file_id AS file_id
           FROM edges ed
           JOIN symbols s1 ON s1.id = ed.from_id
           JOIN symbols s2 ON s2.id = ed.to_id
           WHERE ed.kind = 'imports' AND s2.file_id = ?`;
    const lineQuery =
      direction === 'imports'
        ? `SELECT MIN(ed.line) AS line
           FROM edges ed
           JOIN symbols s1 ON s1.id = ed.from_id
           JOIN symbols s2 ON s2.id = ed.to_id
           WHERE ed.kind = 'imports' AND s1.file_id = ? AND s2.file_id = ?`
        : `SELECT MIN(ed.line) AS line
           FROM edges ed
           JOIN symbols s1 ON s1.id = ed.from_id
           JOIN symbols s2 ON s2.id = ed.to_id
           WHERE ed.kind = 'imports' AND s2.file_id = ? AND s1.file_id = ?`;

    const stmtNext = this.db.prepare(nextFileIdsQuery);
    const stmtLine = this.db.prepare(lineQuery);
    const pathOf = this.db.prepare(`SELECT path FROM files WHERE id = ?`);

    const visited = new Set<number>([fileRow.id]);
    const results: FileDep[] = [];
    let frontier = [fileRow.id];
    let depth = 1;

    while (frontier.length > 0 && depth <= maxDepth && results.length < limit) {
      const next: number[] = [];
      for (const fid of frontier) {
        const rows = stmtNext.all(fid) as unknown as Array<{ file_id: number }>;
        for (const row of rows) {
          if (visited.has(row.file_id)) continue;
          visited.add(row.file_id);
          const lineRow = stmtLine.get(fid, row.file_id) as { line: number | null };
          const p = pathOf.get(row.file_id) as { path: string } | undefined;
          if (!p) continue;
          results.push({ path: p.path, line: lineRow.line ?? 1, depth });
          next.push(row.file_id);
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }
      frontier = next;
      depth += 1;
    }

    return results.slice(0, limit);
  }

  async similarPairs(
    minCosine: number,
    opts?: { pathPrefix?: string; kinds?: SymbolKind[]; limit?: number; offset?: number }
  ): Promise<SimilarPair[]> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    const kinds = opts?.kinds?.length
      ? opts.kinds.filter((k) => k === 'function' || k === 'method')
      : ['function', 'method'];
    const filters = [`s.kind IN (${kinds.map(() => '?').join(',') || `'function','method'`})`];
    const params: unknown[] = [...kinds];
    if (opts?.pathPrefix) {
      filters.push(`f.path LIKE ?`);
      params.push(`${opts.pathPrefix}%`);
    }

    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path, e.vector AS vector
         FROM symbol_embeddings e
         JOIN symbols s ON s.id = e.symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE ${filters.join(' AND ')}`
      )
      .all(...(params as never[])) as unknown as Array<SymbolRow & { vector: Buffer }>;

    if (rows.length > MAX_SIMILAR_PAIRS_SCAN) {
      throw new Error(
        `index too large for duplicate scan (${rows.length} embedded functions/methods, cap ${MAX_SIMILAR_PAIRS_SCAN}); narrow with pathPrefix`
      );
    }

    const items = rows.map((r) => ({ symbol: symbolRowToRecord(r), vector: bufferToFloat32(r.vector) }));
    const pairs: SimilarPair[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        const similarity = cosine(a.vector, b.vector);
        if (similarity >= minCosine) {
          pairs.push({ a: a.symbol, b: b.symbol, similarity });
        }
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity);
    return pairs.slice(offset, offset + limit);
  }

  async hotspots(query: HotspotQuery): Promise<SymbolRecord[]> {
    const metric = query.metric ?? 'cognitive';
    const column = metric === 'cyclomatic' ? 'complexity' : 'cognitive';
    const filters = [`s.kind IN ('function','method')`];
    const params: unknown[] = [];
    if (query.threshold !== undefined) {
      filters.push(`s.${column} >= ?`);
      params.push(query.threshold);
    }
    if (query.pathPrefix) {
      filters.push(`f.path LIKE ?`);
      params.push(`${query.pathPrefix}%`);
    }
    if (query.langs?.length) {
      filters.push(`s.lang IN (${query.langs.map(() => '?').join(',')})`);
      params.push(...query.langs);
    }
    if (query.kinds?.length) {
      const kinds = query.kinds.filter((k) => k === 'function' || k === 'method');
      if (kinds.length) {
        filters.push(`s.kind IN (${kinds.map(() => '?').join(',')})`);
        params.push(...kinds);
      }
    }
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT s.*, f.path AS file_path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE ${filters.join(' AND ')}
         ORDER BY s.${column} DESC, f.path ASC, s.start_line ASC
         LIMIT ? OFFSET ?`
      )
      .all(...(params as never[]), limit, offset) as unknown as SymbolRow[];

    return rows.map(symbolRowToRecord);
  }

  private dropAll(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS symbols_fts;
      DROP TABLE IF EXISTS symbol_embeddings;
      DROP TABLE IF EXISTS pending_imports;
      DROP TABLE IF EXISTS pending_refs;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS files;
    `);
  }

  async reset(): Promise<void> {
    this.dropAll();
    this.migrate();
  }

  dispose(): void {
    this.db.close();
  }
}

function edgeRowToRecord(r: { from_id: number; to_id: number; kind: string; line: number; confidence: string }): EdgeRecord {
  return {
    fromId: r.from_id,
    toId: r.to_id,
    kind: r.kind as EdgeKind,
    line: r.line,
    confidence: r.confidence as EdgeRecord['confidence'],
  };
}

function escapeFtsQuery(text: string): string {
  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return tokens.join(' OR ');
}

export class SqliteCodeStoreFactory implements CodeStoreFactory {
  async open(dbPath: string): Promise<CodeStore> {
    const db = new DatabaseSync(dbPath);
    return new SqliteCodeStore(db);
  }

  /**
   * Same db, same `migrate()` call, but also returns an IndexProvenanceService
   * sharing the connection — for callers that need generation stamps
   * (docs/MemoryIndexSynergy.md §F1). `open()` stays the plain CodeStore
   * entrypoint so existing call sites are unaffected.
   */
  async openWithProvenance(dbPath: string): Promise<{ store: CodeStore; provenance: IndexProvenanceService }> {
    const db = new DatabaseSync(dbPath);
    return { store: new SqliteCodeStore(db), provenance: new SqliteIndexProvenanceService(db) };
  }
}
