import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmRuntime, markAgentLoopRequest, projectFilesToText } from '@deepseek-ai/dsh-llm'
import { HermesTransport, RemoteChat, LOST, HERMES_DEADLINES, INVALID_FRAME } from '../src/host/hermes-transport.js'
import { remoteApproval, RemoteChatAdapter } from '../src/host/remote-chat-adapter.js'
import { Context } from '@deepseek-ai/cordis'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { Session } from '@deepseek-ai/dsh-session'
import { install } from '../src/host/hermes-remote.js'
import { fallbackFor } from '../src/host/fallback.js'
import { routeOf, selectorRouteOf, crossesHarness } from '../src/shared/routes.js'
import { markOf, judgeOf } from '../src/shared/permission-levels.js'
import { contractPin, differences, USED_METHODS } from '../scripts/hermes-contract.mjs'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { desktop8Session } from './fixtures/hermes-desktop8.mjs'

// All addresses and secrets are generated per test. No network or Hermes process is used.
// A wait that ends. A frame that never comes fails the test after five seconds, or at once
// with the error of the work it waited on, instead of polling for ever.
async function until(predicate, what, work) {
  let failed
  work?.then(undefined, error => { failed = error ?? Error(`Failed before ${what}`) })
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (failed) throw failed
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

// What the runtime gives the adapter: the projected envelope, deep-frozen.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function fixture(t, overrides = {}) {
  const credential = overrides.credential ?? randomUUID(), ticket = randomUUID()
  const address = `https://${randomUUID()}.invalid`
  const sent = [], headers = [], identities = []
  const source = desktop8Session(randomUUID(), randomUUID())
  const snapshot = source.create
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.event('gateway.ready', { replay_epoch: 'epoch-a', ...overrides.ready })) }
    frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })) }
    event(type, payload, seq) { this.frame({ jsonrpc: '2.0', method: 'event', params: { type, payload, session_id: snapshot.session_id, ...(seq ? { seq } : {}) } }) }
    reply(frame, result) { this.frame({ jsonrpc: '2.0', id: frame.id, result }) }
    send(text) {
      const frame = JSON.parse(text); sent.push(frame)
      if (!frame.method) return
      if (overrides.handle?.(frame, this) === true) return
      if (frame.method === 'session.list') { this.reply(frame, { sessions: [{ id: snapshot.stored_session_id, title: 'Bot Chat' }] }); return }
      const result = frame.method === 'client.capabilities' ? { server_requests: ['approval'] }
        : ['session.create', 'session.resume', 'session.activate'].includes(frame.method) ? { ...(frame.method === 'session.create' ? snapshot : source.live), ...overrides.snapshot }
          : frame.method === 'session.events.since' ? { events: [], latest_seq: 9, epoch: 'epoch-a', truncated: false, count: 0, open_requests: [], ...overrides.replay }
            : frame.method === 'model.options' ? { providers: [{ slug: 'sample', name: 'Sample', authenticated: true, models: ['sample-model'] }] }
              : { status: 'streaming', ...overrides.result }
      if (frame.method === 'session.events.since' && Array.isArray(result.events)) {
        result.events = result.events.map((event, index) => ({ session_id: snapshot.session_id, seq: index + 1, ...event }))
        result.count = result.events.length
      }
      queueMicrotask(() => {
        this.reply(frame, result)
        if (frame.method === 'session.create' && overrides.metadata !== false) queueMicrotask(() => this.event('session.info', { ...source.info, ...overrides.metadata }))
      })
    }
    close() { this.dispatchEvent(new Event('close')) }
  }
  let socket
  const wire = new HermesTransport({ address, credential, profile: 'sample', attached: overrides.attached === true, deadlines: { start: 200, control: 100, cancel: 30 },
    fetch: async (url, init) => { headers.push({ url, init }); if (overrides.authError) throw Object.assign(Error(`${credential} ${ticket}`), { code: overrides.errorCode }); const status = overrides.status ?? (overrides.expired ? 401 : 200); return { ok: status === 200, status, json: async () => ({ ticket }) } },
    socket: (url, protocols) => { headers.push({ url, protocols }); socket = new Socket(); return socket },
  })
  const identity = { createKey: randomUUID() }
  const run = new RemoteChat(wire, { identity, save: async () => identities.push(structuredClone(identity)), question: overrides.question })
  t.after(() => run.dispose())
  return { wire, run, identity, identities, sent, headers, snapshot, live: source.live, info: source.info, credential, ticket, socket: () => socket }
}

async function nextTurn(run) {
  const rows = []
  for (;;) {
    const row = await Promise.race([
      run.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the turn did not complete')), 1500)),
    ])
    rows.push(row)
    if (['done', 'error', 'aborted'].includes(row.kind)) return rows
  }
}

test('a serve restart between turns takes the new epoch seq and the next turn answers', async t => {
  let replay = { events: [], latest_seq: 9, epoch: 'epoch-a', truncated: false, count: 0, open_requests: [] }
  const f = fixture(t, {
    attached: true,
    handle: (frame, socket) => {
      if (frame.method === 'session.events.since') { socket.reply(frame, replay); return true }
      return false
    },
  })
  await f.wire.connect()
  const run = new RemoteChat(f.wire, { identity: { canonicalBot: true }, save: async () => {} })
  t.after(() => run.dispose())
  await run.submit('First')
  f.socket().event('message.complete', { text: 'First done' }, 10)
  const first = await nextTurn(run)
  assert.ok(first.some(row => row.kind === 'done'))
  assert.equal(run.identity.lastSeq, 10)

  replay = { events: [], latest_seq: 0, epoch: 'epoch-b', truncated: false, count: 0, open_requests: [] }
  await run.submit('Second')
  f.socket().event('message.complete', { text: 'Second done' }, 2)
  const second = await nextTurn(run)
  assert.ok(second.some(row => row.kind === 'done'), 'the turn after the restart completed')
  assert.equal(second.find(row => row.kind === 'text')?.text, 'Second done')
  assert.equal(run.identity.epoch, 'epoch-b')
  assert.equal(run.identity.lastSeq, 2)
})

test('a same-epoch session reload with a rewound seq answers on the first attached turn', async t => {
  const replay = { events: [], latest_seq: 0, epoch: 'epoch-a', truncated: false, count: 0, open_requests: [] }
  const f = fixture(t, {
    attached: true,
    handle: (frame, socket) => {
      if (frame.method === 'session.events.since') { socket.reply(frame, replay); return true }
      return false
    },
  })
  await f.wire.connect()
  const run = new RemoteChat(f.wire, { identity: { canonicalBot: true, storedSessionId: 'stored', runtimeSessionId: 'old-runtime', lastSeq: 50, epoch: 'epoch-a' }, save: async () => {} })
  t.after(() => run.dispose())
  await run.submit('First')
  f.socket().event('message.complete', { text: 'First done' }, 1)
  const rows = await nextTurn(run)
  assert.ok(rows.some(row => row.kind === 'done'), 'the reloaded first turn completed')
  assert.equal(rows.find(row => row.kind === 'text')?.text, 'First done')
  assert.equal(run.identity.epoch, 'epoch-a')
  assert.equal(run.identity.lastSeq, 1)
})

test('a carried-over lastSeq above the new serve seq answers on the first attached turn', async t => {
  const replay = { events: [], latest_seq: 0, epoch: 'epoch-b', truncated: false, count: 0, open_requests: [] }
  const f = fixture(t, {
    attached: true,
    handle: (frame, socket) => {
      if (frame.method === 'session.events.since') { socket.reply(frame, replay); return true }
      return false
    },
  })
  await f.wire.connect()
  const run = new RemoteChat(f.wire, { identity: { canonicalBot: true, storedSessionId: 'stored', lastSeq: 50, epoch: 'epoch-a' }, save: async () => {} })
  t.after(() => run.dispose())
  await run.submit('First')
  f.socket().event('message.complete', { text: 'First done' }, 1)
  const rows = await nextTurn(run)
  assert.ok(rows.some(row => row.kind === 'done'), 'the carried-over first turn completed')
  assert.equal(rows.find(row => row.kind === 'text')?.text, 'First done')
  assert.equal(run.identity.epoch, 'epoch-b')
  assert.equal(run.identity.lastSeq, 1)
})

test('ticket handshake negotiates server requests first, persists IDs before submit and shows text/tool', async t => {
  const f = fixture(t, { result: { admission_id: randomUUID() } })
  await f.wire.connect()
  assert.equal(f.sent[0].method, 'client.capabilities')
  assert.equal(f.sent[0].params.server_requests, true)
  assert.equal(f.headers[0].init.headers.Authorization, `Bearer ${f.credential}`)
  assert.equal(f.headers[0].init.redirect, 'error')
  assert.ok(f.headers[1].protocols.includes(`hermes-gateway-ticket.${f.ticket}`))
  assert.ok(!f.headers[1].url.includes(f.credential) && !f.headers[1].url.includes(f.ticket))
  await f.run.submit('Sample text')
  assert.equal(f.identity.runtimeSessionId, f.snapshot.session_id)
  assert.equal(f.identity.storedSessionId, f.snapshot.stored_session_id)
  assert.ok(f.identity.admissionId)
  assert.ok(f.identities.some(identity => identity.pendingSubmit && identity.storedSessionId))
  f.socket().event('message.delta', { text: 'Sample reply' }, 1)
  f.socket().event('tool.start', { tool_id: 'sample-tool', name: 'sample', args: { value: 1 } }, 2)
  assert.deepEqual(await f.run.next(), { kind: 'text', text: 'Sample reply' })
  assert.equal((await f.run.next()).tool.status, 'running')
  f.socket().event('tool.complete', { tool_id: 'sample-tool', name: 'sample', result_text: 'Done' }, 3)
  assert.equal(f.run.tools.get('sample-tool').text, 'Done')
  f.socket().event('message.complete', { text: 'Sample reply' }, 4)
  assert.equal((await f.run.next()).kind, 'done')
  assert.equal(f.identity.pendingSubmit, false)
})

test('ticket HTTP failures distinguish expired sign-in from server failure and discard forged errors', async t => {
  for (const status of [401, 403, 500, 503]) {
    const f = fixture(t, { status })
    await assert.rejects(f.wire.connect(), error => error.code === ([401, 403].includes(status) ? 'bot/hermes-auth' : 'bot/hermes-connection') && !error.stack.includes(f.credential) && !error.stack.includes(f.ticket))
    assert.equal(f.sent.length, 0)
  }
  for (const errorCode of ['bot/hermes', 'bot/hermes-auth', 'bot/hermes-timeout']) {
    const f = fixture(t, { authError: true, errorCode })
    await assert.rejects(f.wire.connect(), error => !error.stack.includes(f.credential) && !error.stack.includes(f.ticket))
    assert.equal(f.sent.length, 0)
  }
})

test('expired authentication and connection exceptions have distinct safe errors', async t => {
  for (const options of [{ expired: true }, { authError: true }]) {
    const f = fixture(t, options)
    await assert.rejects(f.wire.connect(), error => error.code === (options.expired ? 'bot/hermes-auth' : 'bot/hermes-connection') && (options.expired ? /credential|authentication/ : /could not connect/).test(error.message) && !error.stack.includes(f.credential) && !error.stack.includes(f.ticket))
    assert.equal(f.sent.length, 0)
  }
})

test('an older Desktop contract is too old, a newer one still chats, and a gateway that owns sessions is refused', async t => {
  for (const snapshot of [{ info: { desktop_contract: 7 } }, { info: {} }]) {
    const f = fixture(t, { snapshot }); await f.wire.connect()
    await assert.rejects(f.run.submit('Never sent'), error => error.code === 'bot/hermes-outdated' && /Update Hermes/.test(error.message))
    assert.ok(!f.sent.some(frame => frame.method === 'prompt.submit'))
  }
  // A contract difference that still lets chat work is not an error.
  const newer = fixture(t, { snapshot: { info: { desktop_contract: 9 } } }); await newer.wire.connect()
  await newer.run.submit('Sent')
  assert.equal(newer.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
  const gateway = fixture(t, { snapshot: { protocol: 'hermes-gateway-v1' } }); await gateway.wire.connect()
  await assert.rejects(gateway.run.submit('Never sent'), error => error.code === 'bot/hermes-unsupported' && /hermes serve/.test(error.message))
  assert.ok(!gateway.sent.some(frame => frame.method === 'prompt.submit'))
  const f = fixture(t, { ready: { session_authority: true } })
  await assert.rejects(f.wire.connect(), /gateway that owns its sessions/)
  assert.equal(f.sent.length, 0)
})

test('a Hermes that names no approval requests still connects: whether it asks is its own setting', async t => {
  const f = fixture(t, { handle: (frame, socket) => { if (frame.method !== 'client.capabilities') return false; queueMicrotask(() => socket.reply(frame, { server_requests: [] })); return true } })
  await f.wire.connect(); await f.run.submit('Sent')
  assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
})

test('unanswered startup and control requests are bounded', async t => {
  const f = fixture(t, { handle: frame => frame.method === 'client.capabilities' })
  f.wire.deadlines.control = 5
  await assert.rejects(f.wire.connect(), /control request/)
  assert.equal(f.wire.pending.size, 0)
  assert.deepEqual(HERMES_DEADLINES, { start: 60_000, control: 15_000, cancel: 5000 })
})

test('dropped submit acknowledgment is durable unknown and never automatically retried', async t => {
  const f = fixture(t, { handle: (frame, socket) => { if (frame.method !== 'prompt.submit') return false; queueMicrotask(() => socket.close()); return true } })
  await f.wire.connect()
  await assert.rejects(f.run.submit('Once only'), { message: LOST })
  assert.ok(f.identity.pendingSubmit && f.identity.uncertain)
  await assert.rejects(f.run.submit('Once only'), /Reconcile/)
  assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
  assert.ok(f.identities.at(-1).uncertain)
})

test('reconnect resumes stored ID, refreshes runtime ID and replaces a replay gap with snapshot', async t => {
  const f = fixture(t, { replay: { truncated: true, epoch: 'epoch-b', events: [{ type: 'message.delta', payload: { text: 'obsolete' } }] } })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: 'old-runtime', pendingSubmit: true, uncertain: true, epoch: 'epoch-a' })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.gap, true)
  assert.equal(result.unknown, false)
  assert.equal(f.identity.runtimeSessionId, f.snapshot.session_id)
  assert.equal(f.sent.find(frame => frame.method === 'session.resume').params.session_id, f.snapshot.stored_session_id)
  assert.equal(f.run.queue.length, 0)
  assert.ok(!f.sent.some(frame => frame.method === 'prompt.submit'))
})

