/**
 * Polyglot contract: for every CodeLang, a real 2-file project (b imports a,
 * calls a's helper) must produce actual cross-file graph edges once run
 * through the real parse → extract → store → moduleMap pipeline.
 *
 * This is the layer pipeline.test.ts and moduleMap.test.ts don't cover:
 * pipeline.test.ts stops at extractor.extract() (never reaches the store),
 * and moduleMap.test.ts / the moduleMap block in executors.test.ts drive the
 * clustering algorithm off canned rows, not a real indexer. Neither would
 * have caught path-style import specifiers ('../store/codeStore') being fed
 * to the Rust name resolver and parked in PendingRef forever — module_map
 * returned zero modules on every non-Rust repo despite 176 passing tests.
 *
 * Where a language's import genuinely can't resolve to a file (Java package
 * imports, Go module paths — see importPath.ts's file-path-only contract),
 * the entry sets knownGap so the DEPENDS_ON assertion is skipped explicitly
 * instead of silently passing, following rustCorpus.test.ts's convention for
 * documented v1 limitations.
 *
 * All 12 language fixtures are indexed into ONE shared store (one namespace
 * dir per language) rather than one database per language: each open
 * Database holds an OS file handle (historically never closed — kuzu segfaulted
 * on close, the convention every other *.test.ts here follows), so opening a
 * dozen in one process exhausts the buffer manager ("Mmap ... failed"). A
 * side effect: every fixture's called function must have a name unique
 * across the whole table, or the resolver's bare-name ladder sees multiple
 * same-named candidates across languages and downgrades the CALLS edge to
 * fuzzy/ambiguous instead of a clean single-candidate resolve.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { moduleMap } from '../core/analyze/moduleMap';
import type { CodeLang } from '../core/indexer/types';
import type { SqliteCodeStore } from '../store/graph/sqliteCodeStore';
import { indexProject } from './indexProject';

interface LangCase {
  aPath: string;
  bPath: string;
  files: Record<string, string>;
  /** Edge kinds this language's fixture is known not to produce cross-file, and why. */
  knownGap?: Partial<Record<'DEPENDS_ON' | 'CALLS', string>>;
}

