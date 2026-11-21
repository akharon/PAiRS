// Two bundles: the VS Code extension (`vscode` external) and the standalone
// `pairs` CLI. External modules marked below are not bundled:
// - vscode: provided by the VS Code extension host
// - node:sqlite: Node 22+ builtin (no native addon, so one .vsix covers every
//   platform)
// web-tree-sitter itself is bundled fine (pure JS); its grammar/runtime .wasm
// assets are copied into dist/grammars by scripts/fetch-grammars.mjs and
// located at runtime via an explicit path, not import.meta.url resolution.
//
// `node esbuild.mjs`            minified production bundles (what the .vsix ships)
// `node esbuild.mjs --watch`    unminified, rebuilds on change
// `node esbuild.mjs --dev`      unminified one-shot build
// `node esbuild.mjs --metafile` also writes dist/meta-<bundle>.json (bundle analysis)
import * as esbuild from 'esbuild';
import { writeFileSync } from 'node:fs';
import { copyGrammarsAndQueries } from './scripts/fetch-grammars.mjs';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const metafile = process.argv.includes('--metafile');

await copyGrammarsAndQueries();

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  minify: !dev,
  legalComments: 'none',
  metafile,
  external: ['vscode', 'node:sqlite'],
  // web-tree-sitter's emscripten glue calls createRequire(import.meta.url);
  // esbuild's CJS output rewrites import.meta to {}, so shim the url.
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
};

const bundles = [
  { entry: 'src/adapters/vscode/extension.ts', outfile: 'dist/extension.js' },
  { entry: 'src/adapters/cli/index.ts', outfile: 'dist/cli.js' },
];

const contexts = await Promise.all(
  bundles.map(async ({ entry, outfile }) => ({
    outfile,
    ctx: await esbuild.context({ ...common, entryPoints: [entry], outfile }),
  }))
);

if (watch) {
  await Promise.all(contexts.map(({ ctx }) => ctx.watch()));
} else {
  const results = await Promise.all(contexts.map(({ ctx }) => ctx.rebuild()));
  if (metafile) {
    results.forEach((r, i) => {
      writeFileSync(`dist/meta-${bundles[i].entry.includes('cli') ? 'cli' : 'extension'}.json`, JSON.stringify(r.metafile));
    });
  }
  await Promise.all(contexts.map(({ ctx }) => ctx.dispose()));
}
