import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { attachedModelOf } from '../src/host/hermes-connection.js'
import { install } from '../src/host/hermes-remote.js'
import { HermesTransport, RemoteChat } from '../src/host/hermes-transport.js'
import { fakeContext } from './fake-ctx.js'

const deadlines = { start: 1000, control: 30, cancel: 10 }
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(predicate, what) {
  const end = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await tick()
  }
}
const approval = () => ({
  kind: 'question', id: 'question-1', method: 'approval', epoch: 'epoch-1',
  params: { session_id: 'runtime-1', request_id: 'request-1', command: 'sample' },
})
const event = (type, payload = {}, seq = 8) => ({
  kind: 'event', session_id: 'runtime-1', epoch: 'epoch-1', type, payload, seq,
})

// Like hermes-attach.test.js: construct the real transport without connecting it,
// replacing only its wire operations. Events still go through its listener set.
function chat(t, { attached = true, identity = {}, question, save, request } = {}) {
  const transport = new HermesTransport({
    address: 'http://127.0.0.1:40123', profile: 'sample', credential: 'sample-credential',
    allowLoopback: true, attached, deadlines,
  })
  transport.epoch = 'epoch-1'
  const calls = [], answers = []
  transport.request = async (method, params, ms) => {
    calls.push({ method, params, ms, listeners: transport.listeners.size })
    return request ? request(method, params, ms) : {}
  }
  transport.answer = (...args) => answers.push(args)
  transport.ws = { close: () => calls.push({ method: 'ws.close' }) }
  const run = new RemoteChat(transport, {
    identity: {
      runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1', subscriptionId: 'subscription-1',
      epoch: 'epoch-1', lastSeq: 7, pendingSubmit: true, uncertain: false, ...identity,
    }, question, save,
  })
  t.after(() => run.dispose())
  const emit = value => { for (const listener of transport.listeners) listener(value) }
  return { run, transport, calls, answers, emit }
}
const methods = h => h.calls.map(call => call.method)
const detaches = h => h.calls.filter(call => call.method === 'session.detach')

test('U1 release removes the listener before detaching the old subscription, then closes the socket', async t => {
  const held = deferred()
  t.after(() => held.resolve({}))
  const h = chat(t, { request: () => held.promise })
  assert.equal(h.transport.listeners.has(h.run.off), true)
  const releasing = h.run.release()
  assert.deepEqual(methods(h), ['session.detach'])
  assert.equal(detaches(h)[0].listeners, 0, 'quiet before sending any detach bytes')
  assert.deepEqual(detaches(h)[0].params, { session_id: 'runtime-1', subscription_id: 'subscription-1' })
  assert.equal(h.transport.closed, undefined, 'keep the wire open until detach settles')
  held.resolve({ detached: true })
  await releasing
  assert.deepEqual(methods(h), ['session.detach', 'ws.close'], 'never session.close or interrupt')
  assert.equal(h.transport.closed, true)
})

test('U2 release of an attached run without a subscription only closes its socket', async t => {
  const h = chat(t, { identity: { subscriptionId: undefined } })
  await h.run.release()
  assert.deepEqual(methods(h), ['ws.close'])
  assert.equal(h.transport.listeners.size, 0)
  assert.equal(h.transport.closed, true)
})

test('U3 release of a non-attached run only closes its socket, like dispose', async t => {
  const h = chat(t, { attached: false })
  const disposed = chat(t, { attached: false })
  disposed.run.dispose()
  await h.run.release()
  assert.deepEqual(methods(h), ['ws.close'])
  assert.deepEqual(methods(h), methods(disposed))
  assert.equal(h.transport.closed, true)
})

