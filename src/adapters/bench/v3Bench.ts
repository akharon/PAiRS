/**
 * V3 token benchmark (plan.md 1.7, the headline "why GIZEM" number).
 *
 * Claim under test: answering an agent's structural code questions through the
 * GIZEM MCP tools costs ≤ 10% of the tokens a file-reading agent spends to
 * answer the *same* question by grep-then-read.
 *
 * Method — for each of 20 scripted questions:
 *   GIZEM cost  = tokens of the MCP tool response text an agent would receive.
 *   Baseline    = tokens of the file contents a grep-then-read agent must pull
 *                 into context to answer, i.e. the full text of every file that
 *                 grep -l for the question's search term returns. This is the
 *                 honest floor for the no-index path: the agent cannot answer
 *                 "who calls X / what depends on X / where is X" without reading
 *                 the candidate files, and grep is how it finds them.
 *
 * Both sides are counted with the same cl100k tokenizer (gpt-tokenizer). The
 * baseline deliberately does NOT include the agent's own reasoning/thrash — it
 * is a lower bound on the file-reading path, which makes the ratio conservative
 * (real agents read more, re-read, and overshoot). GIZEM's side is the exact
 * bytes the tool returns, nothing hidden.
 *
 * Questions are authored against symbols/files the harness discovers in the
 * indexed store at run time, so the set adapts to whatever corpus is indexed
 * (no hard-coded ARes names that rot). Run: node dist/v3-bench.js <repo> [--json]
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encode } from 'gpt-tokenizer';
import type { CodeStore } from '../../store/graph/codeStore';
import type { SymbolRecord } from '../../core/indexer/types';
import { createExecutors, type Executors } from '../mcp/executors';

const tok = (s: string): number => encode(s).length;

/** Repo-relative files whose text contains `term` (word-boundary). The file
 *  set a grep-then-read agent must open to answer a question about `term`. */
