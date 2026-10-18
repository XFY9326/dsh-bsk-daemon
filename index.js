/**
 * DSH bundle: supervise the BrowserSkill (`bsk`) bridge daemon.
 *
 * The daemon must be started outside the DSH tool sandbox (a sandboxed child
 * cannot break away from the Windows job object, write `~/.bsk`, or open the
 * IPC named pipe). This plugin runs in the DSH host process, so it spawns
 * `bsk daemon start --foreground` as a host child and gives the daemon the
 * same lifecycle as the host:
 *
 * - starts with the plugin, stops when the plugin (or DSH) exits;
 * - a graceful `bsk daemon stop` is tried first, and only this plugin's own
 *   child is ever signalled, so a manually started daemon is never touched;
 * - if the daemon keeps exiting, it is restarted a bounded number of times,
 *   and the restart budget resets once the daemon has stayed up long enough.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'bsk-daemon'
export const inject = []

const PROBE_TIMEOUT_MS = 800
const RESTART_DELAY_MS = 2000
const MAX_RESTARTS = 5
const STABLE_UPTIME_MS = 60_000
const STOP_TIMEOUT_MS = 3000
const DEFAULT_ARGS = ['daemon', 'start', '--foreground', '--daemon-idle', '30d']
const CONFIG_KEYS = ['bskPath', 'bskHome', 'args']

/** Standard-schema validator for the row's `config` (no runtime dependency needed). */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-bsk-daemon',
    validate(value) {
      if (value === undefined || value === null) value = {}
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be a mapping' }] }
      }
      const issues = []
      const result = {}
      for (const key of Object.keys(value)) {
        if (!CONFIG_KEYS.includes(key)) issues.push({ message: `unknown config key: ${key}` })
      }
      if (value.bskPath !== undefined) {
        if (typeof value.bskPath !== 'string' || value.bskPath.length === 0) {
          issues.push({ message: 'bskPath must be a non-empty string' })
        } else {
          result.bskPath = value.bskPath
        }
      }
      if (value.bskHome !== undefined) {
        if (typeof value.bskHome !== 'string' || value.bskHome.length === 0) {
          issues.push({ message: 'bskHome must be a non-empty string' })
        } else {
          result.bskHome = value.bskHome
        }
      }
      if (value.args !== undefined) {
        if (!Array.isArray(value.args) || value.args.length === 0 || value.args.some((arg) => typeof arg !== 'string')) {
          issues.push({ message: 'args must be a non-empty array of strings' })
        } else {
          result.args = [...value.args]
        }
      }
      return issues.length > 0 ? { issues } : { value: result }
    },
  },
}

/** Resolve the bsk home directory, where daemon.json and the named pipe live. */
function resolveBskHome(config) {
  if (typeof config?.bskHome === 'string' && config.bskHome.length > 0) return config.bskHome
  const fromEnv = process.env.BSK_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.bsk')
}

/** Read and shape-check `daemon.json`; returns null when it is missing or unusable. */
function readDaemonInfo(home) {
  try {
    const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'))
    if (info !== null && typeof info === 'object' && typeof info.sock_path === 'string') return info
  } catch {
    /* missing, stale, or unreadable */
  }
  return null
}

/** Probe the daemon's IPC named pipe; true only when a connection is accepted. */
function probePipe(sockPath, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let socket
    let timer
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try { socket?.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    try {
      socket = connect(sockPath)
    } catch {
      resolve(false)
      return
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Whether a reachable daemon already serves the given bsk home. */
async function daemonAlreadyRunning(home) {
  const info = readDaemonInfo(home)
  if (info === null) return false
  return probePipe(info.sock_path)
}

/** Ask a running daemon to shut down through the CLI; true when it reported success. */
function requestDaemonStop(bskPath, home) {
  return new Promise((resolve) => {
    let child
    let timer
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    try {
      child = spawn(bskPath, ['daemon', 'stop', '--quiet'], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, BSK_HOME: home },
      })
    } catch {
      resolve(false)
      return
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish(false)
    }, STOP_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
}

/** Wait for a child to exit; false on timeout. */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    let timer
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exited)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    child.once('exit', () => finish(true))
  })
}

