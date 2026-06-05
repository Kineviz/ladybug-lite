#!/usr/bin/env node
/**
 * Diagnostic for "process.dlopen failed" when loading lbugjs-win32-arm64.node.
 *
 * Run this ON the real Windows-on-ARM machine, with BOTH runtimes:
 *
 *   # plain Node:
 *   node util/electron/diagnoseArmLoad.js
 *
 *   # inside Electron (main process) — e.g. via electron's node:
 *   npx electron util/electron/diagnoseArmLoad.js
 *
 * It prints the process arch / versions, attempts to load the addon, and on
 * failure prints the FULL OS error string (the part after process.dlopen that
 * tells us WHY), plus whether the arm64 VC++ runtime DLLs are resolvable.
 *
 * The single most important line is `process.arch`: an arm64 .node can only be
 * loaded by an arm64 process. An x64 (emulated) Node/Electron must use the
 * win32-amd64 .node instead — it runs fine under x64 emulation on ARM.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

function line() {
  console.log("-".repeat(72));
}

console.log("=== runtime ===");
console.log("process.platform :", process.platform);
console.log("process.arch     :", process.arch, "   <-- must be 'arm64' to load an arm64 .node");
console.log("os.arch()        :", os.arch());
console.log("node version     :", process.versions.node);
console.log("modules (ABI)    :", process.versions.modules);
console.log("napi             :", process.versions.napi);
console.log("electron         :", process.versions.electron || "(not Electron)");
console.log("v8               :", process.versions.v8);
console.log("ELECTRON_RUN_AS_NODE:", process.env.ELECTRON_RUN_AS_NODE || "(unset)");

line();
console.log("=== arm64 VC++ runtime DLLs (System32 = native arch on this OS) ===");
const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
for (const dll of ["VCRUNTIME140.dll", "MSVCP140.dll", "ucrtbase.dll"]) {
  const p = path.join(sys32, dll);
  console.log("  " + dll.padEnd(20), fs.existsSync(p) ? "present" : "MISSING -> install arm64 VC++ Redistributable");
}

line();
const candidates = [
  path.resolve(__dirname, "..", "..", "prebuilt", "lbugjs-win32-arm64.node"),
  path.resolve(process.cwd(), "prebuilt", "lbugjs-win32-arm64.node"),
];
const target = candidates.find((p) => fs.existsSync(p)) || candidates[0];
console.log("=== loading:", target, "===");
console.log("exists           :", fs.existsSync(target));
try {
  const m = require(target);
  console.log("RESULT           : LOADED OK");
  console.log("exports keys     :", Object.keys(m));
} catch (e) {
  console.log("RESULT           : FAILED");
  console.log("error.code       :", e.code);
  console.log("error.message    :", e.message); // <-- the OS reason string we need
  if (e.stack) console.log("stack[0..3]      :\n" + e.stack.split("\n").slice(0, 4).join("\n"));
}
