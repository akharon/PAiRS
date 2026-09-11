/**
 * Lazy web-tree-sitter grammar loading. Pure WASM — no native modules — so it
 * runs unmodified inside the VS Code extension host on any platform.
 *
 * Adapted from vendor/reference-indexer/src/index/parserRegistry.ts, kept
 * multi-language: v1 *validates* on Rust only (types.ts V1_VALIDATED_LANGS),
 * but every grammar the reference project shipped loads and parses.
 *
 * Grammar .wasm files live under `dist/grammars/` and are fetched at build
 * time by scripts/fetch-grammars.mjs.
 */

import type { Language, Parser } from 'web-tree-sitter';
import type { CodeLang } from './types';

/** Headers default to 'cpp' (superset grammar). */
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
  '.gd': 'gdscript',
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
   * src/core/indexer/queries/<lang>.scm (bundled as text by esbuild).
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