test('attached reconcile flags an epoch gap with a pending submit and zero cursor', async t => {
  const f = fixture(t, {
    attached: true, ready: { replay_epoch: 'epoch-b' },
    replay: { epoch: 'epoch-b', latest_seq: 0 },
  })
  Object.assign(f.identity, {
    canonicalBot: true, storedSessionId: f.snapshot.stored_session_id,
    runtimeSessionId: f.snapshot.session_id, epoch: 'epoch-a', lastSeq: 0,
    pendingSubmit: true,
  })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.gap, true)
  assert.equal(f.identity.epoch, 'epoch-b')
  assert.equal(f.identity.lastSeq, 0)
  assert.ok(!f.sent.some(frame => frame.method === 'prompt.submit'))
})

test('attached reconcile flags an epoch gap with an uncertain turn and zero cursor', async t => {
  const f = fixture(t, {
    attached: true, ready: { replay_epoch: 'epoch-b' },
    replay: { epoch: 'epoch-b', latest_seq: 0 },
  })
  Object.assign(f.identity, {
    canonicalBot: true, storedSessionId: f.snapshot.stored_session_id,
    runtimeSessionId: f.snapshot.session_id, epoch: 'epoch-a', lastSeq: 0,
    uncertain: true,
  })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.gap, true)
  assert.equal(f.identity.epoch, 'epoch-b')
  assert.equal(f.identity.lastSeq, 0)
  assert.ok(!f.sent.some(frame => frame.method === 'prompt.submit'))
})

test('attached prepare has no epoch gap at zero cursor with nothing waiting', async t => {
  const f = fixture(t, {
    attached: true, ready: { replay_epoch: 'epoch-b' },
    replay: { epoch: 'epoch-b', latest_seq: 0 },
  })
  Object.assign(f.identity, {
    canonicalBot: true, storedSessionId: f.snapshot.stored_session_id,
    runtimeSessionId: f.snapshot.session_id, epoch: 'epoch-a', lastSeq: 0,
    pendingSubmit: false, uncertain: false,
  })
  await f.wire.connect()
  await f.run.prepare()
  assert.equal(f.run.joinGap, false)
  assert.deepEqual(f.run.takeRecovered(), [])
  assert.equal(f.identity.epoch, 'epoch-b')
  assert.equal(f.identity.lastSeq, 0)
})

test('attached prepare has no gap for a waiting turn in the same epoch and runtime', async t => {
  for (const waiting of ['pendingSubmit', 'uncertain']) {
    const f = fixture(t, { attached: true, replay: { epoch: 'epoch-a', latest_seq: 0 } })
    Object.assign(f.identity, {
      canonicalBot: true, storedSessionId: f.snapshot.stored_session_id,
      runtimeSessionId: f.snapshot.session_id, epoch: 'epoch-a', lastSeq: 0,
      [waiting]: true,
    })
    await f.wire.connect()
    await f.run.prepare()
    assert.equal(f.run.joinGap, false, waiting)
    assert.deepEqual(f.run.takeRecovered(), [], waiting)
    assert.equal(f.identity[waiting], true)
    assert.equal(f.identity.epoch, 'epoch-a')
    assert.equal(f.identity.runtimeSessionId, f.snapshot.session_id)
  }
})

test('a normal turn resets the watermark when an owned SSH backend starts a new replay epoch', async t => {
  const f = fixture(t, { ready: { replay_epoch: 'epoch-b' } })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: f.snapshot.session_id, lastSeq: 100, epoch: 'epoch-a', pendingSubmit: false })
  await f.wire.connect()
  await f.run.submit('Next ordinary turn')
  assert.equal(f.identity.epoch, 'epoch-b')
  assert.equal(f.identity.lastSeq, 0)
  f.socket().event('message.delta', { text: 'New epoch answer' }, 1)
  f.socket().event('message.complete', { text: 'New epoch answer', status: 'complete' }, 2)
  assert.deepEqual(await f.run.next(), { kind: 'text', text: 'New epoch answer' })
  assert.deepEqual(await f.run.next(), { kind: 'done' })
  assert.equal(f.identity.pendingSubmit, false)
  assert.equal(f.identity.lastSeq, 2)
  assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
})

test('ignored Stop stays unknown; an interrupt acknowledgment does not prove remote children ended', async t => {
  const f = fixture(t)
  await f.wire.connect(); await f.run.submit('Sample')
  await f.run.stop()
  assert.ok(f.identity.uncertain && f.identity.pendingSubmit)
  assert.ok(f.sent.some(frame => frame.method === 'session.interrupt'))
  assert.equal((await f.run.next()).text, LOST)
})

test('Auto is not a level of a Remote Hermes chat: its route has no Auto mark, so no judge is offered there', () => {
  // Auto is offered only for a model with a mark (auto.js autoOffer); a judge that answered a
  // Hermes question would answer for the person.
  assert.equal(markOf('hermes-remote/sample-model'), undefined)
  assert.equal(judgeOf(markOf('hermes-remote/sample-model')), undefined)
  assert.equal(routeOf('hermes-remote').connectedBy, 'hermes-remote')
})

test('no chat level answers a Hermes question for the person: an asking level uses the approval card, a never-ask level a chat question', async () => {
  const agent = { session: {} }
  const ask = async (policy, sandbox, preset, { card = 'allowed-once', pick = { selected: ['Allow once'] }, questions = true } = {}) => {
    const cards = [], asked = []
    const choice = await remoteApproval({ get: name => ({
      approval: { effectivePolicy: () => policy, request: async request => { cards.push(request); return card } },
      userQuestions: questions ? { ask: async request => { asked.push(request); if (pick instanceof Error) throw pick; return { answers: [{ id: request.questions[0].id, ...pick }] } } } : undefined,
      sandboxPolicy: { resolve: () => ({ mode: sandbox }) }, permissionPresets: { current: () => preset },
    })[name] }, agent, { request_id: 'question', command: 'sample command' })
    return { choice, cards: cards.length, asked }
  }
  // Every level that never asks, Full access included: the person is asked, and their answer is the answer.
  for (const [sandbox, preset] of [['danger-full-access', 'full'], ['read-only', 'read-only'], ['workspace-write', 'workspace-write'], ['danger-full-access', 'auto']]) {
    const yes = await ask('never', sandbox, preset)
    assert.deepEqual([yes.choice, yes.cards, yes.asked.length], ['once', 0, 1], `${preset}: allowed by the person`)
    const [question] = yes.asked[0].questions
    assert.equal(yes.asked[0].agent, agent)
    assert.equal(yes.asked[0].questions.length, 1)
    assert.equal(question.detail, 'sample command', 'the question says what Hermes asked')
    assert.deepEqual(question.options, [{ label: 'Allow once' }, { label: 'Deny' }])
    assert.deepEqual(question.intent, { kind: 'approval', approve: 'Allow once', reject: 'Deny', subject: { name: 'Remote Hermes' } })
    const no = await ask('never', sandbox, preset, { pick: { selected: ['Deny'] } })
    assert.deepEqual([no.choice, no.cards, no.asked.length], ['deny', 0, 1], `${preset}: refused by the person`)
  }
  // Only the person's own Allow is a yes: typed text, no pick, two picks or a closed question are not.
  for (const pick of [{ selected: [], custom: 'Allow once' }, { selected: [] }, { selected: ['Allow once', 'Deny'] }, { selected: ['Allow once'], custom: 'but not this' }, Error('Sample closed question')]) {
    assert.equal((await ask('never', 'danger-full-access', 'full', { pick })).choice, 'deny')
  }
  // With nobody to ask, nothing runs.
  assert.deepEqual(await ask('never', 'danger-full-access', 'full', { questions: false }), { choice: 'deny', cards: 0, asked: [] })
  assert.equal(await remoteApproval({ get: () => undefined }, undefined, { request_id: 'question' }), 'deny')
  // A level that asks keeps the chat's approval card.
  for (const [card, choice] of [['allowed-once', 'once'], ['allowed', 'once'], ['rejected', 'deny']]) {
    const shown = await ask('ask', 'workspace-write', 'manual', { card })
    assert.deepEqual([shown.choice, shown.cards, shown.asked.length], [choice, 1, 0], card)
  }
})

test('a failed Hermes chat question is denied and diagnosed without logging remote data', async () => {
  const secret = randomUUID()
  for (const [error, code] of [
    [new TypeError(secret), 'TypeError'],
    [Object.assign(Error(secret), { code: 'NO_PROVIDER' }), 'NO_PROVIDER'],
    [Object.assign(Error(secret), { name: secret, code: secret }), 'Error'],
  ]) {
    const warnings = []
    const ctx = {
      get: name => name === 'userQuestions' ? { ask: async () => { throw error } } : undefined,
      logger: { warn: (...args) => warnings.push(args) },
    }
    assert.equal(await remoteApproval(ctx, { session: { header: {} } }, { command: secret }), 'deny')
    assert.deepEqual(warnings, [['ds-bot: Remote Hermes question failed (%s); the remote tool was denied.', code]])
    assert.ok(!JSON.stringify(warnings).includes(secret), 'arbitrary error text and codes cannot echo remote data')
  }
  const ctx = { get: name => name === 'userQuestions' ? { ask: async () => { throw Error(secret) } } : undefined, logger: { warn() { throw Error('Sample logger failure') } } }
  assert.equal(await remoteApproval(ctx, { session: { header: {} } }, { command: secret }), 'deny', 'a broken logger cannot turn a denial into an uncaught error')
})

