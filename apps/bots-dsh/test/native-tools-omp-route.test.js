import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { createRuntime } from '../index.js'
import { HANDOFF_ACK } from '../src/host/constants.js'
import { HERMES, OMP, holdOmpStart, offArgs, ompWorld, ownerMessage, textBlocks } from '../../acp-dsh/test/fixtures/omp-world.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

const offText = 'Native tools were turned off for this Bot, so this answer stopped. Send your message again.'
const startupText = 'The tools setting changed; send again.'

async function host(t, { saved = true } = {}) {
  const h = ompWorld(t, { otherProvider: true })
  const home = mkdtempSync(join(tmpdir(), 'omp-bot-route-'))
  const path = join(home, 'state.json')
  writeFileSync(path, JSON.stringify({
    version: 2, revision: 0, nativeToolsOmpKept: true, mainBotIds: ['a'],
    bots: {
      // #1564 PR B (B2-1 (1)): a saved ON names its agent; an untagged one is Claude's.
      a: { id: 'a', sessionId: 'ada', name: 'Ada', model: OMP + '/default', createdAt: 1, ...(saved ? { nativeTools: true, nativeToolsAgent: OMP } : {}), segments: [{ sessionId: 'old-a' }, { sessionId: 'off-a' }] },
      b: { id: 'b', sessionId: 'ben', name: 'Ben', model: OMP + '/default', createdAt: 2, nativeTools: true, nativeToolsAgent: OMP },
    },
  }))
  const active = new Map()
  const sessionPersistence = {
    open: async () => { throw Object.assign(new Error('No stored Session'), { name: 'SessionPersistenceNotFoundError' }) },
  }
  const ctx = fakeContext({ services: { ...h.services, sessionPersistence, acpAgents: h.service } })
  ctx.registry = new Map()
  ctx.sessions = { get: id => active.get(id), list: () => [...active.values()] }
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  const rt = createRuntime(ctx, { home })
  ctx.provide('omniTeam', rt)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  await rt.load()
  await h.service.inspect(OMP)
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const chat = (id = 'ada') => {
    const chat = h.chat(id)
    active.set(id, chat.session)
    return chat
  }
  return { ...h, ctx, rt, chat, call, stored: () => JSON.parse(readFileSync(path, 'utf8')) }
}

test('a pending then rejected ON save produces zero ON conversation launches', async t => {
  const h = await host(t, { saved: false })
  const entered = Promise.withResolvers()
  const save = Promise.withResolvers()
  const normalSave = h.rt.save
  const launches = h.events('start')
  t.mock.method(h.rt, 'save', options => {
    if (options?.enableNativeTools === undefined) return normalSave(options)
    entered.resolve('started')
    return save.promise
  })
  const response = h.call('update-bot', { id: 'a', nativeTools: true })
  assert.equal(await Promise.race([entered.promise, response]), 'started')
  const pending = h.chat()
  try {
    await normalSave({ required: true })
    assert.equal(h.stored().bots.a.nativeTools, undefined)
    await pending.turn('plain save-pending')
  } finally {
    save.reject(new Error('test: store rejected ON'))
  }
  assert.equal((await response).ok, false)
  assert.equal(h.stored().bots.a.nativeTools, undefined)
  await h.chat('ada').turn('plain save-rejected')
  const first = h.conversation('save-pending')
  const second = h.conversation('save-rejected')
  assert.deepEqual(first.args, offArgs(h.overlayPath))
  assert.deepEqual(second.args, offArgs(h.overlayPath))
  assert.deepEqual(h.events('start').slice(launches.length).map(row => row.args), [offArgs(h.overlayPath)])
})

test('Read only set during startup gives OFF argv on the very first chat launch', async t => {
  const h = await host(t)
  const chat = h.chat()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.mock.method(h.adapter, 'access', async () => { entered.resolve(); await release.promise })
  const answer = chat.turn('plain level-dropped')
  await entered.promise
  const before = h.events('start').length
  chat.session.append('sandbox/mode', { mode: 'read-only' })
  release.resolve()
  await answer
  assert.deepEqual(h.events('start').slice(before).map(row => row.args), [offArgs(h.overlayPath)])
  assert.deepEqual(h.conversation('level-dropped').args, offArgs(h.overlayPath))
})

test('two owner turns at Manual share one ON child, re-checking the saved ON\'s agent tag on reuse', async t => {
  const h = await host(t)
  const bot = h.rt.botOf('a')
  bot.nativeToolsKept = OMP
  let reads = 0
  Object.defineProperty(bot, 'nativeTools', { get() { reads++; return true } })
  const chat = h.chat()
  await chat.turn('plain owner-first')
  const readsAtStart = reads
  await chat.turn('plain owner-second')
  const first = h.conversation('owner-first')
  const second = h.conversation('owner-second')
  assert.deepEqual(first.args, ['acp'])
  assert.deepEqual(first.servers, [])
  assert.equal(second.pid, first.pid)
  // #1564 PR B (B2-1 (2)): each identity read of the agent tag reads the saved ON too, and
  // a reused child's eligibility now compares that tag. #1564 follow-up: the one-time upgrade
  // reads it once more, and reuse confirms the saved ON itself (fail closed).
  assert.equal(readsAtStart, 5)
  assert.equal(reads, readsAtStart + 2)
})

