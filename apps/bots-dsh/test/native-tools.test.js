import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/native-tools.js'

function runtime({ registry = new Map(), a = {}, services = {}, session, sessions = {}, state } = {}) {
  // #1564 PR B: ON is bound to the agent a Bot runs on, so these Bots run on Claude.
  const bots = new Map([['a', { id: 'a', model: 'acp-claude/default', nativeTools: true, ...a }], ['b', { id: 'b', model: 'acp-claude/default', nativeTools: true }]])
  const live = { 'direct-a': session, ...sessions }
  const rt = {
    ctx: {
      registry,
      get: name => ({
        sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) },
        ...services,
      })[name],
      sessions: { get: id => live[id] },
    },
    chatOwners: new Map([['direct-a', 'a'], ['direct-b', 'b']]),
    groupOwners: new Map([['group-a', { botId: 'a' }]]),
    pastOwners: new Map([['old-a', { botId: 'a' }]]),
    taskOwners: new Map([['task-a', { botId: 'a' }]]),
    botOf: id => bots.get(id),
    chatOf: id => 'direct-' + id,
    isMain: id => id === 'a',
    warn: () => {},
    save: async () => {},
    ...(state === undefined ? {} : { state: { bots: Object.fromEntries(bots), ...state } }),
  }
  // store.js: own chat, group Session, task, earlier part.
  rt.selfOf = id => rt.chatOwners.get(id) ?? rt.groupOwners.get(id)?.botId ?? rt.taskOwners.get(id)?.botId
    ?? rt.pastOwners.get(id)?.botId
  install(rt)
  return rt
}

// The one-time upgrade already ran (RFC 0003, Amendment: native tools in every chat of the Bot).
const RETIRED = { state: { nativeToolsLocksRetired: true } }

// #1564 follow-up: the switch applies in every chat of the Bot.
test('every chat of the Bot takes the saved native tools switch', () => {
  const rt = runtime(RETIRED)
  for (const id of ['direct-a', 'group-a', 'old-a', 'task-a']) assert.equal(rt.nativeToolsFor(id), true, id)
  for (const id of ['subagent', 'fresh-schedule']) {
    assert.equal(rt.nativeToolsFor(id), false, id)
    assert.equal(rt.nativeToolsEligible(id), false, id)
  }
  delete rt.botOf('a').nativeTools
  for (const id of ['direct-a', 'group-a', 'old-a', 'task-a']) assert.equal(rt.nativeToolsFor(id), false, id)
})

// #1564 follow-up: `managed` stays a lock after the upgrade (Omni's plugin takes their tools).
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
    for (const rt of [runtime(options), runtime({ ...options, ...RETIRED })]) {
      assert.equal(rt.nativeToolsBlock(rt.botOf('a')), block)
      assert.equal(rt.nativeToolsFor('direct-a'), false)
    }
  }
  const rt = runtime()
  rt.omniLinked = () => true
  assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'managed')
  assert.equal(rt.nativeToolsBlock(rt.botOf('b')), undefined)
  const linked = runtime(RETIRED)
  linked.omniLinked = () => true
  assert.equal(linked.nativeToolsBlock(linked.botOf('a')), 'managed')
  assert.equal(linked.nativeToolsFor('group-a'), false)
  assert.equal(linked.nativeToolsBotOn('a'), false)
  assert.equal(linked.nativeToolsBotOn('b'), true)
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

// Pending window (no upgrade marker): the old `shared` lock and its code; after the upgrade, none.
test('LiveShare and shared people block both Bots only until the upgrade has run', () => {
  const fiber = { state: 2 }
  const registry = new Map([['sharing', { name: 'liveshare-share-host', fibers: [fiber] }]])
  for (const rt of [runtime({ registry }), runtime({ registry })]) {
    for (const [id, owner] of rt.chatOwners) {
      assert.equal(rt.nativeToolsBlock(rt.botOf(owner)), 'shared')
      assert.equal(rt.nativeToolsFor(id), false)
    }
  }
  const upgraded = runtime({ registry, ...RETIRED })
  for (const [id, owner] of upgraded.chatOwners) {
    assert.equal(upgraded.nativeToolsBlock(upgraded.botOf(owner)), undefined)
    assert.equal(upgraded.nativeToolsFor(id), true)
  }
  fiber.state = 1
  assert.equal(runtime({ registry }).nativeToolsFor('direct-a'), true)
  for (const unreadable of [null, { values() { throw new Error('unreadable') } }]) {
    const rt = runtime({ registry: unreadable })
    assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'shared')
    const retired = runtime({ registry: unreadable, ...RETIRED })
    assert.equal(retired.nativeToolsBlock(retired.botOf('a')), undefined)
  }
  for (const people of [null, { mode: 'owners', allow: ['visitor'] }, { mode: 'allowlist', allow: ['visitor'] }, { mode: 'owners' }]) {
    const rt = runtime({ a: { people } })
    assert.equal(rt.nativeToolsBlock(rt.botOf('a')), 'shared')
    assert.equal(rt.nativeToolsFor('direct-b'), true)
    const retired = runtime({ a: { people }, ...RETIRED })
    assert.equal(retired.nativeToolsBlock(retired.botOf('a')), undefined)
    assert.equal(retired.nativeToolsFor('group-a'), true)
  }
  assert.equal(runtime({ a: { people: { mode: 'owners', allow: [] } } }).nativeToolsFor('direct-a'), true)
})

