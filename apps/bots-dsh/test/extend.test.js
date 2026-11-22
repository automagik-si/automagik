import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fromWindow } from '../src/host/desktop-window.js'
import { install, windowEndpoint } from '../src/host/extend.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const home = mkdtempSync(join(tmpdir(), 'omni-extend-'))
  // A saved team, so the state answer needs no Session services.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, mainBotIds: ['m1'], revision: 1, bots: { m1: { id: 'm1', name: 'Omni', role: 'Channel orchestrator', instructions: '', createdAt: 1 } }, rooms: {}, exchanges: [], exchangeTurns: {}, questions: {} }))
  const ctx = fakeContext()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload, headers) => (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', headers, body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt: ctx.provided.get('omniTeam'), home, call, stop }
}

test('apply provides the runtime as omniTeam, with the hooks other Omni plugins add through', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  assert.deepEqual(Object.keys(rt.hooks).sort(), ['around', 'botModels', 'endpoint', 'genui', 'live', 'mainRules', 'media', 'sessionOwner', 'view'])
  for (const name of ['load', 'save', 'botOf', 'isMain', 'selfOf', 'createBot', 'createTaskSession', 'startTask', 'deliver', 'resolveAgent', 'readOnly', 'home']) assert.ok(name in rt, name)
})

test('an added endpoint is served until its disposer runs, and the view and live answers carry added fields', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  const asked = []
  const off = rt.hooks.endpoint('hello', (body) => { asked.push(body); return { hi: body.name } })
  const offView = rt.hooks.view(() => ({ extra: 1 }))
  const offLive = rt.hooks.live(() => ({ pulse: 2 }))
  assert.deepEqual(await call('hello', { name: 'Ana' }), { ok: true, value: { hi: 'Ana' } })
  const state = (await call('state')).value
  assert.equal(state.extra, 1)
  assert.equal(state.pulse, 2)
  assert.throws(() => rt.hooks.endpoint('hello', () => null), /already served/)
  off()
  offView()
  offLive()
  assert.equal((await call('hello', {})).error.code, 'bot/not-found')
  const after = (await call('state')).value
  assert.equal('extra' in after, false)
  assert.equal('pulse' in after, false)
  assert.deepEqual(asked, [{ name: 'Ana' }])
})

