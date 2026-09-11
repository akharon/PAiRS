/**
 * Precision ratchet: measures fuzzyRate/unresolvedRatio on PAiRS's own real
 * source tree and asserts they stay at or below a committed ceiling. Unlike
 * polyglot.test.ts (pins per-language behavior) this tracks the numbers that
 * `impact`/`who_calls`/`rename_symbol` trust — nothing else in the suite
 * catches a regression that raises the fuzzy rate.
 *
 * Runs the real parse -> extract -> store pipeline over src/ itself (not a
 * synthetic fixture) — a synthetic fixture can be constructed so every name
 * is unique by construction, which hid a 54% fuzzy rate on real code behind
 * a green, all-unique 3-file test (see git history). Real source is
 * method-call-dominated and genuinely ambiguous in places, so the ceiling
 * here is a measured number, not a target of 0.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { ParserRegistryImpl, fileQuerySource } from '../core/indexer/parserRegistryImpl';
import { ExtractorImpl } from '../core/indexer/extractorImpl';
import { IndexerImpl } from '../core/indexer/codeIndexerImpl';
import { nodeListWorkspaceFiles, nodeReadFile } from '../core/indexer/nodeFsDeps';
import { SqliteCodeStore } from '../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../store/graph/sqliteDriver';
import * as fs from 'node:fs';
import * as os from 'node:os';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, '..', 'core', 'indexer', 'queries');

// Ratchet: these are measured ceilings, not goals. If a change lowers them,
// lower the constants in the same commit. If a change raises them, it has
// made the graph less accurate — fix the change, do not raise the number.
//
// Measured 2026-09-07 on PAiRS's own src/ (55 files, TypeScript-dominated),
// after Step 2.1 (unique-name method calls resolve) and Step 2.3 (TS
// declared-receiver-type resolution): fuzzyRate 0.28, unresolvedRatio 0.62.
// Prior baseline (before this session's resolver work): fuzzyRate 0.4934.
const MAX_FUZZY_RATE = 0.28;
const MAX_UNRESOLVED_RATIO = 0.62;

describe('precision ratchet', () => {
  it('PAiRS’s own real source tree stays within the measured fuzzy-rate ceiling', async () => {
    const root = path.join(__dirname, '..', '..');
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-precision-'));
    const store = await SqliteCodeStore.open(path.join(dbDir, 'index.db'), nodeSqlDriver);
    const parsers = new ParserRegistryImpl(GRAMMARS_DIR, fileQuerySource(QUERIES_DIR));
    const extractor = new ExtractorImpl();
    const indexer = new IndexerImpl({
      store,
      parsers,
      extractor,
      listWorkspaceFiles: nodeListWorkspaceFiles(root),
      readFile: nodeReadFile(root),
    });

    await indexer.fullIndex(root);
    const stats = await store.stats();

    expect(stats.fuzzyRate).toBeLessThanOrEqual(MAX_FUZZY_RATE);
    expect(stats.unresolvedRatio).toBeLessThanOrEqual(MAX_UNRESOLVED_RATIO);
  }, 30_000);
});
