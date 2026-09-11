/**
 * Extractor implementation: runs a language's compiled query over a parsed
 * tree and folds captures into a FileExtraction. See extractors.ts for the
 * capture-name contract this depends on. One implementation over all 12
 * languages — everything language-specific lives in the query file.
 *
 * Adapted from vendor/reference-indexer/src/index/extractorImpl.ts — the
 * containment-stack / qualified-name / ref-folding logic is unchanged in
 * shape; complexity counting and FTS name-splitting were dropped (out of
 * PAiRS's scope, see extractors.ts). DEF_CAPTURE_TO_KIND is the reference
 * project's map unchanged (`def.struct`/`def.interface` etc. already existed
 * for Rust/Java/TS there). REF_CAPTURE_TO_KIND is Rust-specific — it maps
 * onto PAiRS's own rule-engine vocabulary (subsystem_indexer_spec.md §3);
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
  gdscript: '.',
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

/** Rust emits PAiRS's refined rule-engine vocabulary (subsystem_indexer_spec.md §3). */
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
   * source of `fuzzy` CALLS edges — the S1 precision fix).
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
/**
 * Does `#[<needle>...]` appear among the item's preceding attribute siblings?
 * Rust attributes are `attribute_item` siblings immediately before the item
 * node, so walk back over attributes/comments only. `needle` matches the start
 * of the attribute body: 'test' matches `#[test]` but not `#[tests_util]`.
 */
