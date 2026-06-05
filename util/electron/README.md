# Electron compatibility for ladybug-lite

## TL;DR

| Platform | Existing prebuilt works in Electron 39? | Action |
|---|---|---|
| linux amd64 / arm64 | ✅ yes | none |
| alpine amd64 / arm64 | ✅ yes | none |
| darwin amd64 / arm64 | ✅ yes | none |
| **win32 amd64** | ❌ **no — crashes in `process.dlopen`** | rebuild with the delay-load patch in this folder |
| **win32 arm64** | ❌ **no — same delay-load issue** | rebuild with the delay-load patch (native or cross-compiled) |

The Windows fix is **architecture-independent** — the delay-load patch applies to
amd64 and arm64 identically. The only difference is how you produce the arm64
binary on an amd64 dev box (cross-compile, see below).

Electron 39 ships Node 22 / **N-API v10**, the same N-API level the binaries are
built against — so there is no ABI mismatch. The addon is a Node-API
(`node-addon-api`) module, and N-API binaries are ABI-stable across Node *and*
Electron. The only blocker is a **Windows-specific linking issue**.

## Why only Windows breaks

The addon resolves its `napi_*` symbols from the host executable.

- **Linux** links with `-Wl,--export-dynamic` and is loaded with `RTLD_GLOBAL`
  (see [`../../lbug_native.js`](../../lbug_native.js)); symbols resolve from the
  host process by name at runtime. No host-binary name is baked in.
- **macOS** links with `-undefined dynamic_lookup`; same idea, flat/lazy lookup.
- **Windows** PE imports record the *name* of the providing DLL. cmake-js
  records `node.exe`. Under Electron the host is `electron.exe`, there is no
  `node.exe`, so the Windows loader fails to bind the imports → crash on load.

`node-gyp` avoids this automatically by compiling a delay-load hook **and**
passing `/DELAYLOAD:node.exe`. `cmake-js` (used by upstream `ladybug-nodejs`)
does not add `/DELAYLOAD`, so the hook never fires. That is the entire bug.

Proof (PE import table of the shipped `prebuilt/lbugjs-win32-amd64.node`):

```
IMPORTS:        node.exe, KERNEL32.dll, MSVCP140.dll, ...
DELAY IMPORTS:  (none)
```

`node.exe` is a normal import, not delay-loaded → cannot be redirected → fails
under Electron.

## The fix

`patchWinDelayLoad.js` patches a cloned `tools/nodejs_api` checkout so the
Windows build:

1. delay-loads the host import: `target_link_options(lbugjs PRIVATE /DELAYLOAD:node.exe)`
2. links `delayimp.lib`
3. ensures a delay-load hook is present (`lbug_win_delay_load_hook.cpp`, used
   only if cmake-js did not already provide one, to avoid a duplicate
   `__pfnDliNotifyHook2` symbol).

At the first N-API call the delay-load machinery asks to load `node.exe`; the
hook returns `GetModuleHandle(NULL)` (the real host — `node.exe` *or*
`electron.exe`), whose exported `napi_*` symbols satisfy the imports. The result
is **one** binary that loads under both Node 22 and Electron 39.

## How to produce the binary

There is no C++ toolchain assumption on the dev machine — build it in CI:

- Run the **“Build Ladybug Lite for Windows (Electron-compatible)”** workflow
  (`.github/workflows/buildWindows.yaml`) via *workflow_dispatch*. It is a
  **matrix** that builds **both** architectures natively:
  - `amd64` on `windows-2022`,
  - `arm64` on the GitHub-hosted `windows-11-arm` runner.
- Each job builds from source with the patch, runs a static PE compatibility
  check (`check-electron-compat.js`), then gates on a plain-Node test and an
  Electron smoke test, and uploads `lbugjs-win32-<arch>.node` as an artifact.
- It does **not** auto-publish — promote the artifact into `prebuilt/` and
  publish deliberately. When packaging that release, set
  `LBUG_SKIP_WIN32_PREBUILT=1` so `util/build.js` keeps the patched binary
  instead of re-fetching the upstream non-hooked one.

### Build locally with `build-win.bat`

One script builds either arch as a self-contained, Electron-compatible binary:

```bat
set LBUG_SUBMODULES=tools/nodejs_api
yarn clone:source
pushd lbug-src\tools\nodejs_api && npm install && popd

util\electron\build-win.bat amd64    REM -> prebuilt\lbugjs-win32-amd64.node
util\electron\build-win.bat arm64    REM -> prebuilt\lbugjs-win32-arm64.node
util\electron\build-win.bat          REM defaults to amd64
```

All output is logged to `.\build-<arch>.log`. Env knobs: `LBUG_CRT=MD` reverts to
the dynamic CRT; `LBUG_VSINSTALL=<path>` pins the VS install (see toolset note
below). What the script does:

1. **Picks the toolchain from host vs target arch** — native `vcvarsall amd64` /
   `arm64`, or cross `amd64_arm64` (build arm64 on an x64 box) / `arm64_amd64`. It
   uses `vswhere` to find a VS install with the C++ tools for the target
   (`…VC.Tools.x86.x64` for amd64, `…VC.Tools.ARM64` for arm64) and prints the
   install command if missing.
