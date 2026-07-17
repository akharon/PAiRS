/**
 * Standalone stdio MCP server entrypoint. Bundled separately by esbuild to
 * `dist/mcp-server.js` so it can be launched by ANY MCP client:
 *
 *  - VS Code: registered via vscode.lm.registerMcpServerDefinitionProvider
 *    (see integration/mcpProvider.ts), which passes the workspace's
 *    `.pairs/memory.db` + `.pairs/code.db` — the SAME databases extension.ts
 *    opens, so both transports see one store.
 *  - Claude Code CLI: `claude mcp add pairs -- node dist/mcp-server.js
 *    --db <ws>/.pairs/memory.db --code-db <ws>/.pairs/code.db --index-on-start`
 *
 * The server opens the SQLite db directly (WAL mode makes concurrent access
 * with the extension host safe) and exposes the tools from tools.ts via
 * `McpServer` from @modelcontextprotocol/sdk with StdioServerTransport.
 *
 * `--index-on-start` runs a headless activation scan of the workspace after
 * connecting, so the code index is fresh even when VS Code isn't running.
 * Concurrent indexing with the extension host is safe: WAL + transactional,
 * hash-idempotent applyExtraction. Embeddings backfill by default too (a
 * shared transformers.js MiniLM pipeline, model cache under ~/.pairs/models);
 * pass --no-embeddings to skip (symbol indexing is unaffected either way).
 *
 * Also exposes one MCP *resource*: `memory://index` → the rendered OKF
 * index.md, so clients can pull an overview without a tool call.
 *
 * Usage: node mcp-server.js --db <ws>/.pairs/memory.db [--okf <ws>/.vscode/memory]
 *        [--code-db <ws>/.pairs/code.db] [--index-on-start] [--workspace <ws>]
 *        [--disabled-tools a,b,c]
 */

import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SqliteMemoryStoreFactory } from '../core/sqliteStore';
import { SqliteCodeStoreFactory } from '../index/codeStoreImpl';
import { CodeSearchImpl } from '../index/codeSearchImpl';
import { startHeadlessIndexer } from '../index/headlessIndexer';
import type { HeadlessIndexerOptions } from '../index/headlessIndexer';
import type { CodeStore } from '../index/codeStore';
import type { GitOps } from '../index/codeIndexer';
import type { IndexFreshness, IndexProvenanceService } from '../index/provenance';
import { createGitOps } from '../index/gitOps';
import { createExecutors } from './createExecutors';
import { codeToolSchemas, toolSchemas } from './tools';
import { logger } from '../core/logger';

export interface McpServerConfig {
  dbPath: string;
  /** OKF bundle root; exports after mutations when provided. */
  okfRoot?: string;
  /** Code index db; when provided, registers the nine code tools. */
  codeDbPath?: string;
  /** Run a headless activation scan after connecting (for use without VS Code). */
  indexOnStart?: boolean;
  /** Workspace root for --index-on-start. Default: parent of the code.db's `.pairs` dir. */
  workspaceRoot?: string;
  /** Symbol-embedding backfill during --index-on-start. Default true. */
  embeddings?: boolean;
  /** Tool names to skip registering (mirrors pairs.disabledTools). */
  disabledTools?: Set<string>;
  serverName: string; // 'pairs'
  version: string;
}

