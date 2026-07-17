/**
 * CLI entry point for the standalone stdio MCP server, bundled to
 * dist/mcp-server.js. Kept separate from server.ts (which only exports
 * main/parseArgs) because server.ts is also require'd from
 * dist/mcp-desktop.js (the Claude Desktop bundle) — a `require.main ===
 * module` auto-run guard inside server.ts itself would misfire there, since
 * esbuild's __esm wrapper doesn't rebind `require`/`module` per-module.
 */

import { main, parseArgs } from './server';

main(parseArgs(process.argv.slice(2))).catch((err) => {
  console.error(err);
  process.exit(1);
});
