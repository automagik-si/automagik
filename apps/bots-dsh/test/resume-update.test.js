import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as SessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnSubagents from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { apply } from '../index.js'
import { install as installLogin } from '../src/host/cli-login.js'
import { SOURCE_KIND, UPDATE_CUT } from '../src/host/constants.js'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'
import { scopeSessions } from '../src/host/member-wall/principals.js'
import { install as installParts } from '../src/host/parts.js'
import { install, RESUME_DELAY_MS } from '../src/host/resume.js'
import { createUpdateHold, install as installHold, STOP_WAIT_MS } from '../src/host/self-update-hold.js'
import { readUpdateRecovery } from '../src/host/self-update-recovery.js'
import { storeDirOf, writeJsonAtomic } from '../src/host/self-update.js'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installWakeLog } from '../src/host/wake-log.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'
import { durableDsh } from './wake-dsh.js'

const cutReason = { kind: 'aborted', reason: { kind: 'hook', reason: UPDATE_CUT } }
const user = (text, source = { kind: 'user' }) => createUserMessage({ source, content: [{ type: 'text', text }] })
const entry = message => ({ at: Date.now(), message })
const empty = { turns: {}, queued: {}, held: {}, cut: [] }
const liveRun = phase => ({ runId: 'test-update', requestId: 'test-request', phase, updatedAt: new Date().toISOString() })
const temp = t => {
  const home = mkdtempSync(join(tmpdir(), 'bots-resume-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}
const notesOf = home => JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8'))
const preSteps = ctx => [...(ctx.events._hooks['agent/pre-step'] ?? [])]
const seed = (home, notes) => writeFileSync(join(home, 'inflight.json'), JSON.stringify({ ...empty, ...notes }))
const emit = (ctx, id, type, data = {}) => {
  for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, { type, data, time: Date.now() })
}

function runtime(ctx, home) {
  const bots = { ada: { id: 'ada', name: 'Ada', sessionId: 'chat' }, sender: { id: 'sender', name: 'Sender', sessionId: 'sender-chat' } }
  return {
    ctx, home, config: {}, state: { bots, tasks: {}, agents: {}, switching: {}, rooms: {} },
    statePath: join(home, 'state.json'), chatOwners: new Map(), groupOwners: new Map(),
    roomOwners: new Map(), pastOwners: new Map(), live: new Map(),
    botOf: id => bots[id], chatOf: id => bots[id]?.sessionId, roomOf() {},
    selfOf(id) { return this.chatOwners.get(id) ?? this.groupOwners.get(id)?.botId },
    isBotSession(id) { return this.selfOf(id) !== undefined },
    sessionNow: id => id, lockTerm: () => 1, readOnly: () => undefined,
    holdsLock: () => true, teamLoaded: () => true, onLockGained: () => () => {},
    load: async () => {}, save: async () => {}, ownRequest: () => false, warn() {},
    deliver: async () => {},
  }
}

function useBootHold(rt, phase = 'health', expectedRun) {
  let run = liveRun(phase)
  const hold = createUpdateHold({
    expectedRun,
    readStatus: () => ({ supervised: true, profileKnown: true, run }),
    bootPlan: () => rt.resumeDestinationsPlanned,
    schedule: () => ({}),
  })
  rt.updateHold = hold
  rt.updateGate = signal => hold.gate(signal)
  rt.updateHoldView = () => hold.closed
  return phase => { run = liveRun(phase); hold.tick() }
}

function replayBench(t, home, { agents = new Map(), logs = new Map(), before, gate = true, profileDir, updateRun } = {}) {
  const ctx = fakeContext(profileDir === undefined ? undefined : { services: { profileContext: { dir: profileDir } } })
  const sent = []
  ctx.sessions = {
    flush: async () => true,
  }
  ctx.sessionController = {
    inspect: async id => ({ events: logs.get(id) }),
  }
  const rt = runtime(ctx, home)
  rt.resolveAgent = async id => agents.get(id)
  rt.deliver = async (args, { enqueue } = {}) => {
    const agent = agents.get(args.sessionId)
    sent.push(args)
    if (enqueue && agent) return enqueue(agent, user(args.text, { kind: SOURCE_KIND, ...args }))
    return args
  }
  before?.(rt)
  if (updateRun) {
    rt.selfUpdateStatus = () => ({ run: updateRun })
    const previousRun = process.env.AUTOMAGIK_SUPERVISOR_RUN
    process.env.AUTOMAGIK_SUPERVISOR_RUN = updateRun.runId
    try { install(rt) } finally {
      if (previousRun === undefined) delete process.env.AUTOMAGIK_SUPERVISOR_RUN
      else process.env.AUTOMAGIK_SUPERVISOR_RUN = previousRun
    }
  } else install(rt)
  const verdict = gate ? useBootHold(rt, typeof gate === 'string' ? gate : undefined, gate === 'rollingBack' ? 'test-update' : undefined) : undefined
  t.after(() => ctx.dispose())
  return { ctx, rt, sent, verdict }
}

async function finishBoot(t, b, phase = 'healthy') {
  b.verdict?.(phase)
  await immediate()
  t.mock.timers.tick(RESUME_DELAY_MS)
  return b.rt.resumesDone
}

test('boot recovery waits for a blocked delivery and replays held input after independent task healing fails', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const run = liveRun('healthy')
  const exchangeId = 'blocked-delivery'
  const input = user('keep this input')
  seed(home, {
    queued: { chat: [{ at: Date.now(), args: { toId: 'ada', text: 'pick this up', role: 'continue', exchangeId } }] },
    held: { chat: [entry(input)] },
  })
  const blocked = Promise.withResolvers()
  const healingFailed = Promise.withResolvers()
  const messages = []
  const chat = { session: { id: 'chat' }, followup: message => messages.push(message) }
  const task = { status: 'idle', followup() {}, session: { id: 'ordinary-task', seq: 1,
    eventAt: () => ({ type: 'turn/end', time: Date.now(), data: { reason: { kind: 'interrupted' } } }) } }
  const previousRun = process.env.AUTOMAGIK_SUPERVISOR_RUN
  process.env.AUTOMAGIK_SUPERVISOR_RUN = run.runId
  let b
  try {
    b = replayBench(t, home, {
      profileDir, gate: false, agents: new Map([['chat', chat], ['ordinary-task', task]]), logs: new Map([['chat', []]]),
      before(rt) {
        rt.selfUpdateStatus = () => ({ run })
        rt.chatOwners.set('chat', 'ada')
        rt.state.agents.worker = { sessions: ['ordinary-task'] }
        const deliver = rt.deliver
        rt.deliver = async (args, options) => {
          if (args.exchangeId === exchangeId) await blocked.promise
          return deliver(args, options)
        }
        rt.ctx.sessions.flush = async session => {
          if (session === task.session) {
            healingFailed.resolve()
            throw new Error('fixture task flush failed')
          }
          return true
        }
      },
    })
  } finally {
    if (previousRun === undefined) delete process.env.AUTOMAGIK_SUPERVISOR_RUN
    else process.env.AUTOMAGIK_SUPERVISOR_RUN = previousRun
  }
  const done = finishBoot(t, b)
  await healingFailed.promise
  await immediate()
  const pending = readUpdateRecovery(profileDir, run)
  blocked.resolve()
  assert.equal(pending.complete, false)
  assert.deepEqual(pending.items.map(item => item.state), ['pending', 'pending'])
  assert.equal((await done).failed, 'fixture task flush failed')
  assert.deepEqual(messages.map(message => message.source.exchangeId ?? message.id), [exchangeId, input.id])
  const report = readUpdateRecovery(profileDir, run)
  assert.equal(report.complete, true)
  assert.deepEqual(report.items.map(({ kind, state }) => [kind, state]), [['delivery', 'resumed'], ['input', 'resumed']])
})

test('adoption merges disk and local message IDs and recovers an old running cut task past its restart limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const first = user('disk input'), second = user('local input')
  const handed = []
  const agents = new Map([
    ['chat', { id: 'chat', session: { id: 'chat' }, followup: message => handed.push(message) }],
    ['old-task', { id: 'old-task', status: 'running', session: { id: 'old-task' }, followup: message => handed.push(message) }],
  ])
  const logs = new Map([['chat', []]])
  const daily = { count: 2, at: Date.now() }
  const b = replayBench(t, home, { agents, logs, before(rt) {
    rt.state.tasks['old-task'] = { status: 'working' }
    rt.state.agents.worker = { sessions: ['old-task', ...Array.from({ length: 12 }, (_, i) => `task-${i}`)] }
    rt.state.restartResumes = { 'old-task': daily }
  } })
  let owning = false
  b.rt.readOnly = () => owning ? undefined : 'reading'
  assert.equal(await b.rt.noteHeldInput('chat', [second]), false)
  owning = true
  seed(home, { held: { chat: [entry(first), entry(first)] }, cut: ['old-task'] })
  await b.rt.reloadDeliveryNotes(() => {})
  assert.deepEqual((await finishBoot(t, b)).resumed, ['old-task'])
  assert.equal(handed[0].source.resumedByUpdate, true)
  assert.deepEqual(handed.slice(1).map(message => message.id), [first.id, second.id])
  assert.deepEqual(b.rt.state.restartResumes['old-task'], daily)
  await b.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [first.id, second.id])
  assert.deepEqual(notesOf(home).cut, [])
})

