import assert from 'node:assert/strict'
import test from 'node:test'
import { runVendorChild } from '../first-boot.mjs'

test('an awaited bounded install leaves the event loop free for a supervisor callback', async () => {
  let ticked = false
  const timer = setTimeout(() => { ticked = true }, 50)
  const result = await runVendorChild(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { timeout: 5000 })
  clearTimeout(timer)
  assert.equal(result.status, 0)
  assert.equal(result.error, null)
  assert.equal(ticked, true, 'the supervisor callback did not run while the install child was open')
  assert.ok(result.durationMs >= 250)
})

test('a bounded install is killed at its timeout and reports the signal', async () => {
  const started = Date.now()
  const result = await runVendorChild(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 100 })
  assert.equal(result.timedOut, true)
  assert.ok(result.signal, `no signal after timeout: ${JSON.stringify({ status: result.status, signal: result.signal })}`)
  assert.ok(Date.now() - started < 3000, `timeout took ${Date.now() - started} ms`)
})
