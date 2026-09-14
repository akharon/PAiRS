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
import { collectDiffHunks } from '../../platform/gitDiff';
import { codeToolSchemas } from '../../core/tools/tools';
import type { CodeToolInput, CodeToolName } from '../../core/tools/tools';
import { ensureCliLinked } from './cliLink';
import { writeSkillFiles } from './skills';

interface Workspace {
  root: string;
  /** The vscode.WorkspaceFolder's name — used to target this workspace from a
   * command's quick-pick and from a tool's `workspaceFolder` input. */
  name: string;
  store: CodeStore;
  indexer: Indexer;
  parsers: ParserRegistryImpl;
}

let statusBar: vscode.StatusBarItem | undefined;
// Module-level so reindex()/rebuildIndex() (which act on one Workspace) can
// still refresh the combined status bar without threading the full array
// through every call site — mirrors the existing statusBar module-level.
let allWorkspaces: Workspace[] = [];

/**
 * Adds `.pairs/` to the workspace's top-level .gitignore so the derived index
 * is never accidentally committed. No-op if the entry (or a broader pattern
 * such as `.pairs` followed by a wildcard) is already present; creates the
 * file if it doesn't exist.
 */
async function ensurePairsIgnored(root: string): Promise<void> {
  const gitignorePath = path.join(root, '.gitignore');
  let contents = '';
  try {
    contents = await fs.readFile(gitignorePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const alreadyIgnored = contents
    .split('\n')
    .some((line) => /^\.pairs\*?\/?$/.test(line.trim()));
  if (alreadyIgnored) return;
  const needsNewline = contents.length > 0 && !contents.endsWith('\n');
  contents += `${needsNewline ? '\n' : ''}${contents.length > 0 ? '\n' : ''}# PAiRS derived index - disposable, never committed\n.pairs/\n`;
  await fs.writeFile(gitignorePath, contents, 'utf8');
}

async function openWorkspace(folder: vscode.WorkspaceFolder, extensionPath: string): Promise<Workspace> {
  const root = folder.uri.fsPath;
  const dbPath = path.join(root, '.pairs', 'index.db');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await ensurePairsIgnored(root);
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
  return { root, name: folder.name, store, indexer, parsers };
}

/**
 * Combined status bar across every open workspace folder. Prefers the active
 * editor's folder's own stats when determinable (vscode.workspace.
 * getWorkspaceFolder), since that's what the user is actually looking at;
 * falls back to aggregating (summing) stats across all open workspaces
 * otherwise — kept simple rather than trying to track "the last-focused
 * folder" independent of the editor.
 */
async function refreshStatus(workspaces: Workspace[]): Promise<void> {
  if (!statusBar) return;
  try {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    const activeWs = activeFolder ? workspaces.find((w) => w.name === activeFolder.name) : undefined;

    if (activeWs) {
      const stats = await activeWs.indexer.stats();
      const pct = (stats.fuzzyRate * 100).toFixed(0);
      statusBar.text = `$(symbol-structure) pairs[${activeWs.name}] ${stats.symbols} sym · ${pct}% fuzzy`;
      statusBar.tooltip = `PAiRS code index — ${activeWs.name}\n${stats.files} files · ${stats.symbols} symbols · ${stats.edges} edges\nfuzzyRate ${pct}% · resolvableMisses ${stats.resolvableMisses}`;
    } else {
      const allStats = await Promise.all(workspaces.map((w) => w.indexer.stats()));
      const totals = allStats.reduce(
        (acc, s) => ({
          files: acc.files + s.files,
          symbols: acc.symbols + s.symbols,
          edges: acc.edges + s.edges,
          resolvableMisses: acc.resolvableMisses + s.resolvableMisses,
        }),
        { files: 0, symbols: 0, edges: 0, resolvableMisses: 0 }
      );
      const totalEdgesForFuzzy = allStats.reduce((s, x) => s + x.edges, 0);
      const fuzzyWeighted = allStats.reduce((s, x) => s + x.fuzzyRate * x.edges, 0);
      const pct = totalEdgesForFuzzy > 0 ? ((fuzzyWeighted / totalEdgesForFuzzy) * 100).toFixed(0) : '0';
      const label = workspaces.length > 1 ? `${workspaces.length} folders · ` : '';
      statusBar.text = `$(symbol-structure) pairs ${label}${totals.symbols} sym · ${pct}% fuzzy`;
      statusBar.tooltip = `PAiRS code index (${label}combined)\n${totals.files} files · ${totals.symbols} symbols · ${totals.edges} edges\nfuzzyRate ${pct}% · resolvableMisses ${totals.resolvableMisses}`;
    }
  } catch (err) {
    statusBar.text = '$(warning) pairs: not indexed';
    statusBar.tooltip = String((err as Error).message);
  }
  statusBar.show();
}

async function reindex(ws: Workspace): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `PAiRS: indexing ${ws.name}…` },
    async () => {
      await ws.indexer.fullIndex(ws.root);
    }
  );
  await refreshStatus(allWorkspaces);
}

/**
 * `pairs.rebuildIndex`: a plain reindex short-circuits unchanged files (mtime/
 * size/hash) and often writes nothing at all, so it can't recover from a
 * corrupted or stale-shaped store. This drops every table and reparses the
 * whole workspace from scratch.
 */
async function rebuildIndex(ws: Workspace): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `PAiRS: rebuilding index for ${ws.name}…` },
    async () => {
      await ws.store.reset();
      await ws.indexer.fullIndex(ws.root);
    }
  );
  await refreshStatus(allWorkspaces);
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

/**
 * Builds one Executors object per open workspace folder, keyed by the
 * folder's vscode name, so a tool invocation can dispatch to the right
 * folder's store without changing createExecutors' single-workspace contract.
 */
