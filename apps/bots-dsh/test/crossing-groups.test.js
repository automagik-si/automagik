// RFC 0030, Handoff note (the owner, 2026-11-23; the lead's Q7b ruling, #2061 D1.5): a Bot's
// group conversations follow its agent switch, each with a fenced switch and a handoff of its
// own. An idle one at once, a busy one at its next step (never by stopping a group reply); the
// summary is the outgoing agent's or none (MX-8); a member's note turn reaches the group
// neither while it runs nor at its end, and counts in no round (MX-12); a failed follow leaves
// the Session on its route, never in place, and tries once more at its next step.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { install } from '../src/host/parts.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installModelState } from '../src/host/model-state.js'
import { install as installOwnTools } from '../src/host/own-tools.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { textOf } from '../src/host/text.js'
import { CROSSING_DEADLINE_MS } from '../src/shared/routes.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const NOTE = [
  '## Goals', '- carry on', '## Constraints and preferences', '- none', '## Progress', '- Done: none',
  '## Decisions', '- none', '## Facts to keep', '- none', '## Open threads', '- none',
  '## Next step', '- none', '## Where to look', '- none',
].join('\n')
const IN_CHAT_NOTE = NOTE.replace('- carry on', '- carry on, from the member agent itself')

const waitFor = async (check, timeout = 3000) => {
  const at = Date.now()
  while (!check()) {
    if (Date.now() - at > timeout) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

let ids = 0
const message = (kind, text, source = {}) => ({ id: `m${++ids}`, role: 'user', source: { kind, ...source }, content: [{ type: 'text', text }] })

function inboxOf() {
  const inbox = {
    nextStep: [], nextTurn: [], unshift() {},
    remove(id) { for (const list of [inbox.nextStep, inbox.nextTurn]) { const at = list.findIndex(item => item.id === id); if (at >= 0) list.splice(at, 1) } },
    prepend(target, item) { (target === 'next-step' ? inbox.nextStep : inbox.nextTurn).unshift(item) },
    append(target, item) { (target === 'next-step' ? inbox.nextStep : inbox.nextTurn).push(item) },
  }
  return inbox
}

const ROOM_CALL = { kind: SOURCE_KIND, form: 'relay', role: 'room', exchangeId: 'e-room', senderName: 'Omni' }

// One Bot ("Ops") on `model`, its own chat `s1` (with an exchange unless `ownEmpty`), and its
// conversation `g1` in the group "Ops room" on `groupRoute`, with a round in it. Fresh parts
// are `s2`, `s3`, … with agents that keep what they are given. `turns`: turns.js runs too.
function bench({ model = 'deepseek/v4', groupRoute = 'deepseek/v4', ownEmpty = false, turns = false } = {}) {
  const calls = { notes: [], created: [], selected: [], archived: [], sends: [], cancels: [], diagnostics: [], warnings: [], roomLines: [], delivered: [], steps: [], replies: [], touches: 0, works: 0, background: 0 }
  const [provider, ...rest] = model.split('/')
  const messages = ownEmpty ? [] : [
    message('user', 'ship it', { exchangeId: 'e-first' }),
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
  ]
  const logOf = new Map([
    ['s1', ownEmpty ? [] : [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'ship it' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'on it' }] } } },
    ]],
    ['g1', [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '[Group chat] what ships friday?' }], source: ROOM_CALL } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'the release ships friday' }] } } },
    ]],
  ])
  const session = {
    id: 's1',
    requestHeader: () => ({ config: { provider, model: rest.join('/'), maxTokens: 1000 } }),
    deriveMessages: () => messages,
    toolHistory: () => [],
    header: {},
  }
  const [gProvider, ...gRest] = groupRoute.split('/')
  const groupMessages = [message(SOURCE_KIND, '[Group chat] what ships friday?', ROOM_CALL), { role: 'assistant', content: [{ type: 'text', text: 'the release ships friday' }] }]
  const gSession = {
    id: 'g1',
    requestHeader: () => ({ config: { provider: gProvider, model: gRest.join('/'), maxTokens: 1000 } }),
    deriveMessages: () => groupMessages,
    toolHistory: () => [],
    header: {},
  }
  const agents = new Map()
  const makeAgent = (id, ownSession) => {
    const agent = {
      id, session: ownSession, status: 'idle', inbox: inboxOf(),
      whenIdle: async () => {},
      runMaintenance: async job => job(new AbortController().signal),
      followup(item) { agent.inbox.nextTurn.push(item) },
      inject(item) { agent.inbox.nextStep.push(item) },
      send(item, where, wake) { calls.sends.push({ id, item, wake }); (where === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn).push(item) },
      cancel(reason, options) { calls.cancels.push({ id, reason, options }) },
    }
    agents.set(id, agent)
    return agent
  }
  const agent = makeAgent('s1', session)
  const group = makeAgent('g1', gSession)
  const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1000 }) } } })
  ctx.sessions = { list: () => [session, gSession], flush: async () => {}, get: id => agents.get(id)?.session }
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }),
    stream: (options) => {
      calls.notes.push(options)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: NOTE }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  ctx.workspaceRegistry = { archiveSession: async (id) => { calls.archived.push(id) } }
  const bot = { id: 'b1', name: 'Ops', createdAt: 1, sessionId: 's1', model, appliedModel: model }
  const room = { id: 'r1', name: 'Ops room', members: ['b1'], sessions: { b1: 'g1' }, segments: {} }
  const ownerOf = id => (room.sessions.b1 === id ? { botId: 'b1', roomId: 'r1' } : undefined)
  let fresh = 1
  const rows = ['deepseek/v4', 'acp-claude/default', 'acp-codex/default', 'acp-antigravity/default', 'hermes-remote/attach', 'acp-hermes/default']
    .map(ref => ({ ref, provider: ref.split('/')[0], ...(ref === 'acp-claude/default' ? { providerName: 'Claude Code' } : {}), ...(ref === 'deepseek/v4' ? { name: 'DeepSeek V4' } : {}) }))
  const rt = {
    ctx, config: {}, state: { switching: {}, bots: { b1: bot }, rooms: { r1: room }, questions: {}, views: {}, exchangeTurns: {} },
    botOf: id => rt.state.bots[id],
    roomOf: id => (id === 'r1' ? room : undefined),
    chatOf: id => rt.state.bots[id]?.sessionId,
    groupSessionsOf: botId => (room.sessions[botId] === undefined ? [] : [room.sessions[botId]]),
    selfOf: id => (id.startsWith('s') || ownerOf(id) !== undefined ? 'b1' : undefined),
    chatOwners: { get: id => (rt.state.bots.b1?.sessionId === id ? 'b1' : undefined), has: id => rt.state.bots.b1?.sessionId === id },
    groupOwners: { get: ownerOf, has: id => ownerOf(id) !== undefined },
    roomOwners: new Map(), pastOwners: new Map(),
    live: new Map(),
    liveOf: id => rt.live.get(id) ?? rt.live.set(id, {}).get(id),
    isBotSession: id => id.startsWith('s') || ownerOf(id) !== undefined,
    readOnly: () => undefined,
    load: async () => {},
    save: async () => {},
    warn: (...args) => { calls.warnings.push(args.map(String).join(' ')) },
    noteFailure: entry => { calls.diagnostics.push(entry.text) },
    renewMemory() {},
    resolveAgent: async id => agents.get(id),
    tagUsage: items => items,
    ownRequest: () => false,
    teamFolder: () => '/team',
    isFolder: async () => false,
    workDirOf: () => undefined,
    desiredModel: async () => bot.model,
    desiredEffort: async () => bot.effort,
    resolveEffort: async (ref, effort) => effort,
    selectSessionModel: async (id, selection) => { calls.selected.push([id, `${selection.provider}/${selection.model}`]) },
    applyPermission: async () => {},
    applyToolDeny: async () => {},
    ensureCapabilities: async () => {},
    moveSchedules: async () => {},
    eventsBackwards: async function* (id) { yield* [...(logOf.get(id) ?? [])].reverse() },
    cachedCatalog: () => rows,
    catalog: async () => rows,
    resolveModel: async ref => ref,
    answersAside: ref => !String(ref).startsWith('acp-') && !String(ref).startsWith('hermes-remote'),
    backgroundModel: async () => { calls.background += 1; return 'deepseek/v4' },
    clearAuto: async () => {},
    modelAccess: async () => ({ ready: true }),
    applyModel: async () => {},
    logRoom: (target, line) => { calls.roomLines.push({ room: target.id, ...line }) },
    deliver: async (job) => { calls.delivered.push(job) },
    userWrote() {},
    roomStepText: async (id, info, text) => { calls.steps.push([id, text]) },
    lateRoomReply: async (id, info, text) => { calls.replies.push([id, text]) },
    lateRoomFailure: async (id) => { calls.replies.push([id, 'failure']) },
    touchRoomTurn: () => { calls.touches += 1 },
    workRoomTurn: () => { calls.works += 1 },
    takeRoomSteps: () => '',
    withRoomSteps: (lines, reply) => reply,
    createSession: async () => {
      const id = `s${++fresh}`
      calls.created.push(id)
      makeAgent(id, { ...session, id, requestHeader: () => undefined, deriveMessages: () => [] })
      return id
    },
  }
  install(rt)
  installOwnTools(rt)
  installModelState(rt)
  if (turns) installTurns(rt)
  ctx.emit('agent/created', { agent })
  ctx.emit('agent/created', { agent: group })
  const listener = name => ctx.listeners.get(name)[0]
  const sessionEvent = (id, event) => { for (const each of ctx.listeners.get('session/event') ?? []) each(agents.get(id)?.session ?? { id }, event) }
  const preStep = (id, payload) => {
    let passed = false
    const result = listener('agent/pre-step')({ agent: agents.get(id), step: 1, signal: new AbortController().signal, ...payload }, () => { passed = true; return { kind: 'enter', messages: payload.messages } })
    return Promise.resolve(result).then(decision => ({ decision, passed }))
  }
  const handoffOf = id => [...agents.get(id).inbox.nextStep, ...agents.get(id).inbox.nextTurn].find(item => item.source?.handoff === true)
  const jobs = () => [...rt.switchJobs()]
  const followed = id => waitFor(() => room.sessions.b1 === id && jobs().length === 0)
  const settled = () => waitFor(() => jobs().length === 0)
  return { rt, ctx, agent, group, bot, room, calls, session, gSession, groupMessages, messages, logOf, agents, handoffOf, sessionEvent, preStep, listener, jobs, followed, settled }
}

