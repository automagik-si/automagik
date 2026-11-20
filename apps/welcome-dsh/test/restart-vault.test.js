import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { equalPrivate, fakeVault } from '../../vault-dsh/test/fixtures/harness.mjs'
import { watchRestart } from '../src/host/restart.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, secretSources, agents) {
  const proc = new EventEmitter(), replies = []
  proc.send = message => replies.push(message)
  const ctx = { get: name => name === 'secretSources' ? secretSources : name === 'agents' ? agents : undefined,
    effect: setup => t.after(setup()) }
  watchRestart(ctx, { proc })
  const send = id => proc.emit('message', { type: 'automagik:prepare-restart', id, protocol: 1, reason: 'quit' })
  return { replies, send }
}

test('quit waits for the vault to finish locking and shares the drain', async t => {
  let calls = 0, unlocked = true, complete
  const h = fixture(t, { prepareQuit() {
    calls += 1
    unlocked = false
    return new Promise(resolve => { complete = resolve })
  } })
  h.send('one')
  h.send('two')
  assert.equal(unlocked, false)
  await tick()
  assert.equal(h.replies.length, 0)
  complete({ ok: true })
  await tick()
  assert.equal(calls, 1)
  assert.deepEqual(h.replies.map(row => row.result), [
    { agents: 0, acp: 'absent', vault: 'done' },
    { agents: 0, acp: 'absent', vault: 'done' },
  ])
})

test('quit reports absent, partial and timeout vault outcomes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixtures = [
    [undefined, undefined],
    [{ prepareQuit: () => { throw new Error('fixture') } }, 'partial'],
    [{ prepareQuit: () => ({ ok: false }) }, 'partial'],
    [{ prepareQuit: () => new Promise(() => {}) }, 'timeout'],
  ].map(([service, expected]) => [fixture(t, service), expected])
  for (const [h] of fixtures) h.send('one')
  await tick()
  assert.equal(fixtures.at(-1)[0].replies.length, 0)
  t.mock.timers.tick(5000)
  await tick()
  for (const [h, expected] of fixtures) assert.equal(h.replies[0].result.vault, expected)
})

test('the pre-quit acknowledgement follows completion of the fake Bitwarden lock', async t => {
  const vault = fakeVault(t, { pause: 'lock' })
  equalPrivate(await vault.unlock(), { ok: true })
  const h = fixture(t, vault.service, { list: () => { throw new Error('fixture') } })
  h.send('one')
  equalPrivate(await vault.service.read(vault.ref), { ok: false, code: 'locked' })
  await vault.waitFor('lock')
  assert.deepEqual(h.replies, [])
  vault.release()
  for (let i = 0; i < 100 && h.replies.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(h.replies[0].result.vault, 'done')
})