test('U4 events, lost and questions during held detach cannot change shared identity or ask', async t => {
  const held = deferred(), asked = [], saved = []
  t.after(() => held.resolve({}))
  const h = chat(t, {
    request: () => held.promise,
    question: async params => { asked.push(params); return 'once' },
    save: async () => { saved.push(true) },
  })
  const before = structuredClone(h.run.identity)
  const releasing = h.run.release()
  assert.deepEqual(methods(h), ['session.detach'])
  h.emit(event('message.complete', { text: 'sample' }))
  h.emit(event('session.info', { stored_session_id: 'stored-other' }, 9))
  h.emit({ kind: 'lost' })
  h.emit(approval())
  await tick()
  assert.deepEqual(h.run.identity, before, 'including uncertain, lastSeq, pendingSubmit and subscriptionId')
  assert.deepEqual(asked, [])
  assert.deepEqual(h.answers, [])
  assert.deepEqual(saved, [])
  assert.deepEqual(h.run.queue, [])
  held.resolve({})
  await releasing
  assert.deepEqual(h.run.identity, before, 'socket close cannot mark the shared identity uncertain either')
})

for (const mode of ['deny on abort', 'late answer ignoring abort']) {
  test(`U5 release fences a pending approval provider: ${mode}`, async t => {
    const held = deferred(), choice = deferred()
    t.after(() => { held.resolve({}); choice.resolve('deny') })
    let signal
    const h = chat(t, {
      request: () => held.promise,
      question: (_params, withdrawn) => {
        signal = withdrawn
        if (mode === 'deny on abort') withdrawn.addEventListener('abort', () => choice.resolve('deny'), { once: true })
        return choice.promise
      },
    })
    const answering = h.run.control(approval())
    assert.equal(signal.aborted, false)
    const releasing = h.run.release()
    assert.equal(signal.aborted, true)
    if (mode === 'late answer ignoring abort') choice.resolve('once')
    await answering
    assert.deepEqual(h.answers, [], 'no answer even while the old wire is still open')
    assert.deepEqual(methods(h), ['session.detach'])
    held.resolve({})
    await releasing
    assert.deepEqual(h.answers, [])
  })
}

test('U6 release waits for a stop held in save without adding another detach or interrupt', async t => {
  const saving = deferred(), detaching = deferred()
  t.after(() => { saving.resolve(); detaching.resolve({}) })
  let saves = 0
  const h = chat(t, {
    save: async () => { if (++saves === 1) await saving.promise },
    request: (method) => {
      if (method === 'session.interrupt') h.emit(event('message.complete', { status: 'interrupted' }))
      if (method === 'session.detach') return detaching.promise
      return {}
    },
  })
  const stopping = h.run.stop()
  assert.equal(saves, 1)
  assert.deepEqual(methods(h), [])
  let released = false
  const releasing = h.run.release().then(() => { released = true })
  await tick()
  assert.equal(released, false)
  assert.deepEqual(methods(h), [], 'release does not bypass the held stop save')
  saving.resolve()
  await until(() => detaches(h).length === 1, 'stop to reach detach')
  assert.deepEqual(methods(h), ['session.interrupt', 'session.detach'])
  assert.equal(released, false, 'release also waits for the stop detach')
  detaching.resolve({})
  await Promise.all([stopping, releasing])
  await h.run.release()
  assert.deepEqual(methods(h), ['session.interrupt', 'session.detach', 'ws.close'])
})

for (const uncertain of [false, true]) {
  test(`U6 stop after release cannot interrupt or change uncertain=${uncertain}`, async t => {
    const held = deferred(), saved = []
    t.after(() => held.resolve({}))
    const h = chat(t, { identity: { uncertain }, request: () => held.promise, save: async () => { saved.push(true) } })
    const before = structuredClone(h.run.identity)
    const releasing = h.run.release()
    await h.run.stop()
    assert.deepEqual(h.run.identity, before)
    assert.deepEqual(saved, [])
    assert.deepEqual(methods(h), ['session.detach'])
    held.resolve({})
    await releasing
    await h.run.stop()
    assert.deepEqual(methods(h), ['session.detach', 'ws.close'])
    assert.deepEqual(h.run.identity, before)
  })
}

