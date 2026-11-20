import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { LlmRuntime, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { apply } from '../index.js'
import { install as installModels } from '../src/host/models.js'
import { install as installParts } from '../src/host/parts.js'
import { install as installModelState } from '../src/host/model-state.js'
import { HermesTransport, RemoteChat } from '../src/host/hermes-transport.js'
import { RemoteChatAdapter } from '../src/host/remote-chat-adapter.js'
import { fakeContext } from './fake-ctx.js'
import { desktop8Session } from './fixtures/hermes-desktop8.mjs'

const ATTACH = 'hermes-remote/attach'
const CARRIED = { provider: 'hermes-remote', model: 'nous:sample-model' }
const DEEPSEEK = { provider: 'deepseek', model: 'saved' }
const ROW = {
  id: 'attach', name: 'sample-model (sample)', provider: 'hermes-remote',
  model: 'sample-model', providerId: 'sample', contextWindow: 200_000,
}
const Persistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default

async function until(predicate, what) {
  const end = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < end, `Timed out waiting for ${what}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

function carriedSession(id, route = CARRIED) {
  const session = new Session(id)
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: route }, reason: 'initial' })
  for (let index = 0; index < 400; index += 1) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `message ${index}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
  return session
}

async function openStore(root) {
  const host = new Context()
  await host.plugin(Storage)
  await host.plugin(StorageJson, { root: join(root, 'storage') })
  await host.plugin(StorageDomain, { backend: 'json' })
  await host.plugin(Persistence, { root: join(root, 'sessions') })
  return host
}

// Close and reopen the real store before a plugin reads any carried route.
async function teamStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-refused-restore-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let host = await openStore(root)
  for (const id of ['b1', 'b2']) {
    const handle = await host.sessionPersistence.create({
      version: 4, id, createdAt: 1, isSeeded: false,
    })
    await handle.append(carriedSession(id).snapshotEvents())
    await handle.flush()
    await handle.close()
  }
  await host.fiber.dispose()
  host = await openStore(root)
  t.after(() => host.fiber.dispose())
  const load = async id => {
    const handle = await host.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      const session = Session.create(id, events)
      assert.equal(session.deriveMessages().length, 400)
      return session
    } finally { await handle.close() }
  }
  return { root, persistence: host.sessionPersistence, load }
}

function bots() {
  return Object.fromEntries(['Sample Bot', 'Second'].map((name, index) => {
    const id = `b${index + 1}`
    return [id, {
      id, sessionId: id, name, createdAt: index + 1, model: ATTACH,
      appliedModel: ATTACH, previousModel: ATTACH, effort: 'low', appliedEffort: 'low',
    }]
  }))
}

const llm = {
  listProviders: () => [
    { id: 'hermes-remote', name: 'Remote Hermes' }, { id: 'deepseek', name: 'DeepSeek' },
  ],
  listModels: async provider => provider === 'hermes-remote' ? [ROW] : [{ id: 'saved' }],
  resolveModelInfo: async () => ({
    context: { contextWindow: 200_000 }, defaultMaxTokens: 8000,
    reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
  }),
}

// One attached Hermes endpoint for both Bots. Only the wire boundary is fake.
function attachedWire(t) {
  const sent = []
  const source = desktop8Session('sample-live', 'sample-stored')
  let socket
  class Socket extends EventTarget {
    constructor() {
      super()
      this.turns = 0
      queueMicrotask(() => this.event('gateway.ready', { replay_epoch: 'epoch-a' }))
    }
    frame(frame) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
    }
    event(type, payload) {
      this.frame({ jsonrpc: '2.0', method: 'event', params: {
        type, payload, session_id: source.create.session_id,
      } })
    }
    send(text) {
      const frame = JSON.parse(text)
      sent.push(frame)
      if (!frame.method) return
      const result = frame.method === 'client.capabilities' ? { server_requests: ['approval'] }
        : frame.method === 'session.list'
          ? { sessions: [{ id: source.create.stored_session_id, title: 'Bot Chat' }] }
          : frame.method === 'session.create' ? source.create
            : ['session.resume', 'session.activate'].includes(frame.method) ? source.live
              : frame.method === 'session.events.since'
                ? { events: [], latest_seq: 0, epoch: 'epoch-a', count: 0,
                  truncated: false, open_requests: [] }
                : { status: 'streaming' }
      // A real Hermes opens the turn with a stamped `message.start` before it streams.
      if (frame.method === 'prompt.submit') this.event('message.start', { turn_id: `turn-${++this.turns}` })
      queueMicrotask(() => this.frame({ jsonrpc: '2.0', id: frame.id, result }))
    }
    close() { this.dispatchEvent(new Event('close')) }
  }
  const wire = new HermesTransport({
    address: 'https://sample.invalid', credential: 'sample-credential',
    profile: 'sample', attached: true,
    deadlines: { start: 1000, control: 1000, cancel: 30 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'sample' }) }),
    socket: () => { socket = new Socket(); return socket },
  })
  t.after(() => wire.close())
  return { wire, sent, complete: text => socket.event('message.complete', { text }) }
}

