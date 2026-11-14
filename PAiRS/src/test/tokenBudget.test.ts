/**
 * Token-cost harness: indexes a TypeScript corpus (this repo's own src/ by
 * default, or the directory in PAIRS_TOKEN_FIXTURE for a frozen, comparable
 * corpus) and counts the tokens of every tool's prose and JSON output for
 * representative inputs, plus the static per-session costs (tool schemas
 * shipped via package.json, the skill file).
 *
 * Prints a table; writes machine-readable numbers to PAIRS_TOKEN_REPORT when
 * set. The assertions are budget guard-rails, not exact pins: they fail when a
 * tool's default output regresses past a generous ceiling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import { createExecutors } from '../core/tools/executors';
import { codeToolSchemas, type CodeToolName } from '../core/tools/tools';
import {
  jsonAnalyze,
  jsonContextPack,
  jsonDiffImpact,
  jsonFileDeps,
  jsonFindSymbol,
  jsonGetSymbol,
  jsonGrepSymbols,
  jsonHierarchy,
  jsonImpact,
  jsonModuleMap,
  jsonOutline,
  jsonWhoCalls,
} from '../adapters/cli/json';
import { indexProject } from './indexProject';

const REPO_ROOT = path.join(__dirname, '..', '..');
const tok = (s: string): number => encode(s).length;

function corpus(): { files: Record<string, string>; dir: string } {
  const fixture = process.env.PAIRS_TOKEN_FIXTURE;
  const dir = fixture ?? REPO_ROOT;
  const rels = fixture
    ? (execSync('find src -name "*.ts"', { cwd: fixture, encoding: 'utf8' }) as string).split('\n').filter(Boolean)
    : execSync('git ls-files "src/**/*.ts"', { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const files: Record<string, string> = {};
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) files[rel.replace(/\\/g, '/')] = fs.readFileSync(abs, 'utf8');
  }
  return { files, dir };
}

describe('token budget', () => {
  it('measures every tool', async () => {
    const { files } = corpus();
    const { store } = await indexProject(files);
    const readSource = (rel: string): string | null => files[rel] ?? null;
    const diffHunks = [
      { path: 'src/core/analyze/impact.ts', startLine: 66, endLine: 80 },
      { path: 'src/core/analyze/moduleMap.ts', startLine: 137, endLine: 150 },
    ];
    const collectDiff = async () => diffHunks;
    const x = createExecutors({ store, readSource, collectDiff });

    type Case = { tool: CodeToolName; label: string; raw: Record<string, unknown> };
    const cases: Case[] = [
      { tool: 'find_symbol', label: 'find_symbol moduleMap', raw: { name: 'moduleMap' } },
      { tool: 'find_symbol', label: 'find_symbol moduleMap --preview', raw: { name: 'moduleMap', preview: true } },
      { tool: 'get_symbol', label: 'get_symbol SqliteCodeStore', raw: { name: 'SqliteCodeStore' } },
      { tool: 'outline', label: 'outline executors.ts', raw: { path: 'src/core/tools/executors.ts' } },
      { tool: 'impact', label: 'impact moduleKeyOf', raw: { name: 'moduleKeyOf' } },
      { tool: 'impact', label: 'impact CodeStore (hub, depth 3)', raw: { name: 'CodeStore' } },
      { tool: 'diff_impact', label: 'diff_impact (2 hunks)', raw: {} },
      { tool: 'hierarchy', label: 'hierarchy CodeStore', raw: { name: 'CodeStore' } },
      { tool: 'who_calls', label: 'who_calls moduleKeyOf', raw: { name: 'moduleKeyOf' } },
      { tool: 'who_calls', label: 'who_calls createExecutors (repeat callers)', raw: { name: 'createExecutors' } },
      { tool: 'outline', label: 'outline executors.ts (suffix path)', raw: { path: 'executors.ts' } },
      { tool: 'find_symbol', label: 'find_symbol createExecutor (miss)', raw: { name: 'createExecutor' } },
      { tool: 'file_deps', label: 'file_deps codeStore.ts importers', raw: { path: 'src/store/graph/codeStore.ts' } },
      { tool: 'module_map', label: 'module_map', raw: {} },
      { tool: 'analyze', label: 'analyze dead_code', raw: { kind: 'dead_code' } },
      { tool: 'grep_symbols', label: 'grep_symbols render', raw: { pattern: 'render' } },
      { tool: 'context_pack', label: 'context_pack moduleMap', raw: { name: 'moduleMap' } },
    ];

    const rows: Array<{ label: string; proseTok: number; jsonPrettyTok: number; jsonCompactTok: number; proseBytes: number }> = [];
    for (const c of cases) {
      const input = codeToolSchemas[c.tool].input.parse(c.raw) as never;
      const prose = await (x[c.tool] as (i: unknown) => Promise<string>)(input);
      let data: unknown;
      switch (c.tool) {
        case 'find_symbol': data = await jsonFindSymbol(store, input); break;
        case 'get_symbol': data = await jsonGetSymbol(store, input); break;
        case 'outline': data = await jsonOutline(store, input); break;
        case 'impact': data = await jsonImpact(store, input); break;
        case 'diff_impact': data = await jsonDiffImpact(store, collectDiff, input); break;
        case 'hierarchy': data = await jsonHierarchy(store, input); break;
        case 'who_calls': data = await jsonWhoCalls(store, input); break;
        case 'file_deps': data = await jsonFileDeps(store, input); break;
        case 'module_map': data = await jsonModuleMap(store, input); break;
        case 'analyze': data = await jsonAnalyze(store, input); break;
        case 'grep_symbols': data = await jsonGrepSymbols(store, input); break;
        case 'context_pack': data = await jsonContextPack(store, input); break;
        default: data = null;
      }
      rows.push({
        label: c.label,
        proseTok: tok(prose),
        jsonPrettyTok: tok(JSON.stringify(data, null, 2)),
        jsonCompactTok: tok(JSON.stringify(data)),
        proseBytes: Buffer.byteLength(prose),
      });
    }

    // Static, per-session costs.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      contributes: { languageModelTools: unknown[] };
    };
    const lmTools = JSON.stringify(pkg.contributes.languageModelTools);
    const skill = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'skills', 'pairs', 'SKILL.md'), 'utf8');
    const schemaDescChars = Object.values(codeToolSchemas).reduce((n, t) => n + t.description.length, 0);
    const statics = {
      languageModelToolsChars: lmTools.length,
      languageModelToolsTokens: tok(lmTools),
      toolDescriptionChars: schemaDescChars,
      skillBytes: Buffer.byteLength(skill),
      skillTokens: tok(skill),
    };

    const table = [
      'case'.padEnd(40) + 'prose'.padStart(8) + 'json-pretty'.padStart(13) + 'json-compact'.padStart(14),
      ...rows.map((r) => r.label.padEnd(40) + String(r.proseTok).padStart(8) + String(r.jsonPrettyTok).padStart(13) + String(r.jsonCompactTok).padStart(14)),
      JSON.stringify(statics),
    ].join('\n');
    console.log(`\n${table}\n`);
    if (process.env.PAIRS_TOKEN_REPORT) {
      fs.writeFileSync(process.env.PAIRS_TOKEN_REPORT, JSON.stringify({ rows, statics }, null, 2));
    }

    expect(rows.length).toBe(cases.length);
    for (const r of rows) {
      expect(r.proseTok).toBeGreaterThan(0);
      // Guard-rail: no single default prose answer may exceed ~4k tokens.
      expect(r.proseTok).toBeLessThan(4000 + (r.label.includes('module_map') ? 2000 : 0));
    }
  }, 120_000);
});
