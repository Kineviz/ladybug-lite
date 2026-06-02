/**
 * Electron-compatibility checker for the prebuilt lbugjs-*.node binaries.
 *
 * It statically inspects each native addon (no loading, no toolchain needed)
 * and reports whether it can be loaded inside Electron:
 *
 *   - win32 (PE):   N-API addons import their napi_* symbols from the host
 *                   executable, recorded by name. A plain cmake-js build
 *                   records "node.exe" as a NORMAL import, which the Windows
 *                   loader cannot bind under Electron (host = electron.exe) ->
 *                   crash in process.dlopen. The fix (delay-load hook +
 *                   /DELAYLOAD:node.exe) moves "node.exe" into the DELAY import
 *                   table so it is redirected to the real host at first call.
 *                   => PASS only if "node.exe" is a DELAY import (or absent),
 *                      FAIL if it is a normal import.
 *
 *   - linux/alpine (ELF) and darwin (Mach-O): napi_* symbols are resolved from
 *                   the host process at runtime (RTLD_GLOBAL / dynamic_lookup);
 *                   no host-binary name is baked in. => always Electron-OK.
 *
 * Usage:
 *   node util/electron/check-electron-compat.js            # check all prebuilt/*.node
 *   node util/electron/check-electron-compat.js <file...>  # check specific files
 *
 * With no arguments it locates the repo's prebuilt/ directory (walking up from
 * this script) and checks every lbugjs-*.node there.
 *
 * Exit code: 0 if every checked binary is Electron-compatible, 1 otherwise.
 *
 * NOTE: kept as .js to match the repo's util/*.js build tooling that runs
 * directly with `node`; see util/electron/README.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// ---- minimal PE import-table parser (win32) --------------------------------
function parsePEImports(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") return null;
  const coff = peOff + 4;
  const numSec = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  const ddOff = opt + (pe32plus ? 112 : 96);
  const importRVA = buf.readUInt32LE(ddOff + 1 * 8);
  const delayRVA = buf.readUInt32LE(ddOff + 13 * 8);

  const secOff = opt + optSize;
  const secs = [];
  for (let i = 0; i < numSec; i++) {
    const o = secOff + i * 40;
    secs.push({
      va: buf.readUInt32LE(o + 12),
      vsize: buf.readUInt32LE(o + 8),
      raw: buf.readUInt32LE(o + 20),
      rsize: buf.readUInt32LE(o + 16),
    });
  }
  const rva2off = (rva) => {
    for (const s of secs) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) {
        return s.raw + (rva - s.va);
      }
    }
    return -1;
  };
  const readStr = (off) => {
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.toString("ascii", off, e);
  };
  const dump = (rva, nameFieldOffset, entrySize) => {
    const out = [];
    if (!rva) return out;
    let off = rva2off(rva);
    if (off < 0) return out;
    for (let i = 0; i < 256; i++) {
      const nameRVA = buf.readUInt32LE(off + nameFieldOffset);
      if (nameRVA === 0) break;
      const nOff = rva2off(nameRVA);
      if (nOff < 0) break;
      out.push(readStr(nOff));
      off += entrySize;
    }
    return out;
  };
  return {
    imports: dump(importRVA, 12, 20), // IMAGE_IMPORT_DESCRIPTOR: Name @ +12, size 20
    delayImports: dump(delayRVA, 4, 32), // ImgDelayDescr: DllName @ +4, size 32
  };
}

function detectFormat(buf) {
  if (buf.length < 4) return "unknown";
  if (buf.readUInt16LE(0) === 0x5a4d) return "pe"; // MZ
  if (buf[0] === 0x7f && buf.toString("ascii", 1, 4) === "ELF") return "elf";
  const m = buf.readUInt32BE(0);
  if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcafebabe || m === 0xcffaedfe || m === 0xcefaedfe) {
    return "macho";
  }
  return "unknown";
}

function platformFromName(file) {
  const b = path.basename(file);
  if (b.includes("win32")) return "win32";
  if (b.includes("alpine")) return "alpine";
  if (b.includes("linux")) return "linux";
  if (b.includes("darwin")) return "darwin";
  return "unknown";
}

// crude but reliable: N-API addons contain napi_* import name strings
function looksNapi(buf) {
  return buf.includes(Buffer.from("napi_create_object")) || buf.includes(Buffer.from("napi_register_module_v1"));
}

function checkFile(file) {
  const buf = fs.readFileSync(file);
  const fmt = detectFormat(buf);
  const platform = platformFromName(file);
  const napi = looksNapi(buf);
  const result = { file: path.basename(file), platform, format: fmt, napi, compatible: false, reason: "" };

  if (fmt === "pe") {
    const pe = parsePEImports(buf);
    if (!pe) {
      result.reason = "could not parse PE import tables";
      return result;
    }
    const ci = (arr) => arr.map((s) => s.toLowerCase());
    const inNormal = ci(pe.imports).includes("node.exe");
    const inDelay = ci(pe.delayImports).includes("node.exe");
    if (inNormal) {
      result.compatible = false;
      result.reason = "node.exe is a NORMAL import -> crashes under Electron (needs /DELAYLOAD:node.exe + delay-load hook)";
    } else if (inDelay) {
      result.compatible = true;
      result.reason = "node.exe is a DELAY import -> redirected to host (node.exe or electron.exe)";
    } else {
      result.compatible = true;
      result.reason = "no node.exe import (symbols resolved from host)";
    }
    return result;
  }

  if (fmt === "elf" || fmt === "macho") {
    // ELF/Mach-O N-API addons do not name a host binary; napi_* resolves from
    // the loading process at runtime -> inherently Electron-compatible.
    const hardRef = buf.includes(Buffer.from("node.exe")) || buf.includes(Buffer.from("libnode"));
    result.compatible = !hardRef;
    result.reason = hardRef
      ? "unexpected hard reference to a host binary"
      : (fmt === "macho" ? "Mach-O: napi resolved via dynamic_lookup at runtime" : "ELF: napi resolved from host (RTLD_GLOBAL) at runtime");
    return result;
  }

  result.reason = `unrecognized binary format (${fmt})`;
  return result;
}

// Locate the repo's prebuilt/ directory. The script may live anywhere under
// the repo (e.g. util/, util/electron/, or prebuilt/ itself), so walk up from
// __dirname looking for a `prebuilt` folder, and also accept __dirname when it
// already contains the binaries.
function findPrebuiltDir() {
  if (fs.readdirSync(__dirname).some((f) => f.startsWith("lbugjs-") && f.endsWith(".node"))) {
    return __dirname;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "prebuilt");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    const dir = findPrebuiltDir();
    if (!dir) {
      console.error("Could not locate a prebuilt/ directory. Pass file paths explicitly.");
      process.exit(1);
    }
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("lbugjs-") && f.endsWith(".node"))
      .map((f) => path.join(dir, f));
  }
  if (files.length === 0) {
    console.error("No lbugjs-*.node files found to check.");
    process.exit(1);
  }

  const rows = files.map(checkFile);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad("BINARY", 30) + pad("FORMAT", 8) + pad("N-API", 7) + pad("ELECTRON", 10) + "REASON"
  );
  console.log("-".repeat(110));
  let allOk = true;
  for (const r of rows) {
    if (!r.compatible) allOk = false;
    console.log(
      pad(r.file, 30) +
        pad(r.format, 8) +
        pad(r.napi ? "yes" : "no", 7) +
        pad(r.compatible ? "PASS" : "FAIL", 10) +
        r.reason
    );
  }
  console.log("-".repeat(110));
  console.log(allOk ? "All binaries are Electron-compatible." : "Some binaries are NOT Electron-compatible (see FAIL rows).");
  process.exit(allOk ? 0 : 1);
}

main();
