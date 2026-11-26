import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { HermesTransport, RemoteChat, LOST } from '../src/host/hermes-transport.js'
import { RemoteChatAdapter } from '../src/host/remote-chat-adapter.js'
import { desktop8Session } from './fixtures/hermes-desktop8.mjs'

// Copied from hermes-remote.test.js: bounded waits and an in-memory ticket/socket
// fixture. No Hermes process or real network is used; all sample identities are neutral.
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

function fixture(t, overrides = {}) {
  const credential = randomUUID(), ticket = randomUUID()
  const address = `https://${randomUUID()}.invalid`
  const sent = [], identities = []
  const source = overrides.source ?? desktop8Session(randomUUID(), randomUUID())
  const snapshot = source.create
  class Socket extends EventTarget {
    constructor() { super(); this.turns = 0; queueMicrotask(() => this.event('gateway.ready', { replay_epoch: 'epoch-a' })) }
    frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })) }
    event(type, payload, seq) { this.frame({ jsonrpc: '2.0', method: 'event', params: { type, payload, session_id: snapshot.session_id, ...(seq ? { seq } : {}) } }) }
    reply(frame, result) { this.frame({ jsonrpc: '2.0', id: frame.id, result }) }
    send(text) {
      const frame = JSON.parse(text); sent.push(frame)
      if (!frame.method) return
      if (overrides.handle?.(frame, this) === true) return
      const result = frame.method === 'client.capabilities' ? { server_requests: ['approval'] }
        : ['session.create', 'session.resume', 'session.activate'].includes(frame.method) ? { ...(frame.method === 'session.create' ? snapshot : source.live), ...overrides.snapshot }
          : frame.method === 'session.events.since' ? { events: [], latest_seq: 9, epoch: 'epoch-a', truncated: false, count: 0, open_requests: [] }
            : { status: 'streaming' }
      // The real wire starts a turn with a stamped `message.start` before it streams or
      // completes; a completion carries no turn id of its own.
      if (frame.method === 'prompt.submit' && overrides.autoStart !== false) this.event('message.start', { turn_id: `turn-${++this.turns}` })
      queueMicrotask(() => {
        this.reply(frame, result)
        if (frame.method === 'session.create') queueMicrotask(() => this.event('session.info', source.info))
      })
    }
    close() { this.dispatchEvent(new Event('close')) }
  }
  let socket
  const wire = new HermesTransport({ address, credential, profile: 'sample', deadlines: { start: 200, control: 100, cancel: 30 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ticket }) }),
    socket: () => { socket = new Socket(); return socket },
  })
  const identity = overrides.identity ?? { createKey: randomUUID(), pendingSubmit: false, uncertain: false }
  const save = async () => identities.push(structuredClone(identity))
  const run = new RemoteChat(wire, { identity, save })
  t.after(() => run.dispose())
  return { wire, run, identity, identities, sent, snapshot, source, save, credential, ticket, socket: () => socket }
}

