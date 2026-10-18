# dsh-bsk-daemon

[![test](https://github.com/XFY9326/dsh-bsk-daemon/actions/workflows/test.yml/badge.svg)](https://github.com/XFY9326/dsh-bsk-daemon/actions/workflows/test.yml)
[![package](https://img.shields.io/badge/package-GitHub%20Packages-2ea44f?logo=github)](https://github.com/XFY9326/dsh-bsk-daemon/pkgs/npm/dsh-bsk-daemon)

A DeepSeek Harness (DSH) bundle that gives the **BrowserSkill `bsk` bridge daemon** the same lifecycle as DSH: it starts with DSH, is stopped when DSH exits, is restarted after a crash (bounded), and is never confused with a daemon somebody else started.

Runs on **Windows, macOS and Linux** — see [Platform support](#platform-support).

[中文说明](README.zh.md) · [Agent instructions](AGENTS.md) · [中文 Agent 说明](AGENTS.zh.md)

---

## Why this exists

BrowserSkill exposes browser automation to DSH through `bsk_*` tools backed by a local `bsk` daemon. Some agent hosts run shell commands in a sandbox that **reaps or forbids the daemon**. The concrete Windows case:

- a sandboxed child cannot break away from the Windows job object,
- it cannot write `~/.bsk`,
- it cannot open the daemon's IPC endpoint.

Linux agents hit the equivalent problem with `bubblewrap`-style sandboxes that kill command children. The documented workaround is to keep the daemon in a persistent host context and use local IPC from the sandbox — which is exactly what a supervisor in the DSH host process provides.

This bundle moves that responsibility into DSH itself: the daemon becomes a DSH child with a DSH lifetime.

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| Windows 10/11 x64 | **Verified end to end** | Daemon started, stopped, restarted through the plugin in real use; job object also reaps it if DSH dies. |
| macOS (Apple Silicon / Intel) | Supported, not yet run on real hardware | Same code path; IPC is a Unix domain socket, `bsk daemon stop` and signal handling are cross-platform. |
| Linux x64 / ARM64 | Supported, not yet run on real hardware | Same as macOS; the `bubblewrap` sandbox case is the closest analogue to Windows. |
| Node.js 22+ | CI matrix | The test suite runs on `ubuntu-latest`, `macos-latest`, `windows-latest` for Node 22 and 24. |

Confirmed by the test matrix: module load, config validation, effect registration order and awaitable disposal on all three operating systems. A real `bsk` daemon is only exercised on Windows so far; a Unix run needs a machine with the CLI and the browser extension.

## Compatibility

| Component | Supported | Tested with |
| --- | --- | --- |
| DeepSeek Harness | `0.2.x` profiles with bundle support | `0.2.1-rc.2` |
| Cordis plugin API | 4.x (`ctx.effect`, standard-schema `Config`) | `4.0.5` |
| BrowserSkill `bsk` | 0.3.x | `0.3.3` |
| Node.js | `>=22` | 22, 24 (CI), 26 (local) |

Older DSH releases that do not support profile bundles cannot load this package; use the [local checkout install](#from-a-local-checkout) only if your DSH supports `plugin_manager install_bundle`.

## Installation

### From GitHub Packages

The package is published to GitHub Packages as `@xfy9326/dsh-bsk-daemon`. GitHub requires authentication even to read public packages, so first make a token with `read:packages` available to npm:

```powershell
npm config set @xfy9326:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken $env:GITHUB_TOKEN
```

or interactively:

```powershell
npm login --scope=@XFY9326 --registry=https://npm.pkg.github.com
```

Then ask your DSH agent to install the bundle:

> Install `@xfy9326/dsh-bsk-daemon` from `https://npm.pkg.github.com` with `plugin_manager` `install_bundle`.

The tool records the dependency in the active profile, applies the bundle patch, and should report `application: applied`. You can also run it directly:

```json
{
  "action": "install_bundle",
  "target": "@xfy9326/dsh-bsk-daemon",
  "registry": "https://npm.pkg.github.com"
}
```

Do not install it with plain `pnpm add` / `dsh plugin add` alone: those only add the dependency, they do not enable the bundle layer.

### From a local checkout

```powershell
git clone https://github.com/XFY9326/dsh-bsk-daemon.git C:\Tools\dsh-bsk-daemon
```

Then ask your DSH agent to install the bundle at that absolute path with `plugin_manager` `install_bundle`. The profile gets a `link:` dependency, so the checkout must not be moved afterwards.

### After install

```powershell
bsk status --json
```

The daemon should be reported as a child of the DSH host process. The plugin row appears in DSH Settings → Plugins as **bsk Daemon Supervisor** / **bsk 守护进程托管**.

A DSH restart is normally not required (the bundle is applied through HMR), but restart if the row does not appear.

## Configuration

The bundle inserts one row with no `config`; the defaults are:

| Key | Default | Meaning |
| --- | --- | --- |
| `bskPath` | `bsk` | Executable name on `PATH`, or an absolute path |
| `bskHome` | `$BSK_HOME` or `~/.bsk` | Where `daemon.json`, the IPC endpoint and logs live |
| `args` | `daemon start --foreground --daemon-idle 30d` | Arguments passed to `bskPath` |

To override, edit this bundle's [`cordis.patch.yml`](cordis.patch.yml) before installing:

```yaml
- insert:
    - id: bsk-daemon
      name: '@xfy9326/dsh-bsk-daemon'
      config:
        bskPath: 'C:\Tools\bsk\bsk.exe'
        bskHome: 'C:\Users\me\.bsk'
        args: [daemon, start, --foreground, --daemon-idle, 30d]
```

Row config is **replaced wholesale**. If the daemon should never be started by DSH (for example you run a shared daemon yourself), disable the row instead.

## Cross-platform behaviour

The plugin only uses Node.js built-ins (`child_process`, `net`, `fs`, `os`, `path`), so no platform branching is needed in the code:

- **Probing** reads `daemon.json` and connects to `sock_path`. On Windows that is a named pipe (`\\.\pipe\bsk-daemon-*`); on macOS/Linux it is a Unix domain socket (`~/.bsk/run/daemon.sock`). `net.connect()` handles both.
- **Stopping** uses the same CLI on every platform (`bsk daemon stop`), only when `daemon.json`'s `pid` is this plugin's own child, then falls back to a signal.
- **Lifecycle difference:** Windows job objects also reap the daemon if DSH is killed hard. On macOS/Linux there is no such mechanism, so a hard-killed DSH leaves the daemon running; the next DSH start probes it and reuses it instead of starting a second one. A normal DSH exit stops it through the plugin either way.
- `windowsHide` is a Windows-only spawn option; it is ignored elsewhere.

## Verification

```powershell
# Is the daemon up and serving?
bsk status --json

# Is it a child of the DSH host process? (Windows)
Get-CimInstance Win32_Process -Filter "Name='bsk.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine

# The same on macOS/Linux
pgrep -fl 'bsk daemon start --foreground'

# Daemon log, written by bsk itself
Get-Content "$env:USERPROFILE\.bsk\daemon.log.*" -Tail 20   # Windows
tail -n 20 ~/.bsk/daemon.log.*                            # macOS/Linux
```

Expected: one daemon process whose parent is the DSH process, a listening loopback port (default `52800`), and `daemon.json` containing `sock_path` plus `host_managed: true`.

To exercise the lifecycle end to end:

```powershell
# restart it behind the plugin's back; the plugin should bring it back within a few seconds
bsk daemon stop --json
Start-Sleep 5
bsk status --json
```

## How it works

```
DSH host process
└── plugin row: bsk-daemon (@xfy9326/dsh-bsk-daemon)
    └── bsk daemon start --foreground --daemon-idle 30d
        ├── ~/.bsk/daemon.json      (pid, sock_path, ws_port)
        ├── IPC endpoint            (named pipe / Unix socket)
        └── ws://127.0.0.1:52800    (browser extension)
```

Startup probes `daemon.json` and connects to `sock_path` before spawning anything, so a daemon started by another host or by hand is reused instead of duplicated. Shutdown uses the CLI stop only when the recorded pid is this plugin's own child, so a foreign daemon is never signalled.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `bsk_*` tools still report no daemon | Is the `bsk-daemon` row enabled? Run `bsk status --json`; inspect the DSH log for `[bsk-daemon]` lines |
| Daemon exits immediately | Run the configured command manually (`bsk daemon start --foreground`) to see the error; check `bskPath` |
| Install fails with 401/403 from `npm.pkg.github.com` | Your npm token is missing or lacks `read:packages`; redo the auth step |
| Two daemons appear | Only the plugin's own child is managed. A foreign daemon is deliberately left alone; stop it yourself if it is stale |
| `bsk status` works but `bsk_*` tools fail | Restart DSH so the browser-skill plugin reconnects to the managed daemon |
| Restart loop, then silence | The plugin gives up after 5 consecutive failures; fix the underlying error and restart DSH (or toggle the bundle) |

## Uninstall

Ask your DSH agent to remove the bundle (`plugin_manager` `remove_bundle`, target `@xfy9326/dsh-bsk-daemon`), or disable it to stop the daemon while keeping the files.

## Security notes

- The bundle only spawns the `bsk` binary you configure; no downloads, no install scripts.
- It opens no new network listeners; the daemon's loopback port and IPC endpoint belong to BrowserSkill.
- No credentials are read or stored. The config schema is limited to three plain fields.

## Development

```powershell
node --test     # zero-dependency test suite (node:test)
npm pack --dry-run    # inspect the published file set
```

CI: [`.github/workflows/test.yml`](.github/workflows/test.yml) runs the suite on Ubuntu, macOS and Windows for Node 22 and 24. Pushing a `v*` tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which tests, publishes to GitHub Packages and creates a GitHub Release with the packed tarball.

## Keywords

`dsh`, `deepseek-harness`, `cordis`, `bundle`, `browserskill`, `bsk`, `daemon`, `browser-automation`, `windows`, `macos`, `linux`, `cross-platform`

## License

[MIT](LICENSE)
