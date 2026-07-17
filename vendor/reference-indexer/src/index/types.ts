/**
 * Domain types for the code indexer — the structural counterpart to the
 * episodic memory store. A SymbolRecord is the unit of structural knowledge;
 * EdgeRecords form the call/inheritance graph over symbols.
 *
 * Design note: docs/ArchSpec.md. Storage contract: src/index/codeStore.ts.
 *
 * Resolution model: parsing is syntactic (web-tree-sitter), so cross-file
 * edges are resolved by name + import heuristics, not a type checker. Every
 * edge carries a `confidence` so tool responses can tell agents when to
 * double-check with Read/grep.
 */

/** Languages indexed in v1. Maps 1:1 to a grammar wasm + a .scm query file. */
export type CodeLang = 'c' | 'cpp' | 'python' | 'javascript' | 'typescript' | 'java' | 'go' | 'ruby' | 'dart' | 'rust' | 'css' | 'html';

export const CODE_LANGS: readonly CodeLang[] = [
  'c',
  'cpp',
  'python',
  'javascript',
  'typescript',
  'java',
  'go',
  'ruby',
  'dart',
  'rust',
  'css',
  'html',
];

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'struct'
  | 'interface' // Java/TS interface; C++ abstract class maps to 'class'
  | 'enum'
  | 'field'
  | 'var' // top-level/module-scope variable or constant
  | 'macro' // C/C++ #define
  | 'module'; // Python module, JS/TS file-as-module, Java package-info

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  'function',
  'method',
  'class',
  'struct',
  'interface',
  'enum',
  'field',
  'var',
  'macro',
  'module',
];

export type EdgeKind =
  | 'calls' // from calls to
  | 'extends' // from is a subclass of to
  | 'implements' // from implements interface to (Java/TS; Python ABC maps to extends)
  | 'references' // any other identifier use (type annotation, field access, …)
  | 'imports'; // from's file imports to's module/header

/** How the edge target was resolved (see resolution model above). */
export type EdgeConfidence =
  | 'resolved' // unambiguous: same-file scope or exactly one import-path match
  | 'fuzzy'; // name matched >1 candidate; edges exist to each candidate

export interface FileRecord {
  id: number;
  /** Workspace-relative, POSIX separators. */
  path: string;
  lang: CodeLang;
  mtimeMs: number;
  size: number;
  /** Content hash (sha1 hex) — skip re-parse when unchanged even if mtime moved. */
  hash: string;
  indexedAt: number; // epoch ms
}

export interface SymbolRecord {
  id: number;
  fileId: number;
  /** Workspace-relative path (denormalized for cheap rendering). */
  file: string;
  /** Bare name: `login`. */
  name: string;
  /**
   * Language-qualified name used for lookups and rendering:
   * `AuthService.login` (Java/TS/Python), `ns::Class::method` (C++),
   * `mod.fn` (Python module-level). Falls back to `name` at file scope in C.
   */
  qualified: string;
  kind: SymbolKind;
  lang: CodeLang;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Params + return as written, e.g. `(user: User, opts?) => Promise<Session>`. */
  signature: string | null;
  /** Leading doc comment (JSDoc/docstring/Doxygen/Javadoc), trimmed of markers. */
  doc: string | null;
  /** Containment: method → class, nested class → outer. Null at file scope. */
  parentId: number | null;
  /** Exported / public API surface (export, non-static in C headers, public in Java). */
  exported: boolean;
  /**
   * Cyclomatic complexity: decision points in the symbol's subtree + 1.
   * Always 1 for non-executable kinds (class/interface/enum/field/var/module —
   * their methods carry their own counts; containers never sum children).
   */
  complexity: number;
  /**
   * Cognitive complexity (SonarSource simplified rules — see extractors.ts
   * "Complexity walk" contract): each decision construct costs 1 + current
   * nesting depth; `else`/`elif` cost 1 flat; boolean-operator runs cost 1 per
   * run (not per operator). 0 for non-executable kinds.
   */
  cognitive: number;
}

export interface EdgeRecord {
  fromId: number;
  toId: number;
  kind: EdgeKind;
  /** 1-based line of the reference site in `from`'s file. */
  line: number;
  confidence: EdgeConfidence;
}

// ---------------------------------------------------------------------------
// Extraction (pass 1) — what a parser/extractor emits for one file
// ---------------------------------------------------------------------------

/** A symbol as extracted, before the store assigns ids. */
export type NewSymbol = Omit<SymbolRecord, 'id' | 'fileId' | 'file' | 'parentId'> & {
  /** Index into FileExtraction.symbols of the containing symbol, or null. */
  parentIndex: number | null;
};

/**
 * A reference whose target is not yet known (pass 2 resolves it).
 * `fromIndex` points into FileExtraction.symbols; references made at file
 * scope (outside any symbol) attach to the file's implicit 'module' symbol.
 */
export interface RawRef {
  fromIndex: number;
  /** Referenced name as written: `login`, `AuthService.login`, `Base::f`. */
  name: string;
  kind: EdgeKind;
  line: number;
}

/** Import/include statements — pass 2 uses these to scope name resolution. */
export interface RawImport {
  /** As written: `./auth/service`, `<vector>`, `com.acme.auth.AuthService`, `os.path`. */
  specifier: string;
  /** Names bound locally (`import { login as doLogin }` → ['doLogin']); empty = whole module. */
  boundNames: string[];
  line: number;
}