// Each adapter stream opens a fresh run/socket, retaining only the durable identity.
function adapterFixture(t, overrides = {}) {
  const first = fixture(t, overrides)
  const opened = []
  const agent = { session: { id: 'sample-chat' }, ctx: { tools: { register: () => () => {} } } }
  const rt = { ctx: { get: name => name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined, on() {} } }
  const adapter = new RemoteChatAdapter(rt, {
    enabled: () => true,
    models: () => [{ id: 'sample:sample-model', model: 'sample-model', provider: 'sample' }],
    identity: () => first.identity,
    save: first.save,
    open: async () => {
      const f = opened.length ? fixture(t, { source: first.source, identity: first.identity }) : first
      opened.push(f)
      await f.wire.connect()
      return f.run
    },
  })
  t.after(() => adapter.dispose())
  const stream = text => adapter.stream(markAgentLoopRequest({
    provider: 'hermes-remote', model: 'sample:sample-model', sessionId: 'sample-chat', messages: [{ role: 'user', content: text }],
  }))
  return { first, opened, stream }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const submits = f => f.sent.filter(frame => frame.method === 'prompt.submit')
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const ownershipFailure = { code: 4090, reason: 'SESSION_OWNER_BUSY', message: 'The session owner is busy. Nothing was sent.' }
const retryableComplete = {
  status: 'error', recoverable: true,
  error_surface: { layer: 'runtime', code: 'agent_init_failed', retryable: true },
}

async function acknowledged(f, work) {
  await until(() => submits(f).length === 1 && ![...f.wire.pending.values()].some(request => request.method === 'prompt.submit'), 'the submit acknowledgment', work)
}

function assertCertain(f) {
  assert.equal(f.identity.pendingSubmit, false)
  assert.equal(f.identity.uncertain, false)
  assert.equal(f.identities.at(-1).pendingSubmit, false, 'certainty is persisted')
  assert.equal(f.identities.at(-1).uncertain, false, 'certainty is persisted')
}

function assertSettleRead(f) {
  const interrupt = f.sent.findIndex(frame => frame.method === 'session.interrupt')
  assert.ok(interrupt >= 0, 'the existing Stop path sends session.interrupt')
  assert.equal(f.sent.filter(frame => frame.method === 'session.activate').length, 1, 'one authoritative settle snapshot')
  assert.ok(f.sent.findIndex(frame => frame.method === 'session.activate') > interrupt, 'snapshot is read after interrupt')
}

async function answerNext(h) {
  const work = collect(h.stream('Second sample message'))
  await until(() => h.opened.length === 2 && submits(h.opened[1]).length === 1, 'a fresh run to submit the next message', work)
  const next = h.opened[1]
  await acknowledged(next, work)
  assert.equal(submits(next)[0].params.text, 'Second sample message')
  next.socket().event('message.complete', { text: 'Second sample answer', status: 'complete' }, 10)
  const chunks = await work
  assert.equal(textOf(chunks), 'Second sample answer')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.doesNotMatch(JSON.stringify(chunks), /Resuming the existing remote turn/)
  assertCertain(next)
}

// Before #1323, (a) and (j) fail the settle-read/false-flag assertions and the next
// stream resumes instead of submitting. (b) requires the new read while preserving
// the old conservative outcome. (c), (d), (f), (h), (i) lock unchanged behavior.
test('a: an early ownership error settles idle after the adapter ends, then a fresh stream answers', async t => {
  const h = adapterFixture(t)
  const f = h.first
  const work = collect(h.stream('First sample message'))
  await acknowledged(f, work)
  f.socket().event('error', ownershipFailure, 1)
  assert.equal(f.identity.pendingSubmit, true, 'an error alone is not proof of refusal')
  assert.equal(f.identity.uncertain, true)
  const chunks = await work
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assertSettleRead(f)
  assertCertain(f)
  await answerNext(h)
})

for (const [label, snapshot] of [
  ['running', { running: true }],
  ['info.running', { info: { desktop_contract: 8, model: 'sample-model', provider: 'sample', running: true } }],
  ['hydrating', { hydrating: true }],
  ['inflight.streaming', { inflight: { streaming: true } }],
  ['open_requests', { open_requests: [{ id: 'sample-request', method: 'approval', params: { session_id: 'sample-session', request_id: 'sample-request' } }] }],
  ['status', { status: 'working' }],
  ['auto_continue', { auto_continue: true }],
]) {
  test(`b: an early error with ${label} in the settle snapshot stays uncertain and the next send reconciles`, async t => {
    const h = adapterFixture(t, { snapshot })
    const f = h.first
    const work = collect(h.stream('First sample message'))
    await acknowledged(f, work)
    f.socket().event('error', ownershipFailure, 1)
    await work
    assertSettleRead(f)
    assert.equal(f.identity.pendingSubmit, true)
    assert.equal(f.identity.uncertain, true)
    assert.equal(f.identities.at(-1).uncertain, true)
    const chunks = await collect(h.stream('Second sample message'))
    assert.equal(h.opened.length, 2)
    assert.equal(submits(h.opened[1]).length, 0, 'an uncertain send is never retried')
    assert.ok(h.opened[1].sent.some(frame => frame.method === 'session.activate'))
    assert.match(textOf(chunks), /Resuming the existing remote turn/)
    assert.equal(chunks.at(-1).reason.kind, 'stop', 'the fresh idle snapshot resolves the old turn')
  })
}

for (const withError of [true, false]) {
  test(`${withError ? 'c' : 'd'}: a retryable failed completion${withError ? ' after an error' : ' alone'} clears both flags and permits a new submit`, async t => {
    const h = adapterFixture(t)
    const f = h.first
    const work = collect(h.stream('First sample message'))
    await acknowledged(f, work)
    if (withError) {
      f.socket().event('error', { message: 'The sample runtime could not initialize.' }, 1)
      assert.equal(f.identity.uncertain, true)
    }
    f.socket().event('message.complete', retryableComplete, 2)
    const chunks = await work
    assert.equal(chunks.at(-1).reason.kind, 'error', 'failed completion never becomes success')
    assertCertain(f)
    assert.equal(f.sent.filter(frame => frame.method === 'session.activate').length, 0, 'terminal evidence needs no settle read')
    await answerNext(h)
  })
}

// All (e) cases depend on #1323: the old catch always throws LOST and persists
// pendingSubmit=true/uncertain=true. Also cover the rest of the explicit allowlist.
for (const remote of [
  { code: 4004, message: 'Sample session was not found.' },
  { code: 4009, message: 'session busy' },
  { code: 4090, message: 'Sample owner is busy.', data: { reason: 'SESSION_OWNER_BUSY' } },
  { code: 4090, message: 'Sample session is not owned.', data: { reason: 'SESSION_NOT_OWNED' } },
  { code: 4091, message: 'Sample session is unavailable.' },
  { code: 4120, message: 'Sample prerequisite is missing.' },
  { code: 4121, message: 'Sample prerequisite is unavailable.' },
  { code: 4124, message: 'Sample prerequisite failed.' },
  { code: 5035, message: 'Sample service is unavailable.' },
]) {
  test(`e: submit refusal ${remote.code} ${remote.data?.reason ?? ''} stays certain and permits the next submit`, async t => {
    let refused = false
    const f = fixture(t, { handle: (frame, socket) => {
      if (frame.method !== 'prompt.submit' || refused) return false
      refused = true
      queueMicrotask(() => socket.frame({ jsonrpc: '2.0', id: frame.id, error: remote }))
      return true
    } })
    await f.wire.connect()
    await assert.rejects(f.run.submit('First sample message'), {
      code: 'bot/hermes', message: `Remote Hermes refused this message: ${remote.message}`,
    })
    assertCertain(f)
    await f.run.submit('Second sample message')
    assert.deepEqual(submits(f).map(frame => frame.params.text), ['First sample message', 'Second sample message'])
    f.socket().event('message.complete', { status: 'complete' }, 1)
    assert.equal((await f.run.next()).kind, 'done')
  })
}

test('e: a refusal without a usable reason offers the fixed Nothing was sent message', async t => {
  const f = fixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'prompt.submit') return false
    socket.frame({ jsonrpc: '2.0', id: frame.id, error: { code: 5035, message: ' \n\t ' } })
    return true
  } })
  await f.wire.connect()
  await assert.rejects(f.run.submit('Sample message'), {
    code: 'bot/hermes', message: 'Remote Hermes refused this message. Nothing was sent; send it again.',
  })
  assertCertain(f)
})

