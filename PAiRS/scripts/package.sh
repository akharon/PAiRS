#!/bin/bash
set -e

# PAiRS VS Code extension packaging
# Usage: ./scripts/package.sh
# Packages the extension as a .vsix file using vsce

VERSION=$(grep '"version"' package.json | head -1 | grep -oP '"\K[0-9]+\.[0-9]+\.[0-9]+')
VSIX_FILE="pairs-${VERSION}.vsix"

echo "🔨 PAiRS packaging — version: $VERSION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "📦 Building extension package..."
rm -f pairs-*.vsix
npx vsce package -o "$VSIX_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Packaging complete!"
echo ""
echo "Generated package:"
ls -lh "$VSIX_FILE"
echo ""
echo "Install to VS Code:"
echo "  code --install-extension $VSIX_FILE"
echo ""
