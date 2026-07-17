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
  echo "❌ Node >=${REQUIRED_NODE_MAJOR} is required (found: $(node -v 2>/dev/null || echo 'none')). scripts/build-full.sh, build-full.sh's own guard, and the build pipeline generally target 22+."
  echo "   Install/select one, e.g.: nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}"
  exit 1
fi

echo "🔨 Full build pipeline for GIZEM"
echo "   Using $(node -v)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "📦 Step 0: bump version on commit change"
bash scripts/bump-version.sh

echo ""
echo "📦 Step 1: npm install"
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

echo "📦 Step 5: npm run package"
npm run package

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Build complete!"
echo ""
echo "Extension package ready (one platform-specific .vsix per OS — R4):"
ls -lh gizem-*.vsix 2>/dev/null || echo "  (run scripts/package.sh once Phase 1 packaging lands)"
echo ""
echo "Install to VS Code:"
echo "  • UI: Extensions → ⋯ → Install from VSIX"
echo "  • CLI: code --install-extension gizem-*.vsix"
echo "  • Dev: code --extensionDevelopmentPath=\$(pwd)"