function emitSession(ctx, session, event) {
  for (const listener of ctx.listeners.get('session/event') ?? []) listener(session, event)
}

// The real runtime dispatches the Session's own messages through the exact-route guard.
// Model state receives the text the stream actually returned, never a made-up answer.
function answerBench(t, h) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('agents')
  ctx.set('agents', { get: id => h.agents.get(id), list: () => [...h.agents.values()] })
  let f
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, attached: () => true, models: () => [ROW],
    identity: () => ({ canonicalBot: true }), save: async () => {},
    open: async () => {
      f = attachedWire(t)
      await f.wire.connect()
      return new RemoteChat(f.wire, {
        identity: { canonicalBot: true }, save: async () => {},
      })
    },
  })
  t.after(() => adapter.dispose())
  const runtime = new LlmRuntime(ctx)
  runtime.registerAdapter(['hermes-remote'], adapter)
  return async (id, botId = id) => {
    const session = h.agents.get(id).session
    const config = session.requestHeader().config
    assert.deepEqual(config, CARRIED, 'the carried route survives the lifecycle')
    const messages = session.deriveMessages()
    assert.equal(messages.length, 400, 'the whole carried chat reaches the runtime')
    f = undefined
    const stream = runtime.stream(markAgentLoopRequest(Object.freeze({
      ...config, sessionId: id, messages, tools: Object.freeze([]),
      signal: new AbortController().signal,
    })))
    const first = stream.next()
    await until(() => f?.sent.some(frame => frame.method === 'prompt.submit'),
      `${id} to submit through the attached transport`)
    const text = `Answer for ${id}`
    f.complete(text)
    const chunks = [(await first).value]
    for await (const chunk of stream) chunks.push(chunk)
    const answer = chunks.filter(chunk => chunk.type === 'text-delta')
      .map(chunk => chunk.text).join('')
    assert.equal(answer, text)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    emitSession(h.ctx, session, session.append('assistant/message', {
      turn: 2, message: { role: 'assistant', source: config,
        content: [{ type: 'text', text: answer }] },
    }, { surfaceOp: 'append' }))
    if (id === h.rt.chatOf(botId)) {
      const view = h.rt.modelStateView()[botId]
      assert.equal(view.answered, true)
      assert.equal(view.pending, false)
      assert.equal(view.lastAnswer.ref, ATTACH)
      assert.equal(h.rt.state.bots[botId].previousModel, ATTACH)
    }
  }
}

async function pluginBench(t, store, home) {
  home ??= mkdtempSync(join(tmpdir(), 'ds-bot-refused-plugin-'))
  if (!readFileSyncSafe(join(home, 'state.json'))) {
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, revision: 1, whaleStored: true, mainBotIds: ['b1'], rooms: {}, bots: bots(),
    }))
  }
  const agents = new Map(), live = new Map(), selected = [], renameCalls = []
  let rt, route, refuseRename = false
  const ctx = fakeContext({ services: { sessionPersistence: store.persistence,
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
  } })
  Object.assign(ctx, {
    llm,
    sessions: { get: id => live.get(id), list: () => [...live.values()], flush: async () => {} },
    sessionController: {
      create: async () => { throw new Error('no fresh Session expected') },
      resolveAgent: async id => ({ agent: agents.get(id) }),
      selectModel: async request => {
        selected.push(request)
        const session = agents.get(request.sessionId)?.session
        if (session) session.append('request/header', { header: { config: {
          provider: request.provider, model: request.model,
        } } })
      },
    },
    sessionTitle: { rename: async () => {
      renameCalls.push(rt.state.bots.b1.appliedEffort)
      if (refuseRename) throw new Error('rename: rejected')
    } },
    workspaceRegistry: { archiveSession: async () => {}, get: () => undefined,
      resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }) },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request(
    'http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) },
  ))).json()
  await call('state', {})
  rt = ctx.provided.get('omniTeam')
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await ctx.dispose()
  }
  t.after(async () => { await stop(); rmSync(home, { recursive: true, force: true }) })
  const load = async () => {
    for (const id of ['b1', 'b2']) {
      const session = await store.load(id)
      agents.set(id, { id, session, followup() {} })
      live.set(id, session)
    }
  }
  return { rt, ctx, agents, selected, renameCalls, call, stop, load, home,
    refuseRename: () => { refuseRename = true },
  }
}

