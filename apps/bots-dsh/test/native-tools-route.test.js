import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { createRuntime } from '../index.js'
import { install as installIm } from '../src/host/im/index.js'
import { adapters } from '../src/host/im/platforms/index.js'
import { CODEX, nativeWorld, person } from '../../acp-dsh/test/fixtures/managed-native-world.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

const offText = 'Native tools were turned off for this Bot, so this answer stopped. Send your message again.'
const team = {
  version: 2, revision: 0, mainBotIds: ['a'],
  bots: {
    a: { id: 'a', sessionId: 'ada', name: 'Ada', model: 'acp-claude/default', createdAt: 1, segments: [{ sessionId: 'old-a' }, { sessionId: 'starting-a' }] },
    b: { id: 'b', sessionId: 'ben', name: 'Ben', model: 'acp-claude/default', createdAt: 2 },
  },
  rooms: { group: { id: 'group', name: 'Group', named: true, members: ['a', 'b'], admin: 'a', sessions: { a: 'ada-group' }, log: [], createdAt: 3 } },
}

async function host(t, { saved = false, hidden, services = {}, im = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bot-native-route-'))
  const path = join(home, 'state.json')
  const record = structuredClone(team)
  if (saved) for (const bot of Object.values(record.bots)) bot.nativeTools = true
  if (im) record.im = { connections: { im_fake: {
    id: 'im_fake', platform: 'telegram', botId: 'a', paired: [{ id: 'sender', name: 'Sender' }],
    chats: { 'dm-sender': { key: 'dm-sender', kind: 'direct' } },
  } } }
  writeFileSync(path, JSON.stringify(record))
  let readIdentity
  const w = nativeWorld(t, { hidden, identity: (...args) => readIdentity?.(...args) })
  const active = new Map()
  const acpAgents = {
    botIdentity(reader) { readIdentity = reader; return () => { readIdentity = undefined } },
    endSession: (...args) => w.adapter.endSession(...args),
    endClaudeSession: (id, why) => w.adapter.endClaudeSession(id, why),
  }
  const sessionPersistence = {
    open: async () => { throw Object.assign(new Error('No stored Session'), { name: 'SessionPersistenceNotFoundError' }) },
  }
  const ctx = fakeContext({ services: { ...w.services, sessionPersistence, ...services, acpAgents } })
  ctx.registry = new Map()
  ctx.sessions = { get: id => active.get(id), list: () => [...active.values()] }
  ctx.sessionController = { resolveAgent: async id => ({ agent: { session: active.get(id) } }) }
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  const rt = createRuntime(ctx, { home })
  ctx.provide('omniTeam', rt)
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  await rt.load()
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const chat = (id = 'ada') => {
    const chat = w.chat(id)
    active.set(id, chat.session)
    return chat
  }
  return { w, rt, ctx, call, chat, active, identity: id => readIdentity(id), stored: () => JSON.parse(readFileSync(path, 'utf8')) }
}

test('owner can save ON and OFF deletes the durable field', async t => {
  const h = await host(t)
  const on = await h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.equal(on.value.nativeTools, true)
  assert.equal(h.stored().bots.a.nativeTools, true)
  const off = await h.call('update-bot', { id: 'a', nativeTools: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(Object.hasOwn(h.stored().bots.a, 'nativeTools'), false)
})

test('owner route rejects non-booleans and mixed patches before saving or choosing a model', async t => {
  const h = await host(t)
  const save = t.mock.method(h.rt, 'save')
  const pickHostModel = t.mock.method(h.rt, 'pickHostModel')
  const bot = h.rt.botOf('a')
  const before = structuredClone(bot)
  await assert.rejects(h.rt.updateBot('a', { nativeTools: true }, 'b'), /Only the user can turn native tools/)
  const invalid = await h.call('update-bot', { id: 'a', nativeTools: 'yes' })
  assert.equal(invalid.error.code, 'bot/invalid')
  for (const extra of [{ model: 'other/model' }, { people: { mode: 'owners', allow: [] } }]) {
    const mixed = await h.call('update-bot', { id: 'a', nativeTools: true, ...extra })
    assert.equal(mixed.ok, false)
    assert.match(mixed.error.message, /Change native tools on their own/)
  }
  assert.equal(save.mock.callCount(), 0)
  assert.equal(pickHostModel.mock.callCount(), 0)
  assert.deepEqual(bot, before)
})

test('Bot-callable update_bot cannot write the new field on the team or MCP tools', async t => {
  const h = await host(t)
  const internal = h.rt.teamTools.find(tool => tool.name === 'update_bot')
  assert.match(await internal.execute({ nativeTools: true }, { agent: { id: 'ada' } }), /Updated Ada/)
  const { value, ok } = await h.call('agent-token-create', { name: 'Native tool fixture' })
  assert.equal(ok, true)
  const response = await h.rt.agentAccess.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${value.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_bot', arguments: { id: 'a', nativeTools: true } } }),
  }))
  const result = await response.json()
  assert.deepEqual(result.error, { code: -32602, message: 'Invalid tool arguments' })
  assert.equal(h.rt.botOf('a').nativeTools, undefined)
  assert.equal(h.stored().bots.a.nativeTools, undefined)
})

test('identity keeps the Bot profile keys, and offers native tools for the current own chat only', async t => {
  const h = await host(t, { saved: true })
  const identity = h.identity('ada')
  assert.deepEqual(Object.keys(identity), ['name', 'role', 'instructions', 'needsDshTools'])
  assert.equal(identity.name, 'Ada')
  assert.equal(identity.nativeTools, true)
  for (const id of ['ada-group', 'old-a', 'starting-a']) {
    assert.equal(h.identity(id).name, 'Ada')
    assert.equal(h.identity(id).nativeTools, false)
  }
  assert.equal(h.identity('unowned'), undefined)
})

test('a pending then rejected owner ON save cannot start a native process', async t => {
  const h = await host(t)
  const entered = Promise.withResolvers()
  const save = Promise.withResolvers()
  const normalSave = h.rt.save
  h.rt.save = options => {
    if (options?.required) {
      entered.resolve('started')
      return save.promise
    }
    return Promise.resolve()
  }
  const response = h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(await Promise.race([entered.promise, response]), 'started')
  try {
    await normalSave({ required: true })
    await h.chat().turn('while the save is pending')
    h.w.assertToolset(0, false)
    assert.equal(h.stored().bots.a.nativeTools, undefined)
  } finally {
    save.reject(new Error('test: store rejected ON'))
  }
  assert.equal((await response).ok, false)
  assert.equal(h.rt.botOf('a').nativeTools, undefined)
  assert.deepEqual(h.w.events('new-session').map(row => row.meta.disableBuiltInTools), [true])
})

test('owner cannot enable native tools for shared, restricted or multiuser Bots', async t => {
  const h = await host(t)
  const bot = h.rt.botOf('a')
  for (const [fields, reason] of [
    [{ people: { mode: 'allowlist', allow: ['visitor'] } }, /shared with other people/],
    [{ shell: false }, /shell access off or denied tools/],
  ]) {
    Object.assign(bot, fields)
    const result = await h.call('update-bot', { id: 'a', nativeTools: true })
    assert.equal(result.ok, false)
    assert.match(result.error.message, reason)
    for (const key of Object.keys(fields)) delete bot[key]
  }
  const before = process.env.AUTOMAGIK_MULTIUSER
  try {
    process.env.AUTOMAGIK_MULTIUSER = '1'
    const result = await h.call('update-bot', { id: 'a', nativeTools: true })
    assert.equal(result.ok, false)
  } finally {
    if (before === undefined) delete process.env.AUTOMAGIK_MULTIUSER
    else process.env.AUTOMAGIK_MULTIUSER = before
  }
  assert.equal(h.stored().bots.a.nativeTools, undefined)
})

test('first owner turn in a fresh direct chat gets native tools from saved ON', async t => {
  const h = await host(t, { saved: true })
  assert.equal(h.rt.chatOwners.get('ada'), 'a')
  let reads = 0
  Object.defineProperty(h.rt.botOf('a'), 'nativeTools', { get() { reads++; return true } })
  const chat = h.chat()
  await chat.turn(person('native-read'))
  h.w.assertToolset(0, true)
  assert.equal(h.w.events('native-tool-ran')[0].name, 'Read')
  assert.deepEqual(h.w.executed, [])
  await chat.turn('second owner turn')
  assert.equal(h.w.events('new-session').length, 1)
  assert.equal(reads, 1)
})

test('a real DSH scheduled delivery to the indexed current chat gets OFF', async t => {
  const h = await host(t, { saved: true, hidden: true })
  const chat = h.chat()
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const tasks = new Map()
  const delivered = Promise.withResolvers()
  let turn
  ctx.provide('storageDomain', { open: async () => ({
    close: async () => {},
    table: () => ({
      entries: () => [...tasks.entries()], get: id => tasks.get(id),
      put: async (id, value) => { tasks.set(id, value) },
    }),
  }) })
  ctx.provide('agents', { get: () => undefined, withoutInitiator: fn => fn() })
  ctx.provide('sessionPersistence', { stat: async () => ({ header: {} }) })
  ctx.provide('sessions', { flush: async () => true })
  ctx.provide('sessionController', { resolveAgent: async id => {
    assert.equal(id, h.rt.chatOf('a'))
    return { agent: { session: chat.session, followup(message) {
      turn = chat.turn(message)
      delivered.resolve(message)
    }, whenIdle: () => turn } }
  } })
  const schedule = new ScheduleService(ctx, {})
  await schedule.ready
  const task = await schedule.create({
    title: 'Reminder', prompt: 'bridge read now',
    timing: { kind: 'at', at: new Date(Date.now() + 86_400_000).toISOString() },
    target: { kind: 'session', sessionId: h.rt.chatOf('a') },
  })
  const run = await schedule.run({ id: task.id })
  assert.equal(run.lastDelivery.targetSessionId, 'ada')
  assert.equal((await delivered.promise).source.kind, 'schedule')
  await turn
  h.w.assertToolset(0, false)
  assert.deepEqual(h.w.executed, ['read'])
})

test('an IM-bound direct chat stays OFF on the carried IM profile', async t => {
  const h = await host(t, { saved: true, hidden: true, im: true })
  const chat = h.chat()
  const connected = Promise.withResolvers()
  const original = adapters.telegram
  adapters.telegram = { connect(_fields, _env, handlers) {
    connected.resolve(handlers)
    return { send: async () => {}, stop: () => {} }
  } }
  t.after(() => { adapters.telegram = original })
  let turn
  let source
  h.ctx.sessionController ??= {}
  h.ctx.sessionController.prompt = async ({ sessionId, content, requestId }) => {
    assert.equal(sessionId, 'ada')
    source = { kind: 'user', rpcId: requestId }
    turn = chat.turn(createUserMessage({ content, source }))
    return { ok: true }
  }
  installIm(h.rt)
  await h.rt.save({ required: true })
  const handlers = await connected.promise
  await handlers.onMessage({ chat: { key: 'dm-sender', kind: 'direct' }, sender: { id: 'sender', name: 'Sender' }, text: 'bridge read' })
  assert.match(source.rpcId, /^im:telegram:/)
  await turn
  h.w.assertToolset(0, false)
  assert.deepEqual(h.w.executed, ['read'])
})

test('OFF stops A’s live, starting and group Claude only, leaving other live processes intact', async t => {
  const h = await host(t, { saved: true })
  const ada = h.chat()
  const group = h.chat('ada-group')
  const starting = h.chat('starting-a')
  const codex = h.chat('old-a')
  const ben = h.chat('ben')
  await ada.turn('first')
  await group.turn('for the group')
  await codex.turn('Codex control', CODEX)
  await ben.turn('Claude control')
  const codexRun = h.w.adapter.live.get('old-a').run
  const benRun = h.w.adapter.live.get('ben').run
  const stopped = ['ada', 'ada-group'].map(id => h.w.adapter.live.get(id))
  const live = ada.turn(person('hang for Ada'))
  const member = group.turn(person('hang for the group'))
  await until(() => ['hang for Ada', 'hang for the group'].every(text => h.w.events('prompt').some(row => row.text === text)))
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.w.adapter.access = async () => { entered.resolve(); await release.promise }
  const start = starting.turn('still starting')
  await entered.promise
  let off
  try { off = await h.call('update-bot', { id: 'a', nativeTools: false }) }
  finally { release.resolve() }
  assert.equal(off.ok, true, JSON.stringify(off))
  for (const id of ['ada', 'ada-group', 'starting-a']) assert.equal(h.w.adapter.live.has(id), false, id)
  for (const { run, bridge } of stopped) {
    assert.equal(bridge.closed, true)
    await run.gone.catch(() => {})
    assert.equal(run.alive, false)
  }
  for (const answer of [live, member, start]) {
    const chunks = await answer
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(chunks.findLast(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')?.block.text, offText)
  }
  const launches = h.w.events('new-session').length
  await codex.turn('Codex again', CODEX)
  await ben.turn('Claude again')
  assert.equal(h.w.adapter.live.get('old-a').run, codexRun)
  assert.equal(h.w.adapter.live.get('ben').run, benRun)
  assert.equal(h.w.events('new-session').length, launches)
})

test('saved Read only override refuses ON while the chat is unloaded, and shows why when reopened', async t => {
  const h = await host(t, { services: {
    sessionPersistence: {
      open: async (id, access) => {
        assert.equal(id, 'ada')
        assert.equal(access, 'read')
        return { read: async () => ({ events: [{ type: 'sandbox/mode', data: { mode: 'read-only' } }] }), close: async () => {} }
      },
    },
  } })
  assert.equal(h.active.has('ada'), false)
  const result = await h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.message, 'Not available at the Read only level.')
  assert.equal(h.stored().bots.a.nativeTools, undefined)
  const { session } = h.chat()
  const before = await h.call('models', {})
  const revision = h.rt.state.revision
  session.append('sandbox/mode', { mode: 'read-only' })
  const after = await h.call('models', {})
  assert.equal(h.rt.state.revision, revision)
  assert.notEqual(after.value.modelsKey, before.value.modelsKey)
  const view = await h.call('state', { requestId: randomUUID() })
  assert.equal(view.value.bots.find(bot => bot.id === 'a').nativeToolsBlock, 'read-only')
})

test('a rejected OFF save stops Claude before the save and restores the previous field', async t => {
  const h = await host(t, { saved: true })
  await h.chat().turn('before turning OFF')
  const save = t.mock.method(h.rt, 'save', async () => {
    const stopped = !h.w.adapter.live.has('ada')
    const off = h.rt.botOf('a').nativeTools === undefined
    assert.equal(stopped && off, true)
    throw new Error('OFF save was rejected')
  })
  const result = await h.call('update-bot', { id: 'a', nativeTools: false })
  assert.equal(result.ok, false)
  await assert.rejects(save.mock.calls[0].result, { message: 'OFF save was rejected' })
  assert.equal(h.rt.botOf('a').nativeTools, true)
  assert.equal(h.stored().bots.a.nativeTools, true)
})

for (const [label, patch] of [
  ['shell', { shell: false }],
  ['deny list', { denyTools: ['read'] }],
  ['permission', { permission: 'read-only' }],
]) {
  test(`saving a ${label} restriction with native mode ON retires Claude`, async t => {
    const permissionPresets = {
      current: session => session.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write',
      resolve: sandbox => ({ sandbox, approval: 'ask' }),
      set: (session, mode) => session.append('sandbox/mode', { mode }),
      catalog: () => ({ options: [{ value: 'read-only' }, { value: 'workspace-write' }], defaultPreset: 'workspace-write' }),
    }
    const h = await host(t, { saved: true, services: { permissionPresets } })
    h.ctx.tools.schemas = () => [{ name: 'read' }]
    const chat = h.chat()
    h.chat('ada-group')
    await chat.turn('before restricting')
    h.w.assertToolset(0, true)
    if (label === 'shell') {
      // The existing shell guard refuses a Bot whose selected route can run commands.
      const refused = await h.call('update-bot', { id: 'a', ...patch })
      assert.match(refused.error.message, /its shell cannot be turned off/)
      assert.equal(h.w.adapter.live.has('ada'), true)
      // Exercise an allowed shell change with a remaining Claude process for this Bot.
      h.rt.botOf('a').model = 'deepseek-official/chat'
    }
    const result = await h.call('update-bot', { id: 'a', ...patch })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(h.rt.botOf('a').nativeTools, true)
    assert.equal(h.w.adapter.live.has('ada'), false)
    await chat.turn('after restricting')
    h.w.assertToolset(1, false)
  })
}
