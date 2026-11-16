// node --test chat/engine.test.mjs: the engine API both clients call, against the fake hc and a
// temp home (never a live Herdr).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chatEnv, Engine } from './engine.js'
import { createFakeHc, fakeTerminal } from './fake-hc.mjs'

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }
const screen = (name) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')
const line = (o) => JSON.stringify(o) + '\n'
const user = (uuid, text) => line({ type: 'user', uuid, message: { role: 'user', content: text } })
const bashCall = (uuid, id, command) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })

function manualTimers() {
  const t = { timeouts: [], intervals: [] }
  return Object.assign(t, {
    setTimeout: (fn, ms) => { const h = { fn, ms }; t.timeouts.push(h); return h },
    clearTimeout: (h) => { const i = t.timeouts.indexOf(h); if (i >= 0) t.timeouts.splice(i, 1) },
    setInterval: (fn, ms) => { const h = { fn, ms }; t.intervals.push(h); return h },
    clearInterval: (h) => { const i = t.intervals.indexOf(h); if (i >= 0) t.intervals.splice(i, 1) }
  })
}

function setup({ transcript = user('u1', 'hello'), view = 'claude-idle', state = 'idle' } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'chat-engine-')))
  const path = join(home, '.claude/projects/p/s.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, transcript)
  const hc = createFakeHc({ terminals: [fakeTerminal('t1', { labels: { 'agent.transcript': path }, state }), fakeTerminal('t2', { app: 'zsh', argv: ['zsh'] })], screens: { t1: screen(view) } })
  const timers = manualTimers()
  const engine = new Engine({ hc, home, timers, flushMs: 1500, projection: { watch: null } })
  const writes = () => hc.calls.filter((c) => ['terminal.send', 'terminal.keys', 'terminal.interrupt'].includes(c.method))
  return { home, path, hc, engine, timers, writes }
}

function client(engine, address = 't1') {
  const events = []
  const me = { name: 'phone' }
  const handle = engine.watch(address, me, (e) => events.push(e))
  return { me, events, handle }
}

test('a call with no watching client is refused, and types nothing', async () => {
  const { engine, writes } = setup()
  const stranger = {}
  const a = client(engine, 't1')
  await settle()
  for (const r of [
    await engine.send(stranger, 't1', { text: 'x', id: 'm1' }),
    await engine.sendHeld(stranger, 't1', { id: 'm1' }),
    await engine.cancelHeld(stranger, 't1', { id: 'm1' }),
    await engine.answer(stranger, 't1', { row: 'approval:x', choice: 'allow' }),
    await engine.interrupt(stranger, 't1'),
    await engine.send(a.me, 't9', { text: 'x', id: 'm2' })
  ]) assert.equal(r.reason, 'not-watching')
  assert.equal(writes().length, 0)
  engine.close()
})

test('a watched terminal: rows from the transcript; a sent message is "sending" until its row arrives', async () => {
  const { engine, path, hc } = setup()
  const a = client(engine)
  await settle(); await engine.entries.get('t1').projection.ready
  assert.deepEqual(a.handle.rows().map((r) => r.text), ['hello'])
  assert.deepEqual(await engine.send(a.me, 't1', { text: 'from the phone', id: 'm1' }), { state: 'sent', id: 'm1' })
  assert.ok(a.events.some((e) => e.type === 'sending' && e.id === 'm1'))
  assert.equal(hc.calls.find((c) => c.method === 'terminal.send').params.caller, null)
  appendFileSync(path, user('u2', 'from the phone'))
  await engine.entries.get('t1').projection.tail.tick()
  assert.deepEqual(a.events.find((e) => e.type === 'matched'), { type: 'matched', id: 'm1', row: '1:2.0' })
  engine.close()
})

