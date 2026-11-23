import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/native-tools.js'

function runtime({ registry = new Map(), a = {}, services = {}, session } = {}) {
  const bots = new Map([['a', { id: 'a', nativeTools: true, ...a }], ['b', { id: 'b', nativeTools: true }]])
  const rt = {
    ctx: {
      registry,
      get: name => ({
        sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) },
        ...services,
      })[name],
      sessions: { get: id => id === 'direct-a' ? session : undefined },
    },
    chatOwners: new Map([['direct-a', 'a'], ['direct-b', 'b']]),
    groupOwners: new Map([['group-a', { botId: 'a' }]]),
    pastOwners: new Map([['old-a', { botId: 'a' }]]),
    taskOwners: new Map([['task-a', { botId: 'a' }]]),
    botOf: id => bots.get(id),
    chatOf: id => 'direct-' + id,
    isMain: id => id === 'a',
  }
  install(rt)
  return rt
}

test('only the current own chat can take the saved native tools switch', () => {
  const rt = runtime()
  assert.equal(rt.nativeToolsFor('direct-a'), true)
  for (const id of ['group-a', 'old-a', 'task-a', 'subagent', 'fresh-schedule']) {
    assert.equal(rt.nativeToolsFor(id), false, id)
  }
  delete rt.botOf('a').nativeTools
  assert.equal(rt.nativeToolsFor('direct-a'), false)
})

test('multiuser, managed, restricted and unknown or Read only levels block eligibility', t => {
  const cases = [
    [{ services: { automagikCaller: { version: 2, multiuser: true } } }, 'multiuser'],
    [{ a: { kind: 'omni' } }, 'managed'],
    [{ a: { shell: false } }, 'restricted'],
    [{ a: { denyTools: ['read'] } }, 'restricted'],
    [{ session: {}, services: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } } }, 'read-only'],
    [{ session: {}, services: { sandboxPolicy: { resolve() { throw new Error('unavailable') } } } }, 'level-unknown'],
    [{ a: { permission: 'inspect' }, services: { permissionPresets: { resolve: () => ({ sandbox: 'read-only' }) } } }, 'read-only'],
  ]
  for (const [options, block] of cases) {
    const rt = runtime(options)
    assert.equal(rt.nativeToolsBlock(rt.botOf('a')), block)
    assert.equal(rt.nativeToolsFor('direct-a'), false)
  }
  const rt = runtime()
  rt.omniLinked = () => true
  assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'managed')
  assert.equal(rt.nativeToolsBlock(rt.botOf('b')), undefined)
  t.mock.method(rt, 'omniLinked', () => false)
  t.mock.method(rt.ctx, 'get', () => undefined)
  assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'level-unknown')
})

test('the multiuser environment hides the switch before a caller service registers', () => {
  const before = process.env.AUTOMAGIK_MULTIUSER
  try {
    process.env.AUTOMAGIK_MULTIUSER = '1'
    const rt = runtime()
    assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'multiuser')
    assert.equal(rt.nativeToolsFor('direct-a'), false)
  } finally {
    if (before === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = before
  }
})

test('LiveShare blocks both Bots before any visitor writes and after Bot runtime restart', () => {
  const fiber = { state: 2 }
  const registry = new Map([['sharing', { name: 'liveshare-share-host', fibers: [fiber] }]])
  for (const rt of [runtime({ registry }), runtime({ registry })]) {
    for (const [id, owner] of rt.chatOwners) {
      assert.equal(rt.nativeToolsBlock(rt.botOf(owner)), 'shared')
      assert.equal(rt.nativeToolsFor(id), false)
    }
  }
  fiber.state = 1
  assert.equal(runtime({ registry }).nativeToolsFor('direct-a'), true)
  for (const unreadable of [null, { values() { throw new Error('unreadable') } }]) {
    const rt = runtime({ registry: unreadable })
    assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'shared')
  }
  for (const people of [null, { mode: 'owners', allow: ['visitor'] }, { mode: 'allowlist', allow: ['visitor'] }, { mode: 'owners' }]) {
    const rt = runtime({ a: { people } })
    assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'shared')
    assert.equal(rt.nativeToolsFor('direct-b'), true)
  }
  assert.equal(runtime({ a: { people: { mode: 'owners', allow: [] } } }).nativeToolsFor('direct-a'), true)
})
