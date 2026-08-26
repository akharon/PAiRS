/**
 * CodeStore implementation over SQLite (`node:sqlite`, built into Node 22+).
 * Lives at `.pairs/index.db` — disposable derived data, single writer (the
 * indexer), no write guards.
 *
 * Replaces the previous KuzuDB backend. The motivation was concrete: Kuzu
 * allocates ~2 MB of pages on first write to *each* of its 13 REL TABLEs, so
 * a graph holding ~50 KB of actual strings occupied a 50 MB file and took
 * ~3.3 s to write. The same graph here is ~0.3 MB and ~20 ms — one `Edge`
 * table with a `kind` column costs nothing for the edge kinds a project never
 * uses.
 *
 * What carried over unchanged, because it was never database logic:
 *  - `resolveOneRef`'s qualified → suffix → module-path → bare-name ladder and
 *    its cross-crate/method-call confidence gate, which read only the
 *    in-memory SymbolIndex mirror.
 *  - `findCycles`'s Tarjan SCC, run in JS over an edge list pulled by one
 *    query.
 *  - The dead-code / file-deps / hotspots / untested exclusion rules.
 *
 * What got simpler: SQLite hands out rowids, so Kuzu's `next_id` /
 * `next_pending_id` Meta counters are gone; prepared statements are
 * synchronous and cheap, so the parameterized-UNWIND machinery and its
 * null-sentinel workarounds are gone too.
 */

import type {
  AmbiguousSymbol,
  CodeLang,
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
  NamedFileRecord,
  RawRef,
  SymbolKind,
  SymbolRecord,
} from '../../core/indexer/types';
import { ENTRY_POINT_NAMES, globToRegExp, isTestPath, TEST_PATH_REGEX } from '../../core/indexer/types';
import type { CodeStore, CodeStoreFactory } from './codeStore';
import { assertReadOnlySql } from './codeStore';
import { importCandidatePaths, isExternalSpecifier } from './importPath';
import { nodeSqlDriver } from './sqliteDriver';
import type { SqlConnectionLike, SqlDriver, SqlStatement } from './sqliteDriver';
import { ALL_TABLES, REFERENCE_EDGE_KINDS, SCHEMA_DDL, SCHEMA_INDEXES, SCHEMA_VERSION } from './sqlSchema';

interface IndexEntry {
  id: number;
  name: string;
  qualified: string;
  path: string;
}

/**
 * In-memory mirror of the symbol table, exactly as the Kuzu store kept it:
 * resolution is pure lookup and the round-trips it used to make dominated
 * index time. Unchanged here — it was never Kuzu-specific.
 */
interface SymbolIndex {
  byQualified: Map<string, number[]>;
  byName: Map<string, number[]>;
  /** Suffix probes: `::x::y` → ids. */
  byQualifiedSuffix: Map<string, number[]>;
  /** name → (id, declaring file path); the module probe suffix-matches the path. */
  byNameWithPath: Map<string, Array<{ id: number; path: string }>>;
  /** id → qualified, for the `use`-specifier narrowing rung. */
  qualifiedById: Map<number, string>;
  /** id → declaring file path, for the cross-crate confidence gate. */
  pathById: Map<number, string>;
  /** file path → that file's module symbol id (module symbols stay out of the name maps). */
  moduleIdByPath: Map<string, number>;
  /** path → this file's entries, so applyExtraction patches the mirror in place. */
  entriesByFile: Map<string, IndexEntry[]>;
}

function toSymbolRecord(r: Record<string, unknown>): SymbolRecord {
  return {
    id: Number(r.id),
    fileId: Number(r.fileId),
    file: String(r.file),
    name: String(r.name),
    qualified: String(r.qualified ?? ''),
    kind: r.kind as SymbolKind,
    lang: r.lang as CodeLang,
    startLine: Number(r.startLine),
    endLine: Number(r.endLine),
    signature: (r.signature as string | null) || null,
    doc: (r.doc as string | null) || null,
    parentId: r.parentId === null || r.parentId === undefined ? null : Number(r.parentId),
    exported: Boolean(r.exported),
  };
}

function toFileRecord(r: Record<string, unknown>): FileRecord {
  return {
    id: Number(r.id),
    path: String(r.path),
    lang: r.lang as CodeLang,
    mtimeMs: Number(r.mtimeMs),
    size: Number(r.size),
    hash: String(r.hash ?? ''),
    indexedAt: Number(r.indexedAt),
    crate: (r.crate as string | null) || null,
    parseError: Boolean(r.parseError),
  };
}

function toNamedFileRecord(r: Record<string, unknown>): NamedFileRecord {
  return {
    id: Number(r.id),
    path: String(r.path),
    name: String(r.name),
    mtimeMs: Number(r.mtimeMs),
    size: Number(r.size),
  };
}

const SYMBOL_COLS = `s.id AS id, s.fileId AS fileId, s.file AS file, s.name AS name, s.qualified AS qualified,
  s.kind AS kind, s.lang AS lang, s.startLine AS startLine, s.endLine AS endLine,
  s.signature AS signature, s.doc AS doc, s.parentId AS parentId, s.exported AS exported`;

