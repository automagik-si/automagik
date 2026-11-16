// node --test chat/input.test.mjs: messages typed into the terminal, against the fake hc. A held
// draft is never cleared, nothing is forced into a dialog, no caller is passed, and a multi-line
// message is one terminal.send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Input, MAX_SEND_BYTES } from './input.js'
import { createFakeHc, fakeTerminal } from './fake-hc.mjs'

const screen = (name) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')
const APP = { claude: 'claude-code', codex: 'codex', omp: 'omp' }

function setup({ agent = 'claude', state = 'idle', view = `${agent}-idle` } = {}) {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1', { app: APP[agent], argv: [agent], state })] })
  let facts = { agent, status: { state }, screen: screen(view) }
  const set = (over) => {
    facts = { ...facts, ...over }
    if (over.status) hc.set('t1', { status: { app: APP[agent], ...over.status } })
  }
  const input = new Input({ hc, address: 't1', read: async () => facts })
  const events = []
  input.on((e) => events.push(e))
  const writes = () => hc.calls.filter((c) => c.method.startsWith('terminal.') && c.method !== 'terminal.get' && c.method !== 'terminal.read')
  return { hc, input, set, events, writes }
}

test('a plain message is cleaned and sent once, with if=idle, no caller and no force', async () => {
  const { input, writes } = setup()
  assert.deepEqual(await input.send({ text: 'hi\x1b[200~ there', id: 'm1' }), { state: 'sent', id: 'm1' })
  assert.deepEqual(writes().map((c) => [c.method, c.params]), [['terminal.send', { terminal: 't1', text: 'hi there', caller: null, if: 'idle' }]])
})

test('per agent, a multi-line message is one terminal.send with every line', async () => {
  for (const agent of ['claude', 'codex', 'omp']) {
    const { input, writes } = setup({ agent })
    assert.equal((await input.send({ text: 'line one\r\nline two\nline three', id: 'm' })).state, 'sent', agent)
    assert.deepEqual(writes().map((c) => c.params.text), ['line one\nline two\nline three'], agent)
  }
})

test('a half-typed draft holds the message; nothing clears the draft; it goes once the row is empty', async () => {
  const { input, set, writes, events } = setup({ view: 'claude-draft' })
  assert.deepEqual(await input.send({ text: 'from the phone', id: 'm1' }), { state: 'held', id: 'm1', why: 'draft', text: 'from the phone' })
  await input.flush()
  assert.equal(writes().length, 0, 'no key, no send: the draft is untouched')
  set({ screen: screen('claude-idle') })
  await input.flush()
  assert.deepEqual(writes().map((c) => [c.method, c.params.text]), [['terminal.send', 'from the phone']])
  assert.deepEqual(events.map((e) => [e.type, e.id, e.why ?? e.state]), [['held', 'm1', 'draft'], ['sent', 'm1', 'sent']])
})

test('Send now pastes after the draft as one message, warned, and clears nothing', async () => {
  const { input, writes } = setup({ agent: 'codex', view: 'codex-draft' })
  await input.send({ text: 'appended', id: 'm1' })
  assert.deepEqual(await input.sendHeld({ id: 'm1' }), { state: 'sent', id: 'm1', warned: 'draft' })
  assert.deepEqual(writes().map((c) => c.method), ['terminal.send'], 'only the send: no backspace, no ctrl+u')
  assert.deepEqual(await input.sendHeld({ id: 'm1' }), { state: 'sent', id: 'm1' }, 'answered again, typed once')
  assert.equal(writes().length, 1)
})

test('an input row that cannot be read holds the message', async () => {
  const { input, writes } = setup({ view: 'claude-dialog', state: 'idle' })
  assert.equal((await input.send({ text: 'x', id: 'm1' })).why, 'no-input-row')
  assert.equal(writes().length, 0)
})

test('a dialog open: the message waits, never forced; a dialog opening during the send holds it too', async () => {
  const a = setup({ state: 'blocked' })
  assert.equal((await a.input.send({ text: 'x', id: 'm1' })).why, 'dialog')
  assert.equal(a.writes().length, 0)
  const b = setup()
  b.hc.set('t1', { status: { app: 'claude-code', state: 'blocked' } }) // herdr-core sees it, our read did not
  assert.equal((await b.input.send({ text: 'x', id: 'm1' })).why, 'dialog')
  assert.ok(b.writes().every((c) => !c.params.force), 'never forced')
})

test('a status that changed between the read and the send (if) holds the message', async () => {
  const { hc, input } = setup()
  hc.set('t1', { status: { app: 'claude-code', state: 'working' } })
  assert.equal((await input.send({ text: 'x', id: 'm1' })).why, 'changed')
})

