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
    ['genie', {
      name: 'Genie', role: 'Grants your wishes', instructions: 'Grant wishes.', kind: 'genie',
    }],
  ])
  const owners = new Map([
    ['private', 'ada'], ['group-member', 'ada'], ['task', 'ada'], ['other', 'someone'],
    ['archived-part', 'ada'],
    ['wish-chat', 'genie'], ['wish-task', 'genie'], ['wish-group', 'genie'],
  ])
  const taskOwners = new Map([['wish-task', { botId: 'genie' }]])
  const botSessions = new Set(['private', 'group-member', 'other', 'wish-chat', 'wish-group'])
  const isBotSession = id => botSessions.has(id) || taskOwners.has(id)
  install({ ctx, taskOwners, isBotSession, selfOf: id => owners.get(id), botOf: id => bots.get(id) })
  t.after(() => ctx.dispose())
  return { ctx, bots, read: id => reader?.(id), disposed: () => disposed }
}

test('identity reader returns only the owning Bot identity and a fresh copy', t => {
  const h = host(t, true)
  const identity = { name: 'Ada', role: 'Reviewer', instructions: 'Check files.' }
  const bridged = { ...identity, needsDshTools: true }
  for (const id of ['private', 'group-member']) assert.deepEqual(h.read(id), bridged)
  assert.deepEqual(h.read('task'), identity)
  assert.deepEqual(h.read('other'), {
    name: 'Someone', role: 'Writer', instructions: 'Write notes.', needsDshTools: true,
  })
  h.read('private').instructions = 'Changed copy.'
  assert.deepEqual(h.read('private'), bridged)
  h.bots.get('ada').instructions = 'Read the diff.'
  assert.equal(h.read('private').instructions, 'Read the diff.')
})

test('an archived part keeps its Bot identity without asking for DSH tools', t => {
  const h = host(t)
  assert.deepEqual(h.read('archived-part'), { name: 'Ada', role: 'Reviewer', instructions: 'Check files.' })
})

test('a Genie says its role tools live in DSH, and a wish task does not (#1639)', t => {
  const h = host(t)
  const genie = { name: 'Genie', role: 'Grants your wishes', instructions: 'Grant wishes.' }
  assert.deepEqual(h.read('wish-chat'), { ...genie, needsDshTools: true })
  assert.deepEqual(h.read('wish-group'), { ...genie, needsDshTools: true })
  // A task is a wish: it must not grant another, so it keeps its agent's own tools.
  assert.deepEqual(h.read('wish-task'), genie)
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
