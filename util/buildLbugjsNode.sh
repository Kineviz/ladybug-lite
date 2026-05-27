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
    # Probe the actual binary at $CACHED_BIN via dlopen + NodeDatabase.getVersion().
    # getVersion.js absorbs every failure mode (file missing, musl/glibc
    # mismatch, ABI mismatch, missing export, native crash caught by Node)
    # and prints the sentinel "0.0.0", so this assignment never trips set -e
    # — `|| bin_ver="0.0.0"` is belt-and-suspenders for the case where the
    # node process is killed by an uncatchable signal (e.g. SIGSEGV from
    # truly broken native code) before it can print the sentinel.
    bin_ver=$(LBUG_BIN_PATH="$CACHED_BIN" node "$APP_ROOT_DIR/util/getVersion.js" 2>/dev/null) || bin_ver="0.0.0"
    if [ "$cached_ver" = "$target_ver" ] && [ "$bin_ver" = "$target_ver" ]; then
        echo "Cache hit: $CACHED_BIN already built for v$target_ver (binary self-reports $bin_ver), skipping compile."
        mkdir -p "$(dirname "$OUTPUT_PATH")"
        cp -f "$CACHED_BIN" "$OUTPUT_PATH"
        echo "Copied cached binary -> $OUTPUT_PATH"
        exit 0
    fi
    echo "Cache miss (prebuilt/version=$cached_ver, binary=$bin_ver, target=$target_ver); rebuilding."
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

# yarn install in nodejs_api/ pulls cmake-js + other build deps that
# upstream's tools/nodejs_api/build.js / CMakeLists.txt expect. Required
# even though we don't invoke `yarn build` directly below — `make nodejs`
# at the upstream root ends up calling into this nodejs_api subproject.
cd "$NODEJS_API_DIR"
yarn install

# Build via the upstream Makefile's `nodejs` target from $LBUG_SOURCE_DIR,
# NOT via the standalone `yarn build` in nodejs_api/.
#
# `yarn build` inside nodejs_api/ runs upstream's build.js which does
#     cmake -S . -B build -DLBUG_SOURCE_DIR=...
# from the nodejs_api subdir. On @ladybugdb/core 0.16.x this fails on both
# Linux and macOS with:
#     CMake Error at CMakeLists.txt:119:
#       The Node.js addon requires the lbug target or
#       LBUG_NODEJS_USE_PRECOMPILED_LIB=TRUE.
# The `lbug` cmake target only exists when cmake is configured from the
# upstream root; the standalone subdir cmake can't see it.
#
# `make nodejs` at $LBUG_SOURCE_DIR is the same path @ladybugdb/core's own
# install.js drives (see node_modules/@ladybugdb/core/install.js:144) — it
# configures cmake at the upstream root, so the `lbug` target is in scope,
# then builds `lbug` + the nodejs addon in one tree. Output still lands at
# tools/nodejs_api/build/lbugjs.node, so the BUILT_NODE check + copy below
# is unchanged.
#
# NB: earlier successful CI builds for v0.16.1 on Alpine were cache hits
# on stale v0.15.x binaries (the old cache check only compared
# prebuilt/version, not the binary's self-reported version). The recently
# added bin_ver probe in the cache check correctly detects this, falls
# through to rebuild, and that's where the cmake error surfaces.
NUM_THREADS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
echo "Building via 'make nodejs' from $LBUG_SOURCE_DIR (NUM_THREADS=$NUM_THREADS)"
(cd "$LBUG_SOURCE_DIR" && make nodejs NUM_THREADS="$NUM_THREADS")

BUILT_NODE="$NODEJS_API_DIR/build/lbugjs.node"
if [ ! -f "$BUILT_NODE" ]; then
    echo "Error: build did not produce $BUILT_NODE" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
cp -f "$BUILT_NODE" "$OUTPUT_PATH"
echo "Wrote $OUTPUT_PATH"
file "$OUTPUT_PATH" || true
