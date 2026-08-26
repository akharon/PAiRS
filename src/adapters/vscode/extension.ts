/**
 * VS Code extension shell. The ONLY file permitted to import
 * `vscode` (R10 — enforced by eslint no-restricted-imports); everything it
 * touches below the adapter boundary is the same editor-agnostic core the CLI
 * uses, so the extension host and headless CLI share one store and indexer.
 *
 * On activation it: opens the workspace's `.pairs/index.db` SQLite store, indexes
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
// Synchronous counterpart for the preview reader: ExecutorDeps.readSource
// returns `string | null`, not a Promise. The extension runs in the node
// host, so node fs is available and vscode.workspace.fs (async-only) would
// force needless plumbing for a three-line excerpt.
import * as fsSync from 'node:fs';
import * as vscode from 'vscode';
import { ParserRegistryImpl, fileQuerySource } from '../../core/indexer/parserRegistryImpl';
import { ExtractorImpl } from '../../core/indexer/extractorImpl';
import { IndexerImpl } from '../../core/indexer/codeIndexerImpl';
import { isSkippedPath, nodeListWorkspaceFiles, nodeReadFile } from '../../core/indexer/nodeFsDeps';
import { langForPath } from '../../core/indexer/parserRegistry';
import { WatchQueue } from '../../core/indexer/watchQueue';
import { SqliteCodeStore } from '../../store/graph/sqliteCodeStore';
import { nodeSqlDriver } from '../../store/graph/sqliteDriver';
import type { CodeStore } from '../../store/graph/codeStore';
import type { Indexer } from '../../core/indexer/codeIndexer';
import { moduleMap } from '../../core/analyze/moduleMap';
import { moduleMapHtml } from '../../core/analyze/moduleMapHtml';
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
  const dbPath = path.join(root, '.pairs', 'index.db');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  // Bundled next to dist/extension.js by scripts/fetch-grammars.mjs.
  const grammarsDir = path.join(extensionPath, 'dist', 'grammars');
  const queriesDir = path.join(extensionPath, 'dist', 'queries');
  const store = await SqliteCodeStore.open(dbPath, nodeSqlDriver);
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
 * `pairs.rebuildIndex`: a plain reindex short-circuits unchanged files (mtime/
 * size/hash) and often writes nothing at all, so it can't recover from a
 * corrupted or stale-shaped store. This drops every table and reparses the
 * whole workspace from scratch.
 */
async function rebuildIndex(ws: Workspace): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'PAiRS: rebuilding index…' },
    async () => {
      await ws.store.reset();
      await ws.indexer.fullIndex(ws.root);
    }
  );
  await refreshStatus(ws);
}

/**
 * In-process Language Model Tools for Copilot agent mode,
 * registered via vscode.lm.registerTool against the extension's already-open
 * store. Names/schemas
 * come from package.json's languageModelTools block, generated from
 * core/tools/tools.ts by scripts/sync-lm-tools.mjs.
 */
/** Upper bound on a file read for a preview excerpt — see the CLI's twin. */
const MAX_PREVIEW_READ_BYTES = 1024 * 1024;

function registerLmTools(ws: Workspace): vscode.Disposable[] {
  /**
   * Preview reader for find_symbol/get_symbol. Size-capped so a generated or
   * minified file can't cost megabytes to produce a three-line excerpt, and
   * null on any failure — a preview is an optimisation and must never be a
   * reason for the tool itself to fail.
   */
  const readSource = (rel: string): string | null => {
    try {
      const abs = path.join(ws.root, rel);
      if (fsSync.statSync(abs).size > MAX_PREVIEW_READ_BYTES) return null;
      return fsSync.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  const executors = createExecutors({ store: ws.store, root: ws.root, readSource });
  const disabled = new Set(vscode.workspace.getConfiguration('pairs').get<string[]>('disabledTools', []));
  const disposables: vscode.Disposable[] = [];
  for (const [name, schema] of Object.entries(codeToolSchemas)) {
    if (disabled.has(name)) continue;
    const toolName = name as CodeToolName;
    disposables.push(
      vscode.lm.registerTool(`pairs_${name}`, {
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return; // no workspace → nothing to index

  const ws = await openWorkspace(folder.uri.fsPath, context.extensionPath);
  context.subscriptions.push({
    // Merge the WAL, then close. Best-effort — the process may already be
    // exiting.
    dispose: () => void ws.store.checkpoint().finally(() => ws.store.dispose()),
  });
  context.subscriptions.push({ dispose: () => ws.parsers.dispose() });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'pairs.reindex';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('pairs.reindex', () => reindex(ws)),
    vscode.commands.registerCommand('pairs.rebuildIndex', () => rebuildIndex(ws)),
    vscode.commands.registerCommand('pairs.findSymbol', () => findSymbol(ws)),
    vscode.commands.registerCommand('pairs.moduleMap', async () => {
      // Read-only module-graph webview: Louvain subsystems as
      // columns ordered by dependency layer, drift edges red, cycle edges
      // amber. Self-contained HTML, inline script only (CSP forbids remote
      // scripts) — the script filters/focuses/pans the view and asks the
      // extension to reveal a module (Enter or double-click on a node), it
      // never mutates the graph.
      const map = await moduleMap(ws.store);
      const panel = vscode.window.createWebviewPanel('pairsModuleMap', 'PAiRS Module Map', vscode.ViewColumn.Active, { enableScripts: true });
      panel.webview.html = moduleMapHtml(map);
      panel.webview.onDidReceiveMessage(async (msg: { type?: string; module?: string }) => {
        if (msg?.type !== 'reveal' || !msg.module) return;
        const uri = vscode.Uri.file(path.join(ws.root, msg.module));
        try {
          await vscode.commands.executeCommand('revealInExplorer', uri);
        } catch {
          // Module path may not exist as-is (e.g. depth-collapsed key) — ignore.
        }
      });
    })
  );

  // After commands: a tool-registration failure must not take the palette
  // commands down with it (0.4.0 shipped exactly that failure mode).
  context.subscriptions.push(...registerLmTools(ws));

  // Incremental loop: source saves/creates/deletes flow through
  // the debounced WatchQueue into indexFile/removeFile (both serialized on the
  // indexer's opChain), then the status bar refreshes — it tracks the code
  // without a manual reindex.
  const queue = new WatchQueue({
    indexFile: (p) => ws.indexer.indexFile(p),
    removeFile: (p) => ws.indexer.removeFile(p),
    onFlushed: async () => {
      await ws.store.checkpoint();
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
  // call needs it; do it in the background so activation isn't blocked.
  void reindex(ws);

  void writeSkillFiles(ws.root);
}

export function deactivate(): void {
  // Subscriptions handle disposal of the store, parsers and status bar.
}
