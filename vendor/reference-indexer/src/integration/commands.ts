/**
 * Command palette registrations under `pairs.*`. All commands
 * delegate to the shared executor/lifecycle services; UI review always goes
 * through UiIntegration.review (F1 — no ad hoc modals here).
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { MemoryToolExecutor, CodeToolExecutor } from '../mcp/tools';
import type { MemoryStore } from '../core/store';
import type { CodeStore } from '../index/codeStore';
import type { CodeSearch } from '../index/codeSearch';
import type { Compressor, HealthChecker, Pruner, Rewinder, Simplifier } from '../intelligence/lifecycle';
import type { EmbeddingIndexer } from '../intelligence/embeddings';
import type { OkfBundleReader, OkfBundleWriter, OkfImporter } from '../okf/bundle';
import type { CommandsIntegration, UiIntegration } from './surfaces';
import { importClaudeMemory } from './claudeMemoryImport';
import {
  CODE_TOOL_ENTRIES,
  CodeResultsProvider,
  edgeSymbols,
  resolveSymbolFromEditor,
  resolveSymbolRecords,
} from './codeResults';
import type { CodeResultNode, ResultGroup, SymbolHint } from './codeResults';
import { deleteDeadCodeSymbols } from './deadCodeActions';

export interface CommandsDeps {
  store: MemoryStore;
  executor: MemoryToolExecutor;
  codeExecutor?: CodeToolExecutor;
  codeStore?: CodeStore;
  codeSearch?: CodeSearch;
  codeResultsProvider?: CodeResultsProvider;
  codeView?: vscode.TreeView<CodeResultNode>;
  workspaceRoot?: string;
  compressor: Compressor;
  simplifier: Simplifier;
  pruner: Pruner;
  rewinder: Rewinder;
  healthChecker: HealthChecker;
  embeddingIndexer?: EmbeddingIndexer;
  ui: UiIntegration & { refreshStatusBar(): Promise<void>; drainInbox(): unknown[] };
  bundleWriter: OkfBundleWriter;
  bundleReader: OkfBundleReader;
  importer: OkfImporter;
  okfRoot: string;
}

export class CommandsIntegrationImpl implements CommandsIntegration {
  constructor(private readonly deps: CommandsDeps) {}

  register(context: vscode.ExtensionContext): vscode.Disposable {
    const {
      store,
      executor,
      codeExecutor,
      codeStore,
      codeSearch,
      codeResultsProvider,
      compressor,
      simplifier,
      pruner,
      rewinder,
      healthChecker,
      embeddingIndexer,
      ui,
      bundleWriter,
      okfRoot,
    } = this.deps;

    const refresh = () => void ui.refreshStatusBar();

    const disposables = [
      vscode.commands.registerCommand('pairs.saveSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const text = editor.document.getText(editor.selection);
        if (!text.trim()) return;
        const title = await vscode.window.showInputBox({ prompt: 'Memory title' });
        if (!title) return;
        await executor.execute(
          'memory_save',
          { type: 'reference', title, body: text, tags: [], importance: 0.5 },
          'chat'
        );
        refresh();
      }),

      vscode.commands.registerCommand('pairs.saveNote', async () => {
        const body = await vscode.window.showInputBox({ prompt: 'Note to remember' });
        if (!body) return;
        await executor.execute(
          'memory_save',
          { type: 'user', title: body.slice(0, 60), body, tags: [], importance: 0.5 },
          'chat'
        );
        refresh();
      }),

      vscode.commands.registerCommand('pairs.saveFileAsMemory', async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        const uris = (selectedUris && selectedUris.length ? selectedUris : clickedUri ? [clickedUri] : [])
          .filter((u) => u.scheme === 'file');
        if (!uris.length) return;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        for (const uri of uris) {
          const relPath = path.relative(folder.uri.fsPath, uri.fsPath) || path.basename(uri.fsPath);
          const title = `File: ${relPath}`;
          await executor.execute(
            'memory_save',
            { type: 'reference', title, body: `File reference: \`${relPath}\``, tags: ['file'], importance: 0.3 },
            'chat'
          );
        }
        refresh();
      }),

      vscode.commands.registerCommand('pairs.saveFolderAsMemory', async (clickedUri?: vscode.Uri) => {
        if (!clickedUri || clickedUri.scheme !== 'file') return;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const relPath = path.relative(folder.uri.fsPath, clickedUri.fsPath) || path.basename(clickedUri.fsPath);
        const title = `Folder: ${relPath}`;
        await executor.execute(
          'memory_save',
          { type: 'reference', title, body: `Folder reference: \`${relPath}/\``, tags: ['folder'], importance: 0.3 },
          'chat'
        );
        refresh();
      }),

      vscode.commands.registerCommand('pairs.search', async () => {
        const query = await vscode.window.showInputBox({ prompt: 'Search memories' });
        if (!query) return;
        const result = await executor.execute('memory_search', { query, limit: 10, includeBody: false }, 'chat');
        const doc = await vscode.workspace.openTextDocument({ content: result.text, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
      }),

      vscode.commands.registerCommand('pairs.compress', async () => {
        const proposals = await compressor.propose();
        const approved = await ui.review('Compress: approve merges', proposals);
        await compressor.apply(approved);
        refresh();
      }),

      vscode.commands.registerCommand('pairs.simplify', async () => {
        const proposals = await simplifier.propose();
        const approved = await ui.review('Simplify: approve rewrites', proposals);
        await simplifier.apply(approved);
        refresh();
      }),

      vscode.commands.registerCommand('pairs.pruneReview', async () => {
        const candidates = await pruner.propose();
        const approved = await ui.review('Prune: approve deletions', candidates);
        await pruner.apply(approved);
        refresh();
      }),

      vscode.commands.registerCommand('pairs.rewind', async () => {
        const points = await rewinder.points();
        const picked = await vscode.window.showQuickPick(
          points.map((p) => ({ label: p.label, description: p.ts, seq: p.seq })),
          { title: 'Rewind to…' }
        );
        if (!picked) return;
        const preview = await rewinder.preview(picked.seq);
        const confirm = await vscode.window.showWarningMessage(
          `Rewind will change ${preview.changes.length} memor${preview.changes.length === 1 ? 'y' : 'ies'}. Continue?`,
          { modal: true },
          'Rewind'
        );
        if (confirm !== 'Rewind') return;
        await rewinder.apply(picked.seq);
        refresh();
      }),

      vscode.commands.registerCommand('pairs.clear', async () => {
        const confirm = await vscode.window.showWarningMessage(
          'Clear ALL workspace memories? A backup will be written first.',
          { modal: true },
          'Clear All'
        );
        if (confirm !== 'Clear All') return;
        const { backupPath, count } = await store.clear('user');
        vscode.window.showInformationMessage(`Cleared ${count} memories. Backup: ${backupPath}`);
        refresh();
      }),

      vscode.commands.registerCommand('pairs.exportBundle', async () => {
        await bundleWriter.export(okfRoot, await store.list(), await store.events());
        vscode.window.showInformationMessage(`Exported OKF bundle to ${okfRoot}`);
      }),

      vscode.commands.registerCommand('pairs.importBundle', async () => {
        const bundle = await this.deps.bundleReader.read(okfRoot);
        const result = await this.deps.importer.import(bundle);
        vscode.window.showInformationMessage(
          `Imported: ${result.created.length} created, ${result.updated.length} updated, ${result.errors.length} errors.`
        );
        refresh();
      }),

      vscode.commands.registerCommand('pairs.importClaudeMemory', async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          vscode.window.showInformationMessage('Open a workspace folder first.');
          return;
        }
        const result = await importClaudeMemory(folder.uri.fsPath, store);
        vscode.window.showInformationMessage(
          `Claude memory import: ${result.imported.length} imported, ${result.skipped.length} already present, ${result.errors.length} errors.`
        );
        refresh();
      }),

      vscode.commands.registerCommand('pairs.rebuildIndex', async () => {
        if (!embeddingIndexer) {
          vscode.window.showInformationMessage('Embeddings are not enabled for this workspace.');
          return;
        }
        vscode.window.showInformationMessage('Rebuilding embedding index…');
        await embeddingIndexer.flush();
        vscode.window.showInformationMessage('Embedding index rebuilt.');
      }),

      vscode.commands.registerCommand('pairs.stats', async () => {
        const count = await store.count();
        const pending = await store.pendingEmbeddings();
        vscode.window.showInformationMessage(`${count} memories, ${pending.length} pending embeddings.`);
      }),

      vscode.commands.registerCommand('pairs.healthCheck', async () => {
        const issues = await healthChecker.check();
        if (!issues.length) {
          vscode.window.showInformationMessage('No stale references or contradictions found.');
          return;
        }
        for (const issue of issues) {
          const healthTitle = (() => {
            if (issue.kind === 'stale-reference') return `Stale reference: ${issue.memory.title}`;
            if (issue.kind === 'stale-symbol-anchor') return `Stale symbol anchor: ${issue.memory.title} (${issue.missingSymbols.join(', ')})`;
            if (issue.kind === 'contradiction') return `Possible contradiction: ${issue.memories.map((m) => m.title).join(' vs ')}`;
            if (issue.kind === 'signature-drift') return `Signature drift: ${issue.memory.title} (${issue.driftedAnchors.length} anchor(s))`;
            return 'Health issue';
          })();
          ui.queueForInbox({
            kind: 'health',
            title: healthTitle,
            payload: issue,
            queuedAt: new Date().toISOString(),
          });
        }
        refresh();
      }),

      vscode.commands.registerCommand('pairs.undoLastCapture', async () => {
        const events = await store.events({ ops: ['create'], limit: 1000 });
        const last = events.at(-1);
        if (!last) {
          vscode.window.showInformationMessage('No recent capture to undo.');
          return;
        }
        await store.delete(last.memoryId, 'user');
        vscode.window.showInformationMessage(`Undid capture of ${last.memoryId}.`);
        refresh();
      }),

      vscode.commands.registerCommand('pairs.openInbox', async () => {
        const items = ui.drainInbox();
        if (!items.length) {
          vscode.window.showInformationMessage('Inbox is empty.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          content: (items as { title: string }[]).map((i) => `- ${i.title}`).join('\n'),
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
      }),

      vscode.commands.registerCommand('pairs.showAgentContext', async () => {
        const result = await executor.execute('memory_list', { limit: 50 }, 'chat');
        const doc = await vscode.workspace.openTextDocument({ content: result.text, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
      }),

      vscode.commands.registerCommand('pairs.setupClaudeCode', async () => {
        // Same `.pairs/` DBs that extension.ts opens — both transports share one store.
        const folder = vscode.workspace.workspaceFolders?.[0];
        const pairsDir = folder
          ? vscode.Uri.joinPath(folder.uri, '.pairs')
          : (context.storageUri ?? context.globalStorageUri);
        const sharedDaemon = vscode.workspace.getConfiguration('pairs').get<boolean>('sharedDaemon', false);

        let cmd: string;
        if (sharedDaemon && folder) {
          const proxyScript = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-proxy.js').fsPath;
          cmd = `claude mcp add pairs -- node ${proxyScript} --workspace ${folder.uri.fsPath}`;
        } else {
          const serverScript = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
          const dbPath = vscode.Uri.joinPath(pairsDir, 'memory.db').fsPath;
          const codeDbPath = vscode.Uri.joinPath(pairsDir, 'code.db').fsPath;
          cmd =
            `claude mcp add pairs -- node ${serverScript} --db ${dbPath} --okf ${okfRoot}` +
            ` --code-db ${codeDbPath} --index-on-start`;
        }
        await vscode.env.clipboard.writeText(cmd);
        vscode.window.showInformationMessage('Claude Code MCP setup command copied to clipboard.');
      }),

      vscode.commands.registerCommand('pairs.showCodeAnalysisTools', async () => {
        if (!codeExecutor) {
          vscode.window.showInformationMessage(
            'Code analysis tools are not enabled. Enable pairs.codeIndex.enabled in settings.'
          );
          return;
        }

        const toolsHelp = `# Memory Code Analysis Tools

## Available Tools

### 1. code_search
Find symbols (functions, classes, methods) across the whole workspace by name, signature, or meaning.
- **Use when:** Locating where something is defined, instead of grep or opening files one by one
- **Syntax:** "Find the auth service login function" or "code_search query='login' pathPrefix='src/'"
- **Extras:** excludePath to skip folders, offset to page past truncated results

### 2. who_calls
List every call site of a function/method (callers) or everything it calls (callees), up to depth 3.
- **Use when:** Before renaming, changing a signature, or removing a function
- **Syntax:** "Who calls AuthService.login?" — pass path='src/auth/service.ts' to disambiguate

### 3. find_implementations
Find all subtypes of an interface/class, or its inheritance ancestry.
- **Use when:** Before changing an interface/base class or adding an abstract method

### 4. code_outline
Structural outline of one file: symbols, signatures, line ranges.
- **Use when:** You need a file's shape but not its full source — far cheaper than Read

### 5. get_declaration
Full declaration of a symbol: signature, doc comment, and members for container kinds.
- **Use when:** You only need a symbol's contract, not its body — pass path to disambiguate

### 6. find_dead_code
Find unreferenced symbols (functions, classes, methods) in your workspace.
- **Use when:** Identifying code to delete or refactor
- **Syntax:** "Find dead code in src/" — use excludePath to skip test folders
- **Available during:** After code index scan completes

### 7. file_deps
Analyze file-level dependencies—what imports a file, or what it imports.
- **Use when:** Planning refactoring impact, finding unused imports, detecting circular dependencies
- **Syntax:** "Show who imports src/auth.ts" or "What does src/config.ts depend on?"
- **Available during:** After code index scan completes

### 8. code_hotspots
Identify the most complex functions (cyclomatic or cognitive complexity).
- **Use when:** Finding candidates for refactoring, understanding hard-to-maintain code
- **Syntax:** "Show complex functions" or "Find functions with cognitive complexity > 15"
- **Available during:** After code index scan completes

### 9. find_duplicates
Find semantically similar functions that could be merged.
- **Use when:** Detecting conceptual overlap between implementations
- **Syntax:** "Find duplicate implementations" or "Show similar functions with score > 0.9"
- **Available during:** After embeddings backfill completes
- **Note:** Requires embeddings enabled in settings

## Memory Tools (Always Available)

- **memory_save** — Save decisions, gotchas, constraints
- **memory_search** — Find past decisions and failed approaches
- **memory_list** — Overview of what's remembered
- **memory_forget** — Delete obsolete memories

## How to Use in Claude Code

Ask Claude Code to use these tools:
\`\`\`
@Claude: Find dead code in src/utils
@Claude: What depends on src/core/auth.ts?
@Claude: Show the most complex functions in the services folder
@Claude: Find functions that do similar things
\`\`\`

Or mention code analysis explicitly:
\`\`\`
@Claude: I want to refactor src/auth.ts. Use file_deps to check impact.
\`\`\`

## Progress & Status

The code index scans your workspace in the background:
- **Initial scan:** ~10s–2min (depends on workspace size)
- **File changes:** Picked up within 2s of save
- **Embeddings:** Backfilled after scan completes (if enabled)

You can monitor progress in the PAiRS status bar.

## Learn More

See the README for complete documentation:
\`\`\`
code --help README.md
\`\`\`

Or search memories: "code analysis tools"
`;

        const doc = await vscode.workspace.openTextDocument({ content: toolsHelp, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
      }),

      ...registerCodeToolCommands({
        store: codeStore,
        search: codeSearch,
        resultsProvider: codeResultsProvider,
        codeView: this.deps.codeView,
        workspaceRoot: this.deps.workspaceRoot,
      }),
    ];

    context.subscriptions.push(...disposables);
    return vscode.Disposable.from(...disposables);
  }
}

interface CodeToolDeps {
  store?: CodeStore;
  search?: CodeSearch;
  resultsProvider?: CodeResultsProvider;
  codeView?: vscode.TreeView<CodeResultNode>;
  workspaceRoot?: string;
}

/** Quick-access commands for the code-analysis tools, surfaced via the "PAiRS
 * Code" sidebar view (search, call graph, refactoring/quality, test
 * coverage) instead of chat-only. Each resolves a symbol from the active
 * editor's selection/cursor first (falling back to an input box only when
 * invoked with no editor context), calls the structured CodeStore/CodeSearch
 * layer directly (pure SQL — no per-query embedding call), and renders
 * clickable results in the view rather than a throwaway markdown tab. */
