// The catalog of an agent's models and efforts: read from the agent, kept on disk, stood in for
// while the agent has not answered.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Catalog, cliStamp, readCatalog, reasoningOf, STALE_MS } from '../src/host/catalog.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const FALLBACK = [{ id: 'default', name: 'Stand-in' }]
const scratch = () => mkdtempSync(join(tmpdir(), 'acp-dsh-catalog-'))
const fake = { command: process.execPath, args: [FAKE] }
const broken = { command: process.execPath, args: [join(import.meta.dirname, 'fixtures', 'no-such-agent.mjs')] }

function catalog(home, { spawn = () => fake, key = () => 'v1', now } = {}) {
  const logs = []
  const made = new Catalog({ id: 'acp-test', name: 'Test agent', defaultName: 'Test agent', fallback: FALLBACK, home, key, spawn, log: line => logs.push(line), ...(now ? { now } : {}) })
  return Object.assign(made, { logs })
}

test('a probe is kept on disk, and the next start lists it before the agent answers again', async (t) => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const first = catalog(home)
  t.after(() => first.dispose())
  assert.deepEqual((await first.models()).map(model => model.id), ['default', 'fake-large', 'fake-small', 'fake-plain'])
  await first.probing
  const kept = JSON.parse(readFileSync(join(home, 'acp-test.json'), 'utf8'))
  assert.equal(kept.key, 'v1')
  assert.deepEqual(kept.models.find(model => model.id === 'fake-small').reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(kept.models.some(model => 'probed' in model), false)
  // Next start: the agent cannot answer now, yet what it said last time is listed at once.
  const next = catalog(home, { spawn: () => broken, key: () => 'v2' })
  t.after(() => next.dispose())
  assert.deepEqual((await next.models()).map(model => model.id), ['default', 'fake-large', 'fake-small', 'fake-plain'])
  assert.deepEqual((await next.model('fake-small')).reasoning.defaultEffort, 'low')
})

test('an agent that does not answer leaves the stand-ins, and is asked again only after a while', async (t) => {
  let now = 1000
  let spawned = 0
  const made = catalog(undefined, { spawn: () => { spawned++; return broken }, now: () => now })
  t.after(() => made.dispose())
  assert.deepEqual(await made.models(), FALLBACK)
  await made.probing
  assert.match(made.logs.join('\n'), /could not read Test agent's models, offering its usual ones/)
  await made.models()
  assert.equal(spawned, 1)
  now += 11 * 60 * 1000
  await made.models()
  await made.probing
  assert.equal(spawned, 2)
})

test("a new release of the agent's adapter is asked again", async (t) => {
  let key = 'v1'
  let spawned = 0
  const made = catalog(undefined, { spawn: () => { spawned++; return fake }, key: () => key })
  t.after(() => made.dispose())
  await made.models()
  await made.probing
  await made.models()
  assert.equal(spawned, 1)
  key = 'v2'
  await made.models()
  await made.probing
  assert.equal(spawned, 2)
  // No adapter installed: no probe, the stand-ins (or what was read) stay.
  key = undefined
  await made.models()
  assert.equal(made.probing, undefined)
})

test("an agent's own default model is kept as it names it; efforts come per model, its default row left out", async () => {
  // Claude Code's adapter: `default` is one of its models, and each model brings its own efforts.
  const efforts = { default: ['default', 'low', 'high'], opus: ['default', 'low', 'high', 'max'], haiku: [] }
  let model = 'default'
  const option = (category) => {
    if (category === 'model') return { id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ group: 'all', name: 'All', options: Object.keys(efforts).map(value => ({ value, name: value === 'default' ? 'Default (recommended)' : value })) }] }
    if (efforts[model].length === 0) return undefined
    return { id: 'effort', category: 'thought_level', type: 'select', currentValue: model === 'opus' ? 'max' : 'default', options: efforts[model].map(value => ({ value, name: value })) }
  }
  const run = { startModel: 'default', option, setOption: async (category, value) => { model = value } }
  const state = await readCatalog(run, { defaultName: 'Claude Code' })
  assert.equal(state.complete, true)
  assert.deepEqual(state.models.map(entry => [entry.id, entry.name]), [['default', 'Default (recommended)'], ['opus', 'opus'], ['haiku', 'haiku']])
  assert.deepEqual(state.models[0].reasoning, { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] })
  assert.deepEqual(state.models[1].reasoning.defaultEffort, 'max')
  assert.equal(state.models[2].reasoning, undefined)
  assert.equal(reasoningOf(undefined), undefined)
})