2. **Delay-load patch** (`patchWinDelayLoad.js`) → loads under Node AND Electron.
3. **`setCmakeJsArch.js <arch>`** so cmake-js hands CMake the matching `node.lib`
   (upstream calls `cmake-js print-cmakejs-lib` with no `--arch` and would target
   the host; cmake-js reads the target arch from the checkout's `package.json`
   `cmake-js.arch`, **not** from `npm_config_arch`).
4. **`patchWinArchMacro.js`** fixes two upstream ARM64 portability bugs (below;
   no-op on amd64).
5. **Static CRT (`/MT`)** via `-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` (below).
6. Builds with Ninja (`-DBUILD_NODEJS=TRUE`), writes
   `prebuilt/lbugjs-win32-<arch>.node`, and verifies it with
   `check-electron-compat.js`.

#### Upstream ARM64 portability fixes (`patchWinArchMacro.js`)

The upstream root `CMakeLists.txt` is x64-only in two places; both break the
ARM64 compiler and are patched to be arch-aware (keyed on the compiler target
`CMAKE_CXX_COMPILER_ARCHITECTURE_ID`, so **amd64 builds are unchanged**):

- **Hardcoded `_AMD64_`** (it literally says *"For now, hardcode `_AMD64_`"*).
  With `_AMD64_` defined, the Windows SDK `<winnt.h>` selects x64 atomic
  intrinsics and the arm64 compiler fails with dozens of
  `error C3861: 'ReadAcquire8': identifier not found`. The patch defines
  `_ARM64_` for arm64 targets instead.
- **`pcg_uint128.hpp` endianness** only auto-detects `_M_X64`/`_M_IX86`, so on
  MSVC/ARM64 it hits `fatal error C1189: Unable to determine target endianness`.
  The patch defines `PCG_LITTLE_ENDIAN=1` for arm64 (Windows on ARM64 is LE).

These fixes are arch-conditional and upstreamable. The same patch runs in the CI
`arm64` (native `windows-11-arm`) job, which hits the identical issues.

#### Static CRT is required for a redistributable win32 prebuilt

`build-win.bat` configures with `-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`
(**`/MT`**, static CRT) by default, and CI does the same via `EXTRA_CMAKE_FLAGS`
(forwarded by `build.js` to `make nodejs`). This is not optional for a shippable
`.node`:

- The default cmake-js/CMake build uses `/MD` (dynamic CRT), so the `.node`
  imports `VCRUNTIME140.dll` and `MSVCP140.dll`. Those ship with the **VC++
  Redistributable**, which is **absent on clean Windows-on-ARM machines** — and
  official Node is itself static-CRT, so `node.exe` running is no guarantee the
  redist is present. The `/MD` arm64 build therefore failed in `process.dlopen`
  ("the specified module could not be found") on a real arm64 box.
- With `/MT`, the runtime is linked in and the addon depends only on
  `KERNEL32.dll` + `WS2_32.dll` (always present) and `node.exe` (delay-import).
  Verified on the produced binary: no `VCRUNTIME140`/`MSVCP140`/`ucrtbase`
  imports remain.

`/MT` is safe here because the addon links ladybug **statically** (`lbug.lib`, it
does *not* depend on `lbug_shared.dll`), so it is a single self-contained module
with one private CRT, and N-API never passes CRT-owned objects (allocations,
`FILE*`, locale) across the `node.exe` boundary — the same reason node-gyp
defaults to `/MT`.

Both arches built by `build-win.bat` (and by CI) are now `/MT`. To deliberately
produce a dynamic-CRT build, pass `LBUG_CRT=MD`.

> **Toolset note:** an amd64 host does **not** ship the x64→arm64 cross compiler
> by default — `build-win.bat arm64` detects that and prints the exact component
> to add (`Microsoft.VisualStudio.Component.VC.Tools.ARM64`); installing it does
> not disturb the amd64 toolchain. Also avoid the **VS 18 / MSVC 14.50**
> prerelease toolset for arm64 — its cross compiler crashed (ICE) on heavy
> template files where **BuildTools 2022 / MSVC 14.44** built cleanly. Pin a
> known-good install with `LBUG_VSINSTALL` if `vswhere -latest` selects a
> prerelease.

## Verifying under Electron

```bash
# from a dir with electron@^39 installed
unset ELECTRON_RUN_AS_NODE   # IMPORTANT: else Electron boots as plain Node
LBUG_PKG_ROOT=/path/to/ladybug-lite electron util/electron/electronSmokeTest.js
```

Exit code 0 = loads and queries successfully under Electron.

## Note on file extensions

The global convention prefers TypeScript for new source files. These helpers
are kept as `.js` to match the existing `util/*.js` build tooling (`build.js`,
`install.js`, `test.js`) that CI runs directly with `node`, and because the
repo has no `tsconfig.json`/ts loader in its build chain. Converting the build
tooling to TypeScript would be a separate, opt-in task.