test('held notes survive unavailable sessions or history and a cut stays until its handoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const consumed = user('already written'), missing = user('no agent'), unread = user('unreadable log')
  const messages = []
  const agent = { id: 'chat', session: { id: 'chat' }, followup: message => messages.push(message) }
  seed(home, { held: { chat: [entry(consumed)], missing: [entry(missing)], unread: [entry(unread)] }, cut: ['no-cut-agent'] })
  const b = replayBench(t, home, {
    agents: new Map([['chat', agent], ['unread', agent]]),
    logs: new Map([['chat', [{ type: 'user/message', data: consumed }]], ['missing', []]]),
  })
  await finishBoot(t, b)
  await b.rt.flushUpdateNotes()
  const notes = notesOf(home)
  assert.deepEqual(notes.cut, ['no-cut-agent'])
  assert.deepEqual(Object.fromEntries(Object.entries(notes.held).map(([id, entries]) => [id, entries.map(item => item.message)])),
    { missing: [missing], unread: [unread] })
  assert.deepEqual(messages, [])
})

test('an update continuation survives unrelated activity, routes joined room calls and stays eligible for an ordinary restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const resumed = []
  const room = { id: 'room', members: ['ada'], sessions: { ada: 'group-chat' } }
  const roomCall = { info: { role: 'room', roomId: 'room', exchangeId: 'room-call', askedBy: 'sender', senderRoomId: 'source-room' }, text: 'A room call' }
  const botCall = { info: { role: 'request', exchangeId: 'bot-call', senderSessionId: 'sender', senderRoomId: 'source-room' }, text: 'A Bot call' }
  const roomAgent = { status: 'running', session: { id: 'group-chat' }, followup: message => resumed.push(message) }
  const agents = new Map([[roomAgent.session.id, roomAgent]])
  seed(home, { turns: { 'group-chat': { since: 1, botId: 'ada', roomId: room.id, resumed: true, stoppedBy: 'update',
    trigger: { role: 'room', joined: [roomCall, botCall] } } } })
  const notices = []
  const b = replayBench(t, home, { agents, before(rt) {
    rt.groupOwners.set('group-chat', { botId: 'ada', roomId: room.id })
    rt.roomOf = id => id === room.id ? room : undefined
    rt.postToRoom = async (_room, _bot, _text, options) => { notices.push(options) }
  } })
  emit(b.ctx, 'group-chat', 'turn/start')
  emit(b.ctx, 'group-chat', 'user/message', user('unrelated activity'))
  assert.deepEqual((await finishBoot(t, b, 'rolledBack')).resumed, ['group-chat'])
  assert.equal(resumed[0].source.resumedByUpdate, true)
  assert.equal(notices[0].again, undefined)
  assert.equal(notices[0].resumedByUpdate, true)
  const call = b.sent.find(args => args.exchangeId === 'room-call')
  const request = b.sent.find(args => args.exchangeId === 'bot-call')
  assert.deepEqual([call.fromId, call.sessionId, call.askedBy, call.fromRoomId], [undefined, 'group-chat', 'sender', 'source-room'])
  assert.deepEqual([request.fromId, request.sessionId, request.fromRoomId], ['sender', 'group-chat', 'source-room'])
  b.rt.live.set('group-chat', { info: resumed[0].source })
  emit(b.ctx, 'group-chat', 'turn/start')
  await b.rt.flushUpdateNotes()
  assert.equal(notesOf(home).turns['group-chat'].resumedByUpdate, true)
  assert.equal(notesOf(home).turns['group-chat'].resumed, undefined)
  await b.ctx.dispose()
  roomAgent.status = 'idle'
  const next = replayBench(t, home, { agents, gate: false, before(rt) {
    rt.groupOwners.set('group-chat', { botId: 'ada', roomId: room.id })
    rt.roomOf = id => id === room.id ? room : undefined
    rt.postToRoom = async (_room, _bot, _text, options) => { notices.push(options) }
  } })
  assert.deepEqual((await finishBoot(t, next)).resumed, ['group-chat'])
  assert.equal(resumed[1].source.resumed, true)
  assert.equal(resumed[1].source.resumedByUpdate, undefined)
})

test('an update-cut turn hands back later results and keeps joined requests without answering the trigger', async t => {
  const home = temp(t)
  const ctx = fakeContext()
  const rt = runtime(ctx, home)
  const delivered = []
  rt.deliver = async args => { delivered.push(args); return args.exchangeId }
  rt.chatOwners.set('chat', 'ada')
  installTurns(rt)
  install(rt)
  t.after(() => ctx.dispose())
  emit(ctx, 'chat', 'turn/start', { turn: 1 })
  const joined = [
    { info: { exchangeId: 'joined', role: 'request', senderSessionId: 'sender' }, text: 'also do this' },
    { info: { exchangeId: 'room-call', role: 'room', askedBy: 'sender', roomId: 'room' }, text: 'for the room' },
  ]
  Object.assign(rt.liveOf('chat'), {
    info: { exchangeId: 'trigger', role: 'request', senderSessionId: 'sender' },
    joined,
    later: [{ info: { exchangeId: 'result', role: 'reply', senderSessionId: 'sender' }, text: 'result came back' }],
  })
  await rt.markUpdateStop(['chat'])
  const cutNotes = notesOf(home).turns.chat
  assert.deepEqual(cutNotes.trigger.joined, joined)
  assert.equal(cutNotes.later[0].info.exchangeId, 'result')
  assert.deepEqual(delivered, [])
  emit(ctx, 'chat', 'turn/end', { reason: cutReason })
  await rt.flushUpdateNotes()
  assert.deepEqual(delivered.map(item => [item.exchangeId, item.deferred]), [['result', true]])
  assert.deepEqual(notesOf(home).turns.chat.trigger.joined, joined)
})

test('disposing during the boot delay leaves disk notes for the next runtime alone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const waiting = user('waiting after restart')
  seed(home, { held: { chat: [entry(waiting)] } })
  const received = []
  const agents = new Map([['chat', { session: { id: 'chat' }, followup: msg => received.push(msg.id) }]])
  const logs = new Map([['chat', []]])
  const old = replayBench(t, home, { agents, logs, gate: false })
  await immediate()
  await old.ctx.dispose()
  t.mock.timers.tick(RESUME_DELAY_MS)
  assert.match((await old.rt.resumesDone).failed, /stopped/)
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [waiting.id])
  const next = replayBench(t, home, { agents, logs, gate: false })
  await finishBoot(t, next)
  assert.deepEqual(received, [waiting.id])
})

function supervise(home, profileDir) {
  const env = { AUTOMAGIK_BOTS_HOME: home, AUTOMAGIK_SUPERVISOR_BOOT: 'fixture-boot', AUTOMAGIK_SUPERVISOR_VERSION: 'v1.2.3' }
  const previous = Object.entries(env).map(([key, value]) => {
    const old = process.env[key]
    process.env[key] = value
    return [key, old]
  })
  writeJsonAtomic(join(storeDirOf(profileDir), 'check.json'), {
    version: 1, runId: 'dry-run', checkedAt: new Date().toISOString(), state: 'available', reason: null,
    laneVersion: '1.2.4', sequence: 6, supervisor: true, plugins: [],
  }, { profileDir })
  return () => {
    for (const [key, old] of previous.splice(0)) {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    }
  }
}

