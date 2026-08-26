/**
 * rename_symbol core logic.
 *
 * No column offsets survive into the store (SymbolRecord/EdgeRecord only carry
 * `line`), so a reference site is located by re-scanning its known line for the
 * old name at a word boundary. If any site doesn't match exactly once, the whole
 * rename aborts before touching any file — partial, inconsistent renames are
 * worse than no rename.
 *
 * Reference sites reuse the same edge kinds `impact` walks (IMPACT_EDGE_KINDS),
 * one hop only: renaming touches direct reference sites, not transitive callers.
 * No undo log is kept here — revert via the workspace's own VCS.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodeStore } from '../../store/graph/codeStore';
import type { AmbiguousSymbol, EdgeConfidence, SymbolRecord } from '../indexer/types';
import { IMPACT_EDGE_KINDS } from '../analyze/impact';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Site {
  file: string;
  line: number;
  /** 'resolved' for the definition site and verified refs; 'fuzzy' for name-only matches. */
  confidence: EdgeConfidence;
}

function wordBoundaryRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

/** Every distinct file:line where `oldName` must be replaced: the definition plus direct reference sites. */
async function collectSites(store: CodeStore, seed: SymbolRecord): Promise<Site[]> {
  const sites = new Map<string, Site>();
  const add = (file: string, line: number, confidence: EdgeConfidence) => {
    const key = `${file}:${line}`;
    const existing = sites.get(key);
    // A line reached by both a resolved and a fuzzy edge is resolved: the
    // verified reference is proof the name at this line is the seed.
    if (existing && existing.confidence === 'resolved') return;
    sites.set(key, { file, line, confidence });
  };

  add(seed.file, seed.startLine, 'resolved');
  const edges = await store.edgesTo([seed.id], [...IMPACT_EDGE_KINDS]);
  for (const e of edges) {
    const from = await store.get(e.fromId);
    if (from) add(from.file, e.line, e.confidence);
  }
  return [...sites.values()];
}

function isAmbiguous(x: SymbolRecord[] | AmbiguousSymbol): x is AmbiguousSymbol {
  return !Array.isArray(x) && x.ambiguous === true;
}

/**
 * Same-name symbols that the rename would land on top of, split by severity
 * because the two cases warrant opposite responses. A collision inside the
 * seed's own file or its own impl block produces a duplicate declaration or a
 * shadow, which is always wrong and which no undo log exists to recover from —
 * so that aborts. A same-named symbol in an unrelated module is normal in any
 * real codebase (every module has its own `parse`, `render`, `new`), so
 * aborting there would make the tool unusable; it is reported instead and the
 * caller judges.
 */
async function findCollisions(
  store: CodeStore,
  seed: SymbolRecord,
  newName: string
): Promise<{ blocking: SymbolRecord[]; elsewhere: SymbolRecord[] }> {
  const hit = await store.lookup(newName);
  const all = isAmbiguous(hit) ? hit.candidates : hit;
  const blocking: SymbolRecord[] = [];
  const elsewhere: SymbolRecord[] = [];
  for (const c of all) {
    if (c.id === seed.id) continue;
    if (c.file === seed.file || (seed.parentId !== null && c.parentId === seed.parentId)) blocking.push(c);
    else elsewhere.push(c);
  }
  return { blocking, elsewhere };
}

export interface RenamePlanError {
  message: string;
}

export interface RenamePlan {
  seed: SymbolRecord;
  sites: Site[];
  /** absolute file path -> new full content. */
  rewritten: Map<string, string>;
  /** Same-named symbols in OTHER files — legal, but worth reporting. */
  collisionsElsewhere: SymbolRecord[];
}

/** Builds the rewrite in memory; does not touch disk. Returns an error if any site can't be matched safely. */
export async function planRename(
  store: CodeStore,
  root: string,
  seed: SymbolRecord,
  newName: string,
  opts?: { includeFuzzy?: boolean }
): Promise<RenamePlan | RenamePlanError> {
  if (!IDENT_RE.test(newName)) return { message: `"${newName}" is not a valid identifier.` };
  if (newName === seed.name) return { message: `New name is the same as the current name.` };

  // Destination-name check, before any site collection: this is about the name
  // being renamed *to*, so includeFuzzy has no bearing on it.
  const collisions = await findCollisions(store, seed, newName);
  if (collisions.blocking.length > 0) {
    const listed = collisions.blocking
      .slice(0, 5)
      .map((c) => `  - ${c.qualified || c.name} [${c.kind}]  ${c.file}:${c.startLine}`)
      .join('\n');
    const more = collisions.blocking.length > 5 ? `\n  ... and ${collisions.blocking.length - 5} more` : '';
    return {
      message:
        `Aborted: "${newName}" is already declared in the same scope, which would collide ` +
        `with the renamed symbol:\n${listed}${more}\n` +
        `No files were modified. Pick a different name.`,
    };
  }

  const allSites = await collectSites(store, seed);
  const fuzzySites = allSites.filter((s) => s.confidence === 'fuzzy');

  // A fuzzy edge is a bare-name match, not a verified reference — it may well
  // point at an unrelated symbol that merely shares the name. Rewriting one
  // corrupts an unrelated file, and there is no undo log, so refuse by default
  // and make the caller opt in with full knowledge of the sites at risk.
  if (fuzzySites.length > 0 && opts?.includeFuzzy !== true) {
    const listed = fuzzySites
      .slice(0, 20)
      .map((s) => `  - ${s.file}:${s.line}`)
      .join('\n');
    const more = fuzzySites.length > 20 ? `\n  ... and ${fuzzySites.length - 20} more` : '';
    return {
      message:
        `Aborted: ${fuzzySites.length} of ${allSites.length} reference site(s) are fuzzy ` +
        `(matched by name only, not a verified reference) and may belong to an unrelated ` +
        `symbol with the same name:\n${listed}${more}\n` +
        `No files were modified. Re-run with includeFuzzy to rename these sites too.`,
    };
  }

  const sites = opts?.includeFuzzy === true ? allSites : allSites.filter((s) => s.confidence === 'resolved');

  const byFile = new Map<string, Site[]>();
  for (const s of sites) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }

  const re = wordBoundaryRegex(seed.name);
  const rewritten = new Map<string, string>();

  for (const [file, fileSites] of byFile) {
    const abs = path.join(root, file);
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return { message: `Cannot read ${file} (reference site at line ${fileSites[0]!.line}).` };
    }
    const lines = text.split('\n');
    for (const s of fileSites) {
      const idx = s.line - 1;
      const original = lines[idx];
      if (original === undefined) {
        return { message: `${file}:${s.line} — line no longer exists; re-index and retry.` };
      }
      const matches = original.match(re);
      if (!matches || matches.length === 0) {
        return { message: `${file}:${s.line} — "${seed.name}" not found at a word boundary; re-index and retry.` };
      }
      // `re` is global: every word-boundary occurrence on the line is the same
      // symbol, so rewriting all of them is correct — the schema's
      // Edge(src,dst,kind,line) key collapses same-line duplicates into one
      // site, and that one site stands for all occurrences on it.
      lines[idx] = original.replace(re, newName);
    }
    rewritten.set(abs, lines.join('\n'));
  }

  return { seed, sites, rewritten, collisionsElsewhere: collisions.elsewhere };
}

export function applyPlan(plan: RenamePlan): string[] {
  for (const [abs, content] of plan.rewritten) fs.writeFileSync(abs, content, 'utf8');
  return [...plan.rewritten.keys()];
}
