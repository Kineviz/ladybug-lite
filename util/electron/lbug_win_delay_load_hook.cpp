/*
 * Windows delay-load hook for the lbugjs N-API addon.
 *
 * Why this exists
 * ---------------
 * The addon imports its N-API symbols (napi_*) from the host executable. On
 * Windows the PE import table records the *name* of the providing module, and
 * a plain build records "node.exe". When the addon is loaded inside Electron
 * (host = electron.exe) there is no node.exe, so the Windows loader fails to
 * bind the imports and the process crashes in dlopen.
 *
 * node-gyp solves this automatically by (a) compiling a delay-load hook and
 * (b) passing /DELAYLOAD:node.exe to the linker. cmake-js (used by upstream
 * ladybug-nodejs) does NOT add /DELAYLOAD, so the hook never fires. This file
 * + the linker flags added by util/electron/patchWinDelayLoad.js reproduce the
 * node-gyp behaviour, producing a single binary that loads under both Node and
 * Electron.
 *
 * With /DELAYLOAD:node.exe the node.exe import is resolved lazily; the first
 * time an N-API symbol is called the delay-load machinery raises
 * dliNotePreLoadLibrary for "node.exe" and this hook returns a handle to the
 * actual host module (GetModuleHandle(NULL)) instead of trying to LoadLibrary
 * a non-existent node.exe. The host (node.exe OR electron.exe) exports the same
 * napi_* symbols, so resolution succeeds either way.
 *
 * This is a vendored copy of the canonical node-gyp src/win_delay_load_hook.cc.
 * It compiles to nothing on non-MSVC toolchains, so it is safe to leave in the
 * source set unconditionally.
 */

#ifdef _MSC_VER

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <delayimp.h>
#include <string.h>

#ifndef LBUG_HOST_BINARY
#define LBUG_HOST_BINARY "node.exe"
#endif

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary) {
    return NULL;
  }

  // Only intercept the host-executable import; let everything else load
  // normally. The import we redirect is recorded as node.exe by cmake-js.
  if (_stricmp(info->szDll, LBUG_HOST_BINARY) != 0) {
    return NULL;
  }

  // Return a handle to the current process image (the real host: node.exe or
  // electron.exe). Its exported napi_* symbols satisfy our imports.
  HMODULE m = GetModuleHandle(NULL);
  return (FARPROC) m;
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = load_exe_hook;

#endif  // _MSC_VER