async function realLoop(t, home, { run = null, expectedRun, supervised = false, logs = new Map(),
  turns = false, subagents = false, stream } = {}) {
  const ctx = new Context()
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  ctx.provide('profileContext', { dir: profileDir })
  const restoreEnv = supervised ? supervise(home, profileDir) : () => {}
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: subagents })
  if (subagents) {
    await ctx.plugin(SessionPersistence, { root: join(home, 'dsh-logs'), compression: 'none' })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnSubagents)
  }
  const calls = []
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }
    async *stream(request) {
      calls.push(request)
      await stream?.(request)
      const reply = { type: 'text', text: 'Done' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply.text }
      yield { type: 'block-end', index: 0, block: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const model = { provider: 'd5b-fixture', model: 'test' }
  ctx.llm.registerAdapter([model.provider], new Adapter())
  const rt = runtime(ctx, home)
  const warnings = []
  rt.warn = (...args) => warnings.push(args)
  rt.config.selfUpdate = true
  const status = { available: supervised, reason: supervised ? null : 'no-supervisor', run }
  rt.selfUpdateStatus = () => status
  rt.resolveAgent = async id => ctx.get('agents')?.get(id)
  ctx.provide('sessionController', {
    events: async ({ address, beforeSeq }) => {
      const events = (logs.get(address.sessionId) ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq)
      return { records: events.slice(-2).map(event => ({ event })), hasMore: events.length > 2 }
    },
  })
  ctx.provide('acpAgents', { loginTextMatches: text => text.includes('fixture-secret-token') })
  ctx.on('session/flush', () => {})
  const events = []
  const delivered = []
  rt.deliver = async (args, { enqueue, shouldSend, made } = {}) => {
    const target = args.sessionId ?? rt.chatOf(args.toId)
    const agent = await rt.resolveAgent(target)
    if (!agent || shouldSend?.(agent, target) === false) return
    const source = Object.fromEntries(Object.entries({ ...args, kind: SOURCE_KIND, senderSessionId: args.fromId })
      .filter(([, value]) => value !== undefined))
    const message = user(args.text, source)
    if (enqueue) {
      if (!await enqueue(agent, message)) return
    } else {
      agent.followup(message)
      made?.(message)
      await ctx.sessions.flush(agent.session)
    }
    delivered.push(args)
    return args.exchangeId
  }
  rt.userWrote = () => {}
  rt.userAnswered = () => {}
  rt.workOf = info => info?.work
  rt.workDirOf = () => home
  rt.isFolder = async path => path === home
  ctx.on('session/event', (session, event) => events.push({ id: session.id, ...event }))
  if (turns) installTurns(rt)
  const previousRun = process.env.AUTOMAGIK_SUPERVISOR_RUN
  if (expectedRun !== undefined) process.env.AUTOMAGIK_SUPERVISOR_RUN = expectedRun
  try { install(rt) } finally {
    if (previousRun === undefined) delete process.env.AUTOMAGIK_SUPERVISOR_RUN
    else process.env.AUTOMAGIK_SUPERVISOR_RUN = previousRun
  }
  installWakeLog(rt)
  const earlier = new Set(preSteps(ctx))
  installParts(rt)
  const partsHook = preSteps(ctx).find(hook => !earlier.has(hook))
  installLogin(rt)
  const dispose = installHold(rt)
  const disposeHold = () => {
    dispose()
    restoreEnv()
  }
  t.after(async () => { disposeHold(); await ctx.fiber.dispose() })
  await mountAgentLoopTestHarness(ctx)
  const create = (id, meta) => ctx.agentLoop.createAgent(ctx, {
    sessionId: id, agentOptions: model, meta: subagents ? { cwd: home, ...meta } : meta, setup: agentCtx => { installModelSelection(agentCtx) },
  })
  const verdict = (phase, requestId) => {
    status.run = { ...liveRun(phase), requestId }
    rt.updateHold.tick()
  }
  return { ctx, rt, events, create, calls, disposeHold, warnings, partsHook, delivered, verdict }
}

test('real inbox disposal preserves two owner messages and a direct group goal, with per-ID acknowledgement on boot', async t => {
  const home = temp(t)
  const before = await realLoop(t, home, { run: liveRun('health') })
  const { agent, dispose } = await before.create('chat')
  const first = user('repeated owner input')
  const second = user('repeated owner input')
  const goal = user('direct group goal', { kind: SOURCE_KIND, role: 'goal', exchangeId: 'no-queued-delivery' })
  const withdrawn = user('withdrawn')
  const discarded = []
  before.ctx.on('agent/inbox/discarded', ({ message }) => discarded.push(message.id))
  agent.followup(first)
  await until(() => before.events.some(event => event.type === 'agent/inbox/claimed' && event.data.messages?.includes(first.id))
    || (agent.status === 'running' && !agent.inbox.nextTurn.some(message => message.id === first.id)))
  agent.followup(second)
  agent.followup(goal)
  agent.followup(withdrawn)
  agent.inbox.remove(withdrawn.id)
  await before.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [first.id, second.id, goal.id])
  before.disposeHold()
  await dispose()
  assert.ok(discarded.includes(second.id))
  assert.ok(discarded.includes(goal.id))
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [first.id, second.id, goal.id])
  await before.ctx.fiber.dispose()

  const after = await realLoop(t, home, { logs: new Map([['chat', before.events]]) })
  const again = await after.create('chat')
  await until(() => after.events.some(event => event.type === 'user/message' && event.data.id === goal.id)).catch(async error => {
    t.diagnostic(JSON.stringify({ events: after.events.map(event => [event.type, event.data.reason ?? (event.data.error instanceof Error ? event.data.error.stack : event.data.error)]),
      inbox: again.agent.inbox.nextTurn.map(message => message.source.kind), notes: notesOf(home), warnings: after.warnings,
      boot: await after.rt.resumesDone }))
    throw error
  })
  await again.agent.whenIdle()
  const ids = new Set([first.id, second.id, goal.id, withdrawn.id])
  assert.deepEqual(after.events.filter(event => event.type === 'user/message' && ids.has(event.data.id)).map(event => event.data.id),
    [first.id, second.id, goal.id])
  await after.rt.resumesDone
  await after.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).held, {})
})

