# Agent-hook recipes (plan.md 2.8)

Wire `check_rules` after every agent edit so architectural violations are caught
and self-corrected inside the session — the V4 loop. All recipes assume the
workspace is indexed (`pairs index` or the VS Code extension running) and has a
`.pairs/rules.ron`.

## Claude Code — post-edit hook

`.claude/settings.json` in the guarded repo:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "node <pairs>/dist/cli.js check --format json 2>/dev/null | node <pairs>/recipes/claude-hook-filter.mjs" }
        ]
      }
    ]
  }
}
```

`claude-hook-filter.mjs` exits 2 (blocking feedback to the agent) only when a
**new confirmed error** violation exists; `possible` findings are passed through
as non-blocking stderr. The agent receives each violation's `explain` verbatim
and can self-correct.

Alternatively, register the MCP server and let the agent call the tool itself:

```sh
claude mcp add pairs -- node <pairs>/dist/mcp-server.js --db "$PWD/.pairs/index"
```

then instruct in CLAUDE.md: *"After completing code edits, call the
`check_rules` tool and fix any confirmed violations before finishing."*

## Cursor — rules file

`.cursor/rules/pairs.mdc`:

```
---
description: Architectural guardrails via PAiRS
alwaysApply: true
---

After any code edit, run `check_rules` from the pairs MCP server (or
`node <pairs>/dist/cli.js check`). If it reports confirmed violations, fix them
using each violation's `why:` explanation before declaring the task done.
`possible` findings are advisory — verify, don't blindly fix.
```

MCP registration for Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pairs": { "command": "node", "args": ["<pairs>/dist/mcp-server.js", "--db", "${workspaceFolder}/.pairs/index"] }
  }
}
```

## Pre-commit

`.git/hooks/pre-commit` (or via husky/lefthook):

```sh
#!/bin/sh
node <pairs>/dist/cli.js check --baseline .pairs/baseline.json || {
  echo "pairs: new confirmed architecture violations — commit blocked." >&2
  exit 1
}
```

## CI (GitHub Actions + code scanning)

```yaml
- run: node <pairs>/dist/cli.js check --ci --baseline .pairs/baseline.json --format sarif > pairs.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: pairs.sarif }
```

Exit-code contract (all surfaces): **1 only on new confirmed error-severity
violations**; `possible` (fuzzy-edge-derived) findings and baselined debt never
fail (R1).
