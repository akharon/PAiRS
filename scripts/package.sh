#!/bin/bash
set -e

# PAiRS packaging script with multiple profiles
# Usage: ./scripts/package.sh [profile]
# Profiles:
#   minimal   - No dependencies (users install transformers separately for embeddings)
#   standard  - Production runtime deps only (default, ~30-50MB)
#   full      - All dependencies + bundled transformers (largest, ~100-150MB)
#   all       - Build all three profiles

PROFILE="${1:-standard}"
VERSION=$(grep '"version"' package.json | head -1 | grep -o '[0-9]\.[0-9]\.[0-9]')

echo "🔨 PAiRS packaging — profile: $PROFILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "🔖 Bumping version on commit change..."
bash "$(dirname "$0")/bump-version.sh"

echo ""

# Clean up old packages
echo "🧹 Cleaning old packages..."
rm -f pairs-*.vsix

# Function to package with a specific profile
package_profile() {
  local profile_name=$1
  local ignore_file=$2
  local output_suffix=$3

  echo ""
  echo "📦 Building $profile_name profile..."
  echo "   Using: $ignore_file"

  # Copy appropriate .vscodeignore
  if [ -f "$ignore_file" ]; then
    cp "$ignore_file" .vscodeignore
  else
    echo "❌ Error: $ignore_file not found"
    exit 1
  fi

  # The standard profile excludes @img/* (sharp's native binaries, ~33MB) to
  # save space, but transformers.node.mjs does a static `import sharp from
  # "sharp"` at module load — leaving the real sharp package in place with no
  # native binary makes that import throw and breaks embeddings entirely.
  # Swap in a stub sharp package for the duration of packaging only.
  #
  # onnxruntime-node is swapped out unconditionally (all profiles that ship
  # transformers): its prebuilt native binding requires a newer glibc than
  # some environments provide (e.g. VS Code installed via snap sandboxes
  # against an older glibc through its core20 base), crashing the extension
  # host on activation. onnxruntime-web's Node build is pure WASM with no
  # native binary, so it has no glibc dependency, and implements the same
  # InferenceSession API transformers.js actually calls.
  if [ "$profile_name" = "Standard" ] || [ "$profile_name" = "Full" ]; then
    mv node_modules/onnxruntime-node node_modules/onnxruntime-node.real
    cp -r scripts/stubs/onnxruntime-node node_modules/onnxruntime-node
    trap 'rm -rf node_modules/onnxruntime-node; mv node_modules/onnxruntime-node.real node_modules/onnxruntime-node' RETURN
  fi

  if [ "$profile_name" = "Standard" ]; then
    mv node_modules/sharp node_modules/sharp.real
    cp -r scripts/stubs/sharp node_modules/sharp
  fi

  # Package with vsce
  vsce package --out "pairs-${VERSION}${output_suffix}.vsix"

  if [ "$profile_name" = "Standard" ]; then
    rm -rf node_modules/sharp
    mv node_modules/sharp.real node_modules/sharp
  fi

  if [ "$profile_name" = "Standard" ] || [ "$profile_name" = "Full" ]; then
    rm -rf node_modules/onnxruntime-node
    mv node_modules/onnxruntime-node.real node_modules/onnxruntime-node
    trap - RETURN
  fi

  # Show file size
  local size=$(ls -lh "pairs-${VERSION}${output_suffix}.vsix" | awk '{print $5}')
  echo "   ✓ Created: pairs-${VERSION}${output_suffix}.vsix ($size)"
}

# Build profiles based on argument
case "$PROFILE" in
  minimal)
    package_profile "Minimal" ".vscodeignore.minimal" "-minimal"
    ;;
  standard)
    package_profile "Standard" ".vscodeignore.standard" ""
    ;;
  full)
    package_profile "Full" ".vscodeignore.full" "-full"
    ;;
  all)
    package_profile "Minimal" ".vscodeignore.minimal" "-minimal"
    package_profile "Standard" ".vscodeignore.standard" ""
    package_profile "Full" ".vscodeignore.full" "-full"
    ;;
  *)
    echo "❌ Unknown profile: $PROFILE"
    echo ""
    echo "Available profiles:"
    echo "  minimal   - No dependencies (smallest, ~5-10MB)"
    echo "  standard  - Production runtime deps only (default, ~30-50MB)"
    echo "  full      - All dependencies included (largest, ~100-150MB)"
    echo "  all       - Build all three profiles"
    exit 1
    ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Packaging complete!"
echo ""
echo "Generated packages:"
ls -lh pairs-*.vsix | awk '{printf "  • %s (%s)\n", $NF, $5}'
echo ""
echo "Install to VS Code:"
echo "  code --install-extension pairs-*.vsix"
echo ""
