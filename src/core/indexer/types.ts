/**
 * Domain types for the code indexer. A SymbolRecord is the unit of structural
 * knowledge; EdgeRecords form the call/dependency graph over symbols.
 *
 * Adapted from vendor/reference-indexer/src/index/types.ts — trimmed to
 * PAiRS's scope (no embeddings/semantic search; edge vocabulary matches
 * subsystem_indexer_spec.md §3/§4 rather than the reference's generic set).
 *
 * Resolution model: parsing is syntactic (web-tree-sitter), so cross-file
 * edges are resolved by name + import heuristics, not a type checker. Every
 * reference edge carries a `resolved` flag so tool responses can tell agents
 * when to double-check with Read/grep. See subsystem_indexer_spec.md §4.
 */

/**
 * v1 *validates* on Rust only (precision contract, benchmarks — see
 * plan.md S1 exit criteria); the parser/extractor layer supports all 12
 * languages the reference indexer shipped grammars for, so switching one on
 * later is a query-file + kind-map entry, not new extraction logic (idea.md
 * §5). Unvalidated languages parse and populate the graph; their
 * unresolved_ratio is simply not part of the v1 exit bar.
 */
export type CodeLang = 'c' | 'cpp' | 'python' | 'javascript' | 'typescript' | 'java' | 'go' | 'ruby' | 'dart' | 'rust' | 'css' | 'html';

export const CODE_LANGS: readonly CodeLang[] = ['c', 'cpp', 'python', 'javascript', 'typescript', 'java', 'go', 'ruby', 'dart', 'rust', 'css', 'html'];

/** v1 exit criteria (precision bench, golden corpus) cover Rust only. */
export const V1_VALIDATED_LANGS: readonly CodeLang[] = ['rust'];

export type SymbolKind = 'module' | 'function' | 'method' | 'class' | 'struct' | 'interface' | 'enum' | 'trait' | 'impl' | 'field' | 'var' | 'param' | 'const' | 'static' | 'macro';

export const SYMBOL_KINDS: readonly SymbolKind[] = ['module', 'function', 'method', 'class', 'struct', 'interface', 'enum', 'trait', 'impl', 'field', 'var', 'param', 'const', 'static', 'macro'];

/**
 * Structural edges (Pass 1 DECLARE) vs. reference edges (Pass 2 RESOLVE) —
 * see subsystem_indexer_spec.md §3. Structural edges are always resolved
 * (they come straight off the CST); reference edges carry `resolved: false`
 * when the resolver can't pin a unique target.
 *
 * PAiRS's own rule-engine vocabulary (CALLS/READS/WRITES/DEPENDS_ON/
 * IMPLEMENTS) is a Rust-first refinement of the reference project's generic
 * multi-language set (calls/extends/implements/references/imports). Both are
 * kept: the Rust extractor emits the refined kinds; other languages' `.scm`
 * queries emit the generic ones until each gets its own Rust-style pass.
 */
export type StructuralEdgeKind = 'DECLARES' | 'PARAM' | 'OF_TYPE' | 'RETURNS' | 'OWNS';
export type ReferenceEdgeKind = 'CALLS' | 'READS' | 'WRITES' | 'DEPENDS_ON' | 'IMPLEMENTS' | 'EXTENDS' | 'REFERENCES' | 'IMPORTS';
export type EdgeKind = StructuralEdgeKind | ReferenceEdgeKind;

export const STRUCTURAL_EDGE_KINDS: readonly StructuralEdgeKind[] = ['DECLARES', 'PARAM', 'OF_TYPE', 'RETURNS', 'OWNS'];
export const REFERENCE_EDGE_KINDS: readonly ReferenceEdgeKind[] = ['CALLS', 'READS', 'WRITES', 'DEPENDS_ON', 'IMPLEMENTS', 'EXTENDS', 'REFERENCES', 'IMPORTS'];

/** How a reference edge's target was resolved — the O1 precision contract. */
export type EdgeConfidence = 'resolved' | 'fuzzy' | 'unresolved';

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
  /** Monorepo scoping (O6): which crate this file belongs to. */
  crate: string | null;
  parseError: boolean;
}

export interface SymbolRecord {
  id: number;
  fileId: number;
  /** Workspace-relative path (denormalized for cheap rendering). */
  file: string;
  /** Bare name: `login`. */
  name: string;
  /** Module-qualified name: `auth::service::login`. Used for baseline identity (O4). */
  qualified: string;
  kind: SymbolKind;
  lang: CodeLang;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Params + return as written. */
  signature: string | null;
  /** Leading doc comment, trimmed of `///`/`//!` markers. */
  doc: string | null;
  /** Containment: method → impl block, field → struct. Null at module scope. */
  parentId: number | null;
  /** `pub` visibility. */
  exported: boolean;
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
  /** Bare final segment: `login` for both `login` and `AuthService::login`. */
  name: string;
  /**
   * The reference as written when it carried a qualifier (`AuthService::login`,
   * `Base::f`); null for a bare reference. The resolver matches this against
   * `Symbol.qualified` first and only falls back to `name`, which is what keeps
   * the ~180 `X::new()` call sites in a Rust codebase from collapsing onto one
   * bare `new` candidate set.
   */
  qualifiedName: string | null;
  kind: ReferenceEdgeKind;
  line: number;
  /**
   * True when the reference is a method/member call on a receiver
   * (`obj.foo()`, `self.bar()`) rather than a free-standing name. A bare
   * method call carries NO path information about its target — the receiver's
   * static type is unknown (S1 deferral) — so the resolver must never mark it
   * `resolved` just because one workspace symbol happens to share the name.
   * Without this cap, ripgrep's `#[derive(Clone)]` `.clone()` sites resolved
   * "confirmed" onto the single explicit `Error::clone` in another crate,
   * leaking 207 false confirmed layering violations (R1 breach).
   */
  methodCall?: boolean;
  /**
   * True when the reference site lies inside a test region — a
   * `#[cfg(test)]`/`mod tests` block or a `#[test]` fn. Test code deliberately
   * depends "upward" (a core unit test driving the real sim integrator), so
   * architectural rules (Layering/ForbiddenDep/VisibilityBoundary/NoCycles)
   * must exclude these edges or every inline test module is a Tier-1 false
   * positive (R1 gate — seen on ARES geom.rs).
   */
  inTest?: boolean;
}

