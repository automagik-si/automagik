// node --test chat/status.test.mjs: herdr-core's status for watched terminals, from the fake hc.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { READY_MS, StatusHub, statusOf } from './status.js'
import { createFakeHc, fakeTerminal } from './fake-hc.mjs'

/** Timers a test fires by hand. */
function manualTimers() {
  const intervals = []
  const timeouts = []
  return {
    intervals, timeouts,
    setInterval: (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h },
    clearInterval: (h) => { const i = intervals.indexOf(h); if (i >= 0) intervals.splice(i, 1) },
    setTimeout: (fn, ms) => { const h = { fn, ms }; timeouts.push(h); return h },
    clearTimeout: (h) => { const i = timeouts.indexOf(h); if (i >= 0) timeouts.splice(i, 1) }
  }
}
const settle = () => new Promise((r) => setImmediate(r))

test('statusOf reads state, kind while blocked, msg, turn and title', () => {
  assert.deepEqual(statusOf({ status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'Bash' }, turn: 4, title: 'x' }),
    { state: 'blocked', kind: 'permission', msg: 'Bash', turn: 4, title: 'x', app: 'claude-code' })
  assert.deepEqual(statusOf({ state: 'finished' }), { state: 'done', kind: null, msg: '', turn: 0, title: '', app: null })
  assert.equal(statusOf({}).state, 'idle')
})

test('one subscription for every watched terminal; snapshot then changes, routed by address', async () => {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1'), fakeTerminal('box/t2')] })
  const hub = new StatusHub(hc, { timers: manualTimers() })
  const a = []
  const b = []
  hub.watch('t1', (e) => a.push(e))
  hub.watch('box/t2', (e) => b.push(e))
  await settle()
  assert.equal(hc.calls.filter((c) => c.method === 'events.subscribe').length, 1)
  assert.deepEqual(hc.calls.find((c) => c.method === 'events.subscribe').params, {})
  assert.equal(a[0].change, 'snapshot')
  hc.change('t1', 'status', { status: { app: 'claude-code', state: 'blocked', kind: 'permission', msg: '' }, reported: true, records: {} })
  assert.deepEqual(statusOf(a.at(-1).terminal), { state: 'blocked', kind: 'permission', msg: '', turn: 0, title: '', app: 'claude-code' })
  assert.equal(a.at(-1).change, 'status')
  assert.ok(!('records' in a.at(-1).terminal), 'event bookkeeping is not a fact')
  assert.equal(b.length, 1, 't2 heard nothing of t1')
  hc.change('box/t2', 'labels', { labels: { 'agent.transcript': '/home/u/.claude/projects/p/s.jsonl' } })
  assert.equal(b.at(-1).terminal.labels['agent.transcript'], '/home/u/.claude/projects/p/s.jsonl')
  hub.close()
})

test('a missed snapshot replaces facts, and older events are dropped', async () => {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1')] })
  const hub = new StatusHub(hc, { timers: manualTimers() })
  const got = []
  hub.watch('t1', (e) => got.push(e))
  await settle()
  hc.missed()
  const floor = hub.floor
  hub.onMessage({ type: 'event', terminal: 't1', seq: floor, kind: 'status', data: { status: { state: 'error' } } })
  assert.equal(statusOf(hub.current('t1')).state, 'idle', 'an event at the snapshot seq is old')
  hub.onMessage({ type: 'event', terminal: 't1', seq: floor + 1, kind: 'status', data: { status: { state: 'working' } } })
  assert.equal(statusOf(hub.current('t1')).state, 'working')
  hub.close()
})

test('a removed terminal is gone; a terminal not in the snapshot is gone', async () => {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1')] })
  const hub = new StatusHub(hc, { timers: manualTimers() })
  const one = []
  const missing = []
  hub.watch('t1', (e) => one.push(e))
  hub.watch('t9', (e) => missing.push(e))
  await settle()
  assert.deepEqual(missing, [{ type: 'gone' }])
  hub.onMessage({ type: 'event', terminal: 't1', seq: 99, kind: 'removed', data: {} })
  assert.deepEqual(one.at(-1), { type: 'gone' })
  hub.close()
})