/** `IN (?,?,?)` placeholder list for a variable-length id set. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

export class SqliteCodeStore implements CodeStore {
  private symbolIndex: SymbolIndex | null = null;
  private stmts = new Map<string, SqlStatement>();
  private inTx = false;
  private disposed = false;

  private constructor(private readonly conn: SqlConnectionLike) {}

  static async open(dbPath: string, driver: SqlDriver): Promise<SqliteCodeStore> {
    const conn = driver.open(dbPath);
    // `untested()`'s test-path predicate and the `pairs query` escape hatch
    // need regex matching; SQLite has no built-in REGEXP, so register one.
    // Invalid patterns match nothing rather than throwing mid-query.
    conn.addFunction('regexp_matches', (value: unknown, pattern: unknown): number => {
      try {
        return new RegExp(String(pattern)).test(String(value ?? '')) ? 1 : 0;
      } catch {
        return 0;
      }
    });
    const store = new SqliteCodeStore(conn);
    store.migrate();
    return store;
  }

  // -- Low-level helpers -------------------------------------------------------

  /** Prepared-statement cache: SQL text → handle. Prepare cost is real on hot paths. */
  private stmt(sql: string): SqlStatement {
    let s = this.stmts.get(sql);
    if (s === undefined) {
      s = this.conn.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private all(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.stmt(sql).all(...params);
  }

  /** Named `one` rather than `get` so it doesn't collide with CodeStore.get(id). */
  private one(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt(sql).get(...params);
  }

  private run(sql: string, ...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt(sql).run(...params);
  }

  /**
   * One explicit transaction around `fn`. Beyond the atomicity the spec
   * requires of applyExtraction, this is what keeps bulk insert fast: without
   * it each statement commits with its own fsync.
   */
  private transaction<T>(fn: () => T): T {
    if (this.inTx) return fn(); // nested call joins the outer transaction
    this.inTx = true;
    this.conn.exec('BEGIN');
    try {
      const out = fn();
      this.conn.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK');
      } catch {
        /* connection state unknown — surface the original error */
      }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  private migrate(): void {
    let existing: number | null = null;
    try {
      const r = this.conn.prepare(`SELECT value FROM Meta WHERE key = 'schema_version'`).get();
      existing = r ? Number(r.value) : null;
    } catch {
      existing = null; // Meta doesn't exist yet — fresh database.
    }
    if (existing !== null && existing !== SCHEMA_VERSION) {
      this.resetSync();
      return;
    }
    if (existing === SCHEMA_VERSION) return;
    for (const ddl of SCHEMA_DDL) this.conn.exec(ddl);
    for (const ix of SCHEMA_INDEXES) this.conn.exec(ix);
    this.conn.exec(`INSERT OR REPLACE INTO Meta(key, value) VALUES('schema_version', '${SCHEMA_VERSION}')`);
  }

  async reset(): Promise<void> {
    this.resetSync();
  }

  private resetSync(): void {
    this.invalidateSymbolIndex();
    this.stmts.clear();
    // DROP and recreate rather than DELETE: a schema-version bump can change
    // table shape, and deleting rows from an old-shaped table leaves later
    // INSERTs binding against missing columns.
    for (const t of ALL_TABLES) this.conn.exec(`DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA_DDL) this.conn.exec(ddl);
    for (const ix of SCHEMA_INDEXES) this.conn.exec(ix);
    this.conn.exec(`INSERT OR REPLACE INTO Meta(key, value) VALUES('schema_version', '${SCHEMA_VERSION}')`);
  }

  // -- Symbol index mirror -----------------------------------------------------

  private invalidateSymbolIndex(): void {
    this.symbolIndex = null;
  }

  private static indexAdd(idx: SymbolIndex, e: IndexEntry): void {
    const push = <K, T>(m: Map<K, T[]>, k: K, v: T): void => {
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    };
    push(idx.byQualified, e.qualified, e.id);
    push(idx.byName, e.name, e.id);
    push(idx.byNameWithPath, e.name, { id: e.id, path: e.path });
    idx.qualifiedById.set(e.id, e.qualified);
    idx.pathById.set(e.id, e.path);
    const segs = e.qualified.split('::');
    for (let i = 1; i < segs.length; i++) push(idx.byQualifiedSuffix, segs.slice(i).join('::'), e.id);
    push(idx.entriesByFile, e.path, e);
  }

  /** Remove one file's entries from the mirror (inverse of indexAdd). */
  private static indexRemoveFile(idx: SymbolIndex, path: string): void {
    idx.moduleIdByPath.delete(path);
    const entries = idx.entriesByFile.get(path);
    if (!entries) return;
    idx.entriesByFile.delete(path);
    const ids = new Set(entries.map((e) => e.id));
    const prune = (m: Map<string, number[]>, k: string): void => {
      const list = m.get(k);
      if (!list) return;
      const kept = list.filter((id) => !ids.has(id));
      if (kept.length) m.set(k, kept);
      else m.delete(k);
    };
    for (const e of entries) {
      prune(idx.byQualified, e.qualified);
      prune(idx.byName, e.name);
      idx.qualifiedById.delete(e.id);
      idx.pathById.delete(e.id);
      const segs = e.qualified.split('::');
      for (let i = 1; i < segs.length; i++) prune(idx.byQualifiedSuffix, segs.slice(i).join('::'));
      const withPath = idx.byNameWithPath.get(e.name);
      if (withPath) {
        const kept = withPath.filter((c) => !ids.has(c.id));
        if (kept.length) idx.byNameWithPath.set(e.name, kept);
        else idx.byNameWithPath.delete(e.name);
      }
    }
  }

  private loadSymbolIndex(): SymbolIndex {
    if (this.symbolIndex) return this.symbolIndex;
    const idx: SymbolIndex = {
      byQualified: new Map(),
      byName: new Map(),
      byQualifiedSuffix: new Map(),
      byNameWithPath: new Map(),
      qualifiedById: new Map(),
      pathById: new Map(),
      moduleIdByPath: new Map(),
      entriesByFile: new Map(),
    };
    for (const r of this.all(`SELECT id, name, qualified, file FROM Symbol WHERE kind <> 'module'`)) {
      SqliteCodeStore.indexAdd(idx, {
        id: Number(r.id),
        name: String(r.name),
        qualified: String(r.qualified ?? ''),
        path: String(r.file),
      });
    }
    // Module symbols: kept out of the name maps (they'd pollute every bare-name
    // lookup) but needed as the endpoint of path-style import edges. Lowest id
    // per file = the root module symbol the extractor emits first; inline
    // `mod`s get higher ids and must not displace it.
    for (const r of this.all(`SELECT file, MIN(id) AS id FROM Symbol WHERE kind = 'module' GROUP BY file`)) {
      idx.moduleIdByPath.set(String(r.file), Number(r.id));
    }
    this.symbolIndex = idx;
    return idx;
  }

  // -- Indexing ----------------------------------------------------------------

  /**
   * Convert every reference edge coming INTO file `fileId`'s symbols from a
   * DIFFERENT file back into PendingRefs owned by the referring file, so the
   * upcoming symbol deletion doesn't orphan them — a referring file is not
   * re-indexed when its target changes, so without this every cross-file edge
   * into an edited file is silently lost. An edge that was fuzzy re-parks with
   * methodCall=1 so the confidence cap survives the round trip.
   */
  private reparkIncomingRefs(fileId: number): void {
    const rows = this.all(
      `SELECT a.id AS fromId, a.fileId AS fromFileId, s.name AS name, s.qualified AS qualified,
              e.kind AS kind, e.line AS line, e.confidence AS conf, e.test AS test
       FROM Edge e
       JOIN Symbol s ON s.id = e.dst
       JOIN Symbol a ON a.id = e.src
       WHERE s.fileId = ? AND a.fileId <> ? AND e.kind IN (${placeholders(REFERENCE_EDGE_KINDS.length)})`,
      fileId,
      fileId,
      ...REFERENCE_EDGE_KINDS
    );
    if (rows.length === 0) return;
    const ins = this.stmt(
      `INSERT INTO PendingRef(fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, inTest)
       VALUES(?,?,?,?,?,?,?,?)`
    );
    for (const r of rows) {
      // A top-level fn's stored qualified IS its bare name; parking that as a
      // qualifiedName would hit the qualified ladder's "single segment never
      // matches" rule and stay unresolved forever — park it bare instead.
      const q = String(r.qualified ?? '');
      ins.run(
        Number(r.fromFileId),
        Number(r.fromId),
        String(r.name),
        q.includes('::') ? q : '',
        String(r.kind),
        Number(r.line ?? 0),
        String(r.conf) === 'fuzzy' ? 1 : 0,
        r.test ? 1 : 0
      );
    }
  }

  async applyExtraction(extraction: FileExtraction): Promise<FileRecord> {
    return this.transaction(() => this.applyExtractionInner(extraction));
  }

  private applyExtractionInner(extraction: FileExtraction): FileRecord {
    const now = Date.now();
    const existing = this.one(`SELECT id FROM File WHERE path = ?`, extraction.path);
    const crate = extraction.crate ?? null;

    let fileId: number;
    if (existing) {
      fileId = Number(existing.id);
      this.reparkIncomingRefs(fileId);
      // Delete prior symbols and everything hanging off them. FK cascade
      // covers PendingRef; Edge has no FK (its src may be a File id for
      // DECLARES), so clear it explicitly.
      this.run(`DELETE FROM Edge WHERE src IN (SELECT id FROM Symbol WHERE fileId = ?) OR dst IN (SELECT id FROM Symbol WHERE fileId = ?)`, fileId, fileId);
      this.run(`DELETE FROM Edge WHERE kind = 'DECLARES' AND src = ?`, fileId);
      this.run(`DELETE FROM Symbol WHERE fileId = ?`, fileId);
      this.run(`DELETE FROM PendingRef WHERE fileId = ?`, fileId);
      this.run(`DELETE FROM ExternalName WHERE fileId = ?`, fileId);
      this.run(
        `UPDATE File SET lang=?, mtimeMs=?, size=?, hash=?, indexedAt=?, crate=?, parseError=? WHERE id=?`,
        extraction.lang,
        extraction.mtimeMs,
        extraction.size,
        extraction.hash,
        now,
        crate,
        extraction.parseError ? 1 : 0,
        fileId
      );
    } else {
      const res = this.run(
        `INSERT INTO File(path, lang, mtimeMs, size, hash, indexedAt, crate, parseError) VALUES(?,?,?,?,?,?,?,?)`,
        extraction.path,
        extraction.lang,
        extraction.mtimeMs,
        extraction.size,
        extraction.hash,
        now,
        crate,
        extraction.parseError ? 1 : 0
      );
      fileId = Number(res.lastInsertRowid);
    }

    // Insert symbols in extraction order (module symbol first), remapping
    // parentIndex → real id. SQLite assigns ids, so unlike Kuzu there is no
    // id-block reservation: insert, then read back the rowid.
    const indexToId: number[] = [];
    const insSym = this.stmt(
      `INSERT INTO Symbol(fileId, file, name, qualified, kind, lang, startLine, endLine, signature, doc, parentId, exported)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const sym of extraction.symbols) {
      const res = insSym.run(
        fileId,
        extraction.path,
        sym.name,
        sym.qualified,
        sym.kind,
        sym.lang,
        sym.startLine,
        sym.endLine,
        sym.signature ?? null,
        sym.doc ?? null,
        null, // patched below once every sibling has an id
        sym.exported ? 1 : 0
      );
      indexToId.push(Number(res.lastInsertRowid));
    }
    // parentId in a second pass: a child may precede its parent in extraction
    // order, so the mapping is only complete now.
    const setParent = this.stmt(`UPDATE Symbol SET parentId = ? WHERE id = ?`);
    extraction.symbols.forEach((sym, i) => {
      if (sym.parentIndex !== null && sym.parentIndex !== undefined) {
        setParent.run(indexToId[sym.parentIndex]!, indexToId[i]!);
      }
    });

    const insEdge = this.stmt(`INSERT INTO Edge(src, dst, kind, line, confidence, test) VALUES(?,?,?,?,?,?)`);
    // DECLARES: File → Symbol, the one edge whose src is a file id.
    for (const id of indexToId) insEdge.run(fileId, id, 'DECLARES', 0, 'resolved', 0);
    // OWNS: parent → child.
    extraction.symbols.forEach((sym, i) => {
      if (sym.parentIndex !== null && sym.parentIndex !== undefined) {
        insEdge.run(indexToId[sym.parentIndex]!, indexToId[i]!, 'OWNS', 0, 'resolved', 0);
      }
    });

    // Patch the in-memory mirror in place — a full rebuild per file made
    // fullIndex O(files × symbols).
    if (this.symbolIndex) {
      SqliteCodeStore.indexRemoveFile(this.symbolIndex, extraction.path);
      extraction.symbols.forEach((sym, i) => {
        if (sym.kind === 'module') {
          // Mirrors loadSymbolIndex: module symbols stay out of the name maps,
          // but the file's root module symbol (symbols[0]) is recorded by path
          // so path-style imports can target this file.
          if (i === 0) this.symbolIndex!.moduleIdByPath.set(extraction.path, indexToId[i]!);
          return;
        }
        SqliteCodeStore.indexAdd(this.symbolIndex!, {
          id: indexToId[i]!,
          name: sym.name,
          qualified: sym.qualified,
          path: extraction.path,
        });
      });
    }

    // Pass 2, phase A: resolve what we can now; park the rest.
    const useSpecifiers = extraction.uses.map((u) => u.specifier);
    // Names this file imports from OUTSIDE the workspace (`vitest`, `zod`,
    // `node:fs`). These name external symbols, so they must never bind to a
    // workspace namesake. A glob import binds no name we can list, so it
    // contributes nothing.
    //
    // Classified by specifier shape rather than by "does this resolve to an
    // indexed file": files are indexed one at a time, so a relative import
    // whose target comes later would look unresolvable and be wrongly marked
    // external, suppressing a real edge.
    const externalNames = new Set<string>();
    for (const u of extraction.uses) {
      if (u.isGlob || u.boundNames.length === 0) continue;
      if (!isExternalSpecifier(u.specifier)) continue;
      for (const n of u.boundNames) externalNames.add(n);
    }
    // Persist for resolvePending, which re-resolves parked refs after this
    // extraction is gone.
    if (externalNames.size > 0) {
      const insExt = this.stmt(`INSERT OR IGNORE INTO ExternalName(fileId, name) VALUES (?, ?)`);
      for (const n of externalNames) insExt.run(fileId, n);
    }
    const pending: RawRef[] = [];
    for (const ref of extraction.refs) {
      const fromId = indexToId[ref.fromIndex]!;
      const callerQualified = extraction.symbols[ref.fromIndex]?.qualified ?? null;
      const resolved = this.resolveOneRef(
        ref.name,
        ref.qualifiedName,
        useSpecifiers,
        ref.methodCall ?? false,
        extraction.path,
        externalNames,
        ref.selfReceiver ?? false,
        callerQualified
      );
      if (resolved === 'unresolved') {
        pending.push(ref);
        continue;
      }
      for (const toId of resolved.ids) {
        insEdge.run(fromId, toId, ref.kind, ref.line, resolved.confidence, ref.inTest === true ? 1 : 0);
      }
    }

    // Import/`use` statements: resolve to the target file's module symbol.
    const moduleId = indexToId[0];
    if (moduleId !== undefined) {
      const seenDep = new Set<number>();
      for (const u of extraction.uses) {
        const viaPath = this.resolveImportPath(extraction.path, u.specifier);
        if (viaPath !== null) {
          if (viaPath !== moduleId && !seenDep.has(viaPath)) {
            seenDep.add(viaPath);
            insEdge.run(moduleId, viaPath, 'DEPENDS_ON', u.line, 'resolved', u.inTest === true ? 1 : 0);
          }
          continue;
        }
        const segs = u.specifier.split(/::|\//).filter(Boolean);
        const tail = segs[segs.length - 1];
        if (tail === undefined) continue;
        const resolved = this.resolveOneRef(tail, u.specifier, useSpecifiers);
        if (resolved === 'unresolved') {
          // Park it: the target file may index later. Without this every
          // forward `use` dep is silently lost.
          pending.push({ fromIndex: 0, name: tail, qualifiedName: u.specifier, kind: 'DEPENDS_ON', line: u.line, inTest: u.inTest });
          continue;
        }
        for (const toId of resolved.ids) {
          if (toId === moduleId || seenDep.has(toId)) continue;
          seenDep.add(toId);
          insEdge.run(moduleId, toId, 'DEPENDS_ON', u.line, resolved.confidence, u.inTest === true ? 1 : 0);
        }
      }
    }

    if (pending.length > 0) {
      const insPending = this.stmt(
        `INSERT INTO PendingRef(fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, selfReceiver, inTest)
         VALUES(?,?,?,?,?,?,?,?,?)`
      );
      for (const ref of pending) {
        insPending.run(
          fileId,
          indexToId[ref.fromIndex]!,
          ref.name,
          ref.qualifiedName ?? '',
          ref.kind,
          ref.line,
          ref.methodCall === true ? 1 : 0,
          ref.selfReceiver === true ? 1 : 0,
          ref.inTest === true ? 1 : 0
        );
      }
    }

    return toFileRecord(this.one(`SELECT * FROM File WHERE id = ?`, fileId)!);
  }

  async removeFile(path: string): Promise<void> {
    if (this.symbolIndex) SqliteCodeStore.indexRemoveFile(this.symbolIndex, path);
    const r = this.one(`SELECT id FROM File WHERE path = ?`, path);
    if (!r) return;
    const fileId = Number(r.id);
    this.transaction(() => {
      this.reparkIncomingRefs(fileId); // referrers keep their claim
      this.run(`DELETE FROM PendingRef WHERE fileId = ?`, fileId);
      this.run(`DELETE FROM Edge WHERE src IN (SELECT id FROM Symbol WHERE fileId = ?) OR dst IN (SELECT id FROM Symbol WHERE fileId = ?)`, fileId, fileId);
      this.run(`DELETE FROM Edge WHERE kind = 'DECLARES' AND src = ?`, fileId);
      this.run(`DELETE FROM Symbol WHERE fileId = ?`, fileId);
      this.run(`DELETE FROM File WHERE id = ?`, fileId);
    });
  }

  /**
   * Resolve a path-style import (`./util`, `../lib/x`) to the target file's
   * module symbol id. Rust `use` paths are name-qualified, not file paths, and
   * fall through to the name ladder.
   */
  private resolveImportPath(fromPath: string, specifier: string): number | null {
    const idx = this.loadSymbolIndex();
    for (const cand of importCandidatePaths(fromPath, specifier)) {
      const id = idx.moduleIdByPath.get(cand);
      if (id !== undefined) return id;
    }
    return null;
  }

  /**
   * The resolution ladder: qualified-as-written → qualified suffix → module
   * path → bare name, with a confidence gate over every outcome. Ported
   * verbatim from the Kuzu store — it reads only the in-memory mirror, so it
   * never was database logic.
   */
  private resolveOneRef(
    name: string,
    qualifiedName: string | null,
    useSpecifiers: string[],
    methodCall = false,
    fromPath: string | null = null,
    externalNames?: ReadonlySet<string>,
    selfReceiver = false,
    callerQualified: string | null = null
  ): { ids: number[]; confidence: 'resolved' | 'fuzzy' } | 'unresolved' {
    const idx = this.loadSymbolIndex();

    /**
     * Confidence gate (R1: `resolved` must be trustworthy — rules only fail CI
     * on confirmed findings):
     *  1. A bare METHOD call (`x.foo()`) caps at `fuzzy` however few candidates
     *     share the name — the receiver's static type is unknown and the true
     *     target is often outside the graph (derive impls, trait defaults).
     *  2. A resolution landing in a DIFFERENT crate caps at `fuzzy` unless a
     *     `use` specifier corroborates it. Same-named symbols across sibling
     *     crates otherwise resolve "confirmed" onto the wrong crate: on ripgrep
     *     this leaked 200+ false confirmed layering violations.
     */
    const gate = (out: { ids: number[]; confidence: 'resolved' | 'fuzzy' }): { ids: number[]; confidence: 'resolved' | 'fuzzy' } => {
      if (out.confidence === 'fuzzy') return out;
      if (methodCall) return { ids: out.ids, confidence: 'fuzzy' };
      if (fromPath) {
        const crateOf = (p: string): string => {
          const segs = p.split('/');
          const i = segs.indexOf('src');
          if (i > 0) return segs.slice(0, i).join('/');
          if (segs.length >= 3 && ['crates', 'packages', 'libs', 'apps'].includes(segs[0]!)) return segs.slice(0, 2).join('/');
          return '';
        };
        const home = crateOf(fromPath);
        const crossCrate = out.ids.some((id) => {
          const p = idx.pathById.get(id);
          return p !== undefined && crateOf(p) !== home;
        });
        if (crossCrate) {
          const head = qualifiedName?.split('::').find((s) => s !== 'crate' && s !== 'self' && s !== 'super') ?? null;
          const candidateTokens = new Set(
            out.ids.flatMap((id) => (idx.pathById.get(id) ?? '').split('/').slice(0, -1).map((s) => s.replace(/-/g, '_')))
          );
          const corroborated = useSpecifiers.some((spec) => {
            const segs = spec.split(/::|\//).filter(Boolean);
            const tail = segs[segs.length - 1];
            const specHead = (segs[0] ?? '').replace(/-/g, '_');
            const namesTarget = tail === name || (head !== null && tail === head);
            const crateMatch = [...candidateTokens].some((t) => t.length > 2 && specHead.includes(t));
            return namesTarget && crateMatch;
          });
          if (!corroborated) return { ids: out.ids, confidence: 'fuzzy' };
        }
      }
      return out;
    };

    // Rung 0: `this`/`self` receiver calls. Unlike a general method call, the
    // receiver's static type IS known here — it is the enclosing symbol's own
    // scope — so a unique method on that scope is a verified target, in the
    // same sense Rung 2's same-file local declaration is verified. This does
    // NOT walk EXTENDS/IMPLEMENTS: a method inherited from a base class finds
    // zero matches here and falls through to the ordinary (capped) ladder.
    if (selfReceiver && callerQualified) {
      const sep = callerQualified.includes('::') ? '::' : '.';
      const segs = callerQualified.split(sep);
      if (segs.length > 1) {
        const scope = segs.slice(0, -1).join(sep);
        const candidates = idx.byQualified.get(`${scope}${sep}${name}`);
        if (candidates !== undefined) {
          if (candidates.length === 1) return { ids: [...candidates], confidence: 'resolved' };
          return { ids: [...candidates], confidence: 'fuzzy' };
        }
      }
    }

    // Rung 1: the ref as written, when it carried a `::` qualifier.
    //
    // A qualifier is a *constraint*, not a hint: `Vec3::new` names Vec3's
    // constructor and nothing else, so a qualified ref never falls through to
    // the bare-name rung. Falling back would pick every workspace `new` as a
    // fuzzy candidate — that single mistake accounted for ~1,000 of 1,833
    // fuzzy edges on the ARES sample.
    if (qualifiedName) {
      const segments = qualifiedName.split('::');
      // `length - 1` stops before the bare final segment (see above).
      for (let i = 0; i < segments.length - 1; i++) {
        const candidate = segments.slice(i).join('::');
        const exact = idx.byQualified.get(candidate);
        if (exact) return gate({ ids: [...exact], confidence: exact.length === 1 ? 'resolved' : 'fuzzy' });
        const suffix = idx.byQualifiedSuffix.get(candidate);
        if (suffix) return gate({ ids: [...suffix], confidence: suffix.length === 1 ? 'resolved' : 'fuzzy' });
      }
      // Last resort for a path whose prefix is a *module*, not a type: in Rust
      // the module path is the file path, so the symbol is stored bare.
      const modulePath = segments.slice(0, -1).filter((s) => s !== 'crate' && s !== 'self' && s !== 'super');
      if (modulePath.length > 0) {
        const fileSuffix = `${modulePath.join('/')}.rs`;
        const byModule = (idx.byNameWithPath.get(name) ?? []).filter((c) => c.path === fileSuffix || c.path.endsWith(`/${fileSuffix}`));
        if (byModule.length > 0) {
          return gate({ ids: byModule.map((c) => c.id), confidence: byModule.length === 1 ? 'resolved' : 'fuzzy' });
        }
      }
      return 'unresolved';
    }

    // Rung 2: same-file shadowing. A bare ref in a file that itself declares
    // `name` binds to that local declaration — lexical scope beats any
    // workspace-wide namesake, so this is `resolved`, not a fuzzy fan-out.
    //
    // Without this the global ladder below returned EVERY namesake: a local
    // `main()` in v3BenchCli.ts produced three CALLS edges (to scripts/, to
    // cli/index.ts, and to its own real target), and those cross-module
    // phantoms were reported as layering violations. Same for a callback
    // parameter named `pick` and any common helper name.
    //
    // Only applies to bare refs — a qualified ref returns at Rung 1, where the
    // qualifier is already a constraint. Method/member calls are excluded:
    // there the receiver's static type is unknown, so a same-file namesake is
    // coincidence rather than lexical scope, and `gate` must still cap it.
    if (fromPath && !methodCall) {
      const local = (idx.byNameWithPath.get(name) ?? []).filter((c) => c.path === fromPath);
      if (local.length > 0) {
        // Multiple same-file declarations (overloads, shadowed scopes) are
        // ambiguous within the file, but still certainly not cross-module.
        return { ids: local.map((c) => c.id), confidence: local.length === 1 ? 'resolved' : 'fuzzy' };
      }
    }

    // Rung 3 guard: a name bound by an import that resolves OUTSIDE the
    // workspace names an external symbol, so no workspace symbol can be its
    // target — however few namesakes exist.
    //
    // Rung 3 below treats "only one workspace match" as proof and returns
    // `resolved`. Uniqueness inside the workspace says nothing about whether
    // the call targets it: `Parser.expect` (rules/ron.ts) was the only
    // `expect` indexed, so all 385 vitest `expect()` calls bound to it as
    // CONFIRMED — inflating the tools→rules boundary from ~13 refs to 107.
    // Same for Zod's `z.string()`/`z.number()` against Parser.string/number.
    if (externalNames?.has(name)) return 'unresolved';

    // Rung 3: bare refs, workspace-wide.
    const byQualified = idx.byQualified.get(name);
    if (byQualified) return gate({ ids: [...byQualified], confidence: byQualified.length === 1 ? 'resolved' : 'fuzzy' });
    const byName = idx.byName.get(name);
    if (byName) return gate({ ids: [...byName], confidence: byName.length === 1 ? 'resolved' : 'fuzzy' });
    return 'unresolved';
  }

  async resolvePending(namesHint?: string[], opts?: { retireUnresolved?: boolean }): Promise<number> {
    const rows = namesHint?.length
      ? this.all(
          `SELECT id, fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, selfReceiver, inTest
           FROM PendingRef WHERE name IN (${placeholders(namesHint.length)})`,
          ...namesHint
        )
      : this.all(`SELECT id, fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, selfReceiver, inTest FROM PendingRef`);
    if (rows.length === 0) return 0;

    const idx = this.loadSymbolIndex();
    const pathByFileId = new Map<number, string>();
    for (const fr of this.all(`SELECT id, path FROM File`)) pathByFileId.set(Number(fr.id), String(fr.path));

    // Each file's externally-bound names, recorded at extraction time (see
    // applyExtractionInner). A ref that parks in phase A is re-resolved here,
    // so without this the guard is bypassed on the second pass and the binding
    // it prevented happens anyway — which is exactly how vitest's `expect`
    // reached Parser.expect as `resolved`.
    const externalByFile = new Map<number, Set<string>>();
    for (const r of this.all(`SELECT fileId, name FROM ExternalName`)) {
      const fileId = Number(r.fileId);
      let set = externalByFile.get(fileId);
      if (set === undefined) externalByFile.set(fileId, (set = new Set<string>()));
      set.add(String(r.name));
    }

    // Names the workspace actually defines. Used to tell a genuine miss (we
    // have this symbol but failed to link it) from an external ref (npm,
    // stdlib, test globals) at the moment we retire the row — after deletion
    // the name is gone and stats() can no longer make the distinction.
    const definedNames = new Set<string>();
    for (const r of this.all(`SELECT DISTINCT name FROM Symbol WHERE kind <> 'module'`)) {
      definedNames.add(String(r.name));
    }

    // Decide first, write once.
    let created = 0;
    let retired = 0;
    let retiredMisses = 0;
    const edges: Array<{ fromId: number; toId: number; kind: EdgeKind; line: number; confidence: EdgeConfidence; test: boolean }> = [];
    const settled: number[] = [];
    for (const r of rows) {
      // A DEPENDS_ON pending WITH a qualifiedName is a parked import — the
      // import IS the dependency statement, so the cross-crate gate does not
      // apply. Bare DEPENDS_ON refs get the gate like any other ref.
      const isUseImport = r.kind === 'DEPENDS_ON' && Boolean(String(r.qualifiedName ?? ''));
      const declaringPath = pathByFileId.get(Number(r.fileId)) ?? null;

      // A parked path-style import: its target file may have been indexed
      // since. Retry it as a path before the name ladder, which can never
      // resolve a file path.
      if (isUseImport && declaringPath !== null) {
        const viaPath = this.resolveImportPath(declaringPath, String(r.qualifiedName));
        if (viaPath !== null) {
          if (viaPath !== Number(r.fromSymbolId)) {
            edges.push({ fromId: Number(r.fromSymbolId), toId: viaPath, kind: 'DEPENDS_ON', line: Number(r.line), confidence: 'resolved', test: Boolean(r.inTest) });
            created += 1;
          }
          settled.push(Number(r.id));
          continue;
        }
      }

      const fromPath = isUseImport ? null : declaringPath;
      // A parked import is itself the dependency statement, so it must still
      // resolve by name; only ordinary refs get the external-name guard.
      const externalNames = isUseImport ? undefined : externalByFile.get(Number(r.fileId));
      const callerQualified = idx.qualifiedById.get(Number(r.fromSymbolId)) ?? null;
      const resolved = this.resolveOneRef(
        String(r.name),
        String(r.qualifiedName ?? '') || null,
        [],
        Boolean(r.methodCall),
        fromPath,
        externalNames,
        Boolean(r.selfReceiver),
        callerQualified
      );
      if (resolved === 'unresolved') {
        // Full-index pass: every file has declared, so this names something
        // outside the workspace (npm/stdlib/test globals like `it`/`describe`/
        // `String`) and no later file can rescue it. Retire it instead of
        // parking it forever — these rows otherwise accumulate across every
        // re-index and dominate the db file.
        if (opts?.retireUnresolved === true) {
          settled.push(Number(r.id));
          retired += 1;
          // A *qualified* ref (`Vec::new`) is never a miss on bare name alone —
          // the workspace having some unrelated `new` does not make it
          // resolvable. Mirrors the predicate stats() applies to live rows.
          const qualified = String(r.qualifiedName ?? '');
          if (qualified === '' && definedNames.has(String(r.name))) retiredMisses += 1;
        }
        continue;
      }
      for (const toId of resolved.ids) {
        edges.push({ fromId: Number(r.fromSymbolId), toId, kind: r.kind as EdgeKind, line: Number(r.line), confidence: resolved.confidence, test: Boolean(r.inTest) });
      }
      settled.push(Number(r.id));
      created += resolved.ids.length;
    }

    this.transaction(() => {
      const insEdge = this.stmt(`INSERT INTO Edge(src, dst, kind, line, confidence, test) VALUES(?,?,?,?,?,?)`);
      for (const e of edges) insEdge.run(e.fromId, e.toId, e.kind, e.line, e.confidence, e.test ? 1 : 0);
      if (settled.length > 0) {
        const del = this.stmt(`DELETE FROM PendingRef WHERE id = ?`);
        for (const id of settled) del.run(id);
      }
      // Retired rows are gone but still happened: stats() reports index quality
      // from the pending count, so persist the tally rather than letting
      // `externalRefs` silently read 0.
      if (opts?.retireUnresolved === true) {
        this.run(`INSERT OR REPLACE INTO Meta(key, value) VALUES('retired_refs', ?)`, String(retired));
        this.run(
          `INSERT OR REPLACE INTO Meta(key, value) VALUES('retired_resolvable_misses', ?)`,
          String(retiredMisses)
        );
      }
    });
    return created;
  }

  async listFiles(): Promise<FileRecord[]> {
    return this.all(`SELECT * FROM File`).map(toFileRecord);
  }

  // -- Filename index (non-source files) ---------------------------------------

  async replaceNamedFiles(entries: Array<{ path: string; name: string; mtimeMs: number; size: number }>): Promise<void> {
    this.transaction(() => {
      this.run(`DELETE FROM NamedFile`);
      for (const e of entries) {
        this.run(`INSERT INTO NamedFile(path, name, mtimeMs, size) VALUES(?, ?, ?, ?)`, e.path, e.name, e.mtimeMs, e.size);
      }
    });
  }

  async listNamedFiles(): Promise<NamedFileRecord[]> {
    return this.all(`SELECT * FROM NamedFile ORDER BY path`).map(toNamedFileRecord);
  }

  async findNamedFiles(pattern?: string, opts?: { withPaths?: boolean }): Promise<NamedFileRecord[]> {
    const all = this.all(`SELECT * FROM NamedFile ORDER BY path`).map(toNamedFileRecord);
    if (!pattern) return all;
    const re = globToRegExp(pattern.toLowerCase());
    return all.filter((f) => re.test(f.name.toLowerCase()) || (opts?.withPaths && re.test(f.path.toLowerCase())));
  }

  // -- Symbol lookup -----------------------------------------------------------

  async get(id: number): Promise<SymbolRecord | null> {
    const r = this.one(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.id = ?`, id);
    return r ? toSymbolRecord(r) : null;
  }

  async lookup(nameOrQualified: string): Promise<SymbolRecord[] | AmbiguousSymbol> {
    // Exact `qualified` first, then bare `name` — a qualified hit is a
    // constraint the caller supplied and must win.
    let rows = this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.qualified = ? ORDER BY s.file, s.startLine`, nameOrQualified);
    if (rows.length === 0) {
      rows = this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.name = ? ORDER BY s.file, s.startLine`, nameOrQualified);
    }
    const recs = rows.map(toSymbolRecord);
    if (recs.length > 1) return { ambiguous: true, candidates: recs };
    return recs;
  }

  async outline(path: string): Promise<SymbolRecord[]> {
    return this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.file = ? ORDER BY s.startLine`, path).map(toSymbolRecord);
  }

  async membersOf(parentId: number): Promise<SymbolRecord[]> {
    return this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.parentId = ? ORDER BY s.startLine`, parentId).map(toSymbolRecord);
  }

  // -- Graph queries -----------------------------------------------------------

  async edgesTo(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]> {
    return this.edgesBetween(ids, kinds, 'dst');
  }

  async edgesFrom(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]> {
    return this.edgesBetween(ids, kinds, 'src');
  }

  private edgesBetween(ids: number[], kinds: EdgeKind[], anchor: 'src' | 'dst'): EdgeRecord[] {
    if (ids.length === 0) return [];
    const kindList = kinds.length > 0 ? kinds : REFERENCE_EDGE_KINDS;
    const rows = this.all(
      `SELECT e.src AS fromId, e.dst AS toId, e.kind AS kind, e.line AS line,
              e.confidence AS confidence, e.test AS test
       FROM Edge e
       WHERE e.${anchor} IN (${placeholders(ids.length)}) AND e.kind IN (${placeholders(kindList.length)})`,
      ...ids,
      ...kindList
    );
    return rows.map((r) => ({
      fromId: Number(r.fromId),
      toId: Number(r.toId),
      kind: r.kind as EdgeKind,
      line: Number(r.line ?? 0),
      confidence: (r.confidence as EdgeConfidence) ?? 'resolved',
    }));
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    assertReadOnlySql(sql);
    const values = params ? Object.values(params) : [];
    return this.conn.prepare(sql).all(...values);
  }

  // -- Analysis ----------------------------------------------------------------

  async unreferenced(filter: DeadCodeFilter): Promise<DeadCodeCandidate[]> {
    const conds: string[] = [`s.kind <> 'module'`, `NOT EXISTS (SELECT 1 FROM Edge e WHERE e.dst = s.id AND e.kind IN (${placeholders(REFERENCE_EDGE_KINDS.length)}))`];
    const args: unknown[] = [...REFERENCE_EDGE_KINDS];
    if (filter.pathPrefix) {
      conds.push(`s.file LIKE ?`);
      args.push(`${filter.pathPrefix}%`);
    }
    if (filter.excludePath) {
      conds.push(`s.file NOT LIKE ?`);
      args.push(`${filter.excludePath}%`);
    }
    if (filter.kinds?.length) {
      conds.push(`s.kind IN (${placeholders(filter.kinds.length)})`);
      args.push(...filter.kinds);
    }
    if (filter.includeExported !== true) conds.push(`s.exported = 0`);
    const rows = this.all(
      `SELECT ${SYMBOL_COLS} FROM Symbol s WHERE ${conds.join(' AND ')} ORDER BY s.file, s.startLine`,
      ...args
    );
    const out: DeadCodeCandidate[] = [];
    for (const r of rows) {
      const rec = toSymbolRecord(r);
      // Entry points and test items are not dead code even with zero callers.
      if (ENTRY_POINT_NAMES.has(rec.name)) continue;
      if (isTestPath(rec.file)) continue;
      out.push({ symbol: rec, note: rec.exported ? 'exported' : null });
    }
    const offset = filter.offset ?? 0;
    return out.slice(offset, filter.limit === undefined ? undefined : offset + filter.limit);
  }

  async fileEdges(path: string, direction: 'imports' | 'importers', opts?: { transitive?: boolean; maxDepth?: number; limit?: number }): Promise<FileDep[]> {
    const maxDepth = opts?.transitive === true ? (opts.maxDepth ?? 5) : 1;
    // Breadth-first over DEPENDS_ON, joined through Symbol.file. Each hop is
    // one query; depth is capped so a cyclic graph terminates.
    const seen = new Set<string>([path]);
    const out: FileDep[] = [];
    let frontier = [path];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const [anchor, other] = direction === 'imports' ? ['a', 'b'] : ['b', 'a'];
      const rows = this.all(
        `SELECT DISTINCT ${other}.file AS path, e.line AS line
         FROM Edge e
         JOIN Symbol a ON a.id = e.src
         JOIN Symbol b ON b.id = e.dst
         WHERE e.kind = 'DEPENDS_ON' AND ${anchor}.file IN (${placeholders(frontier.length)}) AND a.file <> b.file`,
        ...frontier
      );
      const next: string[] = [];
      for (const r of rows) {
        const p = String(r.path);
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ path: p, line: Number(r.line ?? 0), depth });
        next.push(p);
      }
      frontier = next;
    }
    return opts?.limit === undefined ? out : out.slice(0, opts.limit);
  }

  async hotspots(query: HotspotQuery): Promise<SymbolRecord[]> {
    const conds = [`s.kind IN ('function','method')`];
    const args: unknown[] = [];
    if (query.pathPrefix) {
      conds.push(`s.file LIKE ?`);
      args.push(`${query.pathPrefix}%`);
    }
    const rows = this.all(
      `SELECT ${SYMBOL_COLS}, COUNT(e.dst) AS fanOut
       FROM Symbol s JOIN Edge e ON e.src = s.id AND e.kind = 'CALLS'
       WHERE ${conds.join(' AND ')}
       GROUP BY s.id
       HAVING fanOut >= ?
       ORDER BY fanOut DESC, s.file, s.startLine`,
      ...args,
      query.threshold ?? 1
    );
    const offset = query.offset ?? 0;
    return rows.slice(offset, query.limit === undefined ? undefined : offset + query.limit).map(toSymbolRecord);
  }

  async untested(filter: { pathPrefix?: string; excludePath?: string; limit?: number; offset?: number }): Promise<SymbolRecord[]> {
    const conds = [`s.exported = 1`, `s.kind <> 'module'`];
    const args: unknown[] = [];
    if (filter.pathPrefix) {
      conds.push(`s.file LIKE ?`);
      args.push(`${filter.pathPrefix}%`);
    }
    if (filter.excludePath) {
      conds.push(`s.file NOT LIKE ?`);
      args.push(`${filter.excludePath}%`);
    }
    // No incoming edge from a test-file symbol at depth 1 (direct callers only).
    conds.push(
      `NOT EXISTS (SELECT 1 FROM Edge e JOIN Symbol t ON t.id = e.src
                   WHERE e.dst = s.id AND regexp_matches(t.file, ?))`
    );
    args.push(TEST_PATH_REGEX);
    const rows = this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE ${conds.join(' AND ')} ORDER BY s.file, s.startLine`, ...args);
    const out = rows.map(toSymbolRecord).filter((s) => !isTestPath(s.file) && !ENTRY_POINT_NAMES.has(s.name));
    const offset = filter.offset ?? 0;
    return out.slice(offset, filter.limit === undefined ? undefined : offset + filter.limit);
  }

  async findCycles(opts: { edge: EdgeKind; scope: 'module' | 'type'; pathPrefix?: string; limit?: number; confirmedOnly?: boolean; excludeTest?: boolean }): Promise<string[][]> {
    // One query for the edge list, Tarjan in JS — same shape as the Kuzu
    // store (neither backend has a native SCC procedure).
    const conds = [`e.kind = ?`, `a.file <> b.file`];
    const args: unknown[] = [opts.edge];
    if (opts.confirmedOnly === true) conds.push(`e.confidence <> 'fuzzy'`);
    if (opts.excludeTest === true) conds.push(`COALESCE(e.test, 0) = 0`);
    if (opts.pathPrefix) {
      conds.push(`a.file LIKE ? AND b.file LIKE ?`);
      args.push(`${opts.pathPrefix}%`, `${opts.pathPrefix}%`);
    }
    const rows = this.all(
      `SELECT DISTINCT a.file AS af, b.file AS bf, a.qualified AS aq, b.qualified AS bq
       FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst
       WHERE ${conds.join(' AND ')}`,
      ...args
    );
    const nodeOf = (file: string, qualified: string): string => (opts.scope === 'module' ? file : qualified);
    const adj = new Map<string, Set<string>>();
    for (const r of rows) {
      const from = nodeOf(String(r.af), String(r.aq ?? ''));
      const to = nodeOf(String(r.bf), String(r.bq ?? ''));
      if (!from || !to || from === to) continue; // self-cycles suppressed
      const set = adj.get(from) ?? new Set<string>();
      set.add(to);
      adj.set(from, set);
    }
    const cycles = tarjanScc(adj).filter((c) => c.length >= 2);
    cycles.sort((x, y) => y.length - x.length || (x[0] ?? '').localeCompare(y[0] ?? ''));
    return opts.limit === undefined ? cycles : cycles.slice(0, opts.limit);
  }

  async stats(): Promise<IndexStats> {
    const num = (sql: string, ...a: unknown[]): number => Number(this.one(sql, ...a)?.c ?? 0);
    const files = num(`SELECT COUNT(*) AS c FROM File`);
    const symbols = num(`SELECT COUNT(*) AS c FROM Symbol WHERE kind <> 'module'`);
    const edges = num(`SELECT COUNT(*) AS c FROM Edge WHERE kind IN (${placeholders(REFERENCE_EDGE_KINDS.length)})`, ...REFERENCE_EDGE_KINDS);
    const parkedRefs = num(`SELECT COUNT(*) AS c FROM PendingRef`);
    // Refs the full-index pass proved external and deleted (see resolvePending's
    // retireUnresolved). They are real unresolved references and must keep
    // counting, or dropping the rows would make the index look more resolved
    // than it is.
    const retiredRefs = Number(this.one(`SELECT value FROM Meta WHERE key = 'retired_refs'`)?.value ?? 0) || 0;
    const pendingRefs = parkedRefs + retiredRefs;

    const lastIndexedAt = this.one(`SELECT MAX(indexedAt) AS c FROM File`)?.c ?? null;

    const byKind: Partial<Record<SymbolKind, number>> = {};
    for (const r of this.all(`SELECT kind, COUNT(*) AS c FROM Symbol WHERE kind <> 'module' GROUP BY kind`)) {
      byKind[r.kind as SymbolKind] = Number(r.c);
    }

    const totalRefs = edges + pendingRefs;
    const unresolvedRatio = totalRefs > 0 ? pendingRefs / totalRefs : 0;

    // A pending ref is a genuine miss only if the workspace could plausibly
    // satisfy it. A *qualified* ref (`Vec::new`) is never a miss on name alone:
    // the workspace having some unrelated `new` doesn't make `Vec::new`
    // resolvable. Retired refs were proven external, so they are not misses.
    const liveResolvableMisses = num(
      `SELECT COUNT(*) AS c FROM PendingRef p
       WHERE p.qualifiedName = ''
         AND EXISTS (SELECT 1 FROM Symbol s WHERE s.name = p.name AND s.kind <> 'module')`
    );
    // Retired rows were classified at retirement time (see resolvePending);
    // their names are deleted, so they cannot be re-tested here.
    const retiredResolvableMisses =
      Number(this.one(`SELECT value FROM Meta WHERE key = 'retired_resolvable_misses'`)?.value ?? 0) || 0;
    const resolvableMisses = liveResolvableMisses + retiredResolvableMisses;

    const fuzzy = num(`SELECT COUNT(*) AS c FROM Edge WHERE confidence = 'fuzzy' AND kind IN (${placeholders(REFERENCE_EDGE_KINDS.length)})`, ...REFERENCE_EDGE_KINDS);
    const resolvedEdges = edges - fuzzy;

    return {
      files,
      symbols,
      edges,
      pendingRefs,
      unresolvedRatio,
      externalRefs: pendingRefs - resolvableMisses,
      resolvableMisses,
      fuzzyRate: fuzzy + resolvedEdges > 0 ? fuzzy / (fuzzy + resolvedEdges) : 0,
      lastIndexedAt: lastIndexedAt === null ? null : Number(lastIndexedAt),
      byKind,
    };
  }

  /**
   * Merge the WAL into the main database file. SQLite checkpoints
   * automatically, but an explicit TRUNCATE keeps `.pairs/index.db-wal` from
   * lingering at its high-water mark between sessions.
   */
  async checkpoint(): Promise<void> {
    if (this.disposed) return;
    this.conn.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stmts.clear();
    // Unlike Kuzu (which segfaulted on close), SQLite closes cleanly — so the
    // store actually releases its file lock and a second process can open the
    // index.
    try {
      this.conn.close();
    } catch {
      /* already closed */
    }
  }
}

/** Tarjan's SCC, iterative so a deep dependency chain can't overflow the stack. */
function tarjanScc(adj: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const nodes = new Set<string>(adj.keys());
  for (const targets of adj.values()) for (const t of targets) nodes.add(t);

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ v: string; next: number }> = [{ v: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succs = [...(adj.get(frame.v) ?? [])];
      if (frame.next < succs.length) {
        const w = succs[frame.next]!;
        frame.next++;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === frame.v) break;
          }
          out.push(comp.sort());
        }
      }
    }
  }
  return out;
}

export const sqliteCodeStoreFactory: CodeStoreFactory = {
  open: (dbPath: string) => SqliteCodeStore.open(dbPath, nodeSqlDriver),
};
