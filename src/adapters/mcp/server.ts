/**
 * Standalone stdio MCP server (plan.md 1.1). Bundled to dist/mcp-server.js so
 * any MCP client can launch it:
 *
 *   claude mcp add gizem -- node dist/mcp-server.js --db <ws>/.gizem/index
 *
 * Opens the Kuzu code graph at `--db` read-only-ish (single-writer model, ADR-
 * 009) and registers the code tools from tools.ts via McpServer +
 * StdioServerTransport. No memory/embedding subsystem — code graph only.
 *
 * Kept import-only (main/parseArgs exported, no auto-run) so serverCli.ts owns
 * the process entry; esbuild's module wrapper doesn't rebind require/module, so
 * a `require.main === module` guard here would misfire when re-bundled.
 */

import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import { createExecutors } from './executors';
import { codeToolSchemas } from './tools';
import type { CodeToolInput, CodeToolName } from './tools';

export interface McpServerConfig {
  /** Absolute path to the `.gizem/index` Kuzu database directory. */
  dbPath: string;
  serverName: string;
  version: string;
  /** Tool names to skip registering. */
  disabledTools: Set<string>;
}

export function parseArgs(argv: string[]): McpServerConfig {
  let dbPath = path.join(process.cwd(), '.gizem', 'index');
  const disabled = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') dbPath = path.resolve(argv[++i] ?? dbPath);
    else if (a === '--disabled-tools') for (const t of (argv[++i] ?? '').split(',')) if (t) disabled.add(t);
  }
  return { dbPath, serverName: 'gizem', version: '0.2.0', disabledTools: disabled };
}

export async function main(config: McpServerConfig): Promise<void> {
  const store = await KuzuCodeStore.open(config.dbPath, nodeKuzuDriver);
  const executors = createExecutors({ store });
  const server = new McpServer({ name: config.serverName, version: config.version });

  for (const [name, schema] of Object.entries(codeToolSchemas)) {
    if (config.disabledTools.has(name)) continue;
    const toolName = name as CodeToolName;
    server.registerTool(
      name,
      // The SDK's ZodRawShapeCompat inference trips TS2589 (excessively deep)
      // on our `.default()`/`.optional()` shapes; the shape is valid at runtime,
      // so cast past the generic. Input is still validated by schema.input.parse.
      { description: schema.description, inputSchema: schema.input.shape as unknown as Record<string, never> },
      async (args: unknown) => {
        try {
          const input = schema.input.parse(args) as CodeToolInput<CodeToolName>;
          const exec = executors[toolName] as (i: CodeToolInput<CodeToolName>) => Promise<string>;
          const text = await exec(input);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until the client disconnects; the store is never closed
  // (kuzu segfaults on close — dispose() is a no-op by design).
}
