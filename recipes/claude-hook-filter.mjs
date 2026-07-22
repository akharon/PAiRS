#!/usr/bin/env node
/**
 * Claude Code PostToolUse filter for `gizem check --format json`.
 *
 * Reads the check JSON from stdin and:
 *  - exits 2 with the violations on stderr when a NEW CONFIRMED error-severity
 *    violation exists — Claude Code treats exit 2 as blocking feedback and the
 *    agent self-corrects from each violation's `explanation`;
 *  - otherwise prints `possible`/warning findings to stderr (non-blocking)
 *    and exits 0.
 */

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0); // check itself failed or produced no JSON — don't block edits
  }
  const violations = data.violations ?? [];
  if (violations.length === 0) process.exit(0);

  const render = (v) =>
    `[${v.severity}${v.confidence === 'possible' ? '/possible' : ''}] ${v.rule}: ${v.explanation}\n` +
    v.nodes.map((n) => `    at ${n.qualified}  ${n.file}:${n.line}`).join('\n') +
    (v.suggestion ? `\n    fix: ${v.suggestion}` : '');

  const blocking = violations.filter((v) => v.confidence === 'confirmed' && v.severity === 'error');
  process.stderr.write(violations.map(render).join('\n\n') + '\n');
  process.exit(blocking.length > 0 ? 2 : 0);
});
