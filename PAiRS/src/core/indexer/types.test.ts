import { describe, expect, it } from 'vitest';
import { isTestPath, TEST_PATH_REGEX, TEST_PATH_REGEX_SQL } from './types';

/**
 * Adapted from vendor/reference-indexer/src/index/types.test.ts. The predicate
 * is multi-language now: the default ruleset uses it to decide what is test
 * code, so both directions cost precision — a miss (`.spec.ts` read as
 * production) and an over-match (`latest.ts` read as a test) each produced
 * false positives in `pairs check`.
 */
describe('isTestPath', () => {
  it('matches a tests/ directory', () => {
    expect(isTestPath('src/tests/foo.rs')).toBe(true);
    expect(isTestPath('tests/integration.rs')).toBe(true);
  });

  it('matches a singular test/ directory and __tests__/', () => {
    expect(isTestPath('src/test/indexProject.ts')).toBe(true);
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
  });

  it('matches tests.rs', () => {
    expect(isTestPath('src/tests.rs')).toBe(true);
  });

  it('matches _test suffixes across languages', () => {
    expect(isTestPath('src/foo_test.rs')).toBe(true);
    expect(isTestPath('pkg/handler_test.go')).toBe(true);
    expect(isTestPath('app/views_test.py')).toBe(true);
  });

  it('matches .test./.spec. suffixes in JS and TypeScript', () => {
    expect(isTestPath('src/store/graph/importPath.test.ts')).toBe(true);
    expect(isTestPath('src/ui/Panel.spec.tsx')).toBe(true);
    expect(isTestPath('lib/util.test.mjs')).toBe(true);
  });

  it('matches pytest naming', () => {
    expect(isTestPath('tests_helpers/test_parser.py')).toBe(true);
    expect(isTestPath('conftest.py')).toBe(true);
  });

  it('does not match a path that merely contains "test" as a substring', () => {
    expect(isTestPath('contest/x.rs')).toBe(false);
    expect(isTestPath('src/testimonials/foo.rs')).toBe(false);
    // "latest" contains "test" — the substring check this replaced flagged it.
    expect(isTestPath('src/api/latest.ts')).toBe(false);
    expect(isTestPath('vitest.config.ts')).toBe(false);
  });

  it('does not match ordinary source files', () => {
    expect(isTestPath('src/foo.rs')).toBe(false);
    expect(isTestPath('src/lib.rs')).toBe(false);
  });
});

describe('TEST_PATH_REGEX_SQL', () => {
  it('is the pattern verbatim — SQLite does not unescape string literals', () => {
    // Kuzu unescaped `\\` to `\` inside a single-quoted literal, so the rules
    // had to double every backslash. SQLite passes the bytes through, so any
    // doubling here would make the shipped rules match nothing at all while
    // still parsing cleanly — a silent failure this pins.
    expect(TEST_PATH_REGEX_SQL).toBe(TEST_PATH_REGEX);
    expect(TEST_PATH_REGEX_SQL).not.toContain('\\\\');
  });

  it('matches the same paths isTestPath does', () => {
    const re = new RegExp(TEST_PATH_REGEX_SQL);
    for (const p of ['src/a.test.ts', 'tests/x.rs', 'pkg/foo_test.go', 'src/__tests__/b.ts']) {
      expect(re.test(p)).toBe(isTestPath(p));
      expect(re.test(p)).toBe(true);
    }
    for (const p of ['src/latest.ts', 'src/contest/a.ts']) {
      expect(re.test(p)).toBe(isTestPath(p));
      expect(re.test(p)).toBe(false);
    }
  });
});
