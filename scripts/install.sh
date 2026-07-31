#!/bin/bash
set -e

# GIZEM VS Code extension installer
# Usage: ./scripts/install.sh
# Builds, packages, and installs the extension to VS Code

echo "🚀 GIZEM installation — full pipeline"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "📦 Step 1: Build"
npm run build
echo "✅ Build complete"
echo ""

echo "📥 Step 2: Fetch grammars"
npm run fetch-grammars
echo "✅ Grammars fetched"
echo ""

echo "🧪 Step 3: Run tests"
npm test
echo "✅ Tests passed"
echo ""

echo "📦 Step 4: Package extension"
npm run package
echo "✅ Packaging complete"
echo ""

# Find the latest .vsix file
VSIX_FILE=$(ls -t gizem-*.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
  echo "❌ Error: No .vsix file found"
  exit 1
fi

echo "📥 Step 5: Install to VS Code"
code --install-extension "$VSIX_FILE"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Installation complete!"
echo ""
echo "Installed package:"
ls -lh "$VSIX_FILE"
echo ""
echo "Next steps:"
echo "  1. Reload VS Code window (Cmd+Shift+P → Reload Window)"
echo "  2. Open a Rust workspace"
echo "  3. GIZEM commands will appear in Command Palette (Cmd+Shift+P)"
echo ""
