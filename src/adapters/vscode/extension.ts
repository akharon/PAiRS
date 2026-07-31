/**
 * VS Code extension shell (plan.md 1.6). The ONLY file permitted to import
 * `vscode` (R10 — enforced by eslint no-restricted-imports); everything it
 * touches below the adapter boundary is the same editor-agnostic core the CLI
 * uses, so the extension host and headless CLI share one store and indexer.
 *
 * On activation it: opens the workspace's `.pairs/index` Kuzu store, indexes
 * the workspace, registers the code tools as VS Code Language Model Tools
 * (Copilot agent mode calls them in-process against the open store), writes
 * Claude Code skill files into the workspace so Claude drives the `pairs` CLI
 * directly, shows a status bar (index freshness + fuzzyRate), and registers
 * `pairs.reindex` / `pairs.findSymbol` commands.
 *
 * Trimmed from vendor/reference-indexer/src/integration/*: no memory tools, no
 * chat participant, no embeddings — code graph only.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { ParserRegistryImpl, fileQuerySource } from '../../core/indexer/parserRegistryImpl';
import { ExtractorImpl } from '../../core/indexer/extractorImpl';
import { IndexerImpl } from '../../core/indexer/codeIndexerImpl';
import { isSkippedPath, nodeListWorkspaceFiles, nodeReadFile } from '../../core/indexer/nodeFsDeps';
import { langForPath } from '../../core/indexer/parserRegistry';
import { WatchQueue } from '../../core/indexer/watchQueue';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import type { CodeStore } from '../../store/graph/codeStore';
import type { Indexer } from '../../core/indexer/codeIndexer';
import { moduleMap } from '../../core/analyze/moduleMap';
import { moduleMapHtml } from '../../core/analyze/moduleMapHtml';
import { parseRuleSet } from '../../core/rules/config';
import { checkRules } from '../../core/rules/evaluate';
import type { Violation } from '../../core/rules/types';
import { createExecutors } from '../../core/tools/executors';
import { codeToolSchemas } from '../../core/tools/tools';
import type { CodeToolInput, CodeToolName } from '../../core/tools/tools';
import { writeSkillFiles } from './skills';

interface Workspace {
  root: string;
  store: CodeStore;
  indexer: Indexer;
  parsers: ParserRegistryImpl;
}

let statusBar: vscode.StatusBarItem | undefined;

async function openWorkspace(root: string, extensionPath: string): Promise<Workspace> {
  const dbPath = path.join(root, '.pairs', 'index');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  // Bundled next to dist/extension.js by scripts/fetch-grammars.mjs.
  const grammarsDir = path.join(extensionPath, 'dist', 'grammars');
  const queriesDir = path.join(extensionPath, 'dist', 'queries');
  const store = await KuzuCodeStore.open(dbPath, nodeKuzuDriver);
  const parsers = new ParserRegistryImpl(grammarsDir, fileQuerySource(queriesDir));
  const indexer = new IndexerImpl({
    store,
    parsers,
    extractor: new ExtractorImpl(),
    listWorkspaceFiles: nodeListWorkspaceFiles(root),
    readFile: nodeReadFile(root),
  });
  return { root, store, indexer, parsers };
}

async function refreshStatus(ws: Workspace): Promise<void> {
  if (!statusBar) return;
  try {
    const stats = await ws.indexer.stats();
    const pct = (stats.fuzzyRate * 100).toFixed(0);
    statusBar.text = `$(symbol-structure) pairs ${stats.symbols} sym · ${pct}% fuzzy`;
    statusBar.tooltip = `PAiRS code index\n${stats.files} files · ${stats.symbols} symbols · ${stats.edges} edges\nfuzzyRate ${pct}% · resolvableMisses ${stats.resolvableMisses}`;
  } catch (err) {
    statusBar.text = '$(warning) pairs: not indexed';
    statusBar.tooltip = String((err as Error).message);
  }
  statusBar.show();
}

async function reindex(ws: Workspace): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'PAiRS: indexing workspace…' },
    async () => {
      await ws.indexer.fullIndex(ws.root);
    }
  );
  await refreshStatus(ws);
}

/**
 * In-process Language Model Tools (plan.md 1.6) for Copilot agent mode,
 * registered via vscode.lm.registerTool against the extension's already-open
 * store — Kuzu is single-process (one lock holder, even for read-only opens),
 * so a separately spawned process could never share the db. Names/schemas
 * come from package.json's languageModelTools block, generated from
 * core/tools/tools.ts by scripts/sync-lm-tools.mjs.
 */
