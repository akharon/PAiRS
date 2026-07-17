/**
 * In-place deletion of unreferenced-symbol candidates found by "Find
 * Unreferenced Code": builds a WorkspaceEdit over each symbol's indexed line
 * range, guarding against a stale index (file edited/moved since the symbol
 * was recorded) by verifying the symbol's name still appears at the recorded
 * location before deleting.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { CodeResultNode } from './codeResults';
import type { CodeResultsProvider } from './codeResults';
import type { SymbolRecord } from '../index/types';

export interface DeadCodeDeleteDeps {
  workspaceRoot: string;
  resultsProvider: CodeResultsProvider;
  codeView: vscode.TreeView<CodeResultNode>;
}

function uniqueSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const seen = new Map<number, SymbolRecord>();
  for (const s of symbols) seen.set(s.id, s);
  return Array.from(seen.values());
}

/** Drops symbols whose range is nested inside another selected symbol's range in the
 * same file (e.g. a dead method inside a dead class) so the WorkspaceEdit has no
 * overlapping deletes. */
function dedupeContained(symbols: SymbolRecord[]): SymbolRecord[] {
  return symbols.filter((s) => {
    return !symbols.some(
      (other) =>
        other !== s &&
        other.file === s.file &&
        other.startLine <= s.startLine &&
        other.endLine >= s.endLine &&
        (other.startLine !== s.startLine || other.endLine !== s.endLine)
    );
  });
}

interface Verified {
  symbol: SymbolRecord;
  doc: vscode.TextDocument;
}

async function verifySymbols(
  workspaceRoot: string,
  symbols: SymbolRecord[]
): Promise<{ verified: Verified[]; skipped: SymbolRecord[] }> {
  const verified: Verified[] = [];
  const skipped: SymbolRecord[] = [];
  const nameRe = (name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

  for (const s of symbols) {
    try {
      const uri = vscode.Uri.file(path.join(workspaceRoot, s.file));
      const doc = await vscode.workspace.openTextDocument(uri);
      if (s.endLine > doc.lineCount) {
        skipped.push(s);
        continue;
      }
      const headEnd = Math.min(s.startLine + 1, doc.lineCount);
      const head = doc.getText(new vscode.Range(s.startLine - 1, 0, headEnd - 1, doc.lineAt(headEnd - 1).text.length));
      if (!nameRe(s.name).test(head)) {
        skipped.push(s);
        continue;
      }
      verified.push({ symbol: s, doc });
    } catch {
      skipped.push(s);
    }
  }
  return { verified, skipped };
}

function deletionRange(doc: vscode.TextDocument, s: SymbolRecord): vscode.Range {
  const startLine = s.startLine - 1;
  const endLineExclusive = s.endLine; // 0-based, exclusive of this line's content, includes its newline
  if (s.endLine >= doc.lineCount) {
    // Last line of the file: no trailing newline to consume; also eat the
    // newline that precedes this symbol (if any) to avoid a blank tail line.
    const from = startLine > 0 ? new vscode.Position(startLine - 1, doc.lineAt(startLine - 1).text.length) : new vscode.Position(startLine, 0);
    const to = new vscode.Position(s.endLine - 1, doc.lineAt(s.endLine - 1).text.length);
    return new vscode.Range(from, to);
  }
  return new vscode.Range(startLine, 0, endLineExclusive, 0);
}

function quickPickLabel(s: SymbolRecord): string {
  return `$(${'symbol-' + (s.kind === 'method' ? 'method' : 'function')}) ${s.name}`;
}

async function confirmDeletion(symbols: SymbolRecord[]): Promise<SymbolRecord[]> {
  if (symbols.length === 1) {
    const [s] = symbols;
    if (!s) return [];
    const choice = await vscode.window.showWarningMessage(
      `Delete "${s.name}" — ${s.file}:${s.startLine}-${s.endLine}?`,
      { modal: true, detail: s.signature ?? s.qualified },
      'Delete'
    );
    return choice === 'Delete' ? symbols : [];
  }
  const picks = symbols.map((s) => ({
    label: quickPickLabel(s),
    description: `${s.file}:${s.startLine}–${s.endLine}`,
    detail: s.signature ?? s.qualified,
    picked: true,
    symbol: s,
  }));
  const picked = await vscode.window.showQuickPick(picks, {
    title: `Delete ${symbols.length} unreferenced symbols`,
    canPickMany: true,
    placeHolder: 'Select symbols to delete (all pre-selected)',
  });
  return (picked ?? []).map((p) => p.symbol);
}

export async function deleteDeadCodeSymbols(deps: DeadCodeDeleteDeps, requested: SymbolRecord[]): Promise<void> {
  const candidates = dedupeContained(uniqueSymbols(requested));
  if (!candidates.length) return;

  const { verified, skipped } = await verifySymbols(deps.workspaceRoot, candidates);
  if (!verified.length) {
    if (skipped.length) {
      vscode.window.showWarningMessage(
        `Skipped ${skipped.length} symbol(s) — file changed since indexing. Re-run Find Unreferenced Code.`
      );
    }
    return;
  }

  const confirmed = await confirmDeletion(verified.map((v) => v.symbol));
  if (!confirmed.length) return;
  const confirmedIds = new Set(confirmed.map((s) => s.id));
  const toApply = verified.filter((v) => confirmedIds.has(v.symbol.id));

  const edit = new vscode.WorkspaceEdit();
  for (const { symbol, doc } of toApply) {
    edit.delete(doc.uri, deletionRange(doc, symbol));
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('Failed to apply the deletion edit.');
    return;
  }

  deps.resultsProvider.removeSymbols(toApply.map((v) => v.symbol.id));

  const fileCount = new Set(toApply.map((v) => v.symbol.file)).size;
  const parts = [`Applied ${toApply.length} deletion(s) across ${fileCount} file(s) (unsaved — review and save, or undo).`];
  if (skipped.length) {
    parts.push(`Skipped ${skipped.length} — file changed since indexing.`);
  }
  vscode.window.showInformationMessage(parts.join(' '));
}
