/**
 * Import-specifier → workspace file candidates.
 *
 * DEPENDS_ON edges are built from import statements. Rust's `use foo::bar`
 * names a *symbol*, so the resolver's name ladder finds it; TypeScript,
 * JavaScript, Python, Dart, C/C++ and friends name a *file* instead
 * (`'../store/codeStore'`, `.pkg.mod`, `"util.h"`) — a string no symbol is
 * ever called. Feeding those to the name ladder parked every import in
 * PendingRef forever, so on any non-Rust repo the DEPENDS_ON graph was empty
 * and `module_map` reported zero modules.
 *
 * This returns the ordered repo-relative paths a specifier could denote. The
 * caller only creates an edge on an exact hit against an already-indexed file
 * path, so an over-generous candidate list costs map lookups, never a wrong
 * edge — which is why bare specifiers get probed too (`esbuild` is a package
 * here, but `util` next to the importer is a real sibling module elsewhere).
 */

/** Extensions a candidate without one may be wearing. Ordered: the likeliest first. */
const SOURCE_EXTS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.dart', '.java',
  '.h', '.hpp', '.hh', '.c', '.cc', '.cpp', '.cxx',
  '.css', '.scss', '.html',
] as const;

/**
 * TS emits ESM specifiers pointing at the *compiled* name: `./x.js` on disk is
 * `./x.ts`. Probe the source extensions before the literal one.
 */
const EXT_REWRITE: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

/** Directory entry points: `./util` may be `util/index.ts` or `util/__init__.py`. */
const INDEX_STEMS = ['index', '__init__'] as const;

const EXT_SET = new Set<string>(SOURCE_EXTS);

function extensionOf(p: string): string | null {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot <= slash + 1) return null; // no dot, or a dotfile like `.env`
  const ext = p.slice(dot);
  return EXT_SET.has(ext) ? ext : null;
}

/** Repo-relative, `.`/`..` collapsed. Leading `/` is dropped: paths are repo-relative. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

function joinPath(dir: string, rel: string): string {
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

/** The importing file's directory ('' for a repo-root file). */
function parentDir(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? '' : file.slice(0, i);
}

/** `a/b/c` → ['a/b/c', 'a/b', 'a', ''] — prefix roots to try for absolute dotted imports. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    out.push(cur);
    if (cur === '') break;
    cur = parentDir(cur);
  }
  return out;
}

/** Every file a `base` (extension-less or not) could be. */
function expandBase(base: string, out: string[]): void {
  if (base === '' || base.startsWith('..')) return; // escaped the repo root
  const ext = extensionOf(base);
  if (ext) {
    const stem = base.slice(0, -ext.length);
    for (const e of EXT_REWRITE[ext] ?? [ext]) out.push(stem + e);
    return;
  }
  for (const e of SOURCE_EXTS) out.push(base + e);
  for (const stem of INDEX_STEMS) for (const e of SOURCE_EXTS) out.push(`${base}/${stem}${e}`);
}

/** A dotted module path (`pkg.mod`, `.sibling`, `..parent.mod`) rather than a file path. */
function isDotted(spec: string): boolean {
  return !spec.includes('/') && /^\.*[A-Za-z_][\w.]*$/.test(spec) && extensionOf(spec) === null;
}

/**
 * True when `specifier` can only name a module OUTSIDE the workspace: a
 * runtime builtin (`node:fs`) or a bare package name (`vitest`, `zod`).
 *
 * Deliberately decided on the specifier's SHAPE, not on whether the target
 * resolves to an indexed file: indexing is per-file and order-dependent, so a
 * relative import whose target simply hasn't been indexed yet would look
 * "unresolvable" and be misclassified as external. That mistake suppressed the
 * real `app/main.ts → lib/util.ts` CALLS edge.
 *
 * A relative (`./x`, `../x`) or rooted (`src/x`) specifier is therefore never
 * external, whether or not its target exists yet. Only `::` paths (Rust, whose
 * crate-external `use`s the name ladder handles) and dotted Python module
 * paths are left alone, since neither shape distinguishes local from external.
 */
export function isExternalSpecifier(specifier: string): boolean {
  const spec = specifier.trim().replace(/^["'<]+/, '').replace(/[">']+$/, '');
  if (spec === '' || spec.includes('::')) return false;
  if (spec.startsWith('node:')) return true;
  // Relative or rooted path → a workspace file by construction.
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (spec.includes('/')) {
    // `vitest/config`, `@scope/pkg` are packages; `src/core/x` is in-repo.
    // A leading `@` scope or a first segment with no path-like meaning is a
    // package; anything else is treated as in-repo and left to resolve.
    return spec.startsWith('@');
  }
  // A single bare segment with no separator and no extension: a package name.
  return extensionOf(spec) === null;
}

/**
 * Repo-relative paths `specifier`, written in `fromPath`, could refer to —
 * best guess first. Empty when the specifier is not a file reference at all
 * (Rust `use` paths, which the name ladder resolves instead).
 */
export function importCandidatePaths(fromPath: string, specifier: string): string[] {
  // C/C++ `#include` captures keep their delimiters; so can Dart/CSS uri nodes.
  const spec = specifier.trim().replace(/^["'<]+/, '').replace(/[">']+$/, '');
  if (spec === '' || spec.includes('::')) return [];
  if (spec.startsWith('node:')) return []; // builtin, never a workspace file

  const dir = parentDir(fromPath);
  const out: string[] = [];

  if (isDotted(spec)) {
    const leading = spec.length - spec.replace(/^\.+/, '').length;
    const rest = spec.slice(leading).split('.').join('/');
    if (leading > 0) {
      // Python relative import: one dot = this package, each extra = one level up.
      const up = '../'.repeat(leading - 1);
      expandBase(joinPath(dir, up + rest), out);
    } else {
      // Absolute dotted: the package root may be the repo root or any ancestor
      // of the importer (src-layout, monorepo package dirs).
      for (const root of ancestors(dir)) expandBase(joinPath(root, rest), out);
    }
  } else if (spec.startsWith('.')) {
    expandBase(joinPath(dir, spec), out);
  } else {
    // Absolute-ish or bare. `/x` and bare specifiers are probed from the repo
    // root; bare ones are also probed as a sibling file, which is what
    // `#include "util.h"` and Ruby's require_relative mean.
    expandBase(normalizePath(spec), out);
    expandBase(joinPath(dir, spec), out);
  }

  return [...new Set(out)];
}

/** True when the specifier points inside the workspace, so a miss is worth retrying later. */
function isWorkspaceRelative(specifier: string): boolean {
  const spec = specifier.trim().replace(/^["'<]+/, '').replace(/[">']+$/, '');
  return spec.startsWith('.') || spec.startsWith('/');
}
