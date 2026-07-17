/**
 * VS Code integration surfaces. Each is an independently registrable unit
 * wired up in extension.ts; all funnel into the same MemoryToolExecutor /
 * lifecycle services so behavior is identical across entry points.
 */

import type * as vscode from 'vscode';

/**
 * 1. MCP server registration (VS Code ≥1.101).
 * Implements vscode.McpServerDefinitionProvider: returns one
 * McpStdioServerDefinition per workspace folder launching
 * `node dist/mcp-server.js --db <workspaceStorage>/memory.db --okf <ws>/.vscode/memory`.
 * Copilot agent mode picks it up automatically.
 */
export interface McpIntegration {
  register(context: vscode.ExtensionContext): vscode.Disposable;
}

/**
 * 2. Language Model Tools (native Copilot tool calling, no MCP needed).
 * vscode.lm.registerTool for each entry in toolSchemas; names & JSON schemas
 * also declared under `languageModelTools` in package.json. Tool
 * `toolReferenceName`s: #memorySave, #memorySearch, #memoryList, #memoryForget.
 */
export interface LmToolsIntegration {
  register(context: vscode.ExtensionContext): vscode.Disposable;
}

/**
 * 3. Chat participant `@memory`.
 * Slash commands: /remember <text>, /search <query>, /list, /forget <id>,
 * /compress, /simplify, /rewind. Free-form prompts → recall + summarize via
 * the request's model.
 */
export interface ChatIntegration {
  register(context: vscode.ExtensionContext): vscode.Disposable;
}

/**
 * 4. Commands (palette). Ids under `pairs.*`:
 * saveSelection, saveNote, search, compress, simplify, pruneReview, rewind,
 * clear (modal confirm + auto OKF backup), exportBundle, importBundle,
 * rebuildIndex, stats, and the transparency/control set:
 * - showAgentContext — render the exact context/memories agents currently see
 *   (with score traces) in a readonly editor (F2)
 * - healthCheck — run HealthChecker, queue findings into the inbox (F6)
 * - undoLastCapture — one-keystroke inversion of the most recent create event (F3)
 * - setupClaudeCode — write the `claude mcp add` config for the CLI (F4)
 */
export interface CommandsIntegration {
  register(context: vscode.ExtensionContext): vscode.Disposable;
}

/**
 * 5. UI: TreeView `pairs.view` (group by type → memory; click opens
 * the OKF .md file), status bar item with memory count, and a diff-style
 * webview used to review Compress/Simplify/Prune proposals and Rewind
 * previews (approve/reject per item).
 */
export interface UiIntegration {
  register(context: vscode.ExtensionContext): vscode.Disposable;
  /** Show a review session; resolves with the approved subset. */
  review<T extends object>(title: string, proposals: T[]): Promise<T[]>;
  /**
   * Memory Inbox (F1): pending review items (compress/prune proposals, health
   * findings, agent-initiated captures when confirmation is configured) queue
   * here and only update the TreeView badge. Flow-state rule: NO toasts, NO
   * modals, NO proactive chat messages — review is always pull-based.
   */
  queueForInbox(item: InboxItem): void;
  inboxCount(): number;
}

export interface InboxItem {
  kind: 'merge' | 'simplify' | 'prune' | 'health' | 'capture';
  title: string;
  /** Opaque payload handed back to the originating service on review. */
  payload: unknown;
  queuedAt: string; // ISO 8601
}

/** Settings (contributed under `pairs.*` in package.json). */
export interface MemorySettings {
  /** Per-workspace kill switch: false → all surfaces unregister, agents see
   * no memory tools (F3). Default true. */
  enabled: boolean;
  /** Agents may save without confirmation. Default false — captures from
   * mcp/lm-tool actors queue in the inbox until approved (F3). */
  autoCapture: boolean;
  /** Hard cap (approx tokens) on memory context injected into any surface;
   * the ranker fills the budget best-first. Default 1500 (F3). */
  contextTokenBudget: number;
  /** Auto-export OKF bundle on every mutation (default true). */
  okfAutoExport: boolean;
  /** Enable MiniLM embeddings (default true; false → FTS-only recall). */
  embeddingsEnabled: boolean;
  /** Recency half-life in days for scoring (default 90). */
  recencyHalfLifeDays: number;
  /** Body length that makes a memory a Simplify candidate (default 800). */
  simplifyThresholdChars: number;
  /** Duplicate-cluster cosine threshold for Compress (default 0.82). */
  duplicateThreshold: number;
}

/** Settings for the code indexer (contributed under `pairs.codeIndex.*`). */
export interface CodeIndexSettings {
  /** Kill switch: false → code_search/who_calls/find_implementations/code_outline
   * unregister entirely and no background indexing runs. Default true. */
  enabled: boolean;
  /** Extra exclude globs on top of .gitignore. */
  exclude: string[];
  /** Skip files larger than this. Default 1024 (1 MB). */
  maxFileSizeKb: number;
  /** Reuse the memory embeddings flag for the optional symbol-embedding layer. */
  embeddingsEnabled: boolean;
}
