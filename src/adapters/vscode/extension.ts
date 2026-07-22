/**
 * VS Code extension shell (plan.md 1.6). The ONLY file permitted to import
 * `vscode` (R10 — enforced by eslint no-restricted-imports); everything it
 * touches below the adapter boundary is the same editor-agnostic core the CLI
 * and MCP server use, so the extension host and headless surfaces share one
 * store and one indexer.
 *
 * On activation it: opens the workspace's `.gizem/index` Kuzu store, indexes
 * the workspace, registers an MCP stdio server definition pointing at the
 * bundled `dist/mcp-server.js` (Copilot agent mode / any MCP client picks it up
 * against the SAME db), shows a status bar (index freshness + fuzzyRate), and
 * registers `gizem.reindex` / `gizem.findSymbol` commands.
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

interface Workspace {
  root: string;
  store: CodeStore;
  indexer: Indexer;
  parsers: ParserRegistryImpl;
}

let statusBar: vscode.StatusBarItem | undefined;

async function openWorkspace(root: string, extensionPath: string): Promise<Workspace> {
  const dbPath = path.join(root, '.gizem', 'index');
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
    statusBar.text = `$(symbol-structure) gizem ${stats.symbols} sym · ${pct}% fuzzy`;
    statusBar.tooltip = `GIZEM code index\n${stats.files} files · ${stats.symbols} symbols · ${stats.edges} edges\nfuzzyRate ${pct}% · resolvableMisses ${stats.resolvableMisses}`;
  } catch (err) {
    statusBar.text = '$(warning) gizem: not indexed';
    statusBar.tooltip = String((err as Error).message);
  }
  statusBar.show();
}

async function reindex(ws: Workspace): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GIZEM: indexing workspace…' },
    async () => {
      await ws.indexer.fullIndex(ws.root);
    }
  );
  await refreshStatus(ws);
}

/** MCP stdio provider: one server per folder, against that folder's .gizem db. */
function registerMcpProvider(extensionPath: string): vscode.Disposable {
  const provider: vscode.McpServerDefinitionProvider = {
    provideMcpServerDefinitions: () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const disabled = vscode.workspace.getConfiguration('gizem').get<string[]>('disabledTools', []);
      const disabledArgs = disabled.length ? ['--disabled-tools', disabled.join(',')] : [];
      const serverScript = path.join(extensionPath, 'dist', 'mcp-server.js');
      return folders.map((folder) => {
        const dbPath = path.join(folder.uri.fsPath, '.gizem', 'index');
        return new vscode.McpStdioServerDefinition(
          `GIZEM (${folder.name})`,
          process.execPath,
          [serverScript, '--db', dbPath, ...disabledArgs]
        );
      });
    },
  };
  return vscode.lm.registerMcpServerDefinitionProvider('gizem.mcpProvider', provider);
}

/** Quick-pick symbol search over the store's lookup(). */
async function findSymbol(ws: Workspace): Promise<void> {
  const name = await vscode.window.showInputBox({ prompt: 'GIZEM: find symbol by name (bare or qualified)' });
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
  const rulesPath = path.join(ws.root, '.gizem', 'rules.ron');
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
    d.source = 'gizem';
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
  statusBar.command = 'gizem.reindex';
  context.subscriptions.push(statusBar);

  const diagnostics = vscode.languages.createDiagnosticCollection('gizem');
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(registerMcpProvider(context.extensionPath));
  context.subscriptions.push(
    vscode.commands.registerCommand('gizem.reindex', () => reindex(ws).then(() => refreshDiagnostics(ws, diagnostics))),
    vscode.commands.registerCommand('gizem.findSymbol', () => findSymbol(ws)),
    vscode.commands.registerCommand('gizem.checkRules', () => refreshDiagnostics(ws, diagnostics)),
    vscode.commands.registerCommand('gizem.moduleMap', async () => {
      // Read-only module-graph webview (plan.md 3.5): Louvain subsystems as
      // columns, drift edges red. Self-contained HTML — webview CSP-safe.
      const map = await moduleMap(ws.store);
      const panel = vscode.window.createWebviewPanel('gizemModuleMap', 'GIZEM Module Map', vscode.ViewColumn.Active, { enableScripts: false });
      panel.webview.html = moduleMapHtml(map);
    })
  );

  // Re-check rules when rules.ron is edited (diagnostics follow the config live).
  const rulesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '.gizem/rules.ron')
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

  // Index on activation so the graph is fresh for the MCP server the moment a
  // client connects; do it in the background so activation isn't blocked. Rule
  // diagnostics follow once the graph exists.
  void reindex(ws).then(() => refreshDiagnostics(ws, diagnostics));
}

export function deactivate(): void {
  // Stores intentionally not closed here (kuzu segfaults on close; dispose() is
  // a no-op) — subscriptions handle disposal of parsers/status bar.
}
