import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { boundContextSummary, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { Backchannel } from '../../acp-dsh/src/host/backchannel.js'
import { createRuntime } from '../index.js'
import { install as installParts } from '../src/host/parts.js'
import { rowsOf } from '../src/host/pocket-chat.js'
import { install, skillTool } from '../src/host/skill-library-call.js'
import { chatPersonParts, SKILL_NOTICE } from '../src/host/skill-message.js'
import { install as installClock } from '../src/host/time-context.js'
import { fakeContext } from './fake-ctx.js'
import { appendLegacyRefusal, nativeText, ordinaryText, rawText, refusedName, replyText, saveModelInput } from './support/legacy-skill-refusal.js'
import { immediate, until } from './until.js'

const fake = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).pathname
const doc = (name, mode) => ({ name, mode, description: 'Description for ' + name, content: 'Checked contents of ' + name, hash: name })
const inactive = doc('amber-fixture', 'automatic')
const automatic = doc('cobalt-fixture', 'automatic')
const manual = doc('mint-fixture', 'manual')
const uncalled = doc('ochre-fixture', 'manual')
const revoke = doc('indigo-fixture', 'automatic')
const unknown = 'unknown-fixture'
const user = (text, ...parts) => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text }, ...parts],
})
const refusal = 'No skill with that name is available to this Bot.'
const result = (text, isError) => ({ content: [{ type: 'text', text }], isError })

async function fixture(t, provider, { clock = false } = {}) {
  const claude = provider === 'acp-claude'
  const root = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'inactive-acp-'))
  const trace = join(dir, 'trace.ndjson')
  const fileName = 'ordinary-attachment.txt'
  const filePath = join(dir, fileName)
  const bytes = Buffer.from('Fixture file')
  const attachment = {
    attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'text/plain', name: fileName, bytes: bytes.length,
  }
  writeFileSync(filePath, bytes, { mode: 0o400 })
  const active = [automatic, manual, uncalled]
  const approvals = []
  const executions = []
  const requests = []
  const turns = [
    { text: 'Probe unavailable loads', loads: [inactive.name, unknown, uncalled.name], retryEmpty: true,
      native: claude ? [inactive.name, unknown, uncalled.name, 'separate-native-skill'] : [] },
    { text: 'Probe duplicate load', loads: [inactive.name, inactive.name] },
    { text: 'Probe checked load', loads: [automatic.name] },
    { text: 'Probe reassignment', loads: [revoke.name], retryEmpty: true },
  ]
  t.after(async () => {
    try { adapter.dispose(); bridge.dispose(); await root.fiber.dispose() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.provide('attachments', { fileHostPath: ref => ref.attachmentId === attachment.attachmentId ? filePath : undefined })
  root.provide('approval', {
    effectivePolicy: () => 'ask',
    async request(request) { approvals.push(request); return 'allowed-once' },
  })
  const rt = {
    ctx: root, load: async () => {}, selfOf: id => id, botOf: id => ['bot-a', 'bot-b'].includes(id) ? { id } : undefined,
    skillLibrary: { active: id => id === 'bot-a' ? active : [] },
  }
  if (clock) installClock({ ...rt, config: { timeZone: 'UTC' },
    isBotSession: id => rt.botOf(id) !== undefined,
    async* eventsBackwards() { yield* [...agent.session.snapshotEvents()].reverse() },
  })
  install(rt)
  root.provide('omniTeam', rt)
  root.tools.register(skillTool(rt))
  root.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'load_skill') return next()
    executions.push(exec.arguments.name)
    const value = await next()
    if (exec.arguments.name === revoke.name) active.splice(active.indexOf(revoke), 1)
    return value
  })
  const bridge = new Backchannel({ ctx: root })
  const adapter = new AcpAdapter(root, new Map([[provider, {
    name: 'Fixture ACP', bridge: claude, disableBuiltInTools: false,
    catalog: { models: async () => [{ id: 'default', name: 'Fixture ACP' }], dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [fake],
      env: { PATH: process.env.PATH, HOME: dir, FAKE_ACP_TRACE: trace,
        FAKE_ACP_SKILLS_PROBE: JSON.stringify({ claude, turns }) } }),
  }]]), { backchannel: bridge, dshTools: () => undefined })
  const stream = adapter.stream.bind(adapter)
  adapter.stream = options => { requests.push(options); return stream(options) }
  root.llm.registerAdapter([provider], adapter)
  const harness = await mountAgentLoopTestHarness(root)
  const agent = await harness.create('bot-a', { provider, model: 'default' }, { cwd: dir })
  const events = kind => (existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
    .filter(event => kind === undefined || event.event === kind)
  const turnFor = async (target, ...inputs) => {
    const from = target.session.seq
    for (const input of inputs.slice(0, -1)) target.inject(input)
    target.followup(inputs.at(-1))
    await target.whenIdle()
    return target.session.snapshotEvents().slice(from)
  }
  const turn = (...inputs) => turnFor(agent, ...inputs)
  const visibleNotices = records => records.flatMap(event => rowsOf(event, { sessionId: agent.id, calls: new Map() }))
    .filter(row => row.state === 'notice')
  return { active, agent, adapter, approvals, executions, requests, events, turn, turnFor, visibleNotices, attachment, filePath,
    rt, secondAgent: () => harness.create('bot-b', { provider, model: 'default' }, { cwd: dir }),
  }
}