test('an approval: buttons from the guards, an answer re-checked and pressed, then closed', async () => {
  const { engine, hc, writes } = setup({ transcript: user('u1', 'list it') + bashCall('a1', 'toolu_1', 'ls -la /home/u/proj') })
  const a = client(engine)
  await settle(); await engine.entries.get('t1').projection.ready
  hc.screens.t1 = screen('claude-dialog')
  hc.onWrite((m) => { if (m === 'terminal.keys') hc.set('t1', { status: { app: 'claude-code', state: 'working' } }) })
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Bash: ls -la /home/u/proj' } })
  await settle()
  const row = a.events.find((e) => e.type === 'approval').row
  assert.deepEqual([row.id, row.tool, row.choices, row.call, row.open], ['approval:1:2.0', 'Bash', ['allow', 'deny'], '1:2.0', true])
  assert.deepEqual(await engine.answer(a.me, 't1', { row: 'approval:other', choice: 'allow' }), { ok: false, reason: 'no-such-row' })
  assert.equal(writes().length, 0)
  const fast = { ...engine.timers, setTimeout: (fn) => setImmediate(fn) }
  engine.timers = fast
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'allow' }), { ok: true, pressed: 'done', sent: true })
  assert.deepEqual(writes().map((c) => [c.method, c.params.keys]), [['terminal.keys', ['1']]])
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'working' } })
  await settle()
  assert.deepEqual(a.events.filter((e) => e.type === 'approval').at(-1).row.open, false)
  engine.close()
})

test('a fake dialog printed by a tool while blocked gets no buttons, and nothing is pressed', async () => {
  const { engine, hc, writes } = setup({ transcript: user('u1', 'list it') + bashCall('a1', 'toolu_1', 'ls -la /home/u/proj') })
  const a = client(engine)
  await settle(); await engine.entries.get('t1').projection.ready
  hc.screens.t1 = `${screen('claude-dialog')}⏺ printed after the dialog\n`
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Bash: ls -la /home/u/proj' } })
  await settle()
  const row = a.events.find((e) => e.type === 'approval').row
  assert.deepEqual([row.choices, row.why], [[], 'answer-in-terminal'])
  assert.equal((await engine.answer(a.me, 't1', { row: row.id, choice: 'allow' })).ok, false)
  assert.equal(writes().length, 0)
  engine.close()
})

test('a question is shown once, answered in the terminal', async () => {
  const { engine, hc } = setup()
  const a = client(engine)
  await settle()
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'question', msg: 'Pick one' }, turn: 2 })
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'question', msg: 'Pick one' }, turn: 2 })
  await settle()
  const qs = a.events.filter((e) => e.type === 'question')
  assert.equal(qs.length, 1)
  assert.deepEqual([qs[0].row.prompt, qs[0].row.answerable], ['Pick one', false])
  engine.close()
})

test('a held message goes once the terminal allows it, checked every flushMs', async () => {
  const { engine, hc, timers, writes } = setup({ view: 'claude-draft' })
  const a = client(engine)
  await settle()
  assert.equal((await engine.send(a.me, 't1', { text: 'wait for me', id: 'm1' })).why, 'draft')
  assert.deepEqual(a.handle.held(), [{ id: 'm1', why: 'draft' }])
  assert.equal(timers.intervals.filter((h) => h.ms === 1500).length, 1)
  hc.screens.t1 = screen('claude-idle')
  await timers.intervals.find((h) => h.ms === 1500).fn()
  await settle()
  assert.deepEqual(writes().map((c) => c.params.text), ['wait for me'])
  assert.equal(timers.intervals.filter((h) => h.ms === 1500).length, 0, 'nothing held: no more looking')
  engine.close()
})

test('two clients share one projection; it stays 10 minutes after the last leaves, then goes', async () => {
  const { engine, timers } = setup()
  const a = client(engine)
  const b = client(engine)
  await settle()
  const projection = engine.entries.get('t1').projection
  b.handle.close()
  assert.equal(engine.entries.get('t1').projection, projection)
  a.handle.close()
  const linger = timers.timeouts.find((h) => h.ms === 600_000)
  assert.ok(linger, 'kept for 10 minutes')
  const c = client(engine)
  assert.ok(!timers.timeouts.includes(linger), 'back before it went: kept')
  c.handle.close()
  timers.timeouts.find((h) => h.ms === 600_000).fn()
  assert.equal(engine.entries.has('t1'), false)
  assert.equal(projection.stopped, true)
  engine.close()
})