function registerCodeToolCommands(deps: CodeToolDeps): vscode.Disposable[] {
  const requireStore = (): CodeStore | undefined => {
    if (!deps.store || !deps.resultsProvider) {
      vscode.window.showInformationMessage(
        'Code analysis tools are not enabled. Enable pairs.codeIndex.enabled in settings.'
      );
      return undefined;
    }
    return deps.store;
  };

  const focusView = () => void vscode.commands.executeCommand('pairs.codeView.focus');

  const withViewProgress = <T>(task: () => Thenable<T>): Thenable<T> =>
    vscode.window.withProgress({ location: { viewId: 'pairs.codeView' } }, task);

  /** A symbol name plus, when it was lifted from the editor rather than typed, the position
   * it came from — passed on to resolveSymbolRecords so a same-named symbol elsewhere in the
   * codebase doesn't force a second disambiguation prompt right after this one. */
  interface PromptedSymbol {
    symbol: string;
    hint?: SymbolHint;
  }

  const promptSymbol = async (prompt: string): Promise<PromptedSymbol | undefined> => {
    const editor = vscode.window.activeTextEditor;
    const fromEditor = resolveSymbolFromEditor(editor);
    if (fromEditor) {
      const hint: SymbolHint | undefined =
        editor && deps.workspaceRoot
          ? { file: path.relative(deps.workspaceRoot, editor.document.uri.fsPath), line: editor.selection.active.line + 1 }
          : undefined;
      return { symbol: fromEditor, hint };
    }
    const typed = await vscode.window.showInputBox({ prompt });
    return typed ? { symbol: typed } : undefined;
  };

  return [
    vscode.commands.registerCommand('pairs.codeSearch', async (queryArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const query =
        queryArg ??
        (await vscode.window.showInputBox({
          prompt: 'Search code symbols by name, signature, or meaning',
          value: resolveSymbolFromEditor(vscode.window.activeTextEditor) ?? '',
        }));
      if (!query) return;
      const hits = await withViewProgress(() => store.ftsSearch({ text: query, limit: 30 }));
      const group: ResultGroup = { label: '', symbols: hits.map((h) => h.symbol) };
      deps.resultsProvider.setResults(`Search: "${query}"`, [group], { sourceCommand: 'pairs.codeSearch' });
      focusView();
    }),

    vscode.commands.registerCommand('pairs.whoCalls', async (symbolArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const prompted = symbolArg
        ? { symbol: symbolArg }
        : await promptSymbol('Symbol to trace (e.g. "login" or "AuthService.login")');
      if (!prompted) return;
      const { symbol, hint } = prompted;
      const direction = await vscode.window.showQuickPick(['callers', 'callees'] as const, {
        placeHolder: 'Show callers of this symbol, or what it calls?',
      });
      if (!direction) return;
      const records = await resolveSymbolRecords(store, symbol, hint);
      if (!records) return;
      const ids = records.map((r) => r.id);
      const results = await withViewProgress(() =>
        direction === 'callers' ? edgeSymbols(store, ids, ['calls'], 'to') : edgeSymbols(store, ids, ['calls'], 'from')
      );
      deps.resultsProvider.setResults(
        `${direction === 'callers' ? 'Callers' : 'Callees'} of "${symbol}"`,
        [{ label: '', symbols: results }],
        { sourceCommand: 'pairs.whoCalls' }
      );
      focusView();
    }),

    vscode.commands.registerCommand('pairs.changeImpact', async (symbolArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const prompted = symbolArg
        ? { symbol: symbolArg }
        : await promptSymbol('Symbol to assess before renaming/changing/deleting it');
      if (!prompted) return;
      const { symbol, hint } = prompted;
      const records = await resolveSymbolRecords(store, symbol, hint);
      if (!records) return;
      const ids = records.map((r) => r.id);
      const [callers, subtypes, references] = await withViewProgress(() =>
        Promise.all([
          edgeSymbols(store, ids, ['calls'], 'to'),
          edgeSymbols(store, ids, ['extends', 'implements'], 'to'),
          edgeSymbols(store, ids, ['references'], 'to'),
        ])
      );
      deps.resultsProvider.setResults(
        `Change impact: "${symbol}"`,
        [
          { label: 'Callers', symbols: callers },
          { label: 'Subtypes / implementations', symbols: subtypes },
          { label: 'Other references', symbols: references },
        ],
        { sourceCommand: 'pairs.changeImpact' }
      );
      focusView();
    }),

    vscode.commands.registerCommand('pairs.codeHotspots', async () => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const metric = await vscode.window.showQuickPick(['cognitive', 'cyclomatic'] as const, {
        placeHolder: 'Rank functions by which complexity metric?',
      });
      if (!metric) return;
      const symbols = await withViewProgress(() => store.hotspots({ metric: metric as 'cognitive' | 'cyclomatic' }));
      deps.resultsProvider.setResults(
        `Hotspots by ${metric} complexity`,
        [
          {
            label: '',
            symbols,
            note: (s) => `${metric === 'cognitive' ? s.cognitive : s.complexity} complexity`,
          },
        ],
        { sourceCommand: 'pairs.codeHotspots' }
      );
      focusView();
    }),

    vscode.commands.registerCommand('pairs.findDeadCode', async () => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const pathPrefix = await vscode.window.showInputBox({
        prompt: 'Limit to a workspace-relative directory (optional)',
        placeHolder: 'e.g. src/ — leave empty to scan everything',
      });
      const candidates = await withViewProgress(() => store.unreferenced({ pathPrefix: pathPrefix || undefined }));
      const notes = new Map(candidates.map((c) => [c.symbol.id, c.note]));
      deps.resultsProvider.setResults(
        'Unreferenced code candidates',
        [{ label: '', symbols: candidates.map((c) => c.symbol), note: (s) => notes.get(s.id) ?? undefined }],
        { symbolContextValue: 'pairs.symbol.deadCode', sourceCommand: 'pairs.findDeadCode' }
      );
      void vscode.commands.executeCommand('setContext', 'pairs.hasDeadCodeResults', candidates.length > 0);
      focusView();
    }),

    vscode.commands.registerCommand('pairs.whoTests', async (symbolArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const prompted = symbolArg ? { symbol: symbolArg } : await promptSymbol('Symbol to check test coverage for');
      if (!prompted) return;
      const { symbol, hint } = prompted;
      const records = await resolveSymbolRecords(store, symbol, hint);
      if (!records) return;
      const hits = await withViewProgress(() => store.testsReferencing(records.map((r) => r.id)));
      deps.resultsProvider.setResults(
        `Tests exercising "${symbol}"`,
        [
          {
            label: '',
            symbols: hits.map((h) => h.test),
            note: (s) => {
              const hit = hits.find((h) => h.test.id === s.id);
              return hit ? `depth ${hit.depth}${hit.confidence === 'fuzzy' ? ' · ~' : ''}` : undefined;
            },
          },
        ],
        { sourceCommand: 'pairs.whoTests' }
      );
      focusView();
    }),

    vscode.commands.registerCommand('pairs.findUntested', async () => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const pathPrefix = await vscode.window.showInputBox({
        prompt: 'Limit to a workspace-relative directory (optional)',
        placeHolder: 'e.g. src/services — leave empty to scan everything',
      });
      const symbols = await withViewProgress(() => store.untested({ pathPrefix: pathPrefix || undefined }));
      deps.resultsProvider.setResults('Untested exported symbols', [{ label: '', symbols }], {
        sourceCommand: 'pairs.findUntested',
      });
      focusView();
    }),

    vscode.commands.registerCommand('pairs.findImplementations', async (symbolArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const prompted = symbolArg
        ? { symbol: symbolArg }
        : await promptSymbol('Symbol to find subtypes/implementations of');
      if (!prompted) return;
      const { symbol, hint } = prompted;
      const records = await resolveSymbolRecords(store, symbol, hint);
      if (!records) return;
      const ids = records.map((r) => r.id);
      const results = await withViewProgress(() => edgeSymbols(store, ids, ['extends', 'implements'], 'to'));
      deps.resultsProvider.setResults(`Implementations of "${symbol}"`, [{ label: '', symbols: results }], {
        sourceCommand: 'pairs.findImplementations',
      });
      focusView();
    }),

    vscode.commands.registerCommand('pairs.codeOutline', async (pathArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const relPath =
        pathArg ??
        (deps.workspaceRoot && vscode.window.activeTextEditor
          ? path.relative(deps.workspaceRoot, vscode.window.activeTextEditor.document.uri.fsPath)
          : undefined) ??
        (await vscode.window.showInputBox({ prompt: 'Workspace-relative file path to outline', placeHolder: 'e.g. src/index.ts' }));
      if (!relPath) return;
      const symbols = await withViewProgress(() => store.outline(relPath));
      deps.resultsProvider.setResults(`Outline: ${relPath}`, [{ label: '', symbols }], {
        sourceCommand: 'pairs.codeOutline',
      });
      focusView();
    }),

    vscode.commands.registerCommand('pairs.fileDeps', async (pathArg?: string) => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const relPath =
        pathArg ??
        (deps.workspaceRoot && vscode.window.activeTextEditor
          ? path.relative(deps.workspaceRoot, vscode.window.activeTextEditor.document.uri.fsPath)
          : undefined) ??
        (await vscode.window.showInputBox({ prompt: 'Workspace-relative file path', placeHolder: 'e.g. src/index.ts' }));
      if (!relPath) return;
      const picked = await vscode.window.showQuickPick(['imports', 'importers'] as const, {
        placeHolder: 'Show what this file imports, or files that import it?',
      });
      if (!picked) return;
      const direction: 'imports' | 'importers' = picked === 'imports' ? 'imports' : 'importers';
      const deps_ = await withViewProgress(() => store.fileEdges(relPath, direction));
      const lines = deps_.length
        ? deps_.map((d) => `${d.path}  (L${d.line})`)
        : [`No ${direction} found for "${relPath}".`];
      deps.resultsProvider.setTextResults(
        `${direction === 'imports' ? 'Imports of' : 'Importers of'} ${relPath}`,
        lines,
        { sourceCommand: 'pairs.fileDeps' }
      );
      focusView();
    }),

    vscode.commands.registerCommand('pairs.dependencyCycle', async () => {
      const store = requireStore();
      if (!store || !deps.resultsProvider) return;
      const pathPrefix = await vscode.window.showInputBox({
        prompt: 'Limit to a workspace-relative directory (optional)',
        placeHolder: 'e.g. src/ — leave empty to scan everything',
      });
      const cycles = await withViewProgress(() => store.findCycles({ pathPrefix: pathPrefix || undefined }));
      const lines = cycles.length
        ? cycles.flatMap((cycle, i) => [`Cycle ${i + 1} (${cycle.length} files):`, ...cycle.map((p) => `  ${p}`)])
        : ['No circular import dependencies found.'];
      deps.resultsProvider.setTextResults('Dependency cycles', lines, { sourceCommand: 'pairs.dependencyCycle' });
      focusView();
    }),

    vscode.commands.registerCommand('pairs.codeResults.clear', () => {
      deps.resultsProvider?.clear();
      void vscode.commands.executeCommand('setContext', 'pairs.hasDeadCodeResults', false);
    }),

    vscode.commands.registerCommand('pairs.copySymbolPath', async (node?: CodeResultNode, selected?: CodeResultNode[]) => {
      const nodes = selected && selected.length ? selected : node ? [node] : deps.codeView?.selection ?? [];
      const symbols = nodes.filter((n) => n.kind === 'symbol' && n.symbol).map((n) => n.symbol!);
      if (!symbols.length) return;
      const paths = symbols.map((s) => s.qualified ?? `${s.file}:${s.startLine}`);
      await vscode.env.clipboard.writeText(paths.join('\n'));
      vscode.window.showInformationMessage(`Copied ${paths.length} symbol path${paths.length === 1 ? '' : 's'}.`);
    }),

    vscode.commands.registerCommand('pairs.runCodeTool', async () => {
      const picked = await vscode.window.showQuickPick(
        CODE_TOOL_ENTRIES.map((e) => ({ label: `$(${e.icon}) ${e.label}`, detail: e.detail, command: e.command })),
        { title: 'Run a PAiRS code tool', placeHolder: 'Select a tool to run' }
      );
      if (!picked) return;
      await vscode.commands.executeCommand(picked.command);
    }),

    vscode.commands.registerCommand(
      'pairs.deadCode.delete',
      async (node?: CodeResultNode, selected?: CodeResultNode[]) => {
        if (!deps.store || !deps.resultsProvider || !deps.workspaceRoot) return;
        const nodes =
          selected && selected.length ? selected : node ? [node] : deps.codeView?.selection ?? [];
        const symbols = nodes
          .filter((n) => n.kind === 'symbol' && n.contextValue === 'pairs.symbol.deadCode' && n.symbol)
          .map((n) => n.symbol!);
        if (!symbols.length) return;
        await deleteDeadCodeSymbols(
          { workspaceRoot: deps.workspaceRoot, resultsProvider: deps.resultsProvider, codeView: deps.codeView! },
          symbols
        );
      }
    ),

    vscode.commands.registerCommand('pairs.deadCode.deleteAll', async () => {
      if (!deps.store || !deps.resultsProvider || !deps.workspaceRoot) return;
      const symbols = deps.resultsProvider.allSymbols();
      if (!symbols.length) return;
      await deleteDeadCodeSymbols(
        { workspaceRoot: deps.workspaceRoot, resultsProvider: deps.resultsProvider, codeView: deps.codeView! },
        symbols
      );
    }),
  ];
}
