/**
 * CLI entry point for the daemon-aware proxy, bundled to dist/mcp-proxy.js.
 * Drop-in replacement for dist/mcp-server.js's stdio contract for clients
 * that want daemon sharing: same --db/--code-db/--workspace flags, minus
 * --index-on-start (the daemon always indexes on workspace acquire).
 *
 * Usage: node mcp-proxy.js --workspace <ws> [--no-fallback]
 */

import * as path from 'node:path';
import { DaemonProxyImpl } from './daemon/proxy';

const VERSION = '0.1.0';

function parseProxyArgs(argv: string[]): { workspaceRoot: string; fallbackInProcess: boolean } {
  let workspaceRoot: string | undefined;
  let fallbackInProcess = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') workspaceRoot = argv[++i];
    else if (argv[i] === '--no-fallback') fallbackInProcess = false;
  }
  if (!workspaceRoot) {
    throw new Error('Usage: mcp-proxy.js --workspace <ws> [--no-fallback]');
  }
  return { workspaceRoot: path.resolve(workspaceRoot), fallbackInProcess };
}

const { workspaceRoot, fallbackInProcess } = parseProxyArgs(process.argv.slice(2));
const proxy = new DaemonProxyImpl(undefined, __dirname);

proxy.run({ workspaceRoot, version: VERSION, fallbackInProcess }).catch((err) => {
  console.error(err);
  process.exit(1);
});
