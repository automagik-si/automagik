import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { RemoteChatAdapter } from '../src/host/remote-chat-adapter.js'

// Only adapter dependencies are faked: no network, sockets or runtime hooks.
function fixture(t, { onOpen, identity = {}, rows = [], reconciled = { unknown: false, snapshot: {} } } = {}) {
  const calls = { open: [], submit: [], next: 0, close: 0, stop: 0, dispose: 0, reconcile: [], takeRecovered: 0 }
  const model = { id: 'sample:model', model: 'model', provider: 'sample' }
  const run = {
    identity, transport: { redact: text => text },
    async submit(text, model) { calls.submit.push({ text, model }) },
    async next() { calls.next++; return rows.shift() ?? { kind: 'done' } },
    async close() { calls.close++ },
    async stop() { calls.stop++ },
    dispose() { calls.dispose++ },
    async reconcile(options) { calls.reconcile.push(options); return reconciled },
    takeRecovered() { calls.takeRecovered++; return [] },
  }
  const agent = { session: { id: 'sample-chat' }, ctx: { tools: { register: () => () => {} } } }
  const rt = { ctx: { get: name => name === 'agents' ? { get: () => agent, list: () => [agent] } : undefined, on() {} } }
  const adapter = new RemoteChatAdapter(rt, {
    enabled: () => true, models: () => [model], identity: () => identity, save: async () => {},
    open: async options => { calls.open.push(options); onOpen?.(run); return run },
  })
  t.after(() => adapter.dispose())
  return { adapter, run, calls, model }
}

async function turn(f, messages) {
  const request = markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages })
  const chunks = []
  for await (const chunk of f.adapter.stream(request)) chunks.push(chunk)
  return chunks
}

function finished(chunks, kind) {
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, kind)
}

function refused(chunks) {
  finished(chunks, 'error')
  assert.equal(chunks.at(-1).reason.failure.message, 'Remote Hermes answers only enabled Bot chat sessions.')
}

function field(target, key, reads, name, read) {
  Object.defineProperty(target, key, { configurable: true, get() {
    reads[name] = (reads[name] ?? 0) + 1
    return read(reads[name])
  } })
}

async function startTool(f) {
  const chunks = await turn(f, [{ role: 'user', content: 'Sample prompt' }])
  finished(chunks, 'tool-calls')
  const call = chunks.find(chunk => chunk.type === 'block-end').block
  assert.equal(call.type, 'tool-call')
  assert.equal(f.calls.close, 0)
  return call.id
}

function toolRows() {
  return [{ kind: 'tool', tool: { id: 'sample-tool', title: 'Sample tool', input: {} } }, { kind: 'done' }]
}

test('a marked list element replaced during open submits the original text', async t => {
  const messages = [{ role: 'user', content: 'Original' }]
  const f = fixture(t, { onOpen: () => { messages[0] = { role: 'user', content: 'Replacement' } } })
  finished(await turn(f, messages), 'stop')
  assert.deepEqual(f.calls.submit, [{ text: 'Original', model: f.model }])
  assert.equal(f.calls.open.length, 1)
})

test('a message appended during open is absent from the submitted text', async t => {
  const messages = [{ role: 'user', content: 'Original' }]
  const f = fixture(t, { onOpen: () => messages.push({ role: 'user', content: 'Appended' }) })
  finished(await turn(f, messages), 'stop')
  assert.deepEqual(f.calls.submit, [{ text: 'Original', model: f.model }])
})

test('nested content mutated during open submits the original block text', async t => {
  const block = { type: 'text', text: 'Original' }
  const messages = [{ role: 'user', content: [block] }]
  const f = fixture(t, { onOpen: () => { block.text = 'Replacement'; messages[0].content.push({ type: 'text', text: 'Appended' }) } })
  finished(await turn(f, messages), 'stop')
  assert.deepEqual(f.calls.submit, [{ text: 'Original', model: f.model }])
})

