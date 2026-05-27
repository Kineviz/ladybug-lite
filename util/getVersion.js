// Reads the version string a prebuilt lbugjs.node reports at runtime by
// dlopen-ing it and calling NodeDatabase.getVersion().
//
// Used as part of util/buildLbugjsNode.sh's cache check: the script trusts the
// cached binary only if its self-reported version matches the target. Any
// failure (file missing, libc/glibc mismatch, ABI mismatch, missing export,
// native crash caught by Node, unsupported arch) MUST collapse to printing
// "0.0.0" on stdout — the shell uses string equality against the target
// version, so "0.0.0" is a sentinel that always means "cache miss, recompile",
// never an exception that aborts the surrounding `set -e` script.
//
// Input (optional): LBUG_BIN_PATH env var = absolute path of the .node file to
// probe. If unset, falls back to the conventional prebuilt/<platform>-<arch>
// path, which is only correct on the host running the script (no musl vs glibc
// distinction). Callers in CI should always set LBUG_BIN_PATH explicitly.

const process = require("process");
const constants = require("constants");
const path = require("path");

const FAILURE_SENTINEL = "0.0.0";

function defaultBinPath() {
  let arch = process.arch;
  if (arch === "x64") {
    arch = "amd64";
  } else if (arch !== "arm64") {
    return null;
  }
  return path.join(__dirname, "..", "prebuilt", `lbugjs-${process.platform}-${arch}.node`);
}

function getVersion() {
  const binPath = process.env.LBUG_BIN_PATH || defaultBinPath();
  if (!binPath) return FAILURE_SENTINEL;

  const mod = { exports: {} };
  try {
    if (process.platform === "linux") {
      process.dlopen(mod, binPath, constants.RTLD_LAZY | constants.RTLD_GLOBAL);
    } else {
      process.dlopen(mod, binPath);
    }
  } catch (_) {
    return FAILURE_SENTINEL;
  }

  try {
    const v = mod?.exports?.NodeDatabase?.getVersion?.();
    return (typeof v === "string" && v) ? v : FAILURE_SENTINEL;
  } catch (_) {
    return FAILURE_SENTINEL;
  }
}

console.log(getVersion());