/** Logger that never breaks the plugin when the logger service is unavailable. */
function createLog(ctx) {
  let logger
  try {
    if (typeof ctx?.logger === 'function') logger = ctx.logger('bsk-daemon')
  } catch {
    logger = undefined
  }
  return (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') {
        logger[level](message)
        return
      }
    } catch {
      /* logging must never break the plugin */
    }
    if (level === 'error') {
      try { console.error(`[bsk-daemon] ${message}`) } catch { /* ignore */ }
    }
  }
}

/**
 * Plugin entry. Never rejects: a broken daemon must not prevent DSH from
 * booting, so failures are logged and the plugin simply stays inert.
 */
export async function apply(ctx, config) {
  const log = createLog(ctx)
  const home = resolveBskHome(config)
  const bskPath = typeof config?.bskPath === 'string' && config.bskPath.length > 0 ? config.bskPath : 'bsk'
  const args = Array.isArray(config?.args) && config.args.length > 0 ? config.args.map(String) : DEFAULT_ARGS

  let child = null
  let disposed = false
  let restarts = 0
  let restartTimer = null
  let startedAt = 0

  /** Stop the managed child, gracefully when it owns the daemon recorded in daemon.json. */
  const stopChild = async () => {
    const current = child
    child = null
    if (current === null) return
    const info = readDaemonInfo(home)
    if (info !== null && info.pid === current.pid && await requestDaemonStop(bskPath, home)) {
      if (await waitForExit(current, STOP_TIMEOUT_MS)) return
    }
    await new Promise((resolve) => {
      let timer
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        try { current.kill('SIGKILL') } catch { /* ignore */ }
        finish()
      }, STOP_TIMEOUT_MS)
      timer.unref?.()
      current.once('exit', finish)
      try { current.kill() } catch { finish() }
    })
  }

  const scheduleRestart = (reason) => {
    if (disposed || restartTimer !== null) return
    if (restarts >= MAX_RESTARTS) {
      log('error', `the bsk daemon keeps exiting (${reason}); giving up after ${MAX_RESTARTS} restart attempts`)
      return
    }
    restarts += 1
    log('warn', `the bsk daemon stopped (${reason}); restarting in ${RESTART_DELAY_MS}ms (attempt ${restarts}/${MAX_RESTARTS})`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!disposed) start()
    }, RESTART_DELAY_MS)
    restartTimer.unref?.()
  }

  function start() {
    if (disposed || child !== null) return
    try {
      const spawned = spawn(bskPath, args, {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, BSK_HOME: home },
      })
      child = spawned
      startedAt = Date.now()
      log('info', `started the managed daemon: ${bskPath} ${args.join(' ')} (BSK_HOME=${home})`)
      spawned.once('error', (error) => {
        log('error', `daemon process error: ${error instanceof Error ? error.message : String(error)}`)
        if (child === spawned) {
          child = null
          startedAt = 0
        }
        scheduleRestart('spawn error')
      })
      spawned.once('exit', (code, signal) => {
        const uptime = startedAt === 0 ? 0 : Date.now() - startedAt
        if (child === spawned) {
          child = null
          startedAt = 0
        }
        if (uptime >= STABLE_UPTIME_MS) restarts = 0
        if (disposed) return
        scheduleRestart(`code=${code ?? 'null'}, signal=${signal ?? 'null'}`)
      })
    } catch (error) {
      log('error', `could not spawn ${bskPath}: ${error instanceof Error ? error.message : String(error)}`)
      scheduleRestart('spawn failure')
    }
  }

  // Register cleanup before starting anything, so a failing effect registration
  // can never leave a supervised child without an owner.
  ctx.effect(() => {
    log('info', `supervising the bsk daemon (BSK_HOME=${home})`)
    return async () => {
      disposed = true
      if (restartTimer !== null) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      if (child !== null) log('info', 'stopping the managed bsk daemon with DSH')
      await stopChild()
    }
  }, 'bsk-daemon.lifecycle')

  try {
    const alreadyRunning = await daemonAlreadyRunning(home)
    if (disposed) return
    if (alreadyRunning) {
      log('info', 'an existing bsk daemon is already running; leaving it untouched (only a daemon this plugin started is managed)')
    } else {
      start()
    }
  } catch (error) {
    log('error', `daemon supervision failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
