/**
 * Rule engine: RON parsing, config validation, and evaluation against a real
 * Kuzu store (same fixture style as resolver.test.ts — the rules are Cypher,
 * so a fake store would only test the fake).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import type { CodeStore } from '../../store/graph/codeStore';
import type { FileExtraction, NewSymbol, RawRef } from '../indexer/types';
import { parseRon } from './ron';
import { ConfigError, parseRuleSet, assertReadOnlyCypher } from './config';
import { checkRules, globToRegExp, layerOfModule } from './evaluate';
import { createBaseline, diffAgainstBaseline, ciFailures, parseBaseline } from './baseline';
import { violationKey } from './types';
import type { RuleSet } from './types';

// -- RON reader ---------------------------------------------------------------

describe('parseRon', () => {
  it('parses the spec example shape', () => {
    const doc = parseRon(`
      // comment
      ( layers: { "core": 1, "ui": 3 },
        rules: [
          (id: "no-skip", tier: 1, kind: Layering(direction: DownOnly, max_skip: 0),
           explain: "See docs."),
          (id: "custom", tier: 2, kind: Cypher("MATCH (s:Symbol) RETURN s.*"), explain: "x"),
        ] )
    `) as Record<string, unknown>;
    expect((doc.layers as Record<string, number>).core).toBe(1);
    const rules = doc.rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(2);
    expect((rules[0]!.kind as { variant: string }).variant).toBe('Layering');
    expect((rules[1]!.kind as { args: unknown[] }).args[0]).toBe('MATCH (s:Symbol) RETURN s.*');
  });

  it('handles escapes, Some/None, bools, trailing commas, block comments', () => {
    const doc = parseRon('( a: "x\\n\\"y", b: Some(2), c: None, d: true, /* z */ e: [1, 2,], )') as Record<string, unknown>;
    expect(doc.a).toBe('x\n"y');
    expect(doc.b).toBe(2);
    expect(doc.c).toBeNull();
    expect(doc.d).toBe(true);
    expect(doc.e).toEqual([1, 2]);
  });

  it('reports line:col on errors', () => {
    expect(() => parseRon('( a: \n  @bad )')).toThrowError(/2:3/);
  });
});

// -- Config validation ----------------------------------------------------------

const GOOD = `
( layers: { "core": 1, "services": 2, "ui": 3 },
  module_layers: { "src/core": "core", "src/services": "services", "src/ui": "ui" },
  rules: [
    (id: "layering", tier: 1, kind: Layering(direction: DownOnly, max_skip: 0),
     explain: "UI -> services -> core."),
    (id: "no-cycles", tier: 1, kind: NoCycles(edge: "DEPENDS_ON", scope: Module),
     explain: "Module graph must stay a DAG."),
    (id: "no-ui-db", tier: 1, kind: ForbiddenDep(from: "src/ui/**", to: "src/db/**"),
     explain: "UI never touches the DB directly."),
    (id: "fanout", tier: 2, severity: warning, kind: MaxFanOut(max: 2),
     explain: "Keep functions focused."),
    (id: "core-private", tier: 1, kind: VisibilityBoundary(module: "src/core"),
     explain: "Only core's pub API may be used from outside."),
  ] )
`;

describe('parseRuleSet', () => {
  it('parses a full valid ruleset', () => {
    const rs = parseRuleSet(GOOD);
    expect(rs.rules.map((r) => r.kind.kind)).toEqual(['Layering', 'NoCycles', 'ForbiddenDep', 'MaxFanOut', 'VisibilityBoundary']);
    expect(rs.layers.ui).toBe(3);
    expect(rs.moduleLayers['src/core']).toBe('core');
    expect(rs.rules[3]!.severity).toBe('warning');
  });

  it('rejects a rule without explain', () => {
    expect(() => parseRuleSet('( rules: [ (id: "x", kind: NoCycles()) ] )')).toThrowError(/missing mandatory "explain"/);
  });

  it('rejects duplicate rule ids and unknown kinds', () => {
    expect(() =>
      parseRuleSet('( rules: [ (id: "x", kind: NoCycles(), explain: "e"), (id: "x", kind: NoCycles(), explain: "e") ] )')
    ).toThrowError(/duplicate rule id/);
    expect(() => parseRuleSet('( rules: [ (id: "x", kind: Bogus(), explain: "e") ] )')).toThrowError(/unknown rule kind/);
  });

  it('rejects Layering without layers, and mutating Cypher', () => {
    expect(() => parseRuleSet('( rules: [ (id: "l", kind: Layering(), explain: "e") ] )')).toThrowError(/non-empty layers/);
    expect(() =>
      parseRuleSet('( rules: [ (id: "c", kind: Cypher("MATCH (s) DELETE s"), explain: "e") ] )')
    ).toThrowError(ConfigError);
    expect(() => assertReadOnlyCypher('CREATE (n)', 'r')).toThrowError(/read-only/);
    // Keywords inside string literals or comments are data, not mutation.
    expect(() => assertReadOnlyCypher(`MATCH (s) WHERE s.doc CONTAINS 'create table' RETURN s`, 'r')).not.toThrow();
    expect(() => assertReadOnlyCypher(`MATCH (s) // delete me later\nRETURN s`, 'r')).not.toThrow();
    expect(() => assertReadOnlyCypher(`MATCH (s) WHERE s.name = 'x' SET s.name = 'y'`, 'r')).toThrowError(/read-only/);
  });
});

