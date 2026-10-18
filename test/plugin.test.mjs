import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Config, apply, inject, name } from '../index.js'

const validate = (value) => Config['~standard'].validate(value)

test('exports a DSH host plugin', () => {
  assert.equal(name, 'bsk-daemon')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
})

test('config accepts the documented shape unchanged', () => {
  const config = {
    bskPath: 'C:\\tools\\bsk.exe',
    bskHome: 'C:\\Users\\me\\.bsk',
    args: ['daemon', 'start', '--foreground'],
  }
  const result = validate(config)
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, config)
})

test('config defaults to an empty object', () => {
  assert.deepEqual(validate(undefined), { value: {} })
  assert.deepEqual(validate(null), { value: {} })
})

test('config rejects unknown keys, empty paths and malformed args', () => {
  for (const input of [
    { bsHome: 'typo' },
    { bskPath: '' },
    { bskHome: 42 },
    { args: [] },
    { args: ['daemon', 7] },
    { args: 'daemon start' },
    'not-an-object',
    [],
  ]) {
    const result = validate(input)
    assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `expected issues for ${JSON.stringify(input)}`)
  }
})

test('registers the lifecycle effect before probing, and disposes cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bsk-daemon-'))
  const logs = []
  const effects = []
  const ctx = {
    logger: (loggerName) => {
      assert.equal(loggerName, 'bsk-daemon')
      const push = (level) => (message) => logs.push([level, message])
      return { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
    },
    effect: (execute, label) => {
      effects.push({ label, disposer: execute() })
    },
  }

  await apply(ctx, { bskPath: join(home, 'missing-bsk.exe'), bskHome: home, args: ['daemon', 'start'] })

  assert.equal(effects.length, 1, 'exactly one lifecycle effect is registered')
  assert.equal(effects[0].label, 'bsk-daemon.lifecycle')
  assert.equal(typeof effects[0].disposer, 'function')

  // A spawn error surfaces asynchronously; the plugin logs it and schedules a retry.
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.ok(logs.some(([, message]) => message.includes('supervising the bsk daemon')))
  assert.ok(logs.some(([level, message]) => level === 'error' && message.includes('daemon process error')))
  assert.ok(logs.some(([level]) => level === 'warn'), 'a restart should be scheduled')

  // The disposer must return an awaitable cleanup, finish promptly, and stop all retries.
  const cleanup = effects[0].disposer()
  assert.ok(cleanup && typeof cleanup.then === 'function')
  await cleanup

  const warnings = logs.filter(([level]) => level === 'warn').length
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(logs.filter(([level]) => level === 'warn').length, warnings, 'no restart may run after dispose')
})