// rt.warn's arguments, joined: the template, then its values.
const keptLine = line => /keeps its route in group Session %s: its switch to %s did not finish/.test(line) && line.includes(' g1 ')
const selectedOn = (b, id) => b.calls.selected.filter(([sessionId]) => sessionId === id)

// G1: an idle populated group Session follows the own chat's switch with its own job, a fresh
// group part and a handoff of the group variant (latest lines only), on the new agent.
test('G1 an idle group conversation follows the own chat\'s switch with its own handoff and part', async t => {
  const b = bench()
  t.after(() => b.ctx.dispose())
  // The group's marker, as a restart reads it: the route it goes back to, never the Bot's fields.
  const markers = []
  const save = b.rt.save
  b.rt.save = async () => { if (b.rt.state.switching.g1 !== undefined) markers.push(structuredClone(b.rt.state.switching.g1)); return save() }
  await b.rt.switchRoute('b1', 'acp-claude/default')
  await b.followed('s3')
  assert.deepEqual(markers[0], { botId: 'b1', roomId: 'r1', target: 'acp-claude/default', group: true, from: 'deepseek/v4' })
  assert.equal(b.rt.state.switching.g1, undefined)
  // The own chat moved first; the group's part is a second fresh part, on the new agent.
  assert.deepEqual({ sessionId: b.bot.sessionId, model: b.bot.model, appliedModel: b.bot.appliedModel }, { sessionId: 's2', model: 'acp-claude/default', appliedModel: 'acp-claude/default' })
  assert.deepEqual(b.calls.selected, [['s2', 'acp-claude/default'], ['s3', 'acp-claude/default']])
  // Never in place: nothing is ever selected on the group's old part.
  assert.deepEqual(selectedOn(b, 'g1'), [])
  assert.deepEqual(b.room.segments.b1.map(segment => [segment.sessionId, segment.switchedTo, segment.archivePending, segment.note === NOTE]), [['g1', 'acp-claude/default', true, true]])
  assert.equal(b.bot.segments.length, 1)
  const text = textOf(b.handoffOf('s3').content)
  assert.match(text, /^\[Handoff · part 2\]/)
  assert.match(text, /Omni moved your conversation in the group chat "Ops room" on to a fresh conversation, part 2, because the user switched you from DeepSeek V4 to Claude Code; in this group you are Claude Code now\./)
  assert.match(text, /read_group_chat shows the group's latest messages/)
  // The group variant carries the latest lines only, with no list of earlier messages.
  assert.doesNotMatch(text, /## Messages to you in part/)
  assert.match(text, /## Latest messages \(oldest first\)\n\[[^\]]+\] Omni: \[Group chat\] what ships friday\?|## Latest messages \(oldest first\)\n\[[^\]]+\] .*what ships friday\?/)
  assert.match(text, /Every message above has had its answer\./)
  // MX-8: the summary is the outgoing agent's own, on the group Session's own route.
  assert.equal(b.calls.background, 0)
  assert.deepEqual(b.calls.notes.map(options => `${options.provider}/${options.model}`), ['deepseek/v4', 'deepseek/v4'])
  // Its first answer settles it: the old group part stays until then.
  assert.equal(b.rt.awaitingFirstAnswer('s3'), true)
  assert.equal(b.calls.archived.includes('g1'), false)
  // The fresh group part starts at the commit (one waking send, its handoff).
  assert.deepEqual(b.calls.sends.filter(send => send.id === 's3').map(send => [send.item.source.handoff, send.wake]), [[true, true]])
  // The Bot's own model line has no failure, and the own chat's lock is not the group's.
  assert.equal((await b.rt.modelStateOf('b1')).lastFailure, undefined)
  assert.equal(b.rt.switchingChat('b1', { crossing: true }), false)
})

// G2: a busy group Session is never cancelled: it switches at its next step through
// switchBeforeStep, carrying that step's messages, and the turn goes on on the new agent.
test('G2 a busy group conversation switches at its next step, its messages carried, never cancelled', async t => {
  const b = bench({ model: 'acp-claude/default' })
  t.after(() => b.ctx.dispose())
  b.group.status = 'running'
  b.rt.live.set('g1', { turn: 5, info: ROOM_CALL, joined: [] })
  await b.rt.followGroups(b.bot)
  assert.deepEqual(b.jobs(), [])
  assert.deepEqual(b.calls.cancels, [])
  const idle = Promise.withResolvers()
  b.group.whenIdle = () => idle.promise
  const before = Date.now()
  const post = message(SOURCE_KIND, '[Group post] the build is green', { role: 'post', exchangeId: 'e-mid' })
  const { decision, passed } = await b.preStep('g1', { messages: [post], step: 2 })
  assert.equal(passed, false)
  assert.deepEqual(decision, { kind: 'reject' })
  const [job] = b.jobs()
  assert.deepEqual({ group: job.crossing.group, from: job.crossing.from, target: job.target, resume: job.resume, info: job.info.exchangeId }, { group: true, from: 'deepseek/v4', target: 'acp-claude/default', resume: true, info: 'e-room' })
  // Its 120 s deadline starts when its job starts, not at the Bot's pick.
  assert.ok(job.since >= before)
  assert.equal(job.deadline, job.since + CROSSING_DEADLINE_MS)
  b.group.status = 'idle'
  b.rt.live.delete('g1')
  idle.resolve()
  await b.followed('s2')
  const handoff = b.handoffOf('s2')
  assert.deepEqual({ resume: handoff.source.resume, role: handoff.source.role, exchangeId: handoff.source.exchangeId }, { resume: true, role: 'room', exchangeId: 'e-room' })
  assert.match(textOf(handoff.content), /You were in the middle of your turn in the group\. Go on with it now and write your reply to the group\.$/)
  const queued = [...b.agents.get('s2').inbox.nextStep, ...b.agents.get('s2').inbox.nextTurn]
  assert.deepEqual(queued.map(item => item.source.exchangeId), ['e-room', 'e-mid'])
  assert.deepEqual(b.calls.cancels, [])
  assert.deepEqual(selectedOn(b, 'g1'), [])
})

// G3 (MX-12): an ACP member's note turn is hidden, posts nothing to the group while it runs
// (a mid-turn assistant message with a tool call) or at its end, touches no round, and the
// group's activity row shows the move, not the note turn's work. The note is the member
// agent's own; never the background model.
test('G3 an ACP member\'s note turn never reaches the group and counts in no round', async t => {
  const b = bench({ model: 'deepseek/v4', groupRoute: 'acp-codex/default', turns: true })
  t.after(() => b.ctx.dispose())
  let request
  b.group.send = (item, where, wake) => {
    b.calls.sends.push({ id: 'g1', item, wake })
    request = item
  }
  await b.rt.followGroups(b.bot)
  await waitFor(() => request !== undefined)
  assert.equal(request.source.role, 'handoff-note')
  assert.equal(Object.hasOwn(request.source, 'handoff'), false)
  assert.match(textOf(request.content), /This chat is switching to DeepSeek V4/)
  // Before the turn reads its request, its events touch no round either.
  b.sessionEvent('g1', { type: 'turn/start', data: { turn: 7 } })
  b.sessionEvent('g1', { type: 'user/message', data: { content: request.content, source: request.source } })
  b.sessionEvent('g1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Let me look first.' }, { type: 'tool-call', id: 'k1', name: 'read_file' }] } } })
  b.sessionEvent('g1', { type: 'tool/call', data: { callId: 'k1', name: 'read_file', arguments: '{"path":"notes.md"}' } })
  assert.deepEqual(b.rt.roomWorkView().r1?.map(item => [item.botId, item.switching, item.tool]), [['b1', true, undefined]])
  b.sessionEvent('g1', { type: 'tool/result', data: { callId: 'k1' } })
  b.sessionEvent('g1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: IN_CHAT_NOTE }] } } })
  b.groupMessages.push(request, { role: 'assistant', content: [{ type: 'text', text: IN_CHAT_NOTE }] })
  b.sessionEvent('g1', { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  await b.followed('s2')
  assert.deepEqual(b.calls.steps, [])
  assert.deepEqual(b.calls.replies, [])
  assert.equal(b.calls.touches, 0)
  assert.equal(b.calls.works, 0)
  assert.deepEqual(b.calls.delivered, [])
  assert.deepEqual(b.rt.state.exchangeTurns.g1, [7])
  // MX-8: the member agent wrote the summary itself.
  assert.equal(b.calls.background, 0)
  assert.deepEqual(b.calls.notes, [])
  assert.match(textOf(b.handoffOf('s2').content), /carry on, from the member agent itself/)
  assert.match(textOf(b.handoffOf('s2').content), /the user switched you from Codex to DeepSeek V4; in this group you are DeepSeek V4 now/)
  // A later turn of a group Session is a round's again.
  b.sessionEvent('s2', { type: 'turn/start', data: { turn: 1 } })
  assert.equal(b.calls.touches, 1)
})

// MX-8: a member agent that writes no note in time gives no summary: never a background
// note, and never the earlier part's note.
test('G3 MX-8 a member agent with no note in time gives no summary, never a background one', async t => {
  const b = bench({ model: 'deepseek/v4', groupRoute: 'acp-codex/default' })
  t.after(() => b.ctx.dispose())
  b.rt.config.crossingNoteTimeoutMs = 20
  b.room.segments.b1 = [{ sessionId: 'g0', endedAt: 1, note: 'an earlier background note' }]
  await b.rt.followGroups(b.bot)
  await b.followed('s2')
  const text = textOf(b.handoffOf('s2').content)
  assert.match(text, /\(No note, on purpose: the agent of the previous part wrote no summary in time for the switch\./)
  assert.doesNotMatch(text, /an earlier background note/)
  assert.equal(b.calls.background, 0)
  assert.deepEqual(b.calls.notes, [])
})

// G4: the group shows "{name} switched to {agent}" once, from the group's own line; members
// never read it.
test('G4 the group gets one "switched" line naming the Bot and its new agent', async t => {
  const b = bench()
  t.after(() => b.ctx.dispose())
  await b.rt.switchRoute('b1', 'acp-claude/default')
  await b.followed('s3')
  const lines = b.calls.roomLines.filter(line => line.kind === 'switched')
  assert.deepEqual(lines.map(({ room, who, about, to, agent, time }) => ({ room, who, about, to, agent, at: time === b.room.segments.b1[0].endedAt })),
    [{ room: 'r1', who: 'Omni', about: 'b1', to: 'acp-claude/default', agent: 'Claude Code', at: true }])
  assert.equal(b.calls.roomLines.length, 1)
})

// The group's book: the line is a row the group chat draws, and no member reads it.
test('G4 the group chat draws the switched row; the members\' transcript leaves it out', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-crossing-groups-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'],
    bots: { a: { id: 'a', name: 'Omni', sessionId: 'a', createdAt: 1 }, b: { id: 'b', name: 'Writer', sessionId: 'b', createdAt: 2 } },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, inbox: { nextStep: [], nextTurn: [] } } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  t.after(() => ctx.dispose())
  await rt.load()
  const room = rt.roomOf('r1')
  rt.logRoom(room, { botId: 'a', text: 'before' })
  rt.logRoom(room, { who: 'Omni', kind: 'switched', about: 'b', to: 'acp-claude/default', agent: 'Claude Code', time: 5 })
  const rows = rt.groupRows('r1', 1)
  assert.deepEqual(rows.filter(row => row.kind === 'switched').map(({ kind, botId, name, agent, time }) => ({ kind, botId, name, agent, time })),
    [{ kind: 'switched', botId: 'b', name: 'Writer', agent: 'Claude Code', time: 5 }])
  assert.deepEqual((await rt.groupLinesAfter('r1', 0)).map(line => line.kind ?? 'message'), ['message'])
  assert.deepEqual(room.log.map(line => line.kind ?? 'message'), ['message'])
})