test('real Cordis holds Parts before its over-limit work, including claims before the hook and subagent steps', async t => {
  const assembly = Promise.withResolvers()
  t.after(() => assembly.resolve())
  const home = temp(t)
  const b = await realLoop(t, home, { supervised: true })
  const { ctx, rt } = b
  rt.chatOwners.set('chat', 'ada')
  rt.state.tasks.child = { status: 'working' }
  await until(() => !rt.resumeBootPending())
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
  mountBrowserPlugin(ctx, { toolDefs: [], profileRoot: home, openSession: () => assert.fail('the browser must stay closed') })
  const browserHook = preSteps(ctx)[0]
  await ctx.plugin(MemberWallFileSystem, { cwd: home, members: true, principalsFile: join(home, 'principals.json'), membersRoot: home })
  const wallHook = preSteps(ctx)[0]

  let checked = 0
  rt.refreshShellChoice = async () => { checked++ }
  let measured = 250_000
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: measured }) })
  const preparing = Promise.withResolvers()
  const childPreparing = Promise.withResolvers()
  const outer = []
  const filter = rt.dropLoginCodes
  rt.dropLoginCodes = payload => {
    outer.push({ id: payload.agent.id, scope: scopeSessions(), before: payload.messages.map(msg => msg.id) })
    filter(payload)
    outer.at(-1).after = payload.messages.map(msg => msg.id)
  }
  const beforeAgents = new Set(preSteps(ctx))
  const { agent: parent } = await b.create('chat')
  const { agent: child } = await b.create('child', { origin: 'subagent', parentSession: 'chat', subagentDepth: 1 })
  const hooks = preSteps(ctx)
  const beforeParts = hooks.slice(0, hooks.indexOf(b.partsHook))
  assert.ok(beforeParts.includes(wallHook))
  assert.ok(beforeParts.includes(browserHook))
  assert.ok(beforeParts.some(hook => !beforeAgents.has(hook)), 'the agent-scoped model-selection wrapper precedes Parts')
  parent.session.append('user/message', user('long existing context'), { surfaceOp: 'append' })
  const offAssembly = ctx.on('system-prompt/assemble', async (value, context, next) => {
    if (context.agent?.id === parent.id) {
      preparing.resolve()
      await assembly.promise
    } else if (context.agent?.id === child.id) {
      childPreparing.resolve()
      await assembly.promise
    }
    return next()
  })
  const claimed = user('claimed before the click')
  const pending = user('already in the inbox')
  await rt.deliver({ toId: 'ada', text: 'claimed team input', role: 'continue', exchangeId: 'claimed-team' }, {
    enqueue(agent, message) { agent.inject(message); return true },
  })
  parent.followup(claimed)
  child.followup(user('child step waits'))
  await preparing.promise
  await childPreparing.promise
  parent.followup(pending)
  assert.equal(outer.length, 0)
  assert.deepEqual(parent.inbox.nextTurn.map(message => message.id), [pending.id])
  const click = rt.selfUpdateStart()
  assert.equal(rt.updateHold.closed, true)
  assembly.resolve()
  const answer = await click
  offAssembly()
  assert.equal(answer.started, true)
  assert.equal(answer.stopped, 1)
  assert.equal(answer.stillRunning, 0)
  assert.ok(b.events.some(event => event.id === parent.id && event.type === 'turn/end'
    && JSON.stringify(event.data.reason) === JSON.stringify(cutReason)))

  const arrived = user('arrived during update')
  const code = user('fixture-secret-token')
  parent.inject(code)
  parent.followup(arrived)
  await until(() => outer.some(event => event.id === child.id) && outer.some(event => event.before.includes(code.id)))
  const seen = outer.find(event => event.before.includes(code.id))
  assert.deepEqual(seen.scope, [parent.id])
  assert.equal(seen.after.includes(code.id), false)
  assert.equal(child.status, 'running')
  assert.equal(checked, 0)
  assert.equal(b.calls.length, 0)
  await rt.flushUpdateNotes()
  assert.ok(notesOf(home).held.chat.some(item => item.message.id === claimed.id))
  assert.ok(notesOf(home).queued.chat.some(item => item.args.exchangeId === 'claimed-team'))
  assert.ok(!notesOf(home).held.chat.some(item => item.message.source.exchangeId === 'claimed-team'))
  assert.ok(notesOf(home).held.chat.some(item => item.message.id === pending.id))
  assert.ok(notesOf(home).held.chat.some(item => item.message.id === arrived.id))
  assert.equal(notesOf(home).held.chat.some(item => item.message.id === code.id), false)
  assert.equal(notesOf(home).held.child, undefined)
  assert.equal(notesOf(home).cut.includes(child.id), false)
  measured = 0
  b.verdict('notUpdated', answer.requestId)
  const ids = messagesOf(b, parent.id)
  await until(() => ids().some(message => message.id === claimed.id)
    && ids().some(message => message.source.exchangeId === 'claimed-team')).catch(reportLoop(t, b))
  await parent.whenIdle()
  assert.equal(ids().filter(item => item.source.exchangeId === 'claimed-team').length, 1)
  for (const message of [claimed, pending, arrived]) {
    assert.equal(ids().filter(item => item.id === message.id).length, 1)
  }
  await rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).held, {})
})

const reportLoop = (t, bench) => error => {
  t.diagnostic(JSON.stringify({ status: bench.rt.updateHold.state, warnings: bench.warnings.map(args => args.map(arg => arg instanceof Error ? arg.stack : arg)),
    notes: notesOf(bench.rt.home), delivered: bench.delivered.map(args => args.exchangeId),
    events: bench.events.map(event => [event.id, event.type, event.data.source?.exchangeId ?? event.data.reason ?? (event.data.error instanceof Error ? event.data.error.stack : event.data.error)]) }))
  throw error
}
const messagesOf = (bench, id) => () => bench.events
  .filter(event => event.id === id && event.type === 'user/message').map(event => event.data)
const logsOf = bench => new Map([...new Set(bench.events.map(event => event.id))]
  .map(id => [id, bench.events.filter(event => event.id === id)]))
const waitBoot = bench => until(() => !bench.rt.resumeBootPending())
async function stopLoop(bench) {
  bench.disposeHold()
  await bench.ctx.fiber.dispose()
}

async function slowCancellation(t, failReplay) {
  const home = temp(t)
  const assembling = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const b = await realLoop(t, home, { supervised: true })
  b.rt.chatOwners.set('chat', 'ada')
  const { agent } = await b.create('chat')
  await waitBoot(b)
  const off = b.ctx.on('system-prompt/assemble', async (_value, context, next) => {
    if (context.agent?.id === agent.id) {
      assembling.resolve()
      await release.promise
    }
    return next()
  })
  const input = user('claim pending when the verdict arrives')
  const exchangeId = 'slow-cancellation-delivery'
  await b.rt.deliver({ toId: 'ada', text: 'team delivery pending with the input', role: 'continue', exchangeId }, {
    enqueue(target, message) { target.inject(message); return true },
  })
  agent.followup(input)
  await assembling.promise
  const timer = setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    timer(callback, ms === STOP_WAIT_MS ? 0 : ms, ...args))
  const answer = await b.rt.selfUpdateStart()
  assert.equal(answer.started, true)
  assert.equal(answer.stillRunning, 1)
  const initialReplay = Promise.withResolvers()
  const events = b.ctx.sessionController.events
  t.mock.method(b.ctx.sessionController, 'events', async options => {
    const value = await events(options)
    if (options.address.sessionId === agent.id) initialReplay.resolve()
    return value
  })
  b.verdict('notUpdated', answer.requestId)
  await b.rt.updateHold.wait()
  await initialReplay.promise
  await immediate()
  await b.rt.flushUpdateNotes()
  const heldBefore = notesOf(home).held
  assert.deepEqual(heldBefore.chat.map(item => item.message.id), [input.id])
  assert.equal(messagesOf(b, 'chat')().some(message => message.id === input.id), false)
  const summary = () => readUpdateRecovery(join(home, 'profiles', 'web'), b.rt.selfUpdateStatus().run)
  const outcome = kind => summary()?.items.find(item => item.kind === kind)?.state
  assert.equal(summary().complete, false)
  assert.equal(outcome('input'), 'pending')
  assert.equal(outcome('delivery'), 'pending')
  if (failReplay) {
    const followup = agent.followup.bind(agent)
    t.mock.method(agent, 'followup', message => {
      if (message.id === input.id || message.source?.exchangeId === exchangeId) throw new Error('fixture replay failed')
      return followup(message)
    })
  }
  off()
  release.resolve()
  await until(() => summary()?.complete === true).catch(reportLoop(t, b))
  assert.equal(outcome('input'), failReplay ? 'failed' : 'resumed')
  assert.equal(outcome('delivery'), failReplay ? 'failed' : 'resumed')
  const messages = messagesOf(b, 'chat')
  if (!failReplay) {
    await until(() => messages().some(message => message.id === input.id)
      && messages().some(message => message.source.exchangeId === exchangeId)).catch(reportLoop(t, b))
  }
  await agent.whenIdle()
  await b.rt.flushUpdateNotes()
  assert.equal(messages().filter(message => message.id === input.id).length, failReplay ? 0 : 1)
  assert.equal(messages().filter(message => message.source.exchangeId === exchangeId).length, failReplay ? 0 : 1)
  assert.deepEqual(notesOf(home).held, failReplay ? { chat: heldBefore.chat } : {})
}

test('a verdict that beats a slow DSH cancellation replays the claims once after turn end', t => slowCancellation(t, false))
test('slow-cancellation input and delivery claims stay pending until a failed replay', t => slowCancellation(t, true))

