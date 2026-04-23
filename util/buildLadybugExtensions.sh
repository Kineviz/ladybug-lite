#!/bin/bash

# Script that only compiles Ladybug extensions, supports LBUG_DIR environment variable
# apk add --no-cache openssl openssl-dev

# Fail fast on any error. Without this, a failed `cmake --build` would let the
# script continue and print "All extensions copied" even though nothing was
# produced, making CI silently report success while committing nothing.
set -e

APP_ROOT_DIR=$(cd $(dirname "${BASH_SOURCE[0]}")/..; pwd)
# Upstream @ladybugdb/core@0.15.x no longer ships lbug-source/ in the tarball;
# CI clones the source separately and passes LBUG_SOURCE_DIR. Fall back to the
# old in-node_modules path for local dev against older cores.
LBUG_SOURCE_DIR="${LBUG_SOURCE_DIR:-$APP_ROOT_DIR/node_modules/@ladybugdb/core/lbug-source}"
EXTENSION_DIR="${LBUG_SOURCE_DIR}/extension"


SYSTEM="$(uname -o)"
if [ "$SYSTEM" = "Msys" ]; then
    export MSYS2_ARG_CONV_EXCL="*"
    echo "Msys"
    APP_ROOT_DIR="$(cygpath -w $APP_ROOT_DIR)"
    LBUG_SOURCE_DIR="$(cygpath -w $LBUG_SOURCE_DIR)"
    EXTENSION_DIR="$(cygpath -w $EXTENSION_DIR)"
fi

# Architecture detection (moved above the cache check so $EXTENSION_DIST_DIR
# can be computed before deciding whether to skip the build).
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    echo "Detected x86_64 architecture"
    ARCH="amd64"
elif [ "$ARCH" = "aarch64" ]; then
    echo "Detected aarch64 architecture"
    ARCH="arm64"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi
EXTENSION_DIST_DIR="${EXTENSION_OUTPUT_DIR:-$APP_ROOT_DIR/extensions/alpine-$ARCH}"
VERSION_FILE="$APP_ROOT_DIR/extensions/version"
CORE_PKG_JSON="$APP_ROOT_DIR/node_modules/@ladybugdb/core/package.json"

# Cache check: if extensions/version matches the target @ladybugdb/core
# version and $EXTENSION_DIST_DIR already contains at least one built
# artifact, skip the 4-8 minute cmake build. Set LBUG_FORCE_REBUILD=1 to
# bypass.
if [ "${LBUG_FORCE_REBUILD:-0}" != "1" ] \
    && [ -d "$EXTENSION_DIST_DIR" ] \
    && [ -f "$VERSION_FILE" ] \
    && [ -f "$CORE_PKG_JSON" ]; then
    cached_ver=$(head -n 1 "$VERSION_FILE" | tr -d '[:space:]')
    target_ver=$(node -p "require('$CORE_PKG_JSON').version")
    existing=$(find "$EXTENSION_DIST_DIR" -maxdepth 1 -type f \( -name "*.lbug_extension" -o -name "*.kuzu_extension" \) 2>/dev/null | wc -l)
    if [ "$cached_ver" = "$target_ver" ] && [ "$existing" -gt 0 ]; then
        echo "Cache hit: $existing extension artifact(s) in $EXTENSION_DIST_DIR for v$target_ver, skipping rebuild."
        exit 0
    fi
    echo "Cache miss (extensions/version=$cached_ver, target=$target_ver, artifacts=$existing); rebuilding."
fi

#EXTENSION_LIST="$(find "${EXTENSION_DIR}" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | grep -v '^duckdb$' | sort | tr '\n' ';' | sed 's/;$//')"
EXTENSION_LIST="httpfs;json;fts;vector;neo4j;algo"
echo "Automatically detected extension list: ${EXTENSION_LIST}"

if [ ! -f "${LBUG_SOURCE_DIR}/CMakeLists.txt" ] || [ ! -d "${LBUG_SOURCE_DIR}/extension" ]; then
    echo "Error: Please run this script in the root directory of the ladybug repository, or set the LBUG_DIR environment variable to point to the ladybug source directory"
    echo "Current LBUG_SOURCE_DIR: ${LBUG_SOURCE_DIR}"
    exit 1
fi

BUILD_DIR="${LBUG_SOURCE_DIR}/build_extensions"
if [ ! -d "$BUILD_DIR" ]; then
    mkdir "$BUILD_DIR"
fi

cd "$BUILD_DIR" || exit 1

# Check if already compiled, if so delete it
if [ -d "extension" ]; then
    echo "Detected existing extension directory, deleting..."
    rm -rf extension
fi

echo "Configuring CMake to build only extensions..."
echo "Source directory: ${LBUG_SOURCE_DIR}"
# BUILD_LBUG=FALSE alone still pulls in tools/shell, whose printer target has
# a broken include path (upstream cmake doesn't add src/include when shell is
# built standalone). BUILD_SHELL=FALSE skips it; upstream install.js uses
# both flags for the nodejs native addon build.
cmake "${LBUG_SOURCE_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_EXTENSIONS="${EXTENSION_LIST}" \
    -DOPENSSL_CRYPTO_LIBRARY=/usr/lib/libcrypto.so \
    -DOPENSSL_SSL_LIBRARY=/usr/lib/libssl.so \
    -DOPENSSL_USE_STATIC_LIBS=OFF \
    -DBUILD_LBUG=FALSE \
    -DBUILD_SHELL=FALSE

CORES=$(nproc --all)
echo "Using $CORES cores for compilation..."

# Use all target for compilation (more generic)
cmake --build . -- -j"$CORES"

echo "All extensions compiled successfully!"

#check cpu architecture
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    echo "Detected x86_64 architecture"
    ARCH="amd64"
elif [ "$ARCH" = "aarch64" ]; then
    echo "Detected aarch64 architecture"
    ARCH="arm64"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

# Collect the built extensions into an output dir the publish pipeline can
# pick up. Default to $APP_ROOT_DIR/extensions/alpine-$ARCH.
EXTENSION_DIST_DIR="${EXTENSION_OUTPUT_DIR:-$APP_ROOT_DIR/extensions/alpine-$ARCH}"
mkdir -p "$EXTENSION_DIST_DIR"

# Use -name rather than -path with globbing. The prior -path "*/build/*.ext"
# pattern silently matched zero files under Alpine's busybox find even though
# the artifacts existed at extension/<name>/build/lib<name>.lbug_extension.
# -name is simpler and produced the same result set on the test run.
copied=0
for ext in $(find "${LBUG_SOURCE_DIR}/extension" -type f \( -name "*.lbug_extension" -o -name "*.kuzu_extension" \)); do
    cp -f "$ext" "$EXTENSION_DIST_DIR/"
    echo "Copied: $ext -> $EXTENSION_DIST_DIR/"
    copied=$((copied + 1))
done

if [ "$copied" -eq 0 ]; then
    echo "Error: No .lbug_extension or .kuzu_extension artifacts found under ${LBUG_SOURCE_DIR}/extension. Did the cmake build produce any?" >&2
    exit 1
fi

echo "$copied extension artifact(s) have been copied to the $EXTENSION_DIST_DIR directory"
