/**
 * "PAiRS Code" TreeView: renders code-analysis results (search / call graph /
 * change impact / hotspots / dead code / test coverage) as clickable symbol
 * lists inside the sidebar instead of throwaway markdown editor tabs.
 *
 * Calls CodeStore/CodeSearch directly (structured SymbolRecord data, pure
 * SQL) rather than going through CodeToolExecutor's markdown-rendering path —
 * that path also makes a per-query embedding call for search, which this
 * view avoids for interactive use by calling ftsSearch instead.
 *
 * Root switches between two modes: Index/Tools browser (default) and a
 * single tool's output (once a tool has run) — the two aren't shown at once,
 * so a query's results read as a focused view rather than one more branch in
 * a crowded tree. The view's "Back to Tools" title action (pairs.codeResults.clear)
 * returns to the browser; its tooltip/detail text lives in the view's message
 * banner (set from resultsMessage()) instead of on every row of the tool list.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { CodeStore } from '../index/codeStore';
import type { IndexerPhase } from '../index/codeIndexer';
import type { AmbiguousSymbol, EdgeKind, IndexStats, SymbolRecord } from '../index/types';

export type CodeToolGroup = 'Explore' | 'Analyze' | 'Tests';

/** Code-analysis actions, grouped for the "Tools" section. */
export const CODE_TOOL_ENTRIES: Array<{
  label: string;
  command: string;
  icon: string;
  detail: string;
  group: CodeToolGroup;
}> = [
  { label: 'Search Code', command: 'pairs.codeSearch', icon: 'search', detail: 'Find symbols by name, signature, or meaning', group: 'Explore' },
  { label: 'Who Calls / Call Graph', command: 'pairs.whoCalls', icon: 'references', detail: 'Callers or callees of a symbol', group: 'Explore' },
  { label: 'Find Implementations', command: 'pairs.findImplementations', icon: 'type-hierarchy', detail: 'Subtypes / implementors of a symbol', group: 'Explore' },
  { label: 'Code Outline', command: 'pairs.codeOutline', icon: 'list-tree', detail: 'Structure of a file', group: 'Explore' },
  { label: 'Change Impact', command: 'pairs.changeImpact', icon: 'radio-tower', detail: 'Blast radius before renaming/changing/deleting', group: 'Analyze' },
  { label: 'Code Hotspots', command: 'pairs.codeHotspots', icon: 'flame', detail: 'Most complex functions (refactoring candidates)', group: 'Analyze' },
  { label: 'Find Unreferenced Code', command: 'pairs.findDeadCode', icon: 'trash', detail: 'Syntactic only — verify before deleting; excludes exports, entry points, tests', group: 'Analyze' },
  { label: 'File Dependencies', command: 'pairs.fileDeps', icon: 'references', detail: 'Import graph for a file', group: 'Analyze' },
  { label: 'Dependency Cycles', command: 'pairs.dependencyCycle', icon: 'sync-ignored', detail: 'Circular imports', group: 'Analyze' },
  { label: 'Who Tests This', command: 'pairs.whoTests', icon: 'beaker', detail: 'Tests exercising a symbol', group: 'Tests' },
  { label: 'Find Untested', command: 'pairs.findUntested', icon: 'shield', detail: 'Exported symbols with no direct test', group: 'Tests' },
];

export interface ResultGroup {
  label: string;
  symbols: SymbolRecord[];
  /** Optional per-symbol note rendered after the description, e.g. a call-site line or confidence marker. */
  note?: (s: SymbolRecord) => string | undefined;
}

export interface SetResultsOptions {
  /** contextValue applied to symbol nodes; drives view/item/context menus (e.g. dead-code delete). */
  symbolContextValue?: string;
  /** Command that produced these results; resolves the tool's blurb for the view's message banner. */
  sourceCommand?: string;
}