test('list: live terminals with a decoder, and whether their chat is from the transcript', async () => {
  const { engine } = setup()
  client(engine)
  await settle()
  assert.deepEqual(engine.list().map((t) => [t.terminal, t.agent, t.chat]), [['t1', 'claude', 'transcript']])
  engine.close()
})

test('chatEnv drops HC_TERMINAL_ID, so herdr-core never types a message as a note from a terminal', () => {
  const env = chatEnv({ PATH: '/usr/bin', HC_TERMINAL_ID: 't9', HC_SESSION: 'phone' })
  assert.deepEqual(env, { PATH: '/usr/bin', HC_SESSION: 'phone' })
})

async function approvalSetup({ landing = 'working' } = {}) {
  const s = setup({ transcript: user('u1', 'list it') + bashCall('a1', 'toolu_1', 'ls -la /home/u/proj') })
  const a = client(s.engine)
  const b = client(s.engine)
  await settle(); await s.engine.entries.get('t1').projection.ready
  s.hc.screens.t1 = screen('claude-dialog')
  s.hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Bash: ls -la /home/u/proj' } })
  await settle()
  if (landing) s.hc.onWrite((m) => { if (m === 'terminal.keys') s.hc.set('t1', { status: { app: 'claude-code', state: landing } }) })
  s.engine.timers = { ...s.engine.timers, setTimeout: (fn) => setImmediate(fn) }
  const row = a.events.find((e) => e.type === 'approval').row
  return { ...s, a, b, row }
}

test('two clients answering one approval at once: one key, the other refused in-flight', async () => {
  const { engine, a, b, row, writes } = await approvalSetup()
  const [x, y] = await Promise.all([engine.answer(a.me, 't1', { row: row.id, choice: 'allow' }), engine.answer(b.me, 't1', { row: row.id, choice: 'deny' })])
  assert.deepEqual([x.ok, y], [true, { ok: false, reason: 'in-flight' }])
  assert.deepEqual(writes().map((c) => c.params.keys), [['1']])
  engine.close()
})

test('a double tap from one client presses once', async () => {
  const { engine, a, row, writes } = await approvalSetup()
  const [x, y] = await Promise.all([engine.answer(a.me, 't1', { row: row.id, choice: 'allow' }), engine.answer(a.me, 't1', { row: row.id, choice: 'allow' })])
  assert.deepEqual([x.ok, y.reason], [true, 'in-flight'])
  assert.equal(writes().length, 1)
  engine.close()
})

test('keys sent but the dialog stays (uncertain): the row says not-taken, never answered; a retry is refused', async () => {
  const { engine, a, row, writes } = await approvalSetup({ landing: null })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'deny' }), { ok: true, pressed: 'uncertain', sent: true })
  await settle()
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'deny' }), { ok: false, reason: 'answered' })
  assert.equal(writes().length, 1)
  const last = a.events.filter((e) => e.type === 'approval').at(-1).row
  assert.deepEqual([last.choices, last.why], [[], 'not-taken'])
  engine.close()
})

test('every chat.answer logs one line: the terminal and row as sent, the choice, the result, what keys and the read-back saw', async () => {
  const { engine, a, row } = await approvalSetup({ landing: null })
  const logs = []
  engine.log = (m) => logs.push(m)
  await engine.answer(a.me, 't1', { row: row.id, choice: 'allow' })
  await engine.answer(a.me, 't1', { row: row.id, choice: 'allow' })
  await engine.answer({}, 't1\nforged', { row: 'r', choice: 'allow' })
  assert.deepEqual(logs, [
    'chat.answer terminal="t1" row="approval:1:2.0" choice="allow" ok=true reason=- pressed=uncertain sent=true typed=blocked/0 final=blocked/permission/0',
    'chat.answer terminal="t1" row="approval:1:2.0" choice="allow" ok=false reason=answered pressed=- sent=false typed=- final=-',
    'chat.answer terminal="t1\\nforged" row="r" choice="allow" ok=false reason=not-watching pressed=- sent=false typed=- final=-'
  ])
  engine.close()
})

