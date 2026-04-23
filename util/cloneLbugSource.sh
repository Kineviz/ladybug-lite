#!/usr/bin/env bash
# Clone the upstream LadybugDB/ladybug repo at the tag matching the installed
# @ladybugdb/core version, with selective submodule initialization.
#
# Upstream has 8 submodules (extension, benchmark, dataset, tools/{java,
# nodejs,python,rust,wasm}_api); each CI job only needs 1. Cloning all eight
# shallow clones wastes bandwidth and, in the macOS-native job, looked like a
# 6h hang. Inspect lbug-src/.gitmodules for the full list.
#
# Inputs (env):
#   LBUG_SOURCE_DIR   Destination directory (default: $APP_ROOT_DIR/lbug-src)
#   LBUG_SUBMODULES   Which submodules to init, space-separated. Controls
#                     submodule selection:
#                       unset → recurse ALL submodules (local-dev default)
#                       ""    → no submodules (main repo only)
#                       "extension"           → only extension/
#                       "tools/nodejs_api"    → only tools/nodejs_api
#   LBUG_REPO_URL         Override upstream repo URL (default:
#                         https://github.com/LadybugDB/ladybug.git)
#   LBUG_SHALLOW_SUBMODULES  1 (default) to shallow-clone submodules, 0 for full.

set -euo pipefail

APP_ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)
LBUG_SOURCE_DIR="${LBUG_SOURCE_DIR:-$APP_ROOT_DIR/lbug-src}"
CORE_PKG_JSON="$APP_ROOT_DIR/node_modules/@ladybugdb/core/package.json"
REPO_URL="${LBUG_REPO_URL:-https://github.com/LadybugDB/ladybug.git}"
SHALLOW_SUBMODULES="${LBUG_SHALLOW_SUBMODULES:-1}"

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

shallow_args=()
if [ "$SHALLOW_SUBMODULES" = "1" ]; then
    shallow_args=(--shallow-submodules)
fi

if [ -z "${LBUG_SUBMODULES+x}" ]; then
    # Unset: recurse all submodules (convenient for local dev).
    echo "Cloning $REPO_URL @ $TAG with ALL submodules -> $LBUG_SOURCE_DIR"
    git clone --depth 1 --branch "$TAG" --recurse-submodules "${shallow_args[@]}" "$REPO_URL" "$LBUG_SOURCE_DIR"
    exit 0
fi

# Set (possibly empty): clone main repo, then selectively init.
echo "Cloning $REPO_URL @ $TAG (main repo only) -> $LBUG_SOURCE_DIR"
git clone --depth 1 --branch "$TAG" "$REPO_URL" "$LBUG_SOURCE_DIR"

if [ -z "$LBUG_SUBMODULES" ]; then
    echo "LBUG_SUBMODULES is empty; skipping submodule init."
    exit 0
fi

submodule_shallow=()
if [ "$SHALLOW_SUBMODULES" = "1" ]; then
    submodule_shallow=(--depth 1)
fi

# Split on whitespace to feed multiple paths; --recursive handles nested
# submodules inside the selected ones.
# shellcheck disable=SC2086
(
    cd "$LBUG_SOURCE_DIR"
    echo "Initializing submodules: $LBUG_SUBMODULES"
    git submodule update --init --recursive "${submodule_shallow[@]}" -- $LBUG_SUBMODULES
)
