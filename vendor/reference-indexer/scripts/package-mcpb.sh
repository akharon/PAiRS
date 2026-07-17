#!/bin/bash
set -e

# Package PAiRS as a Claude Desktop MCPB extension (.mcpb).
# A .mcpb is a zip of manifest.json + a bundled Node MCP server — this is a
# read-only companion to the VS Code extension: it never indexes on its own,
# it only reads the .pairs/memory.db (and code.db) that the extension writes.

# Bump version if commit changed — the .mcpb file name embeds the version.
bash "$(dirname "$0")/bump-version.sh"

VERSION=$(grep '"version"' package.json | head -1 | grep -o '[0-9]\.[0-9]\.[0-9]')
STAGE_DIR="build/mcpb"
OUT_FILE="pairs-${VERSION}.mcpb"

echo "🔨 Building..."
npm run build

echo "🧹 Staging $STAGE_DIR..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/server"

sed "s/__VERSION__/${VERSION}/" assets/mcpb/manifest.template.json > "$STAGE_DIR/manifest.json"
cp dist/mcp-desktop.js "$STAGE_DIR/server/index.js"
if [ -f dist/mcp-desktop.js.map ]; then
  cp dist/mcp-desktop.js.map "$STAGE_DIR/server/index.js.map"
fi

rm -f "$OUT_FILE"

if npx --no-install @anthropic-ai/mcpb --version >/dev/null 2>&1; then
  echo "📦 Packing with @anthropic-ai/mcpb (validates manifest)..."
  npx --no-install @anthropic-ai/mcpb pack "$STAGE_DIR" "$OUT_FILE"
else
  echo "📦 @anthropic-ai/mcpb CLI not installed — falling back to plain zip."
  (cd "$STAGE_DIR" && zip -r "../../$OUT_FILE" .)
fi

echo ""
echo "✅ Built $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
echo ""
echo "Install in Claude Desktop: Settings → Extensions → Install extension… → pick $OUT_FILE"
echo "(or just double-click the .mcpb file)"
