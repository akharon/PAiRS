// Two bundles: the extension (vscode external) and the standalone MCP server.
// External modules marked below are not bundled:
// - vscode: provided by VS Code extension host
// - node:sqlite: built-in to Node 22+ (no bundling needed, ~2.2MB saved vs better-sqlite3)
// - @huggingface/transformers: lazy-loaded at runtime only if embeddings enabled
// web-tree-sitter itself is bundled fine (pure JS); its grammar/runtime .wasm
// assets are copied into dist/grammars by scripts/fetch-grammars.mjs and
// located at runtime via an explicit path, not import.meta.url resolution.
import * as esbuild from 'esbuild';
import { copyGrammarsAndQueries } from './scripts/fetch-grammars.mjs';

const watch = process.argv.includes('--watch');

await copyGrammarsAndQueries();

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', '@huggingface/transformers', 'node:sqlite'],
  // web-tree-sitter's emscripten glue calls createRequire(import.meta.url);
  // esbuild's CJS output rewrites import.meta to {}, so shim the url.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }),
  esbuild.context({ ...common, external: ['@huggingface/transformers', 'node:sqlite'], entryPoints: ['src/mcp/serverCli.ts'], outfile: 'dist/mcp-server.js' }),
  esbuild.context({ ...common, external: ['@huggingface/transformers', 'node:sqlite'], entryPoints: ['src/mcp/desktopEntry.ts'], outfile: 'dist/mcp-desktop.js' }),
  esbuild.context({ ...common, external: ['@huggingface/transformers', 'node:sqlite'], entryPoints: ['src/mcp/daemonEntry.ts'], outfile: 'dist/mcp-daemon.js' }),
  esbuild.context({ ...common, external: ['@huggingface/transformers', 'node:sqlite'], entryPoints: ['src/mcp/proxyEntry.ts'], outfile: 'dist/mcp-proxy.js' }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