for (const recovery of ['notUpdated', 'boot']) {
  test(`a claimed wake report is replayed once after ${recovery}`, async t => {
    const home = temp(t)
    const assembling = Promise.withResolvers()
    const release = Promise.withResolvers()
    const continuing = Promise.withResolvers()
    const continueReply = Promise.withResolvers()
    let pause = recovery === 'notUpdated'
    t.after(() => { release.resolve(); continueReply.resolve() })
    const b = await realLoop(t, home, {
      supervised: true,
      stream(request) {
        if (pause && JSON.stringify(request.messages).includes('An Automagik update stopped your last turn')) {
          pause = false
          continuing.resolve()
          return continueReply.promise
        }
      },
    })
    b.rt.chatOwners.set('chat', 'ada')
    const { agent } = await b.create('chat')
    await waitBoot(b)
    const off = b.ctx.on('system-prompt/assemble', async (_value, context, next) => {
      if (context.agent?.id === agent.id) {
        assembling.resolve()
        await release.promise
      }
      return next()
    })
    const id = 'claimed-task-report'
    const report = { role: 'task-done', taskSessionId: 'task', note: 'Check', text: 'Task finished' }
    const fields = { id, kind: 'task-report', key: 'task:task', botId: 'ada', sessionId: 'chat',
      report, outcome: { status: 'done', endedAt: Date.now(), summary: 'Task finished' } }
    const title = 'Check the update report'
    b.rt.state.tasks.task = { title }
    assert.equal(b.rt.wakeLog.intent(fields), 'written')
    await b.rt.deliver({ toId: 'ada', ...report, exchangeId: id, wake: true }, b.rt.wakeLog.firstOptions(id))
    await assembling.promise
    await b.rt.flushUpdateNotes()
    assert.ok(notesOf(home).queued.chat.some(item => item.args.exchangeId === id && item.args.wake))
    const click = b.rt.selfUpdateStart()
    release.resolve()
    const answer = await click
    off()
    assert.equal(answer.started, true)
    assert.equal(answer.stillRunning, 0)
    assert.equal(messagesOf(b, 'chat')().filter(message => message.source.exchangeId === id).length, 0)

    let recovering = b
    let destination = agent
    if (recovery === 'boot') {
      await stopLoop(b)
      const run = { ...liveRun('healthy'), requestId: answer.requestId }
      recovering = await realLoop(t, home, { logs: logsOf(b), run, expectedRun: run.runId, supervised: true })
      recovering.rt.state.tasks.task = { title }
      recovering.rt.chatOwners.set('chat', 'ada')
      destination = (await recovering.create('chat')).agent
    } else {
      b.verdict('notUpdated', answer.requestId)
      await continuing.promise
      await until(() => b.delivered.some(args => args.exchangeId === id && args.resent)).catch(reportLoop(t, b))
      assert.equal(messagesOf(b, 'chat')().some(message => message.source.exchangeId === id), false)
      const summary = () => readUpdateRecovery(join(home, 'profiles', 'web'), b.rt.selfUpdateStatus().run)
      await until(() => summary()?.complete === true).catch(reportLoop(t, b))
      assert.deepEqual(summary().items.filter(item => item.kind === 'delivery'),
        [{ kind: 'delivery', sessionId: 'chat', name: title, state: 'resumed' }])
      continueReply.resolve()
    }
    const messages = messagesOf(recovering, 'chat')
    await until(() => messages().some(message => message.source.exchangeId === id)).catch(reportLoop(t, recovering))
    await destination.whenIdle()
    await recovering.rt.wakeLog.replayed
    if (recovery === 'boot') {
      await recovering.rt.resumesDone
      const summary = readUpdateRecovery(join(home, 'profiles', 'web'), recovering.rt.selfUpdateStatus().run)
      assert.equal(summary.complete, true)
      assert.deepEqual(summary.items.filter(item => item.kind === 'delivery'),
        [{ kind: 'delivery', sessionId: 'chat', name: title, state: 'resumed' }])
    }
    await recovering.rt.flushUpdateNotes()
    assert.equal(messages().filter(message => message.source.exchangeId === id).length, 1)
    assert.equal(recovering.delivered.filter(args => args.exchangeId === id && args.resent).length, 1)
    const records = readFileSync(join(home, 'wake.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.filter(item => item.id === id && item.event === 'attempt').length, 1)
  })
}

test('a held receipt waits for its own session flush and survives a flush failure', async t => {
  const home = temp(t)
  const b = await realLoop(t, home)
  await b.create('old-chat')
  const { agent } = await b.create('chat')
  await waitBoot(b)
  const flush = b.ctx.sessions.flush.bind(b.ctx.sessions)
  for (const succeeds of [true, false]) {
    const held = user(succeeds ? 'flush pending' : 'flush fails')
    await b.rt.noteHeldInput('old-chat', [held])
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const finished = Promise.withResolvers()
    t.after(() => release.resolve())
    const mock = t.mock.method(b.ctx.sessions, 'flush', async session => {
      if (!messagesOf(b, 'chat')().some(message => message.id === held.id)) return flush(session)
      entered.resolve(session)
      await release.promise
      try {
        if (!succeeds) throw new Error('receipt flush failed')
        return await flush(session)
      } finally {
        finished.resolve()
      }
    })
    agent.followup(held)
    assert.equal(await entered.promise, agent.session)
    await b.rt.flushUpdateNotes()
    assert.deepEqual(notesOf(home).held['old-chat'].map(item => item.message.id), [held.id])
    release.resolve()
    await finished.promise
    await agent.whenIdle()
    await immediate()
    await b.rt.flushUpdateNotes()
    assert.deepEqual(notesOf(home).held['old-chat']?.map(item => item.message.id), succeeds ? undefined : [held.id])
    mock.mock.restore()
  }
})

test('a boot click refuses before a plain cut task is taken and the old cut heals once past 24 hours', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  seed(home, { cut: ['old-task'] })
  const messages = []
  const daily = { count: 2, at: Date.now() }
  const agent = { id: 'old-task', status: 'idle', session: {
    id: 'old-task', seq: 1,
    eventAt: () => ({ type: 'turn/end', data: { reason: cutReason }, time: Date.now() - 25 * 60 * 60_000 }),
  }, followup: message => messages.push(message) }
  const agents = new Map([[agent.id, agent]])
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const env = { AUTOMAGIK_BOTS_HOME: home, AUTOMAGIK_SUPERVISOR_BOOT: 'boot', AUTOMAGIK_SUPERVISOR_VERSION: 'v1.2.3' }
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key]
    process.env[key] = value
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  writeJsonAtomic(join(storeDirOf(profileDir), 'check.json'), {
    version: 1, runId: 'dry-run', checkedAt: new Date().toISOString(), state: 'available', reason: null,
    laneVersion: '1.2.4', sequence: 6, supervisor: true, plugins: [],
  }, { profileDir })
  const b = replayBench(t, home, { agents, gate: false, before(rt) {
    rt.config.selfUpdate = true
    rt.selfUpdateStatus = () => ({ available: true, run: null })
    rt.ctx.provide('profileContext', { dir: profileDir })
    rt.state.tasks[agent.id] = { status: 'working' }
    rt.state.restartResumes = { [agent.id]: daily }
  } })
  const dispose = installHold(b.rt)
  t.after(dispose)
  assert.deepEqual(await b.rt.selfUpdateStart(), { started: false, reason: 'starting-up' })
  assert.deepEqual((await finishBoot(t, b)).resumed, [agent.id])
  await b.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).cut, [])
  assert.deepEqual(messages.map(message => message.source.resumedByUpdate), [true])
  assert.deepEqual(b.rt.state.restartResumes[agent.id], daily)
})

test('adoption keeps disk withdrawals and applies only local held additions and withdrawals', async t => {
  const home = temp(t)
  const withdrawnByOwner = user('withdrawn on disk')
  const withdrawnHere = user('withdrawn here')
  const kept = user('still on disk')
  const arrived = user('new local note')
  seed(home, { held: { chat: [entry(withdrawnByOwner), entry(withdrawnHere), entry(kept)] } })
  const b = replayBench(t, home)
  let owning = false
  b.rt.readOnly = () => owning ? undefined : 'reading'
  b.rt.forgetHeldInput('chat', withdrawnHere.id)
  assert.equal(await b.rt.noteHeldInput('chat', [arrived]), false)
  seed(home, { held: { chat: [entry(withdrawnHere), entry(kept)] } })
  owning = true
  await b.rt.reloadDeliveryNotes(() => {})
  await b.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [kept.id, arrived.id])
})

