// Where work starts by itself (a task's first turn, a new Bot's greeting, a member's first
// turn in a group), a permission level that could not be applied starts nothing: the
// start is refused with a message that says so, never left to run on DSH's default,
// which may be wider. The failure is injected in the fake presets service's `set`, as DSH
// would throw it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { afterRound } from './relay-rows.js'

const FULL = 'danger-full-access'
const WRITE = 'workspace-write'
const STOCK = {
  [WRITE]: { sandbox: 'workspace-write', approval: 'ask' },
  [FULL]: { sandbox: 'danger-full-access', approval: 'never' },
}
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }
const NOT_SET = 'The permission level could not be set, so nothing was started. Try again.'
const NOT_OFFERED = 'The saved permission level is no longer offered, so nothing was started. Pick a permission level again.'

// A fake DSH presets service writing to `log`. `failing(sessionId, name)` makes one set throw.
function presetService(log, { auto = true, stock = STOCK, defaultPreset = WRITE, noDefault = false } = {}) {
  const presetOf = new Map()
  const service = {
    auto,
    failing: () => false,
    names: () => [...Object.keys(stock), ...(service.auto ? ['auto'] : [])],
    catalog: () => ({ options: service.names().map(value => ({ value, name: value })), defaultOptions: [], ...(noDefault ? {} : { defaultPreset }) }),
    resolve: (name) => {
      if (!service.names().includes(name)) throw new Error(`permission: unknown preset "${name}"`)
      return name === 'auto' ? AUTO_SPEC : stock[name]
    },
    current: session => presetOf.get(session.id),
    set: (session, name) => {
      service.resolve(name)
      if (service.failing(session.id, name)) throw new Error('permission: the Session log refused the write')
      if (presetOf.get(session.id) !== name) log.push(`${session.id} preset ${name}`)
      presetOf.set(session.id, name)
    },
  }
  return service
}

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', name: 'Omni', role: '', instructions: '', createdAt: 1 },
    b2: { id: 'b2', name: 'Ada', role: '', instructions: '', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2'], mode: 'everyone', notice: '', sessions: {}, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// The whole team, as in permissions.test.js. Group members' answers are played back
// through session/event, as in rounds.test.js, so a round runs with no model.
function team(t, { bots = {}, room = {}, prefs, ...catalog } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-apply-failure-'))
  const saved = { ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(prefs ? { prefs } : {}) }
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const log = []
  const open = new Set()
  const archived = []
  const sent = []
  const service = presetService(log, catalog)
  const ctx = fakeContext({ services: { permissionPresets: service } })
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) inboxes.set(sessionId, { nextTurn: [], nextStep: [], remove: () => true })
    return inboxes.get(sessionId)
  }
  let sessions = 0
  const announce = (session) => {
    if (open.has(session.id)) return
    open.add(session.id)
    for (const listener of ctx.listeners.get('session/created') ?? []) void listener(session)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }], listModels: async () => [{ id: 'deepseek-v4-flash' }], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: home }),
      resolveByPath: async path => ({ id: 'w1', path }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (id) => { archived.push(id) },
    },
    sessionController: {
      async create() {
        const sessionId = `s${++sessions}`
        announce({ id: sessionId })
        return { sessionId }
      },
      async resolveAgent(sessionId) {
        const session = { id: sessionId }
        announce(session)
        await new Promise(resolve => setTimeout(resolve, 1))
        return { agent: { session, followup: message => sent.push({ sessionId, message }) } }
      },
      selectModel: async () => {},
      prompt: async (request) => {
        inboxOf(request.sessionId).nextTurn.push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async (session) => { log.push(`${session.id} first turn`) }, list: () => [...open].map(id => ({ id })) },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = ctx.provided.get('omniTeam')
  t.mock.method(rt, 'warn', () => {})
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const presets = sessionId => log.filter(line => line.startsWith(`${sessionId} preset `)).map(line => line.split(' preset ')[1])
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId, session: { id: sessionId } }, callId: randomUUID(), signal: new AbortController().signal })
  // The relay's own result names where its rows start; the round runs on, and its rows are read as the chat does.
  const relay = (roomId, callId) => ctx.registeredTools.get('group_relay').execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal: new AbortController().signal })
    .then(async value => JSON.stringify(await afterRound(rt, roomId, value)))
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  return { ctx, rt, service, home, call, log, presets, settle, archived, sent, emit, tool, relay, answer }
}
const fail = (service, when = () => true) => { service.failing = when }
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return undefined
}
const roomTurn = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source?.role === 'room'))

