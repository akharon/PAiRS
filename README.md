# PAiRS

**Derived code-graph index + architectural rule engine for AI coding agents.**

PAiRS builds a queryable code dependency graph from your workspace and evaluates architectural rules in real-time. Use it to understand module relationships, find symbols, and enforce constraints as you code.

## Quick Start

### Installation

1. **Open VS Code** and go to **Extensions** (Ctrl+Shift+X)
2. **Search for "PAiRS"** and install
3. **Reload** the VS Code window

The extension activates automatically on startup and indexes your workspace in the background.

### VS Code Commands

Open the command palette (**Ctrl+Shift+P**) and type:

- **PAiRS: Re-index Workspace** — Rebuild the code graph (auto-runs on activation and file changes)
- **PAiRS: Find Symbol** — Search and jump to any symbol in the workspace
- **PAiRS: Check Rules** — Evaluate architectural rules (run manually or auto-triggers on file save)
- **PAiRS: Show Module Map** — Visualize module subsystems and dependency drift

### Rule Enforcement

Create `.pairs/rules.ron` in your workspace root to define architectural constraints. Rules appear as inline diagnostics (squiggles) in the editor.

Example:
```ron
rules = [
  (
    name: "no_cycle",
    query: "MATCH (a:Module)-[*]->(a) RETURN a",
    severity: "error",
    explanation: "Cyclic module dependency",
  ),
]
```

### Status Bar

The status bar (bottom right) shows:
- **Symbol count** — Total symbols indexed
- **Fuzzy rate** — Percentage of symbols with fuzzy resolution (lower is better)

Click it to re-index.

## Features

- **Live indexing** — Code graph updates automatically on file save
- **Symbol lookup** — Quick search with go-to-definition
- **Diagnostics** — Real-time inline constraint violations
- **MCP integration** — Exposes all PAiRS tools to Claude/Copilot agents
- **Multi-root workspaces** — One index per folder, separate MCP server per folder

## Configuration

Open VS Code Settings and search for "PAiRS":

- **pairs.disabledTools** — Comma-separated MCP tool names to disable (e.g., `"analyze"`)

## Troubleshooting

**"PAiRS: ... command not found"**
- Run **Developer: Reload Window** (Ctrl+Shift+P)
- Check **Help → Toggle Developer Tools** for errors

**Index not updating**
- Run **PAiRS: Re-index Workspace** manually
- Check that `.pairs/` folder is writable

**Rules not showing**
- Ensure `.pairs/rules.ron` exists and is valid RON syntax
- Check the **Problems** panel for parse errors

## Learn More

- [Architecture & design](plan.md)
- [Benchmark results](BENCHMARKS.md)
- [CLI reference](https://github.com/mkyr/pairs#cli)

---

**License:** MIT | **GitHub:** [mkyr/pairs](https://github.com/mkyr/pairs)