test('a failed inflight replacement keeps the last notes and reports failed held input once',
  { skip: process.platform === 'win32' }, async t => {
  const home = temp(t)
  const b = replayBench(t, home)
  const saved = user('saved')
  const failed = user('write failed')
  const another = user('write failed again')
  await b.rt.noteHeldInput('chat', [saved])
  const warn = t.mock.method(b.rt, 'warn')
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === join(home, 'inflight.json')) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal(await b.rt.noteHeldInput('chat', [failed]), false)
  assert.equal(await b.rt.noteHeldInput('chat', [another]), false)
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [saved.id])
  assert.equal(warn.mock.calls.filter(call => call.arguments[0].includes('input held')).length, 1)
})

test('a durable inflight replacement syncs the team directory after rename',
  { skip: process.platform === 'win32' }, async t => {
  const home = temp(t)
  const b = replayBench(t, home)
  const rename = fs.renameSync
  const sync = fs.fsyncSync
  const operations = []
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to)
    if (to === join(home, 'inflight.json')) operations.push('rename')
  })
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) operations.push('directory sync')
    sync(fd)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal(await b.rt.noteHeldInput('chat', [user('durable')]), true)
  assert.deepEqual(operations, ['rename', 'directory sync'])

  const failed = t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('directory sync failed')
    sync(fd)
  })
  syncBuiltinESMExports()
  assert.equal(await b.rt.noteHeldInput('chat', [user('directory sync fails')]), false)
  assert.equal(failed.mock.callCount(), 1)
})

test('the Windows inflight write updates the file in place', async t => {
  const home = temp(t)
  const b = replayBench(t, home)
  const old = user('saved locally'), added = user('another held input')
  seed(home, { held: { chat: [entry(old)] } })
  await b.rt.reloadDeliveryNotes(() => {})
  await b.rt.flushUpdateNotes()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  const rename = t.mock.method(fs, 'renameSync', () => assert.fail('Windows must write in place'))
  syncBuiltinESMExports()
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
    assert.equal(await b.rt.noteHeldInput('chat', [added]), true)
  } finally {
    Object.defineProperty(process, 'platform', original)
    rename.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [old.id, added.id])
})

test('a failed Bot continuation stays durable and is delivered once by the next runtime', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const updateRun = liveRun('healthy')
  const record = { botId: 'ada', since: 1, stoppedBy: 'update' }
  seed(home, { turns: { chat: record, 'sender-chat': { ...record, botId: 'sender' } } })
  const messages = []
  let bench
  const agents = new Map(['chat', 'sender-chat'].map(id => [id, {
    session: { id },
    followup(message) {
      messages.push(message)
      emit(bench.ctx, id, 'user/message', message)
    },
  }]))
  bench = replayBench(t, home, { agents, profileDir, updateRun, before(rt) {
    const deliver = rt.deliver
    rt.deliver = async (args, options) => {
      if (args.toId === 'ada') throw new Error('capability setup failed')
      return deliver(args, options)
    }
  } })
  assert.deepEqual((await finishBoot(t, bench)).resumed, ['sender-chat'])
  await bench.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home), { ...empty, turns: { chat: record } })
  const recovery = () => readUpdateRecovery(profileDir, updateRun)
  const items = [
    { kind: 'turn', sessionId: 'chat', name: 'Ada', state: 'failed' },
    { kind: 'turn', sessionId: 'sender-chat', name: 'Sender', state: 'resumed' },
  ]
  assert.deepEqual(recovery(), { runId: updateRun.runId, requestId: updateRun.requestId, complete: true, items })
  await bench.ctx.dispose()

  bench = replayBench(t, home, { agents, profileDir, updateRun })
  assert.deepEqual((await finishBoot(t, bench)).resumed, ['chat'])
  await bench.rt.flushUpdateNotes()
  assert.deepEqual(messages.filter(message => message.source.resumedByUpdate).map(message => message.source.exchangeId),
    ['resume:sender-chat:1', 'resume:chat:1'])
  assert.equal(notesOf(home).turns.chat, undefined)
  assert.deepEqual(recovery(), {
    runId: updateRun.runId, requestId: updateRun.requestId, complete: true,
    items: [{ ...items[0], state: 'resumed' }, items[1]],
  })
})

for (const [label, contents, unconfirmed] of [
  ['valid empty', JSON.stringify(empty), false],
  ['malformed JSON', '{', true],
  ['invalid inventory', '{}', true],
  ['missing', undefined, true],
]) {
  test(`boot reports whether ${label} inflight notes establish an empty recovery inventory`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const home = temp(t)
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    if (contents !== undefined) writeFileSync(join(home, 'inflight.json'), contents)
    const updateRun = liveRun('healthy')
    const b = replayBench(t, home, { profileDir, updateRun, gate: false })
    await finishBoot(t, b)
    const expected = {
      runId: updateRun.runId, requestId: updateRun.requestId, complete: true, items: [],
      ...(unconfirmed ? { inventoryUnconfirmed: true } : {}),
    }
    assert.deepEqual(readUpdateRecovery(profileDir, updateRun), expected)
    await b.rt.flushUpdateNotes()
    await b.ctx.dispose()
    assert.deepEqual(notesOf(home), empty)
    await finishBoot(t, replayBench(t, home, { profileDir, updateRun, gate: false }))
    assert.deepEqual(readUpdateRecovery(profileDir, updateRun), expected)
  })
}

test('a failed hand-back retains a queued continuation and the next runtime sends only the remaining exchange', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const room = { id: 'room', members: ['ada'], sessions: { ada: 'group-chat' } }
  const pending = { info: { role: 'room', roomId: room.id, exchangeId: 'room-call' }, text: 'pending request' }
  seed(home, { turns: { 'group-chat': { botId: 'ada', roomId: room.id, since: 1, stoppedBy: 'update',
    trigger: { joined: [pending] } } } })
  const messages = []
  let first
  const agent = { session: { id: 'group-chat' }, followup(message) {
    messages.push(message)
    emit(first.ctx, 'group-chat', 'user/message', message)
  } }
  const agents = new Map([['group-chat', agent]])
  const setupRoom = rt => {
    rt.groupOwners.set('group-chat', { botId: 'ada', roomId: room.id })
    rt.roomOf = id => id === room.id ? room : undefined
    rt.postToRoom = async () => {}
  }
  first = replayBench(t, home, { agents, before(rt) {
    setupRoom(rt)
    const deliver = rt.deliver
    rt.deliver = async (args, options) => {
      if (args.exchangeId === 'room-call') throw new Error('room agent unavailable')
      return deliver(args, options)
    }
  } })
  assert.deepEqual((await finishBoot(t, first)).resumed, ['group-chat'])
  await first.rt.flushUpdateNotes()
  assert.equal(notesOf(home).turns['group-chat'].continuationQueued, true)
  assert.deepEqual(notesOf(home).queued['group-chat'].map(item => item.args.exchangeId), ['room-call'])
  await first.ctx.dispose()

  const next = replayBench(t, home, { agents, before: setupRoom })
  assert.deepEqual((await finishBoot(t, next)).resumed, [])
  await next.rt.flushUpdateNotes()
  assert.equal(notesOf(home).turns['group-chat'], undefined)
  assert.equal(messages.filter(message => message.source.resumedByUpdate).length, 1)
  assert.deepEqual(next.sent.map(args => args.exchangeId), ['room-call'])
})