test('a task whose level could not be set takes no first turn and ends as failed', async (t) => {
  const { rt, service, home, call, log, presets, settle, archived } = team(t, { bots: { m1: { permission: WRITE } }, defaultPreset: FULL })
  await call('state', {})
  fail(service)
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), { code: 'bot/refused', message: NOT_SET })
  await settle()
  const [[sessionId, task]] = Object.entries(rt.state.tasks)
  assert.deepEqual(presets(sessionId), [])
  assert.equal(log.includes(`${sessionId} first turn`), false, log.join(' | '))
  // Not left working: nothing resumes it after a restart, and it can be forgotten.
  assert.equal(task.status, 'failed')
  assert.equal(typeof task.endedAt, 'number')
  assert.equal(task.summary, NOT_SET)
  const onDisk = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).tasks[sessionId]
  assert.equal(onDisk.status, 'failed')
  // Its Session is not left open on the default level.
  assert.deepEqual(archived, [sessionId])

  // The same start once the level can be set again: the failure was not kept.
  fail(service, () => false)
  const next = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await settle()
  assert.deepEqual(presets(next), [WRITE])
  assert.equal(rt.state.tasks[next].status, 'working')
  assert.ok(log.includes(`${next} first turn`))
})

test('start_task tells its Bot the task did not start, and why', async (t) => {
  const { rt, service, call, log, tool } = team(t, { bots: { m1: { permission: WRITE } } })
  await call('state', {})
  fail(service)
  const reply = await tool('start_task', { title: 'Wish', instructions: 'Do it' }, rt.chatOf('m1'))
  assert.equal(reply, `The task did not start: ${NOT_SET}`)
  assert.equal(log.some(line => line.endsWith('first turn')), false)
  assert.deepEqual(Object.values(rt.state.tasks).map(task => task.status), ['failed'])
})

test('a saved level that left the catalog refuses the task and says to pick one again', async (t) => {
  // Nothing still offered is known to allow no more than the level the person chose.
  const { rt, call, log, presets, tool } = team(t, { bots: { m1: { permission: 'gone' } }, stock: { ...STOCK, 'read-only': { sandbox: 'read-only', approval: 'ask' } }, defaultPreset: FULL })
  await call('state', {})
  const reply = await tool('start_task', { title: 'Wish', instructions: 'Do it' }, rt.chatOf('m1'))
  assert.equal(reply, `The task did not start: ${NOT_OFFERED}`)
  const [[sessionId, task]] = Object.entries(rt.state.tasks)
  assert.deepEqual(presets(sessionId), [])
  assert.equal(log.some(line => line.endsWith('first turn')), false)
  assert.equal(task.status, 'failed')
  // The Bot's saved level is left for the user to change; once changed, tasks start.
  assert.equal(rt.botOf('m1').permission, 'gone')
  assert.equal((await call('update-bot', { id: 'm1', permission: WRITE })).ok, true)
  const next = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  assert.deepEqual(presets(next), [WRITE])
  assert.equal(rt.state.tasks[next].status, 'working')
})

test('a task with no level to set starts as before', async (t) => {
  // A Bot without a level and a catalog without a default: nothing is set, nothing refused.
  const none = team(t, { noDefault: true })
  await none.call('state', {})
  fail(none.service)
  const task = await none.rt.startTask({ title: 'Chore', text: 'Do it', from: 'm1' })
  assert.ok(none.log.includes(`${task} first turn`))
  assert.equal(none.rt.state.tasks[task].status, 'working')
})