// #1564 PR B (BD-5): the tag check on reuse is what remakes the child when ending it failed.
test('turning OFF while endOmpSession throws: the next owner turn does not reuse the ON child', async t => {
  const h = await host(t)
  const chat = h.chat()
  await chat.turn('plain owner-on')
  const on = h.conversation('owner-on')
  assert.deepEqual(on.args, ['acp'])
  let ends = 0
  h.service.endOmpSession = () => { ends += 1; throw new Error('test: the omp child could not be ended') }
  const off = await h.call('update-bot', { id: 'a', nativeTools: false })
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(ends > 0, true)
  assert.equal(h.stored().bots.a.nativeTools, undefined)
  await chat.turn('plain owner-after-off')
  const after = h.conversation('owner-after-off')
  assert.notEqual(after.pid, on.pid)
  assert.deepEqual(after.args, offArgs(h.overlayPath))
})

// #1564 follow-up: a scheduled delivery follows the Bot's switch.
test('a real scheduled delivery starts ON, and an owner turn replays its history ON', async t => {
  const h = await host(t)
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
    title: 'Reminder', prompt: 'plain scheduled-marker',
    timing: { kind: 'at', at: new Date(Date.now() + 86_400_000).toISOString() },
    target: { kind: 'session', sessionId: h.rt.chatOf('a') },
  })
  const run = await schedule.run({ id: task.id })
  assert.equal(run.lastDelivery.targetSessionId, 'ada')
  assert.equal((await delivered.promise).source.kind, 'schedule')
  await turn
  const first = h.conversation('scheduled-marker')
  h.service.endSession('ada')
  await chat.turn('plain replay-marker')
  const second = h.conversation('replay-marker')
  assert.match(second.prompt, /scheduled-marker/)
  assert.notEqual(second.pid, first.pid)
  assert.deepEqual(first.args, ['acp'])
  assert.deepEqual(second.args, ['acp'])
})

async function startFreshPart(h) {
  const old = h.chat()
  const fresh = h.chat('fresh-ada')
  const captured = Promise.withResolvers()
  const oldAgent = { id: old.session.id, session: old.session, inbox: { nextStep: [], nextTurn: [] },
    whenIdle: async () => {}, runMaintenance: run => run(new AbortController().signal) }
  const freshAgent = { id: fresh.session.id, session: fresh.session, followup: captured.resolve }
  h.rt.resolveAgent = async id => id === oldAgent.id ? oldAgent : freshAgent
  h.rt.createSession = async () => fresh.session.id
  h.rt.selectSessionModel = async (_id, config) => fresh.session.append('request/header', { reason: 'initial', header: { config } })
  h.ctx.sessions.flush = async () => true
  h.ctx.workspaceRegistry = { archiveSession: async () => {} }
  const warnings = []
  h.ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const result = await h.call('bot-fresh', { id: 'a' })
  assert.equal(result.ok, true, JSON.stringify(result))
  await until(() => h.rt.switchJobs().next().done)
  assert.equal(h.rt.chatOf('a'), fresh.session.id, warnings.join('\n'))
  const relay = await captured.promise
  assert.equal(relay.source.handoff, true)
  assert.equal(relay.source.kind, 'bot')
  assert.match(relay.content[0].text, /^\[Handoff · part \d+\]\nThe user started a fresh conversation/)
  return { ...fresh, relay }
}