// The client: the round's row draws the existing event line with the Bot's name and agent.
test('G4 the group round draws "{name} switched to {agent}" as an event line', async () => {
  const { outputFiles } = await build({
    stdin: { contents: "export { ToolCell } from './src/client/cells.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const react = {
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value, useCallback: fn => fn, createElement: h, Fragment: Symbol('Fragment'),
    useEffect: () => {}, useLayoutEffect: () => {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (subscribe, get) => get(),
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, document: { hidden: false }, TextEncoder, Blob, navigator: {},
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => ({}), clearTimeout: () => {},
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text, writeClipboard: async () => true }
      throw new Error(`Unexpected platform module ${name}`)
    },
  })
  const expand = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
  const findAll = (node, match, found = []) => {
    if (Array.isArray(node)) node.forEach(child => findAll(child, match, found))
    else if (node && typeof node === 'object') {
      if (match(node)) found.push(node)
      findAll(node.props?.children, match, found)
    }
    return found
  }
  const writer = { id: 'writer', name: 'Writer', color: 'blue' }
  const room = { id: 'room', name: 'Ops', members: ['writer'], admin: 'writer' }
  const roster = { bots: [writer], byId: { writer }, rooms: [room], roomsById: { room }, exchangeTurns: {}, questions: {}, secretRequests: {}, secrets: [] }
  const replies = [{ kind: 'switched', botId: 'writer', name: 'Writer', agent: 'Claude Code', time: 5 }]
  const root = { kind: 'tool-result', name: 'group_relay', callId: 'direct', call: { name: 'group_relay', argsRaw: '{}' }, content: [{ type: 'text', text: JSON.stringify({ replies }) }], isError: false, subCalls: [] }
  const out = expand(module.exports.ToolCell({
    node: { key: 'node', data: { root }, location: { turn: { turn: 1 } } }, sessionId: 'room',
    useRoster: select => select(roster), useUi: select => select({ reactions: {}, visits: {} }), actions: {}, useHeldCards: select => select({}),
  }))
  assert.deepEqual(findAll(out, node => node.props?.className === 'bt-event').map(text), ['Writer switched to Claude Code'])
})