function buildExecutorsByFolder(workspaces: Workspace[]): Map<string, ReturnType<typeof createExecutors>> {
  const byFolder = new Map<string, ReturnType<typeof createExecutors>>();
  for (const ws of workspaces) {
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
    // diff_impact needs git; the pure core must not shell out itself, so the
    // adapter injects it here exactly as the CLI does.
    byFolder.set(
      ws.name,
      createExecutors({
        store: ws.store,
        root: ws.root,
        readSource,
        collectDiff: (src) => collectDiffHunks(ws.root, src),
      })
    );
  }
  return byFolder;
}

/**
 * Each `pairs_<name>` tool is registered exactly once (vscode.lm.registerTool
 * allows only one registration per name), regardless of how many workspace
 * folders are open. Dispatch to the right folder's executor happens inside
 * the single invoke() via the tool's optional `workspaceFolder` input,
 * defaulting to the first/only open folder to match the single-root behavior.
 */
function registerLmTools(workspaces: Workspace[]): vscode.Disposable[] {
  const executorsByFolder = buildExecutorsByFolder(workspaces);
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
            const requested = (input as { workspaceFolder?: string }).workspaceFolder;
            const executors = requested ? executorsByFolder.get(requested) : executorsByFolder.get(workspaces[0]!.name);
            if (!executors) {
              const open = workspaces.map((w) => w.name).join(', ');
              return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: no open workspace folder named "${requested}". Open folders: ${open}`),
              ]);
            }
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

/**
 * Resolves which Workspace a command should act on. Single-folder case is
 * unchanged (no prompt); with 2+ folders open, asks via quick-pick and
 * returns undefined if the user cancels — commands must not silently fall
 * back to "all" or "first" in that case, they're single-workspace-scoped by
 * user choice.
 */
async function pickWorkspace(workspaces: Workspace[]): Promise<Workspace | undefined> {
  if (workspaces.length <= 1) return workspaces[0];
  const pick = await vscode.window.showQuickPick(
    workspaces.map((w) => ({ label: w.name, description: w.root, ws: w })),
    { placeHolder: 'PAiRS: choose a workspace folder' }
  );
  return pick?.ws;
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
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return; // no workspace → nothing to index

  // One Workspace (root/store/indexer/parsers) per open folder — each folder
  // gets its own .pairs/index.db, so a multi-root workspace indexes every
  // folder instead of silently skipping all but the first.
  const workspaces = await Promise.all(folders.map((f) => openWorkspace(f, context.extensionPath)));
  allWorkspaces = workspaces;

  for (const ws of workspaces) {
    context.subscriptions.push({
      // Merge the WAL, then close. Best-effort — the process may already be
      // exiting.
      dispose: () => void ws.store.checkpoint().finally(() => ws.store.dispose()),
    });
    context.subscriptions.push({ dispose: () => ws.parsers.dispose() });
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'pairs.reindex';
  context.subscriptions.push(statusBar);
  // The active editor determines which folder's stats the status bar shows
  // (falling back to the aggregate) — react to editor switches, not just
  // index changes.
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void refreshStatus(allWorkspaces)));

  context.subscriptions.push(
    vscode.commands.registerCommand('pairs.reindex', async () => {
      const ws = await pickWorkspace(workspaces);
      if (ws) await reindex(ws);
    }),
    vscode.commands.registerCommand('pairs.rebuildIndex', async () => {
      const ws = await pickWorkspace(workspaces);
      if (ws) await rebuildIndex(ws);
    }),
    vscode.commands.registerCommand('pairs.findSymbol', async () => {
      const ws = await pickWorkspace(workspaces);
      if (ws) await findSymbol(ws);
    }),
    vscode.commands.registerCommand('pairs.moduleMap', async () => {
      const ws = await pickWorkspace(workspaces);
      if (!ws) return;
      // Read-only module-graph webview: Louvain subsystems as
      // columns ordered by dependency layer, drift edges red, cycle edges
      // amber. Self-contained HTML, inline script only (CSP forbids remote
      // scripts) — the script filters/focuses/pans the view and asks the
      // extension to reveal a module (Enter or double-click on a node), it
      // never mutates the graph.
      const map = await moduleMap(ws.store);
      const panel = vscode.window.createWebviewPanel('pairsModuleMap', `PAiRS Module Map — ${ws.name}`, vscode.ViewColumn.Active, { enableScripts: true });
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
  context.subscriptions.push(...registerLmTools(workspaces));

  // One watcher + queue per folder — each routes into its own folder's
  // indexer, never a queue shared across folders.
  for (const ws of workspaces) {
    const folder = folders.find((f) => f.name === ws.name)!;
    // Incremental loop: source saves/creates/deletes flow through
    // the debounced WatchQueue into indexFile/removeFile (both serialized on the
    // indexer's opChain), then the status bar refreshes — it tracks the code
    // without a manual reindex.
    const queue = new WatchQueue({
      indexFile: (p) => ws.indexer.indexFile(p),
      removeFile: (p) => ws.indexer.removeFile(p),
      onFlushed: async () => {
        await ws.store.checkpoint();
        await refreshStatus(allWorkspaces);
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
  }

  void Promise.all(workspaces.map((ws) => writeSkillFiles(ws.root)));

  // Marketplace installs never run npm's postinstall hook, so link the
  // bundled CLI onto PATH here instead — the only path that covers every
  // install method (Marketplace, .vsix, npm install).
  void ensureCliLinked(context.extensionPath);
}

export function deactivate(): void {
  // Subscriptions handle disposal of the store, parsers and status bar.
}
