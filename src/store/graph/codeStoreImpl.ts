/**
 * CodeStore implementation over KuzuDB (Cypher). Lives at `.pairs/index/`
 * (ADR-009) — disposable derived data, single writer (the indexer), no write
 * guards (subsystem_graph_store_spec.md §4).
 *
 * Algorithms ported from vendor/reference-indexer/src/index/codeStoreImpl.ts
 * (SQLite → Cypher): `resolveOneRef`'s qualified-then-name-then-import-scope
 * resolution ladder, `findCycles`'s Tarjan SCC (run in JS over an edge list
 * pulled by one Cypher query — Kuzu has no native SCC procedure), and the
 * dead-code/file-deps/hotspots/untested exclusion rules. Not ported: FTS
 * search, embeddings/similarity (out of PAiRS's scope, see codeStore.ts).
 *
 * Import-target resolution differs from the reference project: Rust `use`
 * paths are crate-qualified names, not relative file paths (unlike JS/Python
 * imports), so there is no `resolveImportTarget`-by-path step here — Rust's
 * `use`-map instead narrows *name* candidates during resolveOneRef (§4.1 of
 * subsystem_indexer_spec.md). `fileEdges` (DEPENDS_ON) is still derived
 * per-file via the reference symbols' file property, no separate import graph.
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
  RawRef,
  SymbolKind,
  SymbolRecord,
} from '../../core/indexer/types';
import { isTestPath } from '../../core/indexer/types';
import type { CodeStore, CodeStoreFactory } from './codeStore';
import { stripCypherLiterals } from './codeStore';
import { REFERENCE_EDGE_TABLES, SCHEMA_DDL, SCHEMA_VERSION, STRUCTURAL_EDGE_TABLES } from './schema';

/** Rust items that are never dead code even with zero incoming edges. */
const ENTRY_POINT_NAMES: ReadonlySet<string> = new Set(['main']);

/**
 * Kuzu always hands back untyped `Record<string, KuzuValue>` rows, so these
 * are deliberately non-generic: a `query<T>()` signature would let callers
 * name any row type and get it back unchecked. Rows are narrowed explicitly
 * by the `to*Record` mappers below instead.
 *
 * `query()` returns an array of results for multi-statement Cypher; the
 * single-statement callers here unwrap it via `first()`.
 */
export interface KuzuConnectionLike {
  query(cypher: string): Promise<KuzuResultLike | KuzuResultLike[]>;
  /** Prepared-statement path (optional: fakes may omit it and fall back to literals). */
  prepare?(cypher: string): Promise<unknown>;
  execute?(prepared: unknown, params: Record<string, unknown>): Promise<KuzuResultLike | KuzuResultLike[]>;
}
interface KuzuResultLike {
  getAll(): Promise<Record<string, unknown>[]>;
  close(): void;
}
interface KuzuDatabaseLike {
  close(): void;
}

/** Injected so tests can swap in an in-memory/tmp-dir Kuzu instance without importing the native module directly here. */
export interface KuzuDriver {
  openDatabase(dbPath: string): Promise<KuzuDatabaseLike>;
  openConnection(db: KuzuDatabaseLike): Promise<KuzuConnectionLike>;
}

function row<T>(rows: T[]): T | undefined {
  return rows[0];
}

/** Kuzu returns an array of results only for multi-statement Cypher; every query here is single-statement. */
function first(res: KuzuResultLike | KuzuResultLike[]): KuzuResultLike {
  return Array.isArray(res) ? res[0]! : res;
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Kuzu's `RETURN s.*` returns keys prefixed with the node variable (`s.id`,
 * `s.name`, …), while `RETURN s.id AS id` returns bare keys. Accept both so
 * callers that use the terse `s.*` form (lookup/outline/unreferenced/…) map
 * correctly rather than binding every field to null.
 */
function field(r: Record<string, unknown>, key: string): unknown {
  if (key in r) return r[key];
  // `RETURN <var>.*` prefixes every key with the node variable (`s.id`,
  // `f.path`, …). We don't know the variable, so match on the suffix.
  for (const k of Object.keys(r)) {
    const dot = k.indexOf('.');
    if (dot >= 0 && k.slice(dot + 1) === key) return r[k];
  }
  return undefined;
}

function toSymbolRecord(r: Record<string, unknown>): SymbolRecord {
  const parentId = field(r, 'parentId');
  return {
    id: Number(field(r, 'id')),
    fileId: Number(field(r, 'fileId')),
    file: String(field(r, 'file')),
    name: String(field(r, 'name')),
    qualified: String(field(r, 'qualified')),
    kind: field(r, 'kind') as SymbolKind,
    lang: field(r, 'lang') as CodeLang,
    startLine: Number(field(r, 'startLine')),
    endLine: Number(field(r, 'endLine')),
    signature: (field(r, 'signature') as string | null) ?? null,
    doc: (field(r, 'doc') as string | null) ?? null,
    parentId: parentId === null || parentId === undefined ? null : Number(parentId),
    exported: Boolean(field(r, 'exported')),
  };
}

function toFileRecord(r: Record<string, unknown>): FileRecord {
  return {
    id: Number(field(r, 'id')),
    path: String(field(r, 'path')),
    lang: field(r, 'lang') as CodeLang,
    mtimeMs: Number(field(r, 'mtimeMs')),
    size: Number(field(r, 'size')),
    hash: String(field(r, 'hash')),
    indexedAt: Number(field(r, 'indexedAt')),
    crate: (field(r, 'crate') as string | null) ?? null,
    parseError: Boolean(field(r, 'parseError')),
  };
}

/** In-memory mirror of the symbol table, for the resolver's hot lookups. */
interface SymbolIndex {
  byQualified: Map<string, number[]>;
  byName: Map<string, number[]>;
  /** Suffix probes: `::x::y` → ids, so ENDS WITH becomes a map hit. */
  byQualifiedSuffix: Map<string, number[]>;
  /** name → (id, declaring file path); the module probe suffix-matches the path. */
  byNameWithPath: Map<string, Array<{ id: number; path: string }>>;
  /** id → qualified, for the `use`-specifier narrowing rung. */
  qualifiedById: Map<number, string>;
  /** id → declaring file path, for the cross-crate confidence gate. */
  pathById: Map<number, string>;
  /** path → this file's index entries, so applyExtraction can patch the
   * mirror in place instead of rebuilding it from Kuzu per file (a full-table
   * rebuild per file made fullIndex O(files × symbols)). */
  entriesByFile: Map<string, IndexEntry[]>;
}

interface IndexEntry {
  id: number;
  name: string;
  qualified: string;
  path: string;
}

export class KuzuCodeStore implements CodeStore {
  /**
   * Resolution issues several lookups per ref against a table only
   * applyExtraction writes — at ~0.6 ms per Kuzu round-trip that made indexing
   * round-trip-bound (89.7% idle in a CPU profile even after write batching;
   * see plan.md S1). The symbol table is small (hundreds to low thousands of
   * rows), so mirroring it in memory turns each probe into a map hit. Dropped
   * on every write; single-writer (ADR-009) means no staleness window.
   */
  private symbolIndex: SymbolIndex | null = null;

