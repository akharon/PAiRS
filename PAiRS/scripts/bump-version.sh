#!/bin/bash
# Bump the minor version in package.json when the git HEAD commit SHA has
# changed since the last build. Stores the last-build SHA in a sidecar JSON
# file at <repo-root>/.pairs/.build-state.json.
#
# This ensures that every build produces a distinct version number, so the
# extension's checkVersion() mechanism (which compares the stored extension
# version against the running version) detects the change and forces a fresh
# index rebuild after install/reinstall.
#
# Usage: ./scripts/bump-version.sh
#   Exit code 0: version was bumped (or is already up to date)
#   Exit code 1: not a git repo, no commits, or package.json parse error

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

STATE_DIR="$PROJECT_ROOT/.pairs"
STATE_FILE="$STATE_DIR/.build-state.json"

# --- Get current HEAD SHA ---------------------------------------------------
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || true)
if [ -z "$HEAD_SHA" ]; then
  echo "⚠️  bump-version: not a git repo or no commits — skipping version bump"
  exit 0
fi

# --- Read last-build SHA ----------------------------------------------------
LAST_SHA=""
if [ -f "$STATE_FILE" ]; then
  LAST_SHA=$(jq -r '.lastBuildSha // ""' "$STATE_FILE" 2>/dev/null || echo "")
fi

# --- Same SHA → nothing to do ------------------------------------------------
if [ "$HEAD_SHA" = "$LAST_SHA" ]; then
  exit 0
fi

# --- SHA changed → bump minor version ---------------------------------------
CURRENT_VERSION=$(jq -r '.version' package.json 2>/dev/null || echo "")
if [ -z "$CURRENT_VERSION" ]; then
  echo "❌ bump-version: could not read version from package.json"
  exit 1
fi

# Parse major.minor.patch
MAJOR="${CURRENT_VERSION%%.*}"
REST="${CURRENT_VERSION#*.}"
MINOR="${REST%%.*}"
PATCH="${REST#*.}"

# Bump minor, reset patch to 0
NEW_MINOR=$((MINOR + 1))
NEW_VERSION="${MAJOR}.${NEW_MINOR}.0"

echo "📦 bump-version: ${CURRENT_VERSION} → ${NEW_VERSION} (commit ${HEAD_SHA:0:7})"

# Write new version to package.json
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp
mv package.json.tmp package.json

# --- Persist new SHA ---------------------------------------------------------
mkdir -p "$STATE_DIR"
printf '{"lastBuildSha":"%s"}\n' "$HEAD_SHA" > "$STATE_FILE"