test('at a never-ask level Hermes’s question passes DSH’s real question service, and the person’s answer goes back', async t => {
  const ctx = new Context(), agent = { id: 'sample-agent', session: Session.create('sample-agent') }, requests = []
  let answer
  await ctx.plugin({ name: 'sample-agents', apply(child) { child.provide('agents'); child.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent], roots: () => [agent] }) } })
  await ctx.plugin(UserQuestionService)
  ctx.provide('approval'); ctx.set('approval', { effectivePolicy: () => 'never', request: async () => assert.fail('a never-ask level has no approval card') })
  ctx.on('user-questions/request', request => { requests.push(request); return answer(request) })
  const f = fixture(t)
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }],
    identity: () => f.identity, save: async () => {},
    open: async options => { await f.wire.connect(); return new RemoteChat(f.wire, options) },
  })
  t.after(() => adapter.dispose())
  const stream = adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: agent.session.id, messages: [{ role: 'user', content: 'Sample' }] }))
  const first = stream.next()
  await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the adapter to submit', first)
  const question = id => ({ jsonrpc: '2.0', id, method: 'approval', params: { session_id: f.identity.runtimeSessionId, request_id: `approval-${id}`, command: 'rm sample.txt', description: 'Delete sample.txt' } })
  const settle = async () => { for (let turn = 0; turn < 6; turn++) await new Promise(resolve => setImmediate(resolve)) }
  for (const [id, label, choice] of [['srq-yes', 'Allow once', 'once'], ['srq-no', 'Deny', 'deny']]) {
    answer = request => ({ answers: [{ id: request.questions[0].id, selected: [label] }] })
    f.socket().frame(question(id)); await settle()
    assert.deepEqual(f.sent.filter(frame => frame.id === id), [{ jsonrpc: '2.0', id, result: { choice } }], label)
  }
  // The real service took the request as an approval question: one question, two fixed answers.
  assert.equal(requests.length, 2)
  assert.equal(requests[0].agent, agent, 'the adapter passes the exact live registry agent, including its Session header')
  assert.equal(requests[0].agent.session.header, agent.session.header)
  assert.equal(requests[0].questions[0].intent.kind, 'approval')
  assert.equal(requests[0].questions[0].detail, 'Delete sample.txt')
  // A question Hermes withdraws closes in the chat, and a late answer is not sent.
  let late
  answer = request => new Promise(resolve => { late = { resolve, signal: request.signal } })
  f.socket().frame(question('srq-late')); await settle()
  assert.equal(late.signal.aborted, false)
  f.socket().event('request.cancel', { id: 'srq-late', method: 'approval', reason: 'timeout' })
  assert.equal(late.signal.aborted, true)
  late.resolve({ answers: [{ id: 'approval-srq-late', selected: ['Allow once'] }] }); await settle()
  assert.deepEqual(f.sent.filter(frame => frame.id === 'srq-late'), [])
  f.socket().event('message.complete', { text: 'Done' })
  await first
  const chunks = await Array.fromAsync(stream)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a Hermes approval question waits for the person: no deadline answers for them, and the answer goes back once', async t => {
  const asked = []
  const f = fixture(t, { question: (params, withdrawn) => new Promise(resolve => asked.push({ params, withdrawn, resolve })) })
  f.wire.deadlines.control = 5
  await f.wire.connect(); await f.run.prepare()
  const question = id => ({ jsonrpc: '2.0', id, method: 'approval', params: { session_id: f.identity.runtimeSessionId, request_id: `approval-${id}`, command: 'sample command', choices: ['once', 'deny'] } })
  f.socket().frame(question('srq-a')); f.socket().frame(question('srq-a'))
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(asked.length, 1, 'a repeated question is asked once')
  assert.equal(asked[0].params.command, 'sample command')
  assert.deepEqual(f.sent.filter(frame => frame.id === 'srq-a'), [], 'well past the control deadline, nothing was answered for the person')
  asked[0].resolve('once'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.sent.filter(frame => frame.id === 'srq-a'), [{ jsonrpc: '2.0', id: 'srq-a', result: { choice: 'once' } }])
  f.socket().frame(question('srq-b')); await new Promise(resolve => setImmediate(resolve))
  asked[1].resolve('deny'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.sent.filter(frame => frame.id === 'srq-b'), [{ jsonrpc: '2.0', id: 'srq-b', result: { choice: 'deny' } }])
  // Hermes withdraws a question: the card is told, and a late answer is not sent.
  f.socket().frame(question('srq-c')); await new Promise(resolve => setImmediate(resolve))
  assert.equal(asked[2].withdrawn.aborted, false)
  f.socket().event('request.cancel', { id: 'srq-c', method: 'approval', reason: 'timeout' })
  assert.equal(asked[2].withdrawn.aborted, true)
  asked[2].resolve('once'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.sent.filter(frame => frame.id === 'srq-c'), [])
  assert.ok(!f.sent.some(frame => /approval.*(mode|set)|config\.set/.test(frame.method ?? '')), 'Hermes’s own settings are never changed')
})

test('a Hermes approval question reaches the chat’s approval card and the person’s answer goes back', async t => {
  for (const [outcome, choice] of [['allowed-once', 'once'], ['rejected', 'deny']]) {
    const requests = [], agent = { session: {} }
    const ctx = { get: name => ({ approval: { effectivePolicy: () => 'ask', request: async request => { requests.push(request); return outcome } }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, permissionPresets: { current: () => 'workspace-write' } })[name] }
    const f = fixture(t, { question: (params, withdrawn) => remoteApproval(ctx, agent, params, withdrawn) })
    await f.wire.connect(); await f.run.prepare()
    f.socket().frame({ jsonrpc: '2.0', id: 'srq-card', method: 'approval', params: { session_id: f.identity.runtimeSessionId, request_id: 'approval-card', command: 'rm sample.txt', description: 'Delete sample.txt' } })
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].agent, agent)
    assert.match(requests[0].reason, /Delete sample\.txt/, 'the card says what Hermes asked')
    assert.equal(requests[0].callId, 'approval-card')
    assert.ok(requests[0].signal instanceof AbortSignal)
    assert.deepEqual(f.sent.filter(frame => frame.id === 'srq-card'), [{ jsonrpc: '2.0', id: 'srq-card', result: { choice } }], outcome)
  }
})

test('redaction covers ticket/token echoes, nested headers, URL and JSON forms, RPC failures', async t => {
  const f = fixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'sample') return false
    queueMicrotask(() => socket.frame({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: `${f.credential} ${f.ticket}`, data: { Authorization: f.credential } } }))
    return true
  } })
  await f.wire.connect()
  const redacted = JSON.stringify(f.wire.redact({ text: `${f.credential} ${f.ticket}`, headers: { Authorization: f.credential }, nested: [{ ticket: f.ticket }] }))
  assert.ok(!redacted.includes(f.credential) && !redacted.includes(f.ticket))
  await assert.rejects(f.wire.request('sample'), error => !error.stack.includes(f.credential) && !error.stack.includes(f.ticket))
})

test('DSH adapter produces a real mirror tool card then continues the same remote turn', async t => {
  const f = fixture(t)
  const registered = []
  const agent = { session: { id: 'sample-chat' }, ctx: { tools: { register: tool => { registered.push(tool); return () => {} } } } }
  const rt = { ctx: { get: name => name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined, on() {} } }
  const adapter = new RemoteChatAdapter(rt, { enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }], identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run } })
  t.after(() => adapter.dispose())
  const options = markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: [{ role: 'user', content: 'Sample' }] })
  const stream = adapter.stream(options)
  const first = stream.next()
  await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the prompt to be submitted', first)
  f.socket().event('tool.start', { tool_id: 'sample-tool', name: 'Sample tool', args: {} })
  const chunks = [(await first).value]
  for await (const chunk of stream) chunks.push(chunk)
  const call = chunks.find(chunk => chunk.type === 'block-end').block
  assert.equal(call.type, 'tool-call')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  const execution = registered[0].execute({ id: 'sample-tool', title: 'Sample tool' }, { agent })
  f.socket().event('tool.complete', { tool_id: 'sample-tool', name: 'sample', result_text: 'Sample result' })
  assert.equal((await execution).text, 'Sample result')
  f.socket().event('message.delta', { text: 'After tool' })
  f.socket().event('message.complete', { text: 'After tool' })
  const next = markAgentLoopRequest({ ...options, messages: [{ role: 'tool', toolCallId: call.id, content: 'Sample result' }] })
  const continued = []
  for await (const chunk of adapter.stream(next)) continued.push(chunk)
  assert.equal(continued.find(chunk => chunk.type === 'text-delta').text, 'After tool')
  assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
})

test('a file copy path that changes between asks does not refuse the turn', async t => {
  // #1340: the guard rebuilds the Session's projection, and the attachment service may name a
  // different copy on each call. The path is a handle to the same durable bytes, so the turn
  // must still be accepted; everything else about the handle and the text stays exact.
  const ref = Object.freeze({ attachmentId: `sha256:${'a'.repeat(64)}`, name: 'sample.txt', bytes: 3 })
  const fileMessage = Object.freeze({ role: 'user', id: 'm-2', content: Object.freeze([Object.freeze({ type: 'file', attachment: ref })]) })
  const messages = Object.freeze([
    Object.freeze({ role: 'user', id: 'm-1', content: Object.freeze([Object.freeze({ type: 'text', text: 'read this' })]) }),
    fileMessage,
  ])
  let calls = 0
  const ctx = new Context()
  ctx.provide('attachments'); ctx.set('attachments', { fileHostPath: ref => `/tmp/hermes-copy-${++calls}/${ref.attachmentId.slice(7, 15)}` })
  ctx.provide('fs'); ctx.set('fs', { processPathFromHostPath: path => path })
  const adapter = new RemoteChatAdapter({ ctx }, { enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }], identity: () => ({ createKey: randomUUID() }), save: async () => {}, open: async () => { throw Error('not opened') } })
  t.after(() => adapter.dispose())
  const session = { deriveMessages: () => [...messages], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) }
  const agent = { id: 'sample-chat', session }
  const dispatched = deepFreeze(projectFilesToText([...messages], () => '/tmp/hermes-copy-dispatched/sha256'))
  const envelope = Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: dispatched })
  assert.equal(RemoteChatAdapter.ownTurn(envelope, agent, ref => adapter.filePath(ref)), true)
  // A different durable file under the same shape is still not this turn.
  const other = deepFreeze(projectFilesToText([...messages], () => '/tmp/hermes-copy-dispatched/sha256').map(projected => projected.role === 'user' && projected.id === 'm-2'
    ? { ...projected, content: projected.content.map(block => block.type === 'text' ? { ...block, text: block.text.replace(ref.attachmentId.slice(7, 15), 'b'.repeat(16)) } : block) }
    : projected))
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ ...envelope, messages: other }), agent, ref => adapter.filePath(ref)), false)
})

test('a projected agent-loop request still answers, and a hand-built call is still refused', async t => {
  const f = fixture(t)
  const ctx = new Context(), runtime = new LlmRuntime(ctx)
  // The Session's own messages: a person's message, an earlier file, and the developer note
  // DSH writes when a Bot's tool set changes between releases. This is a carried-over chat.
  const fileMessage = Object.freeze({ role: 'user', id: 'm-2', content: Object.freeze([Object.freeze({ type: 'file', attachment: Object.freeze({ attachmentId: 'a-1', name: 'sample.txt', bytes: 3 }) })]) })
  const messages = Object.freeze([
    Object.freeze({ role: 'user', id: 'm-1', content: Object.freeze([Object.freeze({ type: 'text', text: 'say OK' })]) }),
    fileMessage,
    Object.freeze({ role: 'developer', id: 'dev-tools', content: Object.freeze([{ type: 'tool-addition', toolName: 'sample' }]) }),
  ])
  const filePath = ref => `/tmp/${ref.attachmentId}`
  // The live Session's own file read path, as the runtime projects a file to text.
  ctx.provide('attachments'); ctx.set('attachments', { fileHostPath: ref => `/tmp/${ref.attachmentId}` })
  ctx.provide('fs'); ctx.set('fs', { processPathFromHostPath: path => path })
  const session = { deriveMessages: () => [...messages], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) }
  const agent = { id: 'sample-chat', session }
  ctx.provide('agents'); ctx.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] })
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }],
    identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run },
  })
  t.after(() => adapter.dispose())
  runtime.registerAdapter(['hermes-remote'], adapter)
  const request = markAgentLoopRequest(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages, tools: Object.freeze([]), signal: new AbortController().signal }))
  const stream = runtime.stream(request)
  const first = stream.next()
  await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the prompt to be submitted', first)
  f.socket().event('message.complete', { text: 'OK' })
  const chunks = [(await first).value]
  for await (const chunk of stream) chunks.push(chunk)
  // DSH projected the developer note away and dispatched a copy; the Bot's turn still ran.
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'OK')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // The same chat called by hand beside the loop: new messages, not the Session's own.
  const stray = []
  for await (const chunk of adapter.stream({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: [{ role: 'user', content: 'hand built' }] })) stray.push(chunk)
  assert.equal(stray.at(-1).reason.failure.code, 'REMOTE_HERMES')
  assert.equal(stray.at(-1).reason.failure.message, 'Remote Hermes answers only enabled Bot chat sessions.')
  // A frozen envelope with new messages is still not the Session's turn.
  const forged = []
  for await (const chunk of adapter.stream(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([{ role: 'user', content: 'hand built' }]) }))) forged.push(chunk)
  assert.equal(forged.at(-1).reason.failure.code, 'REMOTE_HERMES')
  // The loop's own sequence, developer note aside and the file projected, is the accepted envelope.
  const projected = deepFreeze(projectFilesToText([messages[0], fileMessage], filePath))
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze(projected) }), agent, filePath), true)
  // The same id with new text is a different message, and never the turn.
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([Object.freeze({ role: 'user', id: 'm-1', content: Object.freeze([{ type: 'text', text: 'send something else' }]) }), projected[1]]) }), agent, filePath), false)
  // A rebuilt file message with different text is not the projection either.
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([projected[0], Object.freeze({ role: 'user', id: 'm-2', content: Object.freeze([{ type: 'text', text: 'different' }]) })]) }), agent, filePath), false)
  // An old subset that ends on an earlier prompt is not the current turn either.
  const older = Object.freeze({ role: 'user', id: 'm-0', content: 'an earlier prompt' })
  const agent2 = { id: 'sample-chat', session: { deriveMessages: () => [older, messages[0]], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) } }
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([older]) }), agent2), false)
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([older, messages[0]]) }), agent2), true)
  // A hand-built call beside the turn is never one.
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', purpose: 'compaction', messages: Object.freeze(projected) }), agent, filePath), false)
})