function acpRecorder() {
  const ended = []
  return {
    ended,
    acpAgents: {
      endNative: (id) => { ended.push(['native', id]) },
      endOmpSession: (id) => { ended.push(['omp', id]) },
    },
  }
}

// E7-d: OFF ends the Bot's group and task Sessions too, for every agent.
for (const model of ['acp-claude/default', 'acp-codex/default', 'acp-omp/default']) {
  test(`OFF ends the native processes of the Bot's chat, group, task and past Sessions (${model})`, async () => {
    const { ended, acpAgents } = acpRecorder()
    const rt = runtime({ a: { model }, services: { acpAgents }, ...RETIRED })
    await rt.setNativeTools('a', { nativeTools: false })
    for (const id of ['direct-a', 'group-a', 'old-a', 'task-a']) {
      assert.ok(ended.some(([kind, sessionId]) => kind === 'native' && sessionId === id), id)
      assert.ok(ended.some(([kind, sessionId]) => kind === 'omp' && sessionId === id), id)
    }
    assert.equal(ended.some(([, sessionId]) => sessionId === 'direct-b'), false)
  })
}

// E3-a: a fresh scheduled Session of an ON Bot (schedules.js map) follows it, and OFF ends it.
test('a fresh scheduled Session of the Bot follows its switch, and OFF ends its process', async () => {
  const { ended, acpAgents } = acpRecorder()
  const rt = runtime({ services: { acpAgents }, ...RETIRED })
  rt.scheduledNativeOwner = id => id === 'fresh-a' ? 'a' : undefined
  rt.scheduledNativeSessions = botId => botId === 'a' ? ['fresh-a'] : []
  assert.equal(rt.nativeToolsFor('fresh-a'), true)
  assert.equal(rt.nativeToolsFor('fresh-other'), false)
  await rt.setNativeTools('a', { nativeTools: false })
  assert.deepEqual(ended.filter(([, id]) => id === 'fresh-a'), [['native', 'fresh-a'], ['omp', 'fresh-a']])
  assert.equal(rt.nativeToolsFor('fresh-a'), false)
})

// E7-f: each Session is checked at its own level; a level that cannot be read blocks it.
test('a group Session whose level cannot be read is blocked as level-unknown', () => {
  const group = {}
  const rt = runtime({
    sessions: { 'group-a': group },
    services: { sandboxPolicy: { defaultMode: 'workspace-write', resolve: ({ session }) => {
      if (session === group) throw new Error('unreadable')
      return { mode: 'workspace-write' }
    } } },
    ...RETIRED,
  })
  assert.equal(rt.nativeToolsFor('direct-a'), true)
  assert.equal(rt.nativeToolsEligible('group-a'), false)
  assert.equal(rt.nativeToolsFor('group-a'), false)
})

// E7-g: Read only in one Session keeps that Session OFF while the direct chat stays ON.
test('a group Session at Read only reads OFF while the direct chat is ON', () => {
  const group = {}
  const rt = runtime({
    session: {},
    sessions: { 'group-a': group },
    services: { sandboxPolicy: { defaultMode: 'workspace-write', resolve: ({ session }) => ({
      mode: session === group ? 'read-only' : 'workspace-write',
    }) } },
    ...RETIRED,
  })
  assert.equal(rt.nativeToolsFor('direct-a'), true)
  assert.equal(rt.nativeToolsFor('group-a'), false)
  assert.equal(rt.nativeToolsEligible('group-a'), false)
  assert.equal(rt.nativeToolsFor('task-a'), true)
})
