import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { createRuntime } from '../index.js'
import { HANDOFF_ACK } from '../src/host/constants.js'
import { install as installIm } from '../src/host/im/index.js'
import { adapters } from '../src/host/im/platforms/index.js'
import { CLAUDE, CODEX, holdNativeStartup, nativeWorld, person } from '../../acp-dsh/test/fixtures/managed-native-world.js'
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
    endClaudeSession: (...args) => w.adapter.endClaudeSession(...args),
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
  // #1564 PR B (B2-1 (2)): the identity's agent tag reads the saved ON as well, once per read.
  assert.equal(reads, 4)
})

async function botFresh(t, h) {
  const prior = h.chat('ben')
  prior.session.append('request/header', { header: { config: { provider: CLAUDE, model: 'default' } }, reason: 'initial' })
  const workspace = { id: 'test-workspace', path: prior.session.header.cwd }
  let startup
  let fresh
  const agent = chat => ({
    id: chat.session.id, session: chat.session, status: 'idle',
    ctx: { tools: { register: () => () => {} } },
    whenIdle: async () => {},
    runMaintenance: job => job(new AbortController().signal),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => { startup = message },
  })
  const agents = new Map([['ben', agent(prior)]])
  Object.assign(h.ctx.sessionController, {
    resolveAgent: async id => ({ agent: agents.get(id) }),
    create: async () => {
      fresh = h.chat('fresh-ben')
      agents.set(fresh.session.id, agent(fresh))
      return { sessionId: fresh.session.id }
    },
    selectModel: async ({ sessionId, provider, model }) => {
      h.active.get(sessionId).append('model/selection', { provider, model })
      return { ok: true }
    },
  })
  h.ctx.workspaceRegistry = { get: () => workspace, resolveByPath: async () => workspace, archiveSession: async () => {} }
  h.ctx.sessions.flush = async () => {}
  h.ctx.sessionTitle = { rename: async () => {} }
  t.mock.method(h.rt, 'warn', (...args) => t.diagnostic(args.join(' ')))

  const moved = await h.call('bot-fresh', { id: 'b' })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  await until(() => ![...h.rt.switchJobs()].some(job => job.botId === 'b'))
  assert.ok(startup, 'the Bot route delivered the startup relay')
  return { prior, fresh, startup }
}

const startupContext = () => [
  ['runtime-context', 'snapshot', 'Runtime context for a plain ACP reply.'],
  ['skill-catalog', 'catalog', 'Available skills.'],
  ['time-context', 'snapshot', 'Current time.'],
].map(([kind, form, text]) => createUserMessage({ content: [{ type: 'text', text }], source: { kind, form } }))

test('New conversation replaces the startup Claude on the first owner turn with saved ON', async t => {
  const h = await host(t)
  const saved = await h.call('update-bot', { id: 'b', nativeTools: true })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(h.stored().bots.b.nativeTools, true)

  const { prior, fresh, startup } = await botFresh(t, h)
  const sessionId = fresh.session.id
  assert.equal(h.rt.chatOf('b'), sessionId)
  assert.notEqual(sessionId, prior.session.id)
  const { exchangeId, ...source } = startup.source
  assert.equal(typeof exchangeId, 'string')
  assert.deepEqual(source, { kind: 'bot', form: 'relay', role: 'handoff', senderName: 'Omni', handoff: true })
  assert.match(startup.content[0].text, /^\[Handoff · part 2\]\nThe user started a fresh conversation.*This message is not from the user/m)

  // The app trace records these generated rows on the startup step only (seq 11–13).
  // The recording agent uses the plain marker to finish this setup turn without a tool.
  const generated = startupContext()
  const startupAnswer = await fresh.turn(startup, CLAUDE, generated)
  assert.deepEqual(startupAnswer.at(-1).reason, { kind: 'stop' })
  h.w.assertToolset(0, false)
  const off = h.w.adapter.live.get(sessionId).run
  assert.equal(off.alive, true)

  const owner = 'Teste automático (1564-A): plain owner direct Electron'
  const ownerAnswer = await fresh.turn(person(owner))
  assert.deepEqual(ownerAnswer.at(-1).reason, { kind: 'stop' })
  const launches = h.w.events('new-session')
  const prompts = h.w.events('prompt')
  assert.equal(h.rt.chatOf('b'), sessionId)
  assert.equal(prompts.length, 2)
  assert.match(prompts[0].text, /\[Handoff · part 2\]/)
  assert.ok(prompts[1].text.includes(owner))
  t.diagnostic(JSON.stringify({
    sessionId,
    newSessions: launches.map(({ pid, meta }) => ({ pid, disableBuiltInTools: meta.disableBuiltInTools })),
    prompts: prompts.map(({ pid }, index) => ({ pid, input: index === 0 ? 'handoff' : 'owner' })),
  }))
  assert.deepEqual(launches.map(row => row.meta.disableBuiltInTools), [true, false],
    'the handoff opens OFF and the first owner turn opens ON')
  const [offPid, onPid] = launches.map(row => row.pid)
  assert.notEqual(offPid, onPid)
  assert.deepEqual(prompts.map(row => row.pid), [offPid, onPid])
  await off.gone.catch(() => {})
  assert.equal(off.alive, false)
  assert.match(prompts[1].text, /The chat so far, before this new/)
  assert.match(prompts[1].text, /Handoff \(not from the user\)/)
  h.w.assertToolset(1, true)
  const on = h.w.adapter.live.get(sessionId).run
  const persisted = h.rt.botOf('b').nativeTools
  let reads = 0
  Object.defineProperty(h.rt.botOf('b'), 'nativeTools', { get() { reads++; return persisted } })
  await fresh.turn('another owner message')
  assert.equal(h.w.adapter.live.get(sessionId).run, on)
  assert.equal(h.w.events('new-session').length, 2)
  assert.equal(h.w.events('prompt').at(-1).pid, onPid)
  assert.equal(reads, 0)
})