test('boot rechecks the same team generation after agent resolution before enqueue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const record = { botId: 'ada', since: 1, stoppedBy: 'update' }
  seed(home, { turns: { chat: record } })
  const resolving = Promise.withResolvers()
  const resolved = Promise.withResolvers()
  let epoch = 1
  const b = replayBench(t, home, { before(rt) {
    rt.teamGeneration = () => epoch
    rt.sameTeam = captured => captured === epoch
    rt.deliver = async (_args, { enqueue }) => {
      resolving.resolve()
      await resolved.promise
      return enqueue({ session: { id: 'chat' }, followup: () => assert.fail('ownership changed') }, user('resume'))
    }
  } })
  const boot = finishBoot(t, b)
  await resolving.promise
  epoch++
  resolved.resolve()
  assert.deepEqual((await boot).resumed, [])
  await b.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).turns.chat, record)
})

test('a writable store with an unusable lock resumes an ordinary cut turn once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  seed(home, { turns: { chat: { botId: 'ada', since: 1 } } })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['ada'], bots: { ada: { id: 'ada', name: 'Ada', role: 'Boss', sessionId: 'chat' } },
  }))
  const lockPath = join(home, 'state.lock')
  const write = fs.writeFileSync
  const lockWrite = t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (path === lockPath) throw Object.assign(new Error('lock unusable'), { code: 'EACCES' })
    return write(path, ...args)
  })
  syncBuiltinESMExports()
  const dsh = durableDsh()
  dsh.add('chat')
  apply(dsh.ctx, { home, diagnosticsFile: false, github: false })
  t.after(() => dsh.ctx.dispose())
  const rt = dsh.ctx.provided.get('omniTeam')
  try {
    await rt.load()
  } finally {
    lockWrite.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(rt.holdsLock(), false)
  assert.equal(rt.canWriteTeam(), true)
  assert.equal(rt.readOnly(), undefined)
  assert.deepEqual((await finishBoot(t, { rt })).resumed, ['chat'])
  assert.equal(dsh.sends.length, 1)
  assert.equal(dsh.sends[0].message.source.resumed, true)
  assert.equal(dsh.sends[0].message.source.resumedByUpdate, undefined)
  await rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).turns, {})
})

test('an ordinary cut note survives a failed enqueue and a generation change', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const failure of ['enqueue', 'generation']) {
    const home = temp(t)
    const record = { botId: 'ada', since: 1 }
    seed(home, { turns: { chat: record } })
    const b = replayBench(t, home, { before(rt) {
      let current = true
      rt.sameTeam = () => current
      rt.deliver = async (_args, { enqueue }) => {
        current = failure !== 'generation'
        if (await enqueue({ session: { id: 'chat' }, followup: () => { throw new Error('inbox unavailable') } }, user('resume'))) {
          return 'queued'
        }
      }
    } })
    assert.deepEqual((await finishBoot(t, b)).resumed, [])
    await b.rt.flushUpdateNotes()
    assert.deepEqual(notesOf(home).turns.chat, record)
  }
})

test('taking over after a read-only boot takes the adopted update notes once and clears starting-up', async t => {
  const home = temp(t)
  const lock = join(home, 'state.lock')
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'writer' }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['ada'], bots: { ada: { id: 'ada', name: 'Ada', role: 'Boss', sessionId: 'chat' } },
  }))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  t.after(supervise(home, profileDir))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dsh = durableDsh()
  dsh.add('chat')
  dsh.ctx.provide('profileContext', { dir: profileDir })
  apply(dsh.ctx, { home, selfUpdate: true, diagnosticsFile: false, github: false })
  t.after(() => dsh.ctx.dispose())
  const rt = dsh.ctx.provided.get('omniTeam')
  rt.selfUpdateStatus = () => ({ available: true, run: null })
  assert.match((await finishBoot(t, { rt })).readOnly, /open in another dsh/)
  assert.equal(rt.selfUpdateStartRefusal(), 'starting-up')
  seed(home, { turns: { chat: { botId: 'ada', since: 1, stoppedBy: 'update' } } })
  rmSync(lock)
  await rt.refresh()
  await rt.resumeDestination('chat')
  await rt.wakeLog.replayed
  await until(() => !rt.resumeBootPending())
  assert.equal(rt.holdsLock(), true)
  assert.equal(rt.selfUpdateStartRefusal(), null)
  assert.equal(dsh.sends.length, 1)
  assert.equal(dsh.sends[0].message.source.resumedByUpdate, true)
  await rt.refresh()
  await rt.wakeLog.replayed
  assert.equal(dsh.sends.length, 1)
  await rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).turns, {})
})

test('a real cut and held wake give the next runtime the original trigger, joined requests, and one deferred result', async t => {
  const home = temp(t)
  const entered = Promise.withResolvers()
  const cancel = Promise.withResolvers()
  t.after(() => cancel.resolve())
  const b = await realLoop(t, home, { supervised: true, turns: true, stream: () => {
    entered.resolve()
    return cancel.promise
  } })
  b.rt.chatOwners.set('chat', 'ada')
  b.rt.chatOwners.set('sender-chat', 'sender')
  const { agent } = await b.create('chat')
  await b.create('sender-chat')
  await waitBoot(b)
  const source = { kind: SOURCE_KIND, role: 'request', senderSessionId: 'sender' }
  agent.inject(user('original Bot request', { ...source, exchangeId: 'original' }))
  agent.inject(user('joined Bot request', { ...source, exchangeId: 'joined' }))
  agent.inject(user('deferred result', { ...source, role: 'reply', exchangeId: 'later', work: 'other' }))
  agent.followup(user('wake original turn'))
  await entered.promise
  const click = b.rt.selfUpdateStart()
  cancel.resolve()
  const answer = await click
  assert.equal(answer.started, true)
  assert.equal(answer.stillRunning, 0)
  const changed = user('unrelated wake')
  agent.followup(changed)
  await until(() => b.events.filter(event => event.id === 'chat' && event.type === 'turn/start').length > 1)
  await b.rt.flushUpdateNotes()
  const sticky = notesOf(home).turns.chat
  assert.equal(sticky.trigger.exchangeId, 'original')
  assert.deepEqual(sticky.trigger.joined.map(item => item.info.exchangeId), ['joined'])
  assert.deepEqual(sticky.later.map(item => item.info.exchangeId), ['later'])
  assert.equal(messagesOf(b, 'chat')().some(msg => msg.id === changed.id), false)
  assert.equal(b.delivered.some(args => args.replyTo === 'original'), false)

  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [changed.id])
  assert.deepEqual(notesOf(home).queued.chat.map(item => item.args.exchangeId), ['later'])
  assert.equal(b.delivered.filter(args => args.exchangeId === 'later').length, 1)
  await stopLoop(b)

  const next = await realLoop(t, home, { logs: logsOf(b), turns: true })
  next.rt.chatOwners.set('chat', 'ada')
  next.rt.chatOwners.set('sender-chat', 'sender')
  const { agent: reopened } = await next.create('chat')
  await next.create('sender-chat')
  const messages = messagesOf(next, 'chat')
  await until(() => messages().some(msg => msg.source.resumedByUpdate)
    && messages().some(msg => msg.source.exchangeId === 'later')).catch(reportLoop(t, next))
  await next.rt.resumesDone
  await reopened.whenIdle()
  await next.rt.flushUpdateNotes()
  assert.equal(messages().filter(msg => msg.id === changed.id).length, 1)
  assert.equal(messages().filter(msg => msg.source.exchangeId === 'later').length, 1)
  const continuation = messages().filter(msg => msg.source.resumedByUpdate)
  assert.equal(continuation.length, 1)
  assert.equal(continuation[0].source.exchangeId, 'original')
  assert.deepEqual(continuation[0].source.joined.map(item => item.info.exchangeId), ['joined'])
  assert.equal(next.delivered.filter(args => args.exchangeId === 'later').length, 1)
  assert.equal(notesOf(home).turns.chat?.stoppedBy, undefined)
})

