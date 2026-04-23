#!/usr/bin/env bash
# Clone the upstream LadybugDB/ladybug repo at the tag matching the installed
# @ladybugdb/core version. Idempotent: if $LBUG_SOURCE_DIR already contains a
# checkout, skip the clone.
#
# Inputs (env):
#   LBUG_SOURCE_DIR  Destination directory (default: $APP_ROOT_DIR/lbug-src)
#
# Why this exists: @ladybugdb/core@0.15.x no longer ships lbug-source/ inside
# its npm tarball, so the Linux/macOS build jobs need the source from git.

set -euo pipefail

APP_ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)
LBUG_SOURCE_DIR="${LBUG_SOURCE_DIR:-$APP_ROOT_DIR/lbug-src}"
CORE_PKG_JSON="$APP_ROOT_DIR/node_modules/@ladybugdb/core/package.json"
REPO_URL="${LBUG_REPO_URL:-https://github.com/LadybugDB/ladybug.git}"

if [ ! -f "$CORE_PKG_JSON" ]; then
    echo "Error: $CORE_PKG_JSON not found. Run 'yarn add @ladybugdb/core' first." >&2
    exit 1
fi

VER=$(node -p "require('$CORE_PKG_JSON').version")
TAG="v${VER}"

if [ -d "$LBUG_SOURCE_DIR/.git" ]; then
    echo "LBUG_SOURCE_DIR already exists at $LBUG_SOURCE_DIR; skipping clone."
    exit 0
fi

echo "Cloning $REPO_URL @ $TAG -> $LBUG_SOURCE_DIR"
git clone --depth 1 --branch "$TAG" "$REPO_URL" "$LBUG_SOURCE_DIR"