/** `use` statements — pass 2 uses these to scope name resolution. */
export interface RawUse {
  /** As written: `crate::auth::service`, `std::collections::HashMap`. */
  specifier: string;
  /** Names bound locally (`use foo::Bar as Baz` → ['Baz']); empty = glob import. */
  boundNames: string[];
  isGlob: boolean;
  line: number;
  /** `use` written inside a test region (see RawRef.inTest). */
  inTest?: boolean;
}

/** Complete pass-1 output for one file. Replaces all prior rows for that file. */
export interface FileExtraction {
  path: string;
  lang: CodeLang;
  mtimeMs: number;
  size: number;
  hash: string;
  crate: string | null;
  parseError: boolean;
  symbols: NewSymbol[];
  refs: RawRef[];
  uses: RawUse[];
}

// ---------------------------------------------------------------------------
// Analysis results — backs core/analyze (subsystem_mcp_rules_spec.md §5)
// ---------------------------------------------------------------------------

export interface DeadCodeCandidate {
  symbol: SymbolRecord;
  /** Why the candidate survived filtering despite being plausible-looking API. */
  note: 'exported' | null;
}

export interface DeadCodeFilter {
  pathPrefix?: string;
  excludePath?: string;
  kinds?: SymbolKind[];
  /** Include exported (`pub`) symbols. Default false. */
  includeExported?: boolean;
  limit?: number;
  offset?: number;
}

/** One file-level dependency derived from DEPENDS_ON edges. */
export interface FileDep {
  path: string;
  /** Line of the `use`/reference in the *depending* file. */
  line: number;
  /** Hops from the queried file (1 = direct; >1 only when transitive). */
  depth: number;
}

export interface HotspotQuery {
  /** Only functions/methods; ranked by fan-out (out-degree of CALLS edges). */
  threshold?: number;
  pathPrefix?: string;
  limit?: number;
  offset?: number;
}

export interface IndexStats {
  files: number;
  symbols: number;
  edges: number;
  pendingRefs: number;
  /**
   * pendingRefs / (edges + pendingRefs).
   *
   * NOT a resolver-precision metric: PAiRS indexes workspace code only, so
   * every `assert!`/`Vec::new`/framework call is correctly unresolved and lands
   * here. On the ARES sample this sat near 50% while *zero* unresolved refs
   * named a workspace symbol — it mostly measures how much stdlib a codebase
   * uses. Precision is `fuzzyRate`; see plan.md S1.
   */
  unresolvedRatio: number;
  /** Of `pendingRefs`, those naming nothing in the workspace — external/stdlib calls, not failures. */
  externalRefs: number;
  /** Unresolved refs that DO name a workspace symbol: genuine resolver misses. Expected 0. */
  resolvableMisses: number;
  /** fuzzy / (fuzzy + resolved) over reference edges — the real precision number (R1). */
  fuzzyRate: number;
  lastIndexedAt: number | null;
  /** Symbol counts per kind (`module` excluded, matching `symbols`). Absent kinds are omitted. */
  byKind: Partial<Record<SymbolKind, number>>;
}

// ---------------------------------------------------------------------------
// Test↔code mapping (test_gap rule / untested()) — path-based heuristic only;
// Rust `#[cfg(test)]` in-file test modules are invisible to this v1 pass.
// ---------------------------------------------------------------------------

/**
 * Test-path predicate as regex *source*, so the same definition can be handed
 * to Cypher's `regexp_matches` (default rules, untested()) and to JS. Substring
 * tests like `contains(file, 'test')` are not usable here: they also match
 * `latest.ts`, `contest/`, `testimonials/`, and they miss `.spec.ts` entirely —
 * both directions produced default-rule false positives.
 */
export const TEST_PATH_REGEX =
  '(^|/)(tests?|__tests__)/|\\.(test|spec)\\.[a-zA-Z]+$|_test\\.(rs|go|py)$|(^|/)tests\\.rs$|(^|/)(test_[^/]+|conftest)\\.py$';

/**
 * {@link TEST_PATH_REGEX} with every backslash doubled, ready to paste inside a
 * Cypher single-quoted literal — Kuzu unescapes `\\` to `\` when parsing one.
 */
export const TEST_PATH_REGEX_CYPHER = TEST_PATH_REGEX.replace(/\\/g, '\\\\');

const TEST_PATH_RE = new RegExp(TEST_PATH_REGEX);

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/**
 * Functions the host calls, not the workspace: they have no in-workspace
 * caller by design, so fan-out and dead-code passes must not flag them.
 */
export const ENTRY_POINT_NAMES: ReadonlySet<string> = new Set(['main', 'activate', 'deactivate']);

/** Returned when a tool's `symbol` argument matches more than one symbol. */
export interface AmbiguousSymbol {
  ambiguous: true;
  candidates: SymbolRecord[];
}