test('a carried-over chat keeps its old Hermes ref and the attach row answers through the guard', async t => {
  // The Bot moved to the attached serve's one row, but its Session still names the old
  // nous ref. Because it is kept (models.js applyModel), the request and the header agree;
  // #1334's exact-route guard accepts it, and the attach transport serves its one row
  // whatever the ref. Both a short and a long carried-over history dispatch.
  for (const count of [1, 400]) {
    const f = fixture(t, { attached: true })
    const messages = Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({ role: 'user', id: `m-${index}`, content: `message ${index}` })))
    const session = { id: 'sample-chat', deriveMessages: () => [...messages], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' } }) }
    const agent = { id: 'sample-chat', session }
    const ctx = new Context()
    ctx.provide('agents'); ctx.set('agents', { get: id => (id === agent.id ? agent : undefined), list: () => [agent] })
    const adapter = new RemoteChatAdapter({ ctx }, {
      enabled: () => true,
      models: () => [{ id: 'attach', name: 'gpt-6-astra (openai-codex)', provider: 'hermes-remote', model: 'gpt-6-astra', providerId: 'openai-codex', contextWindow: 200_000 }],
      identity: () => ({ ...f.identity, canonicalBot: true }),
      save: async () => {},
      attached: () => true,
      open: async () => {
        await f.wire.connect()
        return new RemoteChat(f.wire, { identity: { canonicalBot: true }, save: async () => {} })
      },
    })
    t.after(() => adapter.dispose())
    const runtime = new LlmRuntime(ctx)
    runtime.registerAdapter(['hermes-remote'], adapter)
    const request = Object.freeze({ provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra', sessionId: 'sample-chat', messages })
    assert.equal(RemoteChatAdapter.ownTurn(request, agent), true, `the exact-route guard accepts the carried-over header (${count} messages)`)
    // Same provider, another model: not this turn and never dispatched.
    assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ ...request, model: 'nous:openai/another-model' }), agent), false)
    const stream = runtime.stream(markAgentLoopRequest(Object.freeze({ ...request, tools: Object.freeze([]), signal: new AbortController().signal })))
    const first = stream.next()
    await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the carried-over prompt to be submitted', first)
    f.socket().event('message.complete', { text: 'OK' })
    const chunks = [(await first).value]
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'OK')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  }
})

test('the attach row prices a model switch through resolveModel, also for a carried ref', async () => {
  const attached = new RemoteChatAdapter({ ctx: new Context() }, {
    enabled: () => true,
    models: () => [{ id: 'attach', name: 'gpt-6-astra (openai-codex)', provider: 'hermes-remote', model: 'gpt-6-astra', providerId: 'openai-codex', contextWindow: 200_000 }],
    attached: () => true,
    identity: () => ({}), save: async () => {}, open: async () => { throw new Error('not opened') },
  })
  const row = await attached.resolveModel('hermes-remote', 'attach')
  assert.equal(row.context.contextWindow, 200_000)
  // A carried-over ref is served by that one row, so the guard can price it too.
  const carried = await attached.resolveModel('hermes-remote', 'nous:openai/gpt-6-astra')
  assert.equal(carried.context.contextWindow, 200_000)
  // A non-attached adapter has no row for a ref it was not given.
  const remote = new RemoteChatAdapter({ ctx: new Context() }, {
    enabled: () => true, models: () => [{ id: 'model', name: 'Model', provider: 'hermes-remote', model: 'model', contextWindow: 1000 }],
    attached: () => false, identity: () => ({}), save: async () => {}, open: async () => { throw new Error('not opened') },
  })
  assert.equal((await remote.resolveModel('hermes-remote', 'other')).context, undefined)
})

test('the guard refuses an unfrozen, misrouted or extra-message envelope, and accepts a rebuilt foreign answer', async t => {
  const f = fixture(t)
  const ctx = new Context(), runtime = new LlmRuntime(ctx)
  // An answer from another adapter that carries replay state: DSH rebuilds its source for
  // this adapter (the content stays), which is still the Session's own turn.
  const user = Object.freeze({ role: 'user', id: 'm-1', content: 'say OK' })
  const foreign = Object.freeze({ role: 'assistant', id: 'm-2', content: Object.freeze([{ type: 'text', text: 'Earlier answer' }]), source: Object.freeze({ kind: 'model', provider: 'other', model: 'other-model', replayState: Object.freeze({ opaque: 'state' }) }) })
  const latest = Object.freeze({ role: 'user', id: 'm-3', content: Object.freeze([{ type: 'text', text: 'say OK' }]) })
  const session = { deriveMessages: () => [user, foreign, latest], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) }
  const agent = { id: 'sample-chat', session }
  ctx.provide('agents'); ctx.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] })
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }],
    identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run },
  })
  t.after(() => adapter.dispose())
  runtime.registerAdapter(['hermes-remote'], adapter)
  const request = markAgentLoopRequest(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([user, foreign, latest]), tools: Object.freeze([]), signal: new AbortController().signal }))
  const stream = runtime.stream(request)
  const first = stream.next()
  await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the prompt to be submitted', first)
  f.socket().event('message.complete', { text: 'OK' })
  const chunks = [(await first).value]
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const envelope = (replacement) => Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze(replacement) })
  // An unfrozen envelope is never the loop's own turn.
  assert.equal(RemoteChatAdapter.ownTurn({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: [user, foreign, latest] }, agent), false)
  // The right messages on another route are not this Session's turn.
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'another', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([user, foreign, latest]) }), agent), false)
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'another-model', sessionId: 'sample-chat', messages: Object.freeze([user, foreign, latest]) }), agent), false)
  // The Session's messages plus a new prompt are not the turn either.
  assert.equal(RemoteChatAdapter.ownTurn(envelope([user, foreign, latest, Object.freeze({ role: 'user', id: 'm-4', content: Object.freeze([Object.freeze({ type: 'text', text: 'and this too' })]) })]), agent), false)
  // A content array that answers a toJSON read with the Session's text is not plain data.
  const real = Object.freeze([Object.freeze({ type: 'text', text: 'say OK' })])
  const toJSON = Object.freeze(Object.assign([Object.freeze({ type: 'text', text: 'made up' })], { toJSON: () => real }))
  assert.equal(RemoteChatAdapter.ownTurn(envelope([Object.freeze({ role: 'user', id: 'm-1', content: toJSON }), foreign, latest]), agent), false)
  // A getter on content can change between the guard's read and the adapter's read.
  const getter = Object.freeze(Object.defineProperty({ role: 'user', id: 'm-1' }, 'content', { get: () => real, enumerable: true }))
  assert.equal(RemoteChatAdapter.ownTurn(envelope([getter, foreign, latest]), agent), false)
  // A Proxy could say one thing and do another.
  const proxy = new Proxy(Object.freeze({ role: 'user', id: 'm-1', content: real }), {})
  assert.equal(RemoteChatAdapter.ownTurn(envelope([proxy, foreign, latest]), agent), false)
  // Relabelling the foreign answer's source would drop it from the request.
  assert.equal(RemoteChatAdapter.ownTurn(envelope([user, Object.freeze({ ...foreign, source: Object.freeze({ kind: 'acp-session' }) }), latest]), agent), false)
  // A flipped toolCallId would end a live remote turn on the wrong call.
  const tool = Object.freeze({ role: 'tool', toolCallId: 'call-a', content: Object.freeze([Object.freeze({ type: 'text', text: 'result' })]) })
  const agent3 = { id: 'sample-chat', session: { deriveMessages: () => [user, tool], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) } }
  assert.equal(RemoteChatAdapter.ownTurn(envelope([user, tool]), agent3), true)
  assert.equal(RemoteChatAdapter.ownTurn(envelope([user, Object.freeze({ ...tool, toolCallId: 'call-b' })]), agent3), false)
})

test('each hardening check is pinned by a forgery equal to the Session message', async t => {
  const f = fixture(t)
  const ctx = new Context(), runtime = new LlmRuntime(ctx)
  const real = Object.freeze([Object.freeze({ type: 'text', text: 'say OK' })])
  const user = Object.freeze({ role: 'user', id: 'm-1', content: real })
  const session = { deriveMessages: () => [user], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) }
  const agent = { id: 'sample-chat', session }
  ctx.provide('agents'); ctx.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] })
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }],
    identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run },
  })
  t.after(() => adapter.dispose())
  runtime.registerAdapter(['hermes-remote'], adapter)
  const envelope = messages => Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze(messages) })
  // The plain Session message itself is still the turn.
  assert.equal(RemoteChatAdapter.ownTurn(envelope([user]), agent), true)
  // Every forgery below is equal to `user` in every value; only its one property kind differs.
  const toJSON = Object.freeze(Object.defineProperty([Object.freeze({ type: 'text', text: 'say OK' })], 'toJSON', { value: () => real, enumerable: false }))
  assert.equal(RemoteChatAdapter.ownTurn(envelope([Object.freeze({ role: 'user', id: 'm-1', content: toJSON })]), agent), false)
  const getter = Object.freeze(Object.defineProperty({ role: 'user', id: 'm-1' }, 'content', { get: () => real, enumerable: true }))
  assert.equal(RemoteChatAdapter.ownTurn(envelope([getter]), agent), false)
  // The trap answers the guard's reads with the Session's text and the adapter's read with other text.
  let reads = 0
  const proxy = new Proxy(user, { get(target, key, receiver) {
    if (key !== 'content') return Reflect.get(target, key, receiver)
    reads += 1
    return reads <= 2 ? real : Object.freeze([Object.freeze({ type: 'text', text: 'made up' })])
  } })
  assert.equal(RemoteChatAdapter.ownTurn(envelope([proxy]), agent), false)
  // Frozen message, unfrozen content: the value could change after the guard.
  const unfrozen = Object.freeze({ role: 'user', id: 'm-1', content: [Object.freeze({ type: 'text', text: 'say OK' })] })
  assert.equal(RemoteChatAdapter.ownTurn(envelope([unfrozen]), agent), false)
})

test('a plain-data toJSON key in history is ordinary data; a function toJSON is still refused', async t => {
  const f = fixture(t)
  const ctx = new Context(), runtime = new LlmRuntime(ctx)
  // A tool call in history whose arguments carry an ordinary JSON key named toJSON.
  const call = Object.freeze({ role: 'assistant', id: 'a-1', content: Object.freeze([Object.freeze({ type: 'tool-call', id: 'call-1', name: 'sample', arguments: Object.freeze({ toJSON: 'x', nested: Object.freeze({ toJSON: 1 }) }) })]), source: Object.freeze({ kind: 'model', provider: 'hermes-remote', model: 'sample:model' }) })
  const user = Object.freeze({ role: 'user', id: 'm-1', content: Object.freeze([Object.freeze({ type: 'text', text: 'say OK' })]) })
  const messages = Object.freeze([call, user, Object.freeze({ role: 'developer', id: 'dev-tools', content: Object.freeze([Object.freeze({ type: 'tool-addition', toolName: 'sample' })]) })])
  const session = { deriveMessages: () => [...messages], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) }
  const agent = { id: 'sample-chat', session }
  ctx.provide('agents'); ctx.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] })
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }],
    identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run },
  })
  t.after(() => adapter.dispose())
  runtime.registerAdapter(['hermes-remote'], adapter)
  const request = markAgentLoopRequest(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages, tools: Object.freeze([]), signal: new AbortController().signal }))
  const stream = runtime.stream(request)
  const first = stream.next()
  await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the prompt to be submitted', first)
  f.socket().event('message.complete', { text: 'OK' })
  const chunks = [(await first).value]
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'OK')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // A function toJSON is not data: JSON.stringify would call it, so it stays refused.
  const evil = Object.freeze(Object.defineProperty([Object.freeze({ type: 'text', text: 'say OK' })], 'toJSON', { value: () => [], enumerable: false }))
  const evilUser = Object.freeze({ role: 'user', id: 'm-1', content: evil })
  const evilAgent = { id: 'sample-chat', session: { deriveMessages: () => [evilUser], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) } }
  assert.equal(RemoteChatAdapter.ownTurn(Object.freeze({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: Object.freeze([evilUser]) }), evilAgent), false)
})