test('once the status leaves blocked, the next dialog can be answered again', async () => {
  const { engine, hc, a, writes, path } = await approvalSetup()
  await engine.answer(a.me, 't1', { row: (a.events.find((e) => e.type === 'approval').row).id, choice: 'deny' })
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'working' } })
  await settle()
  appendFileSync(path, line({ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'denied' }] } }) + bashCall('a2', 'toolu_2', 'ls -la /home/u/proj'))
  await engine.entries.get('t1').projection.tail.tick()
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Bash: ls -la /home/u/proj' } })
  await settle()
  const next = a.events.filter((e) => e.type === 'approval' && e.row.open).at(-1).row
  assert.equal(next.call, '1:4.0')
  assert.equal((await engine.answer(a.me, 't1', { row: next.id, choice: 'deny' })).ok, true)
  assert.equal(writes().length, 2)
  engine.close()
})

test('the same call asked again after the status moved can be answered again', async () => {
  const { engine, hc, a, row, writes } = await approvalSetup({ landing: null })
  assert.equal((await engine.answer(a.me, 't1', { row: row.id, choice: 'deny' })).pressed, 'uncertain')
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'working' } })
  await settle()
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Bash: ls -la /home/u/proj' } })
  await settle()
  const again = a.events.filter((e) => e.type === 'approval' && e.row.open).at(-1).row
  assert.deepEqual([again.id, again.choices], [row.id, ['allow', 'deny']])
  assert.equal((await engine.answer(a.me, 't1', { row: row.id, choice: 'deny' })).ok, true)
  assert.equal(writes().length, 2)
  engine.close()
})

test('a keys call that failed or timed out still marks the call answered: no second press on retry', async () => {
  const { engine, hc, a, row, writes } = await approvalSetup({ landing: null })
  hc.onWrite((m) => { if (m === 'terminal.keys') throw Object.assign(new Error('timed out'), { kind: 'timeout' }) })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'deny' }), { ok: false, reason: 'timeout', sent: true })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'deny' }), { ok: false, reason: 'answered' })
  assert.equal(writes().filter((c) => c.method === 'terminal.keys').length, 1)
  engine.close()
})

test('a held terminal (no client left) accepts no writes; the engine says when nothing is held', async () => {
  const { engine, timers, writes } = setup()
  const a = client(engine)
  await settle()
  let emptied = 0
  engine.onEmpty = () => { emptied += 1 }
  a.handle.close()
  assert.equal(engine.empty, false, 'held for 10 minutes')
  assert.equal((await engine.send(a.me, 't1', { text: 'x', id: 'm1' })).reason, 'not-watching')
  assert.equal((await engine.interrupt(a.me, 't1')).reason, 'not-watching')
  assert.equal(writes().length, 0)
  timers.timeouts.find((h) => h.ms === 600_000).fn()
  assert.deepEqual([engine.empty, emptied], [true, 1])
  engine.close()
})

test('a held message is never typed once its client left (closed, or a removed phone)', async () => {
  const { engine, hc, timers, writes } = setup({ view: 'claude-draft' })
  const a = client(engine)
  await settle()
  assert.equal((await engine.send(a.me, 't1', { text: 'queued behind a draft', id: 'm1' })).why, 'draft')
  a.handle.close() // what endRemoved -> the chat connection's close does
  hc.screens.t1 = screen('claude-idle')
  for (const h of timers.intervals) await h.fn() // any flusher left would fire now
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'done' } })
  await settle()
  assert.equal(writes().length, 0, 'nothing typed for a client that left')
  assert.equal(timers.intervals.filter((h) => h.ms === 1500).length, 0, 'the flusher stopped')
  const back = client(engine)
  assert.deepEqual(back.handle.held(), [], 'its held message went with it')
  engine.close()
})

test('with two clients, the one leaving takes only its own held messages', async () => {
  const { engine, hc, timers, writes } = setup({ view: 'claude-draft' })
  const a = client(engine)
  const b = client(engine)
  await settle()
  await engine.send(a.me, 't1', { text: 'from a', id: 'ma' })
  await engine.send(b.me, 't1', { text: 'from b', id: 'mb' })
  a.handle.close()
  assert.deepEqual(b.handle.held().map((h) => h.id), ['mb'])
  hc.screens.t1 = screen('claude-idle')
  await timers.intervals.find((h) => h.ms === 1500).fn()
  await settle()
  assert.deepEqual(writes().map((c) => c.params.text), ['from b'])
  engine.close()
})

