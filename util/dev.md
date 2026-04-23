# ladybug-lite — Developer Guide

> This document is the single entry point for contributors. It supersedes the
> scattered notes in [`util/build.md`](build.md) and [`util/readme.md`](readme.md),
> which are kept as historical references.

---

## 1. What this repository is

`@kineviz/ladybug-lite` is a **redistribution layer** on top of the upstream
[`@ladybugdb/core`](https://www.npmjs.com/package/@ladybugdb/core) npm package.
It exists for two reasons:

1. **Smaller install footprint.** The upstream package ships every prebuilt
   binary for every platform in one tarball. We only ship the loader/JS and
   download the matching native binary on demand at install time.
2. **Alpine / musl libc support.** Upstream does not publish Alpine binaries.
   We build them ourselves (via `docker buildx` + QEMU) and host them in this
   repository's `prebuilt/` folder.

We do **not** fork the C++ engine. The runtime JS files
([`connection.js`](../connection.js), [`database.js`](../database.js),
[`query_result.js`](../query_result.js),
[`prepared_statement.js`](../prepared_statement.js),
[`lbug_native.js`](../lbug_native.js), [`index.js`](../index.js),
[`index.mjs`](../index.mjs), [`lbug.d.ts`](../lbug.d.ts)) are copied verbatim
from `@ladybugdb/core` by [`util/build.js`](build.js) on each release.

---

## 2. End-to-end data flow

```
              upstream npm
        ┌────────────────────────┐
        │  @ladybugdb/core@X.Y.Z │  (yarn add --force)
        └───────────┬────────────┘
                    │
                    ▼
        ┌─────────────────────────┐
        │ node_modules/@ladybugdb │
        │  /core/                 │
        │   ├─ *.js (runtime API) │
        │   ├─ lbug-source/       │  C++ sources (build only)
        │   └─ prebuilt/*.node    │  upstream's prebuilt binaries
        └───────────┬─────────────┘
                    │
       ┌────────────┼─────────────────────────┐
       │            │                         │
       ▼            ▼                         ▼
  util/build.js   buildLadybugWithDocker.sh   buildLadybugExtensions.sh
  (copies JS to   (compiles Alpine            (compiles extensions:
   repo root,     amd64/arm64 .node           httpfs, json, fts,
   bumps version, via docker buildx)          vector, neo4j, algo)
   npm publish)         │                          │
       │                ▼                          ▼
       │        prebuilt/lbugjs-          extensions/alpine-{arch}/
       │        alpine-{arch}.node         *.lbug_extension
       │                │                          │
       ▼                ▼                          │
  ┌─────────────────────────────────────┐          │
  │  git tag X.Y.Z + push prebuilt/     │◄─────────┘
  └────────────────┬────────────────────┘
                   │
                   ▼
         ┌──────────────────┐
         │  npm publish     │
         │  (release script)│
         └────────┬─────────┘
                  │
                  ▼
       ┌─────────────────────────┐
       │ user: npm install       │
       │ @kineviz/ladybug-lite   │
       └────────┬────────────────┘
                │
                ▼  (postinstall hook)
       util/install.js
                │
                │  detects platform / arch / Alpine
                ▼
       https://raw.githubusercontent.com/Kineviz/ladybug-lite/
         refs/tags/{version}/prebuilt/lbugjs-{platform}-{arch}.node
                │  (CDN fallback: graphxr.oss-cn-shanghai.aliyuncs.com)
                ▼
       writes ./lbugjs.node  ──► loaded at runtime by
                                 lbug_native.js (RTLD_GLOBAL on Linux)
```

---

## 3. Repository layout (by responsibility)

| Group | Path | Purpose |
| --- | --- | --- |
| Runtime API (synced from upstream) | [`index.js`](../index.js), [`index.mjs`](../index.mjs), [`connection.js`](../connection.js), [`database.js`](../database.js), [`query_result.js`](../query_result.js), [`prepared_statement.js`](../prepared_statement.js), [`lbug_native.js`](../lbug_native.js), [`lbug.d.ts`](../lbug.d.ts) | Pure JS surface; do **not** edit by hand — they are overwritten by `build.js` |
| Native binary (per-machine) | `lbugjs.node` (root) | Active binary loaded at runtime; produced by `install.js` or `copy.js` |
| Prebuilt binaries (shipped) | [`prebuilt/`](../prebuilt/) | One `lbugjs-{platform}-{arch}.node` per supported target |
| Build / install scripts | [`util/`](.) | Everything in this guide |
| CI workflows | [`.github/workflows/`](../.github/workflows/) | `build.yaml`, `buildExtension.yaml`, `daily.yaml` |
| Container build | [`Dockerfile`](../Dockerfile) | Multi-stage, multi-arch Alpine build (amd64 + arm64) |
| Packaging | [`package.json`](../package.json), [`.npmignore`](../.npmignore) | The `.npmignore` whitelists `util/*.*` and `package.json` only — everything else is included by default |

---

## 4. Environment prerequisites

| Tool | Why | Required for |
| --- | --- | --- |
| Node.js 18 | Build & test | Everything |
| yarn | Package manager used by all scripts | Everything |
| Docker (with buildx) | Multi-arch Alpine builds | `build:ladybug`, extensions |
| `qemu-user-static` (host) | Cross-arch emulation when building arm64 on amd64 host | `buildLadybugWithDocker.sh` |
| `npm` token in env (`NPM_TOKEN`) | Publishing | `release` |
| Python 3 + `pandas` (optional) | Only for the Python subprocess helper | `safe_ladybug_subprocess.py` |

On Debian/Ubuntu hosts:

```sh
sudo apt-get install -y qemu-user-static
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
```

---

## 5. `util/` scripts in detail

### 5.1 `build.js` — sync upstream + publish

Driven by `yarn build` (alias for `node util/build.js`).

What it does, in order:

1. **`deleteFiles(rootDir, [...])`** — wipes the repo root **except** for a
   small allowlist (`package.json`, `util`, `node_modules`, `README.md`,
   `test`, `.git`, `.vscode`, `.gitignore`, `.github`, `.dockerignore`,
   `Dockerfile`, `.npmignore`, `docs`, `prebuilt`).
2. **`copyDir(node_modules/@ladybugdb/core, rootDir, [...])`** — copies the
   upstream package into the repo root, **excluding**:
   - `lbug-source` (multi-GB C++ source tree)
   - `node_modules`
   - `lbugjs.node` (we ship per-platform copies separately)
   - upstream `package.json` (we keep ours)
   - upstream `install.js` (replaced by ours)
   - upstream `README.md`, `Dockerfile`, `.npmignore`, etc. (we keep ours)
   - upstream `prebuilt/` (we ship our own from `prebuilt/`)
3. **`asyncVersion()`** — reads upstream's `package.json` version, mirrors it
   into our `package.json` and `devDependencies["@ladybugdb/core"]`, then
   triggers `npmPublish()`.
4. **`npmPublish()`** — writes `.npmrc` from `process.env.NPM_TOKEN` and runs
   `npm publish --access public --registry https://registry.npmjs.org`.

> **Heads up:** `build.js` is destructive. Always run it on a clean working
> tree on the `release` branch — never on `main` or a feature branch with
> uncommitted work. CI runs it after `yarn add @ladybugdb/core --force`, so
> the upstream is always present in `node_modules/`.

### 5.2 `install.js` — runs on the consumer's machine

Driven by `npm install` via the `"install"` lifecycle script in
`package.json`.

Detection logic:

```
arch     = process.arch                          // x64, arm64, ...
platform = process.platform                      // linux, darwin, win32

if platform == "linux" and /etc/os-release contains "Alpine Linux":
    platform = "alpine"
    if arch == "x64":  arch = "amd64"            // historical naming
```

Download:

1. Primary: `https://raw.githubusercontent.com/Kineviz/ladybug-lite/refs/tags/{version}/prebuilt/lbugjs-{platform}-{arch}.node`
2. CDN fallback (on any error): `https://graphxr.oss-cn-shanghai.aliyuncs.com/ladybug@{version}/lbugjs-{platform}-{arch}.node`

Both honor `HTTP_PROXY` / `HTTPS_PROXY` / `PROXY` (and lowercase variants) via
`https-proxy-agent`.

Written to `./lbugjs.node` in the package root. The version used in the URL is
`packageJson.version.split("-")[0]` — so a `0.15.3-beta.1` would still pull
`0.15.3` artifacts.

> **If both downloads fail**, the install error message includes
> `sean@kineviz.com` as the contact. The most common cause is a brand-new
> version where CI hasn't yet pushed the prebuilt for the user's platform —
> see §10.

### 5.3 `copy.js` — local shortcut

```sh
yarn copy
```

Picks the matching binary out of `prebuilt/` and copies it to `./lbugjs.node`.
Use this on a developer machine to test against a freshly committed binary
without having to publish a new version.

### 5.4 `test.js` / `test.large.js`

- [`test.js`](test.js) — creates a tiny Movie/Person/ActedIn graph in a
  fresh on-disk DB at `util/demo_test.db`, runs a `MATCH` query, prints rows.
  Used by CI as the smoke test inside Alpine containers.
- [`test.large.js`](test.large.js) — runs a 20k-row query against an
  existing `util/demo_large` DB. Not used in CI; for local performance
  spot-checks only.

### 5.5 `buildLadybugWithDocker.sh`

Local-only multi-arch Alpine build (CI uses an inline equivalent in
`build.yaml`):

1. `docker buildx build --platform=linux/amd64 --target build-amd64` — builds
   the `build-amd64` stage from [`Dockerfile`](../Dockerfile).
2. `docker create` + `docker cp` to extract
   `lbugjs-alpine-amd64.node` into `./prebuilt/`.
3. Resets QEMU (`multiarch/qemu-user-static --reset -p yes`).
4. Same dance for `linux/arm64`.
5. Runs `test.js` inside an `arm64` Alpine container against the freshly
   extracted binary.

> **Known papercut:** in the current script, line 20 reads
> `Build arm64 artifact` (no leading `#`), which the shell will try to
> execute as a command. It fails harmlessly with "command not found" and
> the script continues. Add a `#` if the noise bothers you.

### 5.6 `buildLadybugExtensions.sh`

Independently builds the engine extensions (`httpfs`, `json`, `fts`,
`vector`, `neo4j`, `algo`) via cmake against
`node_modules/@ladybugdb/core/lbug-source/`. Must run **inside** the target
Alpine container (the GitHub workflow `buildExtension.yaml` does exactly
that).

Outputs land in `${LBUG_SOURCE_DIR}/extension/alpine-{arch}/` as
`*.lbug_extension` and `*.kuzu_extension` files. `buildExtension.yaml`
commits them under `extensions/` in this repo.

> **Note on extension distribution:** the engine resolves extensions at
> runtime by downloading from
> `https://extension.ladybugdb.com/v{version}/{platform}/{name}` into
> `~/.ladybug/extension/{version}/{platform}/`. The extensions we build
> here are intended for that hosting layer, **not** to be shipped inside
> the npm tarball.

### 5.7 `safe_ladybug_subprocess.py`

A standalone Python helper that runs the **`real_ladybug`** Python binding
(not this npm package) inside a forked subprocess via `multiprocessing.Pipe`,
so a crash in the engine cannot take down the parent process. It is unrelated
to the npm publish flow and is included here only for convenience of teams
who use both bindings. Skip it unless you are working on Python integration.

---

## 6. Three release paths

### 6.1 Local manual release (full)

Use this when you need to ship an Alpine update from your laptop, e.g. when
CI is wedged.

```sh
# 0. Be on the release branch with a clean tree.
git checkout release && git status

# 1. Pull the upstream version you want to track.
yarn cache clean
yarn add @ladybugdb/core --force

# 2. Build Alpine prebuilts (amd64 + arm64) into ./prebuilt/.
yarn build:ladybug                # = bash util/buildLadybugWithDocker.sh

# 3. (Optional) Build native prebuilts for the host platform if missing.
#    For Linux x64 / Linux arm64 / darwin-arm64 / win32-x64 you typically
#    rely on the corresponding GitHub Actions runner; do this manually
#    only if you have the right hardware.

# 4. Sync upstream JS into the repo root, bump version, and publish.
NPM_TOKEN=xxxxx yarn build         # runs util/build.js → npm publish

# 5. Tag the release so install.js can fetch from raw.githubusercontent.
git tag -a "$(node -p "require('./package.json').version")" -m "Release"
git push origin --tags
```

Verify the consumer flow:

```sh
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm install @kineviz/ladybug-lite
node -e "console.log(require('@kineviz/ladybug-lite').VERSION)"
```

### 6.2 CI-driven release (the normal path)

There are three workflows in [`.github/workflows/`](../.github/workflows/):

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`build.yaml`](../.github/workflows/build.yaml) | push / PR to `release`, manual | Matrix `{amd64, arm64}` on Ubuntu runners. Builds Alpine `.node` inside `node:22-alpine` container, copies to `prebuilt/`, runs `util/test.js` smoke test in Alpine, commits `prebuilt/*.node + *.js + package.json` to the release branch, tags with the upstream version (`0.15.3` etc.), publishes via `yarn build`. |
| [`buildMacOsIntel.yaml`](../.github/workflows/buildMacOsIntel.yaml) | push / PR to `release`, manual | Single job on `macos-26-intel`. Compiles `lbug-source/tools/nodejs_api` from source (upstream ships no darwin-x64), copies the result to `prebuilt/lbugjs-darwin-x64.node`, runs `util/test.js` natively, commits/tags/publishes the same way `build.yaml` does. Races with `build.yaml` on push/tag — the `merge -X ours` strategy and `npm publish` no-op-on-existing handle this safely. |
| [`buildExtension.yaml`](../.github/workflows/buildExtension.yaml) | push / PR to `release`, manual | Matrix `{amd64, arm64}`. Runs `util/buildLadybugExtensions.sh` inside `node:22-alpine`, force-pushes the resulting `extensions/*/*.lbug_extension` files. |
| [`daily.yaml`](../.github/workflows/daily.yaml) | cron `0 0 * * *` | Compares `npm view @ladybugdb/core version` vs `npm view @kineviz/ladybug-lite version`. If upstream is newer, opens an issue and triggers `build.yaml` via `workflow_dispatch`. **Note:** does not currently dispatch `buildMacOsIntel.yaml` — Intel Mac binaries piggyback on the next manual or PR-triggered run. |

