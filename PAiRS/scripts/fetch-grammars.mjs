// Copies prebuilt tree-sitter grammar wasm (from the `tree-sitter-wasms`
// devDependency — no native build step, no tree-sitter-cli needed) plus the
// web-tree-sitter runtime's own tree-sitter.wasm, and the .scm query sources,
// into dist/grammars/ so ParserRegistryImpl can load them at runtime with a
// plain filesystem path (see src/index/parserRegistryImpl.ts).
//
// Run automatically before each esbuild build (see esbuild.mjs); safe to
// run standalone via `node scripts/fetch-grammars.mjs`.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const root = path.join(scriptsDir, '..');
const outDir = path.join(root, 'dist', 'grammars');
const queriesOutDir = path.join(root, 'dist', 'queries');

// CodeLang -> source wasm filename in node_modules/tree-sitter-wasms/out/.
// TypeScript's .tsx variant is copied too but both route to the same
// 'typescript' CodeLang extraction path (see parserRegistry.EXT_TO_LANG);
// only tree-sitter-typescript.wasm is required for v1 (.tsx falls back to it).
const GRAMMARS = {
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  python: 'tree-sitter-python.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  dart: 'tree-sitter-dart.wasm',
  rust: 'tree-sitter-rust.wasm',
  css: 'tree-sitter-css.wasm',
  html: 'tree-sitter-html.wasm',
};

// GDScript has no prebuilt wasm in tree-sitter-wasms (only a native node
// addon is published to npm), so it's compiled from the tree-sitter-gdscript
// devDependency's source via tree-sitter-cli at build time instead of
// copied. Cached in node_modules/.cache so repeat builds (no grammar change)
// don't re-invoke the wasi-sdk/binaryen toolchain tree-sitter-cli downloads
// on first use.
const GDSCRIPT_WASM = 'tree-sitter-gdscript.wasm';

async function buildGdscriptWasm() {
  const cacheDir = path.join(root, 'node_modules', '.cache', 'pairs-grammars');
  const cached = path.join(cacheDir, GDSCRIPT_WASM);
  const grammarDir = path.dirname(fileURLToPath(new URL(import.meta.resolve('tree-sitter-gdscript/package.json'))));

  const cachedStat = await fs.stat(cached).catch(() => null);
  const grammarStat = await fs.stat(path.join(grammarDir, 'src', 'parser.c')).catch(() => null);
  if (!cachedStat || !grammarStat || cachedStat.mtimeMs < grammarStat.mtimeMs) {
    await fs.mkdir(cacheDir, { recursive: true });
    execFileSync('npx', ['--yes', 'tree-sitter-cli', 'build', '--wasm', '-o', cached, grammarDir], {
      stdio: 'inherit',
    });
  }
  return cached;
}

export async function copyGrammarsAndQueries() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(queriesOutDir, { recursive: true });

  const wasmsDir = path.join(root, 'node_modules', 'tree-sitter-wasms', 'out');
  for (const file of Object.values(GRAMMARS)) {
    await fs.copyFile(path.join(wasmsDir, file), path.join(outDir, file));
  }

  const gdscriptWasm = await buildGdscriptWasm();
  await fs.copyFile(gdscriptWasm, path.join(outDir, GDSCRIPT_WASM));

  const runtimeWasm = path.join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
  await fs.copyFile(runtimeWasm, path.join(outDir, 'tree-sitter.wasm'));

  const queriesSrcDir = path.join(root, 'src', 'core', 'indexer', 'queries');
  const entries = await fs.readdir(queriesSrcDir);
  for (const entry of entries) {
    if (entry.endsWith('.scm')) {
      await fs.copyFile(path.join(queriesSrcDir, entry), path.join(queriesOutDir, entry));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await copyGrammarsAndQueries();
  // eslint-disable-next-line no-console
  console.log(`Copied grammars to ${outDir} and queries to ${queriesOutDir}`);
}