test('U6 repeated release and release after close detach at most once', async t => {
  const held = deferred()
  t.after(() => held.resolve({}))
  const h = chat(t, { request: () => held.promise })
  const first = h.run.release()
  await h.run.release()
  assert.deepEqual(methods(h), ['session.detach'])
  held.resolve({})
  await first
  await h.run.release()
  await h.run.close()
  assert.deepEqual(methods(h), ['session.detach', 'ws.close'])

  const closed = chat(t)
  await closed.run.close()
  await closed.run.release()
  assert.deepEqual(methods(closed), ['session.detach', 'ws.close'])
})

test('U7 a rejected detach still resolves release and closes the socket', async t => {
  const h = chat(t, { request: async () => { throw Error('sample detach refusal') } })
  await assert.doesNotReject(h.run.release())
  assert.deepEqual(methods(h), ['session.detach', 'ws.close'])
  assert.equal(h.transport.closed, true)
})

test('U7 an unanswered detach expires through the real short control deadline and closes', { timeout: 2000 }, async t => {
  const h = chat(t)
  // Use the real RPC timer with an in-memory socket that never replies.
  h.transport.request = HermesTransport.prototype.request
  h.transport.ws.send = raw => h.calls.push(JSON.parse(raw))
  const releasing = h.run.release()
  assert.deepEqual(methods(h), ['session.detach'])
  assert.equal(h.transport.pending.size, 1)
  assert.equal(h.transport.listeners.size, 0)
  await assert.doesNotReject(releasing)
  assert.deepEqual(methods(h), ['session.detach', 'ws.close'])
  assert.equal(h.transport.pending.size, 0)
  assert.equal(h.transport.closed, true)
})

