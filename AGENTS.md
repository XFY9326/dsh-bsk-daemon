# AGENTS.md

Instructions for AI coding agents and for DSH agents that *use* this bundle.
中文版见 [AGENTS.zh.md](AGENTS.zh.md).

## What this repository is

A single-file DeepSeek Harness **bundle** (`dsh-bsk-daemon`) that runs the BrowserSkill `bsk` bridge daemon as a child of the DSH host process. There is no build step and no runtime dependency: `index.js` is loaded directly by the Cordis loader.

```
index.js            plugin (exports name, inject, Config, apply)
cordis.patch.yml    bundle patch: inserts row id "bsk-daemon"
package.json        bundle manifest (dsh.bundle.patch, locale/icon exports)
locale/en.json      panel title/description (English)
locale/zh.json      panel title/description (Chinese)
icon.svg            panel icon
test/plugin.test.mjs  node:test suite, no dependencies
README.md           user documentation (English)
README.zh.md        user documentation (Chinese)
```

## For a DSH agent: install and use it

1. The bundle is published to GitHub Packages as `@xfy9326/dsh-bsk-daemon`, or available from a local checkout.
2. Install it with the `plugin_manager` tool.

   From the registry (the machine must have a `read:packages` token configured for `npm.pkg.github.com`):

   ```json
   {
     "action": "install_bundle",
     "target": "@xfy9326/dsh-bsk-daemon",
     "registry": "https://npm.pkg.github.com"
   }
   ```

   From a checkout at an absolute path:

   ```json
   { "action": "install_bundle", "target": "C:\\Tools\\dsh-bsk-daemon" }
   ```

   This writes the dependency into the active profile and applies the bundle patch. Treat `application: applied` as the success signal; `restart-required` means the row is not live yet. Plain `pnpm add` / `dsh plugin add` only adds the dependency and does not enable the bundle layer.

3. Verify with `bsk status --json` and `Get-Process bsk` (or your platform's equivalent). The daemon must be a child of the DSH host and serve the loopback port recorded in `~/.bsk/daemon.json`.
4. Do **not** try to start the daemon from a sandboxed shell. The whole point of the bundle is that a sandboxed child cannot start it. If the daemon is missing, toggle or reinstall the bundle, or restart DSH — do not run `bsk daemon start` inside a tool sandbox and do not delete `~/.bsk` runtime files.

## Hard invariants when changing this repository

Changes must keep all of these true. They are the reason the plugin exists and the reason it is safe to run unattended.

1. **Never signal a daemon you did not spawn.** The graceful stop (`bsk daemon stop`) may only run when `daemon.json`'s `pid` equals the pid of the child this plugin spawned. Otherwise only the child itself is killed.
2. **Register cleanup before spawning.** `ctx.effect(...)` must be registered before `spawn`, and its disposer must `return` the promise from the stop routine. Cordis awaits disposer promises; returning `undefined` re-introduces the reload race where an old daemon survives and the new fiber refuses to adopt it.
3. **`apply` must never reject.** A broken daemon may not block DSH boot: log and stay inert.
4. **Keep the restart budget self-healing.** Reset the attempt counter after the daemon has stayed up for a while; do not let a few old crashes permanently disable supervision.
5. **Only manage what you own.** If a reachable daemon already serves the same `BSK_HOME`, leave it alone; do not adopt, restart, or kill it.
6. **Config stays tiny and validated.** Three fields (`bskPath`, `bskHome`, `args`), validated by the exported standard schema. Update the schema, the defaults and this repo's `cordis.patch.yml` comment together.
7. **No machine-specific state in the repo.** No absolute user paths, no secrets, no `daemon.json` copies. Portability belongs in documented examples.
8. **Do not add runtime dependencies or build steps.** The bundle must load as plain ESM from a profile `link:` dependency.

## Platform perspective

The plugin is written against Node.js built-ins only, so it runs on Windows, macOS and Linux without platform branches:

- `daemon.json` is keyed by `sock_path` on every platform: a Windows named pipe or a Unix domain socket. `net.connect()` handles both.
- `bsk daemon stop` and the signal fallback are cross-platform.
- The Windows job object reaps the daemon when DSH dies; macOS/Linux have no equivalent, so a hard-killed DSH can leave an orphan daemon that the next start reuses.
- `windowsHide` is ignored outside Windows.

Keep that property: no `process.platform` branching unless a platform genuinely behaves differently, and no shell-specific command construction.

## Development workflow

- Edit `index.js`; there is no compile step.
- A running DSH host keeps the previously imported module. To test a code change, restart the host (the bundle patch is re-read on boot; HMR covers patch changes, not JavaScript module replacement).
- Run the test suite before committing:

  ```bash
  node --test
  ```

- The suite must stay hermetic: it uses a temporary `BSK_HOME` and a deliberately missing `bskPath`, so it never starts or stops a real daemon.

## Manual verification checklist

After a change that can affect lifecycle:

```powershell
# 1. unit tests
node --test

# 2. install/refresh the bundle, then check the daemon
bsk status --json
Get-CimInstance Win32_Process -Filter "Name='bsk.exe'" | Select-Object ProcessId, ParentProcessId

# 3. stop it behind the plugin's back; the plugin must restart it within ~5 s
bsk daemon stop --json
Start-Sleep 5
bsk status --json

# 4. toggle the bundle off; the daemon must exit and the port must be released
#    (plugin_manager set_bundle enabled=false), then toggle it back on
```

Record in the change description what you actually observed, not what should have happened. If you could not verify a path (for example no DSH host available), say so explicitly.

## Release

`.github/workflows/publish.yml` publishes on a `v*` tag. The workflow tests, publishes `@xfy9326/dsh-bsk-daemon` to GitHub Packages with the repository `GITHUB_TOKEN` (`packages: write`), packs the tarball and creates a GitHub Release.

1. Bump `version` in `package.json` (the workflow publishes exactly that version; re-publishing an existing version fails).
2. Update README/README.zh/AGENTS if behaviour, configuration or supported versions changed.
3. Run `node --test` and `npm pack --dry-run` locally.
4. Commit, tag `v<version>`, push the commit and the tag.
5. Confirm with `gh run list --workflow publish.yml`; check the package page and the release assets. Do not report success before the run is green.

Repository settings are intentionally minimal: Actions use only the default token, no secrets are stored.

## Supported versions

`package.json` does not declare DSH as a dependency — DSH loads the bundle. Keep the compatibility table in both READMEs accurate when testing a new DSH, Cordis or bsk release: it currently records DSH `0.2.1-rc.2`, Cordis `4.0.5`, bsk `0.3.3` and Node `>=22`.

## License

MIT. Contributions are accepted under the same license.
