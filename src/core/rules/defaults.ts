/**
 * The default ruleset shipped with PAiRS: 9 zero-config rules that fire on any
 * workspace with no `layers`/`module_layers` configuration.
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
 *
 * Precision policy (why this list is short): a default that cries wolf gets
 * muted wholesale, taking the real defects with it. Two classes of rule were
 * dropped rather than tuned:
 *
 *  - *Metrics wearing a rule's clothes.* `hub-symbol`, `file-efferent-coupling`
 *    and friends reported "many things point at this", which is a fact about
 *    healthy shared modules as often as a defect. On this very workspace every
 *    `hub-symbol` hit was a shared types module or a name collision on `map` /
 *    `push`. Fan-in and coupling belong in `analyze` / `impact`, where the
 *    reader supplies the judgement — not in a pass/fail rule.
 *  - *Style opinions.* `cryptic-export` (names under 3 chars), `wide-signature`
 *    (signature string over 200 chars), `todo-in-public-doc`, `deep-inheritance`
 *    and `too-many-interfaces` flag legal, common code — `id`, a generic-heavy
 *    TypeScript signature, `interface A extends B extends C`. None describes a
 *    defect, and formatters and linters already own that ground.
 *
 * What survives asserts something is *wrong*: a cycle, a reference into test
 * code, a function too large to review, a type or file that has outgrown one
 * responsibility.
 *
 * Two edge-level guards keep the survivors honest. Any rule whose finding is
 * an *assertion of a defect* filters `e.confidence <> 'fuzzy'`, because fuzzy
 * edges are name-matched, not resolved (65% of CALLS edges in a TypeScript
 * workspace) and are what turned `.map()` call sites into a fan-in hub. Rules
 * that ask whether a symbol is *used at all* deliberately accept fuzzy edges:
 * there, weak evidence of use is still evidence, and ignoring it invents dead
 * code. Test files are matched by {@link TEST_PATH_REGEX}, never by
 * `contains(file, 'test')` — that substring also matches `latest.ts` and
 * `contest/`, and misses `.spec.ts` entirely.
 */

import { TEST_PATH_REGEX_SQL } from '../indexer/types';

/**
 * Test-path regex escaped for a SQL literal *inside a RON string*. Only ONE
 * unescaping round now: RON turns `\\`→`\` when parsing, and SQLite then
 * takes the pattern verbatim. (Kuzu unescaped a second time, so this used to
 * double twice — doing that here would make every rule below match nothing.)
 */
const TP = TEST_PATH_REGEX_SQL.replace(/\\/g, '\\\\');

