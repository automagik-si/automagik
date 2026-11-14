import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function host(t, injected = false) {
  let reader
  let disposed = 0
  const service = {
    botIdentity(read) {
      reader = read
      return () => { reader = undefined; disposed++ }
    },
  }
  const ctx = fakeContext({ services: { acpAgents: service } })
  if (injected) ctx.inject = (names, attach) => {
    assert.deepEqual(names, ['acpAgents'])
    attach({ acpAgents: service, effect: ctx.effect })
  }
  const bots = new Map([
    ['ada', { name: 'Ada', role: 'Reviewer', instructions: 'Check files.', main: true }],
    ['someone', { name: 'Someone', role: 'Writer', instructions: 'Write notes.' }],
  ])
  const owners = new Map([
    ['private', 'ada'], ['group-member', 'ada'], ['task', 'ada'], ['other', 'someone'],
  ])
  install({ ctx, selfOf: id => owners.get(id), botOf: id => bots.get(id) })
  t.after(() => ctx.dispose())
  return { ctx, bots, read: id => reader?.(id), disposed: () => disposed }
}

test('identity reader returns only the owning Bot identity and a fresh copy', t => {
  const h = host(t, true)
  const identity = { name: 'Ada', role: 'Reviewer', instructions: 'Check files.' }
  for (const id of ['private', 'group-member', 'task']) assert.deepEqual(h.read(id), identity)
  assert.deepEqual(h.read('other'), {
    name: 'Someone', role: 'Writer', instructions: 'Write notes.',
  })
  h.read('private').instructions = 'Changed copy.'
  assert.deepEqual(h.read('private'), identity)
  h.bots.get('ada').instructions = 'Read the diff.'
  assert.equal(h.read('private').instructions, 'Read the diff.')
})

test('unowned sessions receive no identity', t => {
  const h = host(t)
  for (const id of ['relay', 'unowned', undefined]) assert.equal(h.read(id), undefined)
})

test('registration is disposed on unload for injected and direct services', async t => {
  for (const injected of [false, true]) {
    const h = host(t, injected)
    assert.ok(h.read('private'))
    await h.ctx.dispose()
    assert.equal(h.disposed(), 1)
    assert.equal(h.read('private'), undefined)
  }
})