test('an engine holds at most maxTerminals: a held one goes first; all watched, watch is refused', async () => {
  const { engine } = setup()
  engine.maxTerminals = 2
  const one = engine.watch('t1', {}, () => {})
  const two = engine.watch('t2', {}, () => {})
  assert.equal(engine.watch('t3', {}, () => {}), null, 'all watched: refused')
  two.close() // held now
  assert.ok(engine.watch('t3', {}, () => {}), 'the held one made room')
  assert.equal(engine.entries.has('t2'), false)
  void one
  engine.close()
})

test("another phone using the same id has its own message: removing the first types only the second's", async () => {
  const { engine, hc, timers, writes } = setup({ view: 'claude-draft' })
  const a = client(engine)
  const b = client(engine)
  await settle()
  assert.equal((await engine.send(a.me, 't1', { text: 'from a', id: 'm1' })).why, 'draft')
  assert.equal((await engine.send(b.me, 't1', { text: 'from b', id: 'm1' })).why, 'behind', 'a new message, behind a\'s')
  a.handle.close() // a removed
  hc.screens.t1 = screen('claude-idle')
  await timers.intervals.find((h) => h.ms === 1500).fn()
  await settle()
  assert.deepEqual(writes().map((c) => c.params.text), ['from b'])
  engine.close()
})

test("a phone can neither send nor cancel another phone's held message", async () => {
  const { engine, writes } = setup({ view: 'claude-draft' })
  const a = client(engine)
  const b = client(engine)
  await settle()
  await engine.send(a.me, 't1', { text: 'from a', id: 'm1' })
  assert.equal((await engine.sendHeld(b.me, 't1', { id: 'm1' })).reason, 'not-held')
  assert.deepEqual(engine.cancelHeld(b.me, 't1', { id: 'm1' }), { ok: false, reason: 'not-held' })
  assert.deepEqual(a.handle.held(), [{ id: 'm1', why: 'draft' }])
  assert.deepEqual(b.handle.held(), [], "b does not see a's held message")
  assert.equal(writes().length, 0)
  assert.deepEqual(engine.cancelHeld(a.me, 't1', { id: 'm1' }), { ok: true })
  engine.close()
})

test("a message's events reach only the phone that wrote it, by its own id", async () => {
  const { engine } = setup()
  const a = client(engine)
  const b = client(engine)
  await settle()
  assert.deepEqual(await engine.send(a.me, 't1', { text: 'mine', id: 'm1' }), { state: 'sent', id: 'm1' })
  assert.deepEqual(a.events.filter((e) => ['sent', 'sending'].includes(e.type)).map((e) => [e.type, e.id]), [['sent', 'm1'], ['sending', 'm1']])
  assert.equal(b.events.filter((e) => ['held', 'sent', 'sending', 'matched', 'cancelled'].includes(e.type)).length, 0)
  engine.close()
})

test('a message held while its author left during the send is dropped, never typed', async () => {
  const { engine, hc, timers, writes } = setup({ view: 'claude-draft' })
  const a = client(engine)
  await settle()
  const sending = engine.send(a.me, 't1', { text: 'left mid-send', id: 'm1' })
  a.handle.close() // gone before the send has read the screen and held it
  assert.equal((await sending).state, 'held')
  const back = client(engine)
  assert.deepEqual(back.handle.held(), [])
  hc.screens.t1 = screen('claude-idle')
  for (const h of timers.intervals) await h.fn()
  await settle()
  assert.equal(writes().length, 0)
  engine.close()
})

