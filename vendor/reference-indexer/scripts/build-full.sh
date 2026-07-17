#!/bin/bash
set -e

REQUIRED_NODE_MAJOR=22

node_major() {
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null || [ -z "$(node_major)" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    CANDIDATE=$(find "$NVM_DIR/versions/node" -maxdepth 1 -name 'v*' 2>/dev/null | sed -E 's#.*/v##' | awk -F. -v min="$REQUIRED_NODE_MAJOR" '$1>=min' | sort -V | tail -1)
    if [ -n "$CANDIDATE" ]; then
      nvm use "$CANDIDATE" > /dev/null
    fi
  fi
fi

if [ "$(node_major)" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null || [ -z "$(node_major)" ]; then
  echo "❌ Node >=${REQUIRED_NODE_MAJOR} is required (found: $(node -v 2>/dev/null || echo 'none')). This extension uses node:sqlite."
  echo "   Install/select one, e.g.: nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}"
  exit 1
fi

echo "🔨 Full build pipeline for PAiRS extension"
echo "   Using $(node -v)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "� Step 0: bump version on commit change"
bash scripts/bump-version.sh

echo ""
echo "�📦 Step 1: npm install"
npm install

echo ""
echo "✓ Step 1 done"
echo ""

echo "🔍 Step 2: npm run typecheck"
npm run typecheck

echo ""
echo "✓ Step 2 done"
echo ""

echo "🧪 Step 3: npm test"
npm test

echo ""
echo "✓ Step 3 done"
echo ""

echo "🏗️  Step 4: npm run build"
npm run build

echo ""
echo "✓ Step 4 done"
echo ""

echo "📦 Step 5: npm run package (standard profile)"
npm run package

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Build complete!"
echo ""
echo "Extension package ready (standard profile):"
ls -lh pairs-*.vsix | grep -v minimal | grep -v full
echo ""
echo "Other profiles available:"
echo "  • npm run package:minimal — no dependencies (~5-10 MB)"
echo "  • npm run package:full   — all dependencies (~100-150 MB)"
echo "  • npm run package:all    — build all three profiles"
echo ""
echo "Install to VS Code:"
echo "  • UI: Extensions → ⋯ → Install from VSIX"
echo "  • CLI: code --install-extension pairs-*.vsix"
echo "  • Dev: code --extensionDevelopmentPath=\$(pwd)"