function readFileSyncSafe(path) {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

test('R1: a late update-bot refusal restores two long carried chats on one attach', async t => {
  const store = await teamStore(t)
  const h = await pluginBench(t, store)
  await h.load()
  const before = structuredClone(h.rt.state.bots)
  h.refuseRename()
  const response = await h.call('update-bot', {
    id: 'b1', effort: 'high', name: 'Sample Bot',
  })
  assert.equal(response.ok, false)
  assert.equal(response.error.message, 'Something went wrong (Error).')
  assert.deepEqual(h.renameCalls, ['high'], 'the switch was accepted before the late refusal')
  assert.deepEqual(h.rt.state.bots, before, 'both Bots keep their fields')
  const saved = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.bots, before, 'the saved Bot fields are restored too')
  assert.deepEqual(h.selected, [], 'neither carried chat is selected during switch or restore')
  const answer = answerBench(t, h)
  await answer('b1')
  await answer('b2')
  assert.deepEqual(h.selected, [])
})

test('R2: reinstall restore bootstraps a fresh plugin over the same JSONL store', async t => {
  const store = await teamStore(t)
  const first = await pluginBench(t, store)
  await first.stop()
  const h = await pluginBench(t, store, first.home)
  assert.notEqual(h.rt, first.rt, 'the restore uses a fresh plugin instance')
  assert.equal(h.agents.size, 0, 'bootstrap reads unloaded chats from the real store')
  await h.rt.catalog()
  await h.rt.syncModels()
  for (const force of [false, true]) {
    for (const bot of Object.values(h.rt.state.bots)) await h.rt.applyModel(bot, { force })
  }
  assert.deepEqual(h.selected, [])
  await h.load()
  const answer = answerBench(t, h)
  await answer('b1')
  await answer('b2')
  assert.deepEqual(h.selected, [])
})