test('while working: Claude queues it (if=working); Codex and omp hold it until idle', async () => {
  const c = setup({ state: 'working' })
  assert.deepEqual(await c.input.send({ text: 'x', id: 'm1' }), { state: 'queued', id: 'm1' })
  assert.equal(c.writes()[0].params.if, 'working')
  for (const agent of ['codex', 'omp']) {
    const o = setup({ agent, state: 'working' })
    assert.equal((await o.input.send({ text: 'x', id: 'm1' })).why, 'working', agent)
    assert.equal(o.writes().length, 0)
  }
})

test('a done pane is sent to without if (herdr-core matches if exactly: idle or working)', async () => {
  const { input, writes } = setup({ state: 'done' })
  await input.send({ text: 'x', id: 'm1' })
  assert.ok(!('if' in writes()[0].params))
})

test('held messages go in order, oldest first; a new one waits behind them', async () => {
  const { input, set, writes } = setup({ view: 'claude-draft' })
  await input.send({ text: 'first', id: 'a' })
  assert.equal((await input.send({ text: 'second', id: 'b' })).why, 'behind')
  set({ screen: screen('claude-idle') })
  await input.flush()
  assert.deepEqual(writes().map((c) => c.params.text), ['first', 'second'])
})

test('the same id is never typed twice; a cancelled message never goes', async () => {
  const { input, set, writes } = setup()
  await input.send({ text: 'x', id: 'm1' })
  assert.deepEqual(await input.send({ text: 'x', id: 'm1' }), { state: 'sent', id: 'm1' })
  assert.equal(writes().length, 1)
  set({ screen: screen('claude-draft') })
  await input.send({ text: 'y', id: 'm2' })
  assert.deepEqual(input.cancelHeld({ id: 'm2' }), { ok: true })
  set({ screen: screen('claude-idle') })
  await input.flush()
  assert.equal(writes().length, 1)
  assert.deepEqual(input.cancelHeld({ id: 'm2' }), { ok: false, reason: 'not-held' })
})

test('refused: empty after cleaning, too long, no id', async () => {
  const { input, writes } = setup()
  assert.deepEqual(await input.send({ text: '\x1b[200~\x1b[201~ ', id: 'm1' }), { state: 'refused', id: 'm1', reason: 'empty' })
  assert.equal((await input.send({ text: 'x'.repeat(MAX_SEND_BYTES + 1), id: 'm2' })).reason, 'too-long')
  assert.equal((await input.send({ text: 'x', id: '' })).reason, 'id')
  assert.equal(writes().length, 0)
})

test('interrupt is one terminal.interrupt and nothing else (never a second esc)', async () => {
  const { input, writes } = setup({ state: 'working' })
  assert.deepEqual(await input.interrupt(), { ok: true, outcome: 'stopped' })
  assert.deepEqual(writes().map((c) => [c.method, c.params]), [['terminal.interrupt', { terminal: 't1' }]])
})

test('two sends of one id at once paste once', async () => {
  const { input, writes } = setup()
  const [a, b] = await Promise.all([input.send({ text: 'once', id: 'm1' }), input.send({ text: 'once', id: 'm1' })])
  assert.deepEqual([a, b], [{ state: 'sent', id: 'm1' }, { state: 'sent', id: 'm1' }])
  assert.equal(writes().length, 1)
})

test('Send now racing a flush pastes once', async () => {
  const { input, set, writes } = setup({ view: 'claude-draft' })
  await input.send({ text: 'race', id: 'm1' })
  set({ screen: screen('claude-idle') })
  await Promise.all([input.sendHeld({ id: 'm1' }), input.flush(), input.sendHeld({ id: 'm1' })])
  assert.deepEqual(writes().map((c) => c.params.text), ['race'])
})

test('Send now keeps the held order: only the oldest held message can go', async () => {
  const { input, writes } = setup({ view: 'claude-draft' })
  await input.send({ text: 'first', id: 'a' })
  await input.send({ text: 'second', id: 'b' })
  assert.equal((await input.sendHeld({ id: 'b' })).reason, 'behind')
  assert.equal(writes().length, 0)
  assert.equal((await input.sendHeld({ id: 'a' })).state, 'sent')
  assert.deepEqual(writes().map((c) => c.params.text), ['first'])
})

test('Send now never goes into a terminal whose input row cannot be seen', async () => {
  const { input, set, writes } = setup({ view: 'claude-draft' })
  await input.send({ text: 'x', id: 'm1' })
  set({ screen: screen('claude-dialog') })
  assert.equal((await input.sendHeld({ id: 'm1' })).why, 'no-input-row')
  assert.equal(writes().length, 0)
})
