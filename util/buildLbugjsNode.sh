#!/usr/bin/env bash
# Build the native Node.js addon (lbugjs.node) from a Ladybug source checkout
# and copy the result to OUTPUT_PATH.
#
# Inputs (env):
#   LBUG_SOURCE_DIR  Path to a checkout of github.com/LadybugDB/ladybug (required)
#   OUTPUT_PATH      Absolute path for the produced .node file (required)

set -euo pipefail

: "${LBUG_SOURCE_DIR:?LBUG_SOURCE_DIR is required}"
: "${OUTPUT_PATH:?OUTPUT_PATH is required}"

APP_ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)
CORE_PKG_JSON="$APP_ROOT_DIR/node_modules/@ladybugdb/core/package.json"

# Cache check: if prebuilt/<target> already exists in the repo checkout and
# prebuilt/version matches the currently-installed @ladybugdb/core version,
# skip the 15-20 minute compile and just copy the cached binary to the
# expected OUTPUT_PATH. Lets same-version re-runs (e.g. CI reruns triggered
# by a sibling job's push) finish in seconds instead of ~20 min.
# Set LBUG_FORCE_REBUILD=1 to bypass.
CACHED_BIN="$APP_ROOT_DIR/prebuilt/$(basename "$OUTPUT_PATH")"
VERSION_FILE="$APP_ROOT_DIR/prebuilt/version"
if [ "${LBUG_FORCE_REBUILD:-0}" != "1" ] \
    && [ -f "$CACHED_BIN" ] \
    && [ -f "$VERSION_FILE" ] \
    && [ -f "$CORE_PKG_JSON" ]; then
    cached_ver=$(head -n 1 "$VERSION_FILE" | tr -d '[:space:]')
    target_ver=$(node -p "require('$CORE_PKG_JSON').version")
    if [ "$cached_ver" = "$target_ver" ]; then
        echo "Cache hit: $CACHED_BIN already built for v$target_ver, skipping compile."
        mkdir -p "$(dirname "$OUTPUT_PATH")"
        cp -f "$CACHED_BIN" "$OUTPUT_PATH"
        echo "Copied cached binary -> $OUTPUT_PATH"
        exit 0
    fi
    echo "Cache miss (prebuilt/version=$cached_ver, target=$target_ver); rebuilding."
fi

NODEJS_API_DIR="$LBUG_SOURCE_DIR/tools/nodejs_api"

if [ ! -d "$NODEJS_API_DIR" ]; then
    echo "Error: $NODEJS_API_DIR not found. Is LBUG_SOURCE_DIR a valid ladybug checkout?" >&2
    exit 1
fi

# tools/nodejs_api is a git submodule upstream. If the clone forgot
# --recurse-submodules the directory exists but is empty, and yarn silently
# walks up the tree to the repo-root package.json, running the wrong scripts.
# Refuse to proceed.
if [ ! -f "$NODEJS_API_DIR/package.json" ]; then
    echo "Error: $NODEJS_API_DIR/package.json missing. Did the submodule fail to init? Try re-running with 'git submodule update --init --recursive' in $LBUG_SOURCE_DIR." >&2
    exit 1
fi

cd "$NODEJS_API_DIR"
yarn install
yarn build

BUILT_NODE="$NODEJS_API_DIR/build/lbugjs.node"
if [ ! -f "$BUILT_NODE" ]; then
    echo "Error: build did not produce $BUILT_NODE" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
cp -f "$BUILT_NODE" "$OUTPUT_PATH"
echo "Wrote $OUTPUT_PATH"
file "$OUTPUT_PATH" || true