function privateFree(prompts) {
  assert.ok(prompts.length > 0)
  for (const { prompt } of prompts) {
    assert.ok(Array.isArray(prompt), 'the trace contains the exact ACP prompt blocks')
    const wire = JSON.stringify(prompt)
    for (const text of [inactive.name, inactive.description, inactive.content, unknown,
      uncalled.name, uncalled.description, uncalled.content, 'is not active on this Bot', 'under Skills', refusal]) {
      assert.ok(!wire.includes(text), 'private text reached ACP: ' + text + '\n' + wire)
    }
  }
}

test('round 2 clock: due Bot time context leaves a pure inactive call host-only', { timeout: 15_000 }, async t => {
  const f = await fixture(t, 'acp-codex', { clock: true })
  const expired = Date.now() - 600_001
  const time = t.mock.method(Date, 'now', () => expired)
  const oldClock = 'Current time: an expired fixture reading.'
  f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: oldClock }],
    source: { kind: 'ds-bot-time-context', form: 'snapshot', sections: [{ name: 'ds-bot-time-context', text: oldClock }] },
  }), { surfaceOp: 'append' })
  time.mock.restore()
  const records = await f.turn(user('/' + inactive.name))
  assert.deepEqual(f.visibleNotices(records).map(row => row.msg), [
    `The skill ${inactive.name} is not active on this Bot. Add it in the Bot's Details, under Skills.`,
  ])
  assert.equal(f.requests.length, 0, 'a due clock alone must not dispatch a model request')
  assert.deepEqual(f.events('prompt'), [])
  assert.deepEqual(f.executions, [])
  assert.deepEqual(f.approvals, [])
  assert.equal(records.some(event => event.type === 'tool/call'), false)
  assert.deepEqual(records.at(-1).data.reason, { kind: 'completed' })
  const batch = await f.turn(user('Keep this genuine queued work.'), user('use the skill ' + inactive.name))
  assert.ok(batch.some(event => event.type === 'user/message' && event.data.source.kind === 'ds-bot-time-context'))
  const prompts = f.events('prompt')
  privateFree(prompts)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /Keep this genuine queued work/)
})