test('each request field must be own data: an equal-value accessor envelope is refused', async t => {
  const f = fixture(t)
  const ctx = new Context(), runtime = new LlmRuntime(ctx)
  const real = Object.freeze([Object.freeze({ type: 'text', text: 'say OK' })])
  const user = Object.freeze({ role: 'user', id: 'm-1', content: real })
  const session = { deriveMessages: () => [user], requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'sample:model' } }) }
  const agent = { id: 'sample-chat', session }
  ctx.provide('agents'); ctx.set('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] })
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }],
    identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run },
  })
  t.after(() => adapter.dispose())
  runtime.registerAdapter(['hermes-remote'], adapter)
  const base = () => ({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: [user], tools: Object.freeze([]) })
  const plain = Object.freeze({ ...base(), messages: Object.freeze([user]) })
  assert.equal(RemoteChatAdapter.ownTurn(plain, agent), true)
  // Every accessor below answers the same value as the plain envelope; only its kind differs.
  const withAccessor = (name, value) => {
    const envelope = base()
    Object.defineProperty(envelope, name, { get: () => value, enumerable: true, configurable: true })
    return Object.freeze(envelope)
  }
  for (const [name, value] of [['provider', 'hermes-remote'], ['model', 'sample:model'], ['sessionId', 'sample-chat'], ['purpose', undefined], ['messages', Object.freeze([user])]]) {
    assert.equal(RemoteChatAdapter.ownTurn(withAccessor(name, value), agent), false, `a ${name} accessor is not own data`)
  }
  // The envelope itself cannot be a Proxy answering as the plain one.
  assert.equal(RemoteChatAdapter.ownTurn(new Proxy(plain, {}), agent), false)
  // A Session header that throws refuses instead of escaping the guard.
  const throwing = { id: 'sample-chat', session: { requestHeader: () => { throw new Error('sample') }, deriveMessages: () => [user] } }
  assert.equal(RemoteChatAdapter.ownTurn(plain, throwing), false)
  // The stream refuses those envelopes too and never submits to the remote.
  for (const envelope of [withAccessor('messages', Object.freeze([user])), withAccessor('model', 'sample:model')]) {
    const chunks = []
    for await (const chunk of adapter.stream(envelope)) chunks.push(chunk)
    assert.equal(chunks.at(-1).reason.failure.code, 'REMOTE_HERMES')
    assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 0)
  }
})

test('connection is off by default, record stores a reference and credential stays mode 0600', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-fixture-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(() => ctx.dispose())
  await rt.load(); await rt.loadSecrets()
  assert.equal(rt.hermesRemote.view().enabled, false)
  const credential = randomUUID()
  await rt.hermesRemote.configure({ enabled: true, address: `https://${randomUUID()}.invalid`, profile: 'sample', credential })
  const stored = await readFile(join(home, 'state.json'), 'utf8')
  assert.ok(!stored.includes(credential))
  assert.equal((await stat(join(home, 'secrets.json'))).mode & 0o777, 0o600)
  assert.ok((await readFile(join(home, 'secrets.json'), 'utf8')).includes(credential))
  assert.equal(rt.canUseSecret('HERMES_REMOTE_CREDENTIAL', 'sample-chat'), false)
})

test('remote route crosses from Native and local ACP Hermes; changing only its model does not', () => {
  assert.equal(selectorRouteOf('hermes-remote'), 'hermes-remote')
  assert.deepEqual(routeOf('hermes-remote'), { harness: 'hermes', connectedBy: 'hermes-remote' })
  assert.equal(crossesHarness('acp-hermes/default', 'hermes-remote/sample:model'), true)
  assert.equal(crossesHarness('native/sample', 'hermes-remote/sample:model'), true)
  assert.equal(crossesHarness('hermes-remote/sample:a', 'hermes-remote/sample:b'), false)
})

test('release contract diff follows generated schemas and detects drift without a network', () => {
  const contract = { methods: USED_METHODS.map(name => ({ name, result: { schema: { $ref: '#/components/schemas/Sample' } } })), components: { schemas: { Sample: { type: 'string' } } },
    'x-server-requests': [{ name: 'approval' }], 'x-notifications': ['gateway.ready', 'session.info', 'message.start', 'message.delta', 'message.interim', 'message.complete', 'tool.start', 'tool.complete', 'request.cancel', 'error'].map(name => ({ name })) }
  const before = contractPin(contract)
  contract.components.schemas.Sample.type = 'number'
  assert.deepEqual(differences(before, contractPin(contract)), ['schema:Sample'])
})

test('final-only text is visible and terminal failure and interruption never become success', async t => {
  for (const status of ['complete', 'error', 'interrupted']) {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    f.socket().event('message.complete', { text: 'Final-only sample', status })
    assert.deepEqual(await f.run.next(), { kind: 'text', text: 'Final-only sample' })
    assert.equal((await f.run.next()).kind, status === 'complete' ? 'done' : status === 'error' ? 'error' : 'aborted')
    assert.equal(f.identity.pendingSubmit, false)
  }
})

test('a remote error event shows the remote reason, redacted, instead of the fixed sentence', async t => {
  for (const reason of ['Provider nous is not signed in on the remote. Sign in there, then try again.', 'The saved provider session expired.']) {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    f.socket().event('error', { message: reason }, 1)
    assert.deepEqual(await f.run.next(), { kind: 'error', text: `Remote Hermes reported a turn failure: ${reason}` })
  }
  // The contract's one field is `message`; a detail under that name is shown the same way.
  const f = fixture(t)
  await f.wire.connect(); await f.run.submit('Sample')
  f.socket().event('error', { detail: 'The remote could not start the assistant for this model.' }, 1)
  assert.equal((await f.run.next()).text, 'Remote Hermes reported a turn failure: The remote could not start the assistant for this model.')
})

test('a remote error reason never carries the connection secrets or a provider key', async t => {
  const f = fixture(t)
  const key = 'sk-live-A1b2C3d4E5f6G7h8'
  await f.wire.connect(); await f.run.submit('Sample')
  f.socket().event('error', { message: `Provider refused ${f.credential}, ticket ${f.ticket}, key ${key}.` }, 1)
  const row = await f.run.next()
  assert.equal(row.kind, 'error')
  assert.ok(row.text.includes('[redacted]') && row.text.includes('sk-[hidden]'))
  assert.ok(!row.text.includes(f.credential) && !row.text.includes(f.ticket) && !row.text.includes(key))
})

test('a remote reason masks key material, long tokens and home-folder paths on both failure paths', async t => {
  const shapes = [
    {
      what: 'a private key block',
      // Made-up material: a marker pair and a base64 body, not a real key.
      text: 'The remote key is -----BEGIN OPENSSH PRIVATE KEY-----\nAAAAb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY----- and it failed.',
      gone: ['OPENSSH PRIVATE KEY', 'AAAAb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ=='],
      kept: '[key]',
    },
    {
      what: 'a long opaque token',
      text: 'The provider rejected wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY for this turn.',
      gone: ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
      kept: '[hidden]',
    },
    {
      what: 'a home-folder path naming the remote user',
      text: 'The remote could not read /home/sample-person/.hermes/config.yaml for this session.',
      gone: ['sample-person', '/home/'],
      kept: '~/.hermes/config.yaml',
    },
  ]
  for (const shape of shapes) {
    for (const failed of ['error', 'complete']) {
      const f = fixture(t)
      await f.wire.connect(); await f.run.submit('Sample')
      if (failed === 'error') f.socket().event('error', { message: shape.text }, 1)
      else f.socket().event('message.complete', { status: 'error', text: '', failure_reason: shape.text }, 1)
      const shown = (await f.run.next()).text
      assert.ok(shown.includes(shape.kept), `${failed}: ${shape.what} is masked: ${shown}`)
      for (const secret of shape.gone) assert.ok(!shown.includes(secret), `${failed}: ${shape.what} keeps ${secret}: ${shown}`)
      assert.ok(!shown.includes('\n'), `${failed}: ${shape.what} is one line`)
    }
  }
})

test('a remote error reason is one line of at most 500 characters', async t => {
  for (const [reason, prefix] of [
    [`${'sign in again '.repeat(60)}\nsecond line ${'x'.repeat(800)}`, 'sign in again '],
    // The newline is inside the first 500 characters: only the whitespace collapse removes it.
    [`The remote said it could not sign in.\n${'word '.repeat(200)}`, 'The remote said it could not sign in. word'],
  ]) {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    f.socket().event('error', { message: reason }, 1)
    const row = await f.run.next()
    const detail = row.text.slice('Remote Hermes reported a turn failure: '.length)
    assert.equal(row.kind, 'error')
    assert.ok(detail.length <= 500)
    assert.ok(detail.endsWith('…'))
    assert.ok(!detail.includes('\n'))
    assert.ok(detail.startsWith(prefix))
  }
})

test('a remote error with no usable reason keeps the fixed sentence', async t => {
  const fixed = 'Remote Hermes reported a turn failure. Inspect the remote session before sending again.'
  for (const payload of [{}, { message: '' }, { message: ' \n\t ' }, { message: 42 }, { detail: null }]) {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    f.socket().event('error', payload, 1)
    assert.deepEqual(await f.run.next(), { kind: 'error', text: fixed })
  }
})

test('a failed final message shows its reason and falls back to the fixed sentence', async t => {
  const fixed = 'Remote Hermes reported a failed turn. Review the remote session.'
  for (const [payload, text] of [
    [{ status: 'error', text: '', error: 'Provider sign-in expired on the remote.' }, 'Remote Hermes reported a failed turn: Provider sign-in expired on the remote.'],
    [{ status: 'error', text: '', failure_reason: 'billing_wall' }, 'Remote Hermes reported a failed turn: billing_wall'],
    [{ status: 'error', text: '' }, fixed],
  ]) {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    f.socket().event('message.complete', payload, 1)
    assert.deepEqual(await f.run.next(), { kind: 'error', text })
  }
})

test('Settings reconciliation observes pending approvals without answering them', async t => {
  const f = fixture(t, { snapshot: { running: true, open_requests: [{ id: 'srq-pending', method: 'approval', params: { session_id: 'sample-runtime', request_id: 'pending' } }] } })
  f.identity.storedSessionId = f.snapshot.stored_session_id
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.unknown, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!f.sent.some(frame => frame.id === 'srq-pending'))
})

test('real adapter signal Stop keeps socket open for interrupt and honours the cancel grace', async t => {
  const f = fixture(t)
  const agent = { session: { id: 'sample-stop' }, ctx: { tools: { register: () => () => {} } } }
  const ctx = fakeContext({ services: { agents: { get: () => agent, list: () => [agent] } } })
  ctx.llm.registerAdapter = () => () => {}
  const rt = { ctx, state: { prefs: { hermesRemote: { enabled: true, address: f.wire.address, profile: 'sample', credentialRef: 'SAMPLE', models: [{ id: 'sample:model', model: 'model', provider: 'sample' }] } } },
    hooks: { endpoint() {} }, load: async () => {}, save: async () => {}, loadSecrets: async () => {}, secretValue: () => f.credential }
  install(rt, { transport: () => f.wire })
  t.after(() => ctx.dispose())
  const controller = new AbortController()
  const stream = rt.hermesRemote.adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: agent.session.id, signal: controller.signal, messages: [{ role: 'user', content: 'Sample' }] }))
  const first = stream.next()
  await until(() => f.sent.some(frame => frame.method === 'prompt.submit'), 'the prompt to be submitted', first)
  controller.abort()
  await first
  await stream.return()
  assert.ok(f.sent.some(frame => frame.method === 'session.interrupt'))
  assert.ok(rt.state.hermesSessions[agent.session.id].uncertain)
})

test('an uncertain remote turn never falls back to another model', () => {
  assert.equal(fallbackFor({ failure: { code: 'REMOTE_HERMES', message: LOST }, failed: { provider: 'hermes-remote', model: 'sample' }, fallback: { provider: 'native', model: 'sample' } }), undefined)
})

test('a paired Bot Chat opens on whatever Hermes runs: no approval setting is read, required or waited for', async t => {
  for (const info of [{ approval_mode: 'off', yolo: true }, { approval_mode: 'smart', yolo: false }, {}]) {
    let asked = 0
    const f = fixture(t, {
      question: async () => { asked++; return 'deny' },
      handle: (frame, socket) => {
        if (frame.method !== 'session.resume') return false
        const { approval_mode: _mode, yolo: _yolo, ...rest } = f.live.info
        socket.reply(frame, { ...f.live, info: { ...rest, ...info } })
        return true
      },
    })
    f.identity.canonicalBot = true
    await f.wire.connect()
    await f.run.prepare()
    const methods = f.sent.map(frame => frame.method)
    assert.ok(methods.includes('session.list') && methods.includes('session.resume'), JSON.stringify(info))
    assert.ok(!methods.some(method => ['session.create', 'config.set', 'prompt.submit'].includes(method)), 'the existing Bot Chat is used as it is')
    assert.equal(asked, 0)
  }
})

