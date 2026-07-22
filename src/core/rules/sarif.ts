/**
 * SARIF 2.1.0 output for `gizem check --format sarif` — the shape GitHub code
 * scanning ingests (spec §6, plan.md Phase 2 exit). Minimal but valid: one run,
 * one rule descriptor per rule, one result per violation, first node as the
 * primary location, remaining nodes as relatedLocations.
 */

import type { Rule, Violation } from './types';

export function toSarif(violations: Violation[], rules: Rule[], version: string): string {
  const ruleIndex = new Map(rules.map((r, i) => [r.id, i]));
  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'gizem',
            informationUri: 'https://github.com/gizem',
            version,
            rules: rules.map((r) => ({
              id: r.id,
              shortDescription: { text: r.explain },
              defaultConfiguration: { level: r.severity === 'error' ? 'error' : 'warning' },
            })),
          },
        },
        results: violations.map((v) => {
          const [first, ...rest] = v.nodes;
          const loc = (n: { file: string; line: number; qualified: string }) => ({
            physicalLocation: {
              artifactLocation: { uri: n.file },
              region: { startLine: Math.max(1, n.line) },
            },
            message: { text: n.qualified },
          });
          return {
            ruleId: v.rule,
            ruleIndex: ruleIndex.get(v.rule),
            // `possible` findings surface as notes — visible, never blocking.
            level: v.confidence === 'possible' ? 'note' : v.severity === 'error' ? 'error' : 'warning',
            message: { text: v.explanation + (v.suggestion ? ` — ${v.suggestion}` : '') },
            locations: first ? [loc(first)] : [],
            relatedLocations: rest.map(loc),
            properties: { tier: v.tier, confidence: v.confidence },
          };
        }),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
