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
import { bareName, baseOf, maxTypoDistance, rankClosestPaths, rankNameSuggestions } from './nameSuggest';
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
 * In-memory mirror of the symbol table: resolution is pure lookup and the
 * round-trips it used to make dominated index time.
 *
 * Each symbol is stored once per map it participates in, as a number — there
 * is deliberately no per-symbol object and no second copy of (name, path):
 * "name → (id, path)" is derived from `byName` + `pathById`, and removing a
 * file's entries re-reads that file's (id, name, qualified) rows from SQLite
 * (see mirrorEntriesOf) instead of keeping an `entriesByFile` shadow copy.
 */
interface SymbolIndex {
  byQualified: Map<string, number[]>;
  byName: Map<string, number[]>;
  /** Suffix probes: `::x::y` → ids. */
  byQualifiedSuffix: Map<string, number[]>;
  /** id → qualified, for the `use`-specifier narrowing rung. */
  qualifiedById: Map<number, string>;
  /** id → declaring file path (interned: one string per file), for the confidence gate and path probes. */
  pathById: Map<number, string>;
  /** file path → that file's module symbol id (module symbols stay out of the name maps). */
  moduleIdByPath: Map<string, number>;
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

/**
 * SQLite caps host parameters at 999 on older builds (SQLITE_MAX_VARIABLE_NUMBER)
 * — every variable-length `IN (...)` chunks at 500.
 */
const ID_CHUNK = 500;
/** PendingRef rows decided and written per transaction in resolvePending's full pass. */
const PENDING_CHUNK = 5000;
const PENDING_COLS = `id, fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, selfReceiver, receiverType, inTest`;

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
      // The mirror is patched inside transactions; a rollback leaves it ahead
      // of the database. Drop it — it rebuilds lazily from the committed rows.
      this.invalidateSymbolIndex();
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

  private pragmaNumber(name: string): number {
    const row = this.conn.prepare(`PRAGMA ${name}`).get();
    return row ? Number(Object.values(row)[0] ?? 0) : 0;
  }

  private resetSync(): void {
    this.invalidateSymbolIndex();
    this.stmts.clear();
    // DROP and recreate rather than DELETE: a schema-version bump can change
    // table shape, and deleting rows from an old-shaped table leaves later
    // INSERTs binding against missing columns.
    for (const t of ALL_TABLES) this.conn.exec(`DROP TABLE IF EXISTS ${t}`);
    // Dropped pages are only freelisted — without this the file keeps its
    // high-water mark forever, even across `--rebuild`. VACUUM (cheap now: the
    // database is empty) rewrites it to its minimum size, and doubles as the
    // one-time conversion of a pre-existing file to auto_vacuum=INCREMENTAL
    // (the mode can only change via VACUUM; brand-new files get it in the
    // driver). Must run outside a transaction.
    if (this.pragmaNumber('auto_vacuum') !== 2) this.conn.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.conn.exec('VACUUM');
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
    idx.qualifiedById.set(e.id, e.qualified);
    idx.pathById.set(e.id, e.path);
    const segs = e.qualified.split('::');
    for (let i = 1; i < segs.length; i++) push(idx.byQualifiedSuffix, segs.slice(i).join('::'), e.id);
  }

  /** `name` → (id, declaring path) for every candidate, derived from byName + pathById (insertion order preserved). */
  private static namesWithPath(idx: SymbolIndex, name: string): Array<{ id: number; path: string }> {
    const ids = idx.byName.get(name);
    if (!ids) return [];
    return ids.map((id) => ({ id, path: idx.pathById.get(id) ?? '' }));
  }