So the **normal release cadence** is: upstream bumps → `daily.yaml` notices →
`build.yaml` runs on both arches → tag + npm publish. No human action
required unless something breaks.

> **Secrets** required in GitHub `TOKENS` environment: `NPM_TOKEN` (publish),
> `NPM_TOKENS` (npmrc auth — yes, both spellings are used as of today).

### 6.3 Local quick verify (no publish)

For day-to-day iteration on the JS surface or `util/` scripts:

```sh
yarn add @ladybugdb/core --force        # only if you don't already have it
yarn copy                               # prebuilt/* → ./lbugjs.node
yarn test                               # runs util/test.js
```

This skips `build.js` entirely — useful when you only need a working
runtime and want to avoid rewriting the repo root.

---

## 7. Prebuilt binary naming convention

| File | Built by | Notes |
| --- | --- | --- |
| `lbugjs-linux-x64.node` | upstream `@ladybugdb/core` | Copied from `node_modules/@ladybugdb/core/prebuilt/` |
| `lbugjs-linux-arm64.node` | upstream | same |
| `lbugjs-darwin-arm64.node` | upstream | Apple Silicon |
| `lbugjs-darwin-x64.node` | **us** (`buildMacOsIntel.yaml`, `macos-26-intel` runner) | Built from source; upstream does not ship Intel Mac for 0.15.x |
| `lbugjs-win32-x64.node` | upstream | |
| `lbugjs-alpine-amd64.node` | **us** (`buildLadybugWithDocker.sh` / `build.yaml`) | musl libc |
| `lbugjs-alpine-arm64.node` | **us** | musl libc |