test('a Retry after a reconnect (same device, new connection) is the same message: typed once', async () => {
  const { engine, writes } = setup()
  const first = { device: 'phone-a' }
  const h1 = engine.watch('t1', first, () => {})
  await settle()
  assert.deepEqual(await engine.send(first, 't1', { text: 'once', id: 'm1' }), { state: 'sent', id: 'm1' })
  h1.close()
  const again = { device: 'phone-a' } // the phone reconnected: a new connection, the same paired key
  engine.watch('t1', again, () => {})
  assert.deepEqual(await engine.send(again, 't1', { text: 'once', id: 'm1' }), { state: 'sent', id: 'm1' })
  assert.equal(writes().length, 1)
  engine.close()
})

test('two devices using the same id have two messages', async () => {
  const { engine, writes } = setup()
  const a = { device: 'phone-a' }
  const b = { device: 'phone-b' }
  engine.watch('t1', a, () => {})
  engine.watch('t1', b, () => {})
  await settle()
  await engine.send(a, 't1', { text: 'from a', id: 'm1' })
  await engine.send(b, 't1', { text: 'from b', id: 'm1' })
  assert.deepEqual(writes().map((c) => c.params.text), ['from a', 'from b'])
  engine.close()
})

test('a device that reconnects does not get back a held message its old connection took away', async () => {
  const { engine, hc, timers, writes } = setup({ view: 'claude-draft' })
  const first = { device: 'phone-a' }
  const h1 = engine.watch('t1', first, () => {})
  await settle()
  assert.equal((await engine.send(first, 't1', { text: 'held', id: 'm1' })).why, 'draft')
  h1.close() // left: dropped
  const again = { device: 'phone-a' }
  const h2 = engine.watch('t1', again, () => {})
  assert.deepEqual(h2.held(), [])
  hc.screens.t1 = screen('claude-idle')
  for (const h of timers.intervals) await h.fn()
  await settle()
  assert.equal(writes().length, 0, 'never typed by itself')
  assert.equal((await engine.send(again, 't1', { text: 'held', id: 'm1' })).state, 'sent', 'the person retries: typed once')
  assert.equal(writes().length, 1)
  engine.close()
})

// ---- questions (Claude Code AskUserQuestion). Keys as probed on Claude Code 2.1.319: a
// single-select answers with the option's digit alone (no Enter); free text is digit N+1, then the
// text, then Enter; a multi-select is each digit, then Right, then Enter. Every key its own send.

const askCall = (uuid, id, question) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [question] } }] } })
const dbQuestion = (multiSelect = false) => ({ question: 'Which database should we use?', header: 'Database', multiSelect,
  options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'A file' }] })
// Synthetic, not a recording: the question and its options drawn at the bottom of the screen.
const questionScreen = (multi = false) => [
  '❯ pick a database', '', '⏺ AskUserQuestion', '─'.repeat(40), ' ☐ Database', '', 'Which database should we use?', '',
  `❯ 1. ${multi ? '[ ] ' : ''}Postgres`, '     Relational', `  2. ${multi ? '[ ] ' : ''}SQLite`, '     A file', '  3. Type something.', '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
].join('\n') + '\n'

async function questionSetup({ multi = false, done = null } = {}) {
  const s = setup({ transcript: user('u1', 'pick a database') + askCall('a1', 'toolu_q', dbQuestion(multi)) })
  const a = client(s.engine)
  await settle(); await s.engine.entries.get('t1').projection.ready
  s.hc.screens.t1 = questionScreen(multi)
  s.hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'question', msg: 'Which database should we use?' }, turn: 3 })
  await settle()
  // The send that answers the question: then the status leaves blocked.
  if (done) s.hc.onWrite((m, p) => { if (done(m, p)) s.hc.set('t1', { status: { app: 'claude-code', state: 'working' } }) })
  const waits = []
  s.engine.timers = { ...s.engine.timers, setTimeout: (fn, ms) => { waits.push(ms); setImmediate(fn) } }
  const sends = () => s.writes().map((c) => (c.method === 'terminal.keys' ? ['keys', c.params.keys] : [c.method === 'terminal.send' ? 'send' : c.method, c.params.text, c.params.force]))
  const row = a.events.filter((e) => e.type === 'question').at(-1)?.row
  return { ...s, a, row, waits, sends }
}

