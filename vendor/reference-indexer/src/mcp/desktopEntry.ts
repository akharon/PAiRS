/**
 * Entry point for the Claude Desktop MCPB bundle (dist/mcp-desktop.js).
 *
 * Claude Desktop launches this with only PAIRS_WORKSPACE set (the workspace
 * folder the user picked in the extension's config UI) — it has no notion of
 * the .pairs/ on-disk layout that the VS Code extension writes to, so this
 * wrapper derives the db paths and delegates to the same main() used by
 * dist/mcp-server.js.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function checkNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(
      `PAiRS requires Node >=22.5 for node:sqlite (found ${process.versions.node}). ` +
        'This should not happen under Claude Desktop’s bundled runtime; please report this.'
    );
    process.exit(1);
  }
}

// Checked before importing ./server, which pulls in node:sqlite at module
// scope — on Node <22.5 that throws ERR_UNKNOWN_BUILTIN_MODULE instead of
// this guard's clear message, so the check must run first via require().
async function run(): Promise<void> {
  checkNodeVersion();

  const { main, parseArgs } = require('./server') as typeof import('./server');

  const workspace = process.env.PAIRS_WORKSPACE;
  if (!workspace) {
    console.error('PAiRS: PAIRS_WORKSPACE environment variable is not set.');
    process.exit(1);
  }

  const pairsDir = path.join(workspace, '.pairs');
  const dbPath = path.join(pairsDir, 'memory.db');
  if (!fs.existsSync(dbPath)) {
    console.error(
      `PAiRS: no memory index found at ${dbPath}. ` +
        'Open this workspace in VS Code with the PAiRS extension installed first, so it can build the index.'
    );
    process.exit(1);
  }

  const codeDbPath = path.join(pairsDir, 'code.db');
  const okfRoot = path.join(workspace, '.vscode', 'memory');

  main(
    parseArgs([
      '--db',
      dbPath,
      '--okf',
      okfRoot,
      ...(fs.existsSync(codeDbPath) ? ['--code-db', codeDbPath] : []),
    ])
  ).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

run();