type NodeKind =
  | 'index-root'
  | 'tools-root'
  | 'tool-group'
  | 'action'
  | 'group'
  | 'symbol'
  | 'text-line'
  | 'empty';

export class CodeResultNode extends vscode.TreeItem {
  constructor(
    public readonly kind: NodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly symbol?: SymbolRecord,
    public readonly group?: ResultGroup,
    public readonly toolGroup?: CodeToolGroup
  ) {
    super(label, collapsibleState);
  }
}

/** Latest index status, tracked so the "Index" root always reflects current state. */
interface IndexStatusState {
  phase: IndexerPhase;
  queued: number;
  stats: IndexStats;
}

export class CodeResultsProvider implements vscode.TreeDataProvider<CodeResultNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private resultsTitle: string | null = null;
  private groups: ResultGroup[] = [];
  private textLines: string[] | null = null;
  private symbolContextValue = 'pairs.symbol';
  private sourceCommand: string | undefined;
  private indexStatus: IndexStatusState | undefined;

  constructor(private readonly workspaceRoot: string | undefined) {}

  setIndexStatus(status: IndexStatusState): void {
    this.indexStatus = status;
    this._onDidChangeTreeData.fire();
  }

  setResults(title: string, groups: ResultGroup[], opts?: SetResultsOptions): void {
    this.resultsTitle = title;
    this.groups = groups;
    this.textLines = null;
    this.symbolContextValue = opts?.symbolContextValue ?? 'pairs.symbol';
    this.sourceCommand = opts?.sourceCommand;
    this._onDidChangeTreeData.fire();
  }

  /** For results that don't map to symbols (file paths, dependency cycles). */
  setTextResults(title: string, lines: string[], opts?: SetResultsOptions): void {
    this.resultsTitle = title;
    this.groups = [];
    this.textLines = lines;
    this.sourceCommand = opts?.sourceCommand;
    this._onDidChangeTreeData.fire();
  }

  /** True while the view is showing a tool's output rather than the tool/index browser. */
  isShowingResults(): boolean {
    return this.resultsTitle !== null;
  }

  /** Banner text for the view's `message` — the result title plus the tool's blurb, so
   * that detail lives in the output instead of cluttering every row of the tool list. */
  resultsMessage(): string | undefined {
    if (this.resultsTitle === null) return undefined;
    const detail = this.sourceCommand
      ? CODE_TOOL_ENTRIES.find((e) => e.command === this.sourceCommand)?.detail
      : undefined;
    return detail ? `${this.resultsTitle} — ${detail}` : this.resultsTitle;
  }

  /** Removes symbols (e.g. after an in-place delete) without re-running the query. */
  removeSymbols(ids: number[]): void {
    const idSet = new Set(ids);
    this.groups = this.groups.map((g) => ({ ...g, symbols: g.symbols.filter((s) => !idSet.has(s.id)) }));
    this._onDidChangeTreeData.fire();
  }

  /** All symbols currently shown across every group (used for "delete all"). */
  allSymbols(): SymbolRecord[] {
    return this.groups.flatMap((g) => g.symbols);
  }

  clear(): void {
    this.resultsTitle = null;
    this.groups = [];
    this.textLines = null;
    this.symbolContextValue = 'pairs.symbol';
    this.sourceCommand = undefined;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CodeResultNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CodeResultNode): CodeResultNode[] {
    if (!element) {
      // While a tool's output is showing, the tree is just that output — the
      // Index/Tools browser reappears once the view's "Back to Tools" action clears it.
      if (this.isShowingResults()) {
        return this.resultsChildren();
      }
      return [this.buildIndexRoot(), this.buildToolsRoot()];
    }

    if (element.kind === 'tools-root') {
      const groups = Array.from(new Set(CODE_TOOL_ENTRIES.map((e) => e.group)));
      return groups.map((g) => new CodeResultNode('tool-group', g, vscode.TreeItemCollapsibleState.Expanded, undefined, undefined, g));
    }

    if (element.kind === 'tool-group' && element.toolGroup) {
      return CODE_TOOL_ENTRIES.filter((e) => e.group === element.toolGroup).map((entry) => {
        const item = new CodeResultNode('action', entry.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(entry.icon);
        item.tooltip = entry.detail;
        item.command = { command: entry.command, title: entry.label };
        return item;
      });
    }

    if (element.kind === 'group' && element.group) {
      if (!element.group.symbols.length) {
        return [new CodeResultNode('empty', 'None.', vscode.TreeItemCollapsibleState.None)];
      }
      return this.symbolNodes(element.group);
    }

    return [];
  }

  private resultsChildren(): CodeResultNode[] {
    if (this.textLines) {
      if (!this.textLines.length) return [new CodeResultNode('empty', 'No results.', vscode.TreeItemCollapsibleState.None)];
      return this.textLines.map((line) => new CodeResultNode('text-line', line, vscode.TreeItemCollapsibleState.None));
    }
    if (!this.groups.length) {
      return [new CodeResultNode('empty', 'No results.', vscode.TreeItemCollapsibleState.None)];
    }
    const onlyGroup = this.groups.length === 1 ? this.groups[0] : undefined;
    if (onlyGroup && onlyGroup.label === '') {
      return this.symbolNodes(onlyGroup);
    }
    return this.groups.map((g) => {
      return new CodeResultNode('group', `${g.label} (${g.symbols.length})`, vscode.TreeItemCollapsibleState.Expanded, undefined, g);
    });
  }

  private buildIndexRoot(): CodeResultNode {
    const status = this.indexStatus;
    const label = status ? describeIndexStatus(status.phase, status.queued, status.stats) ?? 'Index' : 'Index — not built yet';
    const node = new CodeResultNode('index-root', label, vscode.TreeItemCollapsibleState.None);
    node.contextValue = 'pairs.indexRoot';
    node.command = { command: 'pairs.rebuildCodeIndex', title: 'Rebuild Code Index' };
    if (!status) {
      node.iconPath = new vscode.ThemeIcon('circle-slash');
    } else if (status.phase === 'scanning' || status.phase === 'indexing' || status.phase === 'embedding') {
      node.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (status.phase === 'error') {
      node.iconPath = new vscode.ThemeIcon('error');
    } else {
      node.iconPath = new vscode.ThemeIcon('database');
    }
    node.tooltip = 'Click to rebuild the code index';
    return node;
  }

  private buildToolsRoot(): CodeResultNode {
    const node = new CodeResultNode('tools-root', 'Tools', vscode.TreeItemCollapsibleState.Expanded);
    node.iconPath = new vscode.ThemeIcon('tools');
    return node;
  }

  private symbolNodes(group: ResultGroup): CodeResultNode[] {
    return group.symbols.map((s) => {
      const node = new CodeResultNode('symbol', s.name, vscode.TreeItemCollapsibleState.None, s);
      const note = group.note?.(s);
      node.description = `${s.kind} · ${s.file}:${s.startLine}${note ? ` · ${note}` : ''}`;
      node.tooltip = s.signature ?? s.qualified;
      node.iconPath = new vscode.ThemeIcon(symbolIcon(s.kind));
      node.contextValue = this.symbolContextValue;
      if (this.workspaceRoot) {
        const uri = vscode.Uri.file(path.join(this.workspaceRoot, s.file));
        const line = Math.max(0, s.startLine - 1);
        node.command = {
          command: 'vscode.open',
          title: 'Open',
          arguments: [uri, { selection: new vscode.Range(line, 0, line, 0) }],
        };
      }
      return node;
    });
  }
}

function symbolIcon(kind: SymbolRecord['kind']): string {
  switch (kind) {
    case 'class':
    case 'struct':
      return 'symbol-class';
    case 'interface':
      return 'symbol-interface';
    case 'enum':
      return 'symbol-enum';
    case 'field':
      return 'symbol-field';
    case 'var':
      return 'symbol-variable';
    case 'macro':
      return 'symbol-constant';
    case 'module':
      return 'symbol-namespace';
    case 'method':
      return 'symbol-method';
    default:
      return 'symbol-function';
  }
}

/** Selection text, else the identifier word under the cursor. Undefined if neither. */
export function resolveSymbolFromEditor(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) return undefined;
  const selected = editor.document.getText(editor.selection).trim();
  if (selected && !selected.includes('\n')) return selected;
  const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_$][A-Za-z0-9_$]*/);
  if (!range) return undefined;
  return editor.document.getText(range);
}