for (const [label, remote] of [
  ['unconfirmed owner', { code: 4090, data: { reason: 'SESSION_OWNER_UNCONFIRMED' } }],
  ['4090 without data', { code: 4090 }],
  ['4090 with a non-string reason', { code: 4090, data: { reason: ['SESSION_OWNER_BUSY'] } }],
  ['4090 with an unknown reason', { code: 4090, data: { reason: 'SAMPLE_UNKNOWN' } }],
  ['internal RPC error', { code: -32603 }],
  ['server RPC error', { code: -32000 }],
  ['unknown code despite an allowed reason', { code: 4999, data: { reason: 'SESSION_OWNER_BUSY' } }],
  ['submit timeout', null],
  ['socket loss', 'lost'],
]) {
  test(`f: ${label} keeps the submit uncertain with LOST`, async t => {
    const f = fixture(t, { handle: (frame, socket) => {
      if (frame.method !== 'prompt.submit') return false
      if (remote === 'lost') queueMicrotask(() => socket.close())
      else if (remote) queueMicrotask(() => socket.frame({ jsonrpc: '2.0', id: frame.id, error: { message: 'Nothing was sent; sample refusal text is not evidence.', ...remote } }))
      return true
    } })
    await f.wire.connect()
    await assert.rejects(f.run.submit('Sample message'), { code: 'bot/hermes', message: LOST })
    assert.equal(f.identity.pendingSubmit, true)
    assert.equal(f.identity.uncertain, true)
    assert.equal(f.identities.at(-1).uncertain, true)
    await assert.rejects(f.run.submit('Do not retry this sample'), /Reconcile/)
    assert.equal(submits(f).length, 1)
    assert.equal(f.sent.filter(frame => frame.method === 'session.activate').length, 0)
  })
}

