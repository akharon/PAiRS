/**
 * CLI entry point for the shared PAiRS daemon, bundled to dist/mcp-daemon.js.
 * Spawned (detached, stdio ignored) by proxyEntry.ts when no live daemon is
 * discovered; never launched directly by an MCP client. See
 * docs/DaemonDesign.md and src/mcp/daemon/daemon.ts.
 */

import { PairsDaemonImpl } from './daemon/daemon';

const VERSION = '0.1.0';

async function run(): Promise<void> {
  const daemon = new PairsDaemonImpl({ version: VERSION }, __dirname);
  const info = await daemon.start();
  console.error(`[PAIRS daemon] listening on 127.0.0.1:${info.port} (pid ${info.pid})`);

  const shutdown = () => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