**Time-bounded support:** `darwin-x64` (Intel Mac) depends on the
`macos-26-intel` GitHub-hosted runner, which Apple/GitHub will retire in
Fall 2027. After that, Intel Mac users must build from source locally.

The naming inconsistency between `linux-x64` (Node arch) and `alpine-amd64`
(Docker arch) is historical and is normalized by `install.js` — see §5.2.

---

## 8. Engine extensions

When user code runs `LOAD EXTENSION httpfs`, the engine downloads the
extension from `https://extension.ladybugdb.com/v{VERSION}/{platform}/{ext}`
into `~/.ladybug/extension/{VERSION}/{platform}/`. We do not need to ship
extensions inside the npm tarball — but for Alpine targets we **do** need to
build them ourselves (since upstream's CDN may not host musl variants for
every release).

- Build script: [`util/buildLadybugExtensions.sh`](buildLadybugExtensions.sh)
- CI: [`.github/workflows/buildExtension.yaml`](../.github/workflows/buildExtension.yaml)
- Output committed at: `extensions/alpine-{arch}/*.lbug_extension`

If you're adding a new extension to the build list, edit the
`EXTENSION_LIST` variable in `buildLadybugExtensions.sh` (currently
`httpfs;json;fts;vector;neo4j;algo`).

---

