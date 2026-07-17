/**
 * TreeView (memories by type), status bar count, Memory Inbox (F1 — pull-based
 * review queue, no toasts/modals), and a simple diff-style review webview for
 * Compress/Simplify/Prune proposals and Rewind previews.
 */

import * as vscode from 'vscode';
import type { MemoryStore } from '../core/store';
import type { InboxItem, UiIntegration } from './surfaces';

class MemoryTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly memoryId?: string
  ) {
    super(label, collapsibleState);
  }
}

class MemoryTreeDataProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: MemoryStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: MemoryTreeItem): Promise<MemoryTreeItem[]> {
    if (!element) {
      const memories = await this.store.list();
      const types = Array.from(new Set(memories.map((m) => m.type)));
      return types.map((t) => {
        const count = memories.filter((m) => m.type === t).length;
        const item = new MemoryTreeItem(capitalize(t), vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'pairs.memoryType';
        item.iconPath = new vscode.ThemeIcon(memoryTypeIcon(t));
        item.description = `${count} memor${count === 1 ? 'y' : 'ies'}`;
        return item;
      });
    }
    const typeLabel = typeof element.label === 'string' ? element.label : '';
    const memories = await this.store.list({ types: [typeLabel.toLowerCase() as never] });
    return memories.map((m) => {
      const item = new MemoryTreeItem(m.title, vscode.TreeItemCollapsibleState.None, m.id);
      item.contextValue = 'pairs.memory';
      item.description = m.description;
      item.tooltip = `${m.id}${m.stale ? ' — ⚠ stale' : ''}`;
      item.command = {
        command: 'pairs.openMemoryFile',
        title: 'Open',
        arguments: [m.id],
      };
      return item;
    });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function memoryTypeIcon(type: string): string {
  switch (type) {
    case 'decision':
      return 'law';
    case 'gotcha':
      return 'warning';
    case 'reference':
      return 'book';
    default:
      return 'note';
  }
}

export class UiIntegrationImpl implements UiIntegration {
  private readonly treeProvider: MemoryTreeDataProvider;
  private treeView: vscode.TreeView<MemoryTreeItem> | null = null;
  private statusBar: vscode.StatusBarItem | null = null;
  private readonly inbox: InboxItem[] = [];
  private inboxStatusBar: vscode.StatusBarItem | null = null;

  constructor(private readonly store: MemoryStore) {
    this.treeProvider = new MemoryTreeDataProvider(store);
  }

  register(context: vscode.ExtensionContext): vscode.Disposable {
    const treeView = vscode.window.createTreeView('pairs.view', {
      treeDataProvider: this.treeProvider,
      canSelectMany: true,
    });
    this.treeView = treeView;

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'pairs.search';
    void this.refreshStatusBar();

    this.inboxStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.inboxStatusBar.command = 'pairs.openInbox';
    this.updateInboxBadge();

    const openFileCmd = vscode.commands.registerCommand('pairs.openMemoryFile', async (id: string) => {
      const memory = await this.store.get(id);
      if (memory) {
        const doc = await vscode.workspace.openTextDocument({ content: memory.body, language: 'markdown' });
        await vscode.window.showTextDocument(doc);
      }
    });

    const deleteCmd = vscode.commands.registerCommand(
      'pairs.memory.delete',
      async (item?: MemoryTreeItem, selected?: MemoryTreeItem[]) => {
        const items = (selected && selected.length ? selected : item ? [item] : this.treeView?.selection ?? []).filter(
          (i): i is MemoryTreeItem => !!i?.memoryId
        );
        const ids = Array.from(new Set(items.map((i) => i.memoryId!)));
        if (!ids.length) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${ids.length} memor${ids.length === 1 ? 'y' : 'ies'}? Recoverable via PAiRS Rewind.`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') return;
        for (const id of ids) {
          await this.store.delete(id, 'user');
        }
        await this.refreshStatusBar();
      }
    );

    const renameCmd = vscode.commands.registerCommand('pairs.memory.rename', async (item?: MemoryTreeItem) => {
      const target = item ?? this.treeView?.selection[0];
      if (!target?.memoryId) return;
      const memory = await this.store.get(target.memoryId);
      if (!memory) return;
      const title = await vscode.window.showInputBox({ prompt: 'Rename memory', value: memory.title });
      if (!title || title === memory.title) return;
      await this.store.update(target.memoryId, { title }, 'user');
      this.treeProvider.refresh();
    });

    const copyIdCmd = vscode.commands.registerCommand('pairs.memory.copyId', async (item?: MemoryTreeItem) => {
      const target = item ?? this.treeView?.selection[0];
      if (!target?.memoryId) return;
      await vscode.env.clipboard.writeText(target.memoryId);
    });

    const refreshTreeCmd = vscode.commands.registerCommand('pairs.refreshTreeView', () => {
      this.treeProvider.refresh();
      void this.refreshStatusBar();
    });

    context.subscriptions.push(
      treeView,
      this.statusBar,
      this.inboxStatusBar,
      openFileCmd,
      deleteCmd,
      renameCmd,
      copyIdCmd,
      refreshTreeCmd
    );
    return vscode.Disposable.from(
      treeView,
      this.statusBar,
      this.inboxStatusBar,
      openFileCmd,
      deleteCmd,
      renameCmd,
      copyIdCmd,
      refreshTreeCmd
    );
  }

  async refreshStatusBar(): Promise<void> {
    if (!this.statusBar) return;
    const count = await this.store.count();
    this.statusBar.text = `$(brain) ${count}`;
    this.statusBar.tooltip = `${count} workspace memories`;
    this.statusBar.show();
    if (this.treeView) {
      this.treeView.badge = { value: count, tooltip: `${count} workspace memories` };
    }
    this.treeProvider.refresh();
  }

  private updateInboxBadge(): void {
    if (!this.inboxStatusBar) return;
    if (this.inbox.length === 0) {
      this.inboxStatusBar.hide();
      return;
    }
    this.inboxStatusBar.text = `$(inbox) ${this.inbox.length}`;
    this.inboxStatusBar.tooltip = 'Memory review inbox — pending compress/prune/health items';
    this.inboxStatusBar.show();
  }

  queueForInbox(item: InboxItem): void {
    this.inbox.push(item);
    this.updateInboxBadge();
  }

  inboxCount(): number {
    return this.inbox.length;
  }

  drainInbox(): InboxItem[] {
    const items = this.inbox.splice(0, this.inbox.length);
    this.updateInboxBadge();
    return items;
  }

  async review<T extends object>(title: string, proposals: T[]): Promise<T[]> {
    if (!proposals.length) return [];
    const items = proposals.map((p, i) => ({
      label: `Proposal ${i + 1}`,
      detail: describeProposal(p),
      picked: true,
      proposal: p,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title,
      canPickMany: true,
      placeHolder: 'Select proposals to approve (all pre-selected)',
    });
    return (picked ?? []).map((p) => p.proposal);
  }
}

function describeProposal(p: object): string {
  if ('rationale' in p && typeof (p as { rationale: unknown }).rationale === 'string') {
    return (p as { rationale: string }).rationale;
  }
  if ('reason' in p && typeof (p as { reason: unknown }).reason === 'string') {
    return (p as { reason: string }).reason;
  }
  return '';
}