test('a subscription that ends says offline and opens again; a quiet one is reopened', async () => {
  const timers = manualTimers()
  let now = 0
  const hc = createFakeHc({ terminals: [fakeTerminal('t1')] })
  const hub = new StatusHub(hc, { timers, now: () => now, staleMs: 45_000 })
  const got = []
  hub.watch('t1', (e) => got.push(e))
  await settle()
  hc.drop()
  assert.deepEqual(got.at(-1), { type: 'offline' })
  assert.equal(timers.timeouts.length, 1)
  timers.timeouts.shift().fn()
  await settle()
  assert.equal(hc.calls.filter((c) => c.method === 'events.subscribe').length, 2)
  assert.equal(got.at(-1).change, 'snapshot')
  now = 50_000
  timers.intervals.at(-1).fn()
  await settle()
  assert.equal(hc.calls.filter((c) => c.method === 'events.subscribe').length, 3, 'no heartbeat for 45 s: reopened')
  hub.close()
})

test('the last watcher leaving closes the subscription', async () => {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1')] })
  const hub = new StatusHub(hc, { timers: manualTimers() })
  const stop = hub.watch('t1', () => {})
  await settle()
  assert.equal(hc.subscriptions, 1)
  stop()
  assert.equal(hc.subscriptions, 0)
})

test('a held hub is subscribed with nothing watched, stays so after the last watcher, and reopens', async () => {
  const timers = manualTimers()
  const hc = createFakeHc({ terminals: [fakeTerminal('t1'), fakeTerminal('t2')] })
  const hub = new StatusHub(hc, { timers })
  const release = hub.hold()
  await settle()
  assert.deepEqual(hub.all().map((t) => t.address), ['t1', 't2'], 'cold: the snapshot is there')
  const stop = hub.watch('t1', () => {})
  stop()
  assert.equal(hc.subscriptions, 1, 'the last watcher leaving keeps a held subscription')
  hc.drop()
  assert.equal(timers.timeouts.length, 1, 'an ended one is retried while held')
  timers.timeouts.shift().fn()
  await settle()
  assert.equal(hc.calls.filter((c) => c.method === 'events.subscribe').length, 2)
  const other = hub.hold()
  release()
  release()
  assert.equal(hc.subscriptions, 1, 'one release twice is still one: the other hold keeps it')
  other()
  assert.equal(hc.subscriptions, 0, 'every hold released: closed')
  hub.close()
})

test('ready waits for the first snapshot; an hc that never answers ends the wait at READY_MS', async () => {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1')] })
  const hub = new StatusHub(hc, { timers: manualTimers() })
  hub.hold()
  assert.deepEqual(hub.all(), [], 'nothing yet: the snapshot is on its way')
  await hub.ready()
  assert.deepEqual(hub.all().map((t) => t.address), ['t1'])
  await hub.ready() // already in: at once
  hub.close()

  const timers = manualTimers()
  const silent = new StatusHub({ subscribe: () => ({ close() {} }) }, { timers })
  silent.hold()
  let done = false
  silent.ready().then(() => { done = true })
  await settle()
  assert.equal(done, false)
  const wait = timers.timeouts.find((h) => h.ms === READY_MS)
  assert.ok(wait, 'bounded by READY_MS')
  wait.fn()
  await settle()
  assert.equal(done, true, 'answers with what it has, empty')
  assert.equal(silent.waiting.size, 0)
  silent.close()
})

test('a listener that throws stops neither the others nor the hub', async () => {
  const hc = createFakeHc({ terminals: [fakeTerminal('t1')] })
  const hub = new StatusHub(hc, { timers: manualTimers() })
  const got = []
  hub.watch('t1', () => { throw new Error('listener bug') })
  hub.watch('t1', (e) => got.push(e.change))
  await settle()
  hc.change('t1', 'status', { status: { state: 'working' } })
  assert.deepEqual(got, ['snapshot', 'status'])
  hub.close()
})
