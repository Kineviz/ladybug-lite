#!/usr/bin/env node
/**
 * Patch the upstream ladybug root CMakeLists.txt so the Windows SDK
 * architecture macro (_AMD64_ / _ARM64_ / _X86_) follows the COMPILER TARGET
 * arch instead of being hardcoded to _AMD64_.
 *
 * Why this is needed (win32-arm64 cross/native builds)
 *   The Windows SDK <winnt.h> selects its inline atomic/barrier intrinsics
 *   (ReadAcquire8, WriteRelease, ...) based on the arch macro the project
 *   defines: _AMD64_ (x64), _ARM64_ (arm64), _X86_ (x86). Upstream hardcodes
 *   _AMD64_ (it even says "For now, hardcode _AMD64_"). When building for arm64
 *   with the arm64 cl.exe, _AMD64_ is still defined, so <winnt.h> takes the x64
 *   path and the arm64 compiler cannot resolve the x64 intrinsics:
 *       winnt.h: error C3861: 'ReadAcquire8': identifier not found  (x24...)
 *   Defining _ARM64_ instead makes <winnt.h> take the matching arm64 path.
 *
 *   We key off CMAKE_CXX_COMPILER_ARCHITECTURE_ID (set by CMake for MSVC-like
 *   compilers to the real TARGET: ARM64 / ARM / x64 / X86). This is reliable for
 *   cross builds, where CMAKE_SYSTEM_PROCESSOR still reports the host. For x64
 *   the patched logic falls back to _AMD64_, so amd64 builds are unchanged — the
 *   patch is a strict, upstreamable improvement, not an arm64-only hack.
 *
 * Idempotent: guarded by a marker; running twice is a no-op.
 *
 * Usage:
 *   node util/electron/patchWinArchMacro.js <path-to-lbug-src-root>
 *   (the directory containing the top-level CMakeLists.txt)
 *
 * NOTE (per repo .js build-tooling convention): kept as .js to match the other
 * util/*.js scripts that run directly with `node`. See util/electron/README.md.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MARKER = "ladybug-lite arm64 arch-macro patch";

// Arch-aware replacement for a hardcoded `add_compile_definitions(_AMD64_)`.
// `indent` is the leading whitespace of the original line so the block lines up.
function archBlock(indent) {
  const i = indent;
  return (
    `${i}# >>> ${MARKER} >>>\n` +
    `${i}# Pick the Windows SDK arch macro from the compiler TARGET arch so <winnt.h>\n` +
    `${i}# uses matching intrinsics (arm64 cross/native builds need _ARM64_, not _AMD64_).\n` +
    `${i}if(CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "ARM64")\n` +
    `${i}  add_compile_definitions(_ARM64_)\n` +
    `${i}elseif(CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "ARM")\n` +
    `${i}  add_compile_definitions(_ARM_)\n` +
    `${i}elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)\n` +
    `${i}  add_compile_definitions(_AMD64_)\n` +
    `${i}else()\n` +
    `${i}  add_compile_definitions(_X86_)\n` +
    `${i}endif()\n` +
    `${i}# <<< ${MARKER} <<<`
  );
}

function main() {
  const srcRoot = process.argv[2];
  if (!srcRoot) {
    console.error("Usage: node patchWinArchMacro.js <path-to-lbug-src-root>");
    process.exit(1);
  }
  const cmakePath = path.join(srcRoot, "CMakeLists.txt");
  if (!fs.existsSync(cmakePath)) {
    console.error(`Error: ${cmakePath} not found. Pass the lbug source root.`);
    process.exit(1);
  }

  let cmake = fs.readFileSync(cmakePath, "utf8");
  if (cmake.includes(MARKER)) {
    console.log("CMakeLists.txt already arch-macro patched; skipping.");
    return;
  }

  let replacements = 0;

  // NOTE ON ORDER: the arch-aware block emitted by archBlock() itself contains a
  // fallback `add_compile_definitions(_AMD64_)` line. So we must anchor each match
  // to surrounding context that does NOT appear inside archBlock, and we replace
  // the standalone define (anchored to its unique comment) BEFORE the pointer-size
  // block — never with a bare `^add_compile_definitions(_AMD64_)$` that would also
  // match the fallback line we just inserted.

  // 1) The standalone unconditional MSVC define, uniquely identified by its
  //    preceding "For now, hardcode _AMD64_" comment (optionally followed by the
  //    CMAKE_GENERATOR_PLATFORM comment). archBlock has no such comment, so this
  //    cannot match the fallback line inside an inserted block.
  const standaloneRe =
    /[ \t]*# For now, hardcode _AMD64_\r?\n(?:[ \t]*#[^\r\n]*\r?\n)?([ \t]*)add_compile_definitions\(_AMD64_\)/;
  cmake = cmake.replace(standaloneRe, (_m, indent) => {
    replacements++;
    return archBlock(indent);
  });

  // 2) The pointer-size block (also covers the Clang-on-Windows path):
  //      if(CMAKE_SIZEOF_VOID_P EQUAL 8)
  //        add_compile_definitions(_AMD64_)
  //      else()
  //        add_compile_definitions(_X86_)
  //      endif()
  //    archBlock uses `elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)` (preceded by "else"),
  //    so the leading-whitespace-anchored `if(` here never matches inside it.
  const blockRe =
    /([ \t]*)if\(CMAKE_SIZEOF_VOID_P EQUAL 8\)\r?\n[ \t]*add_compile_definitions\(_AMD64_\)\r?\n[ \t]*else\(\)\r?\n[ \t]*add_compile_definitions\(_X86_\)\r?\n[ \t]*endif\(\)/;
  cmake = cmake.replace(blockRe, (_m, indent) => {
    replacements++;
    return archBlock(indent);
  });

  // 3) Extra Windows/ARM64 third-party portability defines, inserted once after
  //    the WIN32 `add_compile_definitions(NOMINMAX)` anchor. Currently:
  //      - PCG_LITTLE_ENDIAN=1: third_party/pcg/pcg_uint128.hpp only auto-detects
  //        endianness for _M_X64/_M_IX86, and errors ("Unable to determine target
  //        endianness", C1189) on MSVC/ARM64. Windows on ARM64 is little-endian.
  const nominmaxRe = /^([ \t]*)add_compile_definitions\(NOMINMAX\)[ \t]*$/m;
  if (nominmaxRe.test(cmake)) {
    cmake = cmake.replace(nominmaxRe, (m, indent) => {
      replacements++;
      return (
        `${m}\n` +
        `${indent}# >>> ${MARKER} (extra arm64 third-party defines) >>>\n` +
        `${indent}if(CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "ARM64")\n` +
        `${indent}  # pcg_uint128.hpp can't detect endianness on MSVC/ARM64; Windows is little-endian.\n` +
        `${indent}  add_compile_definitions(PCG_LITTLE_ENDIAN=1)\n` +
        `${indent}endif()\n` +
        `${indent}# <<< ${MARKER} (extra arm64 third-party defines) <<<`
      );
    });
  }

  if (replacements === 0) {
    console.error(
      "Error: no hardcoded _AMD64_ definitions found to patch. Upstream layout may have changed."
    );
    process.exit(1);
  }

  fs.writeFileSync(cmakePath, cmake, "utf8");
  console.log(`Patched ${cmakePath}: applied ${replacements} Windows arch fix(es) (arch macro + arm64 third-party defines).`);
}

main();