function registerLmTools(ws: Workspace): vscode.Disposable[] {
  const executors = createExecutors({ store: ws.store, rulesPath: path.join(ws.root, '.pairs', 'rules.ron'), root: ws.root });
  const disabled = new Set(vscode.workspace.getConfiguration('pairs').get<string[]>('disabledTools', []));
  const disposables: vscode.Disposable[] = [];
  for (const [name, schema] of Object.entries(codeToolSchemas)) {
    if (disabled.has(name)) continue;
    const toolName = name as CodeToolName;
    disposables.push(
      vscode.lm.registerTool(`gizem_${name}`, {
        invoke: async (options) => {
          try {
            const input = schema.input.parse(options.input) as CodeToolInput<CodeToolName>;
            const exec = executors[toolName] as (i: CodeToolInput<CodeToolName>) => Promise<string>;
            const text = await exec(input);
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
          } catch (err) {
            return new vscode.LanguageModelToolResult([
              new vscode.LanguageModelTextPart(`Error: ${(err as Error).message}`),
            ]);
          }
        },
      })
    );
  }
  return disposables;
}

/** Quick-pick symbol search over the store's lookup(). */
async function findSymbol(ws: Workspace): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'PAiRS: find symbol by name (bare or qualified)' });
  if (!name) return;
  const hit = await ws.store.lookup(name);
  const syms = Array.isArray(hit) ? hit : hit.candidates;
  if (syms.length === 0) {
    void vscode.window.showInformationMessage(`No symbol named "${name}".`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    syms.map((s) => ({ label: s.qualified || s.name, description: `${s.kind}  ${s.file}:${s.startLine}`, sym: s })),
    { placeHolder: `${syms.length} match(es) for "${name}"` }
  );
  if (!pick) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws.root, pick.sym.file)));
  const editor = await vscode.window.showTextDocument(doc);
  const line = Math.max(0, pick.sym.startLine - 1);
  editor.selection = new vscode.Selection(line, 0, line, 0);
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
}

/**
 * Inline diagnostics (plan.md 2.9, spec §7): violations from the rule engine
 * rendered as squiggles. `confirmed` maps to the rule's severity, `possible`
 * to Hint — visible in the hover, never alarming (R1). Read-only: no code
 * actions that mutate source.
 */