const CASES: Record<CodeLang, LangCase> = {
  typescript: {
    aPath: 'typescript/a/helper.ts',
    bPath: 'typescript/b/main.ts',
    files: {
      'typescript/a/helper.ts': `export function helperTs(): string { return 'hi'; }\n`,
      'typescript/b/main.ts': `import { helperTs } from '../a/helper';\nexport function runTs(): string { return helperTs(); }\n`,
    },
  },
  javascript: {
    aPath: 'javascript/a/helper.js',
    bPath: 'javascript/b/main.js',
    files: {
      'javascript/a/helper.js': `export function helperJs() { return 'hi'; }\n`,
      'javascript/b/main.js': `import { helperJs } from '../a/helper.js';\nexport function runJs() { return helperJs(); }\n`,
    },
  },
  python: {
    aPath: 'python/a/helper.py',
    bPath: 'python/b/main.py',
    files: {
      'python/a/helper.py': `def helper_py():\n    return 'hi'\n`,
      'python/b/main.py': `from a.helper import helper_py\n\n\ndef run_py():\n    return helper_py()\n`,
    },
  },
  dart: {
    aPath: 'dart/a/helper.dart',
    bPath: 'dart/b/main.dart',
    files: {
      'dart/a/helper.dart': `String helperDart() { return 'hi'; }\n`,
      'dart/b/main.dart': `import '../a/helper.dart';\nString runDart() { return helperDart(); }\n`,
    },
  },
  c: {
    aPath: 'c/a/helper.h',
    bPath: 'c/b/main.c',
    files: {
      // A prototype-only declaration is not captured by queries/c.scm (only
      // function_definition, i.e. a body, is a @def.function) — define the
      // function inline in the header so it's a real symbol to resolve against.
      'c/a/helper.h': `int helperC(int x) { return x + 1; }\n`,
      'c/b/main.c': `#include "../a/helper.h"\nint runC(int x) { return helperC(x); }\n`,
    },
  },
  cpp: {
    aPath: 'cpp/a/helper.hpp',
    bPath: 'cpp/b/main.cpp',
    files: {
      'cpp/a/helper.hpp': `int helperCpp(int x) { return x + 1; }\n`,
      'cpp/b/main.cpp': `#include "../a/helper.hpp"\nint runCpp(int x) { return helperCpp(x); }\n`,
    },
  },
  ruby: {
    aPath: 'ruby/a/helper.rb',
    bPath: 'ruby/b/main.rb',
    files: {
      'ruby/a/helper.rb': `def helper_rb\n  'hi'\nend\n`,
      // A bare no-paren reference parses as a plain identifier, not a `call`
      // node (queries/ruby.scm's @ref.call requires a `call` node) — call
      // with parens so it registers as a CALLS ref.
      'ruby/b/main.rb': `require_relative '../a/helper'\n\ndef run_rb\n  helper_rb()\nend\n`,
    },
  },
  css: {
    aPath: 'css/a/base.css',
    bPath: 'css/b/main.css',
    files: {
      'css/a/base.css': `.base-css {\n  color: red;\n}\n`,
      'css/b/main.css': `@import "../a/base.css";\n.main-css {\n  color: blue;\n}\n`,
    },
    // CSS has no call expressions at all (pipeline.test.ts's NO_CALLS_LANGS).
    knownGap: { CALLS: 'CSS has no call/reference expressions to resolve (queries/css.scm: only @import.specifier is captured).' },
  },
  html: {
    aPath: 'html/a/style.css',
    bPath: 'html/b/main.html',
    files: {
      'html/a/style.css': `.base-html {\n  color: red;\n}\n`,
      'html/b/main.html': `<link rel="stylesheet" href="../a/style.css">\n<p>hi</p>\n`,
    },
    knownGap: { CALLS: 'HTML has no call/reference expressions to resolve (queries/html.scm: only @import.specifier is captured).' },
  },
  // Java imports name a *package*, not a file path. importPath.ts's dotted-
  // import heuristic (shared with Python) probes every ancestor directory of
  // the importer as a possible package root, so it can accidentally match a
  // package whenever it happens to share a path prefix with the importer
  // (e.g. both under 'java/') — real Java package roots (src/main/java/...)
  // don't generally coincide with the importer's own directory tree. Keeping
  // the two files under unrelated top-level roots makes the true gap visible:
  // no ancestor of the importer's directory is ever a prefix of the package's
  // real location.
  java: {
    aPath: 'javapkg/com/example/Helper.java',
    bPath: 'javaapp/b/Main.java',
    files: {
      'javapkg/com/example/Helper.java': `package com.example;\npublic class Helper {\n    public static String helperJava() { return "hi"; }\n}\n`,
      'javaapp/b/Main.java': `package b;\nimport com.example.Helper;\npublic class Main {\n    public static String runJava() { return Helper.helperJava(); }\n}\n`,
    },
    knownGap: { DEPENDS_ON: 'Java imports name a package (com.example.Helper), not a file path relative to the importer — importPath.ts resolves file-path specifiers only.' },
  },
  // Go imports name a *module path* (`example.com/mod/a`), not a workspace
  // file path — same v1 gap as Java, plus Go's package-qualified call
  // (`a.Helper()`) is a selector the CALLS query captures unqualified
  // (`Helper`), so it never carries the cross-package hint anyway.
  go: {
    aPath: 'go/a/helper.go',
    bPath: 'go/b/main.go',
    files: {
      'go/a/helper.go': `package a\n\nfunc HelperGo() string {\n\treturn "hi"\n}\n`,
      'go/b/main.go': `package b\n\nimport "example.com/mod/a"\n\nfunc RunGo() string {\n\treturn a.HelperGo()\n}\n`,
    },
    knownGap: { DEPENDS_ON: 'Go imports name a module path (example.com/mod/a), not a workspace file path — importPath.ts resolves file-path specifiers only.' },
  },
  // Rust `use` names a symbol path, resolved by the name ladder (not
  // importPath.ts's file-path machinery, which is deliberately a no-op for
  // `::`-separated specifiers) — see resolver.test.ts / rustCorpus.test.ts
  // for that path's dedicated coverage. `crate::a::helper::helper` resolves
  // here because `helper` is a globally-unique bare name; no `crateForPath`
  // needed for that ladder step.
  rust: {
    aPath: 'rust/a/helper.rs',
    bPath: 'rust/b/main.rs',
    files: {
      'rust/a/helper.rs': `pub fn helper_rs() -> String { "hi".to_string() }\n`,
      'rust/b/main.rs': `use crate::a::helper::helper_rs;\npub fn run_rs() -> String { helper_rs() }\n`,
    },
  },
};

