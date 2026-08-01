/**
 * The default ruleset shipped with PAiRS: 18 rules that fire on any workspace
 * with no `layers`/`module_layers` configuration.
 *
 * Layering, ForbiddenDep and VisibilityBoundary are deliberately excluded —
 * they need workspace-specific paths, and a default naming paths nobody has is
 * a rule that silently never fires. `pairs init` prepends an inferred
 * `Layering` rule to these when it can propose layers with confidence.
 *
 * Portability: rules list DEPENDS_ON|CALLS|IMPORTS|REFERENCES together because
 * extractors differ — the TypeScript pass folds imports into DEPENDS_ON and
 * emits no IMPORTS/REFERENCES, the Rust pass emits all four. PARAM / RETURNS /
 * OF_TYPE / READS / WRITES are Rust-only today, so no default rule depends on
 * them: it would be dead weight in every other language.
 *
 * Severity policy: `error` is reserved for defects. Everything advisory is
 * `tier: 2, warning`, so `pairs check --ci` stays green on a fresh install
 * (exit 1 means new *confirmed error* violations — R1) while agents still see
 * every finding and can self-correct from its `explain`.
 */

/** Rule entries only — no wrapping parens, so callers can prepend their own. */
export const DEFAULT_RULE_ENTRIES = `    // ---- Code safety ------------------------------------------------------

    (id: "no-module-cycles", tier: 1, severity: error,
     kind: NoCycles(edge: "DEPENDS_ON", scope: Module),
     explain: "Modules must form a DAG. A cycle means neither module can be understood, tested, or reused without the other. Break it by moving the shared piece into a module both can depend on, or by inverting one direction behind an interface."),

    (id: "no-call-cycles", tier: 2, severity: warning,
     kind: NoCycles(edge: "CALLS", scope: Module),
     explain: "Modules call each other in a loop. Even when each individual call looks reasonable, the pair cannot be reasoned about or unit-tested independently. Extract the shared step, or make one side take a callback/port."),

    (id: "prod-depends-on-test", tier: 1, severity: error,
     kind: Cypher("MATCH (a:Symbol)-[e:CALLS|DEPENDS_ON|IMPORTS|REFERENCES]->(b:Symbol) WHERE NOT contains(a.file, 'test') AND contains(b.file, 'test') RETURN a.qualified AS qualified, a.file AS file, e.line AS line, e.confidence AS confidence"),
     explain: "Production code references a test file. Tests are not shipped, so this either breaks the build outside the test runner or drags fixtures into the release. Move the shared helper into a normal module that both sides import."),

    (id: "huge-function", tier: 1, severity: error,
     kind: Cypher("MATCH (s:Symbol) WHERE s.kind IN ['function','method'] AND s.endLine - s.startLine > 300 RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "A function over 300 lines cannot be reviewed or tested as a unit, and is where defects concentrate. Split it along its internal phases — each block with its own comment is usually a function waiting to be named."),

    (id: "ambiguous-exported-name", tier: 2, severity: warning,
     kind: Cypher("MATCH (a:Symbol), (b:Symbol) WHERE a.qualified = b.qualified AND a.id < b.id AND a.exported = true AND b.exported = true AND a.kind IN ['function','class','struct','interface','trait','enum'] RETURN a.qualified AS qualified, a.file AS file, a.startLine AS line"),
     explain: "Two exported symbols share one fully-qualified name. Imports of this name are ambiguous to readers and to the indexer, which degrades every other rule's precision. Rename one, or scope it under a distinct module."),

    (id: "untested-export", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol) WHERE s.exported = true AND s.kind IN ['function','method'] AND NOT contains(s.file, 'test') AND NOT EXISTS { MATCH (t:Symbol)-[:CALLS|REFERENCES]->(s) WHERE contains(t.file, 'test') } RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "An exported function is never reached from a test file. Public surface without a test is the code most likely to break silently on refactor. Add a direct test, or make it internal if it is not really public."),

    (id: "todo-in-public-doc", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol) WHERE s.exported = true AND s.doc IS NOT NULL AND (contains(s.doc, 'TODO') OR contains(s.doc, 'FIXME') OR contains(s.doc, 'HACK') OR contains(s.doc, 'XXX')) RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "The documented contract of a public symbol contains a TODO/FIXME/HACK. Callers read this as the spec, so an unfinished contract is a trap. Resolve it, or move the note to an internal comment and state what the symbol actually guarantees today."),

    // ---- Architecture -----------------------------------------------------

    (id: "fan-out-40", tier: 2, severity: warning, kind: MaxFanOut(max: 40),
     explain: "This function calls 40+ distinct targets, so it is orchestrating rather than doing one thing. Group the calls into named steps and delegate — the current shape makes every downstream change land here."),

    (id: "hub-symbol", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol)<-[e:CALLS|DEPENDS_ON|IMPORTS|REFERENCES]-(o:Symbol) WHERE o.file <> s.file WITH s, count(DISTINCT o.file) AS fanin WHERE fanin > 15 RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "More than 15 files depend on this one symbol, making it a chokepoint: any change to its signature or semantics ripples workspace-wide. Freeze its contract, or split it so callers depend only on the part they use."),

    (id: "file-efferent-coupling", tier: 2, severity: warning,
     kind: Cypher("MATCH (a:Symbol)-[e:CALLS|DEPENDS_ON|IMPORTS|REFERENCES]->(b:Symbol) WHERE a.file <> b.file WITH a.file AS f, count(DISTINCT b.file) AS deps WHERE deps > 20 RETURN f AS qualified, f AS file, 1 AS line"),
     explain: "This file depends on more than 20 other files, so it breaks whenever any of them move. Usually it is doing several jobs: split it, or route the dependencies through a narrower interface."),

    (id: "oversized-file", tier: 2, severity: warning,
     kind: Cypher("MATCH (f:File)-[:DECLARES]->(s:Symbol) WITH f, count(s) AS n WHERE n > 60 RETURN f.path AS qualified, f.path AS file, 1 AS line"),
     explain: "A file declaring 60+ symbols has outgrown one responsibility, and it serialises everyone editing that area. Split along the natural grouping already visible in the symbol names."),

    (id: "god-type", tier: 2, severity: warning,
     kind: Cypher("MATCH (t:Symbol)-[:OWNS]->(m:Symbol) WHERE t.kind IN ['class','struct','interface','trait','impl'] WITH t, count(m) AS n WHERE n > 30 RETURN t.qualified AS qualified, t.file AS file, t.startLine AS line"),
     explain: "A type with 30+ members is accumulating unrelated responsibilities, and its callers each use a different slice of it. Extract the cohesive subsets into their own types."),

    (id: "deep-inheritance", tier: 2, severity: warning,
     kind: Cypher("MATCH (a:Symbol)-[:EXTENDS*3..]->(b:Symbol) RETURN DISTINCT a.qualified AS qualified, a.file AS file, a.startLine AS line"),
     explain: "This type sits three or more levels down an inheritance chain, so its real behaviour is spread across ancestors and cannot be read locally. Prefer composition, or flatten the intermediate levels."),

    (id: "too-many-interfaces", tier: 2, severity: warning,
     kind: Cypher("MATCH (t:Symbol)-[:IMPLEMENTS]->(i:Symbol) WITH t, count(i) AS n WHERE n > 4 RETURN t.qualified AS qualified, t.file AS file, t.startLine AS line"),
     explain: "One type implements more than 4 interfaces, so it is being used as several different things by different callers. Split it per role, so each caller depends only on the contract it needs."),

    (id: "test-only-production-symbol", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol) WHERE s.exported = true AND NOT contains(s.file, 'test') AND s.kind IN ['function','method','class','struct'] AND EXISTS { MATCH (t:Symbol)-[:CALLS|REFERENCES|DEPENDS_ON]->(s) WHERE contains(t.file, 'test') } AND NOT EXISTS { MATCH (p:Symbol)-[:CALLS|REFERENCES|DEPENDS_ON|IMPORTS]->(s) WHERE NOT contains(p.file, 'test') AND p.file <> s.file } RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "This production symbol is only ever used by tests. It is either dead production code kept alive by its own test, or a test helper living in the wrong place — move it to the test tree or delete both."),

    // ---- Design -----------------------------------------------------------

    (id: "long-function", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol) WHERE s.kind IN ['function','method'] AND s.endLine - s.startLine > 120 RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "A function over 120 lines is doing several things at once and forces readers to hold all of it in mind. Extract the internal phases into named helpers; the comments inside usually name them already."),

    (id: "wide-signature", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol) WHERE s.kind IN ['function','method'] AND s.signature IS NOT NULL AND size(s.signature) > 200 RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "This signature is over 200 characters, which means too many parameters or types too complex to name. Group the related arguments into a named options/config type so call sites read as intent, not as a positional puzzle."),

    (id: "cryptic-export", tier: 2, severity: warning,
     kind: Cypher("MATCH (s:Symbol) WHERE s.exported = true AND size(s.name) < 3 AND s.kind IN ['function','class','struct','interface','trait','enum'] RETURN s.qualified AS qualified, s.file AS file, s.startLine AS line"),
     explain: "A public symbol named with fewer than 3 characters carries no meaning at the call site. Short names are fine for locals, never for exported API — rename it to say what it does."),
`;

/** Number of rules in {@link DEFAULT_RULE_ENTRIES} — asserted by the tests. */
export const DEFAULT_RULE_COUNT = 18;

/** A complete, standalone `rules.ron` with no layer configuration. */
export const DEFAULT_RULES_RON = `// PAiRS default ruleset — ${DEFAULT_RULE_COUNT} zero-config rules.
(
  rules: [
${DEFAULT_RULE_ENTRIES}  ] )
`;
