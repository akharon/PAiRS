/**
 * Baseline/ratchet (spec §6, O4): a committed snapshot of accepted violations.
 * `gizem check --baseline` fails only on violations whose key is not in the
 * snapshot — legacy repos pass day 1, new debt fails CI.
 *
 * Key = rule id + sorted module-qualified symbol names (not file paths):
 * stable under file moves, invalidated by genuine renames (acceptable — a
 * rename is a review-worthy change).
 */

import type { Violation } from './types';
import { violationKey } from './types';

export interface Baseline {
  version: 1;
  createdAt: string; // ISO
  /** Sorted violation keys accepted at snapshot time. */
  keys: string[];
}

export function createBaseline(violations: Violation[]): Baseline {
  const keys = [...new Set(violations.filter((v) => v.confidence === 'confirmed').map(violationKey))].sort();
  return { version: 1, createdAt: new Date().toISOString(), keys };
}

export function parseBaseline(json: string): Baseline {
  const b = JSON.parse(json) as Baseline;
  if (b.version !== 1 || !Array.isArray(b.keys)) throw new Error('unrecognized baseline format (expected {version:1, keys:[…]})');
  return b;
}

export interface BaselineDiff {
  /** Violations not in the baseline — the ones that may fail CI. */
  fresh: Violation[];
  /** Baselined violations still present. */
  known: Violation[];
  /** Baseline keys no longer violated — candidates for `baseline update`. */
  fixedKeys: string[];
}

export function diffAgainstBaseline(violations: Violation[], baseline: Baseline): BaselineDiff {
  const accepted = new Set(baseline.keys);
  const fresh: Violation[] = [];
  const known: Violation[] = [];
  const present = new Set<string>();
  for (const v of violations) {
    const key = violationKey(v);
    present.add(key);
    (accepted.has(key) ? known : fresh).push(v);
  }
  const fixedKeys = baseline.keys.filter((k) => !present.has(k));
  return { fresh, known, fixedKeys };
}

/**
 * CI verdict (spec §6): exit 1 only on NEW CONFIRMED tier-1/2 error-severity
 * violations. `possible` findings and baselined debt never fail CI (R1).
 */
export function ciFailures(fresh: Violation[]): Violation[] {
  return fresh.filter((v) => v.confidence === 'confirmed' && v.severity === 'error');
}
