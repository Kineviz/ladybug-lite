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
cmake "${LBUG_SOURCE_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_EXTENSIONS="${EXTENSION_LIST}" \
    -DOPENSSL_CRYPTO_LIBRARY=/usr/lib/libcrypto.so \
    -DOPENSSL_SSL_LIBRARY=/usr/lib/libssl.so \
    -DOPENSSL_USE_STATIC_LIBS=OFF \
    -DBUILD_LBUG=FALSE

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
# pick up. Default to $APP_ROOT_DIR/extensions/alpine-$ARCH so the
# buildExtension.yaml `git add extensions/*/*.lbug_extension` glob matches.
EXTENSION_DIST_DIR="${EXTENSION_OUTPUT_DIR:-$APP_ROOT_DIR/extensions/alpine-$ARCH}"
mkdir -p "$EXTENSION_DIST_DIR"
find "${LBUG_SOURCE_DIR}/extension" -type f \( -path "*/build/*.lbug_extension" -o -path "*/build/*.kuzu_extension" \) -exec cp {} "$EXTENSION_DIST_DIR" \;

echo "All extensions have been copied to the $EXTENSION_DIST_DIR directory"
