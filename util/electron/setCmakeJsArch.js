#!/usr/bin/env node
/**
 * Force a cloned ladybug-nodejs (tools/nodejs_api) checkout to resolve its
 * Node dev files (node headers + node.lib) for a SPECIFIC target architecture,
 * so the addon can be CROSS-COMPILED (e.g. building win32-arm64 on an
 * win32-amd64 host).
 *
 * Why this is needed
 *   The upstream tools/nodejs_api/CMakeLists.txt obtains the import library via
 *       execute_process(COMMAND npx cmake-js print-cmakejs-lib ...)
 *   invoked with NO `--arch`. cmake-js then targets the HOST architecture and
 *   hands CMake the host's node.lib (win-x64). When the C++ toolchain is set up
 *   to emit arm64 objects (vcvarsall amd64_arm64), linking against the x64
 *   node.lib fails. cmake-js DOES support arm64 (it downloads win-arm64/node.lib
 *   when the target arch is arm64) — it just needs to be told.
 *
 *   cmake-js reads the target arch from the nearest package.json `cmake-js`
 *   config (appCMakeJSConfig walks up the tree). It does NOT read npm_config_arch
 *   (npmConfig only forwards `nodedir`/`msvs_version`). So the reliable, flag-free
 *   way to make the print-cmakejs-* commands target arm64 is to write
 *   `{ "cmake-js": { "arch": "arm64" } }` into the checkout's package.json.
 *
 * This helper sets (or clears) that field idempotently.
 *
 * Usage:
 *   node util/electron/setCmakeJsArch.js <path-to-tools/nodejs_api> <arch>
 *   node util/electron/setCmakeJsArch.js <path-to-tools/nodejs_api> --clear
 *
 *   <arch> is a Node arch string: arm64 | x64 (ia32/arm also accepted verbatim).
 *
 * Only meaningful for cross-compilation. A NATIVE build (host arch == target
 * arch, e.g. building arm64 on a windows-11-arm runner) does not need it.
 *
 * NOTE (per repo .js build-tooling convention): kept as .js to match the other
 * util/*.js scripts that CI runs directly with `node`. See util/electron/README.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const VALID_ARCH = new Set(["arm64", "x64", "ia32", "arm", "x86"]);

function main() {
  const nodejsApiDir = process.argv[2];
  const archArg = process.argv[3];
  if (!nodejsApiDir || !archArg) {
    console.error("Usage: node setCmakeJsArch.js <path-to-tools/nodejs_api> <arch|--clear>");
    process.exit(1);
  }

  const pkgPath = path.join(nodejsApiDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error(`Error: ${pkgPath} not found. Is this a ladybug-nodejs checkout?`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const clearing = archArg === "--clear";

  if (!clearing && !VALID_ARCH.has(archArg)) {
    console.error(`Error: unknown arch "${archArg}". Expected one of: ${[...VALID_ARCH].join(", ")}.`);
    process.exit(1);
  }

  const cfg = pkg["cmake-js"] && typeof pkg["cmake-js"] === "object" ? pkg["cmake-js"] : {};

  if (clearing) {
    if (cfg.arch === undefined) {
      console.log("cmake-js.arch not set; nothing to clear.");
      return;
    }
    delete cfg.arch;
    if (Object.keys(cfg).length === 0) {
      delete pkg["cmake-js"];
    } else {
      pkg["cmake-js"] = cfg;
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    console.log(`Cleared cmake-js.arch in ${pkgPath}`);
    return;
  }

  if (cfg.arch === archArg) {
    console.log(`cmake-js.arch already "${archArg}" in ${pkgPath}; nothing to do.`);
    return;
  }
  cfg.arch = archArg;
  pkg["cmake-js"] = cfg;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`Set cmake-js.arch = "${archArg}" in ${pkgPath} (cross-compile target).`);
}

main();