  /**
   * Drop a file's symbols from the mirror (inverse of indexAdd). `entries` are
   * the file's non-module symbol rows as they are in SQLite right now — callers
   * read them BEFORE deleting the rows, so the mirror needs no shadow copy of
   * its own contents.
   */
  private static indexRemoveEntries(idx: SymbolIndex, path: string, entries: Array<{ id: number; name: string; qualified: string }>): void {
    idx.moduleIdByPath.delete(path);
    if (entries.length === 0) return;
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
    }
  }

  /** The file's non-module symbols as SQLite has them now (what the mirror holds for it). */
  private mirrorEntriesOf(fileId: number): Array<{ id: number; name: string; qualified: string }> {
    return this.all(`SELECT id, name, qualified FROM Symbol WHERE fileId = ? AND kind <> 'module'`, fileId).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      qualified: String(r.qualified ?? ''),
    }));
  }

  private loadSymbolIndex(): SymbolIndex {
    if (this.symbolIndex) return this.symbolIndex;
    const idx: SymbolIndex = {
      byQualified: new Map(),
      byName: new Map(),
      byQualifiedSuffix: new Map(),
      qualifiedById: new Map(),
      pathById: new Map(),
      moduleIdByPath: new Map(),
    };
    // Every row of a file carries its own copy of the path string; intern them
    // so pathById holds one string per file, not one per symbol.
    const paths = new Map<string, string>();
    const intern = (p: string): string => {
      const hit = paths.get(p);
      if (hit !== undefined) return hit;
      paths.set(p, p);
      return p;
    };
    for (const r of this.stmt(`SELECT id, name, qualified, file FROM Symbol WHERE kind <> 'module'`).iterate()) {
      SqliteCodeStore.indexAdd(idx, {
        id: Number(r.id),
        name: String(r.name),
        qualified: String(r.qualified ?? ''),
        path: intern(String(r.file)),
      });
    }
    // Module symbols: kept out of the name maps (they'd pollute every bare-name
    // lookup) but needed as the endpoint of path-style import edges. Lowest id
    // per file = the root module symbol the extractor emits first; inline
    // `mod`s get higher ids and must not displace it.
    for (const r of this.all(`SELECT file, MIN(id) AS id FROM Symbol WHERE kind = 'module' GROUP BY file`)) {
      idx.moduleIdByPath.set(intern(String(r.file)), Number(r.id));
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
   *
   * What an edge row cannot tell us is how the original ref was written
   * (selfReceiver / receiverType are not stored on Edge). The two cases that
   * matter for precision are recovered from the (caller, target) qualified
   * names instead, and only for `resolved` CALLS edges (a fuzzy edge keeps the
   * plain methodCall=1 cap — the safe direction):
   *  - selfReceiver: the target's qualified name is `<caller's scope><sep><name>`,
   *    i.e. the target is a sibling member of the caller's own type.
   *  - receiverType: the target's qualified name is `<Type>.<name>` (TS-style
   *    dotted members) — re-parking with that Type reproduces the typed-receiver
   *    rung's answer instead of degrading to a name-only fuzzy fan-out when the
   *    method name is not unique workspace-wide.
   * Anything else (e.g. a receiverType whose target was found by another rung)
   * re-parks bare, exactly as before, so it resolves by the ordinary ladder.
   */
  private reparkIncomingRefs(fileId: number): void {
    const rows = this.all(
      `SELECT a.id AS fromId, a.fileId AS fromFileId, a.qualified AS callerQualified,
              s.name AS name, s.qualified AS qualified, s.kind AS targetKind,
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
      `INSERT INTO PendingRef(fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, selfReceiver, receiverType, inTest)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of rows) {
      const q = String(r.qualified ?? '');
      const name = String(r.name);
      const kind = String(r.kind);
      const fuzzy = String(r.conf) === 'fuzzy';
      let qualifiedName = q.includes('::') ? q : '';
      // An import edge lands on the target file's MODULE symbol (qualified =
      // its path, name = file name), which no name rung can ever find. Park it
      // as a path import (DEPENDS_ON + qualifiedName) so resolvePending retries
      // it through resolveImportPath once the target is re-indexed.
      if (kind === 'DEPENDS_ON' && String(r.targetKind) === 'module') qualifiedName = q;
      let methodCall = fuzzy ? 1 : 0;
      let selfReceiver = 0;
      let receiverType: string | null = null;
      if (!fuzzy && kind === 'CALLS' && String(r.targetKind) !== 'module') {
        const callerQ = String(r.callerQualified ?? '');
        const sep = callerQ.includes('::') ? '::' : '.';
        const callerSegs = callerQ.split(sep);
        if (callerSegs.length > 1 && q === `${callerSegs.slice(0, -1).join(sep)}${sep}${name}`) {
          selfReceiver = 1;
          methodCall = 1;
        } else if (q.endsWith(`.${name}`) && q.length > name.length + 1 && !q.includes('::')) {
          receiverType = q.slice(0, -(name.length + 1));
          methodCall = 1;
        }
      }
      ins.run(Number(r.fromFileId), Number(r.fromId), name, qualifiedName, kind, Number(r.line ?? 0), methodCall, selfReceiver, receiverType, r.test ? 1 : 0);
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
    let oldMirrorEntries: Array<{ id: number; name: string; qualified: string }> = [];
    if (existing) {
      fileId = Number(existing.id);
      this.reparkIncomingRefs(fileId);
      // The mirror patch below needs the OLD symbols' (id, name, qualified);
      // read them before the rows go.
      if (this.symbolIndex) oldMirrorEntries = this.mirrorEntriesOf(fileId);
      this.deleteFileEdges(fileId);
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

    // `ON CONFLICT DO UPDATE` (not plain OR IGNORE): a `fuzzy` row may already
    // sit on disk for this exact (src,dst,kind,line) from an earlier pass —
    // see resolvePending's insEdge for the full rationale. Only ever upgrades
    // fuzzy -> resolved, never the reverse.
    const insEdge = this.stmt(`
      INSERT INTO Edge(src, dst, kind, line, confidence, test) VALUES(?,?,?,?,?,?)
      ON CONFLICT(src, dst, kind, line) DO UPDATE SET confidence = 'resolved'
      WHERE excluded.confidence = 'resolved' AND Edge.confidence = 'fuzzy'
    `);
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
      SqliteCodeStore.indexRemoveEntries(this.symbolIndex, extraction.path, oldMirrorEntries);
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
        callerQualified,
        ref.receiverType ?? null
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
        `INSERT INTO PendingRef(fileId, fromSymbolId, name, qualifiedName, kind, line, methodCall, selfReceiver, receiverType, inTest)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
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
          ref.receiverType ?? null,
          ref.inTest === true ? 1 : 0
        );
      }
    }

    return toFileRecord(this.one(`SELECT * FROM File WHERE id = ?`, fileId)!);
  }

  async removeFile(path: string): Promise<void> {
    const r = this.one(`SELECT id FROM File WHERE path = ?`, path);
    if (!r) {
      if (this.symbolIndex) this.symbolIndex.moduleIdByPath.delete(path);
      return;
    }
    const fileId = Number(r.id);
    this.transaction(() => {
      if (this.symbolIndex) SqliteCodeStore.indexRemoveEntries(this.symbolIndex, path, this.mirrorEntriesOf(fileId));
      this.reparkIncomingRefs(fileId); // referrers keep their claim
      this.run(`DELETE FROM PendingRef WHERE fileId = ?`, fileId);
      this.deleteFileEdges(fileId);
      this.run(`DELETE FROM Symbol WHERE fileId = ?`, fileId);
      this.run(`DELETE FROM File WHERE id = ?`, fileId);
    });
  }

  /**
   * Delete every Edge row touching file `fileId`'s symbols, plus the file's
   * DECLARES edges. Edge has no FK (a DECLARES edge's src is a *File* id), and
   * the old single `src IN (...) OR dst IN (...)` delete could not use an
   * index for both arms — so it is two statements, each on its own index
   * (Edge primary key for src, idx_edge_dst for dst).
   *
   * The src arm excludes DECLARES: its src is a file id, and a file id can
   * numerically equal one of this file's SYMBOL ids, which would otherwise
   * delete an unrelated file's DECLARES edges. This file's own DECLARES edges
   * go via the dst arm (their dst is this file's symbols) and the explicit
   * file-id delete below.
   */
  private deleteFileEdges(fileId: number): void {
    this.run(`DELETE FROM Edge WHERE kind <> 'DECLARES' AND src IN (SELECT id FROM Symbol WHERE fileId = ?)`, fileId);
    this.run(`DELETE FROM Edge WHERE dst IN (SELECT id FROM Symbol WHERE fileId = ?)`, fileId);
    this.run(`DELETE FROM Edge WHERE kind = 'DECLARES' AND src = ?`, fileId);
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
    callerQualified: string | null = null,
    receiverType: string | null = null,
    /**
     * True only when every file in the workspace has already declared its
     * symbols — i.e. during resolvePending's full pass, never during
     * applyExtraction's inline per-file resolve. Full-index runs files
     * through applyExtraction IN PARALLEL, so "unique workspace-wide" is
     * meaningless mid-pass: a method call can land on whichever same-named
     * method happened to index first, before its true rival (or the
     * receiver's real declared type) exists yet — and unlike a parked ref, a
     * wrongly `resolved` edge is never revisited. Both the Step 2.1
     * uniqueness gate and the Step 2.3 declared-type rung below require this.
     */
    fullPass = false
  ): { ids: number[]; confidence: 'resolved' | 'fuzzy' } | 'unresolved' {
    const idx = this.loadSymbolIndex();

    /**
     * Confidence gate (R1: `resolved` must be trustworthy — rules only fail CI
     * on confirmed findings):
     *  1. A bare METHOD call (`x.foo()`) caps at `fuzzy` unless its one
     *     candidate's name is unique workspace-wide (`idx.byName` holding a
     *     single entry for that name) — the receiver's static type is still
     *     unknown, but a name no other symbol shares cannot land on a
     *     different target than the one candidate, so `resolved` is safe.
     *     Any other case (multiple namesakes anywhere) stays capped: the true
     *     target may be outside the graph (derive impls, trait defaults).
     *  2. A resolution landing in a DIFFERENT crate caps at `fuzzy` unless a
     *     `use` specifier corroborates it. Same-named symbols across sibling
     *     crates otherwise resolve "confirmed" onto the wrong crate: on ripgrep
     *     this leaked 200+ false confirmed layering violations.
     */
    const gate = (out: { ids: number[]; confidence: 'resolved' | 'fuzzy' }): { ids: number[]; confidence: 'resolved' | 'fuzzy' } => {
      if (out.confidence === 'fuzzy') return out;
      if (methodCall) {
        const uniqueWorkspaceWide = fullPass && out.ids.length === 1 && (idx.byName.get(name)?.length ?? 0) === 1;
        if (!uniqueWorkspaceWide) return { ids: out.ids, confidence: 'fuzzy' };
      }
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

    // A plain (non-self) method call that could benefit from full-workspace
    // knowledge — either Step 2.1's uniqueness gate or Step 2.3's declared-
    // type rung — is parked during the inline per-file pass rather than
    // resolved fuzzy right away, so it gets one real shot at `resolved` once
    // resolvePending's full pass runs with fullPass=true. Resolving it fuzzy
    // now would be final: an edge, once written, is never revisited.
    if (methodCall && !fullPass) return 'unresolved';

    // Rung 0.5: declared local type (Step 2.3, TypeScript only). A method
    // call whose receiver is a parameter or `const`/`let` with a written
    // type annotation (`function f(x: Widget) { x.foo() }`) has a known
    // static type, so looking `foo` up among that type's own members is a
    // genuine disambiguation — unlike Rung 0 this doesn't require the
    // receiver to BE the enclosing type, and unlike the Step 2.1 workspace
    // uniqueness gate it can resolve a name that is not unique workspace-wide,
    // as long as the type has exactly one member by that name.
    //
    // Only trusted once every file has declared (see `fullPass`) — during the
    // parallel inline pass, "type known" / "type has no such member" are both
    // unreliable: the type's own file may simply not have indexed yet.
    if (methodCall && receiverType && fullPass) {
      const typeKnown = idx.byQualified.has(receiverType) || idx.byName.has(receiverType);
      if (typeKnown) {
        const candidates = idx.byQualified.get(`${receiverType}.${name}`);
        if (candidates !== undefined) {
          return { ids: [...candidates], confidence: candidates.length === 1 ? 'resolved' : 'fuzzy' };
        }
        // Type is known but has no such member: annotation may be stale or
        // the method is inherited — fall through to the ordinary ladder.
      } else {
        return 'unresolved';
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
        const byModule = SqliteCodeStore.namesWithPath(idx, name).filter((c) => c.path === fileSuffix || c.path.endsWith(`/${fileSuffix}`));
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
      const local = SqliteCodeStore.namesWithPath(idx, name).filter((c) => c.path === fromPath);
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

  /**
   * `fullPass` defaults true: every call site to this method runs after the
   * rest of the workspace has already declared (either the full-index worker
   * pool has finished, or — for a single-file incremental re-index — every
   * OTHER file was already indexed in a prior run). Only applyExtraction's
   * inline resolve, mid-parallel-pass, needs `fullPass: false`.
   *
   * Scope: `namesHint` and/or `opts.filePaths` select a subset of PendingRef
   * (rows whose name is hinted UNION rows owned by those files); with neither,
   * every parked ref is retried.
   *
   * Memory: the full pass never holds the whole table. Refs whose name no
   * workspace symbol declares are retired in one SQL statement (see
   * retireUndeclaredPending); the rest are processed PENDING_CHUNK rows at a
   * time, each chunk decided and written in its own transaction.
   */
  async resolvePending(namesHint?: string[], opts?: { retireUnresolved?: boolean; filePaths?: string[] }): Promise<number> {
    const names = namesHint ?? [];
    const filePaths = opts?.filePaths ?? [];
    const scoped = names.length > 0 || filePaths.length > 0;
    const retire = opts?.retireUnresolved === true;

    let scopedRows: Record<string, unknown>[] = [];
    if (scoped) {
      scopedRows = this.scopedPendingRows(names, filePaths);
      if (scopedRows.length === 0) return 0;
    } else if (this.one(`SELECT 1 AS x FROM PendingRef LIMIT 1`) === undefined) {
      return 0;
    }

    const idx = this.loadSymbolIndex();

    // Per-file facts, fetched lazily for just the files a chunk touches.
    const pathByFileId = new Map<number, string>();
    // Each file's externally-bound names, recorded at extraction time (see
    // applyExtractionInner). A ref that parks in phase A is re-resolved here,
    // so without this the guard is bypassed on the second pass and the binding
    // it prevented happens anyway — which is exactly how vitest's `expect`
    // reached Parser.expect as `resolved`.
    const externalByFile = new Map<number, Set<string>>();
    const loadFileFacts = (fileIds: number[]): void => {
      const missing = [...new Set(fileIds)].filter((id) => !pathByFileId.has(id));
      for (let i = 0; i < missing.length; i += ID_CHUNK) {
        const part = missing.slice(i, i + ID_CHUNK);
        for (const fr of this.all(`SELECT id, path FROM File WHERE id IN (${placeholders(part.length)})`, ...part)) {
          pathByFileId.set(Number(fr.id), String(fr.path));
        }
        for (const r of this.all(`SELECT fileId, name FROM ExternalName WHERE fileId IN (${placeholders(part.length)})`, ...part)) {
          const fileId = Number(r.fileId);
          let set = externalByFile.get(fileId);
          if (set === undefined) externalByFile.set(fileId, (set = new Set<string>()));
          set.add(String(r.name));
        }
      }
    };

    // Used at the moment a row is retired: a genuine miss (we HAVE this symbol
    // but failed to link it) vs an external ref (npm, stdlib, test globals) —
    // after deletion the name is gone and stats() can no longer tell. Asked per
    // distinct name on demand rather than loading every symbol name up front.
    const declaredCache = new Map<string, boolean>();
    const isDeclared = (name: string): boolean => {
      let hit = declaredCache.get(name);
      if (hit === undefined) {
        hit = this.one(`SELECT 1 AS x FROM Symbol WHERE name = ? AND kind <> 'module' LIMIT 1`, name) !== undefined;
        declaredCache.set(name, hit);
      }
      return hit;
    };

    let created = 0;
    let retired = 0;
    let retiredMisses = 0;
    const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { unresolved: -1, fuzzy: 0, resolved: 1 };
    type PendingEdge = { fromId: number; toId: number; kind: EdgeKind; line: number; confidence: EdgeConfidence; test: boolean };

    const processChunk = (rows: Record<string, unknown>[]): void => {
      loadFileFacts(rows.map((r) => Number(r.fileId)));
      // Decide first, write once per chunk.
      const edges: PendingEdge[] = [];
      const settled: number[] = [];
      // A ref that parks and re-resolves across several `resolvePending` calls
      // (or a single call touching the same site twice) must still produce one
      // edge, not one per pass — mirrors the `seenDep` guard in
      // applyExtractionInner. Keyed on (fromId,toId,kind,line); 'resolved' wins
      // over 'fuzzy' if both are seen for the same key. Cross-chunk repeats are
      // collapsed by the ON CONFLICT upsert below.
      const seenEdge = new Map<string, number>(); // key -> index into edges
      const addEdge = (e: PendingEdge): void => {
        const key = `${e.fromId}|${e.toId}|${e.kind}|${e.line}`;
        const i = seenEdge.get(key);
        if (i === undefined) {
          seenEdge.set(key, edges.length);
          edges.push(e);
          return;
        }
        // Same site resolved twice in this batch: never let a fuzzy hit
        // suppress a resolved one, or vice versa downgrade it.
        if (CONFIDENCE_RANK[e.confidence] > CONFIDENCE_RANK[edges[i]!.confidence]) edges[i] = e;
      };
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
              const before = edges.length;
              addEdge({ fromId: Number(r.fromSymbolId), toId: viaPath, kind: 'DEPENDS_ON', line: Number(r.line), confidence: 'resolved', test: Boolean(r.inTest) });
              if (edges.length > before) created += 1;
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
          callerQualified,
          r.receiverType ? String(r.receiverType) : null,
          true
        );
        if (resolved === 'unresolved') {
          // Full-index pass: every file has declared, so this names something
          // outside the workspace (npm/stdlib/test globals like `it`/`describe`/
          // `String`) and no later file can rescue it. Retire it instead of
          // parking it forever — these rows otherwise accumulate across every
          // re-index and dominate the db file.
          if (retire) {
            settled.push(Number(r.id));
            retired += 1;
            // A *qualified* ref (`Vec::new`) is never a miss on bare name alone —
            // the workspace having some unrelated `new` does not make it
            // resolvable. Mirrors the predicate stats() applies to live rows.
            if (String(r.qualifiedName ?? '') === '' && isDeclared(String(r.name))) retiredMisses += 1;
          }
          continue;
        }
        for (const toId of resolved.ids) {
          const before = edges.length;
          addEdge({ fromId: Number(r.fromSymbolId), toId, kind: r.kind as EdgeKind, line: Number(r.line), confidence: resolved.confidence, test: Boolean(r.inTest) });
          if (edges.length > before) created += 1;
        }
        settled.push(Number(r.id));
      }

      this.transaction(() => {
        // Backstop for the cross-run (and cross-chunk) case the in-memory dedupe
        // above cannot see: a `fuzzy` row may already sit on disk from an
        // earlier pass at the exact (src,dst,kind,line) this pass now resolves
        // with certainty. Plain `INSERT OR IGNORE` would silently lose the
        // 'resolved' outcome. `ON CONFLICT DO UPDATE` upgrades in place
        // instead, and only ever upgrades (fuzzy -> resolved), never the
        // reverse, matching the "fuzzy must never suppress resolved" rule.
        const insEdge = this.stmt(`
          INSERT INTO Edge(src, dst, kind, line, confidence, test) VALUES(?,?,?,?,?,?)
          ON CONFLICT(src, dst, kind, line) DO UPDATE SET confidence = 'resolved'
          WHERE excluded.confidence = 'resolved' AND Edge.confidence = 'fuzzy'
        `);
        for (const e of edges) insEdge.run(e.fromId, e.toId, e.kind, e.line, e.confidence, e.test ? 1 : 0);
        if (settled.length > 0) {
          const del = this.stmt(`DELETE FROM PendingRef WHERE id = ?`);
          for (const id of settled) del.run(id);
        }
      });
    };

    if (scoped) {
      for (let i = 0; i < scopedRows.length; i += PENDING_CHUNK) processChunk(scopedRows.slice(i, i + PENDING_CHUNK));
    } else {
      if (retire) retired += this.retireUndeclaredPending();
      let lastId = 0;
      for (;;) {
        const rows = this.all(`SELECT ${PENDING_COLS} FROM PendingRef WHERE id > ? ORDER BY id LIMIT ?`, lastId, PENDING_CHUNK);
        if (rows.length === 0) break;
        lastId = Number(rows[rows.length - 1]!.id);
        processChunk(rows);
      }
    }

    if (retire) {
      // Retired rows are gone but still happened: stats() reports index quality
      // from the pending count, so persist the tally rather than letting
      // `externalRefs` silently read 0.
      this.transaction(() => {
        this.run(`INSERT OR REPLACE INTO Meta(key, value) VALUES('retired_refs', ?)`, String(retired));
        this.run(`INSERT OR REPLACE INTO Meta(key, value) VALUES('retired_resolvable_misses', ?)`, String(retiredMisses));
      });
    }
    return created;
  }

  /** PendingRef rows a scoped retry covers: name in `names` UNION owned by `filePaths`' files, by id. */
  private scopedPendingRows(names: string[], filePaths: string[]): Record<string, unknown>[] {
    const byId = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < names.length; i += ID_CHUNK) {
      const part = names.slice(i, i + ID_CHUNK);
      for (const r of this.all(`SELECT ${PENDING_COLS} FROM PendingRef WHERE name IN (${placeholders(part.length)})`, ...part)) byId.set(Number(r.id), r);
    }
    const fileIds: number[] = [];
    for (let i = 0; i < filePaths.length; i += ID_CHUNK) {
      const part = filePaths.slice(i, i + ID_CHUNK);
      for (const r of this.all(`SELECT id FROM File WHERE path IN (${placeholders(part.length)})`, ...part)) fileIds.push(Number(r.id));
    }
    for (let i = 0; i < fileIds.length; i += ID_CHUNK) {
      const part = fileIds.slice(i, i + ID_CHUNK);
      for (const r of this.all(`SELECT ${PENDING_COLS} FROM PendingRef WHERE fileId IN (${placeholders(part.length)})`, ...part)) byId.set(Number(r.id), r);
    }
    return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  /**
   * Full-pass shortcut: delete, in SQL, every parked ref that can never
   * resolve because no workspace symbol carries its bare name — these are the
   * bulk of PendingRef (npm / stdlib / test-global calls). Returns the count.
   *
   * Safe because every rung of resolveOneRef needs a non-module symbol whose
   * `name` equals the ref's bare name: Rung 0 (`scope.name` qualified), 0.5
   * (`Type.name`), Rung 1 (qualified/suffix keys ending in `::name` — hence the
   * "qualifiedName ends with ::name" condition, which keeps any ref whose
   * written path tail differs from its bare name), the module-path rung
   * (byName), Rung 2 and Rung 3 (byQualified/byName on `name`; a top-level
   * symbol's qualified IS its name). Not retired here, on purpose:
   *  - parked path imports (DEPENDS_ON with a qualifiedName): they resolve by
   *    FILE PATH to a module symbol (which is excluded from the name maps),
   *    never by name;
   *  - everything, if any symbol's own `name` contains `::` or `.`: then a
   *    qualified key's last segment need not equal a symbol name, so the
   *    name-only argument no longer holds and the (chunked) ladder decides.
   * These rows are, by construction, never "resolvable misses" (their name is
   * undeclared), so the caller counts them as retired only.
   */
  private retireUndeclaredPending(): number {
    const oddName = this.one(`SELECT 1 AS x FROM Symbol WHERE kind <> 'module' AND (instr(name, ':') > 0 OR instr(name, '.') > 0) LIMIT 1`);
    if (oddName !== undefined) return 0;
    const res = this.run(
      `DELETE FROM PendingRef
       WHERE NOT (kind = 'DEPENDS_ON' AND qualifiedName <> '')
         AND (qualifiedName = '' OR substr(qualifiedName, -(length(name) + 2)) = '::' || name)
         AND NOT EXISTS (SELECT 1 FROM Symbol s WHERE s.name = PendingRef.name AND s.kind <> 'module')`
    );
    return Number(res.changes);
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

  /**
   * SQLite caps host parameters at 999 (SQLITE_MAX_VARIABLE_NUMBER) — chunk
   * at 500 so a large `impact` on a real monorepo doesn't exceed it. `IN
   * (...)` returns rows in arbitrary order and omits missing ids, so this
   * builds the id->record map itself rather than leaving positional
   * correspondence to the caller.
   */
  async getMany(ids: number[]): Promise<Map<number, SymbolRecord>> {
    const out = new Map<number, SymbolRecord>();
    const dedupedIds = [...new Set(ids)];
    const CHUNK = ID_CHUNK;
    for (let i = 0; i < dedupedIds.length; i += CHUNK) {
      const chunk = dedupedIds.slice(i, i + CHUNK);
      const rows = this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.id IN (${placeholders(chunk.length)})`, ...chunk);
      for (const r of rows) {
        const rec = toSymbolRecord(r);
        out.set(rec.id, rec);
      }
    }
    return out;
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

  async resolveFilePath(input: string): Promise<{ exact: string } | { matches: string[]; closest: string[] }> {
    const norm = input.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    for (const cand of norm === input ? [input] : [input, norm]) {
      const r = this.one(`SELECT path FROM File WHERE path = ?`, cand);
      if (r) return { exact: String(r.path) };
    }
    if (!norm) return { matches: [], closest: [] };
    const esc = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    // Path-suffix match on a `/` boundary. LIKE is ASCII-case-insensitive, so a
    // case-exact hit (if any) wins over a case-folded one.
    const rows = this.all(`SELECT path FROM File WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 21`, `%/${esc(norm)}`).map((r) => String(r.path));
    const exactCase = rows.filter((p) => p.endsWith(`/${norm}`));
    const matches = exactCase.length > 0 ? exactCase : rows;
    if (matches.length === 1) return { exact: matches[0]! };
    if (matches.length > 1) return { matches, closest: [] };

    // Miss: offer the paths with the nearest basenames. Bounded candidate set.
    const base = baseOf(norm);
    const stem = base.replace(/\.[^.]*$/, '');
    let cands: string[] = [];
    if (stem.length >= 2) {
      cands = this.all(`SELECT path FROM File WHERE path LIKE ? ESCAPE '\\' LIMIT 200`, `%${esc(stem)}%`).map((r) => String(r.path));
    }
    if (cands.length === 0 && base.length > 0) {
      cands = this.all(`SELECT path FROM File WHERE path LIKE ? ESCAPE '\\' LIMIT 2000`, `%/${esc(base[0]!)}%`).map((r) => String(r.path));
    }
    return { matches: [], closest: rankClosestPaths(norm, cands, 3) };
  }

  async suggestNames(name: string, limit = 5): Promise<string[]> {
    const q = bareName(name);
    if (!q) return [];
    const esc = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    const cands = new Set<string>();
    // Equal-ignoring-case / prefix / substring in one bounded scan.
    const like = q.length >= 3 ? `%${esc(q)}%` : `${esc(q)}%`;
    for (const r of this.all(`SELECT DISTINCT name FROM Symbol WHERE name LIKE ? ESCAPE '\\' LIMIT 300`, like)) cands.add(String(r.name));
    // Typos: same first letter, similar length. Capped so a huge repo never loads every symbol.
    const d = maxTypoDistance(q.length);
    const first = q[0]!.toLowerCase();
    for (const r of this.all(
      `SELECT DISTINCT name FROM Symbol WHERE LOWER(SUBSTR(name, 1, 1)) = ? AND LENGTH(name) BETWEEN ? AND ? LIMIT 2000`,
      first,
      Math.max(1, q.length - d),
      q.length + d
    )) {
      cands.add(String(r.name));
    }
    return rankNameSuggestions(name, cands, limit);
  }

  async membersOf(parentId: number): Promise<SymbolRecord[]> {
    return this.all(`SELECT ${SYMBOL_COLS} FROM Symbol s WHERE s.parentId = ? ORDER BY s.startLine`, parentId).map(toSymbolRecord);
  }

  async grepSymbols(
    pattern: string,
    opts?: { isRegex?: boolean; kinds?: SymbolKind[]; pathPrefix?: string; limit?: number }
  ): Promise<SymbolRecord[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts?.kinds?.length) {
      conds.push(`s.kind IN (${placeholders(opts.kinds.length)})`);
      params.push(...opts.kinds);
    }
    if (opts?.pathPrefix) {
      conds.push(`s.file LIKE ? ESCAPE '\\'`);
      params.push(`${opts.pathPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const limit = opts?.limit ?? 50;
    let matcher: (text: string) => boolean;
    if (opts?.isRegex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch (err) {
        throw new Error(`Invalid regex: ${(err as Error).message}`);
      }
      matcher = (text) => re.test(text);
    } else {
      // Plain substring: SQL does the filtering (and the LIMIT), so the Symbol
      // table is never materialized. LIKE is case-insensitive for ASCII; JS
      // re-checks with toLowerCase().includes() so non-ASCII letters (which
      // LIKE would not fold) are matched identically to before — SQL is only a
      // PRE-filter that must not exclude a real hit, hence both stay.
      const needle = pattern.toLowerCase();
      const like = `%${pattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      // A non-ASCII needle: LIKE's ASCII-only folding could miss `É` vs `é`,
      // so skip the SQL pre-filter and let JS decide (still streamed, not mapped).
      if (/^[\x00-\x7f]*$/.test(pattern)) {
        conds.push(
          `(s.name LIKE ? ESCAPE '\\' OR s.qualified LIKE ? ESCAPE '\\' OR s.signature LIKE ? ESCAPE '\\' OR s.doc LIKE ? ESCAPE '\\')`
        );
        params.push(like, like, like, like);
      }
      matcher = (text) => text.toLowerCase().includes(needle);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const sql = `SELECT ${SYMBOL_COLS} FROM Symbol s ${where} ORDER BY s.file, s.startLine`;
    const out: SymbolRecord[] = [];
    // Streamed: rows are tested as they arrive and the scan stops at `limit`,
    // so neither path maps (or holds) the rest of the table.
    for (const r of this.stmt(sql).iterate(...params)) {
      // Matched per-field, not one joined string: a regex like `^getFoo$`
      // must anchor to a single field (the name), not to the start/end of a
      // multi-line join of name+qualified+signature+doc.
      if (matcher(String(r.name)) || matcher(String(r.qualified ?? '')) || matcher(String(r.signature ?? '')) || matcher(String(r.doc ?? ''))) {
        out.push(toSymbolRecord(r));
        if (out.length >= limit) break;
      }
    }
    return out;
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
    const out: EdgeRecord[] = [];
    // Chunked like getMany: the id list plus the kind list must stay under the
    // host-parameter cap, and a big `impact` frontier easily exceeds it.
    const chunkSize = Math.max(1, ID_CHUNK - kindList.length);
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const rows = this.all(
        `SELECT e.src AS fromId, e.dst AS toId, e.kind AS kind, e.line AS line,
                e.confidence AS confidence, e.test AS test
         FROM Edge e
         WHERE e.${anchor} IN (${placeholders(chunk.length)}) AND e.kind IN (${placeholders(kindList.length)})`,
        ...chunk,
        ...kindList
      );
      for (const r of rows) {
        out.push({
          fromId: Number(r.fromId),
          toId: Number(r.toId),
          kind: r.kind as EdgeKind,
          line: Number(r.line ?? 0),
          confidence: (r.confidence as EdgeConfidence) ?? 'resolved',
          test: Boolean(r.test),
        });
      }
    }
    return out;
  }

  async query(sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    assertReadOnlySql(sql);
    const values = params ? Object.values(params) : [];
    return this.conn.prepare(sql).all(...values);
  }

  // -- Analysis ----------------------------------------------------------------

  /**
   * Symbol kinds `unreferenced()` must never report: the extractor emits no
   * reference edge that could EVER land on this kind, so "zero incoming
   * edges" proves nothing — it's not evidence of dead code, just an
   * unmeasurable gap. `field` is read/written only through READS/WRITES
   * (e.g. `this.x`), and this extractor emits neither (measured: `SELECT
   * kind, COUNT(*) FROM Edge WHERE kind IN ('READS','WRITES','OF_TYPE')`
   * returns zero rows for all three, on this repo). A constructor-injected
   * private field used throughout its class would otherwise show up as dead
   * on every single run.
   */
  private static readonly DEAD_CODE_UNPROVABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['field']);

  /**
   * Same "unprovable, not proven dead" reasoning as DEAD_CODE_UNPROVABLE_KINDS,
   * but keyed on name rather than kind: a `constructor` is a `method` (no
   * distinct SymbolKind), yet `new X(...)` never emits a CALLS/reference edge
   * to it either — verified on this repo: every constructor's only incoming
   * edges are the structural DECLARES/OWNS pair, never a reference kind, even
   * for constructors called from real, indexed `new X(...)` sites (e.g.
   * IndexerImpl, ParserRegistryImpl, WatchQueue, SqliteCodeStore all had zero
   * reference edges to their constructor despite being constructed in
   * adapters/cli and adapters/vscode).
   */
  private static isUnprovableByName(rec: SymbolRecord): boolean {
    return rec.kind === 'method' && rec.name === 'constructor';
  }

  /**
   * Symbol kinds that CAN sometimes be proven referenced (unlike
   * DEAD_CODE_UNPROVABLE_KINDS) but only through an edge kind that covers
   * part of their real usage — so a survivor here is unproven, not proven
   * dead, and gets a qualifying note instead of exclusion. An `interface`
   * gets an IMPLEMENTS edge when a class implements it, but the far more
   * common case — used purely as a parameter/return type annotation — needs
   * OF_TYPE/REFERENCES, which this extractor never emits either. Excluding
   * `interface` outright would hide a genuinely dead, never-implemented
   * interface in a codebase where IMPLEMENTS edges exist for other
   * interfaces; labeling instead keeps it in the list without overclaiming.
   */
  private static readonly DEAD_CODE_TYPE_ONLY_KINDS: ReadonlySet<SymbolKind> = new Set(['interface']);

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
      if (SqliteCodeStore.DEAD_CODE_UNPROVABLE_KINDS.has(rec.kind)) continue;
      if (SqliteCodeStore.isUnprovableByName(rec)) continue;
      const note = rec.exported ? 'exported' : SqliteCodeStore.DEAD_CODE_TYPE_ONLY_KINDS.has(rec.kind) ? 'type-only' : null;
      out.push({ symbol: rec, note });
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

  // -- Contract helpers (touch / count / caches / compact) ---------------------

  /** Refresh stat metadata only; the content (hash) is untouched. No-op for unknown paths. */
  async touchFile(path: string, mtimeMs: number, size: number): Promise<void> {
    this.run(`UPDATE File SET mtimeMs = ?, size = ? WHERE path = ?`, mtimeMs, size, path);
  }

  async fileCount(): Promise<number> {
    return Number(this.one(`SELECT COUNT(*) AS c FROM File`)?.c ?? 0);
  }

  /**
   * Drop the in-memory symbol mirror and prepared statements. Safe at any
   * point between operations: the mirror is rebuilt lazily from SQLite by the
   * next resolve (loadSymbolIndex), and applyExtraction only patches a mirror
   * that exists — a released store re-reads the already-written rows instead.
   * Statements are re-prepared on demand by `stmt()`.
   */
  releaseCaches(): void {
    this.invalidateSymbolIndex();
    this.stmts.clear();
  }

  /**
   * Return freed pages to the OS. Only meaningful for auto_vacuum=INCREMENTAL
   * files (new databases and converted ones — see resetSync); anything else is
   * left alone. Skipped unless more than 10% of the file is free, so calling it
   * after every index run stays cheap.
   */
  async compact(): Promise<void> {
    if (this.disposed) return;
    if (this.pragmaNumber('auto_vacuum') !== 2) return;
    const total = this.pragmaNumber('page_count');
    const free = this.pragmaNumber('freelist_count');
    if (total === 0 || free / total <= 0.1) return;
    this.conn.exec('PRAGMA incremental_vacuum');
    this.conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Consistent snapshot copy of an index at `srcDbPath` into `dstDbPath`
   * (which must not exist), via `VACUUM INTO` — safe while another process
   * has the source open in WAL mode. Used to seed a fresh git worktree's
   * index from the main worktree's so only changed files need re-parsing.
   */
  static snapshot(srcDbPath: string, dstDbPath: string, driver: SqlDriver): void {
    const conn = driver.open(srcDbPath);
    try {
      conn.exec(`VACUUM INTO '${dstDbPath.replace(/'/g, "''")}'`);
    } finally {
      conn.close();
    }
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