export function describeIndexStatus(phase: string, queued: number, stats: IndexStats): string | undefined {
  if (phase === 'scanning' || phase === 'indexing') {
    return `Indexing… ${queued} queued`;
  }
  if (phase === 'embedding') {
    return `Embedding… ${queued} queued`;
  }
  if (phase === 'error') {
    return 'Index error — see logs';
  }
  return `${stats.files} files, ${stats.symbols} symbols`;
}

/** Where a symbol name was picked up from — lets ambiguity resolution prefer the candidate
 * actually at the cursor instead of asking, when the name was lifted from an editor selection. */
export interface SymbolHint {
  file: string;
  line: number;
}

/** Resolves a name to symbols via CodeStore.lookup. On ambiguity, prefers a `hint` candidate
 * (same file, closest line) over prompting — a name picked up from the editor almost always
 * means the definition nearest that cursor, not a same-named symbol elsewhere in the codebase.
 * Only asks the user when hint doesn't narrow it to one, or there is no hint (name typed manually). */
export async function resolveSymbolRecords(
  store: CodeStore,
  nameOrQualified: string,
  hint?: SymbolHint
): Promise<SymbolRecord[] | undefined> {
  const result = await store.lookup(nameOrQualified);
  if (!isAmbiguous(result)) return result.length ? result : undefined;
  const candidates = result.candidates;
  const hinted = hint ? pickByHint(candidates, hint) : undefined;
  if (hinted) return [hinted];
  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: c.qualified,
      description: `${c.kind} · ${c.file}:${c.startLine}`,
      symbol: c,
    })),
    { title: `"${nameOrQualified}" is ambiguous — pick one`, placeHolder: 'Select a symbol' }
  );
  return picked ? [picked.symbol] : undefined;
}