test('a kept file of any other shape is not used: the stand-ins answer until a probe writes it again', async (t) => {
  const { writeFileSync } = await import('node:fs')
  const shapes = [
    { models: [null] },
    { models: [{ id: 'opus', name: 'Opus', reasoning: { efforts: 'high' } }] },
    { models: [{ id: 'opus', name: 'Opus', reasoning: { efforts: [{ id: 3, name: 'x' }] } }] },
    { models: [{ id: 'opus', name: 'Opus', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'max' } }] },
    { models: [{ id: 'opus' }] },
    { models: [] },
    'not json',
  ]
  for (const shape of shapes) {
    const home = scratch()
    t.after(() => rmSync(home, { recursive: true, force: true }))
    writeFileSync(join(home, 'acp-test.json'), typeof shape === 'string' ? shape : JSON.stringify({ key: 'v1', ...shape }))
    // No adapter installed: no probe, so only the kept file could answer.
    const made = catalog(home, { key: () => undefined })
    t.after(() => made.dispose())
    assert.deepEqual(await made.models(), FALLBACK, JSON.stringify(shape))
  }
  // A well-formed one is used.
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'acp-test.json'), JSON.stringify({ key: 'v1', models: [{ id: 'opus', name: 'Opus', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }))
  assert.deepEqual((await catalog(home, { key: () => undefined }).models()).map(model => model.id), ['opus'])
})

test("a model's own effort is the one read for it or kept, at once: a stand-in never answers, a probe is never waited on", async (t) => {
  const { writeFileSync } = await import('node:fs')
  const made = catalog(undefined, { key: () => undefined })
  t.after(() => made.dispose())
  const effort = (id, defaultEffort) => ({ efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }].filter(level => id === 'default' || level.id !== 'medium'), defaultEffort })
  // Mid-probe: the start model is read, the other not yet, so its listed efforts stand in from the start model's.
  made.live = { complete: false, models: [{ id: 'default', name: 'Default', reasoning: effort('default', 'medium'), probed: true }, { id: 'small', name: 'Small', probed: false }] }
  made.probing = new Promise(() => {})
  assert.equal((await made.model('small')).reasoning.defaultEffort, 'medium')
  // A probe that never ends: the answer is immediate (not a promise) and no stand-in.
  assert.equal(made.ownEffort('small'), undefined)
  assert.equal(made.ownEffort('default'), 'medium')
  made.live.models[1] = { id: 'small', name: 'Small', reasoning: effort('small', 'low'), probed: true }
  assert.equal(made.ownEffort('small'), 'low')
  // Nothing read: what was kept answers; nothing kept, nothing does.
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'acp-test.json'), JSON.stringify({ key: 'v1', models: [{ id: 'small', name: 'Small', reasoning: effort('small', 'high') }] }))
  const kept = catalog(home, { key: () => undefined })
  t.after(() => kept.dispose())
  assert.equal(kept.ownEffort('small'), 'high')
  assert.equal(catalog(undefined, { key: () => undefined }).ownEffort('default'), undefined)
})

test('a kept catalog from the release installed now is not probed again at start; another release is', async (t) => {
  const { writeFileSync } = await import('node:fs')
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // #1564 PR B (B2-2 (b)): this release keeps the start model too; a file without it is read again once.
  writeFileSync(join(home, 'acp-test.json'), JSON.stringify({ key: 'v1', at: Date.now() - 60 * 60 * 1000, start: null, models: [{ id: 'default', name: 'Kept' }] }))
  let spawned = 0
  const same = catalog(home, { key: () => 'v1', spawn: () => { spawned++; return fake } })
  t.after(() => same.dispose())
  assert.deepEqual((await same.models()).map(model => model.name), ['Kept'])
  assert.equal(same.probing, undefined)
  assert.equal(spawned, 0)
  const next = catalog(home, { key: () => 'v2', spawn: () => { spawned++; return fake } })
  t.after(() => next.dispose())
  await next.models()
  await next.probing
  assert.equal(spawned, 1)
})

