/**
 * Headless activation-scan runner: reuses the extension's CodeIndexer with
 * Node-fs-backed deps (no vscode APIs) so both the standalone stdio server
 * (server.ts --index-on-start) and the shared daemon's WorkspaceRegistry can
 * index a workspace without VS Code running.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { CodeStore } from './codeStore';
import { CodeIndexerImpl } from './codeIndexerImpl';
import { ExtractorImpl } from './extractorImpl';
import { ParserRegistryImpl, fileQuerySource } from './parserRegistryImpl';
import { createGitOps } from './gitOps';
import { nodeListWorkspaceFiles, nodeReadFile } from './nodeFsDeps';
import { TransformersEmbeddingProvider } from '../intelligence/transformersEmbeddingProvider';
import type { GitOps } from './codeIndexer';
import type { IndexFreshness, IndexProvenanceService } from './provenance';
import { logger } from '../core/logger';

export interface HeadlessIndexerOptions {
  /** Enable symbol-embedding backfill. Default true; PAIRS_EMBEDDINGS=0 disables. */
  embeddings?: boolean;
  /** transformers.js model cache. Default ~/.pairs/models (shared across workspaces). */
  modelCacheDir?: string;
  /**
   * Generation stamps (docs/MemoryIndexSynergy.md §F1) — pass the service
   * returned by SqliteCodeStoreFactory.openWithProvenance() alongside its
   * matching `codeStore` to enable them; omit for the plain open() path.
   */
  provenance?: IndexProvenanceService;
  /** Required when `provenance` is supplied. */
  toolVersion?: string;
}

/**
 * @param bundleDir directory the running bundle lives in (grammars/queries
 *        are copied next to it at build time — `dist/` for both mcp-server.js
 *        and the daemon bundle).
 * @returns dispose() — call when the workspace handle closes so the
 *        embedding pipeline (and any onnx threads) doesn't outlive it. Also
 *        returns the GitOps instance so callers can reuse it for commit
 *        stamps (§F2) / freshness queries (§F1) without a second sidecar file.
 */
export async function startHeadlessIndexer(
  codeStore: CodeStore,
  workspaceRoot: string,
  bundleDir: string,
  options?: HeadlessIndexerOptions
): Promise<{ dispose(): void; git: GitOps; freshness(): Promise<IndexFreshness | null> }> {
  const grammarsDir = path.join(bundleDir, 'grammars');
  const queriesDir = path.join(bundleDir, 'queries');
  const parsers = new ParserRegistryImpl(grammarsDir, fileQuerySource(queriesDir));
  const git = createGitOps(workspaceRoot, path.join(workspaceRoot, '.pairs', 'code-index-git-state.json'));

  const embeddingsEnabled = (options?.embeddings ?? true) && process.env.PAIRS_EMBEDDINGS !== '0';
  let provider: TransformersEmbeddingProvider | undefined;
  let loggedUnavailable = false;

  if (embeddingsEnabled) {
    const cacheDir = options?.modelCacheDir ?? process.env.PAIRS_MODEL_CACHE ?? path.join(os.homedir(), '.pairs', 'models');
    provider = new TransformersEmbeddingProvider(cacheDir);
  }

  if (options?.provenance && options.toolVersion && (await options.provenance.needsFullRebuild(options.toolVersion))) {
    await codeStore.reset();
  }

  const indexer = new CodeIndexerImpl(
    {
      store: codeStore,
      parsers,
      extractor: new ExtractorImpl(),
      listWorkspaceFiles: nodeListWorkspaceFiles(workspaceRoot),
      readFile: nodeReadFile(workspaceRoot),
      git,
      provenance: options?.provenance,
      embed: provider
        ? async (texts: string[]) => {
            try {
              return await provider!.embedBatch(texts);
            } catch (err) {
              if (!loggedUnavailable) {
                loggedUnavailable = true;
                logger.warn('embeddings unavailable', err);
              }
              throw err;
            }
          }
        : undefined,
    },
    { workspaceRoot, exclude: [], embeddingsEnabled: !!provider, toolVersion: options?.toolVersion }
  );
  await indexer.start();

  return {
    dispose(): void {
      provider?.dispose();
    },
    git,
    freshness: () => indexer.freshness(),
  };
}