async function groupFixture(t) {
  const f = await fixture(t, 'acp-codex')
  const second = await f.secondAgent()
  const roomId = 'fixture-room'
  const state = {
    version: 1, mainBotIds: ['bot-b'],
    bots: {
      'bot-b': { id: 'bot-b', sessionId: 'own-b', name: 'Admin', role: 'Admin', createdAt: 1 },
      'bot-a': { id: 'bot-a', sessionId: 'own-a', name: 'Writer', role: 'Writer', createdAt: 2 },
    },
    rooms: { [roomId]: { id: roomId, name: 'Ops', members: ['bot-b', 'bot-a'], mode: 'admin', admin: 'bot-b',
      notice: 'Use plain replies.', named: true, sessions: { 'bot-b': 'bot-b', 'bot-a': 'bot-a' },
      log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  const home = mkdtempSync(join(tmpdir(), 'inactive-room-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext()
  const pending = new Map()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined },
    sessionController: { resolveAgent: async id => ({ agent: { id, session: { id },
      followup: input => pending.set(id, input), ctx: { tools: { restrict: () => () => {}, register: () => () => {} } } } }) },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
  })
  const host = createRuntime(ctx, { home, github: false, memory: false, browser: false, updateCheck: false })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const savedActive = host.skillLibrary.active
  const active = f.rt.skillLibrary.active
  f.rt.skillLibrary.active = host.skillLibrary.active = id => id === 'bot-b' ? savedActive(id) : active(id)
  f.rt.roomSkillNotice = host.roomSkillNotice
  f.rt.roomSkillHandled = host.roomSkillHandled
  f.rt.skillRoomActivity = host.skillRoomActivity
  f.rt.groupOwners = host.groupOwners
  const tool = (name, args, id, extra) => host.teamTools.find(entry => entry.name === name)
    .execute(args, { agent: { id }, ...extra })
  await tool('list_bots', {}, 'bot-b')
  const room = host.roomOf(roomId)
  host.logRoom(room, { who: 'User', text: 'Unseen earlier ordinary context.' })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const relay = async (recipient, input, beforeRead) => {
    const signal = AbortSignal.timeout(5_000)
    emit(roomId, 'user/message', input)
    const result = JSON.parse(await tool('group_relay', {}, roomId, { callId: `relay-${seq}`, signal }))
    await until(() => pending.has(recipient.id), { poll: immediate, ms: 2_000 })
    const delivered = pending.get(recipient.id)
    pending.delete(recipient.id)
    await beforeRead?.()
    const records = await f.turnFor(recipient, delivered)
    for (const event of records) if (['turn/start', 'user/message', 'turn/end'].includes(event.type)) {
      emit(recipient.id, event.type, event.data)
    }
    await until(() => host.roomProgress.size === 0 && host.roomWaiters.size === 0, { poll: immediate })
    assert.deepEqual(records.at(-1)?.data.reason, { kind: 'completed' })
    return result
  }
  return { f, second, roomId, host, room, tool, relay, call, emit, pending }
}

test('round 2 activity: a queued recipient keeps relay A when relay B opens at the same sequence', { timeout: 20_000 }, async t => {
  const { f, second, roomId, host, room, tool, call, emit, pending } = await groupFixture(t)
  room.mode = 'all'
  const reading = Promise.withResolvers()
  const beganReading = Promise.withResolvers()
  t.mock.method(host, 'imagesForGroup', () => { beganReading.resolve(); return reading.promise })
  t.after(() => reading.resolve([]))
  const firstCall = { callId: 'relay-a', signal: t.signal }
  const secondCall = { callId: 'relay-b', signal: t.signal }
  emit(roomId, 'user/message', user(`Finish this /${manual.name}`, { type: 'image', attachment: f.attachment }))
  const first = JSON.parse(await tool('group_relay', {}, roomId, firstCall))
  await beganReading.promise
  const roomBook = `group-${roomId}`
  const openingB = tool('group_relay', {}, roomId, secondCall)
  await until(() => host.ledger.records(roomBook).filter(record => record.event === 'anchor').length === 2, { poll: immediate })
  reading.resolve([])
  const later = JSON.parse(await openingB)
  assert.equal(later.from, first.from)
  assert.notEqual(later.anchor, first.anchor)
  await until(() => pending.has(second.id), { poll: immediate })
  assert.equal(pending.has(f.agent.id), false, 'the writer is queued behind the admin')
  const settle = (id, input, turn = 1) => {
    emit(id, 'turn/start', { turn })
    emit(id, 'user/message', input)
    emit(id, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  settle(second.id, pending.get(second.id))
  await until(() => pending.has(f.agent.id), { poll: immediate })
  const input = pending.get(f.agent.id)
  const records = await f.turnFor(f.agent, input)
  assert.equal(records.at(-1)?.data.reason.kind, 'completed')
  const activity = rows => rows.filter(row => row.kind === 'skill-activity').map(row => [row.botId, row.skill])
  const read = async range => activity((await call('group-rows', { roomId, ...range })).value.rows)
  const progress = (await call('room-progress', { roomId })).value
  const live = { a: activity(progress.find(item => item.callId === firstCall.callId).replies), b: await read(later) }
  settle(f.agent.id, input)
  await until(() => host.roomProgress.size === 0 && host.roomWaiters.size === 0, { poll: immediate })
  assert.deepEqual({ live, history: { a: await read(first), b: await read(later) } }, {
    live: { a: [[f.agent.id, manual.name]], b: [] },
    history: { a: [[f.agent.id, manual.name]], b: [] },
  })
})

test('a checked recipient load stays on its own relay after a second anchor opens', { timeout: 20_000 }, async t => {
  const { f, roomId, host, room, tool, relay } = await groupFixture(t)
  let later
  const first = await relay(f.agent, user(`@Writer Finish this /${manual.name}`), async () => {
    later = JSON.parse(await tool('group_relay', {}, roomId, { callId: 'later-anchor' }))
  })
  assert.notEqual(later.anchor, first.anchor)
  const activity = rows => rows.filter(row => row.kind === 'skill-activity').map(({ botId, skill }) => ({ botId, skill }))
  assert.deepEqual(activity(host.groupRowsView(roomId, first.from, undefined, first.anchor).rows), [{ botId: 'bot-a', skill: manual.name }])
  assert.deepEqual(activity(host.groupRowsView(roomId, later.from, undefined, later.anchor).rows), [])
  assert.deepEqual(activity(host.groupRowsView('different-room', first.from, undefined, first.anchor).rows), [])
  assert.deepEqual(activity(host.groupRows(roomId, 0, room.seq)), [])
  assert.equal((await host.groupLinesAfter(roomId, 0)).some(line => line.kind === 'skill-activity'), false)
  const book = `group-${roomId}`
  const loaded = host.ledger.records(book).find(record => record.kind === 'skill-activity' && record.event === 'load')
  host.ledger.append(book, { ...loaded })
  host.ledger.append(book, { ...loaded, botId: 'bot-b', exchangeId: 'another-recipient' })
  assert.deepEqual(activity(host.groupRowsView(roomId, first.from, undefined, first.anchor).rows), [
    { botId: 'bot-a', skill: manual.name }, { botId: 'bot-b', skill: manual.name },
  ])
})

test('round 2 group: relay and later reads project human lines for each recipient', { timeout: 20_000 }, async t => {
  const { f, second, roomId, host, room, tool, relay } = await groupFixture(t)
  const pure = '/' + manual.name
  await relay(second, user(pure))
  assert.deepEqual(f.events('prompt'), [], 'a group envelope alone must not dispatch an inactive-only turn')
  assert.equal(room.seen['bot-b'], undefined, 'a host-only turn does not read earlier context for the Bot')
  assert.deepEqual(host.groupRows(roomId, 0, room.seq).map(row => row.kind), ['user', SKILL_NOTICE])
  assert.ok(room.log.some(line => line.text === pure), 'the group Session still displays the original call')
  const mixed = `Keep the group report ${pure} /${inactive.name}`
  await relay(second, user(mixed, { type: 'file', attachment: f.attachment }))
  const adminPrompt = f.events('prompt').at(-1).text
  assert.match(adminPrompt, /Unseen earlier ordinary context/)
  assert.match(adminPrompt, /Keep the group report/)
  assert.match(adminPrompt, /ordinary-attachment\.txt/)
  assert.ok(adminPrompt.includes(f.filePath), 'the group attachment still reaches the provider with a readable handle')
  assert.doesNotMatch(adminPrompt, /mint-fixture|amber-fixture|is not active/)

  await relay(f.agent, user(`@Writer Finish the next report ${pure}`))
  const writerPrompt = f.events('prompt').at(-1).text
  assert.match(writerPrompt, /Earlier in the group[\s\S]*Keep the group report/)
  assert.match(writerPrompt, /Finish the next report/)
  assert.equal(writerPrompt.split(manual.content).length - 1, 1, 'only the current call applies checked content')
  assert.doesNotMatch(writerPrompt, /amber-fixture|is not active/)

  const original = room.log.find(line => line.text?.startsWith(mixed))
  assert.ok(original, 'the human room log keeps the exact original wording')
  assert.equal(host.ledger.record(`group-${roomId}`, original.seq).caption, mixed)
  assert.ok(host.groupRows(roomId, 0, room.seq).some(row => row.kind === SKILL_NOTICE && row.botId === 'bot-b'))
  for (const args of [{}, { seq: original.seq }, { query: 'Keep the group report' }]) {
    const adminRead = await tool('read_group_chat', { group: roomId, ...args }, 'bot-b')
    assert.match(adminRead, /Keep the group report/)
    assert.doesNotMatch(adminRead, /mint-fixture|amber-fixture|is not active/)
    const writerRead = await tool('read_group_chat', { group: roomId, ...args }, 'bot-a')
    assert.match(writerRead, /Keep the group report \/mint-fixture/)
    assert.doesNotMatch(writerRead, /amber-fixture|Checked contents|is not active/)
  }
  assert.match(await tool('read_group_chat', { group: roomId, query: manual.name }, 'bot-b'), /^Nothing said /)
  room.log = room.log.filter(line => line !== original)
  const archived = await tool('read_group_chat', { group: roomId, seq: original.seq }, 'bot-b')
  assert.match(archived, /Keep the group report/)
  assert.doesNotMatch(archived, /mint-fixture|amber-fixture/)
})

test('owner exception group: a manual Add cannot reopen a recorded refusal', { timeout: 20_000 }, async t => {
  const { f, second, roomId, host, room, tool, relay } = await groupFixture(t)
  const gesture = '/' + manual.name
  const ordinary = 'Keep the previous group report.'
  const mixed = `${ordinary} ${gesture}`
  await relay(second, user(mixed))
  await relay(second, user(gesture))
  assert.equal(f.events('prompt').length, 1, 'the pure refusal ended on the host')
  const original = room.log.find(line => line.text === mixed)
  const pure = room.log.find(line => line.text === gesture)
  assert.ok(original && pure)
  const notices = () => host.groupRows(roomId, 0, room.seq).filter(row => row.kind === SKILL_NOTICE)
  assert.deepEqual(notices().map(row => row.botId), ['bot-b', 'bot-b'])

  const owner = { role: 'owner' }
  assert.deepEqual(await host.skillLibrary.endpoint('skill-library-save', manual, owner), { saved: true })
  assert.deepEqual(await host.skillLibrary.endpoint('bot-skill-add', { id: 'bot-b', name: manual.name }, owner), { saved: true })
  assert.deepEqual((await host.skillLibrary.endpoint('skill-library', {}, owner)).active['bot-b'], [{ name: manual.name, mode: 'manual' }])

  await relay(second, user('Continue the work in the next group round.'))
  const later = f.events('prompt').at(-1)
  assert.match(later.text, /Earlier in the group[\s\S]*Continue the work in the next group round/)
  const reads = []
  for (const args of [{}, { seq: original.seq }, { seq: pure.seq }, { query: ordinary }]) {
    const read = id => tool('read_group_chat', { group: roomId, ...args }, id)
    reads.push({ args, refused: await read('bot-b'), other: await read('bot-a') })
  }
  room.log = room.log.filter(line => line !== original)
  const archived = await tool('read_group_chat', { group: roomId, seq: original.seq }, 'bot-b')
  assert.equal(host.ledger.record(`group-${roomId}`, original.seq).text, mixed)
  assert.equal(host.ledger.record(`group-${roomId}`, pure.seq).text, gesture)

  await relay(second, user(`Use it now ${gesture}`))
  const valid = f.events('prompt').at(-1)
  assert.match(valid.text, /Use it now/)
  assert.equal(valid.text.split(manual.content).length - 1, 1, 'a fresh call applies the newly added skill once')
  assert.deepEqual(notices().map(row => row.botId), ['bot-b', 'bot-b'])
  saveModelInput('group', { later: later.prompt, reads, archived, valid: valid.prompt })
  assert.doesNotMatch(JSON.stringify(later.prompt), /mint-fixture|is not active on this Bot|under Skills/)
  for (const { args, refused, other } of reads) {
    if (args.seq !== pure.seq) assert.ok(refused.includes(ordinary))
    assert.doesNotMatch(refused, /mint-fixture|is not active on this Bot|under Skills/)
    assert.ok(other.includes(gesture), 'the refusal does not alter another recipient’s projection')
  }
  assert.ok(archived.includes(ordinary))
  assert.doesNotMatch(archived, /mint-fixture|is not active on this Bot/)
})

async function checkLegacyHandoff(t, { sparse = false } = {}) {
  const f = await fixture(t, 'acp-codex')
  const { agent } = f
  const fresh = await f.secondAgent()
  appendLegacyRefusal(agent.session, { provider: 'acp-codex', model: 'default' })
  if (sparse) {
    const read = agent.session.eventAt
    t.mock.method(agent.session, 'eventAt', function (seq) {
      const event = read.call(this, seq)
      if (event?.type === 'assistant/message' && event.data?.message?.content?.some(part => part.text === replyText)) return undefined
      return event
    })
  }
  const ctx = fakeContext()
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm = { resolveModelInfo: async () => ({}) }
  const bot = { id: 'writer', sessionId: agent.id, name: 'Writer', createdAt: 1, model: 'acp-codex/default' }
  const warnings = []
  const rt = {
    ctx, config: {}, state: { switching: {}, bots: { writer: bot }, questions: {}, views: {} },
    warn: (...args) => warnings.push(args.map(value => value instanceof Error ? value.stack : value)),
    load: async () => {}, save: async () => {}, readOnly: () => undefined,
    selfOf: () => bot.id, botOf: id => id === bot.id ? bot : undefined, roomOf: () => undefined, chatOf: () => bot.sessionId,
    chatOwners: new Map([[agent.id, bot.id]]), groupOwners: new Map(), pastOwners: new Map(),
    resolveAgent: async id => id === agent.id ? agent : fresh,
    async* eventsBackwards() { yield* [...agent.session.snapshotEvents()].reverse() },
    teamFolder: () => agent.session.header.cwd, workDirOf: () => undefined,
    desiredModel: async () => bot.model, cachedCatalog: () => [{ ref: bot.model }],
    resolveModel: async ref => ref, resolveEffort: async () => undefined, desiredEffort: async () => undefined,
    createSession: async () => fresh.id, selectSessionModel: async () => {},
    applyPermission: async () => {}, applyToolDeny: async () => {}, ensureCapabilities: async () => {},
    moveSchedules: async () => {}, renewMemory() {},
  }
  installParts(rt)
  assert.equal(await rt.newPart(agent.id), true)
  await until(() => [...rt.switchJobs()].length === 0, { poll: immediate })
  assert.equal(bot.sessionId, fresh.id, JSON.stringify(warnings))
  assert.equal(bot.segments.at(-1).sessionId, agent.id)
  await fresh.whenIdle()
  assert.deepEqual(fresh.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason, { kind: 'completed' })
  const [handoff] = f.events('prompt')
  assert.equal(f.events('prompt').length, 1)
  const wire = JSON.stringify(handoff.prompt)
  saveModelInput('handoff', handoff.prompt)
  for (const text of [ordinaryText, nativeText, replyText]) assert.ok(wire.includes(text), wire)
  assert.ok(agent.session.deriveMessages().some(row => row.content.some(part => part.text === rawText)))
  assert.doesNotMatch(wire, new RegExp(`${refusedName}|is not active on this Bot|under Skills`))
}

test('owner exception handoff: a new part carries only the ordinary legacy history', { timeout: 15_000 }, checkLegacyHandoff)

test('owner exception handoff: preserves a recorded refusal before a missing assistant event', { timeout: 15_000 },
  t => checkLegacyHandoff(t, { sparse: true }))

test('round 2 replay: a cold ACP request projects a matching parent-format refusal', { timeout: 15_000 }, async t => {
  const f = await fixture(t, 'acp-claude')
  await f.turn(user('/' + manual.name))
  f.active.splice(f.active.indexOf(manual), 1)
  f.adapter.endSession(f.agent.id)
  const session = f.agent.session
  const append = row => session.append('user/message', row, { surfaceOp: 'append' })
  const step = (turn, rows) => {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    for (const row of rows) append(row)
    session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'acp-claude', model: 'default' },
      content: [{ type: 'text', text: 'Historical report reply.' }],
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const refused = name => {
    const text = `The skill ${name} is not active on this Bot. Add it in the Bot's Details, under Skills.`
    return createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: SKILL_NOTICE, form: 'notice', summary: boundContextSummary(text) } })
  }
  const native = `/help /${inactive.name}`
  const mixed = `Keep the exact report wording.  use the skill ${inactive.name} /${inactive.name}`
  const pure = '/' + unknown
  // The pre-correction parent wrote unmarked person rows, then the refusals at the end of each step.
  step(2, [user(native), user(mixed), user(pure), refused(inactive.name), refused(unknown)])
  await f.turn(user('Continue in a reconstructed request.'))
  const replay = f.events('prompt').at(-1)
  const fresh = replay.prompt.findIndex(block => block.text === 'Continue in a reconstructed request.')
  assert.ok(fresh > 0, 'the reconstructed history precedes the new input')
  assert.match(replay.prompt[0].text, /^The chat so far/)
  const history = replay.prompt.slice(1, fresh).map(block => block.text).join('\n')
  assert.match(history, /Historical report reply/)
  assert.match(history, /Checked contents of mint-fixture/)
  assert.ok(history.includes(native), 'a separate native slash input keeps its original route and wording')
  assert.match(history, /Keep the exact report wording\.\s+\/amber-fixture/)
  assert.doesNotMatch(replay.text, /use the skill amber-fixture|unknown-fixture|is not active on this Bot/)
  const displayed = session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    .flatMap(event => chatPersonParts(event.data).map(part => part.text))
  for (const text of [native, mixed, pure]) assert.ok(displayed.includes(text), 'human display keeps ' + text)
})

for (const provider of ['acp-claude', 'acp-codex']) {
  for (const gesture of ['/', 'use the skill ']) {
    test(`${provider}: pure ${gesture.trim()} inactive call ends visibly on the host`, { timeout: 15_000 }, async t => {
      const f = await fixture(t, provider)
      const records = await f.turn(user(gesture + inactive.name))
      const notices = f.visibleNotices(records)
      assert.equal(notices.length, 1)
      assert.match(notices[0].msg, /amber-fixture is not active on this Bot.*Details, under Skills/)
      assert.deepEqual(f.events('prompt').map(event => event.text), [], 'zero outgoing ACP requests')
      assert.deepEqual(f.requests, [], 'zero model dispatches')
      assert.deepEqual(f.executions, [])
      assert.deepEqual(f.approvals, [])
      assert.equal(records.some(event => event.type === 'tool/call'), false)
      assert.deepEqual(records.at(-1).data.reason, { kind: 'completed' })
    })
  }

  test(`${provider}: mixed input preserves ordinary work, attachment, other inputs and active manual use`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, provider)
    const file = { type: 'file', attachment: f.attachment }
    const records = await f.turn(
      user(`Prepare the summary / please /${inactive.name} /${manual.name}`, file),
      user('Keep the queued instructions.'),
      user('use the skill ' + inactive.name),
    )
    const prompts = f.events('prompt')
    privateFree(prompts)
    const wire = prompts.map(event => event.text).join('\n')
    assert.equal([...wire.matchAll(/Prepare the summary \/ please \/mint-fixture/g)].length, 1)
    assert.match(wire, /ordinary-attachment\.txt/)
    assert.ok(wire.includes(f.filePath), 'the durable file still has a readable provider handle')
    assert.equal([...wire.matchAll(/Keep the queued instructions\./g)].length, 1)
    assert.match(wire, /Checked contents of mint-fixture/)
    assert.match(wire, /cobalt-fixture: Description for cobalt-fixture/)
    assert.doesNotMatch(wire, /Description for mint-fixture|Checked contents of cobalt-fixture/)
    assert.ok(records.some(event => event.type === 'user/message'
      && event.data.content.some(part => part.attachment?.attachmentId === file.attachment.attachmentId)))
    assert.equal(f.visibleNotices(records).length, 2, 'each inactive input gets its own human remedy')
    f.adapter.endSession(f.agent.id)
    await f.turn(user('Continue ordinary work.'))
    const replay = f.events('prompt').at(-1)
    privateFree([replay])
    assert.match(replay.text, /Prepare the summary/)
    assert.match(replay.text, /Continue ordinary work/)
    assert.match(replay.text, /Checked contents of mint-fixture/)
  })

  test(`${provider}: unavailable loads are terminal before approval and on delivery`, { timeout: 25_000 }, async t => {
    const f = await fixture(t, provider)
    await f.turn(user('Probe unavailable loads'))
    await t.test('all unavailable names yield the same error and stop retrying', () => {
      const loads = f.events('skills-load')
      assert.deepEqual(loads.map(({ answer }) => answer), Array(3).fill(result(refusal, true)))
      assert.deepEqual(loads.map(({ retry }) => retry), [false, false, false])
    })
    await t.test('unavailable loads and matching native Skill attempts raise zero approvals', () => {
      assert.deepEqual(f.executions, [], 'unavailable calls never enter the tool executor')
      if (provider === 'acp-claude') {
        assert.deepEqual(f.events('native-skill-permission').map(({ outcome }) => outcome.optionId), ['no', 'no', 'no', 'yes'])
        assert.deepEqual(f.approvals.map(request => request.mirrorCall?.input?.skill), ['separate-native-skill'])
      } else assert.deepEqual(f.approvals, [])
    })
    await t.test('even an explicit repeated call never executes or asks again', async () => {
      const before = f.events('skills-load').length
      const approvals = f.approvals.length
      await f.turn(user('Probe duplicate load'))
      assert.deepEqual(f.events('skills-load').slice(before).map(({ answer }) => answer), Array(2).fill(result(refusal, true)))
      assert.equal(f.approvals.length, approvals)
      assert.deepEqual(f.executions, [])
    })
    await t.test('active Automatic content is delivered once with its normal approval', async () => {
      const approvals = f.approvals.length
      await f.turn(user('Probe checked load'))
      assert.deepEqual(f.events('skills-load').at(-1)?.answer, result(automatic.content, false))
      assert.deepEqual(f.executions.slice(-1), [automatic.name])
      assert.deepEqual(f.approvals.slice(approvals).map(request => request.toolName), ['load_skill'])
    })
    await t.test('revocation during execution returns the same terminal refusal', async () => {
      f.active.push(revoke)
      const before = f.events('skills-load').length
      const approvals = f.approvals.length
      await f.turn(user('Probe reassignment'))
      assert.deepEqual(f.events('skills-load').slice(before).map(({ answer }) => answer), [result(refusal, true)])
      assert.deepEqual(f.executions.slice(-1), [revoke.name])
      assert.deepEqual(f.approvals.slice(approvals).map(request => request.toolName), ['load_skill'])
    })
    await t.test('outgoing prompts keep private data out even on replay', async () => {
      f.adapter.endSession(f.agent.id)
      await f.turn(user('Continue after the probes.'))
      privateFree(f.events('prompt'))
    })
  })
}