test('a kept catalog a day old is read again behind the picker, which answers from it at once', async (t) => {
  const { writeFileSync } = await import('node:fs')
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = join(home, 'acp-test.json')
  writeFileSync(file, JSON.stringify({ key: 'v1', at: Date.now() - STALE_MS - 60_000, models: [{ id: 'default', name: 'Kept' }] }))
  let spawned = 0
  const stale = catalog(home, { key: () => 'v1', spawn: () => { spawned++; return fake } })
  t.after(() => stale.dispose())
  assert.deepEqual((await stale.models()).map(model => model.name), ['Kept'])
  assert.equal(spawned, 1)
  await stale.probing
  const kept = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Date.now() - kept.at < 60_000, 'the new read is kept with its time')
  assert.deepEqual(kept.models.map(model => model.id), ['default', 'fake-large', 'fake-small', 'fake-plain'])
  // Read just now: not again in this process either.
  await stale.models()
  assert.equal(spawned, 1)
})

test("the CLI's key changes when it is updated, through a link or in place, with no process spawned", async (t) => {
  const { mkdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } = await import('node:fs')
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  for (const version of ['1.0', '2.0']) {
    mkdirSync(join(home, version))
    writeFileSync(join(home, version, 'claude'), '#!/bin/sh\n')
  }
  mkdirSync(join(home, 'bin'))
  const link = join(home, 'bin', 'claude')
  symlinkSync(join(home, '1.0', 'claude'), link)
  const first = cliStamp(link)
  assert.match(first, /1\.0\/claude \d/)
  // The installer moves the link to a new version's folder.
  unlinkSync(link)
  symlinkSync(join(home, '2.0', 'claude'), link)
  const second = cliStamp(link)
  assert.notEqual(second, first)
  // npm writes the new version over the same file.
  utimesSync(join(home, '2.0', 'claude'), new Date(), new Date(Date.now() + 5000))
  assert.notEqual(cliStamp(link), second)
  // Gone: the path itself, never a throw.
  assert.equal(cliStamp(join(home, 'nothing')), join(home, 'nothing'))
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('refresh bypasses auth backoff and freshness and keeps complete results', async t => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let launch = { ...fake, env: { FAKE_ACP_AUTH: 'session' } }
  let spawned = 0
  const made = catalog(home, {
    now: () => 1000, spawn: () => { spawned++; return launch },
  })
  t.after(() => made.dispose())
  await made.models()
  await made.probing
  assert.equal(made.access, false)
  launch = fake
  await made.refresh()
  assert.equal(spawned, 2)
  assert.equal(made.access, true)
  const complete = made.current()
  const disk = readFileSync(made.file, 'utf8')
  launch = broken
  await made.refresh()
  assert.deepEqual(made.current(), complete)
  assert.equal(readFileSync(made.file, 'utf8'), disk)
  const kept = catalog(home, { now: () => 1000, spawn: () => { spawned++; return fake } })
  t.after(() => kept.dispose())
  await kept.models()
  assert.equal(spawned, 3)
  await kept.refresh()
  assert.equal(spawned, 4)
})

test('Codex falls back only to default, without sign-in evidence, until a probe', async t => {
  const { AGENTS } = await import('../src/host/agents.js')
  const made = new Catalog({ ...AGENTS['acp-codex'], id: 'acp-codex',
    key: () => undefined, spawn: () => fake })
  t.after(() => made.dispose())
  assert.deepEqual(made.current().map(({ id, name }) => [id, name]), [
    ['default', 'Codex'],
  ])
  assert.deepEqual(made.current()[0].reasoning.efforts.map(effort => effort.id),
    ['low', 'medium', 'high'])
  assert.equal(await made.signedIn(), undefined)
  made.spec.key = () => 'v1'
  await made.refresh()
  assert.deepEqual(made.current().map(model => model.id),
    ['default', 'fake-large', 'fake-small', 'fake-plain'])
})

test('signed-out failures keep the complete list in memory and on disk', async t => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let launch = fake
  const made = catalog(home, { spawn: () => launch })
  t.after(() => made.dispose())
  await made.refresh()
  const disk = readFileSync(made.file, 'utf8')
  const complete = JSON.parse(disk).models
  assert.deepEqual(complete.map(model => model.id),
    ['default', 'fake-large', 'fake-small', 'fake-plain'])
  launch = { ...fake, env: { FAKE_ACP_AUTH: 'session' } }
  await made.refresh()
  assert.equal(made.access, false)
  assert.equal(JSON.stringify(made.current().map(({ probed, ...model }) => model)),
    JSON.stringify(complete))
  made.dispose()
  const kept = catalog(home, { spawn: () => launch })
  t.after(() => kept.dispose())
  await kept.refresh()
  assert.equal(kept.access, false)
  assert.deepEqual(kept.current(), complete)
  assert.equal(readFileSync(kept.file, 'utf8'), disk)
})

