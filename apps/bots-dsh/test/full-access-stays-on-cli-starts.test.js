// The places a new Session of a Bot starts work by itself (a task, a member's first turn in a
// group, a new Bot's greeting, a fresh part), for a Bot at Full access whose coding
// CLI is not served now, or is served and could not be selected on that Session: the Session
// would start on DSH's default model at that level, so the start is refused and nothing runs.
// Any other level starts as before, on the default model. The team harness is the one of
// permission-apply-failure.test.js: only `deepseek` is served, so `acp-codex` is gone, unless
// the case asks for it (`codex`); `failSelect` makes a selection throw.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
function team(t, { bots = {}, room = {}, prefs, codex = false, failSelect = () => false, ...catalog } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-stays-on-cli-'))
  const saved = { ...TEAM, bots: { m1: { ...TEAM.bots.m1, ...bots.m1 }, b2: { ...TEAM.bots.b2, ...bots.b2 } }, rooms: { r1: { ...TEAM.rooms.r1, ...room } }, ...(prefs ? { prefs } : {}) }
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const log = []
  const open = new Set()
  const archived = []
  const sent = []
  const selected = []
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
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, ...(codex ? [{ id: 'acp-codex', name: 'Codex' }] : [])],
      listModels: async provider => (provider === 'acp-codex' ? [{ id: 'default' }] : [{ id: 'deepseek-v4-flash' }]),
      resolveModelInfo: async () => ({}),
    },
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
        // Enough of an agent for a fresh part to be made from it (parts.js moveOn).
        return {
          agent: {
            id: sessionId, session: Object.assign(session, { deriveMessages: () => [], requestHeader: () => undefined }), inbox: inboxOf(sessionId),
            followup: message => sent.push({ sessionId, message }), whenIdle: async () => {}, runMaintenance: job => job(new AbortController().signal),
          },
        }
      },
      selectModel: async (request) => {
        if (failSelect(request)) throw new Error('the agent did not take the model')
        selected.push([request.sessionId, `${request.provider}/${request.model}`])
      },
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
  return { ctx, rt, service, home, call, log, presets, settle, archived, sent, selected, emit, tool, relay, answer }
}
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return undefined
}
const roomTurn = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source?.role === 'room'))


const STAYS = 'This Bot has Full access on its coding CLI, which is not available now, so nothing was started on another model. Fix the CLI or sign in to it, or pick another model for the Bot yourself.'
const ON_CODEX = { model: 'acp-codex/default' }

test('a task of a Bot at Full access whose coding CLI is gone takes no first turn on the default model', async (t) => {
  const { rt, call, log, settle, archived, presets } = team(t, { bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await call('state', {})
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), { code: 'bot/refused', message: STAYS })
  await settle()
  const [[sessionId, task]] = Object.entries(rt.state.tasks)
  assert.equal(log.includes(`${sessionId} first turn`), false, log.join(' | '))
  assert.equal(task.status, 'failed')
  assert.equal(task.summary, STAYS)
  assert.deepEqual(archived, [sessionId], 'its Session is not left open at Full access on another model')
  assert.deepEqual(presets(sessionId), [FULL], 'the level itself was set as chosen: it is not narrowed silently')
})

test('the same task at Workspace, or of a Bot on another model at Full access, starts as before', async (t) => {
  const narrow = team(t, { bots: { m1: { ...ON_CODEX, permission: WRITE } } })
  await narrow.call('state', {})
  const first = await narrow.rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await narrow.settle()
  assert.equal(narrow.rt.state.tasks[first].status, 'working')
  assert.ok(narrow.log.includes(`${first} first turn`))
  assert.deepEqual(narrow.archived, [])

  const native = team(t, { bots: { m1: { model: 'deepseek/deepseek-v4-flash', permission: FULL } } })
  await native.call('state', {})
  const second = await native.rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await native.settle()
  assert.equal(native.rt.state.tasks[second].status, 'working')
  assert.ok(native.log.includes(`${second} first turn`))
})

test('a member at Full access whose coding CLI is gone takes no turn in a group on the default model', async (t) => {
  const { rt, call, archived, sent, emit, relay, answer } = team(t, { bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await call('state', {})
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const turn = await roomTurn(sent)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Ada here.', 1)
  const result = JSON.parse(await running)
  const failed = result.replies.filter(reply => reply.kind === 'failed')
  assert.deepEqual(failed.map(reply => [reply.name, reply.text]), [['Omni', STAYS]], 'one line in the group says why the member is silent')
  assert.equal(rt.roomOf('r1').sessions.m1, undefined, 'the Session is not kept as the member\'s')
  assert.equal(archived.length, 1)
  assert.equal(sent.some(entry => entry.sessionId === archived[0]), false, 'it got no prompt')
  assert.notEqual(rt.roomOf('r1').sessions.b2, undefined, 'the other member answered as before')
})

test('a group whose level is narrower lets that member in: its Session there is not at Full access', async (t) => {
  const { rt, call, sent, emit, relay, answer, archived } = team(t, { bots: { m1: { ...ON_CODEX, permission: FULL } }, room: { permission: WRITE } })
  await call('state', {})
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const first = await roomTurn(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'One.', 1)
  const other = await roomTurn(sent, first)
  if (other !== undefined) await answer(other.sessionId, other.message.source.exchangeId, 'Two.', 2)
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('the round did not end')), 5000).unref())])
  assert.notEqual(rt.roomOf('r1').sessions.m1, undefined)
  assert.deepEqual(archived, [])
})

