import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/extend.js'

test('legacy providers retain one ordered call for each Main or Omni Bot', () => {
  const bots = new Map([['main', {}], ['omni', { kind: 'omni' }], ['both', { kind: 'omni' }], ['worker', {}]])
  const rt = { botOf: id => bots.get(id), isMain: id => id === 'main' || id === 'both' }
  const calls = []
  install(rt)
  const offCanvas = rt.hooks.mainRules((...args) => { calls.push(args); return 'canvas' }, { order: 200 })
  rt.hooks.mainRules((...args) => { calls.push(args); return 'operator' }, { order: 100 })
  rt.hooks.rules({}, (id, session) => `${id}/${session}`, { order: 150 })

  for (const id of ['main', 'omni', 'both']) {
    assert.deepEqual(rt.extended.rules(id), ['operator', 'canvas'])
    assert.deepEqual(calls.splice(0), [[id], [id]])
    assert.deepEqual(rt.extended.rulesFor(id, 'session'), ['operator', `${id}/session`, 'canvas'])
    assert.deepEqual(calls.splice(0), [[id], [id]])
  }
  assert.deepEqual(rt.extended.rulesFor('worker', 'session'), ['worker/session'])
  assert.deepEqual(rt.extended.rulesFor('deleted', 'session'), [])
  assert.deepEqual(calls, [])
  offCanvas()
  offCanvas()
  assert.deepEqual(rt.extended.rules('main'), ['operator'])
  assert.deepEqual(rt.extended.rulesFor('omni', 'session'), ['operator', 'omni/session'])
})

test('early rules use live chief and role readers, including both selectors on one entry', () => {
  const rt = { botOf: id => ({ id, role: 'omni' }), isMain: id => id === 'old-main' }
  install(rt)
  rt.hooks.rules({ position: 'chief' }, () => 'chief', { order: -1 })
  rt.hooks.rules({ role: 'omni' }, (_id, session) => `role/${session}`)
  rt.hooks.rules({ position: 'chief', role: 'omni' }, () => 'both')
  assert.deepEqual(rt.extended.rulesFor('old-main', 's1'), [])

  let chief = 'first'
  const roles = new Set(['first', 'second'])
  rt.isChief = id => id === chief
  rt.hasRole = (id, role) => role === 'omni' && roles.has(id)
  assert.deepEqual(rt.extended.rulesFor('first', 's1'), ['chief', 'role/s1', 'both'])
  assert.deepEqual(rt.extended.rulesFor('second', 's2'), ['role/s2'])
  assert.deepEqual(rt.extended.rulesFor('old-main', 's1'), [])

  chief = 'second'
  roles.delete('second')
  const offLate = rt.hooks.rules({ position: 'chief' }, () => 'late', { order: -1 })
  assert.deepEqual(rt.extended.rulesFor('second', 's2'), ['chief', 'late'])
  offLate()
  assert.deepEqual(rt.extended.rulesFor('second', 's2'), ['chief'])
})

test('bad scopes are refused and an empty or throwing rule leaves other parts intact', () => {
  const warned = []
  const rt = { botOf: () => ({}), warn: (...args) => warned.push(args) }
  install(rt)
  assert.throws(() => rt.hooks.rules({ roles: 'omni' }, () => 'wrong'), /unknown rule selector/)
  assert.throws(() => rt.hooks.rules({ position: 'main' }, () => 'wrong'), /unknown rule position/)
  assert.throws(() => rt.hooks.rules({ role: '' }, () => 'wrong'), /role needs an id/)
  rt.hooks.rules({}, () => 'first')
  rt.hooks.rules({}, () => { throw new Error('provider failed') })
  rt.hooks.rules({}, () => '')
  rt.hooks.rules({}, () => null)
  rt.hooks.rules({}, () => 'last')
  assert.deepEqual(rt.extended.rulesFor('bot'), ['first', 'last'])
  assert.deepEqual(warned, [['ds-bot: a Bot rule failed: %s', 'provider failed']])
})
