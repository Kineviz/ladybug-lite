/**
 * Electron main-process smoke test for the ladybug-lite native addon.
 *
 * ⚠ MUST be launched with Electron, NOT plain Node:
 *     electron util/electron/electronSmokeTest.js
 * Running it with `node` will fail at require('electron') (no `app` object).
 *
 * Loads the repo's index.js (which loads ./lbugjs.node) inside Electron's main
 * process and runs a real query end-to-end. Exits 0 on success, 1 on failure,
 * so CI can gate on it. This is the verification that the Windows delay-load
 * fix actually makes the binary loadable under Electron (it is a no-op proof on
 * Linux/macOS, where the binary is already Electron-compatible).
 *
 * Run with:  electron util/electron/electronSmokeTest.js
 * The package root defaults to the repo root (two levels up); override with
 * LBUG_PKG_ROOT.
 *
 * IMPORTANT: clear ELECTRON_RUN_AS_NODE before launching, or Electron boots as
 * plain Node and require('electron') returns the launcher path instead of the
 * API (the `app` object will be undefined).
 */
"use strict";

const path = require("path");

const PASS_MARKER = "[electron-smoke] PASSED:";

// ── Launcher ────────────────────────────────────────────────────────────────
// We always run the real test in a child Electron process and judge success by
// this marker on its output — NOT by the child's exit code. Two reasons:
//   1. On Windows, Electron's process teardown can exit with an access violation
//      (0xC0000005) AFTER the test already succeeded, so the exit code is unreliable.
//   2. If ELECTRON_RUN_AS_NODE is set, the Electron binary boots as plain Node and
//      require('electron') has no `app`. We clear it for the child here.
// Net effect: `npm run test:electron` reports a correct 0/1 regardless of the
// caller's environment or Electron's flaky shutdown.
if (!process.env.LBUG_SMOKE_WORKER) {
  const { spawnSync } = require("child_process");
  const env = { ...process.env, LBUG_SMOKE_WORKER: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    env,
    encoding: "utf8",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const passed = typeof r.stdout === "string" && r.stdout.includes(PASS_MARKER);
  if (!passed) {
    console.error(
      `[electron-smoke] FAILED: worker did not report success ` +
        `(exit=${r.status}, signal=${r.signal}).`
    );
  }
  process.exit(passed ? 0 : 1);
}

// ── Worker (LBUG_SMOKE_WORKER=1) ─────────────────────────────────────────────
const { app } = require("electron");
const fs = require("fs");
const os = require("os");

if (!app) {
  console.error(
    "SMOKE TEST FAILED: require('electron') returned no app object. " +
      "Is ELECTRON_RUN_AS_NODE set? Unset it before launching Electron."
  );
  process.exit(1);
}

app.disableHardwareAcceleration();

const PKG_ROOT = process.env.LBUG_PKG_ROOT
  ? path.resolve(process.env.LBUG_PKG_ROOT)
  : path.resolve(__dirname, "..", "..");

function logVersions() {
  console.log(
    "[electron-smoke] versions:",
    JSON.stringify(
      {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        modules: process.versions.modules,
        napi: process.versions.napi,
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2
    )
  );
}

async function run() {
  logVersions();
  let exitCode = 0;
  let db;
  try {
    const lbug = require(path.join(PKG_ROOT, "index.js"));
    console.log(
      "[electron-smoke] REQUIRE OK. VERSION =",
      lbug.VERSION,
      "STORAGE_VERSION =",
      lbug.STORAGE_VERSION
    );

    const dbPath = path.join(os.tmpdir(), `lbug_electron_smoke_${process.pid}.db`);
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });

    db = new lbug.Database(dbPath);
    const conn = new lbug.Connection(db);

    await conn.query(`
      CREATE NODE TABLE Person (name STRING, age INT64, PRIMARY KEY(name));
      CREATE (:Person {name: 'Alice', age: 30});
      CREATE (:Person {name: 'Bob', age: 25});
    `);
    const qr = await conn.query(
      `MATCH (p:Person) RETURN p.name AS name, p.age AS age ORDER BY p.age;`
    );
    const rows = await qr.getAll();
    console.log("[electron-smoke] QUERY RESULT:", JSON.stringify(rows));

    const ok =
      rows.length === 2 &&
      rows[0].name === "Bob" &&
      rows[1].name === "Alice" &&
      Number(rows[0].age) === 25;
    if (!ok) {
      throw new Error("Unexpected query result: " + JSON.stringify(rows));
    }

    qr.close();
    conn.close();
    await db.close();
    db = null;
    try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch (_) {}

    console.log(
      `${PASS_MARKER} ladybug-lite loads and queries under Electron ${process.versions.electron}`
    );
  } catch (e) {
    exitCode = 1;
    console.error("[electron-smoke] FAILED:", e && e.stack ? e.stack : e);
  } finally {
    if (db) { try { await db.close(); } catch (_) {} }
    app.exit(exitCode);
  }
}

app.whenReady().then(run);