test('pairing binds one Bot own-chat across segments without remote creation', async t => {
  const f = fixture(t)
  const ctx = fakeContext(), endpoints = new Map()
  ctx.llm.registerAdapter = () => () => {}
  const rt = { ctx, state: { bots: { owner: { id: 'owner', name: 'Owner', model: 'hermes-remote/sample:model' }, other: { id: 'other', name: 'Other', model: 'hermes-remote/sample:model' } }, prefs: { hermesRemote: { enabled: true, address: f.wire.address, profile: 'sample', credentialRef: 'SAMPLE', models: [] } } },
    chatOwners: new Map([['segment-one', 'owner'], ['segment-two', 'owner'], ['other-chat', 'other']]),
    hooks: { endpoint: (name, fn) => endpoints.set(name, fn) }, load: async () => {}, save: async () => {}, loadSecrets: async () => {}, secretValue: () => f.credential }
  install(rt, { transport: () => f.wire })
  t.after(() => ctx.dispose())
  await endpoints.get('hermes-remote-pair')({ botId: 'owner' })
  assert.equal(rt.state.prefs.hermesRemote.pairedBotId, 'owner')
  const adapter = rt.hermesRemote.adapter
  assert.equal(adapter.identity('segment-one'), adapter.identity('segment-two'))
  assert.equal(adapter.identity('segment-one').canonicalBot, true)
  for (const id of ['other-chat', 'group', 'task', 'unknown']) assert.throws(() => adapter.identity(id), /paired/)
  await assert.rejects(endpoints.get('hermes-remote-pair')({ botId: 'other' }), /already paired/)
  assert.ok(!f.sent.some(frame => ['session.create', 'config.set', 'prompt.submit'].includes(frame.method)))
  const same = adapter.identity('segment-one')
  same.pendingSubmit = true
  await assert.rejects(endpoints.get('hermes-remote-pair')({ botId: '' }), /running/)
  same.pendingSubmit = false
  await endpoints.get('hermes-remote-pair')({ botId: '' })
  assert.equal(rt.state.prefs.hermesRemote.pairedBotId, undefined)
  assert.equal(same.canonicalBot, true, 'unpair preserves reconciliation history')
  rt.state.bots.other.model = 'native/model'
  await assert.rejects(endpoints.get('hermes-remote-pair')({ botId: 'other' }), /Choose Remote Hermes/)
  // Cancellation while the durable save is in flight restores the old binding on disk.
  rt.state.prefs.hermesRemote.pairedBotId = 'owner'
  const controller = new AbortController(), saved = []
  rt.save = async () => {
    saved.push(rt.state.prefs.hermesRemote.pairedBotId)
    if (saved.length === 1) controller.abort()
  }
  await assert.rejects(endpoints.get('hermes-remote-pair')({ botId: '' }, controller.signal))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rt.state.prefs.hermesRemote.pairedBotId, 'owner')
  assert.deepEqual(saved, [undefined, 'owner'])
})

test('resumed model changes explicitly opt out of profile persistence', async t => {
  const f = fixture(t, { result: { scope: 'session' } })
  f.identity.storedSessionId = f.snapshot.stored_session_id
  await f.wire.connect()
  await f.run.prepare({ model: 'other-model', provider: 'sample' })
  const change = f.sent.find(frame => frame.method === 'config.set')
  assert.equal(change.params.key, 'model')
  assert.equal(change.params.value, 'other-model --provider sample --session')
})

test('streaming redaction carries credential and one-use ticket prefixes across frames', async t => {
  const f = fixture(t)
  await f.wire.connect(); await f.run.submit('Sample')
  for (const secret of [f.credential, f.ticket]) {
    const half = Math.floor(secret.length / 2)
    f.socket().event('message.delta', { text: secret.slice(0, half) })
    f.socket().event('message.delta', { text: secret.slice(half) + ' ' })
  }
  f.socket().event('message.complete', { response_reused: true, status: 'complete' })
  let output = ''
  for (;;) { const row = await f.run.next(); if (row.kind === 'done') break; if (row.kind === 'text') output += row.text }
  assert.ok(!output.includes(f.credential) && !output.includes(f.ticket))
  assert.match(output, /redacted/)
})

// A line of chat text with one secret in it, and the same line as a chat may show it.
// Nothing around the secret shares three characters in a row with it (hex and dashes).
const SECRET_LINES = [
  ['a token query value', value => [`Look: wss://sample.invalid/api/ws?token=${value}&next=1 ok`, 'Look: wss://sample.invalid/api/ws?token=[redacted]&next=1 ok']],
  ['a ticket query value', value => [`Look: wss://sample.invalid/api/ws?first=1&ticket=${value} ok`, 'Look: wss://sample.invalid/api/ws?first=1&ticket=[redacted] ok']],
  ['an internal query value', value => [`Look: "wss://sample.invalid/api/ws?INTERNAL=${value}" ok`, 'Look: "wss://sample.invalid/api/ws?INTERNAL=[redacted]" ok']],
  ['a bearer', value => [`Look: Authorization: Bearer  ${value} ok`, 'Look: Authorization: Bearer [redacted] ok']],
  ['a gateway ticket', value => [`Look: hermes-gateway-v1, hermes-gateway-ticket.${value}, ok`, 'Look: hermes-gateway-v1, hermes-gateway-ticket.[redacted], ok']],
]
// Whose secret it is: the connection's own, one with a character that ends a query value,
// and ones the connection has never seen (a token Hermes only repeats), two of them
// starting the way another rule's mark does.
const SECRET_KINDS = [
  ['the saved credential', () => { const value = randomUUID(); return { value, credential: value } }],
  ['a credential with an ampersand', () => { const value = `${randomBytes(8).toString('hex')}&${randomBytes(8).toString('hex')}`; return { value, credential: value } }],
  ['an unknown token', () => ({ value: randomBytes(32).toString('hex') })],
  ['an unknown token that starts like a bearer', () => ({ value: `bea${randomBytes(30).toString('hex')}` })],
  ['an unknown token that starts like a gateway ticket', () => ({ value: `he${randomBytes(30).toString('hex')}-b${randomBytes(4).toString('hex')}` })],
]
/** The first three characters in a row of `value` that `row` shows, if any. */
const fragment = (row, value) => {
  const shown = row.replaceAll('[redacted]', '')
  for (let at = 0; at + 3 <= value.length; at++) if (shown.includes(value.slice(at, at + 3))) return value.slice(at, at + 3)
}
const textRows = async f => { const rows = []; for (;;) { const row = await f.run.next(); if (row.kind === 'text') rows.push(row.text); else return rows } }
const cutCases = () => SECRET_KINDS.flatMap(([whose, make]) => SECRET_LINES.map(([what, line]) => {
  const { value, credential } = make(), [sent, shown] = line(value)
  assert.equal(fragment(shown, value), undefined, 'the line around the secret holds none of it')
  return { name: `${what}, ${whose}`, value, credential, sent, shown }
}))

test('a secret cut between two frames reaches no row, wherever the cut is: query values, a bearer, a gateway ticket', async t => {
  for (const { name, value, credential, sent, shown } of cutCases()) {
    const f = fixture(t, { credential })
    await f.wire.connect(); await f.run.submit('Sample')
    for (let cut = 0; cut <= sent.length; cut++) {
      f.socket().event('message.delta', { text: sent.slice(0, cut) })
      f.socket().event('message.delta', { text: sent.slice(cut) })
      f.socket().event('message.complete', { response_reused: true, status: 'complete' })
      const rows = await textRows(f)
      for (const row of rows) assert.equal(fragment(row, value), undefined, `${name}, cut at ${cut}: a row shows part of the secret`)
      assert.equal(rows.join(''), shown, `${name}, cut at ${cut}`)
    }
    // One character a frame: every cut at once.
    for (const character of sent) f.socket().event('message.delta', { text: character })
    f.socket().event('message.complete', { response_reused: true, status: 'complete' })
    const rows = await textRows(f)
    for (const row of rows) assert.equal(fragment(row, value), undefined, `${name}, one character a frame`)
    assert.equal(rows.join(''), shown, `${name}, one character a frame`)
  }
})

test('the rest of a cut secret that arrives in the final text reaches no row either', async t => {
  for (const { name, value, credential, sent, shown } of cutCases()) {
    for (let cut = 0; cut <= sent.length; cut++) {
      const f = fixture(t, { credential })
      await f.wire.connect(); await f.run.submit('Sample')
      f.socket().event('message.delta', { text: sent.slice(0, cut) })
      f.socket().event('message.complete', { text: sent, status: 'complete' })
      const rows = await textRows(f)
      for (const row of rows) assert.equal(fragment(row, value), undefined, `${name}, cut at ${cut}: a row shows part of the secret`)
      assert.equal(rows.join(''), shown, `${name}, cut at ${cut}`)
      f.run.dispose()
    }
  }
})

test('a final text that is not what was streamed starts again: nothing held of the stream is shown', async t => {
  for (const { name, value, credential, sent } of cutCases()) {
    for (let cut = 0; cut <= sent.length; cut++) {
      const f = fixture(t, { credential })
      await f.wire.connect(); await f.run.submit('Sample')
      f.socket().event('message.delta', { text: sent.slice(0, cut) })
      f.socket().event('message.complete', { text: 'Another answer.', status: 'complete' })
      const rows = await textRows(f)
      for (const row of rows) assert.equal(fragment(row, value), undefined, `${name}, cut at ${cut}: a row shows part of the secret`)
      assert.equal(rows.at(-1), 'Another answer.', `${name}, cut at ${cut}`)
      f.run.dispose()
    }
  }
})

test('a cut value ends with its turn: the text after it is whole', async t => {
  const f = fixture(t)
  await f.wire.connect(); await f.run.submit('Sample')
  const value = randomBytes(32).toString('hex')
  for (const [end, payload] of [['message.complete', { response_reused: true, status: 'complete' }], ['message.interim', { text: '', already_streamed: true }], ['tool.start', { tool_id: 'tool-a', name: 'sample' }]]) {
    f.socket().event('message.delta', { text: `See /api/ws?token=${value.slice(0, 20)}` })
    f.socket().event(end, payload)
    f.socket().event('message.delta', { text: 'plain-words-after go on' })
    f.socket().event('message.complete', { response_reused: true, status: 'complete' })
    const rows = []
    for (let done = 0; done < (end === 'message.complete' ? 2 : 1);) { const row = await f.run.next(); if (row.kind === 'text') rows.push(row.text); else if (row.kind === 'done') done++ }
    assert.deepEqual(rows, ['See /api/ws?token=[redacted]', 'plain-words-after go on'], end)
  }
})

test('observational reconciliation never answers a live approval delivered during replay', async t => {
  const f = fixture(t, { handle: (frame, socket) => {
    if (frame.method === 'session.events.since') socket.frame({ jsonrpc: '2.0', id: 'srq-live', method: 'approval', params: { session_id: f.identity.runtimeSessionId, request_id: 'live' } })
    return false
  } })
  f.identity.storedSessionId = f.snapshot.stored_session_id
  await f.wire.connect(); await f.run.reconcile()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!f.sent.some(frame => frame.id === 'srq-live'))
})

test('completion between resume and replay is reconciled through a fresh authoritative snapshot', async t => {
  const f = fixture(t, { snapshot: { running: true }, replay: { events: [{ seq: 2, type: 'message.complete', payload: { text: 'Finished', status: 'complete' } }], latest_seq: 2 }, handle: (frame, socket) => {
    if (frame.method !== 'session.activate') return false
    queueMicrotask(() => socket.reply(frame, { ...f.live, running: false, messages: [{ role: 'assistant', text: 'Finished' }] }))
    return true
  } })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: 'old', pendingSubmit: true, uncertain: true })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.unknown, false)
  assert.equal(result.snapshot.messages.at(-1).text, 'Finished')
  assert.equal(f.identity.pendingSubmit, false)
  assert.equal(f.identity.lastSeq, 2)
})

test('an earlier completion never overrides a fresh snapshot of a newly active remote turn', async t => {
  const f = fixture(t, { snapshot: { running: true, status: 'working', inflight: { streaming: true } }, handle: (frame, socket) => {
    if (frame.method === 'session.events.since') socket.event('message.complete', { text: 'Earlier turn', status: 'complete' })
    return false
  } })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: f.snapshot.session_id, pendingSubmit: true, uncertain: true })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.unknown, true)
  assert.equal(f.identity.uncertain, true)
  await assert.rejects(f.run.submit('Do not submit'), /Reconcile/)
})

// #1401: an attached reconnect joins while the previous turn may still be finishing. The wire
// stamps starts and deltas with a turn id but a completion carries none, so the transport
// derives a completion's turn from the turn it opened. A completion with no open turn belongs
// to an earlier turn and never ends the reply of the turn submitted after the reconnect.
function attachedReconnect(t, { earlier = [], replay = {} } = {}) {
  const f = fixture(t, {
    attached: true,
    replay: { latest_seq: 10, events: [], ...replay },
    handle: (frame, socket) => {
      if (frame.method !== 'session.activate') return false
      for (const { text, seq } of earlier) socket.event('message.complete', { text, status: 'complete' }, seq)
      return false
    },
  })
  Object.assign(f.identity, {
    storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: f.snapshot.session_id,
    epoch: 'epoch-a', lastSeq: 10,
  })
  return f
}

const terminalRows = rows => rows.filter(row => ['done', 'error', 'aborted'].includes(row.kind))

test('#1401 a completion recovered during an attached reconnect does not end the next reply', async t => {
  const f = attachedReconnect(t, { earlier: [{ text: 'Earlier reply', seq: 11 }] })
  await f.wire.connect()
  await f.run.submit('New prompt')
  assert.deepEqual(terminalRows(f.run.queue), [], `the new reply stays open: ${JSON.stringify(f.run.queue)}`)
  assert.deepEqual(f.run.takeRecovered(), ['Earlier reply'], 'the earlier turn’s reply is recovered, not taken as the new turn’s')
  f.socket().event('message.complete', { text: 'New reply', status: 'complete' }, 12)
  const rows = []
  for (;;) { const row = await f.run.next(); rows.push(row); if (terminalRows([row]).length) break }
  assert.deepEqual(rows.filter(row => row.kind === 'text').map(row => row.text), ['New reply'])
  assert.equal(rows.at(-1).kind, 'done')
  assert.equal(f.identity.pendingSubmit, false)
})

