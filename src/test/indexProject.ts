/**
 * Real-stack test harness: writes a small file tree to a temp dir and runs it
 * through the actual parse → extract → store pipeline (mirrors
 * adapters/cli/index.ts's wiring), not fake extractions or fake stores. Use
 * this whenever a test needs to know the pipeline actually produces graph
 * edges for real source text, not just that a hand-built FileExtraction
 * resolves correctly in isolation.
 *
 * Requires dist/grammars (npm run fetch-grammars) — real tree-sitter wasm.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExtractorImpl } from '../core/indexer/extractorImpl';
import { IndexerImpl } from '../core/indexer/codeIndexerImpl';
import { nodeListWorkspaceFiles, nodeReadFile } from '../core/indexer/nodeFsDeps';
import { fileQuerySource, ParserRegistryImpl } from '../core/indexer/parserRegistryImpl';
import { SqliteCodeStore } from '../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../store/graph/sqliteDriver';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, '..', 'core', 'indexer', 'queries');

/**
 * Writes `files` (workspace-relative path → source text) into a fresh temp
 * dir and runs a real fullIndex over it.
 */
export async function indexProject(files: Record<string, string>): Promise<{ store: SqliteCodeStore; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-index-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }

  // SQLite creates the database file itself but not its parent directory
  // (mirrors adapters/cli/index.ts's mkdir before open).
  fs.mkdirSync(path.join(root, '.pairs'), { recursive: true });
  const store = await SqliteCodeStore.open(path.join(root, '.pairs', 'index.db'), nodeSqlDriver);
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
  return { store, root };
}