test('changing nested getters are read at most once and submit their first values', async t => {
  const reads = {}, source = {}, block = {}, message = {}
  field(source, 'kind', reads, 'source.kind', count => count === 1 ? 'sample' : 'acp-session')
  field(block, 'type', reads, 'block.type', count => count === 1 ? 'text' : 'image')
  field(block, 'text', reads, 'block.text', count => count === 1 ? 'Original' : 'Replacement')
  const content = new Proxy([block], { get(target, key, receiver) {
    if (key === 'length' || key === '0') {
      const name = `content.${key}`
      reads[name] = (reads[name] ?? 0) + 1
      if (reads[name] > 1) return key === 'length' ? 0 : { type: 'text', text: 'Replacement' }
    }
    return Reflect.get(target, key, receiver)
  } })
  field(message, 'role', reads, 'role', count => count === 1 ? 'user' : 'assistant')
  field(message, 'source', reads, 'source', count => count === 1 ? source : { kind: 'acp-session' })
  field(message, 'content', reads, 'content', count => count === 1 ? content : 'Replacement')
  field(message, 'toolCallId', reads, 'toolCallId', () => { throw Error('Unneeded tool call') })
  const f = fixture(t)
  finished(await turn(f, [message]), 'stop')
  assert.deepEqual(f.calls.submit, [{ text: 'Original', model: f.model }])
  assert.deepEqual(reads, { role: 1, source: 1, 'source.kind': 1, content: 1, 'content.length': 1, 'content.0': 1, 'block.type': 1, 'block.text': 1 })
})

test('a marked Proxy list reads length and each needed index at most once from stream entry', async t => {
  const reads = {}
  const messages = new Proxy([
    { role: 'user', content: 'Old' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'First' },
    { role: 'user', content: 'Second' },
  ], { get(target, key, receiver) {
    if (key === 'length' || /^\d+$/.test(String(key))) reads[key] = (reads[key] ?? 0) + 1
    return Reflect.get(target, key, receiver)
  } })
  const f = fixture(t)
  finished(await turn(f, messages), 'stop')
  assert.deepEqual(f.calls.submit, [{ text: 'First\n\nSecond', model: f.model }])
  assert.deepEqual(reads, { length: 1, 1: 1, 2: 1, 3: 1 })
})

test('a changing last-index accessor continues registered tool A with one read', async t => {
  const f = fixture(t, { rows: toolRows() })
  const id = await startTool(f)
  const reads = {}, first = {}, second = { role: 'tool', toolCallId: 'sample-unregistered' }
  field(first, 'role', reads, 'role', count => count === 1 ? 'tool' : 'assistant')
  field(first, 'toolCallId', reads, 'toolCallId', count => count === 1 ? id : second.toolCallId)
  const messages = [first]
  field(messages, '0', reads, 'last', count => count === 1 ? first : second)
  finished(await turn(f, messages), 'stop')
  assert.deepEqual(reads, { last: 1, role: 1, toolCallId: 1 })
  assert.equal(f.calls.open.length, 1)
  assert.equal(f.calls.submit.length, 1)
  assert.equal(f.calls.dispose, 0)
  assert.equal(f.calls.next, 2)
  assert.equal(f.calls.close, 1)
  assert.equal(f.calls.stop, 0)
})

test('continuation never reads content from earlier messages or the last tool message', async t => {
  const f = fixture(t, { rows: toolRows() })
  const id = await startTool(f)
  const reads = {}, earlier = { role: 'user' }, last = { role: 'tool', toolCallId: id }
  field(earlier, 'content', reads, 'earlier.content', () => { throw Error('Earlier content') })
  field(last, 'content', reads, 'last.content', () => { throw Error('Tool content') })
  finished(await turn(f, [earlier, last]), 'stop')
  assert.deepEqual(reads, {})
  assert.equal(f.calls.open.length, 1)
  assert.equal(f.calls.submit.length, 1)
  assert.equal(f.calls.dispose, 0)
  assert.equal(f.calls.close, 1)
})

for (const pending of ['pendingSubmit', 'uncertain']) {
  test(`${pending} recovery ignores a throwing prompt getter and never submits`, async t => {
    const reads = {}, message = { role: 'user' }
    field(message, 'content', reads, 'content', () => { throw Error('Unreadable prompt') })
    const f = fixture(t, { identity: { [pending]: true } })
    finished(await turn(f, [message]), 'stop')
    assert.deepEqual(reads, { content: 1 })
    assert.deepEqual(f.calls.reconcile, [{ answerQuestions: true }])
    assert.equal(f.calls.submit.length, 0)
    assert.equal(f.calls.takeRecovered, 1)
    assert.equal(f.calls.next, 0)
    assert.equal(f.calls.close, 1)
    assert.equal(f.calls.stop, 0)
  })
}