/** Complete pass-1 output for one file. Replaces all prior rows for that file. */
export interface FileExtraction {
  path: string;
  lang: CodeLang;
  mtimeMs: number;
  size: number;
  hash: string;
  symbols: NewSymbol[];
  refs: RawRef[];
  imports: RawImport[];
}

// ---------------------------------------------------------------------------
// Queries / results (what the tools consume)
// ---------------------------------------------------------------------------

export interface CodeQuery {
  text: string;
  kinds?: SymbolKind[];
  langs?: CodeLang[];
  /** Restrict to files under this workspace-relative directory prefix. */
  pathPrefix?: string;
  /** Skip files under this workspace-relative directory prefix. */
  excludePath?: string;
  exportedOnly?: boolean;
  limit?: number; // default 10
  /** Skip this many results (pagination); applied after fusion ranking. */
  offset?: number;
}

export interface ScoredSymbol {
  symbol: SymbolRecord;
  /** Fused relevance in 0..1 (BM25 + optional semantic + boosts). */
  score: number;
  /** Per-signal breakdown, mirroring ScoredMemory.signals. */
  signals: { fts: number; semantic: number; exactName: number; exported: number };
}

/** One node in a who_calls result tree (depth ≥ 2 nests via `children`). */
export interface CallTreeNode {
  symbol: SymbolRecord;
  /** Reference site in the caller/callee file. */
  line: number;
  confidence: EdgeConfidence;
  children: CallTreeNode[];
}

export interface TypeRelation {
  symbol: SymbolRecord;
  kind: Extract<EdgeKind, 'extends' | 'implements'>;
  confidence: EdgeConfidence;
  /** Hops from the queried type (1 = direct). */
  depth: number;
}

/** Returned when a tool's `symbol` argument matches more than one symbol. */
export interface AmbiguousSymbol {
  ambiguous: true;
  candidates: SymbolRecord[];
}

// ---------------------------------------------------------------------------
// Analysis results (v4 tools: find_dead_code, file_deps, code_hotspots,
// find_duplicates — see docs/ArchSpec.md for the analysis-tool notes)
// ---------------------------------------------------------------------------

/**
 * A symbol with zero incoming edges of ANY kind. This is a *candidate*, not a
 * verdict: resolution is syntactic, so dynamic dispatch, reflection, and
 * string-based lookups are invisible. Tool output must carry that caveat.
 */
export interface DeadCodeCandidate {
  symbol: SymbolRecord;
  /**
   * Why the candidate survived filtering despite being plausible-looking API,
   * e.g. 'exported' when includeExported was set. Null for the common case.
   */
  note: 'exported' | null;
}

export interface DeadCodeFilter {
  /** Restrict to files under this workspace-relative directory prefix. */
  pathPrefix?: string;
  /** Skip files under this workspace-relative directory prefix. */
  excludePath?: string;
  kinds?: SymbolKind[];
  langs?: CodeLang[];
  /**
   * Include exported symbols. Default false: exported symbols may be consumed
   * outside the workspace (published API, dynamic loading) and are the main
   * false-positive source.
   */
  includeExported?: boolean;
  limit?: number; // default 30
  /** Skip this many results (pagination). */
  offset?: number;
}

/** One file-level dependency derived from `imports` edges. */
export interface FileDep {
  /** Workspace-relative path of the related file. */
  path: string;
  /** Line of the import statement in the *importing* file. */
  line: number;
  /** Hops from the queried file (1 = direct; >1 only when transitive). */
  depth: number;
}

/** A pair of symbols whose symbol-card embeddings are near-duplicates. */
export interface SimilarPair {
  a: SymbolRecord;
  b: SymbolRecord;
  /** Cosine similarity in 0..1 over symbol cards (name/signature/doc — NOT bodies). */
  similarity: number;
}

export interface HotspotQuery {
  /** Which metric to rank by. Default 'cognitive'. */
  metric?: 'cyclomatic' | 'cognitive';
  /** Only symbols at or above this value. Default: no floor (pure top-N). */
  threshold?: number;
  pathPrefix?: string;
  /** Narrow within function|method (e.g. methods only). */
  kinds?: SymbolKind[];
  langs?: CodeLang[];
  limit?: number; // default 20
  /** Skip this many results (pagination). */
  offset?: number;
}

export interface IndexStats {
  files: number;
  symbols: number;
  edges: number;
  pendingRefs: number;
  pendingEmbeddings: number;
  lastIndexedAt: number | null;
}

// ---------------------------------------------------------------------------
// Test↔code mapping (who_tests / find_untested) — shared predicate so the
// executor's grouping and the store's SQL exclusions never drift apart. The
// store mirrors these as SQL LIKE patterns (see TEST_PATH_PATTERNS in
// codeStoreImpl.ts); keep both lists in sync if you add a pattern here.
// Rust `#[cfg(test)]` in-file test modules are invisible to this v1
// heuristic — it is purely path-based.
// ---------------------------------------------------------------------------

/** File-path patterns that mark a file as test code (workspace-relative). */
export const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /\.test\.[^/]+$/,
  /\.spec\.[^/]+$/,
  /_test\.[^/]+$/,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)(tests?|__tests__)\//i,
];

export function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(path));
}
