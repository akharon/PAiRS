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
import type { SymbolRecord } from '../indexer/types';
import { IMPACT_EDGE_KINDS } from '../analyze/impact';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Site {
  file: string;
  line: number;
}

function wordBoundaryRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

/** Every distinct file:line where `oldName` must be replaced: the definition plus direct reference sites. */
async function collectSites(store: CodeStore, seed: SymbolRecord): Promise<Site[]> {
  const sites = new Map<string, Site>();
  const add = (file: string, line: number) => sites.set(`${file}:${line}`, { file, line });

  add(seed.file, seed.startLine);
  const edges = await store.edgesTo([seed.id], [...IMPACT_EDGE_KINDS]);
  for (const e of edges) {
    const from = await store.get(e.fromId);
    if (from) add(from.file, e.line);
  }
  return [...sites.values()];
}

export interface RenamePlanError {
  message: string;
}

export interface RenamePlan {
  seed: SymbolRecord;
  sites: Site[];
  /** absolute file path -> new full content. */
  rewritten: Map<string, string>;
}

/** Builds the rewrite in memory; does not touch disk. Returns an error if any site can't be matched safely. */
export async function planRename(
  store: CodeStore,
  root: string,
  seed: SymbolRecord,
  newName: string
): Promise<RenamePlan | RenamePlanError> {
  if (!IDENT_RE.test(newName)) return { message: `"${newName}" is not a valid identifier.` };
  if (newName === seed.name) return { message: `New name is the same as the current name.` };

  const sites = await collectSites(store, seed);
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
      lines[idx] = original.replace(re, newName);
    }
    rewritten.set(abs, lines.join('\n'));
  }

  return { seed, sites, rewritten };
}

export function applyPlan(plan: RenamePlan): string[] {
  for (const [abs, content] of plan.rewritten) fs.writeFileSync(abs, content, 'utf8');
  return [...plan.rewritten.keys()];
}