test('a real held boot and a second disposal after replay claim preserve every input ID until consumed', async t => {
  const home = temp(t)
  const previous = { botId: 'ada', since: 1, stoppedBy: 'update' }
  const old = user('old input'), newer = user('new input during the trial')
  seed(home, { turns: { chat: previous }, held: { chat: [entry(old)] } })
  const trial = await realLoop(t, home, { run: liveRun('health'), supervised: true })
  trial.rt.chatOwners.set('chat', 'ada')
  const { agent } = await trial.create('chat')
  agent.followup(newer)
  await until(() => trial.events.some(event => event.id === 'chat' && event.type === 'turn/start'))
  await trial.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).turns.chat, previous)
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [old.id, newer.id])
  assert.deepEqual(messagesOf(trial, 'chat')(), [])
  await stopLoop(trial)

  const parked = Promise.withResolvers()
  const release = Promise.withResolvers()
  let claim
  t.after(() => release.resolve())
  const replay = await realLoop(t, home, { logs: logsOf(trial) })
  replay.ctx.on('agent/inbox/claimed', ({ message }) => { claim = message.id })
  replay.ctx.on('system-prompt/assemble', async (_value, context, next) => {
    if (context.agent?.id === 'chat' && claim === old.id) {
      parked.resolve()
      await release.promise
    }
    return next()
  })
  await replay.create('chat')
  await until(() => replay.events.some(event => event.type === 'user/message' && event.data.source.resumedByUpdate)).catch(reportLoop(t, replay))
  await parked.promise
  await replay.rt.resumesDone
  await replay.rt.flushUpdateNotes()
  assert.deepEqual(notesOf(home).held.chat.map(item => item.message.id), [old.id, newer.id])
  assert.equal(messagesOf(replay, 'chat')().some(msg => msg.id === old.id), false)
  replay.disposeHold()
  const disposed = replay.ctx.fiber.dispose()
  release.resolve()
  await disposed

  const next = await realLoop(t, home, { logs: logsOf(replay) })
  const { agent: reopened } = await next.create('chat')
  const messages = messagesOf(next, 'chat')
  await until(() => messages().some(msg => msg.id === newer.id))
  await reopened.whenIdle()
  await next.rt.flushUpdateNotes()
  assert.deepEqual(messages().filter(msg => [old.id, newer.id].includes(msg.id)).map(msg => msg.id), [old.id, newer.id])
  assert.equal(messagesOf(replay, 'chat')().filter(msg => msg.source.resumedByUpdate).length, 1)
  assert.equal(messages().filter(msg => msg.source.resumedByUpdate).length, 0)
  assert.deepEqual(notesOf(home).held, {})
})

test('a real DSH subagent settles behind the update hold and its parent reads the durable notice once on boot', async t => {
  const home = temp(t)
  const parentEntered = Promise.withResolvers()
  const childEntered = Promise.withResolvers()
  const allowParent = Promise.withResolvers()
  const allowChild = Promise.withResolvers()
  t.after(() => { allowParent.resolve(); allowChild.resolve() })
  const before = await realLoop(t, home, {
    supervised: true, subagents: true,
    stream(request) {
      const body = JSON.stringify(request.messages)
      if (body.includes('perform the child fixture task')) {
        childEntered.resolve()
        return allowChild.promise
      }
      if (body.includes('keep the parent fixture busy')) {
        parentEntered.resolve()
        return allowParent.promise
      }
    },
  })
  before.rt.chatOwners.set('chat', 'ada')
  const { agent: parent } = await before.create('chat')
  await waitBoot(before)
  parent.followup(user('keep the parent fixture busy'))
  await until(() => before.calls.some(request => JSON.stringify(request.messages)?.includes('keep the parent fixture busy')))
    .catch(reportLoop(t, before))
  await parentEntered.promise
  const child = await before.ctx.subagents.startActivation({
    provider: 'spawn', parent, childId: 'child', label: 'fixture child',
    prompt: [{ type: 'text', text: 'perform the child fixture task' }],
    delivery: 'parent', signal: new AbortController().signal,
  })
  await until(() => before.calls.some(request => JSON.stringify(request.messages)?.includes('perform the child fixture task')))
    .catch(reportLoop(t, before))
  await childEntered.promise
  const click = before.rt.selfUpdateStart()
  allowParent.resolve()
  const started = await click
  assert.equal(started.started, true)
  assert.equal(started.stopped, 1)
  assert.equal(started.stillRunning, 0)
  allowChild.resolve()
  assert.equal((await child.result).stopReason, 'completed')
  await before.rt.flushUpdateNotes()
  const notes = notesOf(home)
  const settlement = notes.held.chat.find(item => item.message.source.kind === 'subagent-settled').message
  assert.equal(settlement.source.senderSessionId, child.childId)
  assert.equal(notes.held[child.childId], undefined)
  assert.ok(!notes.cut.includes(child.childId))
  assert.equal(messagesOf(before, 'chat')().filter(msg => msg.id === settlement.id).length, 0)
  await stopLoop(before)

  const after = await realLoop(t, home, { logs: logsOf(before) })
  const resolve = after.rt.resolveAgent
  after.rt.resolveAgent = id => {
    assert.notEqual(id, child.childId)
    return resolve(id)
  }
  const { agent } = await after.create('chat')
  const messages = messagesOf(after, 'chat')
  await until(() => messages().some(msg => msg.id === settlement.id))
  await agent.whenIdle()
  await after.rt.flushUpdateNotes()
  assert.equal(messages().filter(msg => msg.id === settlement.id).length, 1)
  assert.equal(messages().filter(msg => msg.source.resumedByUpdate).length, 1)
  assert.deepEqual(notesOf(home).held, {})
})

test('cutting a turn opened by a subagent settlement lets the resumed answer reach its original asker', async t => {
  const home = temp(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  let first = true
  const b = await realLoop(t, home, {
    supervised: true, turns: true,
    stream(request) {
      if (first && JSON.stringify(request.messages).includes('fixture child settled')) {
        first = false
        entered.resolve()
        return release.promise
      }
    },
  })
  const asker = { kind: SOURCE_KIND, role: 'request', senderSessionId: 'sender', exchangeId: 'parent-work' }
  const closed = []
  b.rt.subWorkRun = id => id === 'child' ? { id: 'child-work', parent: asker.exchangeId } : undefined
  b.rt.ownsWork = (bot, work) => bot === 'ada' && work === asker.exchangeId
  b.rt.workAsker = () => asker
  b.rt.waitsWork = () => false
  b.rt.answerText = (_work, reply) => reply
  b.rt.closeWork = (work, _name, text) => { closed.push({ work, text }) }
  b.rt.chatOwners.set('chat', 'ada')
  b.rt.chatOwners.set('sender-chat', 'sender')
  const { agent } = await b.create('chat')
  const { agent: sender } = await b.create('sender-chat')
  await waitBoot(b)
  agent.followup(user('fixture child settled', { kind: 'subagent-settled', senderSessionId: 'child' }))
  await entered.promise
  assert.equal(b.rt.live.get('chat').info.work, asker.exchangeId)
  const click = b.rt.selfUpdateStart()
  release.resolve()
  const answer = await click
  assert.equal(answer.started, true)
  assert.equal(notesOf(home).turns.chat.trigger.work, asker.exchangeId)
  assert.deepEqual(closed, [])
  b.verdict('notUpdated', answer.requestId)
  const replies = () => messagesOf(b, 'sender-chat')().filter(message => message.source.replyTo === asker.exchangeId)
  await until(() => replies().length > 0).catch(reportLoop(t, b))
  await sender.whenIdle()
  assert.equal(replies().length, 1)
  assert.equal(replies()[0].content[0].text, 'Done')
  assert.deepEqual(closed, [{ work: asker.exchangeId, text: 'Done' }])
})

test('a restored child picks up sticky work only after the rollback verdict', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = temp(t)
  const resumed = []
  const daily = { count: 2, at: Date.now() }
  const agent = { id: 'chat', session: { id: 'chat' }, followup: message => resumed.push(message) }
  seed(home, { turns: { chat: { since: 1, botId: 'ada', stoppedBy: 'update' } } })
  const b = replayBench(t, home, { gate: 'rollingBack', agents: new Map([['chat', agent]]),
    logs: new Map([['chat', [user('resume this')]]]), before(rt) {
      rt.chatOwners.set('chat', 'ada')
      rt.state.restartResumes = { chat: daily }
    } })
  t.mock.timers.tick(61_000)
  await immediate()
  assert.deepEqual(resumed, [])
  assert.deepEqual((await finishBoot(t, b, 'rolledBack')).resumed, ['chat'])
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0].source.resumedByUpdate, true)
  assert.deepEqual(b.rt.state.restartResumes.chat, daily)
})