test('g: a refused submit exposes a bounded remote reason with credential, ticket and provider key redacted', async t => {
  const key = 'sk-sample-A1b2C3d4E5f6G7h8'
  const f = fixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'prompt.submit') return false
    socket.frame({ jsonrpc: '2.0', id: frame.id, error: {
      code: 4009, message: ` Sample refusal:\n ${f.credential} ${f.ticket} ${key}. ${'Sample detail. '.repeat(80)}`,
    } })
    return true
  } })
  await f.wire.connect()
  await assert.rejects(f.run.submit('Sample message'), error => {
    // Prefix and remote detail fail before the fix; absence of secrets also locks
    // redaction now that the remote's message can be displayed at all.
    assert.equal(error.code, 'bot/hermes')
    assert.match(error.message, /^Remote Hermes refused this message: Sample refusal:/)
    assert.ok(error.message.includes('[redacted]') && error.message.includes('sk-[hidden]'))
    for (const secret of [f.credential, f.ticket, key]) assert.ok(!error.stack.includes(secret))
    const reason = error.message.slice('Remote Hermes refused this message: '.length)
    assert.ok(reason.length <= 500)
    assert.ok(reason.endsWith('…'))
    assert.doesNotMatch(reason, /[\r\n\t]/)
    return true
  })
  assertCertain(f)
})

test('h: user Stop without a remote error sends interrupt but never reads a settle snapshot', async t => {
  const f = fixture(t, { snapshot: { running: true } })
  await f.wire.connect()
  await f.run.submit('Sample running message')
  await f.run.stop()
  assert.ok(f.sent.some(frame => frame.method === 'session.interrupt'))
  assert.equal(f.sent.filter(frame => frame.method === 'session.activate').length, 0)
  assert.equal(f.identity.pendingSubmit, true)
  assert.equal(f.identity.uncertain, true)
})

test('h: transport loss after a remote error skips settling and keeps the outcome uncertain', async t => {
  const f = fixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'session.interrupt') return false
    socket.close()
    return true
  } })
  await f.wire.connect()
  await f.run.submit('Sample message')
  f.socket().event('error', ownershipFailure, 1)
  await f.run.stop()
  assert.ok(f.sent.some(frame => frame.method === 'session.interrupt'))
  assert.equal(f.wire.lostNotified, true)
  assert.equal(f.sent.filter(frame => frame.method === 'session.activate').length, 0)
  assert.equal(f.identity.pendingSubmit, true)
  assert.equal(f.identity.uncertain, true)
})

for (const [label, event] of [
  ['foreign session', { session_id: 'foreign-sample-session' }],
  ['old epoch', { epoch: 'epoch-old' }],
  ['old sequence', { seq: 0 }],
]) {
  test(`i: an error from a ${label} is ignored and cannot trigger a settle read`, async t => {
    const f = fixture(t)
    await f.wire.connect()
    await f.run.submit('Sample message')
    // Transport stamps every live event with its current epoch. Inject the old-
    // epoch row at the RemoteChat boundary, as replay/filter tests do.
    const row = { kind: 'event', type: 'error', payload: ownershipFailure, session_id: f.identity.runtimeSessionId, epoch: f.identity.epoch, seq: 1, ...event }
    if (label === 'old epoch') f.run.receive(row)
    else f.socket().frame({ jsonrpc: '2.0', method: 'event', params: row })
    assert.equal(f.identity.uncertain, false)
    assert.equal(f.identity.pendingSubmit, true)
    assert.equal(f.run.queue.length, 0)
    await f.run.stop()
    assert.ok(f.sent.some(frame => frame.method === 'session.interrupt'))
    assert.equal(f.sent.filter(frame => frame.method === 'session.activate').length, 0)
    assert.equal(f.identity.uncertain, true, 'Stop still leaves an unconfirmed running turn uncertain')
  })
}

test('j: an error before an acknowledgment that never arrives settles idle after submit timeout and Stop', async t => {
  const h = adapterFixture(t, { handle: (frame, socket) => {
    if (frame.method !== 'prompt.submit') return false
    queueMicrotask(() => socket.event('error', ownershipFailure, 1))
    return true // Deliberately never acknowledge this submit.
  } })
  const f = h.first
  const work = collect(h.stream('First sample message'))
  await until(() => f.identity.uncertain === true, 'the pre-ack error', work)
  assert.equal(f.identity.pendingSubmit, true)
  assert.ok([...f.wire.pending.values()].some(request => request.method === 'prompt.submit'), 'the error precedes the ack timeout')
  const chunks = await work
  assert.equal(chunks.at(-1).reason.failure.message, LOST, 'submit ack timed out before adapter cleanup')
  assertSettleRead(f)
  assertCertain(f)
  assert.equal(submits(f).length, 1, 'settling never retries the original submit')
  await answerNext(h)
})