  private constructor(
    private readonly db: KuzuDatabaseLike,
    private readonly conn: KuzuConnectionLike
  ) {}

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
    // Every proper `::` suffix, mirroring the ENDS WITH '::<candidate>' probe.
    const segs = e.qualified.split('::');
    for (let i = 1; i < segs.length; i++) push(idx.byQualifiedSuffix, segs.slice(i).join('::'), e.id);
    push(idx.entriesByFile, e.path, e);
  }

  /** Remove one file's entries from the mirror (inverse of indexAdd). */
  private static indexRemoveFile(idx: SymbolIndex, path: string): void {
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

  private async loadSymbolIndex(): Promise<SymbolIndex> {
    if (this.symbolIndex) return this.symbolIndex;
    const rows = await this.rows(
      `MATCH (f:File)-[:DECLARES]->(s:Symbol) WHERE s.kind <> 'module' RETURN s.id AS id, s.name AS name, s.qualified AS qualified, f.path AS path`
    );
    const idx: SymbolIndex = {
      byQualified: new Map(),
      byName: new Map(),
      byQualifiedSuffix: new Map(),
      byNameWithPath: new Map(),
      qualifiedById: new Map(),
      pathById: new Map(),
      entriesByFile: new Map(),
    };
    for (const r of rows) {
      KuzuCodeStore.indexAdd(idx, {
        id: Number(r.id),
        name: String(r.name),
        qualified: String(r.qualified),
        path: String(r.path),
      });
    }
    this.symbolIndex = idx;
    return idx;
  }

  static async open(dbPath: string, driver: KuzuDriver): Promise<KuzuCodeStore> {
    const db = await driver.openDatabase(dbPath);
    const conn = await driver.openConnection(db);
    const store = new KuzuCodeStore(db, conn);
    await store.migrate();
    return store;
  }

  /** Single-statement query, with Kuzu's multi-statement array return unwrapped. */
  private async q(cypher: string): Promise<KuzuResultLike> {
    return first(await this.conn.query(cypher));
  }

  /** Run a statement for its side effect only, closing the result. */
  private async exec(cypher: string): Promise<void> {
    (await this.q(cypher)).close();
  }

  /**
   * Run `fn`'s statements inside one explicit transaction. Without this every
   * statement auto-commits with its own WAL flush — on a grown index (~40 MB
   * ARES) that cost ~45 ms *per statement*, and applyExtraction's ~17
   * statements put incremental indexFile at p95 638 ms vs the < 100 ms V5
   * bar. One BEGIN/COMMIT collapses those flushes. Also delivers the
   * spec invariant that applyExtraction is atomic (delete-old + insert-new
   * indivisible). ROLLBACK on error so a failed extraction can't leave a
   * half-replaced file subgraph.
   */
  /** Prepared-statement cache: cypher text → prepared handle. */
  private prepared = new Map<string, unknown>();

  /**
   * Run an `UNWIND $rows AS r …` statement with `rows` bound as a parameter.
   * A literal UNWIND makes Kuzu re-parse a megabyte of inline structs — on a
   * heavy file (maneuvers.rs: ~300 symbols + ~800 edges) that parsing was the
   * whole V5 tail (125/99/71 ms per statement; the param path measured 10x
   * faster). Falls back to caller-provided literal SQL when the driver has no
   * prepare/execute (test fakes).
   *
   * NOTE: all-null columns bind as STRING by inference — the same trap as
   * literal UNWINDs — so callers must pass typed non-null sentinels or rely on
   * the CASTs in the statement text.
   */
  private async execRows(cypher: string, rows: Record<string, unknown>[], literalFallback: () => Promise<void>): Promise<void> {
    if (rows.length === 0) return;
    if (!this.conn.prepare || !this.conn.execute) return literalFallback();
    let ps = this.prepared.get(cypher);
    if (ps === undefined) {
      ps = await this.conn.prepare(cypher);
      this.prepared.set(cypher, ps);
    }
    first(await this.conn.execute(ps, { rows })).close();
  }

  private inTx = false;

  private async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) return fn(); // nested call joins the outer transaction
    this.inTx = true;
    await this.exec('BEGIN TRANSACTION');
    try {
      const out = await fn();
      await this.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        await this.exec('ROLLBACK');
      } catch {
        /* connection state unknown — surface the original error */
      }
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  /** Run a query and return its rows, always closing the result. */
  private async rows(cypher: string): Promise<Record<string, unknown>[]> {
    const res = await this.q(cypher);
    try {
      return await res.getAll();
    } finally {
      res.close();
    }
  }

  private async migrate(): Promise<void> {
    let existingVersion: number | null = null;
    try {
      const res = await this.q(`MATCH (m:Meta {key: 'schema_version'}) RETURN m.value AS value`);
      const rows = await res.getAll();
      res.close();
      existingVersion = rows[0] ? Number(rows[0].value) : null;
    } catch {
      existingVersion = null; // Meta table doesn't exist yet — fresh database.
    }

    if (existingVersion !== null && existingVersion !== SCHEMA_VERSION) {
      await this.reset();
      return;
    }
    if (existingVersion === SCHEMA_VERSION) return;

    for (const ddl of SCHEMA_DDL) {
      await this.exec(ddl);
    }
    await this.exec(`CREATE (:Meta {key: 'schema_version', value: '${SCHEMA_VERSION}'})`);
    await this.exec(`CREATE (:Meta {key: 'next_id', value: '1'})`);
    await this.exec(`CREATE (:Meta {key: 'next_pending_id', value: '1'})`);
  }

  async reset(): Promise<void> {
    this.invalidateSymbolIndex();
    // DROP and recreate, not just DELETE rows: a schema-version bump can
    // change table *shape* (e.g. the v3 `test` edge column), and deleting rows
    // from a v2-shaped table leaves later INSERTs binding against missing
    // columns. Rel tables must drop before their node tables.
    for (const t of [...REFERENCE_EDGE_TABLES, ...STRUCTURAL_EDGE_TABLES, 'PendingRef', 'Symbol', 'File', 'Meta']) {
      try {
        await this.exec(`DROP TABLE ${t}`);
      } catch {
        /* table may not exist pre-migration */
      }
    }
    for (const ddl of SCHEMA_DDL) {
      await this.exec(ddl);
    }
    await this.exec(`CREATE (:Meta {key: 'schema_version', value: '${SCHEMA_VERSION}'})`);
    await this.exec(`CREATE (:Meta {key: 'next_id', value: '1'})`);
    await this.exec(`CREATE (:Meta {key: 'next_pending_id', value: '1'})`);
  }

  private async nextId(counter: 'next_id' | 'next_pending_id'): Promise<number> {
    return this.reserveIds(counter, 1);
  }

  /**
   * Reserve `count` consecutive ids, returning the first. Two round-trips per
   * *batch* rather than per id — at ~1.8 ms/statement this is the difference
   * between an id allocation costing more than the insert it serves and it
   * costing nothing. Ids are dense and single-writer, so a contiguous block is
   * safe (see ADR-009).
   */
  private async reserveIds(counter: 'next_id' | 'next_pending_id', count: number): Promise<number> {
    const res = await this.q(`MATCH (m:Meta {key: '${counter}'}) RETURN m.value AS value`);
    const r = row(await res.getAll());
    res.close();
    const first = r ? Number(r.value) : 1;
    await this.exec(`MATCH (m:Meta {key: '${counter}'}) SET m.value = '${first + count}'`);
    return first;
  }

  // -- Indexing ---------------------------------------------------------------

  /**
   * Convert every reference edge coming INTO file `fileId`'s symbols from a
   * DIFFERENT file back into PendingRefs owned by the referring file, so the
   * upcoming symbol deletion doesn't orphan them — resolvePending() re-links
   * (or leaves unresolved, truthfully) once the file's new symbols land.
   * The target's stored name/qualified become the retry hint; an edge that was
   * fuzzy re-parks with methodCall=true so the confidence cap survives.
   */
  private async reparkIncomingRefs(fileId: number): Promise<void> {
    const rows = await this.rows(
      `MATCH (a:Symbol)-[e:${REFERENCE_EDGE_TABLES.join('|')}]->(s:Symbol {fileId: ${fileId}})
       WHERE a.fileId <> ${fileId}
       RETURN a.id AS fromId, a.fileId AS fromFileId, s.name AS name, s.qualified AS qualified,
              label(e) AS kind, e.line AS line, e.confidence AS conf, e.test AS test`
    );
    if (rows.length === 0) return;
    const firstPid = await this.reserveIds('next_pending_id', rows.length);
    const pendRows = rows.map((r, i) => {
      // A top-level fn's stored qualified IS its bare name; parking that as a
      // qualifiedName would hit the qualified ladder's "single segment never
      // matches" rule and stay unresolved forever — park it bare instead.
      const q = String(r.qualified ?? '');
      const qualifiedName = q.includes('::') ? q : '';
      return `{id: ${firstPid + i}, fileId: ${Number(r.fromFileId)}, fromSymbolId: ${Number(r.fromId)}, name: '${escapeStr(String(r.name))}', qualifiedName: '${escapeStr(qualifiedName)}', kind: '${String(r.kind)}', line: ${Number(r.line)}, methodCall: ${String(r.conf) === 'fuzzy'}, inTest: ${r.test === true}}`;
    });
    await this.exec(
      `UNWIND [${pendRows.join(',')}] AS r
       CREATE (:PendingRef {id: r.id, fileId: r.fileId, fromSymbolId: r.fromSymbolId, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind, line: r.line, methodCall: r.methodCall, inTest: r.inTest})`
    );
  }

  async applyExtraction(extraction: FileExtraction): Promise<FileRecord> {
    return this.inTransaction(() => this.applyExtractionInner(extraction));
  }

  private async applyExtractionInner(extraction: FileExtraction): Promise<FileRecord> {
    const now = Date.now();
    const existingRes = await this.q(`MATCH (f:File {path: '${escapeStr(extraction.path)}'}) RETURN f.id AS id`);
    const existing = row(await existingRes.getAll());
    existingRes.close();

    let fileId: number;
    if (existing) {
      fileId = Number(existing.id);
      // Re-park incoming references from OTHER files before the cascade
      // deletes their edges: a referring file is not re-indexed when its
      // target changes, so without this every cross-file edge into an edited
      // file is silently lost (R7 incremental drift — V8 caught it).
      await this.reparkIncomingRefs(fileId);
      // Cascade: delete prior symbols (and their edges) declared by this file.
      await (
        await this.q(
          `MATCH (f:File {id: ${fileId}})-[:DECLARES]->(s:Symbol) DETACH DELETE s`
        )
      ).close();
      await this.exec(`MATCH (p:PendingRef {fileId: ${fileId}}) DETACH DELETE p`);
      await (
        await this.q(
          `MATCH (f:File {id: ${fileId}}) SET f.lang = '${extraction.lang}', f.mtimeMs = ${extraction.mtimeMs}, f.size = ${extraction.size}, f.hash = '${escapeStr(extraction.hash)}', f.indexedAt = ${now}, f.crate = ${extraction.crate ? `'${escapeStr(extraction.crate)}'` : 'null'}, f.parseError = ${extraction.parseError}`
        )
      ).close();
    } else {
      fileId = await this.nextId('next_id');
      await (
        await this.q(
          `CREATE (:File {id: ${fileId}, path: '${escapeStr(extraction.path)}', lang: '${extraction.lang}', mtimeMs: ${extraction.mtimeMs}, size: ${extraction.size}, hash: '${escapeStr(extraction.hash)}', indexedAt: ${now}, crate: ${extraction.crate ? `'${escapeStr(extraction.crate)}'` : 'null'}, parseError: ${extraction.parseError}})`
        )
      ).close();
    }

    // Insert symbols in extraction order (module symbol first), remapping
    // parentIndex -> real symbol id so children can reference inserted parents.
    //
    // Batched into three UNWIND statements rather than ~4 per symbol: Kuzu costs
    // ~1.8 ms per statement regardless of size, so per-symbol statements made
    // indexing round-trip-bound (91.7% idle in a CPU profile — see plan.md S1).
    // One UNWIND of 500 rows measured 8x faster than 500 CREATEs.
    const indexToId: number[] = [];
    const firstId = await this.reserveIds('next_id', extraction.symbols.length);
    extraction.symbols.forEach((_, i) => indexToId.push(firstId + i));

    if (extraction.symbols.length > 0) {
      // Parameterized UNWIND (see execRows). Nulls inside param structs bind
      // broken in kuzu 0.11.3 ("vector with ANY type"), so nullable columns
      // travel as sentinels ('' / -1) and the statement CASEs them back to
      // typed NULLs — same trap as literal type-inference, different spelling.
      const symParamRows = extraction.symbols.map((sym, i) => ({
        id: indexToId[i]!,
        fileId,
        file: extraction.path,
        name: sym.name,
        qualified: sym.qualified,
        kind: sym.kind,
        lang: sym.lang,
        startLine: sym.startLine,
        endLine: sym.endLine,
        signature: sym.signature ?? '',
        doc: sym.doc ?? '',
        parentId: sym.parentIndex !== null ? indexToId[sym.parentIndex]! : -1,
        exported: sym.exported,
      }));
      await this.execRows(
        `UNWIND $rows AS r
         CREATE (:Symbol {id: r.id, fileId: r.fileId, file: r.file, name: r.name, qualified: r.qualified, kind: r.kind, lang: r.lang, startLine: r.startLine, endLine: r.endLine,
                 signature: CASE WHEN r.signature = '' THEN CAST(NULL AS STRING) ELSE r.signature END,
                 doc: CASE WHEN r.doc = '' THEN CAST(NULL AS STRING) ELSE r.doc END,
                 parentId: CASE WHEN r.parentId < 0 THEN CAST(NULL AS INT64) ELSE r.parentId END,
                 exported: r.exported})`,
        symParamRows,
        async () => {
          const symRows = extraction.symbols.map((sym, i) => {
            const parentId = sym.parentIndex !== null ? indexToId[sym.parentIndex]! : null;
            // Literal fallback: CAST pins types a null-in-every-row column
            // would otherwise mis-infer as STRING.
            return `{id: ${indexToId[i]}, name: '${escapeStr(sym.name)}', qualified: '${escapeStr(sym.qualified)}', kind: '${sym.kind}', lang: '${sym.lang}', startLine: ${sym.startLine}, endLine: ${sym.endLine}, signature: CAST(${sym.signature ? `'${escapeStr(sym.signature)}'` : 'null'} AS STRING), doc: CAST(${sym.doc ? `'${escapeStr(sym.doc)}'` : 'null'} AS STRING), parentId: CAST(${parentId ?? 'null'} AS INT64), exported: ${sym.exported}}`;
          });
          await this.exec(
            `UNWIND [${symRows.join(',')}] AS r
             CREATE (:Symbol {id: r.id, fileId: ${fileId}, file: '${escapeStr(extraction.path)}', name: r.name, qualified: r.qualified, kind: r.kind, lang: r.lang, startLine: r.startLine, endLine: r.endLine, signature: r.signature, doc: r.doc, parentId: r.parentId, exported: r.exported})`
          );
        }
      );
      await this.exec(
        `MATCH (f:File {id: ${fileId}})
         UNWIND [${indexToId.join(',')}] AS sid
         MATCH (s:Symbol {id: sid}) CREATE (f)-[:DECLARES]->(s)`
      );

      const owns = extraction.symbols
        .map((sym, i) => (sym.parentIndex !== null ? `{p: ${indexToId[sym.parentIndex]!}, c: ${indexToId[i]}}` : null))
        .filter((x): x is string => x !== null);
      if (owns.length > 0) {
        await this.exec(
          `UNWIND [${owns.join(',')}] AS r
           MATCH (p:Symbol {id: r.p}), (c:Symbol {id: r.c}) CREATE (p)-[:OWNS]->(c)`
        );
      }
    }

    // Pass 2, phase A: try resolving each ref immediately; anything left
    // unresolved is parked in PendingRef for resolvePending() to retry.
    // The symbol table just changed (old symbols dropped, new ones inserted);
    // patch the loaded mirror in place — a full drop-and-rebuild here made
    // fullIndex O(files × symbols) since every file's resolution reloaded the
    // whole table. (If no mirror is loaded yet, the first lookup builds it
    // from the already-settled table.)
    if (this.symbolIndex) {
      KuzuCodeStore.indexRemoveFile(this.symbolIndex, extraction.path);
      extraction.symbols.forEach((sym, i) => {
        if (sym.kind === 'module') return; // mirrors the loadSymbolIndex WHERE clause
        KuzuCodeStore.indexAdd(this.symbolIndex!, {
          id: indexToId[i]!,
          name: sym.name,
          qualified: sym.qualified,
          path: extraction.path,
        });
      });
    }

    // Resolution is read-only, so decide everything first and write once per
    // outcome kind — a file's refs then cost 2 write statements, not 2 per ref.
    const useSpecifiers = extraction.uses.map((u) => u.specifier);
    const pending: RawRef[] = [];
    const edges: Array<{ fromId: number; toId: number; kind: EdgeKind; line: number; confidence: EdgeConfidence; test: boolean }> = [];
    for (const ref of extraction.refs) {
      const fromId = indexToId[ref.fromIndex]!;
      const resolved = await this.resolveOneRef(ref.name, ref.qualifiedName, useSpecifiers, ref.methodCall ?? false, extraction.path);
      if (resolved === 'unresolved') {
        pending.push(ref);
      } else {
        for (const toId of resolved.ids) edges.push({ fromId, toId, kind: ref.kind, line: ref.line, confidence: resolved.confidence, test: ref.inTest === true });
      }
    }

    // File-level dependency edges (DEPENDS_ON) from `use` specifiers. The spec
    // (subsystem_indexer_spec.md §3) lists DEPENDS_ON as an extracted edge and
    // the module-graph rules (no-module-cycles, Layering, module_map) read it;
    // `use` imports are its source. Each resolvable non-glob `use` becomes an
    // edge from this file's root/module symbol (extraction order guarantees it
    // is symbols[0]) to the imported symbol, when that symbol lives in another
    // file. Glob imports (`use foo::*`) name no target and are skipped.
    const moduleId = indexToId[0];
    if (moduleId !== undefined) {
      const seenDep = new Set<number>();
      for (const u of extraction.uses) {
        if (u.isGlob) continue;
        const tail = u.specifier.split('::').filter(Boolean).pop();
        if (!tail) continue;
        const resolved = await this.resolveOneRef(tail, u.specifier, useSpecifiers);
        if (resolved === 'unresolved') {
          // The imported file may simply not be indexed yet (index order is
          // arbitrary). Park as a pending DEPENDS_ON from the module symbol so
          // resolvePending() completes the edge once the target arrives —
          // otherwise every forward `use` dep is silently lost.
          pending.push({ fromIndex: 0, name: tail, qualifiedName: u.specifier, kind: 'DEPENDS_ON', line: u.line, inTest: u.inTest });
          continue;
        }
        for (const toId of resolved.ids) {
          // Skip self-edges and duplicate deps on the same target symbol.
          if (toId === moduleId || seenDep.has(toId)) continue;
          seenDep.add(toId);
          edges.push({ fromId: moduleId, toId, kind: 'DEPENDS_ON', line: u.line, confidence: resolved.confidence, test: u.inTest === true });
        }
      }
    }

    if (pending.length > 0) {
      const firstPid = await this.reserveIds('next_pending_id', pending.length);
      await this.execRows(
        `UNWIND $rows AS r
         CREATE (:PendingRef {id: r.id, fileId: r.fileId, fromSymbolId: r.fromSymbolId, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind, line: r.line, methodCall: r.methodCall, inTest: r.inTest})`,
        pending.map((ref, i) => ({
          id: firstPid + i,
          fileId,
          fromSymbolId: indexToId[ref.fromIndex]!,
          name: ref.name,
          qualifiedName: ref.qualifiedName ?? '',
          kind: ref.kind,
          line: ref.line,
          methodCall: ref.methodCall === true,
          inTest: ref.inTest === true,
        })),
        async () => {
          const pendRows = pending.map(
            (ref, i) =>
              `{id: ${firstPid + i}, fromSymbolId: ${indexToId[ref.fromIndex]!}, name: '${escapeStr(ref.name)}', qualifiedName: '${escapeStr(ref.qualifiedName ?? '')}', kind: '${ref.kind}', line: ${ref.line}, methodCall: ${ref.methodCall === true}, inTest: ${ref.inTest === true}}`
          );
          await this.exec(
            `UNWIND [${pendRows.join(',')}] AS r
             CREATE (:PendingRef {id: r.id, fileId: ${fileId}, fromSymbolId: r.fromSymbolId, name: r.name, qualifiedName: r.qualifiedName, kind: r.kind, line: r.line, methodCall: r.methodCall, inTest: r.inTest})`
          );
        }
      );
    }
    await this.insertEdgesBatch(edges);

    const fileRes = await this.q(`MATCH (f:File {id: ${fileId}}) RETURN f.*`);
    const fileRow = row(await fileRes.getAll())!;
    fileRes.close();
    return toFileRecord(fileRow);
  }

  async removeFile(path: string): Promise<void> {
    if (this.symbolIndex) KuzuCodeStore.indexRemoveFile(this.symbolIndex, path);
    const res = await this.q(`MATCH (f:File {path: '${escapeStr(path)}'}) RETURN f.id AS id`);
    const r = row(await res.getAll());
    res.close();
    if (!r) return;
    const fileId = Number(r.id);
    await this.inTransaction(async () => {
      await this.reparkIncomingRefs(fileId); // referrers keep their claim (see applyExtraction)
      await this.exec(`MATCH (p:PendingRef {fileId: ${fileId}}) DETACH DELETE p`);
      await this.exec(`MATCH (f:File {id: ${fileId}})-[:DECLARES]->(s:Symbol) DETACH DELETE s`);
      await this.exec(`MATCH (f:File {id: ${fileId}}) DETACH DELETE f`);
    });
  }

  /**
   * Resolve a bare/qualified name to symbol ids: exact `qualified` match
   * first, then unique bare-`name` match, then `use`-specifier disambiguation
   * among multiple bare-name candidates (ported from resolveOneRef in
   * vendor/reference-indexer/src/index/codeStoreImpl.ts, adapted for Rust's
   * name-qualified `use` paths rather than relative file paths).
   */
  private async resolveOneRef(
    name: string,
    qualifiedName: string | null,
    useSpecifiers: string[],
    methodCall = false,
    fromPath: string | null = null
  ): Promise<{ ids: number[]; confidence: 'resolved' | 'fuzzy' } | 'unresolved'> {
    // Every rung reads the in-memory mirror (see loadSymbolIndex): resolution is
    // pure lookup, and the round-trips it used to make dominated index time.
    // Returned id arrays are copied — they are the index's own, not the
    // caller's to keep.
    const idx = await this.loadSymbolIndex();

    /**
     * Confidence gate applied to every rung's outcome (R1: `resolved` must be
     * trustworthy — rules only fail CI on confirmed findings):
     *
     * 1. A bare METHOD call (`x.foo()`) caps at `fuzzy` regardless of how few
     *    candidates share the name — the receiver's static type is unknown
     *    (S1 deferral) and the true target is often outside the graph
     *    entirely (derive impls, trait defaults, stdlib).
     * 2. A resolution that lands in a DIFFERENT crate (first-two-path-segment
     *    heuristic, e.g. `crates/globset`) caps at `fuzzy` unless a `use`
     *    specifier in the referring file corroborates the target. Same-named
     *    symbols across sibling crates (`Parser::new` in grep-regex vs core)
     *    otherwise resolve "confirmed" onto the wrong crate: on ripgrep this
     *    leaked 200+ false confirmed layering violations.
     */
    const gate = (out: { ids: number[]; confidence: 'resolved' | 'fuzzy' }): { ids: number[]; confidence: 'resolved' | 'fuzzy' } => {
      if (out.confidence === 'fuzzy') return out;
      if (methodCall) return { ids: out.ids, confidence: 'fuzzy' };
      if (fromPath) {
        // Crate root = the path prefix before a `src` segment (Cargo layout:
        // `crates/globset/src/lib.rs` → `crates/globset`), or the first two
        // segments under a workspace container dir for crates without `src/`
        // (`crates/core/flags/parse.rs` → `crates/core`). Everything else
        // (flat repos, single-crate `src/…`) maps to '' — one crate, gate off.
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
          // A `use` in the referring file corroborates the target when (a) its
          // bound tail names the ref itself (`use x::helper` → helper()) or
          // the ref's qualifier head (`use x::Parser` → Parser::new()), AND
          // (b) the specifier's crate head is plausibly the candidate's crate
          // (some candidate path segment, `-`→`_`, appears in the head — so
          // `use grep_cli::…::ParseSizeError` corroborates crates/cli but
          // `use regex_syntax::ast::Parser` does NOT corroborate crates/core's
          // `Parser`). Errs toward fuzzy: a miss only downgrades confidence.
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

    // Rung 1: the ref as written, when it carried a `::` qualifier.
    //
    // A qualifier is a *constraint*, not a hint: `Vec3::new` names Vec3's
    // constructor and nothing else. So a qualified ref never falls through to
    // the bare-name rung — if the qualifier matches nothing here, the callee
    // lives outside the workspace (`Vec3::new`, `HashMap::new`) and the honest
    // answer is unresolved. Falling back would instead pick every workspace
    // `new` as a fuzzy candidate: that single mistake accounted for ~1,000 of
    // 1,833 fuzzy edges on the ARES sample (plan.md S1).
    if (qualifiedName) {
      // Try progressively shorter suffixes of the written path. A call site can
      // name a symbol more fully than the index stores it — `crate::map::loader
      // ::load_map` or `ares::validate::validate_file` are absolute paths whose
      // crate/module prefix is not part of `qualified` (which is built from the
      // file's own containment). Dropping leading segments turns these into the
      // `load_map` / `Foo::new` forms the index actually holds.
      // `length - 1` stops before the bare final segment: `Vec3::new` must not
      // fall back to matching every workspace `new`. A free fn written
      // absolutely (`crate::map::loader::load_map`) is still reached, via the
      // ENDS WITH probe on the `loader::load_map` suffix below.
      const segments = qualifiedName.split('::');
      for (let i = 0; i < segments.length - 1; i++) {
        const candidate = segments.slice(i).join('::');
        const exact = idx.byQualified.get(candidate);
        if (exact) return gate({ ids: [...exact], confidence: exact.length === 1 ? 'resolved' : 'fuzzy' });

        // The declaration may also be stored under a *longer* path than the call
        // writes (`shapes::Foo::new` reached via `use shapes::Foo`).
        const suffix = idx.byQualifiedSuffix.get(candidate);
        if (suffix) return gate({ ids: [...suffix], confidence: suffix.length === 1 ? 'resolved' : 'fuzzy' });
      }

      // Last resort for a path whose prefix is a *module*, not a type:
      // `crate::map::loader::load_map` declares nothing named
      // `loader::load_map` — in Rust the module path is the file path, so the
      // symbol is stored bare in `src/map/loader.rs`. Match the final segment
      // only against files whose path corresponds to the module prefix, which
      // keeps the qualifier a constraint rather than dropping it.
      const modulePath = segments.slice(0, -1).filter((s) => s !== 'crate' && s !== 'self' && s !== 'super');
      if (modulePath.length > 0) {
        const fileSuffix = `${modulePath.join('/')}.rs`;
        const byModule = (idx.byNameWithPath.get(name) ?? []).filter((c) => c.path === fileSuffix || c.path.endsWith(`/${fileSuffix}`));
        if (byModule.length > 0) {
          return gate({ ids: byModule.map((c) => c.id), confidence: byModule.length === 1 ? 'resolved' : 'fuzzy' });
        }
      }

      // Every probe missed: the callee is not in the workspace. Note this never
      // falls back to the bare final segment, which would match unrelated
      // same-named symbols — that is the point (see above).
      return 'unresolved';
    }

    // Rung 2: bare refs only (all outcomes pass through `gate` above).
    const byQualified = idx.byQualified.get(name);
    if (byQualified) return gate({ ids: [...byQualified], confidence: byQualified.length === 1 ? 'resolved' : 'fuzzy' });

    const byName = idx.byName.get(name);
    if (!byName) return 'unresolved';
    if (byName.length === 1) return gate({ ids: [...byName], confidence: 'resolved' });

    // Multiple candidates — narrow by `use` specifiers ending in this name
    // (e.g. `use auth::service::login` narrows a `login` call to that path).
    const matchingUse = useSpecifiers.filter((spec) => spec === name || spec.endsWith(`::${name}`));
    if (matchingUse.length > 0) {
      const narrowed = byName.filter((id) => {
        const q = idx.qualifiedById.get(id)!;
        return matchingUse.some((spec) => q === spec || spec.endsWith(q));
      });
      if (narrowed.length === 1) return gate({ ids: narrowed, confidence: 'resolved' });
    }

    return { ids: [...byName], confidence: 'fuzzy' };
  }

  /**
   * Insert reference edges, one statement per edge *kind* rather than per edge
   * (the relationship table name can't be an UNWIND parameter, so kind is the
   * natural batch boundary). MERGE still keeps re-apply idempotent.
   */
  private async insertEdgesBatch(
    edges: Array<{ fromId: number; toId: number; kind: EdgeKind; line: number; confidence: EdgeConfidence; test: boolean }>
  ): Promise<void> {
    const byKind = new Map<EdgeKind, typeof edges>();
    for (const e of edges) {
      if (!REFERENCE_EDGE_TABLES.includes(e.kind)) continue; // structural kinds handled at creation time
      if (e.toId === e.fromId) continue; // skip self-edges
      const list = byKind.get(e.kind) ?? [];
      list.push(e);
      byKind.set(e.kind, list);
    }
    for (const [kind, list] of byKind) {
      const cypher = `UNWIND $rows AS r
         MATCH (a:Symbol {id: r.a}), (b:Symbol {id: r.b})
         MERGE (a)-[:${kind} {line: r.line, confidence: r.conf, test: r.test}]->(b)`;
      await this.execRows(
        cypher,
        list.map((e) => ({ a: e.fromId, b: e.toId, line: e.line, conf: e.confidence, test: e.test })),
        async () => {
          const rows = list.map((e) => `{a: ${e.fromId}, b: ${e.toId}, line: ${e.line}, conf: '${e.confidence}', test: ${e.test}}`);
          await this.exec(
            `UNWIND [${rows.join(',')}] AS r
             MATCH (a:Symbol {id: r.a}), (b:Symbol {id: r.b})
             MERGE (a)-[:${kind} {line: r.line, confidence: r.conf, test: r.test}]->(b)`
          );
        }
      );
    }
  }

  async resolvePending(namesHint?: string[]): Promise<number> {
    const filter = namesHint?.length ? `WHERE p.name IN [${namesHint.map((n) => `'${escapeStr(n)}'`).join(',')}]` : '';
    const res = await this.q(
      `MATCH (p:PendingRef) ${filter} RETURN p.id AS id, p.fileId AS fileId, p.fromSymbolId AS fromSymbolId, p.name AS name, p.qualifiedName AS qualifiedName, p.kind AS kind, p.line AS line, p.methodCall AS methodCall, p.inTest AS inTest`
    );
    const rows = await res.getAll();
    res.close();

    // Referring-file paths for the cross-crate confidence gate (one query,
    // not one per pending ref).
    const pathByFileId = new Map<number, string>();
    if (rows.length > 0) {
      const fres = await this.q(`MATCH (f:File) RETURN f.id AS id, f.path AS path`);
      for (const fr of await fres.getAll()) pathByFileId.set(Number(fr.id), String(fr.path));
      fres.close();
    }

    // Decide first, write once: this runs over every pending ref in the
    // workspace after a full index, so per-ref writes dominated the index time.
    let created = 0;
    const edges: Array<{ fromId: number; toId: number; kind: EdgeKind; line: number; confidence: EdgeConfidence; test: boolean }> = [];
    const settled: number[] = [];
    for (const r of rows) {
      const useSpecifiers = await this.useSpecifiersForFile(Number(r.fileId));
      // A DEPENDS_ON pending WITH a qualifiedName is a parked `use` import —
      // the import IS the dependency statement, so the cross-crate gate does
      // not apply. Bare DEPENDS_ON refs (macro invocations captured as
      // ref.reference) get the gate like any other ref: `normalize!(…)` in
      // globset must not resolve confirmed onto ignore's `normalize` method.
      const isUseImport = r.kind === 'DEPENDS_ON' && Boolean(String(r.qualifiedName ?? ''));
      const fromPath = isUseImport ? null : (pathByFileId.get(Number(r.fileId)) ?? null);
      const resolved = await this.resolveOneRef(String(r.name), String(r.qualifiedName ?? '') || null, useSpecifiers, r.methodCall === true, fromPath);
      if (resolved === 'unresolved') continue;
      for (const toId of resolved.ids) {
        edges.push({ fromId: Number(r.fromSymbolId), toId, kind: r.kind as EdgeKind, line: Number(r.line), confidence: resolved.confidence, test: r.inTest === true });
      }
      settled.push(Number(r.id));
      created += resolved.ids.length;
    }

    await this.inTransaction(async () => {
      await this.insertEdgesBatch(edges);
      if (settled.length > 0) {
        await this.exec(`UNWIND [${settled.join(',')}] AS pid MATCH (p:PendingRef {id: pid}) DETACH DELETE p`);
      }
    });
    return created;
  }

  /** PAiRS doesn't persist `use` specifiers per file (unlike the reference
   *  project's pending_imports table) — v1 doesn't need file-scoped `use`
   *  disambiguation beyond what resolveOneRef's global qualified-name lookup
   *  already provides. Returns empty; kept as an extension point. */
  private async useSpecifiersForFile(_fileId: number): Promise<string[]> {
    return [];
  }

  async listFiles(): Promise<FileRecord[]> {
    const res = await this.q(`MATCH (f:File) RETURN f.*`);
    const rows = await res.getAll();
    res.close();
    return rows.map(toFileRecord);
  }

  // -- Symbol lookup ------------------------------------------------------------

  async get(id: number): Promise<SymbolRecord | null> {
    const res = await this.q(`MATCH (s:Symbol {id: ${id}}) RETURN s.*`);
    const r = row(await res.getAll());
    res.close();
    return r ? toSymbolRecord(r) : null;
  }

  async lookup(nameOrQualified: string): Promise<SymbolRecord[] | AmbiguousSymbol> {
    const escaped = escapeStr(nameOrQualified);
    const byQualRes = await this.q(`MATCH (s:Symbol {qualified: '${escaped}'}) WHERE s.kind <> 'module' RETURN s.*`);
    let candidates = await byQualRes.getAll();
    byQualRes.close();
    if (candidates.length === 0) {
      const byNameRes = await this.q(`MATCH (s:Symbol {name: '${escaped}'}) WHERE s.kind <> 'module' RETURN s.*`);
      candidates = await byNameRes.getAll();
      byNameRes.close();
    }
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return [toSymbolRecord(candidates[0]!)];
    return { ambiguous: true, candidates: candidates.map(toSymbolRecord) };
  }

  async outline(path: string): Promise<SymbolRecord[]> {
    const res = await this.q(
      `MATCH (s:Symbol {file: '${escapeStr(path)}'}) RETURN s.* ORDER BY s.startLine`
    );
    const rows = await res.getAll();
    res.close();
    return rows.map(toSymbolRecord);
  }

  async membersOf(parentId: number): Promise<SymbolRecord[]> {
    const res = await this.q(
      `MATCH (p:Symbol {id: ${parentId}})-[:OWNS]->(c:Symbol) RETURN c.* ORDER BY c.startLine`
    );
    const rows = await res.getAll();
    res.close();
    return rows.map(toSymbolRecord);
  }

  // -- Graph queries -----------------------------------------------------------

  async edgesTo(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]> {
    if (ids.length === 0) return [];
    const results: EdgeRecord[] = [];
    for (const kind of kinds) {
      if (!REFERENCE_EDGE_TABLES.includes(kind)) continue;
      const res = await this.q(
        `MATCH (a:Symbol)-[e:${kind}]->(b:Symbol) WHERE b.id IN [${ids.join(',')}] RETURN a.id AS fromId, b.id AS toId, e.line AS line, e.confidence AS confidence`
      );
      const rows = await res.getAll();
      res.close();
      for (const r of rows) results.push({ fromId: Number(r.fromId), toId: Number(r.toId), kind, line: Number(r.line), confidence: r.confidence as EdgeConfidence });
    }
    return results;
  }

  async edgesFrom(ids: number[], kinds: EdgeKind[]): Promise<EdgeRecord[]> {
    if (ids.length === 0) return [];
    const results: EdgeRecord[] = [];
    for (const kind of kinds) {
      if (!REFERENCE_EDGE_TABLES.includes(kind)) continue;
      const res = await this.q(
        `MATCH (a:Symbol)-[e:${kind}]->(b:Symbol) WHERE a.id IN [${ids.join(',')}] RETURN a.id AS fromId, b.id AS toId, e.line AS line, e.confidence AS confidence`
      );
      const rows = await res.getAll();
      res.close();
      for (const r of rows) results.push({ fromId: Number(r.fromId), toId: Number(r.toId), kind, line: Number(r.line), confidence: r.confidence as EdgeConfidence });
    }
    return results;
  }

  async query(cypher: string): Promise<Record<string, unknown>[]> {
    // Scan with string literals/comments blanked so quoted data containing
    // keyword words ("… CONTAINS 'create'") doesn't false-positive the guard.
    const lower = stripCypherLiterals(cypher).trim().toLowerCase();
    if (/\b(create|merge|delete|set|remove)\b/.test(lower)) {
      throw new Error('query() is read-only — mutating Cypher is rejected (subsystem_mcp_rules_spec.md §2)');
    }
    return this.rows(cypher);
  }

  // -- Analysis -----------------------------------------------------------------

  async unreferenced(filter: DeadCodeFilter): Promise<DeadCodeCandidate[]> {
    const kinds = filter.kinds?.length ? filter.kinds : undefined;
    const res = await this.q(`MATCH (s:Symbol) WHERE s.kind <> 'module' RETURN s.*`);
    const rows = await res.getAll();
    res.close();

    // One aggregate query for all referenced ids, not one count() per symbol —
    // the per-symbol probe made dead_code O(symbols) Kuzu round-trips
    // (~0.6 ms each ⇒ seconds on a ripgrep-sized corpus).
    const referenced = new Set<number>();
    const refRes = await this.q(
      `MATCH ()-[e]->(s:Symbol) WHERE label(e) IN [${REFERENCE_EDGE_TABLES.map((k) => `'${k}'`).join(',')}] RETURN DISTINCT s.id AS id`
    );
    for (const r of await refRes.getAll()) referenced.add(Number(r.id));
    refRes.close();

    const candidates: DeadCodeCandidate[] = [];
    for (const r of rows) {
      const sym = toSymbolRecord(r);
      if (filter.pathPrefix && !sym.file.startsWith(filter.pathPrefix)) continue;
      if (filter.excludePath && sym.file.startsWith(filter.excludePath)) continue;
      if (kinds && !kinds.includes(sym.kind)) continue;
      if (ENTRY_POINT_NAMES.has(sym.name)) continue;
      if (isTestPath(sym.file)) continue;
      if (referenced.has(sym.id)) continue;

      if (sym.exported && !filter.includeExported) continue;
      candidates.push({ symbol: sym, note: sym.exported ? 'exported' : null });
    }

    candidates.sort((a, b) => a.symbol.file.localeCompare(b.symbol.file) || a.symbol.startLine - b.symbol.startLine);
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 30;
    return candidates.slice(offset, offset + limit);
  }

  async fileEdges(path: string, direction: 'imports' | 'importers', opts?: { transitive?: boolean; maxDepth?: number; limit?: number }): Promise<FileDep[]> {
    const maxDepth = opts?.maxDepth ?? 5;
    const limit = opts?.limit ?? 50;
    const visited = new Map<string, { depth: number; line: number }>(); // path -> first sighting
    let frontier = [path];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      depth += 1;
      const next: string[] = [];
      for (const p of frontier) {
        const cypher =
          direction === 'imports'
            ? `MATCH (a:Symbol {file: '${escapeStr(p)}'})-[e:DEPENDS_ON]->(b:Symbol) WHERE b.file <> '${escapeStr(p)}' RETURN b.file AS file, min(e.line) AS line`
            : `MATCH (a:Symbol)-[e:DEPENDS_ON]->(b:Symbol {file: '${escapeStr(p)}'}) WHERE a.file <> '${escapeStr(p)}' RETURN a.file AS file, min(e.line) AS line`;
        const res = await this.q(cypher);
        const rows = await res.getAll();
        res.close();
        for (const r of rows) {
          const file = String(r.file);
          if (visited.has(file)) continue;
          visited.set(file, { depth, line: Number(r.line) });
          next.push(file);
          if (visited.size >= limit) break;
        }
        if (visited.size >= limit) break;
      }
      if (!opts?.transitive) break;
      frontier = next;
      if (visited.size >= limit) break;
    }

    return [...visited.entries()].map(([p, v]) => ({ path: p, line: v.line, depth: v.depth }));
  }

  async hotspots(query: HotspotQuery): Promise<SymbolRecord[]> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const pathClause = query.pathPrefix ? `WHERE s.file STARTS WITH '${escapeStr(query.pathPrefix)}'` : '';
    const res = await this.q(
      `MATCH (s:Symbol) ${pathClause ? pathClause + ' AND' : 'WHERE'} s.kind IN ['function', 'method']
       OPTIONAL MATCH (s)-[c:CALLS]->()
       WITH s, count(c) AS fanOut
       RETURN s.*, fanOut
       ORDER BY fanOut DESC, s.file, s.startLine`
    );
    const rows = await res.getAll();
    res.close();
    const filtered = query.threshold ? rows.filter((r) => Number(r.fanOut) >= query.threshold!) : rows;
    return filtered.slice(offset, offset + limit).map(toSymbolRecord);
  }

  async untested(filter: { pathPrefix?: string; excludePath?: string; limit?: number; offset?: number }): Promise<SymbolRecord[]> {
    const res = await this.q(
      `MATCH (s:Symbol) WHERE s.kind IN ['function', 'method'] AND s.exported = true RETURN s.*`
    );
    const rows = await res.getAll();
    res.close();

    // One aggregate query for all test-called symbol ids, not one count() per
    // symbol (same round-trip amplification as unreferenced(), see above).
    const testCalled = new Set<number>();
    const testerRes = await this.q(
      `MATCH (t:Symbol)-[:CALLS]->(s:Symbol) WHERE t.file =~ '.*(tests?/|__tests__/|\\\\.test\\\\.rs$|_test\\\\.rs$)' RETURN DISTINCT s.id AS id`
    );
    for (const r of await testerRes.getAll()) testCalled.add(Number(r.id));
    testerRes.close();

    const untested: SymbolRecord[] = [];
    for (const r of rows) {
      const sym = toSymbolRecord(r);
      if (filter.pathPrefix && !sym.file.startsWith(filter.pathPrefix)) continue;
      if (filter.excludePath && sym.file.startsWith(filter.excludePath)) continue;
      if (isTestPath(sym.file)) continue;
      if (testCalled.has(sym.id)) continue;
      untested.push(sym);
    }

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 30;
    return untested.slice(offset, offset + limit);
  }

  /**
   * Tarjan's SCC over a chosen edge kind, at Module (file) or Type scope.
   * Kuzu has no built-in SCC procedure, so the edge list is pulled with one
   * Cypher query and the algorithm runs in JS — identical to the reference
   * project's findCycles, just fed from Kuzu instead of better-sqlite3.
   */
  async findCycles(opts: { edge: EdgeKind; scope: 'module' | 'type'; pathPrefix?: string; limit?: number; confirmedOnly?: boolean; excludeTest?: boolean }): Promise<string[][]> {
    const maxCycles = opts.limit ?? 20;
    const confFilter =
      (opts.confirmedOnly ? ` AND e.confidence = 'resolved'` : '') +
      // Rules exclude test-origin edges: a #[cfg(test)] `use` of a higher
      // module must not stitch a module cycle (R1).
      (opts.excludeTest ? ` AND coalesce(e.test, false) = false` : '');

    let adj: Map<string, Set<string>>;
    if (opts.scope === 'module') {
      const res = await this.q(
        `MATCH (a:Symbol)-[e:${opts.edge}]->(b:Symbol) WHERE a.file <> b.file${confFilter} RETURN DISTINCT a.file AS fromFile, b.file AS toFile`
      );
      const rows = await res.getAll();
      res.close();
      adj = new Map();
      for (const r of rows) {
        const fromFile = String(r.fromFile);
        if (opts.pathPrefix && !fromFile.startsWith(opts.pathPrefix)) continue;
        if (!adj.has(fromFile)) adj.set(fromFile, new Set());
        adj.get(fromFile)!.add(String(r.toFile));
      }
    } else {
      const res = await this.q(
        `MATCH (a:Symbol)-[e:${opts.edge}]->(b:Symbol) WHERE a.kind IN ['struct','class','trait','interface','enum'] AND b.kind IN ['struct','class','trait','interface','enum'] AND a.qualified <> b.qualified${confFilter} RETURN DISTINCT a.qualified AS fromQ, b.qualified AS toQ`
      );
      const rows = await res.getAll();
      res.close();
      adj = new Map();
      for (const r of rows) {
        const fromQ = String(r.fromQ);
        if (!adj.has(fromQ)) adj.set(fromQ, new Set());
        adj.get(fromQ)!.add(String(r.toQ));
      }
    }

    return tarjanCycles(adj, maxCycles);
  }

  async stats(): Promise<IndexStats> {
    const filesRes = await this.q(`MATCH (f:File) RETURN count(f) AS c`);
    const files = Number(row(await filesRes.getAll())?.c ?? 0);
    filesRes.close();

    const symbolsRes = await this.q(`MATCH (s:Symbol) WHERE s.kind <> 'module' RETURN count(s) AS c`);
    const symbols = Number(row(await symbolsRes.getAll())?.c ?? 0);
    symbolsRes.close();

    let edges = 0;
    for (const kind of REFERENCE_EDGE_TABLES) {
      const res = await this.q(`MATCH ()-[e:${kind}]->() RETURN count(e) AS c`);
      edges += Number(row(await res.getAll())?.c ?? 0);
      res.close();
    }

    const pendingRes = await this.q(`MATCH (p:PendingRef) RETURN count(p) AS c`);
    const pendingRefs = Number(row(await pendingRes.getAll())?.c ?? 0);
    pendingRes.close();

    const lastRes = await this.q(`MATCH (f:File) RETURN max(f.indexedAt) AS m`);
    const lastIndexedAt = row(await lastRes.getAll())?.m ?? null;
    lastRes.close();

    const byKind: Partial<Record<SymbolKind, number>> = {};
    for (const r of await this.rows(`MATCH (s:Symbol) WHERE s.kind <> 'module' RETURN s.kind AS kind, count(s) AS c`)) {
      byKind[r.kind as SymbolKind] = Number(r.c);
    }

    const totalRefs = edges + pendingRefs;
    const unresolvedRatio = totalRefs > 0 ? pendingRefs / totalRefs : 0;

    // A pending ref is a genuine miss only if the workspace could plausibly
    // satisfy it. For a *bare* ref that means the name is declared here. A
    // *qualified* ref (`Vec::new`) is never a miss on name alone: the workspace
    // having some unrelated `new` doesn't make `Vec::new` resolvable, and
    // counting it as one is what made this number read 237 when the true figure
    // was near zero. Its qualifier naming nothing here means external, period.
    const resolvableMisses = Number(
      (
        await this.rows(
          `MATCH (p:PendingRef)
           WHERE p.qualifiedName = ''
             AND EXISTS { MATCH (s:Symbol) WHERE s.name = p.name AND s.kind <> 'module' }
           RETURN count(p) AS c`
        )
      )[0]?.c ?? 0
    );

    let fuzzy = 0;
    let resolvedEdges = 0;
    for (const kind of REFERENCE_EDGE_TABLES) {
      for (const r of await this.rows(`MATCH ()-[e:${kind}]->() RETURN e.confidence AS conf, count(e) AS c`)) {
        if (String(r.conf) === 'fuzzy') fuzzy += Number(r.c);
        else resolvedEdges += Number(r.c);
      }
    }
    const fuzzyRate = fuzzy + resolvedEdges > 0 ? fuzzy / (fuzzy + resolvedEdges) : 0;

    return {
      files,
      symbols,
      edges,
      pendingRefs,
      unresolvedRatio,
      externalRefs: pendingRefs - resolvableMisses,
      resolvableMisses,
      fuzzyRate,
      byKind,
      lastIndexedAt: lastIndexedAt === null ? null : Number(lastIndexedAt),
    };
  }

  /**
   * Deliberately does NOT call `db.close()`: kuzu 0.11.3's native addon
   * segfaults (SIGSEGV, exit 139) during teardown on any explicit close —
   * both `conn.close(); db.close()` and a bare `db.close()`. Reproduced by
   * spikes/s2-kuzu-concurrency.mjs (GIZEM_S2_VARIANT=1 and =2); letting the
   * process exit without closing (variant 3) is clean.
   *
   * Leaving the handle to process exit is safe for PAiRS's usage: the CLI is
   * one-shot, and the extension host holds a single long-lived store for its
   * lifetime. Revisit when kuzu ships a fix — the S2 spike is the regression
   * test. NOTE: this means an in-process store cannot be reopened against a
   * different path without leaking the old handle; acceptable for now, but
   * it's the constraint that would break if we ever open stores per-request.
   */
  dispose(): void {
    // intentionally empty — see comment above
  }

  /** See CodeStore.checkpoint doc. */
  async checkpoint(): Promise<void> {
    await this.exec('CHECKPOINT');
  }
}

/** Tarjan's strongly-connected-components algorithm — cycles of length ≥ 2 only. */
function tarjanCycles(adj: Map<string, Set<string>>, maxCycles: number): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let currentIndex = 0;

  const strongconnect = (v: string): void => {
    index.set(v, currentIndex);
    lowlink.set(v, currentIndex);
    currentIndex += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length >= 2) cycles.push(component.sort());
    }
  };

  for (const v of adj.keys()) {
    if (!index.has(v)) strongconnect(v);
  }

  const seen = new Set<string>();
  const result: string[][] = [];
  for (const c of cycles) {
    const key = c.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
    if (result.length >= maxCycles) break;
  }
  return result;
}

export class KuzuCodeStoreFactory implements CodeStoreFactory {
  constructor(private readonly driver: KuzuDriver) {}
  async open(dbPath: string): Promise<CodeStore> {
    return KuzuCodeStore.open(dbPath, this.driver);
  }
}