/** Narrows ambiguous candidates using editor context: same file, then the one enclosing (or
 * else nearest) the cursor line. Returns undefined if the file doesn't narrow it to one. */
function pickByHint(candidates: SymbolRecord[], hint: SymbolHint): SymbolRecord | undefined {
  const sameFile = candidates.filter((c) => c.file === hint.file);
  if (sameFile.length === 0) return undefined;
  if (sameFile.length === 1) return sameFile[0];
  const enclosing = sameFile.filter((c) => c.startLine <= hint.line && hint.line <= c.endLine);
  if (enclosing.length === 1) return enclosing[0];
  const pool = enclosing.length ? enclosing : sameFile;
  return [...pool].sort((a, b) => Math.abs(a.startLine - hint.line) - Math.abs(b.startLine - hint.line))[0];
}

function isAmbiguous(r: SymbolRecord[] | AmbiguousSymbol): r is AmbiguousSymbol {
  return !Array.isArray(r);
}

export async function edgeSymbols(
  store: CodeStore,
  ids: number[],
  kinds: EdgeKind[],
  direction: 'to' | 'from'
): Promise<SymbolRecord[]> {
  const edges = direction === 'to' ? await store.edgesTo(ids, kinds) : await store.edgesFrom(ids, kinds);
  const wantIds = Array.from(new Set(edges.map((e) => (direction === 'to' ? e.fromId : e.toId))));
  const symbols = await Promise.all(wantIds.map((id) => store.get(id)));
  return symbols.filter((s): s is SymbolRecord => s !== null);
}