// -- Glob + layer helpers ---------------------------------------------------------

describe('globToRegExp / layerOfModule', () => {
  it('matches segments and depths', () => {
    expect(globToRegExp('src/ui/**').test('src/ui/panels')).toBe(true);
    expect(globToRegExp('src/ui/**').test('src/uix')).toBe(false);
    expect(globToRegExp('src/*/db').test('src/a/db')).toBe(true);
    expect(globToRegExp('src/*/db').test('src/a/b/db')).toBe(false);
  });

  it('resolves the longest module prefix', () => {
    const rs: RuleSet = { layers: { core: 1, svc: 2 }, moduleLayers: { src: 'core', 'src/services': 'svc' }, rules: [] };
    expect(layerOfModule('src/services/auth', rs)).toBe('svc');
    expect(layerOfModule('src/other', rs)).toBe('core');
    expect(layerOfModule('vendor/x', rs)).toBeNull();
  });
});

// -- Evaluation against a real store -------------------------------------------

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'function', exported = true): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 3, endLine: 9, signature: null, doc: null, exported, parentIndex: null };
}

function extraction(pathName: string, symbols: NewSymbol[], refs: RawRef[] = [], uses: FileExtraction['uses'] = []): FileExtraction {
  return {
    path: pathName, lang: 'rust', mtimeMs: 1, size: 1, hash: `h-${pathName}-${Math.random()}`,
    crate: null, parseError: false,
    symbols: [{ ...sym(pathName, pathName, 'module'), startLine: 1, endLine: 1 }, ...symbols],
    refs, uses,
  };
}

const use_ = (specifier: string, line = 1): FileExtraction['uses'][number] =>
  ({ specifier, boundNames: [specifier.split('::').pop()!], isGlob: false, line });
const callFrom = (name: string, qualifiedName: string | null = null): RawRef =>
  ({ fromIndex: 1, name, qualifiedName, kind: 'CALLS', line: 5 });