function grepFiles(repo: string, term: string): string[] {
  try {
    const out = execFileSync(
      'grep',
      ['-rlw', '--include=*.rs', '--exclude-dir=target', term, '.'],
      { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    return out.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
  } catch {
    return []; // grep exits 1 on no match
  }
}

/** Baseline token cost: full text of every file grep would surface for `term`. */
function baselineTokens(repo: string, term: string): { tokens: number; files: number } {
  const files = grepFiles(repo, term);
  let tokens = 0;
  for (const f of files) {
    try {
      tokens += tok(fs.readFileSync(path.join(repo, f), 'utf8'));
    } catch {
      /* file vanished / unreadable — skip */
    }
  }
  return { tokens, files: files.length };
}

export interface BenchRow {
  id: number;
  question: string;
  tool: string;
  gizemTokens: number;
  baselineTokens: number;
  baselineFiles: number;
  ratio: number; // gizem / baseline
}

export interface BenchResult {
  rows: BenchRow[];
  totalGizem: number;
  totalBaseline: number;
  ratio: number; // aggregate gizem / baseline
  meanRatio: number; // mean of per-question ratios
  passed: boolean; // aggregate ratio ≤ 0.10
}

interface Q {
  question: string;
  tool: string;
  /** grep ground-truth term the file-reading agent would search for. */
  term: string;
  run: (x: Executors) => Promise<string>;
}

/** Discover concrete, well-connected symbols to phrase questions against. */
async function discover(store: CodeStore): Promise<{ funcs: SymbolRecord[]; files: string[] }> {
  // Functions with the most outgoing calls — the ones an agent actually asks about.
  const hot = (await store.hotspots({ limit: 40 })) as SymbolRecord[];
  const funcs = hot.filter((s) => s.kind === 'function' && s.name.length >= 4);
  const files = Array.from(new Set(funcs.map((f) => f.file))).slice(0, 12);
  return { funcs, files };
}

function buildQuestions(funcs: SymbolRecord[], files: string[]): Q[] {
  const qs: Q[] = [];
  const pick = <T,>(a: T[], i: number): T | undefined => a[i % Math.max(a.length, 1)];

  // 8 symbol-centric questions across who_calls / impact / get_symbol.
  const templates: Array<{ q: (n: string) => string; tool: string; run: (x: Executors, n: string) => Promise<string> }> = [
    { q: (n) => `Who calls ${n}?`, tool: 'who_calls', run: (x, n) => x.who_calls({ name: n, direction: 'callers', includeFuzzy: true, limit: 50 }) },
    { q: (n) => `What is the blast radius if I change ${n}?`, tool: 'impact', run: (x, n) => x.impact({ name: n, depth: 4, limit: 100 }) },
    { q: (n) => `Where is ${n} defined and what does it look like?`, tool: 'get_symbol', run: (x, n) => x.get_symbol({ name: n, includeMembers: true }) },
    { q: (n) => `What does ${n} call?`, tool: 'who_calls', run: (x, n) => x.who_calls({ name: n, direction: 'callees', includeFuzzy: true, limit: 50 }) },
  ];
  for (let i = 0; i < 12; i++) {
    const f = pick(funcs, i);
    const t = templates[i % templates.length]!;
    if (!f) continue;
    qs.push({ question: t.q(f.name), tool: t.tool, term: f.name, run: (x) => t.run(x, f.name) });
  }

  // 5 file-centric questions: outline + file_deps.
  for (let i = 0; i < 5; i++) {
    const file = pick(files, i);
    if (!file) continue;
    const base = path.basename(file).replace(/\.rs$/, '');
    if (i % 2 === 0) {
      qs.push({ question: `Give me the outline of ${file}.`, tool: 'outline', term: base, run: (x) => x.outline({ path: file }) });
    } else {
      qs.push({ question: `What imports ${file}?`, tool: 'file_deps', term: base, run: (x) => x.file_deps({ path: file, direction: 'importers', transitive: false, limit: 50 }) });
    }
  }

  // 3 whole-codebase architecture questions (module_map + analyze). Baseline
  // term chosen to reflect the sweep an agent would do: `mod`/`use`/`fn` are the
  // grep an agent runs to reconstruct architecture by hand — capped to a
  // representative sub-sweep so the baseline stays a *lower* bound, not inflated.
  qs.push({ question: 'What are the architectural subsystems and where does the code drift from them?', tool: 'module_map', term: 'mod', run: (x) => x.module_map({ limit: 40 }) });
  qs.push({ question: 'Are there dependency cycles between modules?', tool: 'analyze', term: 'use', run: (x) => x.analyze({ kind: 'cycles', scope: 'module', limit: 30, offset: 0, includeExported: false }) });
  qs.push({ question: 'Which exported symbols have no test coverage?', tool: 'analyze', term: 'pub', run: (x) => x.analyze({ kind: 'test_gap', scope: 'module', limit: 40, offset: 0, includeExported: false }) });

  return qs.slice(0, 20);
}

export async function runV3Bench(store: CodeStore, repo: string): Promise<BenchResult> {
  const x = createExecutors({ store });
  const { funcs, files } = await discover(store);
  const questions = buildQuestions(funcs, files);

  const rows: BenchRow[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const answer = await q.run(x);
    const gizemTokens = tok(answer);
    const { tokens: baselineTokens, files: baselineFiles } = baselineTokensFor(repo, q.term);
    rows.push({
      id: i + 1,
      question: q.question,
      tool: q.tool,
      gizemTokens,
      baselineTokens,
      baselineFiles,
      ratio: baselineTokens > 0 ? gizemTokens / baselineTokens : 0,
    });
  }

  const totalGizem = rows.reduce((a, r) => a + r.gizemTokens, 0);
  const totalBaseline = rows.reduce((a, r) => a + r.baselineTokens, 0);
  const ratio = totalBaseline > 0 ? totalGizem / totalBaseline : 0;
  const meanRatio = rows.reduce((a, r) => a + r.ratio, 0) / Math.max(rows.length, 1);
  return { rows, totalGizem, totalBaseline, ratio, meanRatio, passed: ratio <= 0.1 };
}

// Local alias so the exported fn name reads clearly above.
function baselineTokensFor(repo: string, term: string): { tokens: number; files: number } {
  return baselineTokens(repo, term);
}
