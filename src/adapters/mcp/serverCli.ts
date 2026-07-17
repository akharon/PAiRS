/**
 * Process entry for the standalone stdio MCP server, bundled to
 * dist/mcp-server.js. Separate from server.ts (import-only) so esbuild's module
 * wrapper never triggers a stray auto-run when server.ts is re-bundled.
 */

import { main, parseArgs } from './server';

main(parseArgs(process.argv.slice(2))).catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
