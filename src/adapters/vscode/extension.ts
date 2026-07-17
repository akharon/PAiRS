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
import { nodeListWorkspaceFiles, nodeReadFile } from '../../core/indexer/nodeFsDeps';
import { KuzuCodeStore } from '../../store/graph/codeStoreImpl';
import { nodeKuzuDriver } from '../../store/graph/kuzuDriver';
import type { CodeStore } from '../../store/graph/codeStore';
import type { Indexer } from '../../core/indexer/codeIndexer';

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return; // no workspace → nothing to index

  const ws = await openWorkspace(folder.uri.fsPath, context.extensionPath);
  context.subscriptions.push({ dispose: () => ws.store.dispose() });
  context.subscriptions.push({ dispose: () => ws.parsers.dispose() });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'gizem.reindex';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(registerMcpProvider(context.extensionPath));
  context.subscriptions.push(
    vscode.commands.registerCommand('gizem.reindex', () => reindex(ws)),
    vscode.commands.registerCommand('gizem.findSymbol', () => findSymbol(ws))
  );

  // Index on activation so the graph is fresh for the MCP server the moment a
  // client connects; do it in the background so activation isn't blocked.
  void reindex(ws);
}

export function deactivate(): void {
  // Stores intentionally not closed here (kuzu segfaults on close; dispose() is
  // a no-op) — subscriptions handle disposal of parsers/status bar.
}
