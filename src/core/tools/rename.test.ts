/**
 * rename.ts: the fuzzy-site gate. Uses a real SQLite store in a temp dir,
 * following the setup style in executors.test.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import { planRename, applyPlan } from './rename';
import type { FileExtraction, NewSymbol, RawRef } from '../indexer/types';

function sym(name: string, qualified: string, kind: NewSymbol['kind'] = 'function'): NewSymbol {
  return { name, qualified, kind, lang: 'rust', startLine: 10, endLine: 12, signature: '()', doc: null, exported: true, parentIndex: null };
}
function ext(p: string, symbols: NewSymbol[], refs: RawRef[] = []): FileExtraction {
  return { path: p, lang: 'rust', mtimeMs: 1, size: 1, hash: `h-${p}-${Math.random()}`, crate: null, parseError: false, symbols: [sym(p, p, 'module'), ...symbols], refs, uses: [] };
}
const fromFn = (name: string, qualifiedName: string | null, line = 5): RawRef => ({
  fromIndex: 1,
  name,
  qualifiedName,
  kind: 'CALLS',
  line,
});

async function makeStore(dir: string) {
  return SqliteCodeStore.open(path.join(dir, 'g.db'), nodeSqlDriver);
}

describe('planRename', () => {
  it('renames all sites when every reference is resolved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-rename-resolved-'));
    const store = await makeStore(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    const coreLines = Array.from({ length: 9 }, () => '').concat('fn core() {}');
    fs.writeFileSync(path.join(dir, 'src/core.rs'), coreLines.join('\n') + '\n');
    const midLines = Array.from({ length: 4 }, () => '').concat('    core();').concat(Array.from({ length: 5 }, () => ''));
    fs.writeFileSync(path.join(dir, 'src/mid.rs'), midLines.join('\n') + '\n');

    await store.applyExtraction(ext('src/core.rs', [sym('core', 'core')]));
    await store.applyExtraction(ext('src/mid.rs', [sym('mid', 'mid')], [fromFn('core', null)]));

    const seed = (await store.lookup('core')) as Array<{ id: number }>;
    expect(Array.isArray(seed)).toBe(true);
    const seedSym = await store.get(seed[0]!.id);
    const plan = await planRename(store, dir, seedSym!, 'core_v2');
    expect('message' in plan).toBe(false);
    if ('message' in plan) return;
    expect(plan.sites.every((s) => s.confidence === 'resolved')).toBe(true);

    const touched = applyPlan(plan);
    expect(touched.length).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8')).toContain('fn core_v2() {}');
    expect(fs.readFileSync(path.join(dir, 'src/mid.rs'), 'utf8')).toContain('core_v2();');
  });

  it('aborts without writing when a fuzzy site exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-rename-fuzzy-'));
    const store = await makeStore(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    const coreLines = Array.from({ length: 9 }, () => '').concat('fn shared() {}');
    fs.writeFileSync(path.join(dir, 'src/core.rs'), coreLines.join('\n') + '\n');
    const midLines = Array.from({ length: 4 }, () => '').concat('    shared();').concat(Array.from({ length: 5 }, () => ''));
    fs.writeFileSync(path.join(dir, 'src/mid.rs'), midLines.join('\n') + '\n');
    // A second, unrelated symbol with the same bare name forces `byName`
    // resolution to see 2 candidates, marking the mid.rs ref fuzzy.
    const otherLines = Array.from({ length: 9 }, () => '').concat('fn shared() {}');
    fs.writeFileSync(path.join(dir, 'src/other.rs'), otherLines.join('\n') + '\n');

    await store.applyExtraction(ext('src/core.rs', [sym('shared', 'core::shared')]));
    await store.applyExtraction(ext('src/other.rs', [sym('shared', 'other::shared')]));
    await store.applyExtraction(ext('src/mid.rs', [sym('mid', 'mid')], [fromFn('shared', null)]));

    const beforeCore = fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8');
    const beforeMid = fs.readFileSync(path.join(dir, 'src/mid.rs'), 'utf8');
    const beforeOther = fs.readFileSync(path.join(dir, 'src/other.rs'), 'utf8');

    const seed = (await store.lookup('core::shared')) as Array<{ id: number }>;
    const seedSym = await store.get(seed[0]!.id);
    const plan = await planRename(store, dir, seedSym!, 'shared_v2');
    expect('message' in plan).toBe(true);
    if (!('message' in plan)) return;
    expect(plan.message).toContain('Aborted');

    expect(fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8')).toBe(beforeCore);
    expect(fs.readFileSync(path.join(dir, 'src/mid.rs'), 'utf8')).toBe(beforeMid);
    expect(fs.readFileSync(path.join(dir, 'src/other.rs'), 'utf8')).toBe(beforeOther);
  });

  it('renames fuzzy sites too when includeFuzzy is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-rename-includefuzzy-'));
    const store = await makeStore(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    const coreLines = Array.from({ length: 9 }, () => '').concat('fn shared() {}');
    fs.writeFileSync(path.join(dir, 'src/core.rs'), coreLines.join('\n') + '\n');
    const midLines = Array.from({ length: 4 }, () => '').concat('    shared();').concat(Array.from({ length: 5 }, () => ''));
    fs.writeFileSync(path.join(dir, 'src/mid.rs'), midLines.join('\n') + '\n');
    const otherLines = Array.from({ length: 9 }, () => '').concat('fn shared() {}');
    fs.writeFileSync(path.join(dir, 'src/other.rs'), otherLines.join('\n') + '\n');

    await store.applyExtraction(ext('src/core.rs', [sym('shared', 'core::shared')]));
    await store.applyExtraction(ext('src/other.rs', [sym('shared', 'other::shared')]));
    await store.applyExtraction(ext('src/mid.rs', [sym('mid', 'mid')], [fromFn('shared', null)]));

    const seed = (await store.lookup('core::shared')) as Array<{ id: number }>;
    const seedSym = await store.get(seed[0]!.id);
    const plan = await planRename(store, dir, seedSym!, 'shared_v2', { includeFuzzy: true });
    expect('message' in plan).toBe(false);
    if ('message' in plan) return;
    expect(plan.sites.some((s) => s.confidence === 'fuzzy')).toBe(true);

    const touched = applyPlan(plan);
    expect(touched.length).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'src/core.rs'), 'utf8')).toContain('fn shared_v2() {}');
    expect(fs.readFileSync(path.join(dir, 'src/mid.rs'), 'utf8')).toContain('shared_v2();');
    // The unrelated same-named symbol's own file is untouched: it has no
    // reference edge into the seed and never appears in collectSites.
    expect(fs.readFileSync(path.join(dir, 'src/other.rs'), 'utf8')).toContain('fn shared() {}');
  });

  it('treats a line reached by both a fuzzy and a resolved edge as resolved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-rename-dedupe-'));
    const store = await makeStore(dir);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    const coreLines = Array.from({ length: 9 }, () => '').concat('fn shared() {}');
    fs.writeFileSync(path.join(dir, 'src/core.rs'), coreLines.join('\n') + '\n');
    // Same line calls `shared` twice conceptually — we model the dedupe by
    // having two refs land on the identical file:line, one resolved (bare
    // name, unique) and one fuzzy (methodCall). Confidence must resolve.
    const midLines = Array.from({ length: 4 }, () => '').concat('    shared(); shared();').concat(Array.from({ length: 5 }, () => ''));
    fs.writeFileSync(path.join(dir, 'src/mid.rs'), midLines.join('\n') + '\n');

    await store.applyExtraction(ext('src/core.rs', [sym('shared', 'core::shared')]));
    await store.applyExtraction(
      ext('src/mid.rs', [sym('mid', 'mid')], [
        fromFn('shared', null, 5),
        { fromIndex: 1, name: 'shared', qualifiedName: null, kind: 'CALLS', line: 5, methodCall: true },
      ])
    );

    const seed = (await store.lookup('core::shared')) as Array<{ id: number }>;
    const seedSym = await store.get(seed[0]!.id);
    const plan = await planRename(store, dir, seedSym!, 'shared_v2');
    expect('message' in plan).toBe(false);
    if ('message' in plan) return;
    const midSites = plan.sites.filter((s) => s.file === 'src/mid.rs');
    expect(midSites.length).toBe(1);
    expect(midSites[0]!.confidence).toBe('resolved');
  });
});