// #1564 follow-up: the handoff relay follows the saved switch too, so the relay opens omp ON
// and the next owner input reuses it.
for (const opening of ['failed relay', 'ACK with generated system prompt']) {
  test(`a real new-part ${opening} opens omp ON, and the next owner input reaches it`, async t => {
    const h = await host(t)
    h.rt.botOf('a').nativeToolsKept = OMP
    const chat = await startFreshPart(h)
    const { session, relay } = chat
    // Use the pinned DSH message constructor and the agent loop's durable event shape.
    const system = createSystemMessage('You are Ada, the Bot in this direct chat.')
    session.append('system/message', { turn: 1, step: 1, message: system }, { surfaceOp: 'append' })
    session.append('user/message', relay, { surfaceOp: 'append' })
    const openingMessages = session.deriveMessages()
    assert.deepEqual(openingMessages.map(message => message.source.kind), ['system-prompt', 'bot'])
    const promptCount = h.events('prompt').length
    let relayRun
    if (opening === 'failed relay') {
      // ACP takes the relay but rejects model choice before it can send a prompt.
      const failed = await chat.stream({ model: 'unsupported-model' })
      assert.equal(failed.at(-1).reason.kind, 'error')
      assert.match(failed.at(-1).reason.failure.message, /would not take unsupported-model/)
      relayRun = h.adapter.live.get(session.id).run
      assert.equal(relayRun.alive, true)
      assert.deepEqual(h.events('start').find(row => row.pid === relayRun.child.pid)?.args, ['acp'])
    } else {
      const stream = h.ctx.listeners.get('llm/stream').reduceRight(
        (next, handler) => options => handler(options, updated => next(updated ?? options)),
        () => assert.fail('the bare relay should be ACKed by Bots'),
      )
      const ack = []
      for await (const chunk of stream({ provider: OMP, model: 'default', sessionId: session.id, messages: openingMessages })) ack.push(chunk)
      assert.deepEqual(textBlocks(ack), [HANDOFF_ACK])
      session.append('assistant/message', { turn: 1, message: createAssistantMessage({
        source: { provider: OMP, model: 'default' },
        content: ack.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
      }) }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
      session.append('turn/start', { turn: 2 })
    }
    assert.equal(h.events('prompt').length, promptCount)
    const owner = ownerMessage('plain fresh-part-owner')
    session.append('user/message', owner, { surfaceOp: 'append' })
    const messages = session.deriveMessages()
    assert.deepEqual(messages.map(message => message.source.kind), opening === 'failed relay'
      ? ['system-prompt', 'bot', 'user'] : ['system-prompt', 'bot', 'model', 'user'])
    assert.equal(messages.find(message => message.source.kind === 'bot').id, relay.id)
    assert.equal(messages.at(-1).id, owner.id)
    assert.equal((await chat.stream()).at(-1).reason.kind, 'stop')
    const on = h.conversation('fresh-part-owner')
    t.diagnostic(JSON.stringify({ opening, relayPid: relayRun?.child.pid, ownerPid: on.pid, argv: on.args, sources: messages.map(m => m.source.kind) }))
    assert.deepEqual(on.args, ['acp'])
    assert.match(on.prompt, /\[Handoff · part \d+\]/)
    assert.equal(h.adapter.live.get(session.id).provider, OMP)
    if (relayRun) {
      assert.equal(on.pid, relayRun.child.pid)
      assert.equal(relayRun.alive, true)
    } else assert.ok(on.prompt.includes(HANDOFF_ACK))
  })
}

for (const phase of ['held ACP startup', 'live turn']) {
  test(`owner OFF immediately stops only A's ON omp during a ${phase}`, async t => {
    const h = await host(t)
    const ben = h.chat('ben')
    const other = h.chat('old-a')
    const off = h.chat('off-a')
    // #1564 follow-up: an earlier part follows the switch too; Read only keeps this one OFF.
    off.session.append('sandbox/mode', { mode: 'read-only' })
    await ben.turn('plain ben-control')
    await other.turn('plain other-control', HERMES)
    await off.turn('plain off-control')
    assert.deepEqual(h.conversation('off-control').args, offArgs(h.overlayPath))
    const ada = h.chat()
    const pending = phase === 'held ACP startup'
    const holdStart = pending ? holdOmpStart(t, h, ada.session.id) : undefined
    if (!pending) await ada.turn('plain ada-control')
    const before = h.events('start').length
    const turn = ada.turn('hang ada-in-flight')
    try {
      if (pending) await holdStart.run(turn)
      else await until(() => h.events('prompt').some(row => row.text.includes('ada-in-flight')))
      const state = h.adapter.live.get('ada')
      const { run } = state
      const oldPid = pending ? run.child.pid : h.conversation('ada-in-flight').pid
      const reply = await h.call('update-bot', { id: 'a', nativeTools: false })
      holdStart?.release()
      assert.equal(reply.ok, true, JSON.stringify(reply))
      assert.equal(state.nativeOff, false)
      assert.equal(h.adapter.live.has('ada'), false)
      await run.gone.catch(() => {})
      assert.equal(run.alive, false)
      const chunks = await turn
      t.diagnostic(JSON.stringify({ phase, oldPid, alive: run.alive,
        prompts: h.events('prompt').filter(row => row.pid === oldPid).length, notice: textBlocks(chunks).at(-1) }))
      assert.equal(chunks.at(-1).reason.kind, 'stop')
      assert.equal(textBlocks(chunks).at(-1), pending ? startupText : offText)
      assert.equal(h.events('prompt').filter(row => row.pid === oldPid).length, pending ? 0 : 2)
      assert.equal(h.events('start').length, before + (pending ? 1 : 0))
      assert.deepEqual(h.events('start').find(row => row.pid === oldPid).args, ['acp'])
      if (pending) {
        assert.deepEqual(holdStart.runs, [run])
        await ada.turn('plain owner-after-off')
        const after = h.conversation('owner-after-off')
        t.diagnostic(JSON.stringify({ offPid: after.pid, argv: after.args }))
        assert.notEqual(after.pid, oldPid)
        assert.deepEqual(after.args, offArgs(h.overlayPath))
      }
      await ben.turn('plain ben-still-here')
      await other.turn('plain other-still-here', HERMES)
      await off.turn('plain off-still-here')
      assert.equal(h.conversation('ben-still-here').pid, h.conversation('ben-control').pid)
      assert.equal(h.conversation('other-still-here').pid, h.conversation('other-control').pid)
      assert.equal(h.conversation('off-still-here').pid, h.conversation('off-control').pid)
    } finally {
      holdStart?.release()
      h.service.endSession('ada')
      await turn
    }
  })
}