/** Rule entries only — no wrapping parens, so callers can prepend their own. */
export const DEFAULT_RULE_ENTRIES = `    // ---- Code safety ------------------------------------------------------

    (id: "no-module-cycles", tier: 1, severity: error,
     kind: NoCycles(edge: "DEPENDS_ON", scope: Module),
     explain: "Modules must form a DAG. A cycle means neither module can be understood, tested, or reused without the other. Break it by moving the shared piece into a module both can depend on, or by inverting one direction behind an interface."),

    (id: "no-call-cycles", tier: 2, severity: warning,
     kind: NoCycles(edge: "CALLS", scope: Module),
     explain: "Modules call each other in a loop. Even when each individual call looks reasonable, the pair cannot be reasoned about or unit-tested independently. Extract the shared step, or make one side take a callback/port."),

    (id: "prod-depends-on-test", tier: 1, severity: error,
     kind: Sql("SELECT a.qualified AS qualified, a.file AS file, e.line AS line FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind IN ('CALLS','DEPENDS_ON','IMPORTS','REFERENCES') AND NOT regexp_matches(a.file, '${TP}') AND regexp_matches(b.file, '${TP}') AND COALESCE(e.confidence, 'resolved') <> 'fuzzy'"),
     explain: "Production code references a test file. Tests are not shipped, so this either breaks the build outside the test runner or drags fixtures into the release. Move the shared helper into a normal module that both sides import."),

    (id: "huge-function", tier: 1, severity: error,
     kind: Sql("SELECT s.qualified AS qualified, s.file AS file, s.startLine AS line FROM Symbol s WHERE s.kind IN ('function','method') AND s.endLine - s.startLine > 300 AND NOT regexp_matches(s.file, '${TP}')"),
     explain: "A function over 300 lines cannot be reviewed or tested as a unit, and is where defects concentrate. Split it along its internal phases — each block with its own comment is usually a function waiting to be named."),

    (id: "dead-production-symbol", tier: 2, severity: warning,
     kind: Sql("SELECT s.qualified AS qualified, s.file AS file, s.startLine AS line FROM Symbol s WHERE s.exported = 1 AND NOT regexp_matches(s.file, '${TP}') AND s.kind IN ('function','method','class','struct') AND EXISTS (SELECT 1 FROM Edge e JOIN Symbol t ON t.id = e.src WHERE e.dst = s.id AND e.kind IN ('CALLS','REFERENCES','DEPENDS_ON') AND regexp_matches(t.file, '${TP}')) AND NOT EXISTS (SELECT 1 FROM Edge e2 JOIN Symbol p ON p.id = e2.src WHERE e2.dst = s.id AND e2.kind IN ('CALLS','REFERENCES','DEPENDS_ON','IMPORTS') AND NOT regexp_matches(p.file, '${TP}'))"),
     explain: "This exported symbol is reached from tests and from nowhere else — no production caller anywhere, including its own module. It is dead code kept alive by its own test, or a test helper living in the production tree. Delete both, or move it to the test tree."),

    // ---- Architecture -----------------------------------------------------

    (id: "fan-out-40", tier: 2, severity: warning, kind: MaxFanOut(max: 40),
     explain: "This function calls 40+ distinct targets, so it is orchestrating rather than doing one thing. Group the calls into named steps and delegate — the current shape makes every downstream change land here."),

    (id: "oversized-file", tier: 2, severity: warning,
     kind: Sql("SELECT f.path AS qualified, f.path AS file, 1 AS line FROM File f JOIN Symbol s ON s.fileId = f.id WHERE NOT regexp_matches(f.path, '${TP}') GROUP BY f.id HAVING COUNT(s.id) > 60"),
     explain: "A file declaring 60+ symbols has outgrown one responsibility, and it serialises everyone editing that area. Split along the natural grouping already visible in the symbol names."),

    (id: "god-type", tier: 2, severity: warning,
     kind: Sql("SELECT t.qualified AS qualified, t.file AS file, t.startLine AS line FROM Symbol t JOIN Edge e ON e.src = t.id AND e.kind = 'OWNS' WHERE t.kind IN ('class','struct','interface','trait','impl') AND NOT regexp_matches(t.file, '${TP}') GROUP BY t.id HAVING COUNT(e.dst) > 30"),
     explain: "A type with 30+ members is accumulating unrelated responsibilities, and its callers each use a different slice of it. Extract the cohesive subsets into their own types."),

    // ---- Design -----------------------------------------------------------

    (id: "long-function", tier: 2, severity: warning,
     kind: Sql("SELECT s.qualified AS qualified, s.file AS file, s.startLine AS line FROM Symbol s WHERE s.kind IN ('function','method') AND s.endLine - s.startLine > 120 AND NOT regexp_matches(s.file, '${TP}')"),
     explain: "A function over 120 lines is doing several things at once and forces readers to hold all of it in mind. Extract the internal phases into named helpers; the comments inside usually name them already."),
`;

/** Number of rules in {@link DEFAULT_RULE_ENTRIES} — asserted by the tests. */
export const DEFAULT_RULE_COUNT = 9;

/** A complete, standalone `rules.ron` with no layer configuration. */
export const DEFAULT_RULES_RON = `// PAiRS default ruleset — ${DEFAULT_RULE_COUNT} zero-config rules.
(
  rules: [
${DEFAULT_RULE_ENTRIES}  ] )
`;