test('a first effort failure keeps the native model list with one notice', async t => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const made = catalog(home, { spawn: () => ({ ...fake, env: {
    FAKE_ACP_SESSION_MODELS: '1', FAKE_ACP_SET_MODEL_FAIL: 'fake-plain',
  } }) })
  t.after(() => made.dispose())
  const notices = []
  made.spec.onChange = () => notices.push(structuredClone(made.current()))
  await made.refresh()
  assert.deepEqual(made.current().map(model => [model.id, model.name]), [
    ['default', 'Test agent'], ['fake-large', 'Fake Large'],
    ['fake-small', 'Fake Small'], ['fake-plain', 'Fake Plain'],
  ])
  assert.equal(made.live.complete, false)
  assert.equal(made.live.models.find(model => model.id === 'fake-small').probed, true)
  assert.equal(made.live.models.find(model => model.id === 'fake-plain').probed, false)
  assert.match(made.logs.join('\n'), /Internal error/i)
  assert.equal(notices.length, 1)
  assert.deepEqual(made.current().map(({ probed, ...model }) => model),
    notices[0].map(({ probed, ...model }) => model))
  assert.equal(made.saved, undefined)
  assert.throws(() => readFileSync(made.file), { code: 'ENOENT' })
})

test('a throwing change callback is logged and the probe still completes', async t => {
  const h = await controlled(t)
  const { AgentRun } = await import('../src/host/acp.js')
  const option = AgentRun.prototype.option
  let selected = false
  t.mock.method(AgentRun.prototype, 'option', function (category) {
    if (category !== 'thought_level') return option.call(this, category)
    return selected ? { options: [{ value: 'high', name: 'High' }] } : undefined
  })
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const made = catalog(home)
  t.after(() => made.dispose())
  let notices = 0
  made.spec.onChange = () => { notices++; throw new Error('publish failed') }
  const probing = made.refresh()
  await h.tick()
  h.starts[0].resolve()
  await h.tick()
  selected = true
  h.reads[0].resolve()
  await h.tick()
  h.reads[1].resolve()
  await assert.doesNotReject(probing)
  assert.equal(notices, 2)
  assert.equal(made.logs.filter(line => /could not publish.*publish failed/.test(line)).length, 2)
  assert.equal(made.access, true)
  assert.equal(made.failedAt, undefined)
  assert.equal(made.live.complete, true)
  assert.deepEqual(JSON.parse(readFileSync(made.file, 'utf8')).models,
    JSON.parse(JSON.stringify(made.current().map(({ probed, ...model }) => model))))
})