// Own install() fixture, following hermes-connection.test.js. No fetch, socket or
// SSH implementation can run: every external boundary is an in-memory fake.
function installedChat(t, { detach } = {}) {
  const ctx = fakeContext(), wires = [], trace = [], secrets = new Map()
  const profiles = [{ id: 'sample', name: 'Sample', model: 'sample/model', provider: 'sample', running: true }]
  let activation = 0
  const rt = {
    ctx, state: { prefs: { hermesRemote: {
      enabled: true, mode: 'ssh', attached: true, authMode: 'token', address: '',
      ssh: { host: 'example.invalid' }, profile: 'sample', setupVersion: 1,
      profiles, models: [attachedModelOf(profiles[0])],
    } }, hermesSessions: {} },
    hooks: { endpoint() {} }, load: async () => {}, loadSecrets: async () => {}, save: async () => {},
    secretValue: name => secrets.get(name),
    secretEndpoint: async (name, body) => {
      assert.equal(name, 'secret-set')
      secrets.set(body.name, body.value)
    },
  }
  const snapshot = () => ({
    session_id: 'runtime-1', stored_session_id: 'stored-1', running: false, messages: [], open_requests: [],
    info: { desktop_contract: 8, approval_mode: 'manual', yolo: false, model: 'sample/model', provider: 'sample',
      stored_session_id: 'stored-1', profile_name: 'sample' },
  })
  class Wire {
    constructor(options) {
      this.options = options
      this.attached = options.attached === true
      this.deadlines = deadlines
      this.epoch = 'epoch-1'
      this.listeners = new Set()
      this.secrets = new Set(options.redactionSecrets)
      this.sent = []
      this.activations = []
      this.index = wires.length
      wires.push(this)
      trace.push({ wire: this.index, method: 'wire.open' })
    }
    async connect() { return this }
    async session(identity) { this.identity = identity; return snapshot() }
    check(value) { return value }
    async request(method, params) {
      const call = { wire: this.index, method, params }
      this.sent.push(call)
      trace.push(call)
      if (method === 'session.activate') {
        const subscription_id = `subscription-${++activation}`
        this.activations.push(subscription_id)
        return { ...snapshot(), subscription_id }
      }
      if (method === 'session.events.since') return { events: [], latest_seq: 0, epoch: this.epoch, truncated: false, open_requests: [] }
      if (method === 'session.detach') { await detach?.(this, params); return { detached: true } }
      if (method === 'prompt.submit') {
        this.emit(event('tool.start', { tool_id: `tool-${this.index}`, name: 'sample', args: {} }, 1))
        return { admission_id: `admission-${this.index}` }
      }
      throw Error(`Unexpected fixture request: ${method}`)
    }
    emit(value) { for (const listener of this.listeners) listener(value) }
    redact(value) { return value }
    text(value) { return value }
    close() {
      if (this.closed) return
      this.closed = true
      trace.push({ wire: this.index, method: 'ws.close' })
      this.emit({ kind: 'lost' })
    }
  }
  install(rt, {
    transport: options => new Wire(options), deadlines,
    fetch: async () => { throw Error('Unexpected fixture fetch') },
    startSsh: async () => ({
      attached: true, address: 'http://127.0.0.1:23456', credential: 'sample-credential',
      authHeaders: { Authorization: 'Bearer sample-credential' }, profiles, defaultProfile: 'sample', close: async () => {},
    }),
  })
  const agent = ctx.scopeAgent('chat-1')
  ctx.provide('agents', { get: id => id === 'chat-1' ? agent : undefined, list: () => [agent], roots: () => [agent] })
  const adapter = rt.hermesRemote.adapter
  t.after(async () => {
    // Cleanup is independent of the method under test and never interrupts a turn.
    for (const entry of adapter.live.values()) entry.run.dispose()
    adapter.live.clear()
    await ctx.dispose()
  })
  const stream = messages => adapter.stream(markAgentLoopRequest({
    provider: 'hermes-remote', model: 'attach', sessionId: 'chat-1', messages,
  }))
  const collect = async messages => {
    const chunks = []
    for await (const chunk of stream(messages)) chunks.push(chunk)
    return chunks
  }
  return { rt, adapter, wires, trace, collect }
}
const user = content => [{ role: 'user', content }]
function assertToolCalls(chunks) {
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.at(-1)?.reason.kind, 'tool-calls')
  const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
  assert.ok(call, 'the request parks a real remote tool call')
  return call
}
async function park(h, { complete = false } = {}) {
  const chunks = await h.collect(user('sample first message'))
  const call = assertToolCalls(chunks)
  const entry = h.adapter.live.get('chat-1'), wire = h.wires.at(-1)
  assert.ok(entry)
  assert.equal(wire.attached, true)
  assert.equal(entry.run.identity.pendingSubmit, true)
  assert.equal(entry.run.identity.subscriptionId, wire.activations[0])
  if (complete) {
    wire.emit(event('tool.complete', { tool_id: 'tool-0', result_text: 'sample result' }, 2))
    wire.emit(event('message.complete', { text: 'sample complete' }, 3))
    await tick()
    assert.equal(entry.run.identity.pendingSubmit, false)
  }
  return { entry, wire, call, subscription: entry.run.identity.subscriptionId }
}
function assertOldDetach(h, old) {
  assert.deepEqual(old.wire.sent.filter(call => call.method === 'session.detach').map(call => call.params), [
    { session_id: 'runtime-1', subscription_id: old.subscription },
  ])
  assert.equal(old.wire.closed, true)
  assert.ok(!h.trace.some(call => call.method === 'session.close'))
  assert.ok(!h.trace.some(call => call.method === 'session.interrupt'))
}

