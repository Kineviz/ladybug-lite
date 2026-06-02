# Electron compatibility for ladybug-lite

## TL;DR

| Platform | Existing prebuilt works in Electron 39? | Action |
|---|---|---|
| linux amd64 / arm64 | ✅ yes | none |
| alpine amd64 / arm64 | ✅ yes | none |
| darwin amd64 / arm64 | ✅ yes | none |
| **win32 amd64** | ❌ **no — crashes in `process.dlopen`** | rebuild with the delay-load patch in this folder |

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
  (`.github/workflows/buildWindows.yaml`) via *workflow_dispatch*.
- It builds from source with the patch, then gates on a plain-Node test and an
  Electron smoke test, and uploads `lbugjs-win32-amd64.node` as an artifact.
- It does **not** auto-publish — promote the artifact into `prebuilt/` and
  publish deliberately. When packaging that release, set
  `LBUG_SKIP_WIN32_PREBUILT=1` so `util/build.js` keeps the patched binary
  instead of re-fetching the upstream non-hooked one.

To build locally instead, install VS 2022 (C++ workload) + CMake, then:

```bash
yarn add @ladybugdb/core --ignore-scripts
LBUG_SUBMODULES=tools/nodejs_api yarn clone:source
node util/electron/patchWinDelayLoad.js lbug-src/tools/nodejs_api
LBUG_FORCE_REBUILD=1 \
  LBUG_SOURCE_DIR="$PWD/lbug-src" \
  OUTPUT_PATH="$PWD/prebuilt/lbugjs-win32-amd64.node" \
  yarn build:native
```

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
