// Two bundles: the VS Code extension (vscode external) and the standalone
// MCP server / CLI. External modules marked below are not bundled:
// - vscode: provided by VS Code extension host
// - kuzu: native addon (R4) — must be bundled as a platform-specific binary
//   per .vsix by scripts/package.sh, not inlined by esbuild
// web-tree-sitter itself is bundled fine (pure JS); its grammar/runtime .wasm
// assets are copied into dist/grammars by scripts/fetch-grammars.mjs and
// located at runtime via an explicit path, not import.meta.url resolution.
//
// Adapted from vendor/reference-indexer/esbuild.mjs: dropped the
// @huggingface/transformers and node:sqlite externals (no embeddings, no
// memory subsystem); added kuzu.
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
  external: ['vscode', 'kuzu'],
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
  { entry: 'src/adapters/bench/v3BenchCli.ts', outfile: 'dist/v3-bench.js' },
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
