/**
 * VS Code LanguageModelTools registration — native Copilot agent-mode tool
 * calling, no MCP config needed. Delegates to the same MemoryToolExecutor /
 * CodeToolExecutor used by the MCP server (invariant #6).
 */

import * as vscode from 'vscode';
import { codeToolSchemas, toolSchemas } from '../mcp/tools';
import type { CodeToolExecutor, CodeToolName, MemoryToolExecutor, ToolName } from '../mcp/tools';
import type { LmToolsIntegration } from './surfaces';

// Derived from the single source of truth (tools.ts) so a newly-added tool is
// registered automatically — no hand-maintained parallel list to drift.
const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];
const CODE_TOOL_NAMES = Object.keys(codeToolSchemas) as CodeToolName[];

function readDisabledTools(): Set<string> {
  const list = vscode.workspace.getConfiguration('pairs').get<string[]>('disabledTools', []);
  return new Set(list);
}

export class LmToolsIntegrationImpl implements LmToolsIntegration {
  constructor(
    private readonly executor: MemoryToolExecutor,
    private readonly codeExecutor?: CodeToolExecutor
  ) {}

  register(_context: vscode.ExtensionContext): vscode.Disposable {
    let toolDisposables = this.registerTools();

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('pairs.disabledTools')) return;
      toolDisposables.dispose();
      toolDisposables = this.registerTools();
    });

    return new vscode.Disposable(() => {
      configListener.dispose();
      toolDisposables.dispose();
    });
  }

  private registerTools(): vscode.Disposable {
    const disabled = readDisabledTools();
    const disposables: vscode.Disposable[] = [];

    for (const name of TOOL_NAMES) {
      if (disabled.has(name)) continue;
      disposables.push(
        vscode.lm.registerTool(`pairs_${name.replace('memory_', '')}`, {
          invoke: async (options: vscode.LanguageModelToolInvocationOptions<unknown>) => {
            const result = await this.executor.execute(name, options.input as never, 'lm-tool');
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
          },
          prepareInvocation: () => ({
            invocationMessage: describeInvocation(name),
          }),
        })
      );
    }

    if (this.codeExecutor) {
      const codeExecutor = this.codeExecutor;
      for (const name of CODE_TOOL_NAMES) {
        if (disabled.has(name)) continue;
        disposables.push(
          vscode.lm.registerTool(`pairs_${name}`, {
            invoke: async (options: vscode.LanguageModelToolInvocationOptions<unknown>) => {
              const result = await codeExecutor.execute(name, options.input as never, 'lm-tool');
              return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
            },
            prepareInvocation: () => ({
              invocationMessage: describeCodeInvocation(name),
            }),
          })
        );
      }
    }

    return vscode.Disposable.from(...disposables);
  }
}

function describeInvocation(name: ToolName): string {
  switch (name) {
    case 'memory_save':
      return 'Saving to workspace memory…';
    case 'memory_search':
      return 'Searching workspace memory…';
    case 'memory_list':
      return 'Listing workspace memory…';
    case 'memory_forget':
      return 'Forgetting a workspace memory…';
    case 'memory_context':
      return 'Building workspace memory briefing…';
  }
}

function describeCodeInvocation(name: CodeToolName): string {
  switch (name) {
    case 'code_search':
      return 'Searching the code index…';
    case 'who_calls':
      return 'Walking the call graph…';
    case 'find_implementations':
      return 'Walking the type hierarchy…';
    case 'code_outline':
      return 'Outlining file structure…';
    case 'find_dead_code':
      return 'Scanning for unreferenced symbols…';
    case 'file_deps':
      return 'Tracing file dependencies…';
    case 'code_hotspots':
      return 'Ranking complexity hotspots…';
    case 'find_duplicates':
      return 'Comparing similar symbols…';
    case 'get_declaration':
      return 'Fetching full declaration…';
    case 'change_impact':
      return 'Assessing change impact…';
    case 'who_tests':
      return 'Finding tests that exercise this symbol…';
    case 'find_untested':
      return 'Scanning for untested exported symbols…';
    case 'dependency_cycle':
      return 'Detecting circular import dependencies…';
    case 'index_status':
      return 'Checking code index freshness…';
  }
}