// G5: a follow that does not move leaves the Session on its route (never in place, nothing on
// the Bot's model line, one warn line), tries once more at its next step, and after a second
// failure waits for the Bot's next pick.
test('G5 a failed follow stays on its route, retries once at its next step, then waits for a pick', async t => {
  const b = bench({ model: 'acp-claude/default' })
  t.after(() => b.ctx.dispose())
  let refuse = 2
  const select = b.rt.selectSessionModel
  b.rt.selectSessionModel = async (id, selection) => {
    if (id !== 'g1' && refuse > 0) {
      refuse -= 1
      throw new Error('not signed in')
    }
    return select(id, selection)
  }
  await b.rt.followGroups(b.bot)
  await b.settled()
  assert.equal(b.room.sessions.b1, 'g1')
  assert.deepEqual(selectedOn(b, 'g1'), [])
  assert.deepEqual({ model: b.bot.model, appliedModel: b.bot.appliedModel, sessionId: b.bot.sessionId }, { model: 'acp-claude/default', appliedModel: 'acp-claude/default', sessionId: 's1' })
  assert.equal((await b.rt.modelStateOf('b1')).lastFailure, undefined)
  assert.equal(b.calls.warnings.filter(keptLine).length, 1)
  // Its next step tries once more, and fails again.
  const first = message(SOURCE_KIND, '[Group chat] next?', { role: 'room', exchangeId: 'e-next' })
  const retry = await b.preStep('g1', { messages: [first] })
  assert.equal(retry.passed, false)
  await b.settled()
  assert.equal(b.room.sessions.b1, 'g1')
  assert.equal(b.calls.warnings.filter(keptLine).length, 2)
  // The step's message waits in the old part again, once.
  assert.equal([...b.group.inbox.nextStep, ...b.group.inbox.nextTurn].filter(item => item.source?.exchangeId === 'e-next').length, 1)
  // A second failure waits for the Bot's next pick: the next step runs as it is.
  const later = await b.preStep('g1', { messages: [message(SOURCE_KIND, '[Group chat] and now?', { role: 'room', exchangeId: 'e-later' })] })
  assert.equal(later.passed, true)
  assert.deepEqual(b.jobs(), [])
  // The Bot's next pick tries again, and this time it moves.
  await b.rt.followGroups(b.bot)
  await b.followed('s4')
  assert.deepEqual(b.calls.created, ['s2', 's3', 's4'])
  assert.deepEqual(selectedOn(b, 'g1'), [])
})

