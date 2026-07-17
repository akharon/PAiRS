/**
 * MCP server registration (VS Code ≥1.101). One stdio server definition per
 * workspace folder, pointing at the bundled dist/mcp-server.js with that
 * folder's db path — or, when `pairs.sharedDaemon` is enabled, at
 * dist/mcp-proxy.js, which relays to one daemon shared across all clients
 * (see docs/DaemonDesign.md). The proxy falls back to the same in-process
 * behavior as mcp-server.js if the daemon is unreachable, so this switch is
 * safe to flip without losing functionality.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { McpIntegration } from './surfaces';

export class McpProviderIntegration implements McpIntegration {
  constructor(private readonly extensionPath: string) {}

  register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider: vscode.McpServerDefinitionProvider = {
      provideMcpServerDefinitions: () => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const cfg = vscode.workspace.getConfiguration('pairs');
        const sharedDaemon = cfg.get<boolean>('sharedDaemon', false);
        const disabledTools = cfg.get<string[]>('disabledTools', []);
        const disabledArgs = disabledTools.length ? ['--disabled-tools', disabledTools.join(',')] : [];
        return folders.map((folder) => {
          // Must match extension.ts, which opens both stores under the
          // workspace-relative `.pairs/` directory (same DBs, both transports).
          const pairsDir = path.join(folder.uri.fsPath, '.pairs');

          if (sharedDaemon) {
            // The proxy relays to a daemon shared across all clients/workspaces, so a
            // per-workspace disabledTools list can't be applied at this layer (out of
            // scope for now — the shared daemon defaults to off).
            const proxyScript = path.join(this.extensionPath, 'dist', 'mcp-proxy.js');
            return new vscode.McpStdioServerDefinition(
              `PAiRS (${folder.name})`,
              process.execPath,
              [proxyScript, '--workspace', folder.uri.fsPath]
            );
          }

          const serverScript = path.join(this.extensionPath, 'dist', 'mcp-server.js');
          const dbPath = path.join(pairsDir, 'memory.db');
          const okfRoot = path.join(folder.uri.fsPath, '.vscode', 'memory');
          const codeDbPath = path.join(pairsDir, 'code.db');
          return new vscode.McpStdioServerDefinition(
            `PAiRS (${folder.name})`,
            process.execPath,
            [serverScript, '--db', dbPath, '--okf', okfRoot, '--code-db', codeDbPath, ...disabledArgs]
          );
        });
      },
    };

    return vscode.lm.registerMcpServerDefinitionProvider('pairs.mcpProvider', provider);
  }
}
