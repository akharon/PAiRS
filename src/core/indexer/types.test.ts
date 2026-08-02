import { describe, expect, it } from 'vitest';
import { isTestPath, TEST_PATH_REGEX, TEST_PATH_REGEX_CYPHER } from './types';

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

describe('TEST_PATH_REGEX_CYPHER', () => {
  it('is the same pattern with backslashes doubled for a Cypher literal', () => {
    // Kuzu unescapes `\\` to `\` inside a single-quoted literal, so the two
    // forms must stay in lockstep or the rules match a different regex than
    // isTestPath does.
    expect(TEST_PATH_REGEX_CYPHER.replace(/\\\\/g, '\\')).toBe(TEST_PATH_REGEX);
  });
});