export function parseArgs(argv: string[]): McpServerConfig {
  let dbPath: string | undefined;
  let okfRoot: string | undefined;
  let codeDbPath: string | undefined;
  let indexOnStart = false;
  let workspaceRoot: string | undefined;
  let embeddings = true;
  let disabledTools: Set<string> | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') dbPath = argv[++i];
    else if (argv[i] === '--okf') okfRoot = argv[++i];
    else if (argv[i] === '--code-db') codeDbPath = argv[++i];
    else if (argv[i] === '--index-on-start') indexOnStart = true;
    else if (argv[i] === '--workspace') workspaceRoot = argv[++i];
    else if (argv[i] === '--embeddings') embeddings = true;
    else if (argv[i] === '--no-embeddings') embeddings = false;
    else if (argv[i] === '--disabled-tools') {
      disabledTools = new Set(
        (argv[++i] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  }
  if (!dbPath) {
    throw new Error(
      'Usage: mcp-server.js --db <ws>/.pairs/memory.db [--okf <ws>/.vscode/memory] ' +
        '[--code-db <ws>/.pairs/code.db] [--index-on-start] [--workspace <ws>] ' +
        '[--embeddings|--no-embeddings] [--disabled-tools a,b,c]'
    );
  }
  if (!workspaceRoot && codeDbPath) {
    workspaceRoot = path.resolve(path.dirname(codeDbPath), '..');
  }
  return {
    dbPath,
    okfRoot,
    codeDbPath,
    indexOnStart,
    workspaceRoot,
    embeddings,
    disabledTools,
    serverName: 'pairs',
    version: '0.1.0',
  };
}

export async function main(config: McpServerConfig): Promise<void> {
  // Same `.pairs/` dir the extension logs to (memory.db lives there).
  logger.init(path.dirname(config.dbPath));

  const store = await new SqliteMemoryStoreFactory().open(config.dbPath);
  // Version guard: if the extension was reinstalled/upgraded, clear memory db
  // so the new version starts fresh (backup is created automatically).
  await store.checkVersion(config.version);

  let codeStore: CodeStore | undefined;
  let codeSearch: CodeSearchImpl | undefined;
  let provenance: IndexProvenanceService | undefined;
  let git: GitOps | undefined;
  // Set once --index-on-start's headless indexer resolves (fire-and-forget,
  // after server.connect — see below); freshness() closures call through it
  // lazily so tool responses stay accurate even before that resolves.
  let headlessFreshness: (() => Promise<IndexFreshness | null>) | undefined;

  if (config.codeDbPath) {
    const opened = await new SqliteCodeStoreFactory().openWithProvenance(config.codeDbPath);
    codeStore = opened.store;
    provenance = opened.provenance;
    codeSearch = new CodeSearchImpl({ store: codeStore });
    if (config.workspaceRoot) {
      git = createGitOps(config.workspaceRoot, path.join(config.workspaceRoot, '.pairs', 'code-index-git-state.json'));
    }
  }

  const { memory: executor, code: codeExecutor } = createExecutors({
    store,
    git,
    code:
      codeStore && codeSearch
        ? {
            store: codeStore,
            search: codeSearch,
            provenance,
            freshness: provenance ? () => (headlessFreshness ? headlessFreshness() : provenance!.freshness({ git })) : undefined,
          }
        : undefined,
  });

  const server = new McpServer({ name: config.serverName, version: config.version });
  const disabledTools = config.disabledTools ?? new Set<string>();

  for (const [name, schema] of Object.entries(toolSchemas)) {
    if (disabledTools.has(name)) continue;
    server.registerTool(
      name,
      { description: schema.description, inputSchema: schema.input.shape },
      async (input: unknown) => {
        const result = await executor.execute(name as keyof typeof toolSchemas, input as never, 'mcp');
        return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
      }
    );
  }

  if (codeExecutor) {
    for (const [name, schema] of Object.entries(codeToolSchemas)) {
      if (disabledTools.has(name)) continue;
      server.registerTool(
        name,
        { description: schema.description, inputSchema: schema.input.shape },
        async (input: unknown) => {
          const result = await codeExecutor.execute(name as keyof typeof codeToolSchemas, input as never, 'mcp');
          return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
        }
      );
    }
  }

  server.registerResource(
    'memory-index',
    'memory://index',
    { title: 'PAiRS Index', description: 'Overview of all saved memories', mimeType: 'text/markdown' },
    async (uri) => {
      const memories = await store.list({ limit: 200 });
      const lines = [`# Memory`, '', `${memories.length} memories.`, ''];
      for (const m of memories) lines.push(`- \`${m.id}\` (${m.type}): ${m.title} — ${m.description}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Fire-and-forget AFTER connect so the client handshake isn't blocked; the
  // freshness footer on tool responses reports scan progress.
  if (config.indexOnStart && codeStore && config.workspaceRoot) {
    // dist/mcp-server.js sits next to dist/grammars + dist/queries.
    const options: HeadlessIndexerOptions = {
      embeddings: config.embeddings,
      provenance,
      toolVersion: config.version,
    };
    void startHeadlessIndexer(codeStore, config.workspaceRoot, __dirname, options)
      .then((handle) => {
        headlessFreshness = () => handle.freshness();
      })
      .catch((err) => {
        logger.error('headless index failed', err);
      });
  }
}

