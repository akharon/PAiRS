/**
 * Extractor implementation: runs a language's compiled query over a parsed
 * tree and folds captures into a FileExtraction. See extractors.ts for the
 * capture-name contract this depends on. One implementation over all 12
 * languages — everything language-specific lives in the query file.
 *
 * Adapted from vendor/reference-indexer/src/index/extractorImpl.ts — the
 * containment-stack / qualified-name / ref-folding logic is unchanged in
 * shape; complexity counting and FTS name-splitting were dropped (out of
 * GIZEM's scope, see extractors.ts). DEF_CAPTURE_TO_KIND is the reference
 * project's map unchanged (`def.struct`/`def.interface` etc. already existed
 * for Rust/Java/TS there). REF_CAPTURE_TO_KIND is Rust-specific — it maps
 * onto GIZEM's own rule-engine vocabulary (subsystem_indexer_spec.md §3);
 * other languages fall back to GENERIC_REF_KIND (the reference project's
 * original calls/extends/implements/references, hoisted into EdgeKind — see
 * types.ts). Trait bounds in Rust ARE `ref.implements`, matching the .scm.
 */

import * as crypto from 'node:crypto';
import type { Node, QueryCapture, QueryMatch } from 'web-tree-sitter';
import type { LoadedLanguage } from './parserRegistry';
import type { Extractor } from './extractors';
import type { CodeLang, FileExtraction, NewSymbol, ReferenceEdgeKind, SymbolKind } from './types';

const QUALIFIER_SEP: Readonly<Record<CodeLang, string>> = {
  c: '::',
  cpp: '::',
  python: '.',
  javascript: '.',
  typescript: '.',
  java: '.',
  go: '.',
  ruby: '.',
  dart: '.',
  rust: '::',
  css: '.',
  html: '.',
};

const DEF_CAPTURE_TO_KIND: Readonly<Record<string, SymbolKind>> = {
  'def.function': 'function',
  'def.method': 'method',
  'def.class': 'class',
  'def.struct': 'struct',
  'def.interface': 'interface',
  'def.enum': 'enum',
  'def.field': 'field',
  'def.var': 'var',
  'def.macro': 'macro',
  'def.module': 'module',
};

/** Rust emits GIZEM's refined rule-engine vocabulary (subsystem_indexer_spec.md §3). */
const RUST_REF_CAPTURE_TO_KIND: Readonly<Record<string, ReferenceEdgeKind>> = {
  'ref.call': 'CALLS',
  'ref.implements': 'IMPLEMENTS',
  // Supertrait bound: `trait Shape: Draw` — Shape EXTENDS Draw. Without this
  // entry the capture is silently dropped (the trait-inheritance graph is lost).
  'ref.extends': 'EXTENDS',
  'ref.reference': 'DEPENDS_ON',
};

/** All other languages emit the reference project's original generic kinds. */
const GENERIC_REF_CAPTURE_TO_KIND: Readonly<Record<string, ReferenceEdgeKind>> = {
  'ref.call': 'CALLS',
  'ref.extends': 'EXTENDS',
  'ref.implements': 'IMPLEMENTS',
  'ref.reference': 'REFERENCES',
};

function refCaptureMap(lang: CodeLang): Readonly<Record<string, ReferenceEdgeKind>> {
  return lang === 'rust' ? RUST_REF_CAPTURE_TO_KIND : GENERIC_REF_CAPTURE_TO_KIND;
}

interface PendingDef {
  node: Node;
  name: string;
  kind: SymbolKind;
  paramsText: string | null;
  retText: string | null;
  docText: string | null;
  exported: boolean;
  /**
   * Qualifier-only entry (`@scope.<name>` capture): contributes a segment to
   * descendants' `qualified` but emits no symbol of its own. Exists for
   * constructs that name a scope without declaring anything new — Rust's
   * `impl Greeter` block, whose symbol is the separately-captured
   * `struct_item`. Without it, methods qualify bare and every same-named
   * method across every type collides into one candidate set (the dominant
   * source of `fuzzy` CALLS edges — see plan.md S1).
   */
  scope: boolean;
}

