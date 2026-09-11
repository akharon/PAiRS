#!/bin/bash
set -e

# PAiRS VS Code extension installer
# Usage: ./scripts/install.sh
# Builds, packages, and installs the extension to VS Code

echo "🚀 PAiRS installation — full pipeline"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# The store uses the built-in node:sqlite module, which needs Node >= 22.
REQUIRED_NODE_MAJOR=22
node_major() { node -v | sed 's/^v//; s/\..*//'; }

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    echo "ℹ️  Node $(node -v) is too old; switching to Node $REQUIRED_NODE_MAJOR via nvm"
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use "$REQUIRED_NODE_MAJOR" >/dev/null 2>&1 || true
  fi
fi

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "❌ Error: Node >= $REQUIRED_NODE_MAJOR required (node:sqlite), found $(node -v)"
  exit 1
fi
echo "🟢 Node $(node -v)"
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
VSIX_FILE=$(ls -t pairs-*.vsix 2>/dev/null | head -1)

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
echo "  3. PAiRS commands will appear in Command Palette (Cmd+Shift+P)"
echo ""