test('the production handoff ACK with a derived system row leaves the first ACP process for the owner to open ON', async t => {
  const h = await host(t, { saved: true })
  h.rt.botOf('b').segments = [{ sessionId: 'previous-ben' }]
  const { fresh, startup } = await botFresh(t, h)
  const { session } = fresh
  const sessionId = session.id
  const selected = session.snapshotEvents().findLast(event => event.type === 'model/selection')?.data
  assert.deepEqual(selected, { provider: CLAUDE, model: 'default' })
  const append = { surfaceOp: 'append' }
  // APP-TEST-A-HANDOFF-FIX recorded these message rows at seq 9–13, 16 and 23.
  const system = createSystemMessage('Synthetic Bot instructions for this test.')
  session.append('system/message', { turn: 1, step: 1, message: system }, append)
  for (const message of [startup, ...startupContext()]) session.append('user/message', message, append)
  const middleware = h.ctx.listeners.get('llm/stream').find(listener => /function\* acknowledge/.test(String(listener)))
  assert.ok(middleware, 'the Bot team registered its handoff ACK middleware')
  const chunks = []
  for await (const chunk of middleware({ sessionId, messages: session.deriveMessages() }, () => assert.fail('the handoff ACK called the adapter'))) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(content, [{ type: 'text', text: HANDOFF_ACK }])
  assert.deepEqual(h.w.events('new-session'), [])
  assert.deepEqual(h.w.events('prompt'), [])
  assert.equal(h.w.adapter.live.has(sessionId), false)
  const ack = createAssistantMessage({ content, source: { provider: CLAUDE, model: 'default' } })
  session.append('assistant/message', { turn: 1, step: 1, message: ack }, append)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1 })
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })

  const owner = 'Teste automático (1564-A): plain owner direct Electron HOFF-01'
  const input = person(owner)
  session.append('user/message', input, append)
  const messages = session.deriveMessages()
  assert.deepEqual(messages[0], system)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].source.kind, 'system-prompt')
  assert.ok(messages[0].content[0].text.length > 0)
  assert.deepEqual(messages[1], startup)
  assert.match(messages[1].content[0].text, /^\[Handoff · part 3\]/)
  assert.deepEqual(messages.slice(-2), [ack, input])
  const request = markAgentLoopRequest({ ...selected, sessionId, messages })
  const answer = []
  for await (const chunk of middleware(request, () => h.w.adapter.stream(request))) answer.push(chunk)
  assert.deepEqual(answer.at(-1).reason, { kind: 'stop' })
  const launches = h.w.events('new-session')
  const prompts = h.w.events('prompt')
  assert.equal(h.w.adapter.live.get(sessionId).provider, CLAUDE)
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].text.includes(owner))
  assert.ok(prompts[0].text.includes(HANDOFF_ACK))
  assert.deepEqual(prompts.map(row => row.pid), launches.map(row => row.pid))
  t.diagnostic(JSON.stringify({
    sessionId,
    provider: request.provider,
    derived: messages.map(message => [message.role, message.source.kind]),
    newSessions: launches.map(({ pid, meta }) => ({ pid, disableBuiltInTools: meta.disableBuiltInTools })),
    prompts: prompts.map(({ pid }) => ({ pid, input: 'owner' })),
  }))
  assert.deepEqual(launches.map(row => row.meta.disableBuiltInTools), [false])
  h.w.assertToolset(0, true)
})

for (const part of [2, 10]) {
  test(`New conversation delivers the own-chat handoff package for part ${part}`, async t => {
    const h = await host(t)
    if (part > 2) h.rt.botOf('b').segments = Array.from({ length: part - 2 }, (_, index) => ({ sessionId: `old-ben-${index + 1}` }))
    const { startup } = await botFresh(t, h)
    assert.ok(startup.content[0].text.startsWith(`[Handoff · part ${part}]\n`))
  })
}

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

test('saving OFF while an ON Claude starts holds the turn and sends the next prompt to a new OFF PID', async t => {
  const h = await host(t, { saved: true })
  const chat = h.chat()
  const startup = holdNativeStartup(t, h.w)
  const pending = chat.turn('owner during startup')
  let on
  try {
    on = await Promise.race([startup.entered, pending.then(() => assert.fail('ON startup did not reach the hold'))])
    h.w.assertToolset(0, true)
    assert.deepEqual(h.w.events('prompt'), [])
    assert.equal((await h.call('update-bot', { id: 'a', nativeTools: false })).ok, true)
    assert.equal(h.stored().bots.a.nativeTools, undefined)
  } finally {
    startup.release()
  }
  const stopped = await pending
  assert.deepEqual(stopped.at(-1).reason, { kind: 'stop' })
  assert.deepEqual(h.w.events('prompt'), [])
  assert.equal(h.w.events('new-session').length, 1)
  await on.gone.catch(() => {})
  assert.ok(on.exited)
  await chat.turn('owner after saving OFF')
  h.w.assertToolset(1, false)
  const [first, next] = h.w.events('new-session')
  assert.notEqual(first.pid, next.pid)
  assert.deepEqual(h.w.events('prompt').map(row => row.pid), [next.pid])
  const text = stopped.findLast(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')?.block.text
  t.diagnostic(JSON.stringify({ offSave: true, onPid: first.pid, offPid: next.pid, stopped: text }))
  assert.equal(text, 'The tools setting changed; send again.')
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
