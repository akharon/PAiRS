/**
 * ParserRegistry implementation over web-tree-sitter WASM grammars.
 *
 * Adapted from vendor/reference-indexer/src/index/parserRegistryImpl.ts,
 * unchanged. Multi-language: all 12 grammars load; v1 precision validation
 * (types.ts V1_VALIDATED_LANGS) covers only Rust.
 *
 * Grammar files are copied at build time (scripts/fetch-grammars.mjs) from
 * `tree-sitter-wasms` into `dist/grammars/tree-sitter-<lang>.wasm`, plus the
 * core `tree-sitter.wasm` runtime from the `web-tree-sitter` package itself.
 * Query source is bundled as text via esbuild's `.scm` loader (see
 * esbuild.mjs) and passed in by the caller rather than read from disk here,
 * so this module has no filesystem dependency beyond the grammar wasm files.
 */

import { Language, Parser, Query } from 'web-tree-sitter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoadedLanguage, ParserRegistry, ParserRegistryFactory } from './parserRegistry';
import type { CodeLang } from './types';

// TypeScript and TSX share the same tree-sitter grammar file family but ship
// as separate wasm artifacts in tree-sitter-wasms; both map to our
// 'typescript' CodeLang (see EXT_TO_LANG for .tsx routing to 'typescript').
const GRAMMAR_FILE: Readonly<Record<CodeLang, string>> = {
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

export interface QuerySource {
  /** Loader supplies the .scm text for a language (bundled by esbuild). */
  (lang: CodeLang): string;
}

export class ParserRegistryImpl implements ParserRegistry {
  private readonly grammarsDir: string;
  private readonly getQuerySource: QuerySource;
  private initialized = false;
  private readonly cache = new Map<CodeLang, LoadedLanguage>();

  constructor(grammarsDir: string, getQuerySource: QuerySource) {
    this.grammarsDir = grammarsDir;
    this.getQuerySource = getQuerySource;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init({
      locateFile: () => path.join(this.grammarsDir, 'tree-sitter.wasm'),
    });
    this.initialized = true;
  }

  async load(lang: CodeLang): Promise<LoadedLanguage> {
    const cached = this.cache.get(lang);
    if (cached) return cached;
    if (!this.initialized) await this.init();

    const wasmPath = path.join(this.grammarsDir, GRAMMAR_FILE[lang]);
    const language = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, this.getQuerySource(lang));

    const loaded: LoadedLanguage = { lang, parser, language, query };
    this.cache.set(lang, loaded);
    return loaded;
  }

  loadedLangs(): CodeLang[] {
    return [...this.cache.keys()];
  }

  dispose(): void {
    for (const { parser, query } of this.cache.values()) {
      query.delete();
      parser.delete();
    }
    this.cache.clear();
  }
}

/**
 * Default QuerySource: reads `<queriesDir>/<lang>.scm` from disk.
 * scripts/fetch-grammars.mjs copies src/core/indexer/queries/*.scm to
 * dist/queries at build time.
 */
export function fileQuerySource(queriesDir: string): QuerySource {
  const cache = new Map<CodeLang, string>();
  return (lang: CodeLang) => {
    const cached = cache.get(lang);
    if (cached !== undefined) return cached;
    const text = fs.readFileSync(path.join(queriesDir, `${lang}.scm`), 'utf8');
    cache.set(lang, text);
    return text;
  };
}