async function partsBench(t, { group = false, route = CARRIED } = {}) {
  const sessions = new Map(), agents = new Map(), selected = [], archived = [], warnings = []
  const state = { bots: bots(), rooms: {}, switching: {}, questions: {}, views: {}, prefs: {} }
  if (group) state.rooms.room = {
    id: 'room', name: 'Sample room', members: ['b1', 'b2'],
    sessions: { b1: 'seat1', b2: 'seat2' }, segments: {},
  }
  const ctx = fakeContext({ services: { tokenMeter: {
    measure: session => ({ totalTokens: session.surface.nodes.length * 1000,
      nodes: session.surface.nodes.map(seq => ({ seq, tokens: 1000 })) }),
    estimateMessage: () => 100,
  } } })
  Object.assign(ctx, { llm,
    sessions: { get: id => sessions.get(id), list: () => [...sessions.values()],
      flush: async () => {} },
    sessionController: { selectModel: async request => {
      selected.push(request)
      sessions.get(request.sessionId).append('request/header', { header: { config: {
        provider: request.provider, model: request.model,
      } } })
    } },
    workspaceRegistry: { archiveSession: async id => { archived.push(id) } },
  })
  const rt = {
    ctx, config: {}, state, botOf: id => state.bots[id], roomOf: id => state.rooms[id],
    chatOf: id => state.bots[id]?.sessionId, selfOf: id => rt.chatOwners.get(id),
    chatOwners: new Map(), groupOwners: new Map(), roomOwners: new Map(), pastOwners: new Map(),
    live: new Map(), isBotSession: id => rt.chatOwners.has(id) || rt.groupOwners.has(id),
    groupSessionsOf: id => group ? [state.rooms.room.sessions[id]] : [],
    readOnly: () => undefined, load: async () => {}, save: async () => {
      rt.chatOwners.clear(); rt.groupOwners.clear()
      for (const bot of Object.values(state.bots)) rt.chatOwners.set(bot.sessionId, bot.id)
      if (group) for (const [botId, id] of Object.entries(state.rooms.room.sessions)) {
        rt.groupOwners.set(id, { botId, roomId: 'room' })
      }
    },
    warn: (...args) => warnings.push(args), renewMemory() {},
    tagUsage: (messages, tag) => Object.assign(messages, { tag }),
    liveOf: () => ({}), workDirOf: () => undefined, teamFolder: () => undefined,
    isFolder: async () => false, ensureWorkspace: async () => {},
    applyPermission: async () => {}, applyToolDeny: async () => {},
    ensureCapabilities: async () => {}, moveSchedules: async () => {},
    resolveAgent: async id => agents.get(id),
    eventsBackwards: async function* (id) {
      yield* [...(sessions.get(id)?.snapshotEvents() ?? [])].reverse()
    },
    createSession: async () => {
      const id = `fresh${sessions.size}`
      makeAgent(new Session(id))
      return id
    },
  }
  function makeAgent(session) {
    const agent = {
      id: session.id, session, status: 'idle', options: {},
      inbox: { nextStep: [], nextTurn: [],
        prepend(_where, message) { this.nextTurn.unshift(message) },
        remove(id) { this.nextTurn = this.nextTurn.filter(message => message.id !== id) },
      },
      followup(message) { this.inbox.nextTurn.push(message) },
      send(message) { this.inbox.nextTurn.push(message) },
      whenIdle: async () => {}, runMaintenance: run => run(new AbortController().signal),
    }
    agents.set(session.id, agent)
    sessions.set(session.id, session)
  }
  for (const id of ['b1', 'b2', ...(group ? ['seat1', 'seat2'] : [])]) {
    makeAgent(carriedSession(id, route))
  }
  await rt.save()
  installModels(rt)
  // No route answers a handoff beside these chats, as in switchBench's agent-only rows.
  rt.backgroundModel = async () => undefined
  rt.answersAside = () => false
  installParts(rt)
  installModelState(rt)
  t.after(() => ctx.dispose())
  const current = bot => group ? state.rooms.room.sessions[bot.id] : bot.sessionId
  const move = async bot => {
    const oldId = current(bot)
    const agent = agents.get(oldId)
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    await preStep({ agent, turn: 2, step: 1, messages: [],
      signal: new AbortController().signal,
      modelSelection: { provider: 'hermes-remote', model: 'attach' },
    }, () => { throw new Error('the long chat must move before the model call') })
    try {
      await until(() => current(bot) !== oldId && rt.awaitingFirstAnswer(current(bot)),
        `${oldId} to open a watched fresh part`)
    } catch (error) {
      throw new Error(`${error.message}; warnings: ${JSON.stringify(warnings)}`, { cause: error })
    }
    const freshId = current(bot)
    await until(() => [...rt.switchJobs()].length === 0, 'the handoff to finish')
    assert.equal(archived.includes(oldId), false)
    return { oldId, freshId }
  }
  const fail = async ({ oldId, freshId }, bot) => {
    const session = sessions.get(freshId)
    emitSession(ctx, session, session.append('turn/start', { turn: 1 }))
    emitSession(ctx, session, session.append('turn/end', { turn: 1, reason: {
      kind: 'error', error: { code: 'REMOTE_HERMES', message: 'The first call failed.' },
    } }))
    await until(() => current(bot) === oldId && archived.includes(freshId),
      `${bot.id} to finish reverting its failed first call`)
    assert.equal(archived.includes(oldId), false, 'the carried part stays resumable')
  }
  return { rt, ctx, agents, sessions, selected, archived, warnings, move, fail, current }
}

