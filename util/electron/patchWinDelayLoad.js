#!/usr/bin/env node
/**
 * Patch a cloned ladybug-nodejs (tools/nodejs_api) checkout so the Windows
 * lbugjs.node addon is built with the delay-load hook required to run inside
 * Electron (and still run under plain Node).
 *
 * What it does (idempotent):
 *   1. Copies util/electron/lbug_win_delay_load_hook.cpp into
 *      <nodejs_api>/electron_compat/ (NOT src_cpp/, so it is NOT picked up by
 *      the `file(GLOB ./src_cpp/*.cpp)` in upstream CMakeLists.txt — otherwise
 *      it would clash with cmake-js's own hook and cause a duplicate-symbol
 *      link error).
 *   2. Appends a WIN32 block to <nodejs_api>/CMakeLists.txt that:
 *        - adds  /DELAYLOAD:node.exe  to the linker (the missing piece; cmake-js
 *          compiles a hook via CMAKE_JS_SRC but never delays node.exe, so the
 *          hook never fires),
 *        - links delayimp.lib (provides the delay-load helper),
 *        - adds our vendored hook ONLY when cmake-js did not supply one
 *          (CMAKE_JS_SRC empty), avoiding the duplicate __pfnDliNotifyHook2.
 *
 * This is a no-op on non-Windows builds (the block is guarded by if(WIN32)),
 * so it is safe to run unconditionally; the dedicated Windows CI job is the
 * only place it actually changes the produced binary.
 *
 * Usage:
 *   node util/electron/patchWinDelayLoad.js <path-to-tools/nodejs_api>
 *
 * NOTE (per repo .js build-tooling convention): kept as .js to match the other
 * util/*.js scripts that CI runs directly with `node`. See util/electron/README.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = "ladybug-lite electron delay-load patch";

function main() {
  const nodejsApiDir = process.argv[2];
  if (!nodejsApiDir) {
    console.error("Usage: node patchWinDelayLoad.js <path-to-tools/nodejs_api>");
    process.exit(1);
  }

  const cmakeListsPath = path.join(nodejsApiDir, "CMakeLists.txt");
  if (!fs.existsSync(cmakeListsPath)) {
    console.error(`Error: ${cmakeListsPath} not found. Is this a ladybug-nodejs checkout?`);
    process.exit(1);
  }

  // 1. Copy the vendored hook into electron_compat/ (outside the src_cpp glob).
  const hookSrc = path.join(__dirname, "lbug_win_delay_load_hook.cpp");
  const compatDir = path.join(nodejsApiDir, "electron_compat");
  const hookDest = path.join(compatDir, "lbug_win_delay_load_hook.cpp");
  fs.mkdirSync(compatDir, { recursive: true });
  fs.copyFileSync(hookSrc, hookDest);
  console.log(`Copied hook -> ${hookDest}`);

  // 2. Append the WIN32 delay-load block to CMakeLists.txt (idempotent).
  const cmake = fs.readFileSync(cmakeListsPath, "utf8");
  if (cmake.includes(MARKER)) {
    console.log("CMakeLists.txt already patched; skipping append.");
    return;
  }

  const block = `
# >>> ${MARKER} >>>
# Make the addon loadable under Electron on Windows by delay-loading the host
# executable import (node.exe) and redirecting it to the running host
# (node.exe OR electron.exe) at first N-API call. See
# util/electron/lbug_win_delay_load_hook.cpp for the full rationale.
if(WIN32 AND TARGET lbugjs)
  target_link_options(lbugjs PRIVATE /DELAYLOAD:node.exe)
  target_link_libraries(lbugjs PRIVATE delayimp.lib)
  if(NOT CMAKE_JS_SRC)
    target_sources(lbugjs PRIVATE "\${CMAKE_CURRENT_SOURCE_DIR}/electron_compat/lbug_win_delay_load_hook.cpp")
    message(STATUS "lbugjs: using vendored win_delay_load_hook (cmake-js src not found)")
  else()
    message(STATUS "lbugjs: relying on cmake-js win_delay_load_hook (CMAKE_JS_SRC=\${CMAKE_JS_SRC})")
  endif()
  message(STATUS "lbugjs: Electron-compatible Windows build (/DELAYLOAD:node.exe)")
endif()
# <<< ${MARKER} <<<
`;

  fs.writeFileSync(cmakeListsPath, cmake + block, "utf8");
  console.log(`Patched ${cmakeListsPath} with /DELAYLOAD:node.exe block.`);
}

main();