// G5: a fresh group part whose first call fails goes back to the group's old part, never
// touching the Bot's fields or model line, and tries once more at the Session's next step.
test('G5 a fresh group part whose first call fails goes back; the Bot is untouched; the next step retries', async t => {
  const b = bench({ model: 'acp-claude/default' })
  t.after(() => b.ctx.dispose())
  await b.rt.followGroups(b.bot)
  await b.followed('s2')
  const before = JSON.stringify(b.bot)
  b.sessionEvent('s2', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'MODEL_ACCESS_REQUIRED', message: 'Sign in' } } } })
  await waitFor(() => b.calls.archived.includes('s2'))
  assert.equal(b.room.sessions.b1, 'g1')
  assert.deepEqual(b.room.segments.b1, [])
  assert.equal(JSON.stringify(b.bot), before)
  assert.equal((await b.rt.modelStateOf('b1')).lastFailure, undefined)
  assert.deepEqual(selectedOn(b, 'g1'), [])
  const step = await b.preStep('g1', { messages: [message(SOURCE_KIND, '[Group chat] again?', { role: 'room', exchangeId: 'e-again' })] })
  assert.equal(step.passed, false)
  await b.followed('s3')
  assert.equal(textOf(b.agents.get('s3').inbox.nextTurn.find(item => item.source?.exchangeId === 'e-again').content), '[Group chat] again?')
})