function stripCommentMarkers(text: string): string {
  return text
    .replace(/^\/\*\*?|\*\/$/g, '')
    .replace(/^\/\/+/, '')
    .replace(/^#+/, '')
    .replace(/^["']{3}|["']{3}$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .join('\n')
    .trim();
}

function buildSignature(paramsText: string | null, retText: string | null): string | null {
  if (!paramsText && !retText) return null;
  const params = paramsText ?? '()';
  return retText ? `${params}${retText}` : params;
}

/** Strips a receiver that names no type and so can't qualify anything. */
function stripReceiver(name: string): string {
  return name.replace(/^(this|self|Self|cls)\./, '').replace(/^(self|Self)::/, '');
}

/** Bare final segment of a possibly-qualified reference name (`this.x`/`self.x` → `x`). */
function bareRefName(name: string): string {
  const cleaned = stripReceiver(name);
  const parts = cleaned.split(/\.|::/);
  return parts[parts.length - 1] ?? cleaned;
}

/**
 * The reference as written if it carries a real qualifier, else null.
 *
 * Only `::` paths qualify: they name a type or module (`Foo::new`), which is
 * what `Symbol.qualified` is built from. A `.` chain is a *value* receiver
 * (`self.engine.start()`), whose static type we don't infer in v1 — treating
 * `engine.start` as a qualified name would never match and would silently
 * disable the bare-name fallback.
 */
function qualifiedRefName(name: string): string | null {
  const cleaned = stripReceiver(name);
  return cleaned.includes('::') ? cleaned : null;
}

export class ExtractorImpl implements Extractor {
  extract(loaded: LoadedLanguage, path: string, source: string, stat: { mtimeMs: number; size: number }, crate: string | null): FileExtraction {
    const hash = crypto.createHash('sha1').update(source).digest('hex');
    const tree = loaded.parser.parse(source);
    const extraction: FileExtraction = {
      path,
      lang: loaded.lang,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash,
      crate,
      parseError: false,
      symbols: [],
      refs: [],
      uses: [],
    };
    if (!tree) return extraction;

    try {
      extraction.parseError = tree.rootNode.hasError;

      const matches = loaded.query.matches(tree.rootNode);
      const defs: PendingDef[] = [];
      const rawRefs: Array<{ node: Node; name: string; kind: ReferenceEdgeKind }> = [];
      const rawUses: Array<{ specifier: string; bound: string[]; line: number }> = [];
      const standaloneExportedNames = new Set<string>();

      const refCaptures = refCaptureMap(loaded.lang);
      for (const match of matches) {
        this.foldMatch(match, refCaptures, defs, rawRefs, rawUses, standaloneExportedNames);
      }

      // Synthesize the implicit module symbol as symbols[0] so refs made at
      // file scope have somewhere to attach.
      const moduleSymbol: NewSymbol = {
        name: path.split('/').pop() ?? path,
        qualified: path,
        kind: 'module',
        lang: loaded.lang,
        startLine: 1,
        endLine: source.split('\n').length,
        signature: null,
        doc: null,
        exported: true,
        parentIndex: null,
      };
      extraction.symbols.push(moduleSymbol);

      // Sort defs by (start byte asc, end byte desc) so containment can be
      // computed with a simple stack: a def's parent is the nearest still-open
      // enclosing def.
      defs.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);

      // Stack entries carry `qualified` directly rather than a symbol index, so
      // scope-only entries (index === null) participate in qualification
      // without ever being pushed to extraction.symbols.
      const stack: Array<{ def: PendingDef; index: number | null; qualified: string }> = [];
      const nodeIdToIndex = new Map<number, number>();

      for (const def of defs) {
        while (stack.length && stack[stack.length - 1]!.def.node.endIndex <= def.node.startIndex) {
          stack.pop();
        }
        const sep = QUALIFIER_SEP[loaded.lang];
        const parentQualified = stack.length ? stack[stack.length - 1]!.qualified : null;
        const qualified = parentQualified ? `${parentQualified}${sep}${def.name}` : def.name;

        if (def.scope) {
          stack.push({ def, index: null, qualified });
          continue;
        }

        // parentIndex points at the nearest enclosing *symbol*, skipping past
        // scope-only entries: `qualified` gets the scope's segment, but the
        // graph edge must reference a node that exists.
        const parentIndex = [...stack].reverse().find((e) => e.index !== null)?.index ?? null;

        const symbol: NewSymbol = {
          name: def.name,
          qualified,
          kind: def.kind,
          lang: loaded.lang,
          startLine: def.node.startPosition.row + 1,
          endLine: def.node.endPosition.row + 1,
          signature: buildSignature(def.paramsText, def.retText),
          doc: def.docText ? stripCommentMarkers(def.docText) : null,
          exported: def.exported || standaloneExportedNames.has(def.name),
          parentIndex,
        };
        const index = extraction.symbols.length;
        extraction.symbols.push(symbol);
        nodeIdToIndex.set(def.node.id, index);
        stack.push({ def, index, qualified });
      }

      // Resolve refs to their innermost enclosing def (module symbol = index 0
      // when no def encloses the reference site).
      // Scope-only entries have no symbol, so a ref inside one attributes to
      // the nearest enclosing real def (or the module symbol).
      const defRanges = defs
        .filter((d) => !d.scope)
        .map((d) => ({ index: nodeIdToIndex.get(d.node.id)!, def: d }));
      for (const ref of rawRefs) {
        let enclosing = 0; // module symbol
        let bestSize = Infinity;
        for (const dr of defRanges) {
          const start = dr.def.node.startIndex;
          const end = dr.def.node.endIndex;
          if (ref.node.startIndex >= start && ref.node.endIndex <= end) {
            const size = end - start;
            if (size < bestSize) {
              bestSize = size;
              enclosing = dr.index;
            }
          }
        }
        extraction.refs.push({
          fromIndex: enclosing,
          name: bareRefName(ref.name),
          qualifiedName: qualifiedRefName(ref.name),
          kind: ref.kind,
          line: ref.node.startPosition.row + 1,
          // Bare names that carry no path evidence about their target — the
          // resolver caps these at `fuzzy` even on a unique name match:
          // member/method calls (Rust `field_identifier`, TS/JS
          // `property_identifier`, Python `attribute`) where the receiver's
          // static type is unknown, and Rust macro invocations (`write!`,
          // `matches!`) whose expansion is invisible to the AST — a workspace
          // fn/method sharing the macro's name is pure coincidence.
          methodCall:
            ref.node.type === 'field_identifier' ||
            ref.node.type === 'property_identifier' ||
            ref.node.parent?.type === 'attribute' ||
            ref.node.parent?.type === 'macro_invocation',
        });
      }

      for (const use of rawUses) {
        extraction.uses.push({
          specifier: use.specifier,
          boundNames: use.bound,
          isGlob: use.specifier.endsWith('*'),
          line: use.line,
        });
      }
    } finally {
      tree.delete();
    }

    return extraction;
  }

  private foldMatch(
    match: QueryMatch,
    refCaptures: Readonly<Record<string, ReferenceEdgeKind>>,
    defs: PendingDef[],
    rawRefs: Array<{ node: Node; name: string; kind: ReferenceEdgeKind }>,
    rawUses: Array<{ specifier: string; bound: string[]; line: number }>,
    standaloneExportedNames: Set<string>
  ): void {
    const byName = new Map<string, QueryCapture[]>();
    for (const cap of match.captures) {
      if (!byName.has(cap.name)) byName.set(cap.name, []);
      byName.get(cap.name)!.push(cap);
    }

    // `@scope` + `@scope.name`: a qualifier segment with no symbol of its own.
    const scopeNode = byName.get('scope')?.[0]?.node;
    const scopeName = byName.get('scope.name')?.[0]?.node;
    if (scopeNode && scopeName) {
      defs.push({
        node: scopeNode,
        name: scopeName.text,
        kind: 'module', // unused: scope entries never become symbols
        paramsText: null,
        retText: null,
        docText: null,
        exported: false,
        scope: true,
      });
    }

    const defCapture = [...byName.keys()].find((k) => k.startsWith('def.'));
    if (defCapture) {
      const kind = DEF_CAPTURE_TO_KIND[defCapture];
      const nameNode = byName.get('name')?.[0]?.node;
      const defNode = byName.get(defCapture)?.[0]?.node;
      if (kind && nameNode && defNode) {
        defs.push({
          node: defNode,
          name: nameNode.text,
          kind,
          paramsText: byName.get('params')?.[0]?.node.text ?? null,
          retText: byName.get('ret')?.[0]?.node.text ?? null,
          docText: byName.get('doc')?.[0]?.node.text ?? null,
          exported: byName.has('exported'),
          scope: false,
        });
      }
      // A single match can also carry ref.implements captures for the same
      // def (trait bounds on trait_item) — fall through.
    }

    for (const [capName, kind] of Object.entries(refCaptures)) {
      for (const cap of byName.get(capName) ?? []) {
        rawRefs.push({ node: cap.node, name: cap.node.text, kind });
      }
    }

    const specCap = byName.get('import.specifier')?.[0];
    if (specCap) {
      const bound = (byName.get('import.bound') ?? []).map((c) => c.node.text);
      rawUses.push({
        specifier: specCap.node.text.replace(/^["']|["']$/g, ''),
        bound,
        line: specCap.node.startPosition.row + 1,
      });
    } else if (byName.has('exported') && !defCapture) {
      const nameNode = byName.get('exported')![0]!.node;
      standaloneExportedNames.add(nameNode.text);
    }
  }
}

export const extractorImpl = new ExtractorImpl();