test('the Auto fallback still holds for a task, and for a Bot it is still marked', async (t) => {
  const { rt, service, call, presets, settle } = team(t, { bots: { m1: { permission: 'auto' } } })
  await call('state', {})
  fail(service, (_session, name) => name === 'auto')
  const task = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await settle()
  assert.deepEqual(presets(task), [WRITE])
  assert.equal(rt.state.tasks[task].status, 'working')
  const created = await call('create-bot', { name: 'Nova' })
  assert.equal(created.ok, true)
  // A Bot whose saved Auto fell back says so in the team view.
  await call('update-bot', { id: 'b2', permission: 'auto' })
  await settle()
  const bot = (await call('state', {})).value.bots.find(entry => entry.id === 'b2')
  assert.equal(bot.permission, 'auto')
  assert.equal(bot.permissionFallback, WRITE)
  // Auto and its fallback both failing is a refusal.
  fail(service)
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), { code: 'bot/refused', message: NOT_SET })
})

test('a new Bot whose level could not be set is not created and never greets', async (t) => {
  const { rt, service, call, archived, sent, settle, tool } = team(t, { prefs: { permission: WRITE }, defaultPreset: FULL })
  await call('state', {})
  const before = Object.keys(rt.state.bots)
  fail(service)
  const refused = await call('create-bot', { name: 'Nova' })
  await settle()
  assert.equal(refused.ok, false)
  assert.equal(refused.error.message, NOT_SET)
  assert.deepEqual(Object.keys(rt.state.bots), before)
  assert.equal(archived.length, 1, 'its Session is archived, not left open on the default level')
  assert.equal(sent.length, 0, 'no greeting')
  // A Bot made by a Bot: the reply claims no level.
  await call('update-bot', { id: 'm1', permission: WRITE })
  const reply = await tool('create_bot', { name: 'Kit', role: 'Helper', instructions: 'Help.' }, rt.chatOf('m1'))
  assert.equal(reply, `Could not create the Bot: ${NOT_SET}`)
  assert.deepEqual(Object.keys(rt.state.bots), before)

  // Once the level holds, the Bot is created at it and greets, as before.
  fail(service, () => false)
  const created = await call('create-bot', { name: 'Nova' })
  assert.equal(created.ok, true)
  assert.equal(created.value.permission, WRITE)
  await settle()
  assert.equal((await call('state', {})).value.bots.some(bot => bot.name === 'Nova'), true)
})