test('#1401 a completion landing between the reconnect and the submit does not end the next reply', async t => {
  const f = attachedReconnect(t)
  await f.wire.connect()
  await f.run.prepare()
  // The reconnect's replay carried no reply; the earlier turn's completion arrives just after it.
  f.socket().event('message.complete', { text: 'Earlier reply', status: 'complete' }, 11)
  await f.run.submit('New prompt')
  assert.deepEqual(terminalRows(f.run.queue), [], `the new reply stays open: ${JSON.stringify(f.run.queue)}`)
  f.socket().event('message.complete', { text: 'New reply', status: 'complete' }, 12)
  const rows = []
  for (;;) { const row = await f.run.next(); rows.push(row); if (terminalRows([row]).length) break }
  assert.deepEqual(rows.filter(row => row.kind === 'text').map(row => row.text), ['New reply'])
  assert.equal(rows.at(-1).kind, 'done')
})

test('#1401 a completion of the turn just submitted still ends its reply', async t => {
  const f = attachedReconnect(t)
  await f.wire.connect()
  await f.run.submit('New prompt')
  f.socket().event('message.start', { turn_id: 'turn-new' }, 11)
  f.socket().event('message.delta', { text: 'New ', turn_id: 'turn-new', segment: 0, offset: 0 }, 12)
  f.socket().event('message.complete', { text: 'New reply', status: 'complete' }, 13)
  const rows = []
  for (;;) { const row = await f.run.next(); rows.push(row); if (terminalRows([row]).length) break }
  assert.equal(rows.filter(row => row.kind === 'text').map(row => row.text).join(''), 'New reply')
  assert.equal(rows.at(-1).kind, 'done')
  assert.equal(f.identity.pendingSubmit, false)
})

test('#1401 two reconnects with out-of-order earlier completions never end the next reply', async t => {
  const first = attachedReconnect(t, { earlier: [{ text: 'Second earlier reply', seq: 12 }] })
  await first.wire.connect()
  await first.run.prepare()
  assert.deepEqual(terminalRows(first.run.queue), [], `the first reconnect ends no reply: ${JSON.stringify(first.run.queue)}`)
  assert.deepEqual(first.run.takeRecovered(), ['Second earlier reply'])
  first.run.dispose()

  const second = attachedReconnect(t, { earlier: [{ text: 'First earlier reply', seq: 11 }] })
  await second.wire.connect()
  await second.run.submit('New prompt')
  assert.deepEqual(terminalRows(second.run.queue), [], `the new reply stays open: ${JSON.stringify(second.run.queue)}`)
  assert.deepEqual(second.run.takeRecovered(), ['First earlier reply'])
  second.socket().event('message.complete', { text: 'New reply', status: 'complete' }, 12)
  const rows = []
  for (;;) { const row = await second.run.next(); rows.push(row); if (terminalRows([row]).length) break }
  assert.deepEqual(rows.filter(row => row.kind === 'text').map(row => row.text), ['New reply'])
  assert.equal(rows.at(-1).kind, 'done')
})

test('#1401 replayed completions stay text-only and the new reply closes on its own completion', async t => {
  const f = attachedReconnect(t, { replay: { latest_seq: 11, events: [{ seq: 11, type: 'message.complete', payload: { text: 'Replayed reply', status: 'complete' } }] } })
  await f.wire.connect()
  await f.run.prepare()
  assert.deepEqual(f.run.takeRecovered(), ['Replayed reply'])
  assert.deepEqual(terminalRows(f.run.queue), [])
  await f.run.submit('New prompt')
  assert.deepEqual(terminalRows(f.run.queue), [], `the new reply stays open: ${JSON.stringify(f.run.queue)}`)
  f.socket().event('message.complete', { text: 'New reply', status: 'complete' }, 12)
  const rows = []
  for (;;) { const row = await f.run.next(); rows.push(row); if (terminalRows([row]).length) break }
  assert.deepEqual(rows.filter(row => row.kind === 'text').map(row => row.text), ['New reply'])
  assert.equal(rows.at(-1).kind, 'done')
})

test('a Hermes that approves on its own (yolo) connects, and its tool runs with no question from us', async t => {
  for (const metadata of [{ approval_mode: 'off', yolo: true }, { approval_mode: 'smart', yolo: false }, { approval_mode: 'manual', yolo: false }]) {
    let asked = 0
    const f = fixture(t, { metadata, snapshot: { info: { desktop_contract: 8, ...metadata } }, question: async () => { asked++; return 'deny' } })
    await f.wire.connect(); await f.run.submit('Run it')
    f.socket().event('tool.start', { tool_id: 'tool-a', name: 'terminal', args: { command: 'ls' } })
    f.socket().event('tool.complete', { tool_id: 'tool-a', result_text: 'sample.txt' })
    f.socket().event('message.complete', { text: 'Done.', status: 'complete' })
    const rows = []
    for (;;) { const row = await f.run.next(); rows.push(row); if (row.kind === 'done') break }
    const tool = rows.find(row => row.kind === 'tool').tool
    assert.deepEqual([tool.title, tool.status, tool.text], ['terminal', 'completed', 'sample.txt'], JSON.stringify(metadata))
    assert.equal(rows.filter(row => row.kind === 'text').map(row => row.text).join(''), 'Done.')
    assert.equal(asked, 0, 'Hermes did not ask, so nobody was asked')
    assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
    assert.ok(!f.sent.some(frame => frame.method === 'config.set'), 'Hermes’s own settings are never changed')
  }
})

test('no approval setting is read or waited for: a session with no such metadata submits at once', async t => {
  const f = fixture(t, { metadata: false })
  await f.wire.connect()
  assert.equal(Object.hasOwn(f.snapshot.info, 'approval_mode'), false)
  assert.equal(Object.hasOwn(f.snapshot.info, 'yolo'), false)
  await f.run.submit('Sent without waiting')
  assert.equal(f.sent.filter(frame => frame.method === 'prompt.submit').length, 1)
  assert.equal(f.identity.storedSessionId, f.snapshot.stored_session_id)
  assert.equal(f.wire.listeners.size, 1, 'nothing is left waiting for a session.info')
})

test('resume and activate normalize session_key and nested stored identity before saving', async t => {
  const f = fixture(t, { snapshot: { messages: [{ role: 'user', text: 'Sample' }, { role: 'assistant', text: 'Sample reply' }] } })
  assert.equal(Object.hasOwn(f.live, 'stored_session_id'), false)
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: randomUUID(), uncertain: true })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.snapshot.stored_session_id, f.live.session_key)
  assert.equal(f.identity.runtimeSessionId, f.live.session_id)
  assert.equal(f.identity.storedSessionId, f.live.info.stored_session_id)
  assert.ok(f.identities.every(identity => !identity.storedSessionId || identity.storedSessionId === f.live.session_key))
  assert.ok(f.sent.some(frame => frame.method === 'session.resume'))
  assert.ok(f.sent.some(frame => frame.method === 'session.activate'))
  await f.run.submit('Next turn')
  assert.ok(!f.sent.some(frame => frame.method === 'session.create'))
})

test('conflicting remote stored identities are refused before submit', async t => {
  const f = fixture(t, { snapshot: { session_key: randomUUID() } })
  await f.wire.connect()
  await assert.rejects(f.run.submit('Never sent'), /conflicting stored session IDs/)
  assert.ok(!f.sent.some(frame => frame.method === 'prompt.submit'))
})

test('epoch restart resets watermark and old stream state, then accepts new deltas and completion', async t => {
  let resolveQuestion
  const f = fixture(t, { ready: { replay_epoch: 'epoch-b' }, replay: { epoch: 'epoch-b', latest_seq: 1 },
    snapshot: { running: true, status: 'working', inflight: { streaming: true } }, question: () => new Promise(resolve => { resolveQuestion = resolve }) })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: f.snapshot.session_id, epoch: 'epoch-a', lastSeq: 100, pendingSubmit: true, uncertain: true })
  f.run.queue.push({ kind: 'text', text: 'Old epoch text' })
  let toolReleased = false
  f.run.tools.set('old-tool', { status: 'running', done: () => { toolReleased = true } })
  f.run.streamed = 'Old epoch text'
  f.wire.textCarry = 'Old prefix'
  const question = f.run.control({ id: 'old-question', method: 'approval', params: { session_id: f.snapshot.session_id, request_id: 'old' } })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(result.gap, true)
  assert.equal(result.unknown, true)
  assert.equal(f.identity.lastSeq, 1)
  assert.equal(f.identity.epoch, 'epoch-b')
  assert.equal(f.run.queue.length, 0)
  assert.equal(f.run.tools.size, 0)
  assert.equal(f.run.questions.size, 0)
  assert.equal(f.run.streamed, '')
  assert.equal(f.wire.textCarry, '')
  assert.equal(toolReleased, true)
  resolveQuestion('once'); await question
  assert.ok(!f.sent.some(frame => frame.id === 'old-question'))
  f.socket().event('message.delta', { text: 'New epoch text' }, 2)
  f.socket().event('message.complete', { text: 'New epoch text', status: 'complete' }, 3)
  assert.deepEqual(await f.run.next(), { kind: 'text', text: 'New epoch text' })
  assert.equal((await f.run.next()).kind, 'done')
  assert.equal(f.identity.lastSeq, 3)
  assert.equal(f.identity.pendingSubmit, false)
  assert.equal(f.identity.uncertain, false)
})

test('completion during activate causes a newer snapshot before reconciliation settles', async t => {
  let activates = 0
  const f = fixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'session.activate') return false
    activates++
    if (activates === 1) socket.event('message.complete', { text: 'Finished', status: 'complete' }, 10)
    queueMicrotask(() => socket.reply(frame, { ...f.live, running: activates === 1, status: activates === 1 ? 'working' : 'idle' }))
    return true
  } })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, epoch: 'epoch-a', pendingSubmit: true, uncertain: true })
  await f.wire.connect()
  const result = await f.run.reconcile()
  assert.equal(activates, 2)
  assert.equal(result.unknown, false)
  assert.equal(f.identity.pendingSubmit, false)
})

test('malformed JSON-RPC frames fail closed without uncaught callbacks or leaked remote data', async t => {
  const malformed = [
    () => null, () => [], () => 1,
    () => ({ method: 'event', params: {} }),
    () => ({ jsonrpc: '2.0', method: 'event', params: null }),
    () => ({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: {} } } }),
    () => ({ jsonrpc: '2.0', method: 'event', params: { type: 'session.info', payload: { yolo: 'false' } } }),
    () => ({ jsonrpc: '2.0', method: 'event', params: { type: 'request.cancel', session_id: 'sample', payload: { id: {}, method: 'approval', reason: 'sample' } } }),
    () => ({ jsonrpc: '2.0', id: 1, method: 'approval', params: null }),
    () => ({ jsonrpc: '2.0', id: 1, method: 'approval', params: { session_id: 'sample', request_id: 'sample', command: {} } }),
    () => ({ jsonrpc: '2.0', id: 99, result: {}, error: { code: -1, message: 'sample' } }),
    () => ({ jsonrpc: '2.0', id: 99, error: null }),
  ]
  for (const make of malformed) {
    const f = fixture(t, { handle: frame => frame.method === 'sample' })
    await f.wire.connect()
    const pending = assert.rejects(f.wire.request('sample'), { message: INVALID_FRAME })
    assert.doesNotThrow(() => f.socket().frame(make()))
    await pending
    assert.equal(f.wire.pending.size, 0)
    assert.equal(f.wire.connected, false)
    assert.equal(f.wire.closed, true)
    assert.equal((await f.run.next()).text, INVALID_FRAME)
  }
})

test('malformed RPC results consumed by the client close and clean up pending requests', async t => {
  for (const [method, result] of [
    ['client.capabilities', { server_requests: {} }], ['model.options', { providers: [null] }],
    ['model.options', { providers: [{ slug: 'sample', models: 'sample' }] }],
    ['session.resume', { session_id: 'sample', info: null, messages: [] }],
    ['session.activate', { session_id: 'sample', info: {}, messages: {} }],
    ['session.events.since', { events: [], epoch: 'epoch-a', latest_seq: {}, truncated: false, open_requests: [] }],
    ['config.set', { scope: {} }], ['prompt.submit', { admission_id: {} }],
  ]) {
    const f = fixture(t, { handle: (frame, socket) => {
      if (frame.method !== method || (method === 'client.capabilities' && !f.wire.connected)) return false
      queueMicrotask(() => socket.reply(frame, result)); return true
    } })
    await f.wire.connect()
    await assert.rejects(f.wire.request(method), { message: INVALID_FRAME })
    assert.equal(f.wire.pending.size, 0)
    assert.equal(f.wire.closed, true)
  }
})