for (const cleanup of ['close', 'stop']) {
  test(`a needed getter throwing on submit refuses and cleans up with ${cleanup}`, async t => {
    const reads = {}, message = { role: 'user' }
    field(message, 'content', reads, 'content', () => { throw Error('Unreadable prompt') })
    const f = fixture(t)
    const stream = f.adapter.stream(markAgentLoopRequest({ provider: 'hermes-remote', model: 'sample:model', sessionId: 'sample-chat', messages: [message] }))
    refused([(await stream.next()).value])
    // Cleanup runs when the consumer resumes after the finish chunk.
    if (cleanup === 'stop') f.run.identity.pendingSubmit = true
    assert.deepEqual(await stream.next(), { value: undefined, done: true })
    assert.deepEqual(reads, { content: 1 })
    assert.equal(f.calls.open.length, 1)
    assert.equal(f.calls.submit.length, 0)
    assert.equal(f.calls.next, 0)
    assert.equal(f.calls[cleanup], 1)
    assert.equal(f.calls[cleanup === 'close' ? 'stop' : 'close'], 0)
    assert.equal(f.adapter.live.size, 0)
  })
}

for (const failing of ['index', 'role']) {
  test(`a throwing last-message ${failing} read disposes the live entry and refuses`, async t => {
    const f = fixture(t, { rows: toolRows() })
    const id = await startTool(f)
    const reads = {}, message = { role: 'tool', toolCallId: id }, messages = [message]
    field(failing === 'index' ? messages : message, failing === 'index' ? '0' : 'role', reads, failing, () => { throw Error('Unreadable last message') })
    refused(await turn(f, messages))
    assert.deepEqual(reads, { [failing]: 1 })
    assert.equal(f.calls.dispose, 1)
    assert.equal(f.calls.open.length, 1)
    assert.equal(f.calls.submit.length, 1)
    assert.equal(f.calls.next, 1)
    assert.equal(f.calls.close, 0)
    assert.equal(f.calls.stop, 0)
    assert.equal(f.adapter.live.size, 0)
  })
}

test('an earlier assistant needs only its role and skips throwing content and source', async t => {
  const reads = {}, earlier = {}
  field(earlier, 'role', reads, 'role', () => 'assistant')
  field(earlier, 'content', reads, 'content', () => { throw Error('Unneeded content') })
  field(earlier, 'source', reads, 'source', () => { throw Error('Unneeded source') })
  const f = fixture(t)
  finished(await turn(f, [earlier, { role: 'user', content: 'OK' }]), 'stop')
  assert.equal(f.calls.submit[0].text, 'OK')
  assert.deepEqual(reads, { role: 1 })
})

test('an acp-session message skips its throwing content getter', async t => {
  const reads = {}, source = {}, skipped = { role: 'user', source }
  field(source, 'kind', reads, 'kind', () => 'acp-session')
  field(skipped, 'content', reads, 'content', () => { throw Error('Unneeded content') })
  const f = fixture(t)
  finished(await turn(f, [skipped, { role: 'user', content: 'OK' }]), 'stop')
  assert.equal(f.calls.submit[0].text, 'OK')
  assert.deepEqual(reads, { kind: 1 })
})

test('a non-text block skips its throwing text getter', async t => {
  const reads = {}, skipped = {}
  field(skipped, 'type', reads, 'type', () => 'image')
  field(skipped, 'text', reads, 'text', () => { throw Error('Unneeded text') })
  const f = fixture(t)
  finished(await turn(f, [{ role: 'user', content: [skipped, { type: 'text', text: 'OK' }] }]), 'stop')
  assert.equal(f.calls.submit[0].text, 'OK')
  assert.deepEqual(reads, { type: 1 })
})

for (const [name, messages, expected] of [
  ['empty list', [], ''],
  ['empty content', [{ role: 'user' }, { role: 'user', content: null }, { role: 'user', content: [] }, { role: 'user', content: '' }], '\n\n\n\n\n\n'],
  ['mixed blocks', [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'First' }, { type: 'file' }, { type: 'text', text: 'Second' }] }], 'First\nSecond'],
  ['block and message separators', [{ role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'text', text: '' }, { type: 'text', text: 'Second' }] }, { role: 'user', content: 'Third' }], 'First\n\nSecond\n\nThird'],
  ['trailing non-user', [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Answer' }], ''],
  ['trailing run only', [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Latest' }], 'Latest'],
  ['acp-session inside trailing run', [{ role: 'user', content: 'First' }, { role: 'user', source: { kind: 'acp-session' }, content: 'Skipped' }, { role: 'user', content: 'Last' }], 'First\n\nLast'],
  ['string content', [{ role: 'user', content: 'First\nSecond' }], 'First\nSecond'],
  ['block content', [{ role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }] }], 'First\nSecond'],
]) {
  test(`promptText preserves ${name}`, () => {
    assert.equal(RemoteChatAdapter.promptText(messages), expected)
  })
}