test('a question row carries the open AskUserQuestion call’s options', async () => {
  const { engine, row } = await questionSetup()
  assert.deepEqual([row.id, row.prompt, row.options, row.multi, row.answerable, row.call],
    ['question:1:2.0', 'Which database should we use?', ['Postgres', 'SQLite'], false, true, '1:2.0'])
  engine.close()
})

test('single-select: the option digit alone, one send, no Enter', async () => {
  const { engine, a, row, sends } = await questionSetup({ done: (m) => m === 'terminal.keys' })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: '2' }), { ok: true, pressed: 'done', sent: true })
  assert.deepEqual(sends(), [['keys', ['2']]])
  engine.close()
})

test('free text: digit N+1, then the text and Enter, as separate sends 500 ms apart', async () => {
  const { engine, a, row, sends, waits } = await questionSetup({ done: (m) => m === 'terminal.send' })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'other', text: 'MySQL 8' }), { ok: true, pressed: 'done', sent: true })
  assert.deepEqual(sends(), [['keys', ['3']], ['send', 'MySQL 8', true]])
  assert.equal(waits[0], 500)
  engine.close()
})

test('multi-select: each digit, then Right, then Enter, every key its own send 500 ms apart', async () => {
  const { engine, a, row, sends, waits } = await questionSetup({ multi: true, done: (m, p) => m === 'terminal.keys' && p.keys[0] === 'enter' })
  assert.equal(row.multi, true)
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: '1,2' }), { ok: true, pressed: 'done', sent: true })
  assert.deepEqual(sends(), [['keys', ['1']], ['keys', ['2']], ['keys', ['right']], ['keys', ['enter']]])
  assert.deepEqual(waits.slice(0, 3), [500, 500, 500])
  engine.close()
})

test('a question that moves on mid-answer stops: no further key, finish in the terminal', async () => {
  const { engine, a, hc, row, sends } = await questionSetup({ multi: true })
  // After the first digit the terminal answers something else: the status leaves the question.
  hc.onWrite((m) => { if (m === 'terminal.keys') hc.set('t1', { status: { app: 'claude-code', state: 'working' } }) })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: '1,2' }), { ok: false, reason: 'stopped', sent: true })
  assert.deepEqual(sends(), [['keys', ['1']]])
  engine.close()
})

test('a question not on the screen, a choice out of range or free text on a multi-select: nothing pressed', async () => {
  const { engine, a, hc, row, writes } = await questionSetup()
  for (const choice of ['0', '3', '1,2', 'allow', '']) assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice }), { ok: false, reason: 'choice' })
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: 'other', text: 'two\nlines' }), { ok: false, reason: 'choice' })
  hc.screens.t1 = screen('claude-idle')
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: '1' }), { ok: false, reason: 'changed' })
  assert.equal(writes().length, 0)
  const m = await questionSetup({ multi: true })
  assert.deepEqual(await m.engine.answer(m.a.me, 't1', { row: m.row.id, choice: 'other', text: 'x' }), { ok: false, reason: 'choice' })
  assert.equal(m.writes().length, 0)
  engine.close(); m.engine.close()
})

test('a question answered uncertain (still up after the read-back) is not-taken, and not pressed twice', async () => {
  const { engine, a, row, writes } = await questionSetup()
  assert.equal((await engine.answer(a.me, 't1', { row: row.id, choice: '1' })).pressed, 'uncertain')
  await settle()
  assert.deepEqual(await engine.answer(a.me, 't1', { row: row.id, choice: '1' }), { ok: false, reason: 'answered' })
  assert.equal(writes().length, 1)
  const last = a.events.filter((e) => e.type === 'question').at(-1).row
  assert.deepEqual([last.answerable, last.why], [false, 'not-taken'])
  engine.close()
})

test('a client watching after the question was raised reads it from its handle, then it clears', async () => {
  const { engine, hc } = await questionSetup()
  const late = client(engine)
  assert.deepEqual([late.handle.question()?.id, late.handle.question()?.options], ['question:1:2.0', ['Postgres', 'SQLite']])
  assert.equal(late.events.filter((e) => e.type === 'question').length, 0)
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'working' }, turn: 3 })
  await settle()
  assert.equal(late.handle.question(), null)
  engine.close()
})