test('A1 completed parked turn detaches its OLD subscription and closes before the new wire submits', { timeout: 5000 }, async t => {
  const held = deferred()
  t.after(() => held.resolve())
  const h = installedChat(t, { detach: wire => wire.index === 0 ? held.promise : undefined })
  const old = await park(h, { complete: true })
  const replacing = h.collect(user('sample second message'))
  await until(() => h.trace.some(call => call.method === 'session.detach') || h.wires.length > 1, 'replacement to detach or open')
  assert.equal(h.wires.length, 1, 'the new wire must wait for the old detach reply')
  assert.equal(old.wire.closed, undefined)
  assert.equal(h.adapter.live.has('chat-1'), false)
  held.resolve()
  assertToolCalls(await replacing)
  assertOldDetach(h, old)
  const next = h.wires[1], current = h.adapter.live.get('chat-1')
  assert.notEqual(current.run, old.entry.run)
  assert.notEqual(next.activations[0], old.subscription)
  assert.equal(current.run.identity.subscriptionId, next.activations[0])
  const detachedAt = h.trace.findIndex(call => call.wire === 0 && call.method === 'session.detach')
  const closedAt = h.trace.findIndex(call => call.wire === 0 && call.method === 'ws.close')
  const openedAt = h.trace.findIndex(call => call.wire === 1 && call.method === 'wire.open')
  const submittedAt = h.trace.findIndex(call => call.wire === 1 && call.method === 'prompt.submit')
  assert.ok(detachedAt < closedAt && closedAt < openedAt && openedAt < submittedAt)
  assert.equal(next.sent.find(call => call.method === 'prompt.submit').params.text, 'sample second message')
})

test('A2 pending parked replacement detaches, then reconciles without another submit', { timeout: 5000 }, async t => {
  const h = installedChat(t)
  const old = await park(h)
  assert.equal(old.entry.run.identity.pendingSubmit, true)
  const chunks = await h.collect(user('sample replacement message'))
  assertOldDetach(h, old)
  assert.equal(h.wires.length, 2)
  const next = h.wires[1]
  assert.ok(next.sent.some(call => call.method === 'session.activate'))
  assert.ok(next.sent.some(call => call.method === 'session.events.since'))
  assert.ok(!next.sent.some(call => call.method === 'prompt.submit'), 'the pending turn is never resubmitted')
  assert.match(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), /Resuming the existing remote turn.*not submitted/)
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
  assert.equal(old.entry.run.identity.pendingSubmit, false, 'the idle authoritative snapshot clears the pending turn')
  assert.notEqual(next.activations[0], old.subscription)
})

test('A3 a tool-result continuation keeps the same parked run and subscription without detach', { timeout: 5000 }, async t => {
  const h = installedChat(t)
  const old = await park(h)
  // Keep this continuation parked at another tool, so ordinary final close does
  // not obscure whether the replacement path detached the first subscription.
  old.wire.emit(event('tool.complete', { tool_id: 'tool-0', result_text: 'sample result' }, 2))
  old.wire.emit(event('tool.start', { tool_id: 'tool-next', name: 'sample', args: {} }, 3))
  const chunks = await h.collect([{ role: 'tool', toolCallId: old.call.id, content: 'sample result' }])
  assertToolCalls(chunks)
  assert.equal(h.adapter.live.get('chat-1'), old.entry)
  assert.equal(h.wires.length, 1)
  assert.equal(old.entry.run.identity.subscriptionId, old.subscription)
  assert.equal(old.wire.closed, undefined)
  assert.equal(old.wire.sent.filter(call => call.method === 'prompt.submit').length, 1)
  assert.ok(!h.trace.some(call => ['session.detach', 'session.close', 'ws.close'].includes(call.method)))
})

test('A4 a rejected replacement detach still closes the old wire and submits the new turn', { timeout: 5000 }, async t => {
  const h = installedChat(t, { detach: async wire => { if (wire.index === 0) throw Error('sample detach refusal') } })
  const old = await park(h, { complete: true })
  assertToolCalls(await h.collect(user('sample second message')))
  assertOldDetach(h, old)
  assert.equal(h.wires.length, 2)
  assert.ok(h.wires[1].sent.some(call => call.method === 'prompt.submit'))
  const closedAt = h.trace.findIndex(call => call.wire === 0 && call.method === 'ws.close')
  const submittedAt = h.trace.findIndex(call => call.wire === 1 && call.method === 'prompt.submit')
  assert.ok(closedAt < submittedAt)
})
