# dsh-bsk-daemon

A DeepSeek Harness (DSH) bundle that gives the **BrowserSkill `bsk` bridge daemon** the same lifecycle as DSH on Windows: it starts with DSH, is stopped when DSH exits, is restarted after a crash (bounded), and is never confused with a daemon somebody else started.

[中文说明](README.zh.md) · [Agent instructions](AGENTS.md) · [中文 Agent 说明](AGENTS.zh.md)

---

## The problem it solves

BrowserSkill exposes browser automation to DSH through `bsk_*` tools backed by a local `bsk` daemon. On Windows, that daemon **cannot be started from inside DSH's tool sandbox**:

- the sandboxed child cannot break away from the Windows job object,
- it cannot write `~/.bsk`,
- it cannot open the daemon's IPC named pipe.

So the daemon has to be started by an unsandboxed process. Without this bundle the usual workaround is a separate console running `bsk daemon start --foreground` that the user must keep open, or a scheduled task that outlives DSH.

This bundle moves that responsibility into the DSH host process itself: the daemon becomes a DSH child with a DSH lifetime.

## What it does

| Behaviour | Detail |
| --- | --- |
| Start | On plugin load, spawns `bsk daemon start --foreground --daemon-idle 30d` (configurable) as a host child process |
| Stop | On plugin unload / DSH exit, asks the daemon to stop with `bsk daemon stop`, then waits, then kills |
| Ownership | Only signals a child it spawned: the CLI stop path is used only when `daemon.json` records this child's pid |
| Existing daemons | If a reachable daemon already serves the same `BSK_HOME`, it is left untouched |
| Crash handling | Restarts after 2 s, at most 5 attempts in a row; the budget resets once the daemon has stayed up for 60 s |
| Config | Validated by a small standard-schema validators; unknown keys and malformed values fail the plugin load with a clear message |
| Boot safety | A broken daemon never prevents DSH from booting — errors are logged and the plugin stays inert |

## Requirements

- Windows 10/11
- DeepSeek Harness with profile bundles (tested with `@deepseek-ai/dsh` **0.2.1-rc.2**)
- [BrowserSkill](https://github.com/Tencent/BrowserSkill) extension and the `bsk` CLI (tested with **0.3.3**)
- The `bsk` executable available on `PATH`, or its absolute path set in the row config
- An active DSH profile (a `link:` dependency is written into that profile)

## Installation

1. Clone this repository somewhere stable (the DSH profile links to this directory):

   ```powershell
   git clone https://github.com/XFY9326/dsh-bsk-daemon.git C:\Tools\dsh-bsk-daemon
   ```

2. Ask your DSH agent to install the bundle by absolute path, using the built-in `plugin_manager` tool:

   > Install the bundle at `C:\Tools\dsh-bsk-daemon` with `plugin_manager` `install_bundle`.

   The tool adds a `link:` dependency to the active profile, applies the bundle patch, and should report `application: applied`. The bundle is a bundle, so it is **not** pruned by later pnpm installs.

3. Verify:

   ```powershell
   bsk status --json
   Get-Process bsk
   ```

   `bsk status --json` should report a live daemon (pid, `ws_port`, connected browsers). The plugin row is visible in DSH Settings → Plugins as **bsk Daemon Supervisor** / **bsk 守护进程托管**.

A DSH restart is normally not required (the new bundle is applied through HMR), but restart if the row does not appear.

### Manual install without the agent tool

`plugin_manager` is the supported path because it writes the profile dependency and lockfile for you. If you must do it by hand, the equivalent state is a `link:` dependency in the active profile's `package.json` plus a `bsk-daemon` row from this bundle's `cordis.patch.yml`; hand-editing profile files is easy to get wrong, so prefer the tool.

## Configuration

The bundle inserts one row:

```yaml
- id: bsk-daemon
  name: 'dsh-bsk-daemon'
```

With no `config`, the defaults are:

| Key | Default | Meaning |
| --- | --- | --- |
| `bskPath` | `bsk` | Executable name on `PATH`, or an absolute path |
| `bskHome` | `$BSK_HOME` or `~/.bsk` | Where `daemon.json`, the IPC pipe and logs live |
| `args` | `daemon start --foreground --daemon-idle 30d` | Arguments passed to `bskPath` |

To override, edit this bundle's [`cordis.patch.yml`](cordis.patch.yml) **before installing**:

```yaml
- insert:
    - id: bsk-daemon
      name: 'dsh-bsk-daemon'
      config:
        bskPath: 'C:\Tools\bsk\bsk.exe'
        bskHome: 'C:\Users\me\.bsk'
        args: [daemon, start, --foreground, --daemon-idle, 30d]
```

Row config is **replaced wholesale**, so restate every field you need. If the daemon should never be started by DSH (for example you run a shared daemon yourself), disable the row instead of pointing it elsewhere.

## Verification

```powershell
# 1. Is the daemon up and serving?
bsk status --json

# 2. Is it a child of the DSH host process?
Get-CimInstance Win32_Process -Filter "Name='bsk.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine

# 3. Daemon log (written by bsk itself)
Get-Content "$env:USERPROFILE\.bsk\daemon.log.*" -Tail 20
```

Expected: one `bsk.exe` whose parent is the DSH process, a listening loopback port (default `52800`), and `daemon.json` containing `sock_path` plus `host_managed: true`.

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
└── plugin row: bsk-daemon (dsh-bsk-daemon)
    └── bsk.exe daemon start --foreground --daemon-idle 30d
        ├── ~/.bsk/daemon.json      (pid, sock_path, ws_port)
        ├── \\.\pipe\bsk-daemon-*   (IPC)
        └── ws://127.0.0.1:52800    (browser extension)
```

Startup probes `daemon.json` and connects to `sock_path` before spawning anything, so a daemon started by another host or by hand is reused instead of duplicated. Shutdown uses the CLI stop only when the recorded pid is this plugin's own child, so a foreign daemon is never signalled.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `bsk_*` tools still report no daemon | Is the `bsk-daemon` row enabled? Run `bsk status --json`; inspect the DSH log for `[bsk-daemon]` lines |
| Daemon exits immediately | Run the configured command manually (`bsk daemon start --foreground`) to see the error; check `bskPath` |
| Two daemons appear | Only the plugin's own child is managed. A foreign daemon is deliberately left alone; stop it yourself if it is stale |
| Plugin vanished after installing another plugin | Should not happen with a `link:` bundle dependency. If the checkout moved, reinstall the bundle |
| Restart loop, then silence | The plugin gives up after 5 consecutive failures; fix the underlying error and restart DSH (or toggle the bundle) |
| `bsk status` works but `bsk_*` tools fail | Restart DSH so the browser-skill plugin reconnects to the managed daemon |

## Uninstall

Ask your DSH agent to remove the bundle (`plugin_manager` `remove_bundle`, target `dsh-bsk-daemon`), or disable it to stop the daemon while keeping the files. Removing the profile dependency by hand leaves the patch row behind.

## Security notes

- The bundle only spawns the `bsk` binary you configure; no downloads, no install scripts.
- It opens no new network listeners; the daemon's loopback port and IPC pipe belong to BrowserSkill.
- No credentials are read or stored. The config schema is limited to three plain fields.

## Development

```powershell
node --test test/     # zero-dependency test suite (node:test)
```

There is no build step: `index.js` is shipped as-is.

## Keywords

`dsh`, `deepseek-harness`, `cordis`, `bundle`, `browserskill`, `bsk`, `daemon`, `browser-automation`, `windows`

## License

[MIT](LICENSE)