for (const group of [false, true]) {
  test(`R3: both carried ${group ? 'group seats' : 'Bot chats'} survive first-call rollback`,
    async t => {
      const h = await partsBench(t, { group })
      const entries = []
      for (const bot of Object.values(h.rt.state.bots)) entries.push([bot, await h.move(bot)])
      for (const [bot, entry] of entries) {
        await h.fail(entry, bot)
        assert.equal(bot.appliedModel, ATTACH)
        assert.equal(bot.appliedEffort, 'low', 'the kept selection records its effort')
        assert.deepEqual(h.selected.filter(row => row.sessionId === entry.oldId), [],
          'R3 never selects the old carried part')
      }
      const answer = answerBench(t, h)
      for (const [bot, entry] of entries) await answer(entry.oldId, bot.id)
    })
}

test('R3: revertModel restores attach before deciding whether to keep the old route', async t => {
  const h = await partsBench(t)
  const entries = []
  for (const bot of Object.values(h.rt.state.bots)) {
    bot.model = 'deepseek/saved'
    const entry = await h.move(bot)
    assert.equal(bot.appliedModel, 'deepseek/saved')
    entries.push([bot, entry])
  }
  for (const [bot, entry] of entries) {
    await h.fail(entry, bot)
    assert.equal(bot.model, ATTACH, 'revertModel moved the pending pick back first')
    assert.equal(bot.appliedModel, ATTACH)
    assert.deepEqual(h.selected.filter(row => row.sessionId === entry.oldId), [])
    assert.equal(h.rt.modelStateView()[bot.id].lastFailure.kept, ATTACH)
  }
  const answer = answerBench(t, h)
  for (const [bot, entry] of entries) await answer(entry.oldId, bot.id)
})

test('R3 control: a DeepSeek old part is still selected onto attach', async t => {
  const h = await partsBench(t, { route: DEEPSEEK })
  for (const bot of Object.values(h.rt.state.bots)) {
    const entry = await h.move(bot)
    await h.fail(entry, bot)
    assert.deepEqual(h.selected.filter(row => row.sessionId === entry.oldId), [{
      sessionId: entry.oldId, provider: 'hermes-remote', model: 'attach', reasoningEffort: 'low',
    }])
  }
})

test('R3 control: a reverted non-Hermes ref reselects the old part as in case 8b', async t => {
  const h = await partsBench(t)
  for (const bot of Object.values(h.rt.state.bots)) {
    bot.previousModel = 'deepseek/saved'
    const entry = await h.move(bot)
    await h.fail(entry, bot)
    assert.equal(bot.model, 'deepseek/saved')
    assert.deepEqual(h.selected.filter(row => row.sessionId === entry.oldId), [{
      sessionId: entry.oldId, provider: 'deepseek', model: 'saved', reasoningEffort: 'low',
    }])
  }
})

const RULE_ROWS = [
  ['live carried', CARRIED, undefined, ATTACH, true],
  ['stored carried', undefined, CARRIED, ATTACH, true],
  ['live other provider', DEEPSEEK, CARRIED, ATTACH, false],
  ['stored other provider', undefined, DEEPSEEK, ATTACH, false],
  ['missing log', undefined, 'missing', ATTACH, false],
  ['unreadable log', undefined, 'unreadable', ATTACH, true],
  ['other ref', CARRIED, CARRIED, 'deepseek/saved', false],
  ['other Hermes ref', CARRIED, CARRIED, 'hermes-remote/nous:sample-model', false],
  ['throwing live header', 'throws', CARRIED, ATTACH, false],
]
for (const [name, live, stored, ref, expected] of RULE_ROWS) {
  test(`keepsCarriedRoute: ${name}`, async t => {
    let reads = 0
    const ctx = fakeContext({ services: { sessionPersistence: { open: async () => {
      reads += 1
      if (stored === 'missing') throw Object.assign(new Error('missing'), {
        name: 'SessionPersistenceNotFoundError',
      })
      if (stored === 'unreadable') throw new Error('unreadable')
      return { read: async () => ({ events: [{ type: 'request/header',
        data: { header: { config: stored } } }] }), close: async () => {} }
    } } } })
    ctx.sessions = { get: () => live === undefined ? undefined : { requestHeader: () => {
      if (live === 'throws') throw new Error('header unavailable')
      return { config: live }
    } } }
    const rt = { ctx, state: { bots: {} } }
    installModels(rt)
    t.after(() => ctx.dispose())
    assert.equal(await rt.keepsCarriedRoute('b1', ref), expected)
    assert.equal(reads, live === undefined && ref === ATTACH ? 1 : 0)
  })
}