function hasAttr(item: Node, needle: string): boolean {
  for (let sib = item.previousNamedSibling; sib; sib = sib.previousNamedSibling) {
    if (sib.type === 'attribute_item') {
      const body = sib.text.replace(/^#\s*\[\s*/, '');
      if (body.startsWith(needle) && !/^[A-Za-z0-9_]/.test(body.slice(needle.length))) return true;
      continue;
    }
    if (sib.type === 'line_comment' || sib.type === 'block_comment') continue;
    break;
  }
  return false;
}

/** Prefixes `stripReceiver` erases — kept in one place so detection and stripping can't drift apart. */
const SELF_RECEIVER_RE = /^(this|self|Self|cls)\.|^(self|Self)::/;

function stripReceiver(name: string): string {
  return name.replace(SELF_RECEIVER_RE, '');
}

/**
 * True when `node` (the property/field/attribute identifier captured by
 * `@ref.call`) is a direct member access off a bare `this`/`self`/`Self`/`cls`
 * receiver — `this.foo` in `member_expression`, `self.foo` in
 * `field_expression`, `self.foo` in Python's `attribute`. The query captures
 * only the identifier itself (`foo`), never the receiver, so this can't be
 * read off `name` the way the `::`-qualified case can — it has to walk up to
 * the receiver node in the CST.
 *
 * A receiver of anything other than a bare identifier (`self.engine.foo`,
 * `this.getEngine().foo`) is a value chain, not a self reference, and must not
 * match — the static type of `engine` is exactly the kind of thing this
 * repo's fuzzy cap exists for.
 */
function isSelfReceiverMemberAccess(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  // Field name varies by grammar: TS/JS member_expression → object, Rust
  // field_expression → value, C++ field_expression → argument, Ruby call →
  // receiver. `this`/`self` are dedicated node types in most grammars (TS,
  // Java, C++, Ruby) but a plain `identifier` in Python's.
  const receiver =
    parent.childForFieldName('object') ??
    parent.childForFieldName('value') ??
    parent.childForFieldName('argument') ??
    parent.childForFieldName('receiver');
  if (!receiver) return false;
  if (receiver.type === 'this' || receiver.type === 'self') return true;
  return receiver.type === 'identifier' && /^(this|self|Self|cls)$/.test(receiver.text);
}

/**
 * TypeScript/JavaScript only (grammar `typescript`): the declared type name
 * of a `member_expression` call's receiver, when the receiver is a bare
 * identifier bound as a parameter or a `const`/`let` with a written type
 * annotation somewhere in an enclosing scope — `function f(x: Widget) {
 * x.foo() }` or `const w: Widget = ...; w.foo()`. Returns null for anything
 * else (untyped bindings, property chains, `any`/generic-looking names),
 * since those give the resolver no more evidence than a bare method call.
 *
 * Walks outward through enclosing block/function scopes rather than doing a
 * whole-file scope analysis — good enough for the common case (the
 * declaration lives in the same function or an ancestor) without building a
 * real symbol table.
 */
function tsReceiverDeclaredType(node: Node): string | null {
  const parent = node.parent;
  if (!parent) return null;
  const receiver = parent.childForFieldName('object');
  if (!receiver || receiver.type !== 'identifier') return null;
  const receiverName = receiver.text;

  const typeNameOf = (typeAnnotation: Node | null): string | null => {
    if (!typeAnnotation) return null;
    // `type_annotation` wraps `: Foo` — its one named child is the type node.
    const typeNode = typeAnnotation.namedChild(0);
    if (!typeNode || typeNode.type !== 'type_identifier') return null;
    return typeNode.text;
  };

  // Function-like node types across the grammar's several call shapes
  // (declarations, arrow functions, methods, function expressions).
  const isFunctionLike = (n: Node): boolean =>
    /^(function_declaration|arrow_function|function_expression|method_definition|generator_function_declaration)$/.test(n.type);

  for (let scope: Node | null = node.parent; scope !== null; scope = scope.parent) {
    if (!isFunctionLike(scope)) continue;
    // Parameters of the enclosing function — `parameters: formal_parameters`
    // is a SIBLING field of `body`, never an ancestor of the call node
    // (which lives inside `body`), so it must be read off the function node
    // directly rather than found by walking further up.
    const params = scope.childForFieldName('parameters');
    if (params) {
      for (const param of params.namedChildren) {
        if (!param) continue;
        const pat = param.childForFieldName('pattern');
        if (pat?.type === 'identifier' && pat.text === receiverName) {
          const t = typeNameOf(param.childForFieldName('type'));
          if (t) return t;
        }
      }
    }
    // `const`/`let` declarations anywhere in the enclosing function body — a
    // sibling statement earlier in the block, not an ancestor of the call
    // node, so this needs a subtree scan rather than another parent walk.
    const body = scope.childForFieldName('body') ?? scope;
    const found = findVariableDeclaratorType(body, receiverName, typeNameOf);
    if (found) return found;
  }
  return null;
}

/** Depth-first search for a `variable_declarator` binding `name` with a written type annotation. */
function findVariableDeclaratorType(
  root: Node,
  name: string,
  typeNameOf: (typeAnnotation: Node | null) => string | null
): string | null {
  if (root.type === 'variable_declarator') {
    const declName = root.childForFieldName('name');
    if (declName?.type === 'identifier' && declName.text === name) {
      const t = typeNameOf(root.childForFieldName('type'));
      if (t) return t;
    }
  }
  for (const child of root.namedChildren) {
    if (!child) continue;
    // Don't descend into a nested function-like scope — a same-named local
    // there is a different binding, not this receiver's declaration.
    if (/^(function_declaration|arrow_function|function_expression|method_definition)$/.test(child.type)) continue;
    const found = findVariableDeclaratorType(child, name, typeNameOf);
    if (found) return found;
  }
  return null;
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
      const rawUses: Array<{ node: Node; specifier: string; bound: string[]; line: number }> = [];
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

      // Test regions: `#[cfg(test)]`-attributed mods (or the conventional
      // `mod tests`) and `#[test]`-attributed fns. References/uses inside them
      // are flagged inTest so architectural rules can exclude them — a core
      // unit test calling the real sim integrator is deliberate, not a
      // layering breach (R1: this was a Tier-1 FP on ARES).
      const testRanges: Array<{ start: number; end: number }> = [];
      for (const d of defs) {
        const t = d.node.type;
        const isTestMod = t === 'mod_item' && (d.name === 'tests' || hasAttr(d.node, 'cfg(test)'));
        const isTestFn = t === 'function_item' && hasAttr(d.node, 'test');
        if (isTestMod || isTestFn) testRanges.push({ start: d.node.startIndex, end: d.node.endIndex });
      }
      const inTestRegion = (n: Node): boolean =>
        testRanges.some((r) => n.startIndex >= r.start && n.endIndex <= r.end);

      // Resolve refs to their innermost enclosing def (module symbol = index 0
      // when no def encloses the reference site).
      // Scope-only entries have no symbol, so a ref inside one attributes to
      // the nearest enclosing real def (or the module symbol).
      const defRanges = defs
        .filter((d) => !d.scope)
        .map((d) => ({ index: nodeIdToIndex.get(d.node.id)!, def: d }));
      /**
       * True when `name` is bound as a parameter of some function enclosing
       * `node` — i.e. the call target is a local binding, not a workspace
       * symbol.
       *
       * Parameters are deliberately not indexed as symbols, so without this a
       * bare `pick(e)` whose `pick` is a callback parameter falls through to
       * the resolver's global name ladder and binds to the only workspace
       * symbol named `pick` — in another module. That produced a *confirmed*
       * cross-module CALLS edge (analyze/hierarchy.ts → adapters/bench) and a
       * false Tier-1 layering error. A higher-order function taking `fn`,
       * `cb`, `next`, or `handler` hits this constantly.
       *
       * Detected structurally rather than per-grammar: every supported
       * language nests parameter identifiers under a node whose type contains
       * "param" (formal_parameters, required_parameter, parameter_list,
       * method_parameters, parameters, …).
       */
      const shadowedByParam = (node: Node, name: string): boolean => {
        for (let fn: Node | null = node.parent; fn !== null; fn = fn.parent) {
          for (const child of fn.namedChildren) {
            if (child === null || !/param/i.test(child.type)) continue;
            // Any identifier directly under the parameter list binds a name.
            const names: string[] = [];
            const collect = (n: Node): void => {
              if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') names.push(n.text);
              for (const c of n.namedChildren) if (c !== null) collect(c);
            };
            collect(child);
            if (names.includes(name)) return true;
          }
        }
        return false;
      };

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
        // A bare ref naming an enclosing parameter is a call through that
        // local binding. Its real target is whatever the caller passed in, is
        // not knowable here, and is certainly not a same-named symbol in
        // another module — so emit no edge at all rather than a wrong one.
        // Qualified refs are exempt: the qualifier already constrains them.
        const bare = bareRefName(ref.name);
        if (qualifiedRefName(ref.name) === null && shadowedByParam(ref.node, bare)) continue;

        extraction.refs.push({
          fromIndex: enclosing,
          name: bare,
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
          // Two shapes carry this evidence: a `self::`/`Self::` scoped path,
          // whose text survives on `ref.name` (checked before stripReceiver
          // erases it); and a `this.foo`/`self.foo` member access, where the
          // query captures only the property identifier and the receiver has
          // to be read off the CST instead (see isSelfReceiverMemberAccess).
          selfReceiver: SELF_RECEIVER_RE.test(ref.name) || isSelfReceiverMemberAccess(ref.node),
          // TypeScript only (Step 2.3): the receiver's declared type, when it
          // can be read off a typed parameter or const/let in an enclosing
          // scope — lets the resolver look the method up on that type
          // directly instead of capping at the workspace-wide name ladder.
          receiverType:
            loaded.lang === 'typescript' && ref.node.type === 'property_identifier'
              ? (tsReceiverDeclaredType(ref.node) ?? undefined)
              : undefined,
          inTest: inTestRegion(ref.node),
        });
      }

      for (const use of rawUses) {
        extraction.uses.push({
          specifier: use.specifier,
          boundNames: use.bound,
          isGlob: use.specifier.endsWith('*'),
          line: use.line,
          inTest: inTestRegion(use.node),
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
    rawUses: Array<{ node: Node; specifier: string; bound: string[]; line: number }>,
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
        node: specCap.node,
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