## 9. Common issues and fixes

**`Failed to download: 404` during `npm install`.**
The tag for your version doesn't exist yet, or the prebuilt for your
platform/arch wasn't pushed. Check
`https://github.com/Kineviz/ladybug-lite/tree/{version}/prebuilt`. If the
file is missing, re-run `build.yaml` for the affected arch.

**Both primary and CDN downloads fail behind a corporate proxy.**
Set `HTTPS_PROXY=http://user:pass@host:port` (case-insensitive variants
also accepted) before `npm install`. See `install.js:33`.

**Alpine container reports `Error loading shared library libc.musl-...`.**
You loaded a `lbugjs-linux-*.node` (glibc) inside Alpine. Confirm
`install.js` detected Alpine — it greps `/etc/os-release` for the literal
string `Alpine Linux`. Distros that derive from Alpine but rewrote that
file will fail detection.

**`docker buildx` complains about `linux/arm64` on an amd64 host.**
You forgot the QEMU registration step. Run
`docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`
once per boot.

**`build.js` deleted my work.** Read §5.1 again — it wipes the repo root.
Always run it on a clean `release` branch.

**`yarn build` runs out of memory inside a small Alpine container.**
Limit C++ build threads. In `node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api/build.js`:

```sh
sed -i 's/THREADS =/THREADS = 2;\/\//' build.js
```

---

## 10. Adding a new platform or version — checklist

When the supported matrix changes (new Node version, new arch, new platform):

- [ ] Add the `lbugjs-{platform}-{arch}.node` entry to `prebuilt/`
- [ ] Verify `install.js` detection logic produces the right
      `{platform}-{arch}` string for that OS (add a branch if not)
- [ ] Add a corresponding matrix entry to `.github/workflows/build.yaml`
      (and `buildExtension.yaml` if the extension matrix changes)
- [ ] Add a build stage to `Dockerfile` if the platform is Alpine-based
- [ ] Update the compatibility table in the root [`README.md`](../README.md)
- [ ] Update §7 of this document
- [ ] Run `yarn copy && yarn test` on a real machine of that platform
      before tagging
