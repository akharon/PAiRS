// Two bundles: the VS Code extension (vscode external) and the standalone
// MCP server / CLI. External modules marked below are not bundled:
// - vscode: provided by VS Code extension host
// web-tree-sitter itself is bundled fine (pure JS); its grammar/runtime .wasm
// assets are copied into dist/grammars by scripts/fetch-grammars.mjs and
// located at runtime via an explicit path, not import.meta.url resolution.
//
// The store runs on `node:sqlite`, a Node 22+ builtin — no native addon, so
// nothing platform-specific to ship and one .vsix covers every platform.
// (This replaced KuzuDB, which needed a per-platform prebuilt binary.)
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { copyGrammarsAndQueries } from './scripts/fetch-grammars.mjs';

const watch = process.argv.includes('--watch');

await copyGrammarsAndQueries();

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'node:sqlite'],
  // web-tree-sitter's emscripten glue calls createRequire(import.meta.url);
  // esbuild's CJS output rewrites import.meta to {}, so shim the url.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};

// Phase 0 scaffolds the CLI only; the extension host and MCP server entry
// points land in Phase 1. Skip bundles whose entry point doesn't exist yet so
// `npm run build` stays green as they arrive — no config change needed then.
const bundles = [
  { entry: 'src/adapters/vscode/extension.ts', outfile: 'dist/extension.js' },
  { entry: 'src/adapters/cli/index.ts', outfile: 'dist/cli.js' },
  { entry: 'src/adapters/mcp/serverCli.ts', outfile: 'dist/mcp-server.js' },
].filter(({ entry }) => {
  if (existsSync(entry)) return true;
  console.log(`[esbuild] skipping ${entry} — not implemented yet`);
  return false;
});

const contexts = await Promise.all(
  bundles.map(({ entry, outfile }) => esbuild.context({ ...common, entryPoints: [entry], outfile }))
);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
