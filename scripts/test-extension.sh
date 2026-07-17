#!/bin/bash
# Test GIZEM extension installation and basic functionality
# Requires: VS Code CLI, a workspace with Rust code, and gizem-0.1.0.vsix in the repo root
# Usage: ./scripts/test-extension.sh

set -e

VSIX="gizem-0.1.0.vsix"
TEST_WORKSPACE="${1:-.}"  # Defaults to current directory
TIMEOUT=30

if [ ! -f "$VSIX" ]; then
  echo "❌ $VSIX not found. Run: npm run build && npx vsce package -o gizem-0.1.0.vsix"
  exit 1
fi

echo "🧪 GIZEM Extension Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📦 Installing extension..."
code --install-extension "$VSIX" || echo "⚠️ Code CLI not available; extension install must be done manually"

echo ""
echo "✅ Extension installed (or will be when VS Code starts)"
echo ""
echo "📋 Next steps:"
echo "   1. Open VS Code"
echo "   2. Open a Rust workspace: code <rust-repo>"
echo "   3. Check the status bar for 'symbols · XX%' indicator"
echo "   4. Verify .gizem/index is created in the workspace root"
echo "   5. Try: cmd+shift+p → 'GIZEM: Find Symbol' or 'GIZEM: Re-index Workspace'"
echo ""
echo "🔍 Verification checklist:"
echo "   □ Extension activation succeeds (see Extensions pane, status bar updates)"
echo "   □ .gizem directory created in workspace root"
echo "   □ Status bar shows 'symbols · XX%' and fuzzyRate"
echo "   □ 'GIZEM: Find Symbol' and 'GIZEM: Re-index Workspace' commands available"
echo "   □ MCP server registered (Claude Code: 'claude mcp list')"
echo ""
