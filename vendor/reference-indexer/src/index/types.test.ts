import { describe, expect, it } from 'vitest';
import { isTestPath } from './types';

describe('isTestPath', () => {
  it('matches .test. suffix style (js/ts)', () => {
    expect(isTestPath('src/foo.test.ts')).toBe(true);
    expect(isTestPath('src/foo.test.js')).toBe(true);
  });

  it('matches .spec. suffix style', () => {
    expect(isTestPath('src/foo.spec.ts')).toBe(true);
  });

  it('matches _test. suffix style (go)', () => {
    expect(isTestPath('pkg/foo_test.go')).toBe(true);
  });

  it('matches pytest test_*.py', () => {
    expect(isTestPath('tests/test_foo.py')).toBe(true);
    expect(isTestPath('test_foo.py')).toBe(true);
  });

  it('matches tests/ and __tests__/ directory styles', () => {
    expect(isTestPath('src/tests/foo.ts')).toBe(true);
    expect(isTestPath('src/test/foo.ts')).toBe(true);
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
  });

  it('does not match a directory that merely contains "test" as a substring', () => {
    expect(isTestPath('contest/x.ts')).toBe(false);
    expect(isTestPath('src/testimonials/foo.ts')).toBe(false);
  });

  it('does not match ordinary source files', () => {
    expect(isTestPath('src/foo.ts')).toBe(false);
    expect(isTestPath('src/service.py')).toBe(false);
  });
});