// G5: a busy group's follow whose fresh part fails its first (resumed) turn goes back, and the
// stopped turn goes on in the old group part: the round's waiter hears no failure from the
// failed turn and is left to the resumed one.
test('G5 a resumed group turn whose fresh part fails goes on in the old part; the round hears no failure', async t => {
  const b = bench({ model: 'acp-claude/default', turns: true })
  t.after(() => b.ctx.dispose())
  const waiter = { failed: [], resolved: [] }
  b.rt.roomWaiters.set('e-room', { sessionId: 'g1', botId: 'b1', roomId: 'r1', fail: failure => waiter.failed.push(failure), resolve: reply => waiter.resolved.push(reply), touch() {}, work() {} })
  b.group.status = 'running'
  b.sessionEvent('g1', { type: 'turn/start', data: { turn: 5 } })
  b.sessionEvent('g1', { type: 'user/message', data: { content: [{ type: 'text', text: '[Group chat] what ships friday?' }], source: ROOM_CALL } })
  await b.rt.followGroups(b.bot)
  const { passed } = await b.preStep('g1', { messages: [], step: 2 })
  assert.equal(passed, false)
  b.group.status = 'idle'
  b.sessionEvent('g1', { type: 'turn/end', data: { turn: 5, reason: { kind: 'blocked' } } })
  await b.followed('s2')
  assert.equal(b.handoffOf('s2').source.resume, true)
  assert.deepEqual(waiter, { failed: [], resolved: [] })
  b.sessionEvent('s2', { type: 'turn/start', data: { turn: 1 } })
  b.sessionEvent('s2', { type: 'user/message', data: { content: b.handoffOf('s2').content, source: b.handoffOf('s2').source } })
  b.sessionEvent('s2', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'MODEL_ACCESS_REQUIRED', message: 'Sign in' } } } })
  await waitFor(() => b.calls.archived.includes('s2'))
  assert.equal(b.room.sessions.b1, 'g1')
  assert.deepEqual(waiter, { failed: [], resolved: [] })
  assert.deepEqual(b.calls.replies, [])
  assert.equal(b.rt.roomWaiters.has('e-room'), true)
  // The stopped turn goes on in the old group part, once, on its own source.
  const resumed = b.calls.sends.filter(send => send.id === 'g1' && send.item.source?.exchangeId === 'e-room')
  assert.deepEqual(resumed.map(send => [send.item.source.role, send.wake]), [['room', true]])
  assert.match(textOf(resumed[0].item.content), /Go on with it now from where you stopped\./)
})

