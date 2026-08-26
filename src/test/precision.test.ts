/**
 * Precision ratchet: measures fuzzyRate/unresolvedRatio on a small, fully
 * controlled fixture and asserts they stay at or below a committed ceiling.
 * Unlike polyglot.test.ts (pins per-language behavior) this tracks the
 * numbers that `impact`/`who_calls`/`rename_symbol` trust — nothing else in
 * the suite catches a regression that raises the fuzzy rate.
 */

import { describe, expect, it } from 'vitest';
import { indexProject } from './indexProject';

// Ratchet: these are measured ceilings, not goals. If a change lowers them,
// lower the constants in the same commit. If a change raises them, it has
// made the graph less accurate — fix the change, do not raise the number.
// Measured 2026-08-26: fuzzyRate 0, unresolvedRatio 0.2 (the `use crate::a::{...}`
// import edges resolve, but each 2-name `use` still parks one bare ref before
// the module edge lands — expected shape for this fixture, not noise).
const MAX_FUZZY_RATE = 0.0;
const MAX_UNRESOLVED_RATIO = 0.22;

describe('precision ratchet', () => {
  it('a fixture of unambiguous cross-file calls stays within the measured ceiling', async () => {
    const { store } = await indexProject({
      'src/a.rs': `pub fn helper_alpha() -> i32 { 1 }\npub fn helper_beta() -> i32 { 2 }\n`,
      'src/b.rs': `use crate::a::{helper_alpha, helper_beta};\npub fn run_alpha() -> i32 { helper_alpha() }\npub fn run_beta() -> i32 { helper_beta() }\n`,
      'src/c.rs': `use crate::b::run_alpha;\npub fn run_all() -> i32 { run_alpha() }\n`,
    });

    const stats = await store.stats();

    expect(stats.fuzzyRate).toBeLessThanOrEqual(MAX_FUZZY_RATE);
    expect(stats.unresolvedRatio).toBeLessThanOrEqual(MAX_UNRESOLVED_RATIO);

    // In a workspace where every call target is defined exactly once and
    // named uniquely, there is no reason for any fuzzy edge.
    const fuzzyCalls = await store.query(
      `SELECT COUNT(*) AS n FROM Edge WHERE kind = 'CALLS' AND confidence = 'fuzzy'`
    );
    expect(Number(fuzzyCalls[0]?.n ?? 0)).toBe(0);
  });
});