async function refreshDiagnostics(ws: Workspace, collection: vscode.DiagnosticCollection): Promise<void> {
  const rulesPath = path.join(ws.root, '.pairs', 'rules.ron');
  let src: string;
  try {
    src = await fs.readFile(rulesPath, 'utf8');
  } catch {
    collection.clear(); // no ruleset — no diagnostics
    return;
  }
  let violations: Violation[];
  try {
    const ruleset = parseRuleSet(src);
    ({ violations } = await checkRules(ws.store, ruleset));
  } catch (err) {
    // Bad rules.ron: surface the parse error on the config file itself.
    collection.clear();
    collection.set(vscode.Uri.file(rulesPath), [
      new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), String((err as Error).message), vscode.DiagnosticSeverity.Error),
    ]);
    return;
  }
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const v of violations) {
    const n = v.nodes[0];
    if (!n) continue;
    const line = Math.max(0, n.line - 1);
    const severity =
      v.confidence === 'possible'
        ? vscode.DiagnosticSeverity.Hint
        : v.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;
    const d = new vscode.Diagnostic(
      new vscode.Range(line, 0, line, 200),
      `${v.explanation}${v.suggestion ? ` — ${v.suggestion}` : ''}`,
      severity
    );
    d.source = 'pairs';
    d.code = v.rule;
    d.relatedInformation = v.nodes.slice(1).map(
      (r) =>
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(path.join(ws.root, r.file)), new vscode.Range(Math.max(0, r.line - 1), 0, Math.max(0, r.line - 1), 1)),
          r.qualified
        )
    );
    const key = n.file;
    (byFile.get(key) ?? byFile.set(key, []).get(key)!).push(d);
  }
  collection.clear();
  for (const [file, diags] of byFile) collection.set(vscode.Uri.file(path.join(ws.root, file)), diags);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return; // no workspace → nothing to index

  const ws = await openWorkspace(folder.uri.fsPath, context.extensionPath);
  context.subscriptions.push({ dispose: () => ws.store.dispose() });
  context.subscriptions.push({ dispose: () => ws.parsers.dispose() });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'pairs.reindex';
  context.subscriptions.push(statusBar);

  const diagnostics = vscode.languages.createDiagnosticCollection('pairs');
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('pairs.reindex', () => reindex(ws).then(() => refreshDiagnostics(ws, diagnostics))),
    vscode.commands.registerCommand('pairs.findSymbol', () => findSymbol(ws)),
    vscode.commands.registerCommand('pairs.checkRules', () => refreshDiagnostics(ws, diagnostics)),
    vscode.commands.registerCommand('pairs.moduleMap', async () => {
      // Read-only module-graph webview (plan.md 3.5): Louvain subsystems as
      // columns, drift edges red. Self-contained HTML — webview CSP-safe.
      const map = await moduleMap(ws.store);
      const panel = vscode.window.createWebviewPanel('gizemModuleMap', 'PAiRS Module Map', vscode.ViewColumn.Active, { enableScripts: false });
      panel.webview.html = moduleMapHtml(map);
    })
  );

  // After commands: a tool-registration failure must not take the palette
  // commands down with it (0.4.0 shipped exactly that failure mode).
  context.subscriptions.push(...registerLmTools(ws));

  // Re-check rules when rules.ron is edited (diagnostics follow the config live).
  const rulesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '.pairs/rules.ron')
  );
  const recheck = (): void => void refreshDiagnostics(ws, diagnostics);
  rulesWatcher.onDidChange(recheck);
  rulesWatcher.onDidCreate(recheck);
  rulesWatcher.onDidDelete(recheck);
  context.subscriptions.push(rulesWatcher);

  // Incremental loop (plan.md 3.1): source saves/creates/deletes flow through
  // the debounced WatchQueue into indexFile/removeFile (both serialized on the
  // indexer's opChain), then rules re-evaluate and the status bar refreshes —
  // squiggles track the code without a manual reindex.
  const queue = new WatchQueue({
    indexFile: (p) => ws.indexer.indexFile(p),
    removeFile: (p) => ws.indexer.removeFile(p),
    onFlushed: async () => {
      await refreshDiagnostics(ws, diagnostics);
      await refreshStatus(ws);
    },
  });
  context.subscriptions.push({ dispose: () => queue.dispose() });
  const srcWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
  const rel = (uri: vscode.Uri): string | null => {
    const r = path.relative(ws.root, uri.fsPath).split(path.sep).join('/');
    return !r.startsWith('..') && !isSkippedPath(r) && langForPath(r) ? r : null;
  };
  srcWatcher.onDidChange((u) => { const r = rel(u); if (r) queue.changed(r); });
  srcWatcher.onDidCreate((u) => { const r = rel(u); if (r) queue.changed(r); });
  srcWatcher.onDidDelete((u) => { const r = rel(u); if (r) queue.deleted(r); });
  context.subscriptions.push(srcWatcher);

  // Index on activation so the graph is fresh the moment Copilot or a CLI
  // call needs it; do it in the background so activation isn't blocked. Rule
  // diagnostics follow once the graph exists.
  void reindex(ws).then(() => refreshDiagnostics(ws, diagnostics));

  void writeSkillFiles(ws.root);
}

export function deactivate(): void {
  // Stores intentionally not closed here (kuzu segfaults on close; dispose() is
  // a no-op) — subscriptions handle disposal of parsers/status bar.
}