// G6: a group Session left behind under D1 (its history on another harness than the Bot's
// model) follows at the Bot's next pick, from wherever it is; so does one an own chat's change
// in place (nothing said there) leaves on its route. Hermes never follows.
test('G6 a Session left behind follows the next pick; a change in place makes groups follow too', async t => {
  {
    const b = bench({ model: 'acp-claude/default', groupRoute: 'deepseek/v4' })
    t.after(() => b.ctx.dispose())
    b.rt.config.crossingNoteTimeoutMs = 20
    await b.rt.switchRoute('b1', 'acp-codex/default')
    await b.followed('s3')
    assert.deepEqual(selectedOn(b, 's3'), [['s3', 'acp-codex/default']])
    assert.match(textOf(b.handoffOf('s3').content), /from DeepSeek V4 to Codex; in this group you are Codex now/)
  }
  {
    const b = bench({ model: 'deepseek/v4', groupRoute: 'deepseek/v4', ownEmpty: true })
    t.after(() => b.ctx.dispose())
    const result = await b.rt.switchRoute('b1', 'acp-claude/default')
    assert.equal(result.status, 'switched')
    await b.followed('s2')
    assert.equal(b.bot.sessionId, 's1')
    assert.deepEqual(selectedOn(b, 's2'), [['s2', 'acp-claude/default']])
    assert.deepEqual(selectedOn(b, 'g1'), [])
  }
  for (const [model, groupRoute] of [['hermes-remote/attach', 'deepseek/v4'], ['deepseek/v4', 'hermes-remote/attach']]) {
    const b = bench({ model, groupRoute })
    t.after(() => b.ctx.dispose())
    await b.rt.followGroups(b.bot)
    await tick()
    assert.deepEqual(b.jobs(), [], `${model} ${groupRoute}`)
    assert.equal(b.room.sessions.b1, 'g1')
    assert.deepEqual(b.calls.created, [])
  }
})

// MG-7: a group follow onto an agent over ACP gets the capped package too (the newest lines and
// the closing line stay); the same follow onto a native model is whole.
const longGroupLog = (b) => {
  const events = []
  for (let n = 0; n < 60; n += 1) {
    events.push({ type: 'user/message', seq: 2 * n + 1, time: n, data: { content: [{ type: 'text', text: `[Group chat] round ${n} ${'x'.repeat(2990)}` }], source: ROOM_CALL } })
    events.push({ type: 'assistant/message', seq: 2 * n + 2, time: n, data: { message: { content: [{ type: 'text', text: `answer ${n}` }] } } })
  }
  b.logOf.set('g1', events)
  b.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 4_000_000 }, defaultMaxTokens: 1000 })
  b.bot.contextRecentTokens = 200_000
}
test('G7 MG-7 a group follow to an ACP agent is capped under the replay clip; to a native model whole', async t => {
  {
    const b = bench({ model: 'acp-claude/default' })
    t.after(() => b.ctx.dispose())
    longGroupLog(b)
    await b.rt.followGroups(b.bot)
    await b.followed('s2')
    const text = textOf(b.handoffOf('s2').content)
    assert.ok(text.length <= 58_000, String(text.length))
    assert.ok(text.endsWith('Every message above has had its answer. Nothing needs an answer now; wait for the next message.'))
    assert.match(text, /round 59 /)
    assert.doesNotMatch(text, /round 0 /)
  }
  {
    const b = bench({ model: 'deepseek/v4', groupRoute: 'acp-codex/default' })
    t.after(() => b.ctx.dispose())
    b.rt.config.crossingNoteTimeoutMs = 20
    longGroupLog(b)
    await b.rt.followGroups(b.bot)
    await b.followed('s2')
    assert.ok(textOf(b.handoffOf('s2').content).length > 60_000)
  }
})

