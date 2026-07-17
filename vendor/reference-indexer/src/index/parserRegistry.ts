/**
 * Lazy web-tree-sitter grammar loading. Pure WASM — no native modules — so it
 * runs unmodified inside the VS Code extension host on any platform.
 *
 * Grammar .wasm files live under `<extensionPath>/dist/grammars/` and are
 * fetched at build time by scripts/fetch-grammars.mjs (preferred source:
 * prebuilt wasm from the `@vscode/tree-sitter-wasm` npm package; for any
 * language it lacks, build once with `tree-sitter build --wasm` and vendor
 * the artifact). A grammar is loaded on the FIRST file of its language and
 * cached; workspaces without e.g. Java never pay for the Java wasm.
 */

import type { Language, Parser } from 'web-tree-sitter';
import type { CodeLang } from './types';

/** File-extension → language routing. Headers default to 'cpp' (superset grammar). */
export const EXT_TO_LANG: Readonly<Record<string, CodeLang>> = {
  '.c': 'c',
  '.h': 'cpp',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.py': 'python',
  '.pyi': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.java': 'java',
  '.go': 'go',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.dart': 'dart',
  '.rs': 'rust',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
};

/** Null when the extension is not indexed (config exclusions handled elsewhere). */
export function langForPath(path: string): CodeLang | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_LANG[path.slice(dot).toLowerCase()] ?? null;
}

export interface LoadedLanguage {
  lang: CodeLang;
  parser: Parser;
  language: Language;
  /**
   * The compiled tree-sitter query for this language, from
   * src/index/queries/<lang>.scm (bundled as text by esbuild).
   * Capture-name contract documented in extractors.ts.
   */
  query: import('web-tree-sitter').Query;
}

export interface ParserRegistry {
  /**
   * One-time `Parser.init({ locateFile })` pointing at the bundled
   * tree-sitter.wasm. Must complete before any `load`.
   */
  init(): Promise<void>;
  /** Load-or-return-cached grammar + compiled query for a language. */
  load(lang: CodeLang): Promise<LoadedLanguage>;
  /** Languages whose wasm was actually loaded (diagnostics/status bar). */
  loadedLangs(): CodeLang[];
  dispose(): void;
}

export interface ParserRegistryFactory {
  /** @param grammarsDir absolute path to dist/grammars (contains *.wasm + tree-sitter.wasm) */
  create(grammarsDir: string): ParserRegistry;
}