// A fault inside an endpoint is a host fault: its message can name a path, a topic or a
// model's words, so neither the log nor the answer repeats it.
test('an added endpoint\'s fault logs the endpoint and kind, never its message', async (t) => {
  const { rt, home, call, stop } = start()
  const marker = 'qzsink-canary-7731'
  const off = rt.hooks.endpoint('sink-probe', () => {
    throw new TypeError(`boom ${marker} at /tmp/${marker}.md`)
  })
  const offFs = rt.hooks.endpoint('sink-probe-fs', () => {
    throw Object.assign(new Error(`EACCES: cannot open ${marker}`), { code: 'EACCES' })
  })
  const offRefused = rt.hooks.endpoint('sink-probe-refused', () => {
    throw Object.assign(new Error(`Refused: ${marker}`), { code: 'bot/invalid' })
  })
  t.after(async () => {
    off()
    offFs()
    offRefused()
    await stop()
  })
  assert.deepEqual(await call('sink-probe', {}), {
    ok: false,
    error: { code: 'bot/internal', message: 'Something went wrong (TypeError).', details: {} },
  })
  assert.deepEqual(await call('sink-probe-fs', {}), {
    ok: false,
    error: { code: 'bot/internal', message: 'Something went wrong (EACCES).', details: {} },
  })
  // A coded refusal is not a host fault: its message is the answer, as before.
  assert.deepEqual(await call('sink-probe-refused', {}), {
    ok: false, error: { code: 'bot/invalid', message: `Refused: ${marker}`, details: {} },
  })
  const log = join(home, 'logs', 'diagnostics.jsonl')
  const apiEntries = () => (existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(entry => entry.source === 'api')
    : [])
  for (let tries = 0; tries < 100 && apiEntries().length < 2; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const entries = apiEntries()
  assert.deepEqual(entries.map(entry => [entry.text, entry.code]), [
    ['sink-probe: TypeError', 'TypeError'],
    ['sink-probe-fs: EACCES', 'EACCES'],
  ])
  for (const entry of entries) {
    assert.ok(!JSON.stringify(entry).includes(marker), JSON.stringify(entry))
    // Frames only: the first line, the message, is not kept.
    assert.ok(entry.stack.split('\n').every(line => line.startsWith('at ')), entry.stack)
  }
  assert.ok(!readFileSync(log, 'utf8').includes(`Refused: ${marker}`))
  assert.equal(entries.length, 2)
})

test('an added endpoint says whether a host that only reads the team may answer it', () => {
  const rt = { warn() {} }
  install(rt)
  rt.hooks.endpoint('reads', () => 1, { read: true })
  rt.hooks.endpoint('writes', () => 2)
  assert.equal(rt.extended.endpointOf('reads').read, true)
  assert.equal(rt.extended.endpointOf('writes').read, false)
  assert.equal(rt.extended.endpointOf('toString'), undefined)
})

test('an endpoint wrapper runs in order and next serves once with the same signal and an optional body', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  const trace = []
  let signal
  let keptNext
  const wrap = async (body, requestSignal, next) => {
    signal = requestSignal
    trace.push(['before', body])
    keptNext = next
    const result = await next({ name: 'Bea' })
    assert.throws(() => next(), /once during its wrapper/)
    trace.push(['after', result])
    return result.toUpperCase()
  }
  const off = rt.hooks.around('wrapped', wrap)
  assert.throws(() => rt.hooks.around('wrapped', wrap), /endpoint wrapped is already wrapped/)
  assert.equal((await call('wrapped', {})).error.code, 'bot/not-found')
  rt.hooks.endpoint('wrapped', ({ name }, passedSignal, proof) => {
    if (trace.length === 1) assert.equal(passedSignal, signal)
    assert.equal(proof, false)
    trace.push(['endpoint', name])
    return name
  })
  assert.deepEqual(await call('wrapped', { name: 'Ana' }), { ok: true, value: 'BEA' })
  assert.deepEqual(trace, [['before', { name: 'Ana' }], ['endpoint', 'Bea'], ['after', 'Bea']])
  assert.throws(() => keptNext(), /once during its wrapper/)
  off()
  assert.deepEqual(await call('wrapped', { name: 'Ana' }), { ok: true, value: 'Ana' })
  const newOff = rt.hooks.around('wrapped', (_body, _signal, next) => next())
  off()
  assert.ok(rt.extended.aroundOf('wrapped'))
  assert.deepEqual(await call('wrapped', { name: 'Ana' }), { ok: true, value: 'Ana' })
  newOff()
  rt.hooks.around('wrapped', (_body, _signal, next) => { keptNext = next; return 'short circuit' })
  assert.deepEqual(await call('wrapped', {}), { ok: true, value: 'short circuit' })
  assert.throws(() => keptNext(), /once during its wrapper/)
})

test('a wrapper registered before its endpoint never handles an unknown name', async t => {
  const { rt, call, stop } = start()
  t.after(stop)
  let wraps = 0
  rt.hooks.around('later', (_body, _signal, next) => { wraps += 1; return next() })
  assert.equal((await call('later', { name: 'Ana' })).error.code, 'bot/not-found')
  assert.equal(wraps, 0)
  rt.hooks.endpoint('later', body => body.name)
  assert.deepEqual(await call('later', { name: 'Ana' }), { ok: true, value: 'Ana' })
  assert.equal(wraps, 1)
})