// A controlled AgentRun lets a retired read finish even after its process was disposed.
async function controlled(t) {
  const { AgentRun } = await import('../src/host/acp.js')
  const starts = [], reads = [], runs = []
  t.mock.method(AgentRun.prototype, 'start', function () {
    runs.push(this)
    this.child = {}
    const wait = deferred()
    starts.push(wait)
    return wait.promise
  })
  t.mock.method(AgentRun.prototype, 'dispose', function () { this.disposed = true })
  t.mock.method(AgentRun.prototype, 'option', function (category) {
    if (category === 'model') return { options: [
      { value: 'x', name: 'X' }, { value: 'u', name: 'U' },
    ] }
    return { options: [{ value: 'high', name: 'High' }], currentValue: 'high' }
  })
  t.mock.method(AgentRun.prototype, 'setOption', function () {
    const wait = deferred()
    reads.push(wait)
    return wait.promise
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const finish = async () => {
    starts.at(-1).resolve()
    await tick()
    reads.at(-1).resolve()
    await tick()
    reads.at(-1).resolve()
    await tick()
  }
  return { starts, reads, runs, tick, finish }
}

for (const failure of [false, true]) {
  test(`refresh retires an older read that later ${failure ? 'fails' : 'succeeds'}`, async t => {
    const h = await controlled(t)
    const home = scratch()
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const made = catalog(home)
    t.after(() => made.dispose())
    let notices = 0
    made.spec.onChange = () => { notices++ }
    made.kick()
    const older = made.probing
    await h.tick()
    h.starts[0].resolve()
    await h.tick()
    const oldRead = h.reads[0]
    const fresh = made.refresh()
    assert.equal(h.runs[0].disposed, true)
    assert.equal(made.refresh(), fresh)
    assert.equal(made.refresh(), fresh)
    await h.tick()
    assert.equal(h.runs.length, 2)
    await h.finish()
    await fresh
    const before = {
      live: structuredClone(made.live), saved: structuredClone(made.saved),
      access: made.access, failedAt: made.failedAt, readAt: made.readAt, notices,
      disk: readFileSync(made.file, 'utf8'),
    }
    if (failure) oldRead.reject(new Error('late failure'))
    else oldRead.resolve()
    await older
    assert.deepEqual({
      live: made.live, saved: made.saved, access: made.access, failedAt: made.failedAt,
      readAt: made.readAt, notices, disk: readFileSync(made.file, 'utf8'),
    }, before)
    assert.equal(made.probing, undefined)
    assert.equal(made.run, undefined)
  })
}

test('retiring a pending spawn releases list waiters and cannot clear the next run', async t => {
  const h = await controlled(t)
  const pending = deferred()
  let launches = 0
  const made = catalog(undefined, {
    spawn: () => (++launches === 1 ? pending.promise : fake),
  })
  t.after(() => made.dispose())
  const waiting = made.models()
  const older = made.probing
  const fresh = made.refresh()
  await waiting
  await h.tick()
  const run = made.run
  pending.resolve(fake)
  await older
  assert.equal(made.run, run)
  assert.equal(made.probing, fresh)
  assert.equal(h.runs.length, 1)
  await h.finish()
  await fresh
})

for (const phase of ['spawn', 'start', 'read']) {
  test(`dispose during ${phase} stops writes, notices and later launches`, async t => {
    const h = await controlled(t)
    const pending = deferred()
    const made = catalog(undefined, { spawn: () => pending.promise })
    let notices = 0
    made.spec.onChange = () => { notices++ }
    made.kick()
    const probing = made.probing
    const listed = made.listed
    if (phase !== 'spawn') {
      pending.resolve(fake)
      await h.tick()
    }
    if (phase === 'read') {
      h.starts[0].resolve()
      await h.tick()
    }
    made.dispose()
    const before = { live: structuredClone(made.live), access: made.access, notices }
    await listed
    pending.resolve(fake)
    h.starts[0]?.resolve()
    h.reads[0]?.resolve()
    await probing
    await made.refresh()
    assert.deepEqual({ live: made.live, access: made.access, notices }, before)
    assert.equal(made.saved, undefined)
    assert.equal(made.readAt, undefined)
    assert.equal(made.failedAt, undefined)
    assert.equal(h.runs.length, phase === 'spawn' ? 0 : 1)
  })
}

test('notices describe the first list and completed efforts, never each effort read', async t => {
  const h = await controlled(t)
  // No provisional efforts: the first list and its completion visibly differ.
  const { AgentRun } = await import('../src/host/acp.js')
  let selected = false
  t.mock.method(AgentRun.prototype, 'option', category => {
    if (category === 'model') return { options: [
      { value: 'x', name: 'X' }, { value: 'u', name: 'U' },
    ] }
    return selected ? { options: [{ value: 'high', name: 'High' }] } : undefined
  })
  const made = catalog(undefined)
  t.after(() => made.dispose())
  const notices = []
  made.spec.onChange = () => notices.push(structuredClone(made.current()))
  const probing = made.refresh()
  await h.tick()
  h.starts[0].resolve()
  await h.tick()
  assert.equal(notices.length, 1)
  selected = true
  h.reads[0].resolve()
  await h.tick()
  assert.equal(notices.length, 1)
  h.reads[1].resolve()
  await probing
  assert.equal(notices.length, 2)
  selected = false
  const again = made.refresh()
  await h.tick()
  h.starts.at(-1).resolve()
  await h.tick()
  selected = true
  h.reads.at(-1).resolve()
  await h.tick()
  h.reads.at(-1).resolve()
  await again
  assert.equal(notices.length, 2, 'the kept efforts make the second list identical')
})

test('a refresh that fails during effort reads restores the last complete catalog', async t => {
  const h = await controlled(t)
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const made = catalog(home)
  t.after(() => made.dispose())
  const first = made.refresh()
  await h.tick()
  await h.finish()
  await first
  const complete = structuredClone(made.current())
  const disk = readFileSync(made.file, 'utf8')
  const { AgentRun } = await import('../src/host/acp.js')
  t.mock.method(AgentRun.prototype, 'option', category => category === 'model'
    ? { options: [{ value: 'someone', name: 'Someone' }] } : undefined)
  const refresh = made.refresh()
  assert.deepEqual(made.current(), complete)
  await h.tick()
  h.starts.at(-1).resolve()
  await h.tick()
  assert.ok(made.current().some(model => model.id === 'someone'))
  h.reads.at(-1).reject(new Error('efforts unavailable'))
  await refresh
  assert.deepEqual(made.current(), complete)
  assert.equal(readFileSync(made.file, 'utf8'), disk)
})

test('the models a Codex check measured with no tool block are kept beside the start model, for the release that measured them and a day (#1564 BF-1)', async (t) => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = join(home, 'acp-test.json')
  writeFileSync(file, `${JSON.stringify({ key: 'v1', at: 5, start: 'fake-large', models: [{ id: 'fake-large', name: 'Fake large' }] })}\n`)
  let now = 1_000_000
  const first = catalog(home, { now: () => now })
  assert.deepEqual(first.measuredKept(), [])
  first.recordMeasured(['gpt-6.2-sol', 'gpt-6.2-sol', 'bad slug', 42])
  assert.deepEqual(first.measuredKept(), ['gpt-6.2-sol'])
  const kept = JSON.parse(readFileSync(file, 'utf8'))
  // The catalog's own age, start model and models are left as they were.
  assert.equal(kept.at, 5)
  assert.equal(kept.start, 'fake-large')
  assert.deepEqual(kept.models, [{ id: 'fake-large', name: 'Fake large' }])
  assert.deepEqual(kept.measured, { key: 'v1', at: now, models: ['gpt-6.2-sol'] })
  // After a restart it is read from the file at once.
  const next = catalog(home, { now: () => now })
  assert.deepEqual(next.measuredKept(), ['gpt-6.2-sol'])
  assert.equal(next.ownModel(), 'fake-large')
  // Another release does not read it; neither does anyone a day later.
  assert.deepEqual(catalog(home, { key: () => 'v2', now: () => now }).measuredKept(), [])
  now += STALE_MS
  assert.deepEqual(next.measuredKept(), [])
  // A later measurement replaces it, an empty one included.
  next.recordMeasured(['gpt-5.6-luna'])
  assert.deepEqual(catalog(home, { now: () => now }).measuredKept(), ['gpt-5.6-luna'])
  next.recordMeasured([])
  assert.deepEqual(catalog(home, { now: () => now }).measuredKept(), [])
  // A measured entry of another shape is ignored; the catalog itself is still read.
  writeFileSync(file, `${JSON.stringify({ key: 'v1', at: 5, start: 'fake-large', models: [{ id: 'fake-large', name: 'Fake large' }], measured: { key: 'v1', at: now, models: 'gpt-6.2-sol' } })}\n`)
  const odd = catalog(home, { now: () => now })
  assert.deepEqual(odd.measuredKept(), [])
  assert.equal(odd.ownModel(), 'fake-large')
  // With no kept catalog yet it holds in memory, and the next probe's write keeps it with the models.
  const empty = scratch()
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  const fresh = catalog(empty, { now: () => now })
  fresh.recordMeasured(['gpt-6.2-sol'])
  assert.deepEqual(fresh.measuredKept(), ['gpt-6.2-sol'])
  assert.throws(() => readFileSync(join(empty, 'acp-test.json')), { code: 'ENOENT' })
  fresh.write('v1', [{ id: 'fake-large', name: 'Fake large', probed: true }], 'fake-large')
  const written = JSON.parse(readFileSync(join(empty, 'acp-test.json'), 'utf8'))
  assert.equal(written.at, now)
  assert.deepEqual(written.measured.models, ['gpt-6.2-sol'])
  assert.deepEqual(catalog(empty, { now: () => now }).measuredKept(), ['gpt-6.2-sol'])
})

test('the Details row reads the measured models whatever their age, never another release\'s (#1564 BG-3)', async (t) => {
  const home = scratch()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = join(home, 'acp-test.json')
  writeFileSync(file, `${JSON.stringify({ key: 'v1', at: 5, start: 'fake-large', models: [{ id: 'fake-large', name: 'Fake large' }] })}\n`)
  let now = 1_000_000
  const made = catalog(home, { now: () => now })
  made.recordMeasured(['gpt-6.2-sol'])
  now += STALE_MS + 60_000
  // A turn checks again after a day; the row stays locked.
  assert.deepEqual(made.measuredKept(), [])
  assert.deepEqual(made.measuredKept({ anyAge: true }), ['gpt-6.2-sol'])
  // After a restart too, read from the file.
  assert.deepEqual(catalog(home, { now: () => now }).measuredKept({ anyAge: true }), ['gpt-6.2-sol'])
  // Another release (a Codex or connector update) is read by neither.
  assert.deepEqual(catalog(home, { key: () => 'v2', now: () => now }).measuredKept({ anyAge: true }), [])
})