describe('polyglot cross-file contract', () => {
  let store: SqliteCodeStore;

  beforeAll(async () => {
    const files: Record<string, string> = {};
    for (const c of Object.values(CASES)) Object.assign(files, c.files);
    ({ store } = await indexProject(files));
  });

  for (const lang of Object.keys(CASES) as CodeLang[]) {
    const c = CASES[lang];

    it(`${lang}: indexes both files and finds cross-file edges`, async () => {
      const filePaths = (await store.listFiles()).map((f) => f.path);
      expect(filePaths).toContain(c.aPath);
      expect(filePaths).toContain(c.bPath);

      const dependsRows = await store.query(
        `SELECT COUNT(*) AS n FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'DEPENDS_ON' AND a.file = '${c.bPath}' AND b.file = '${c.aPath}'`
      );
      const dependsCount = Number(dependsRows[0]?.n ?? 0);
      if (c.knownGap?.DEPENDS_ON) {
        expect(dependsCount).toBe(0);
      } else {
        expect(dependsCount).toBeGreaterThanOrEqual(1);
      }

      const callRows = await store.query(
        `SELECT COUNT(*) AS n FROM Edge e JOIN Symbol a ON a.id = e.src JOIN Symbol b ON b.id = e.dst WHERE e.kind = 'CALLS' AND a.file = '${c.bPath}' AND b.file = '${c.aPath}'`
      );
      const callCount = Number(callRows[0]?.n ?? 0);
      if (c.knownGap?.CALLS) {
        expect(callCount).toBe(0);
      } else {
        expect(callCount).toBeGreaterThanOrEqual(1);
      }

      const importers = await store.fileEdges(c.aPath, 'importers', {});
      if (c.knownGap?.DEPENDS_ON) {
        expect(importers.map((f) => f.path)).not.toContain(c.bPath);
      } else {
        expect(importers.map((f) => f.path)).toContain(c.bPath);
      }
    });
  }

  it('module_map finds modules and edges across the whole polyglot workspace', async () => {
    const map = await moduleMap(store);
    // One 'a' + one 'b' module per language that doesn't knownGap DEPENDS_ON,
    // plus at least that many crossing edges — the exact bug (empty
    // module_map on non-Rust repos) reproduced at the map level, not just
    // the raw edge-count level per language above.
    const resolvableLangs = (Object.keys(CASES) as CodeLang[]).filter((l) => !CASES[l].knownGap?.DEPENDS_ON);
    expect(map.modules.length).toBeGreaterThanOrEqual(resolvableLangs.length * 2);
    expect(map.edges.length).toBeGreaterThanOrEqual(resolvableLangs.length);
  });

  it('never leaves a workspace-relative import parked in PendingRef', async () => {
    // The exact bug class that shipped: a path-style specifier ('../a/helper',
    // './x', '/root/util') that never resolves and sits in PendingRef forever
    // because it was fed to the name ladder instead of importPath.ts.
    const rows = await store.query(
      `SELECT qualifiedName AS q FROM PendingRef WHERE qualifiedName LIKE '.%' OR qualifiedName LIKE '/%'`
    );
    expect(rows.map((r) => r.q)).toEqual([]);
  });
});