test('wrappers keep the read-only gate and leave real window endpoints their proof', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  rt.readOnly = () => 'This team is read-only.'
  rt.hooks.endpoint('writes', () => assert.fail('write endpoint ran'))
  rt.hooks.around('writes', () => assert.fail('write wrapper ran'))
  rt.hooks.endpoint('reads', () => 2, { read: true })
  rt.hooks.around('reads', async (_body, _signal, next) => 1 + await next())
  assert.equal((await call('writes', {})).error.code, 'bot/read-only')
  assert.deepEqual(await call('reads', {}), { ok: true, value: 3 })

  const secret = 'ab'.repeat(32)
  const { AUTOMAGIK_WINDOW_DIGEST: digest, AUTOMAGIK_APP_BROWSER: browser } = process.env
  const send = process.send
  t.after(() => {
    if (digest === undefined) delete process.env.AUTOMAGIK_WINDOW_DIGEST
    else process.env.AUTOMAGIK_WINDOW_DIGEST = digest
    if (browser === undefined) delete process.env.AUTOMAGIK_APP_BROWSER
    else process.env.AUTOMAGIK_APP_BROWSER = browser
    if (send === undefined) delete process.send
    else process.send = send
  })
  process.send = () => true
  process.env.AUTOMAGIK_APP_BROWSER = '1'
  process.env.AUTOMAGIK_WINDOW_DIGEST = createHash('sha256').update(secret).digest('hex')
  windowEndpoint(rt, 'window', (_body, _signal, proof) => fromWindow(proof), { read: true })
  rt.hooks.around('window', () => assert.fail('window wrapper ran'))
  assert.deepEqual(await call('window', {}, { 'x-automagik-window': secret }), { ok: true, value: true })
  assert.deepEqual(await call('window', {}), { ok: true, value: false })
})

test('Main Bot rules come in their order, and a hook with nothing to add is left out', () => {
  const rt = {}
  install(rt)
  const offLate = rt.hooks.mainRules(() => 'late', { order: 200 })
  rt.hooks.mainRules(self => `early for ${self}`, { order: 100 })
  rt.hooks.mainRules(() => null, { order: 150 })
  assert.deepEqual(rt.extended.rules('m1'), ['early for m1', 'late'])
  offLate()
  assert.deepEqual(rt.extended.rules('m1'), ['early for m1'])
  // A failing view hook leaves its own fields out, not the answer.
  const warned = []
  const viewed = { warn: (...args) => warned.push(args) }
  install(viewed)
  viewed.hooks.view(() => { throw new Error('boom') })
  viewed.hooks.view(() => ({ ok: true }))
  assert.deepEqual(viewed.extended.view(), { ok: true })
  assert.equal(warned.length, 1)
})

test('a team linked to an Omni without the channels plugin learns that channels moved', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  assert.equal((await call('state')).value.channelsMoved, false)
  writeFileSync(join(rt.home, 'omni.json'), '{}')
  assert.equal((await call('state')).value.channelsMoved, true)
})

test('a Main Bot rule that throws is left out, and the other rules still come', () => {
  const warned = []
  const rt = { warn: (...args) => warned.push(args) }
  install(rt)
  rt.hooks.mainRules(() => 'first', { order: 1 })
  rt.hooks.mainRules(() => { throw new Error('broken plugin') }, { order: 2 })
  rt.hooks.mainRules(() => 'third', { order: 3 })
  assert.deepEqual(rt.extended.rules({}), ['first', 'third'])
  assert.equal(warned.length, 1)
})

test('#1092 sendsOutside hooks register, ask on failure and dispose', () => {
  const rt = {}; install(rt)
  const step = { tool: 'team_send', args: { recipient: 'outside' } }
  assert.equal(rt.sendsOutside(step), false)
  let classified
  const dispose = rt.stepHooks.sendsOutside(input => {
    classified = input
    return true
  })
  assert.equal(rt.sendsOutside(step, 's1'), true)
  assert.deepEqual(classified, { ...step, sessionId: 's1' })
  assert.equal(rt.sendsOutside(step), true)
  assert.deepEqual(classified, { ...step, sessionId: undefined })
  dispose(); dispose()
  assert.equal(rt.sendsOutside(step), false)
  const throwing = rt.stepHooks.sendsOutside(() => { throw new Error('unknown recipient') })
  assert.equal(rt.sendsOutside(step), true)
  throwing()
  assert.equal(rt.sendsOutside(step), false)
  rt.stepHooks.sendsOutside(() => false)
  assert.equal(rt.sendsOutside(step), false)
})