// MG-8: after a restart, a fresh group part that cannot start is tried at most 3 times, then
// the group goes back to its old part: the Bot's fields and model line are not touched.
test('G8 MG-8 a group part a restart cannot start goes back after three tries, the Bot untouched', async t => {
  const b = bench({ model: 'acp-claude/default' })
  t.after(() => b.ctx.dispose())
  let term = 1
  b.rt.lockTerm = () => term
  b.rt.config.now = () => Date.now() - 1000
  b.rt.config.wakeRetryWindowMs = 600_000
  const freshId = await b.rt.createSession()
  const fresh = b.agents.get(freshId)
  fresh.inbox.nextTurn.push(message(SOURCE_KIND, '[Handoff · part 2] …', { handoff: true, exchangeId: 'e-bare' }))
  b.room.sessions.b1 = freshId
  b.room.segments.b1 = [{ sessionId: 'g1', switchedTo: 'acp-claude/default', archivePending: true }]
  b.rt.state.switching.g1 = { botId: 'b1', roomId: 'r1', target: 'acp-claude/default', group: true, from: 'deepseek/v4' }
  const failed = []
  fresh.send = (item, where, wake) => {
    failed.push({ item, wake })
    throw new Error('the driver could not start')
  }
  const before = JSON.stringify(b.bot)
  for (const tries of [1, 2]) {
    await b.rt.heldBack()
    assert.equal(b.rt.state.switching.g1.wakeTries, tries)
    assert.equal(b.room.sessions.b1, freshId)
    term += 1
  }
  await b.rt.heldBack()
  assert.equal(b.room.sessions.b1, 'g1')
  assert.deepEqual(b.room.segments.b1, [])
  assert.equal(b.rt.state.switching.g1, undefined)
  assert.equal(failed.filter(send => send.wake).length, 3)
  assert.equal(b.calls.archived.includes(freshId), true)
  assert.equal(b.calls.archived.includes('g1'), false)
  assert.equal(JSON.stringify(b.bot), before)
  assert.equal((await b.rt.modelStateOf('b1')).lastFailure, undefined)
  assert.deepEqual(selectedOn(b, 'g1'), [])
})

// ME-1 (carried from D1): a relay sender whose request an own-chat switch cut gets one final
// answer when the live way back cannot run that request again: the chat changed meanwhile, or
// the old part cannot be loaded. The way back that resumes it answers nothing itself.
const cutBench = () => {
  const b = bench()
  b.agent.status = 'running'
  b.rt.live.set('s1', { turn: 3, info: { kind: SOURCE_KIND, form: 'relay', role: 'request', exchangeId: 'e-cut', senderSessionId: 'other' }, joined: [] })
  b.agent.cancel = (reason) => {
    b.calls.cancels.push({ reason })
    b.agent.status = 'idle'
    b.rt.live.delete('s1')
    b.sessionEvent('s1', { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason } } })
  }
  // The group stays out of these cases.
  b.room.sessions = {}
  return b
}
const signInFailure = { kind: 'error', error: { code: 'MODEL_ACCESS_REQUIRED', message: 'Sign in' } }
const cutAnswers = b => b.calls.delivered.filter(job => job.replyTo === 'e-cut')

test('ME-1 a cut relay request gets one final answer when the way back cannot run it', async t => {
  for (const path of ['resumed', 'chat changed', 'old part gone']) {
    const b = cutBench()
    t.after(() => b.ctx.dispose())
    await b.rt.switchRoute('b1', 'acp-claude/default', undefined, { stopReply: true })
    await waitFor(() => b.bot.sessionId === 's2' && b.jobs().length === 0)
    assert.equal(b.rt.switchResumes('s2', signInFailure), true, path)
    if (path === 'chat changed') b.bot.sessionId = 's9'
    if (path === 'old part gone') {
      const resolve = b.rt.resolveAgent
      b.rt.resolveAgent = async id => (id === 's1' ? Promise.reject(new Error('gone')) : resolve(id))
    }
    b.sessionEvent('s2', { type: 'turn/end', data: { turn: 1, reason: signInFailure } })
    if (path === 'chat changed') await tick()
    else await waitFor(() => b.calls.archived.includes('s2'))
    await tick()
    if (path === 'resumed') {
      assert.deepEqual(cutAnswers(b), [], path)
      continue
    }
    const answers = cutAnswers(b)
    assert.equal(answers.length, 1, path)
    assert.deepEqual({ toId: answers[0].toId, role: answers[0].role }, { toId: 'other', role: 'reply' }, path)
    assert.match(answers[0].text, /^Ops could not answer your message: its model call failed \(MODEL_ACCESS_REQUIRED: Sign in\)\. Tell the user if it matters; do not retry right away\.$/, path)
  }
})

test('ME-1 with no way back, a handoff rerun that cannot run answers the cut sender once', async t => {
  const b = cutBench()
  t.after(() => b.ctx.dispose())
  b.bot.model = b.bot.appliedModel = 'acp-antigravity/default'
  b.rt.config.crossingNoteTimeoutMs = 20
  await b.rt.switchRoute('b1', 'acp-claude/default', undefined, { stopReply: true })
  await waitFor(() => b.bot.sessionId === 's2' && b.jobs().length === 0)
  const fresh = b.agents.get('s2')
  // The failed first turn took the handoff, and the part's log does not have it either.
  fresh.inbox.nextTurn.length = 0
  fresh.inbox.nextStep.length = 0
  fresh.session.deriveMessages = () => []
  b.bot.denyTools = ['acp_tool']
  b.sessionEvent('s2', { type: 'turn/end', data: { turn: 1, reason: signInFailure } })
  await waitFor(() => b.calls.archived.includes('s1'))
  await tick()
  assert.equal(b.bot.sessionId, 's2')
  assert.equal(cutAnswers(b).length, 1)
  assert.match(cutAnswers(b)[0].text, /^Ops could not answer your message: its model call failed \(MODEL_ACCESS_REQUIRED: Sign in\)/)
})