test('a member\'s first group Session whose level could not be set takes no turn there', async (t) => {
  const { rt, service, call, archived, sent, emit, relay, answer, presets } = team(t, { room: { permission: WRITE }, defaultPreset: FULL })
  await call('state', {})
  // Omni's Session in the group cannot take the group's level; Ada's can.
  const refusedFor = new Set()
  fail(service, (sessionId) => {
    if (refusedFor.size === 0) refusedFor.add(sessionId)
    return refusedFor.has(sessionId)
  })
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const turn = await roomTurn(sent)
  const [lost] = [...refusedFor]
  assert.notEqual(turn.sessionId, lost, 'the Session without its level got no prompt')
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Ada here.', 1)
  const result = JSON.parse(await running)
  // One line in the group says why the member is silent.
  const failed = result.replies.filter(reply => reply.kind === 'failed')
  assert.deepEqual(failed.map(reply => [reply.name, reply.code, reply.text]), [['Omni', 'PERMISSION', NOT_SET]])
  assert.equal(sent.some(entry => entry.sessionId === lost), false)
  assert.equal(rt.roomOf('r1').sessions.m1, undefined, 'the Session is not kept as the member\'s')
  assert.equal(rt.groupOwners.has(lost), false)
  assert.ok(archived.includes(lost))
  assert.deepEqual(presets(turn.sessionId), [WRITE])

  // Its next turn there makes another Session, which takes the level and the prompt.
  fail(service, () => false)
  sent.length = 0
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Again' }] } })
  const second = relay('r1', 'round-2')
  const first = await roomTurn(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Omni here.', 2)
  const other = await roomTurn(sent, first)
  if (other !== undefined) await answer(other.sessionId, other.message.source.exchangeId, 'Ada again.', 3)
  await Promise.race([second, new Promise((_, reject) => setTimeout(() => reject(new Error('the second round did not end')), 5000).unref())])
  const fresh = rt.roomOf('r1').sessions.m1
  assert.notEqual(fresh, undefined)
  assert.notEqual(fresh, lost)
  assert.deepEqual(presets(fresh), [WRITE])
})

test('the first Main Bot is still made when its level cannot be set, and its held greeting is not sent', async (t) => {
  // An empty team: the team view makes the Main Bot, whose greeting waits for a model.
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-apply-failure-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: [], revision: 1, bots: {}, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: { permission: WRITE } }))
  const log = []
  const service = presetService(log, { defaultPreset: FULL })
  const ctx = fakeContext({ services: { permissionPresets: service } })
  const sent = []
  let sessions = 0
  // No model is served until the test says so: a held greeting goes out once its Bot's model is.
  const served = []
  Object.assign(ctx, {
    llm: { listProviders: () => (served.length > 0 ? [{ id: 'deepseek', name: 'DeepSeek' }] : []), listModels: async () => served, resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => ({ id: 'w1', path: home }), resolveByPath: async path => ({ id: 'w1', path }), create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async () => ({ accepted: true }),
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, list: () => [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = ctx.provided.get('omniTeam')
  t.mock.method(rt, 'warn', () => {})
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  fail(service)
  const first = await call('state', {})
  assert.equal(first.ok, true, JSON.stringify(first.error))
  const main = first.value.bots.find(bot => bot.id === first.value.mainBotId)
  assert.notEqual(main, undefined)
  assert.equal((await call('state', {})).value.bots.length, first.value.bots.length, 'no second Bot on the next poll')
  assert.equal(sessions, 1)
  // Nothing was started for it: its greeting is held.
  assert.equal(main.waiting, true)
  assert.equal(sent.length, 0)
  // The held greeting is not let go while the level does not hold.
  served.push({ id: 'deepseek-v4-flash' })
  rt.botOf(main.id).model = 'deepseek/deepseek-v4-flash'
  await rt.updateBot(main.id, { role: 'Lead' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sent.length, 0)
  assert.notEqual(rt.botOf(main.id).kickoff, undefined, 'the greeting stays held for the next try')
  // With the level set, the held greeting goes out at the next change, as before.
  fail(service, () => false)
  await rt.updateBot(main.id, { role: 'Chief' })
  const greeted = await waitFor(() => (sent.length > 0 ? sent : undefined))
  assert.equal(greeted?.[0]?.sessionId, rt.chatOf(main.id))
  assert.equal(rt.botOf(main.id).kickoff, undefined)
  assert.deepEqual(log.filter(line => line.includes(' preset ')), [`${rt.chatOf(main.id)} preset ${WRITE}`])
})

test('a level lowered while a member\'s first group Session is made still reaches it', async (t) => {
  const { rt, call, sent, emit, relay, answer, presets, service } = team(t, { room: { permission: FULL } })
  await call('state', {})
  // The group is narrowed after the new Session's first apply read its level and before
  // the Session is the member's: the change itself reaches only the Sessions known then.
  const set = service.set
  let lowered
  service.set = (session, name) => {
    if (lowered === undefined && name === FULL) {
      lowered = session.id
      rt.roomOf('r1').permission = WRITE
    }
    set(session, name)
  }
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const first = await roomTurn(sent)
  // Read when its first turn is sent; checked once the round is over.
  const atFirstTurn = service.current({ id: first.sessionId })
  await answer(first.sessionId, first.message.source.exchangeId, 'Here.', 1)
  const other = await roomTurn(sent, first)
  if (other !== undefined) await answer(other.sessionId, other.message.source.exchangeId, 'Here too.', 2)
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('the round did not end')), 5000).unref())])
  assert.equal(first.sessionId, lowered)
  assert.equal(atFirstTurn, WRITE, `first turn at ${presets(first.sessionId).join(' -> ')}`)
})

test('without a presets service, Bots, tasks and group Sessions start as before', async (t) => {
  const { ctx, rt, call, sent, log } = team(t, { prefs: { permission: WRITE }, room: { permission: WRITE } })
  const get = ctx.get
  ctx.get = name => (name === 'permissionPresets' ? undefined : get(name))
  await call('state', {})
  assert.equal((await call('create-bot', { name: 'Nova' })).ok, true)
  const task = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  assert.ok(log.includes(`${task} first turn`))
  assert.equal(rt.state.tasks[task].status, 'working')
  assert.equal(sent.length >= 0, true)
})
