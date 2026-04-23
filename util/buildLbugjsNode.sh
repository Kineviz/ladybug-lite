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