test('a group that gives Full access guards its Session too, whatever the member\'s own level', async (t) => {
  // Omni's own level is Workspace; the group's is Full access, so its Session there is wide.
  const { rt, call, archived, sent, emit, relay, answer } = team(t, { bots: { m1: { ...ON_CODEX, permission: WRITE } }, room: { permission: FULL } })
  await call('state', {})
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const turn = await roomTurn(sent)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Ada here.', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'failed').map(reply => [reply.name, reply.text]), [['Omni', STAYS]])
  assert.equal(rt.roomOf('r1').sessions.m1, undefined)
  assert.equal(archived.length, 1)
  assert.equal(sent.some(entry => entry.sessionId === archived[0]), false, 'it got no prompt')
  // The same Bot's task, asked for outside the group, runs at its own Workspace: started.
  const task = await rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  assert.equal(rt.state.tasks[task].status, 'working')
})

// The CLI's model is catalogued, and selecting it on the new Session throws: the Session is
// still on the model DSH made it with, so it is as if the CLI were gone.
const onCodex = request => request.provider === 'acp-codex'

test('a task whose coding CLI model could not be selected is not started at Full access', async (t) => {
  const { rt, call, log, settle, archived } = team(t, { codex: true, failSelect: onCodex, bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await call('state', {})
  await assert.rejects(rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' }), { code: 'bot/refused', message: STAYS })
  await settle()
  const [[sessionId, task]] = Object.entries(rt.state.tasks)
  assert.equal(task.status, 'failed')
  assert.equal(task.summary, STAYS)
  assert.equal(log.includes(`${sessionId} first turn`), false, log.join(' | '))
  assert.deepEqual(archived, [sessionId])
})

test('the same failed selection at Workspace, or with the CLI selected, starts the task as before', async (t) => {
  const narrow = team(t, { codex: true, failSelect: onCodex, bots: { m1: { ...ON_CODEX, permission: WRITE } } })
  await narrow.call('state', {})
  const first = await narrow.rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await narrow.settle()
  assert.equal(narrow.rt.state.tasks[first].status, 'working', 'on the default model, as on any day the selection fails')
  assert.ok(narrow.log.includes(`${first} first turn`))
  assert.deepEqual(narrow.archived, [])

  const served = team(t, { codex: true, bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await served.call('state', {})
  const second = await served.rt.startTask({ title: 'Wish', text: 'Do it', from: 'm1' })
  await served.settle()
  assert.equal(served.rt.state.tasks[second].status, 'working')
  assert.ok(served.selected.some(([sessionId, ref]) => sessionId === second && ref === 'acp-codex/default'), 'it runs on its CLI')
})

test('a member whose coding CLI model could not be selected takes no turn in a group at Full access', async (t) => {
  const { rt, call, archived, sent, emit, relay, answer } = team(t, { codex: true, failSelect: onCodex, bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await call('state', {})
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const turn = await roomTurn(sent)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Ada here.', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'failed').map(reply => [reply.name, reply.text]), [['Omni', STAYS]])
  assert.equal(rt.roomOf('r1').sessions.m1, undefined, 'the Session is not kept as the member\'s')
  assert.equal(rt.groupOwners.has(archived[0]), false)
  assert.equal(archived.length, 1)
  assert.equal(sent.some(entry => entry.sessionId === archived[0]), false, 'it got no prompt')
})

test('the same failed selection in a group at Workspace seats the member as before', async (t) => {
  const { rt, call, sent, emit, relay, answer, archived } = team(t, { codex: true, failSelect: onCodex, bots: { m1: { ...ON_CODEX, permission: WRITE } } })
  await call('state', {})
  await emit('r1', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Report in' }] } })
  const running = relay('r1', 'round-1')
  const first = await roomTurn(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'One.', 1)
  const other = await roomTurn(sent, first)
  if (other !== undefined) await answer(other.sessionId, other.message.source.exchangeId, 'Two.', 2)
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('the round did not end')), 5000).unref())])
  assert.notEqual(rt.roomOf('r1').sessions.m1, undefined)
  assert.deepEqual(archived, [])
})

// A new Bot's greeting (roster.js): the Bot is made on its CLI model, which is served, and the
// selection on its chat fails.
const greeted = (sent, rt, name) => {
  const bot = Object.values(rt.state.bots).find(entry => entry.name === name)
  return sent.filter(entry => entry.sessionId === rt.chatOf(bot.id))
}

test('a new Bot at Full access whose coding CLI model could not be selected does not greet', async (t) => {
  const { rt, call, sent, settle } = team(t, { codex: true, failSelect: onCodex, prefs: { permission: FULL } })
  await call('state', {})
  const created = await call('create-bot', { name: 'Nova', model: 'acp-codex/default' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.value.permission, FULL)
  await settle()
  await settle()
  assert.deepEqual(greeted(sent, rt, 'Nova'), [], 'no greeting on the model DSH made its chat with')
  assert.ok(rt.warn.mock.calls.some(call => /does not greet/.test(call.arguments[0]) && call.arguments[2] === STAYS))
})

test('the same new Bot at Workspace, or with its CLI selected at Full access, greets as before', async (t) => {
  const narrow = team(t, { codex: true, failSelect: onCodex, prefs: { permission: WRITE } })
  await narrow.call('state', {})
  assert.equal((await narrow.call('create-bot', { name: 'Nova', model: 'acp-codex/default' })).ok, true)
  assert.equal((await waitFor(() => (greeted(narrow.sent, narrow.rt, 'Nova').length > 0 ? true : undefined))), true, 'it greets on the default model')

  const served = team(t, { codex: true, prefs: { permission: FULL } })
  await served.call('state', {})
  assert.equal((await served.call('create-bot', { name: 'Nova', model: 'acp-codex/default' })).ok, true)
  assert.equal((await waitFor(() => (greeted(served.sent, served.rt, 'Nova').length > 0 ? true : undefined))), true)
  const nova = Object.values(served.rt.state.bots).find(entry => entry.name === 'Nova')
  assert.ok(served.selected.some(([sessionId, ref]) => sessionId === served.rt.chatOf(nova.id) && ref === 'acp-codex/default'))
})

// A fresh part (parts.js moveOn), asked for as the person does from the Bot's chat. The fresh
// Session is not the Bot's until the move ends, so its level is its Bot's, not the default's.
// The Bot's chat moves to the fresh part before the handoff is sent there (a few awaits
// later), so the case waits for the whole move (the switch's `done`), not for the chat to move.
const freshPart = async ({ rt }) => {
  await rt.startFresh('m1')
  const job = [...rt.switchJobs()].find(entry => entry.botId === 'm1' && entry.roomId === undefined)
  assert.ok(job, 'the move started')
  await Promise.race([job.done, new Promise((_, reject) => setTimeout(() => reject(new Error('the move did not end')), 10_000).unref())])
  return rt.chatOf('m1')
}

test('a fresh part of a Workspace Bot is kept though the profile default is Full access', async (t) => {
  // Codex is gone, so the fresh part runs on the default model, at the Bot's own Workspace.
  const h = team(t, { bots: { m1: { ...ON_CODEX, permission: WRITE } }, defaultPreset: FULL })
  await h.call('state', {})
  const current = await freshPart(h)
  assert.notEqual(current, 'm1', 'the Bot moved on to its fresh part')
  assert.equal(h.archived.includes(current), false, 'the fresh part is not archived')
  assert.deepEqual(h.presets(current), [WRITE])
  assert.ok(h.selected.some(([sessionId, ref]) => sessionId === current && ref === 'deepseek/deepseek-v4-flash'))
  // The handoff is sent after the Bot's chat moves to the fresh part: wait for it, bounded.
  assert.equal(await waitFor(() => (h.sent.some(entry => entry.sessionId === current) ? true : undefined)), true, 'and it was handed the conversation')
})

test('a fresh part of a Full access Bot whose coding CLI is gone is not kept though the default is Workspace', async (t) => {
  const h = team(t, { bots: { m1: { ...ON_CODEX, permission: FULL } }, defaultPreset: WRITE })
  await h.call('state', {})
  assert.equal(await freshPart(h), 'm1', 'the Bot stays on the part it had')
  assert.equal(h.archived.length, 1)
  assert.equal(h.sent.some(entry => entry.sessionId === h.archived[0]), false, 'the fresh Session got no handoff')
  assert.equal(h.rt.state.bots.m1.segments, undefined)
})

test('a fresh part whose coding CLI model could not be selected is not kept at Full access, and is at Workspace', async (t) => {
  const wide = team(t, { codex: true, failSelect: request => onCodex(request) && request.sessionId !== 'm1', bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await wide.call('state', {})
  assert.equal(await freshPart(wide), 'm1')
  assert.equal(wide.archived.length, 1)
  assert.equal(wide.sent.some(entry => entry.sessionId === wide.archived[0]), false)

  const narrow = team(t, { codex: true, failSelect: request => onCodex(request) && request.sessionId !== 'm1', bots: { m1: { ...ON_CODEX, permission: WRITE } } })
  await narrow.call('state', {})
  const kept = await freshPart(narrow)
  assert.notEqual(kept, 'm1')
  assert.equal(narrow.archived.includes(kept), false)

  const served = team(t, { codex: true, bots: { m1: { ...ON_CODEX, permission: FULL } } })
  await served.call('state', {})
  const current = await freshPart(served)
  assert.notEqual(current, 'm1', 'with its CLI selected the fresh part is kept at Full access')
  assert.ok(served.selected.some(([sessionId, ref]) => sessionId === current && ref === 'acp-codex/default'))
})
