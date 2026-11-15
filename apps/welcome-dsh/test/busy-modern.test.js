import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchBusy } from '../src/host/busy.js'
import { fakeContext } from './fake-ctx.js'

function setup({ flag = '2', getter = true, prepare = true } = {}) {
  let activity = { active: 1, confirming: 0 }
  const service = { loginActive: () => 1,
    ...(getter ? { loginActivity: () => {
      if (activity instanceof Error) throw activity
      return activity
    } } : {}), ...(prepare ? { prepareRestart() {} } : {}) }
  const { ctx } = fakeContext({ services: { acpAgents: service } })
  const writes = []
  watchBusy(ctx, { env: { AUTOMAGIK_BUSY_FILE: '/fake/busy', AUTOMAGIK_BUSY_PROTOCOL: flag },
    now: () => 9, write: (_file, text) => writes.push(JSON.parse(text)) })
  return { ctx, writes, set(value) { activity = value; ctx.emit('acp-dsh/login-activity', value) } }
}

test('modern capability splits waiting sign-ins from real agents and reloads/disposes correctly', () => {
  const h = setup()
  assert.deepEqual(h.writes.at(-1), { running: 0, logins: 1, confirming: 0, at: 9 })
  h.ctx.emit('agent/status', { agent: { id: 'a' }, status: 'running' })
  h.set({ active: 2, confirming: 0 })
  assert.deepEqual(h.writes.at(-1), { running: 1, logins: 2, confirming: 0, at: 9 })
  h.set({ active: 0, confirming: 0 })
  assert.deepEqual(h.writes.at(-1), { running: 1, logins: 0, confirming: 0, at: 9 })
  h.ctx.emit('agent/disposed', { agent: { id: 'a' } })
  assert.deepEqual(h.writes.at(-1), { running: 0, logins: 0, confirming: 0, at: 9 })
  assert.deepEqual(setup().writes[0], { running: 0, logins: 1, confirming: 0, at: 9 })
})

test('confirmation transitions and deadlines publish with an unchanged active count; duplicates do not', () => {
  const h = setup()
  h.set({ active: 1, confirming: 1, confirmingUntil: 90009 })
  assert.deepEqual(h.writes.at(-1), { running: 0, logins: 1, confirming: 1, confirmingUntil: 90009, at: 9 })
  const count = h.writes.length
  h.set({ active: 1, confirming: 1, confirmingUntil: 90009 })
  assert.equal(h.writes.length, count)
  h.set({ active: 1, confirming: 1, confirmingUntil: 80009 })
  assert.equal(h.writes.at(-1).confirmingUntil, 80009)
  h.set({ active: 0, confirming: 0 })
  assert.deepEqual(h.writes.at(-1), { running: 0, logins: 0, confirming: 0, at: 9 })
})

test('modern activity reads the getter, and legacy fallbacks listen only to the count channel', () => {
  const modern = setup()
  modern.ctx.emit('acp-dsh/login-active', { active: 9 })
  modern.ctx.emit('acp-dsh/login-activity', { active: 9, confirming: 9, confirmingUntil: 42 })
  assert.deepEqual(modern.writes, [{ running: 0, logins: 1, confirming: 0, at: 9 }])
  for (const options of [{ flag: '' }, { getter: false }, { prepare: false }]) {
    const legacy = setup(options)
    legacy.set({ active: 7, confirming: 1, confirmingUntil: 42 })
    assert.deepEqual(legacy.writes, [{ running: 1, at: 9 }])
    legacy.ctx.emit('acp-dsh/login-active', { active: 2 })
    assert.deepEqual(legacy.writes.at(-1), { running: 2, at: 9 })
  }
})

test('unknown flags, old ACP getter and absent preparation preserve the literal combined protocol', () => {
  for (const options of [{ flag: '1' }, { flag: '02' }, { flag: '' }, { getter: false }, { prepare: false }]) {
    const h = setup(options)
    assert.deepEqual(h.writes[0], { running: 1, at: 9 })
    h.ctx.emit('agent/status', { agent: { id: 'a' }, status: 'running' })
    assert.deepEqual(h.writes.at(-1), { running: 2, at: 9 })
  }
})

test('modern getter failure and malformed activity replace any idle reading with untrusted data', () => {
  for (const value of [new Error('unavailable'), null, {}, { active: '1', confirming: 0 },
    { active: 1, confirming: -1 }, { active: 1, confirming: 2 }, { active: 1, confirming: 1 },
    { active: 1, confirming: 1, confirmingUntil: '90009' }]) {
    const h = setup()
    h.set({ active: 0, confirming: 0 })
    h.set(value)
    assert.deepEqual(h.writes.at(-1), { untrusted: true, at: 9 })
  }
})