test('invalid startup frames and bounded byte/depth violations close without throwing', async t => {
  const startup = fixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'client.capabilities') return false
    socket.frame(null); return true
  } })
  await assert.rejects(startup.wire.connect(), { message: INVALID_FRAME })
  assert.equal(startup.wire.closed, true)
  const envelope = payload => ({ jsonrpc: '2.0', method: 'event', params: { type: 'ignored', payload } })
  let nested = {}
  for (let depth = 0; depth < 40; depth++) nested = { nested }
  for (const data of ['{', JSON.stringify(envelope({ text: 'x'.repeat(8 * 1024 * 1024) })), JSON.stringify(envelope(nested))]) {
    const f = fixture(t)
    await f.wire.connect()
    assert.doesNotThrow(() => f.socket().dispatchEvent(new MessageEvent('message', { data })))
    assert.equal(f.wire.closed, true)
    assert.equal((await f.run.next()).text, INVALID_FRAME)
  }
})

test('reconcile fences old approval before awaiting resume and can answer a reused current request ID afterward', async t => {
  let resumeFrame, resolveOldQuestion
  const currentRequest = { id: 'srq-reused', method: 'approval', params: { session_id: randomUUID(), request_id: 'current', command: 'Current command' } }
  let asked = 0
  const f = fixture(t, { replay: { epoch: 'epoch-b', latest_seq: 1 }, snapshot: { open_requests: [currentRequest] },
    question: () => ++asked === 1 ? new Promise(resolve => { resolveOldQuestion = resolve }) : 'once',
    handle: frame => { if (frame.method !== 'session.resume') return false; resumeFrame = frame; return true },
  })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, runtimeSessionId: f.snapshot.session_id, epoch: 'epoch-a', uncertain: true })
  currentRequest.params.session_id = f.snapshot.session_id
  await f.wire.connect()
  const oldQuestion = f.run.control({ id: currentRequest.id, method: 'approval', epoch: 'epoch-a', params: { session_id: f.snapshot.session_id, request_id: 'old', command: 'Old command' } })
  f.wire.epoch = 'epoch-b'
  const reconciling = f.run.reconcile({ answerQuestions: true })
  await until(() => resumeFrame, 'the resume frame', reconciling)
  resolveOldQuestion('once')
  await oldQuestion
  assert.ok(!f.sent.some(frame => frame.id === currentRequest.id))
  f.socket().reply(resumeFrame, f.live)
  await reconciling
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(asked, 2)
  assert.deepEqual(f.sent.filter(frame => frame.id === currentRequest.id), [{ jsonrpc: '2.0', id: currentRequest.id, result: { choice: 'once' } }])
  await f.run.control({ id: 'stale-epoch', method: 'approval', epoch: 'epoch-a', params: currentRequest.params })
  assert.equal(asked, 2)
  assert.ok(!f.sent.some(frame => frame.id === 'stale-epoch'))
})

test('reconcile answers only requests still present in the authoritative activate snapshot', async t => {
  let asked = 0
  const f = fixture(t, { question: () => { asked++; return 'once' }, replay: { open_requests: [{ id: 'srq-finished', method: 'approval', params: { session_id: 'sample', request_id: 'finished' } }] } })
  f.identity.storedSessionId = f.snapshot.stored_session_id
  await f.wire.connect()
  await f.run.reconcile({ answerQuestions: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(asked, 0)
  assert.ok(!f.sent.some(frame => frame.id === 'srq-finished'))
})

test('an approval arriving after activate captures open_requests is recovered from a newer snapshot', async t => {
  for (const withdrawn of [false, true]) {
    let activates = 0, asked = 0, request
    const f = fixture(t, { question: () => { asked++; return 'once' }, handle: (frame, socket) => {
      if (frame.method !== 'session.activate') return false
      activates++
      // Source: _live_session_payload has already captured _open_requests(sid).
      const captured = { ...f.live, running: true, status: 'working', ...(activates > 1 && !withdrawn ? { open_requests: [request] } : {}) }
      if (activates === 1) {
        // server_requests.ServerRequest.frame can be written before the captured reply.
        request = { id: 'srq-during-capture', method: 'approval', params: { session_id: f.snapshot.session_id, request_id: randomUUID(), command: 'Sample command', choices: ['once', 'deny'] } }
        socket.frame({ jsonrpc: '2.0', ...request })
        if (withdrawn) socket.event('request.cancel', { id: request.id, method: request.method, reason: 'resolved' })
      }
      queueMicrotask(() => socket.reply(frame, captured))
      return true
    } })
    Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, pendingSubmit: true, uncertain: true, epoch: 'epoch-a' })
    await f.wire.connect()
    const result = await f.run.reconcile({ answerQuestions: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(activates, 2)
    assert.equal(result.unknown, true)
    assert.equal(asked, withdrawn ? 0 : 1)
    assert.deepEqual(f.sent.filter(frame => frame.id === request.id), withdrawn ? [] : [{ jsonrpc: '2.0', id: request.id, result: { choice: 'once' } }])
    assert.ok(!f.sent.some(frame => frame.method === 'prompt.submit'))
  }
})

test('real adapter recovers upstream role/text history through reconcile without resubmission or secret echoes', async t => {
  const messages = [{ role: 'user', text: 'Earlier prompt' }, { role: 'assistant', text: '' }]
  const f = fixture(t, { snapshot: { messages } })
  messages[1].text = `Recovered answer ${f.credential} ${f.ticket}`
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, pendingSubmit: true, uncertain: true, epoch: 'epoch-a' })
  const agent = { session: { id: 'sample-recovered-chat' }, ctx: { tools: { register: () => () => {} } } }
  const rt = { ctx: { get: name => name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined, on() {} } }
  const adapter = new RemoteChatAdapter(rt, { enabled: () => true, models: () => [{ id: 'sample:model', model: 'model', provider: 'sample' }], identity: () => f.identity, save: async () => {}, open: async () => { await f.wire.connect(); return f.run } })
  t.after(() => adapter.dispose())
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: agent.session.id, messages: [{ role: 'user', content: 'Never resubmit this' }] }))) chunks.push(chunk)
  const recovered = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('\n')
  assert.match(recovered, /Recovered answer \[redacted\] \[redacted\]/)
  assert.ok(!JSON.stringify(chunks).includes(f.credential) && !JSON.stringify(chunks).includes(f.ticket))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.ok(f.sent.some(frame => frame.method === 'session.resume'))
  assert.ok(f.sent.some(frame => frame.method === 'session.activate'))
  assert.ok(!f.sent.some(frame => frame.method === 'session.create' || frame.method === 'prompt.submit'))
})

test('a cancellation after activate captures a pending approval causes a newer snapshot with no answer', async t => {
  let activates = 0, asked = 0
  const f = fixture(t, { question: () => { asked++; return 'once' }, handle: (frame, socket) => {
    if (frame.method !== 'session.activate') return false
    activates++
    const request = { id: 'srq-withdrawn', method: 'approval', params: { session_id: f.snapshot.session_id, request_id: randomUUID(), choices: ['once', 'deny'] } }
    const captured = { ...f.live, ...(activates === 1 ? { open_requests: [request] } : {}) }
    if (activates === 1) socket.event('request.cancel', { id: request.id, method: request.method, reason: 'timeout' })
    queueMicrotask(() => socket.reply(frame, captured))
    return true
  } })
  Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, uncertain: true, epoch: 'epoch-a' })
  await f.wire.connect()
  const result = await f.run.reconcile({ answerQuestions: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(activates, 2)
  assert.equal(result.unknown, false)
  assert.equal(asked, 0)
  assert.ok(!f.sent.some(frame => frame.id === 'srq-withdrawn'))
})

test('a live request cancellation invalidates an approval choice still being awaited', async t => {
  let resolveQuestion
  const f = fixture(t, { question: () => new Promise(resolve => { resolveQuestion = resolve }) })
  await f.wire.connect(); await f.run.prepare()
  const request = { id: 'srq-cancelled-choice', method: 'approval', params: { session_id: f.snapshot.session_id, request_id: randomUUID(), choices: ['once', 'deny'] }, epoch: 'epoch-a' }
  const answering = f.run.control(request)
  f.socket().event('request.cancel', { id: request.id, method: request.method, reason: 'resolved' })
  resolveQuestion('once')
  await answering
  assert.ok(!f.sent.some(frame => frame.id === request.id))
  assert.equal(f.run.questions.has(request.id), false)
})

test('approval churn during activate is bounded and observational capture never answers questions', async t => {
  for (const churn of [true, false]) {
    let activates = 0, asked = 0, request
    const f = fixture(t, { question: () => { asked++; return 'once' }, handle: (frame, socket) => {
      if (frame.method !== 'session.activate') return false
      activates++
      const captured = { ...f.live, ...(request ? { open_requests: [request] } : {}) }
      if (churn || activates === 1) {
        request = { id: `srq-capture-${activates}`, method: 'approval', params: { session_id: f.snapshot.session_id, request_id: randomUUID(), choices: ['once', 'deny'] } }
        socket.frame({ jsonrpc: '2.0', ...request })
      }
      queueMicrotask(() => socket.reply(frame, captured))
      return true
    } })
    Object.assign(f.identity, { storedSessionId: f.snapshot.stored_session_id, uncertain: true, epoch: 'epoch-a' })
    await f.wire.connect()
    if (churn) await assert.rejects(f.run.reconcile({ answerQuestions: true }), /changed while reconciling/)
    else await f.run.reconcile()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(activates, churn ? 3 : 2)
    assert.equal(asked, 0)
    assert.ok(!f.sent.some(frame => frame.id === request.id || frame.method === 'prompt.submit'))
  }
})

test('a zero-or-two Bot Chat refusal reaches the chat with its own sentence, not the generic reconcile line', async t => {
  const agent = { session: { id: 'sample-pairing' }, ctx: { tools: { register: () => () => {} } } }
  const ctx = fakeContext({ services: { agents: { get: () => agent, list: () => [agent] } } })
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true,
    models: () => [{ id: 'attach', name: 'Attach', model: 'm', provider: 'p' }],
    identity: () => ({ canonicalBot: true }),
    save: async () => {},
    attached: () => true,
    open: async () => { throw Object.assign(new Error('This profile must have exactly one existing Bot Chat. Open it in Hermes before pairing.'), { code: 'bot/hermes-pairing' }) },
  })
  t.after(() => adapter.dispose())
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'attach', sessionId: 'sample-pairing', messages: [{ role: 'user', content: 'Sample' }] }))) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /exactly one existing Bot Chat/)
})

test('an attached chat with no visible row still opens so the first open can normalize', async t => {
  const agent = { session: { id: 'first-open' }, ctx: { tools: { register: () => () => {} } } }
  const ctx = fakeContext({ services: { agents: { get: () => agent, list: () => [agent] } } })
  let submitted
  const run = {
    transport: { redact: text => text }, identity: {},
    async submit(text, model) { submitted = { text, model } },
    async next() { return { kind: 'done' } },
    async close() {}, async stop() {},
  }
  const adapter = new RemoteChatAdapter({ ctx }, {
    enabled: () => true, models: () => [], identity: () => ({}), save: async () => {}, attached: () => true, open: async () => run,
  })
  t.after(() => adapter.dispose())
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'old-ref', sessionId: 'first-open', messages: [{ role: 'user', content: 'Sample' }] }))) chunks.push(chunk)
  assert.equal(submitted.text, 'Sample')
  assert.equal(submitted.model.id, 'attach', 'the placeholder lets the open happen; the attached transport never sends it')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

for (const [type, field] of [['error', 'message'], ['message.complete', 'error']]) {
  test(type + ' reason drops a split supplementary character at the cut', async t => {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    const reason = '.'.repeat(498) + '\u{1F600}' + 'tail ' + 'more '.repeat(10)
    f.socket().event(type, { ...(type === 'message.complete' ? { status: 'error', text: '' } : {}), [field]: reason }, 1)
    const row = await f.run.next()
    assert.equal(row.kind, 'error')
    const detail = row.text.slice(row.text.indexOf(': ') + 2)
    assert.equal(detail, '.'.repeat(498) + '…')
    assert.ok(detail.isWellFormed())
  })

  test(type + ' reason keeps a complete supplementary character before the cut', async t => {
    const f = fixture(t)
    await f.wire.connect(); await f.run.submit('Sample')
    const reason = '.'.repeat(497) + '\u{1F600}' + 'tail' + 'more '.repeat(10)
    f.socket().event(type, { ...(type === 'message.complete' ? { status: 'error', text: '' } : {}), [field]: reason }, 1)
    const row = await f.run.next()
    assert.equal(row.kind, 'error')
    const detail = row.text.slice(row.text.indexOf(': ') + 2)
    assert.equal(detail, '.'.repeat(497) + '\u{1F600}' + '…')
    assert.equal(detail.length, 500)
    assert.ok(detail.isWellFormed())
  })
}