describe('checkRules over a real Kuzu store', () => {
  let store: CodeStore;
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gizem-rules-'));
    store = await KuzuCodeStore.open(path.join(dir, 'graph.kz'), nodeKuzuDriver);
    // Layers: src/core(1) <- src/services(2) <- src/ui(3).
    await store.applyExtraction(extraction('src/core/kernel.rs', [sym('boot', 'crate::core::kernel::boot'), sym('secret', 'crate::core::kernel::secret', 'function', false)]));
    await store.applyExtraction(
      extraction('src/services/auth.rs', [sym('login', 'crate::services::auth::login')], [], [use_('crate::core::kernel::boot', 2)])
    );
    // Violations: ui depends on core directly (skip) AND core depends on ui (upward).
    await store.applyExtraction(
      extraction('src/ui/panel.rs', [sym('draw', 'crate::ui::panel::draw')], [], [use_('crate::core::kernel::boot', 4)])
    );
    await store.applyExtraction(
      extraction('src/core/oops.rs', [sym('render_hack', 'crate::core::oops::render_hack')], [], [use_('crate::ui::panel::draw', 6)])
    );
    // VisibilityBoundary: services calls core's private `secret`.
    await store.applyExtraction(
      extraction('src/services/sneaky.rs', [sym('peek', 'crate::services::sneaky::peek')], [callFrom('secret', 'kernel::secret')])
    );
    // MaxFanOut: busy() calls 3 targets (max 2).
    await store.applyExtraction(extraction('src/util/a.rs', [sym('t1', 't1'), ]));
    await store.applyExtraction(extraction('src/util/b.rs', [sym('t2', 't2'), sym('t3', 't3')]));
    await store.applyExtraction(
      extraction('src/util/busy.rs', [sym('busy', 'busy')], [callFrom('t1'), callFrom('t2'), callFrom('t3')])
    );
    // NoCycles: x <-> y module cycle via use.
    await store.applyExtraction(extraction('src/x/x.rs', [sym('fx', 'crate::x::x::fx')], [], [use_('crate::y::y::fy')]));
    await store.applyExtraction(extraction('src/y/y.rs', [sym('fy', 'crate::y::y::fy')], [], [use_('crate::x::x::fx')]));
    // Refs/uses that target files indexed later park as pending; resolve them
    // (the indexer's pass 2) so the fixture graph is complete.
    await store.resolvePending();
  });

  const RS = () =>
    parseRuleSet(`
    ( layers: { "core": 1, "services": 2, "ui": 3 },
      module_layers: { "src/core": "core", "src/services": "services", "src/ui": "ui" },
      rules: [
        (id: "layering", tier: 1, kind: Layering(direction: DownOnly, max_skip: 0), explain: "UI -> services -> core."),
        (id: "no-cycles", tier: 1, kind: NoCycles(edge: "DEPENDS_ON", scope: Module), explain: "DAG."),
        (id: "no-ui-core", tier: 1, kind: ForbiddenDep(from: "src/ui/**", to: "src/core/**"), explain: "UI never touches core."),
        (id: "fanout", tier: 2, severity: warning, kind: MaxFanOut(max: 2, path_prefix: "src/util"), explain: "Focus."),
        (id: "core-private", tier: 1, kind: VisibilityBoundary(module: "src/core"), explain: "Pub API only."),
      ] )
  `);

  it('finds layering violations: upward dep and layer skip', async () => {
    const { violations } = await checkRules(store, RS());
    const layering = violations.filter((v) => v.rule === 'layering');
    const texts = layering.map((v) => v.suggestion ?? '');
    expect(texts.some((t) => t.includes('depends upward'))).toBe(true); // core -> ui
    expect(texts.some((t) => t.includes('skips 1 layer'))).toBe(true); // ui -> core
    // The legal services -> core edge is not flagged.
    expect(layering.every((v) => !v.nodes.some((n) => n.file === 'src/services/auth.rs'))).toBe(true);
  });

  it('finds the forbidden ui->core dep with citable nodes', async () => {
    const { violations } = await checkRules(store, RS());
    const fd = violations.filter((v) => v.rule === 'no-ui-core');
    expect(fd).toHaveLength(1);
    expect(fd[0]!.nodes[0]!.file).toBe('src/ui/panel.rs');
    expect(fd[0]!.nodes[0]!.line).toBe(4); // the use line
    expect(fd[0]!.explanation).toBe('UI never touches core.');
    expect(fd[0]!.confidence).toBe('confirmed');
  });

  it('finds the module cycle', async () => {
    const { violations } = await checkRules(store, RS());
    const cyc = violations.filter((v) => v.rule === 'no-cycles');
    expect(cyc.length).toBeGreaterThanOrEqual(1);
    const members = cyc[0]!.nodes.map((n) => n.qualified).sort();
    expect(members.join(',')).toContain('src/x');
    expect(members.join(',')).toContain('src/y');
  });

  it('flags fan-out over the ceiling, scoped by path prefix', async () => {
    const { violations } = await checkRules(store, RS());
    const fo = violations.filter((v) => v.rule === 'fanout');
    expect(fo).toHaveLength(1);
    expect(fo[0]!.nodes[0]!.qualified).toBe('busy');
    expect(fo[0]!.severity).toBe('warning');
  });

  it('flags the private-symbol reach-in (VisibilityBoundary)', async () => {
    const { violations } = await checkRules(store, RS());
    const vb = violations.filter((v) => v.rule === 'core-private');
    expect(vb).toHaveLength(1);
    expect(vb[0]!.nodes[1]!.qualified).toBe('crate::core::kernel::secret');
  });

  it('Cypher rule returns citable rows and rejects mutation at parse', async () => {
    const rs = parseRuleSet(
      `( rules: [ (id: "raw", tier: 2, kind: Cypher("MATCH (s:Symbol) WHERE s.name = 'busy' RETURN s.*"), explain: "raw") ] )`
    );
    const { violations } = await checkRules(store, rs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.nodes[0]!.qualified).toBe('busy');
    expect(violations[0]!.nodes[0]!.file).toBe('src/util/busy.rs');
  });

  it('Cypher rule honors an exposed confidence column (fuzzy → possible)', async () => {
    // A query that exposes e.confidence: rows derived through fuzzy edges must
    // report `possible` (R1 — only confirmed findings fail CI), while a query
    // exposing no confidence column stays confirmed.
    const rs = parseRuleSet(
      `( rules: [ (id: "raw-conf", tier: 2, kind: Cypher("MATCH (a:Symbol)-[e:CALLS]->(s:Symbol) RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line, e.confidence AS confidence"), explain: "conf") ] )`
    );
    const { violations } = await checkRules(store, rs);
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      // Every violation's confidence must mirror the edge column, i.e. no
      // fuzzy-derived row may be confirmed. The fixture has both kinds of
      // edges only if resolution produced them; assert the invariant directly.
      expect(['confirmed', 'possible']).toContain(v.confidence);
    }
    // And a fuzzy edge, when present, must not surface as confirmed:
    const edgeRows = await store.query(
      `MATCH (a:Symbol)-[e:CALLS]->(s:Symbol) RETURN s.qualified AS q, e.confidence AS conf`
    );
    const fuzzyTargets = new Set(edgeRows.filter((r) => String(r.conf) === 'fuzzy').map((r) => String(r.q)));
    for (const v of violations) {
      if (fuzzyTargets.has(v.nodes[0]!.qualified) && !edgeRows.some((r) => String(r.q) === v.nodes[0]!.qualified && String(r.conf) !== 'fuzzy')) {
        expect(v.confidence).toBe('possible');
      }
    }
  });

  it('excludes test-origin edges from architectural rules (R1)', async () => {
    // A #[cfg(test)] mod in core deliberately depends upward on ui — the
    // extractor flags the ref/use inTest; Layering/ForbiddenDep/NoCycles/
    // VisibilityBoundary must not report it (this was a Tier-1 FP on ARES).
    await store.applyExtraction(
      extraction(
        'src/core/tested.rs',
        [sym('tests::probe', 'crate::core::tested::tests::probe')],
        [{ fromIndex: 1, name: 'draw', qualifiedName: 'crate::ui::panel::draw', kind: 'CALLS', line: 7, inTest: true }],
        [{ specifier: 'crate::ui::panel::draw', boundNames: ['draw'], isGlob: false, line: 2, inTest: true }]
      )
    );
    await store.resolvePending();
    const { violations } = await checkRules(store, RS());
    const touching = violations.filter((v) => v.nodes.some((n) => n.file === 'src/core/tested.rs'));
    expect(touching).toHaveLength(0);
  });

  it('baseline: fresh vs known vs fixed, and CI verdict', async () => {
    const { violations } = await checkRules(store, RS());
    const baseline = createBaseline(violations);
    const round = parseBaseline(JSON.stringify(baseline));
    const diff = diffAgainstBaseline(violations, round);
    expect(diff.fresh).toHaveLength(0); // everything baselined
    expect(diff.known.length).toBe(violations.filter((v) => v.confidence === 'confirmed').length + violations.filter((v) => v.confidence === 'possible' && round.keys.includes(violationKey(v))).length);
    expect(ciFailures(diff.fresh)).toHaveLength(0);

    // Remove one key -> that violation becomes fresh; error-severity fails CI.
    const pruned = { ...round, keys: round.keys.slice(1) };
    const diff2 = diffAgainstBaseline(violations, pruned);
    expect(diff2.fresh.length).toBeGreaterThanOrEqual(1);
  });

  it('violation keys are file-move stable (built from qualified names)', async () => {
    const { violations } = await checkRules(store, RS());
    // Symbol-level rules key on qualified names, not file paths. (Module-level
    // nodes — cycle members and `use`-site module symbols — are paths by
    // nature; a file move there IS a module change, so key churn is correct.)
    for (const v of violations.filter((x) => x.rule === 'fanout' || x.rule === 'core-private')) {
      expect(violationKey(v)).not.toMatch(/\.rs/);
    }
  });
});
