import { describe, expect, it } from 'vitest';
import { isTestPath } from './types';

/**
 * Adapted from vendor/reference-indexer/src/index/types.test.ts — trimmed to
 * PAiRS's narrower Rust-first TEST_PATH_PATTERNS (no .spec./_test. suffix
 * styles or pytest test_*.py; those return with multi-language validation).
 */
describe('isTestPath', () => {
  it('matches a tests/ directory', () => {
    expect(isTestPath('src/tests/foo.rs')).toBe(true);
    expect(isTestPath('tests/integration.rs')).toBe(true);
  });

  it('matches tests.rs', () => {
    expect(isTestPath('src/tests.rs')).toBe(true);
  });

  it('matches _test.rs suffix', () => {
    expect(isTestPath('src/foo_test.rs')).toBe(true);
  });

  it('does not match a directory that merely contains "test" as a substring', () => {
    expect(isTestPath('contest/x.rs')).toBe(false);
    expect(isTestPath('src/testimonials/foo.rs')).toBe(false);
  });

  it('does not match ordinary source files', () => {
    expect(isTestPath('src/foo.rs')).toBe(false);
    expect(isTestPath('src/lib.rs')).toBe(false);
  });
});
