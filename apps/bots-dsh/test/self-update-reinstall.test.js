import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { savedResult, selfUpdateCheck } from '../src/host/self-update-check.js'
import { createUpdateHold, GONE_WAIT_MS } from '../src/host/self-update-hold.js'
import { selfUpdateStatus, writeJsonAtomic } from '../src/host/self-update.js'
import { requestOf, takeRequest } from '../src/host/supervisor/request.js'
import { identity, readJson } from '../src/host/supervisor/store.js'
import { requestOf as oldRequestOf, takeRequest as oldTakeRequest } from './fixtures/supervisor-5b/supervisor/request.js'
import { BOTS, fixture, FROM, lane, read, REGISTRY, TO, WELCOME, write } from './fixtures/supervisor.mjs'
import { fakeContext } from './fake-ctx.js'

const bootId = 'fixture-reinstall-boot'
const env = {
  AUTOMAGIK_SUPERVISOR_BOOT: bootId,
  AUTOMAGIK_SUPERVISOR_VERSION: FROM,
  AUTOMAGIK_SUPERVISOR_ROLLBACK: bootId,
  AUTOMAGIK_SUPERVISOR_REINSTALL: bootId,
}
const forced = { force: true, runId: 'confirmed-check-id', reinstall: true }
const plugin = { name: BOTS, from: FROM, to: FROM, sha256: 'b'.repeat(64) }
const record = () => ({
  version: 2, runId: forced.runId, checkedAt: new Date().toISOString(), state: 'available', reason: null,
  laneVersion: FROM, sequence: 42, plugins: [plugin], supervisor: true, reinstall: true,
})

function signEqual(f) {
  return lane(f, pointer => {
    pointer.version = FROM
    pointer.plugins = pointer.plugins.toReversed().map(plugin => ({ ...plugin, version: FROM }))
  })
}

function checkOptions(f, signed = signEqual(f), settings = {}) {
  return {
    profileDir: f.profileDir, inDesktop: false, env, ...signed, getDshVersion: () => '0.2.2-rc.2',
    fetch: async url => {
      if (url === REGISTRY + '-/ping') return new Response('{}')
      assert.ok(f.tarballs.has(url), url)
      return new Response(f.tarballs.get(url))
    },
    registry: () => REGISTRY,
    ...settings,
  }
}

test('the host only checks the exact installed version with boot-bound capability and saves a version-2 identity', async t => {
  const f = fixture(t, { plugins: [BOTS, WELCOME] })
  const options = checkOptions(f)
  assert.equal((await selfUpdateCheck(options)).state, 'current')
  for (const cap of [undefined, '', 'old-supervisor-boot']) {
    const inherited = { ...env, AUTOMAGIK_SUPERVISOR_REINSTALL: cap }
    assert.equal(selfUpdateStatus({ profileDir: f.profileDir, env: inherited, inDesktop: false }).reinstall, undefined)
    assert.equal((await selfUpdateCheck({ ...options, env: inherited, reinstall: true })).state, 'current')
  }
  const result = await selfUpdateCheck({ ...options, reinstall: true })
  assert.equal(selfUpdateStatus({ profileDir: f.profileDir, env, inDesktop: false }).reinstall, true)
  assert.deepEqual(result, { ...record(), runId: result.runId, checkedAt: result.checkedAt,
    plugins: f.release.map(({ name, sha256 }) => ({ name, from: FROM, to: FROM, sha256 })),
  })
  assert.deepEqual(savedResult(f.profileDir), result)
  write(join(f.store, 'check.json'), { ...record(), version: 1, reinstall: undefined })
  assert.equal(savedResult(f.profileDir).reinstall === true, false)
})

for (const [name, installed, seq, expected, reason] of [
  ['lower sequence', [FROM, FROM], 41, 'refused', 'sequence-lower'],
  ['one lower with one equal', [FROM, TO], 42, 'refused', 'not-newer'],
  ['one lower with one newer', ['3.160.1', TO], 42, 'refused', 'not-newer'],
  ['equal and newer', [FROM, '3.160.1'], 42, 'available', null],
  ['build metadata differs', [FROM + '+other', FROM], 42, 'current', 'not-newer'],
  ['empty', [], 42, 'current', 'not-newer'],
]) test('checking a reinstall handles ' + name, async t => {
  const names = [BOTS, WELCOME].slice(0, installed.length)
  const f = fixture(t, { plugins: names })
  for (const [i, name] of names.entries()) {
    write(join(f.profileDir, 'node_modules', name, 'package.json'), { name, version: installed[i] })
  }
  write(join(f.store, 'current.json'), { version: 1, live: { version: FROM, sequence: 42 }, kept: null, lastSequence: 42 })
  const signed = lane(f, pointer => {
    pointer.version = FROM
    pointer.sequence = seq
    pointer.plugins = pointer.plugins.map(plugin => ({ ...plugin, version: FROM }))
  })
  const result = await selfUpdateCheck(checkOptions(f, signed, { reinstall: true }))
  assert.equal(result.state, expected)
  assert.equal(result.reason, reason)
  assert.equal(result.version, 1)
  assert.notEqual(result.reinstall, true)
})

test('mode contention has no handle and leaves the active check shareable in its own mode', async t => {
  for (const reinstall of [true, false]) await t.test(reinstall ? 'reinstall active' : 'ordinary active', async t => {
    const f = fixture(t)
    const signed = reinstall ? signEqual(f) : lane(f)
    const waiting = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const options = checkOptions(f, signed, {
      reinstall,
      async fetch(url) {
        if (url === REGISTRY + '-/ping') return new Response('{}')
        entered.resolve()
        await waiting.promise
        return new Response(f.tarballs.get(url))
      },
    })
    const first = selfUpdateCheck(options)
    await entered.promise
    try {
      assert.deepEqual(await selfUpdateCheck({ ...options, reinstall: !reinstall }), { state: 'checking' })
      assert.equal((await selfUpdateCheck({ ...options, keys: [...options.keys] })).reason, 'signature-invalid')
      assert.equal(selfUpdateCheck(options), first)
    } finally { waiting.resolve() }
    assert.equal((await first).state, 'available')
  })
})

function runtime(t, { reinstall = bootId } = {}) {
  const f = fixture(t)
  for (const [key, value] of Object.entries({ ...env, AUTOMAGIK_SUPERVISOR_REINSTALL: reinstall, AUTOMAGIK_BOTS_HOME: f.botsHome })) {
    const prev = process.env[key]
    process.env[key] = value
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev })
  }
  fs.rmSync(join(f.botsHome, 'state.json'))
  const agents = []
  const ctx = fakeContext({ services: { profileContext: { dir: f.profileDir }, agents: { list: () => agents } } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = value => { route = value; return register(value) }
  const rt = createRuntime(ctx, { home: f.botsHome, selfUpdate: true })
  t.after(async () => { rt.dispose(); await ctx.dispose() })
  rt.resumeBootPending = () => false
  rt.noteUpdateInboxes = () => true
  rt.markUpdateStop = async () => true
  rt.flushUpdateNotes = async publish => publish()
  rt.updateHealable = () => true
  const cancel = t.mock.fn(() => rt.updateTurnEnded('running'))
  agents.push({ id: 'running', status: 'running', cancel })
  const post = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    const reply = await response.json()
    assert.equal(reply.ok, true, JSON.stringify(reply))
    return reply.value
  }
  const save = (value) => writeJsonAtomic(join(f.store, 'check.json'), value, { profileDir: f.profileDir })
  const requestPath = join(f.store, 'request.json')
  return { ...f, rt, cancel, post, save, requestPath }
}

test('owner status distinguishes plain and forced eligibility; only the bound Force request has five keys', async t => {
  const { rt, cancel, post, save, requestPath, store } = runtime(t)
  save(record())
  const status = await post('self-update-status')
  assert.equal(status.reinstall, true)
  assert.equal(status.startRefusal, 'reinstall-needs-force')
  assert.equal(status.forceRefusal, null)
  assert.deepEqual(await post('self-update-start'), { started: false, reason: 'reinstall-needs-force' })
  assert.deepEqual(await post('self-update-start', { force: true }), { started: false, reason: 'page-outdated' })
  assert.deepEqual(await post('self-update-start', { ...forced, reinstall: false }), { started: false, reason: 'check-stale' })
  assert.deepEqual(await post('self-update-start', { ...forced, runId: 'different-check' }), { started: false, reason: 'check-stale' })
  assert.equal(rt.updateHold.closed, false)
  assert.equal(fs.existsSync(requestPath), false)
  assert.equal(cancel.mock.callCount(), 0)
  const answer = await post('self-update-start', forced)
  assert.equal(answer.started, true)
  assert.equal(cancel.mock.callCount(), 1)
  const request = read(requestPath)
  assert.deepEqual(requestOf(request, bootId), request)
  assert.deepEqual(request.reinstall, { version: FROM, sequence: 42, plugins: [{ name: BOTS, sha256: plugin.sha256 }] })
  assert.deepEqual(Object.keys(request).sort(), ['bootId', 'reinstall', 'requestId', 'requestedAt', 'version'])

  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  const runId = 'refused-reinstall-run'
  write(join(store, 'supervisor.json'), { version: 1, bootId, runId })
  write(join(store, 'reinstall-refusal.json'), { version: 1, runId, detail: 'reinstall-unsupported' })
  const now = new Date().toISOString()
  write(join(store, 'state.json'), {
    version: 1, runId, bootId, phase: 'notUpdated', reason: 'stage-failed', from: null, to: null,
    startedAt: now, updatedAt: now, requestId: request.requestId,
  })
  rt.updateHold.tick()
  assert.equal(rt.updateHold.closed, false)
  assert.equal(resume.mock.callCount(), 1)
  assert.equal((await post('self-update-status')).run.detail, 'reinstall-unsupported')
})

test('a capability inherited from another boot refuses a saved reinstall before holding work', async t => {
  const { rt, post, save, requestPath, cancel } = runtime(t, { reinstall: 'other-supervisor-boot' })
  save(record())
  const status = await post('self-update-status')
  assert.equal(status.reinstall, undefined)
  assert.equal(status.forceRefusal, 'reinstall-unsupported')
  assert.deepEqual(await post('self-update-start', forced), { started: false, reason: 'reinstall-unsupported' })
  assert.equal(rt.updateHold.closed, false)
  assert.equal(cancel.mock.callCount(), 0)
  assert.equal(fs.existsSync(requestPath), false)
})

test('the owner route rejects malformed version-2 records before closing admission', async t => {
  const { rt, post, save, requestPath, cancel } = runtime(t)
  const close = t.mock.method(rt.updateHold, 'close')
  for (const fields of [
    { reinstall: false }, { laneVersion: null }, { laneVersion: 'invalid' }, { sequence: null }, { sequence: -1 },
    { state: 'current' }, { plugins: [] }, { plugins: [plugin, plugin] }, { plugins: [{ ...plugin, name: '@automagik/unselected' }] },
    { plugins: [{ ...plugin, from: TO }] }, { plugins: [{ ...plugin, to: FROM + '+other' }] },
    { plugins: [{ ...plugin, sha256: 'x'.repeat(64) }] }, { plugins: [{ ...plugin, sha256: undefined }] },
    { plugins: [{ ...plugin, name: WELCOME }, plugin] }, { version: 1 },
  ]) {
    save({ ...record(), ...fields })
    assert.deepEqual(await post('self-update-start', forced), { started: false, reason: 'check-stale' }, JSON.stringify(fields))
  }
  assert.equal(close.mock.callCount(), 0)
  assert.equal(cancel.mock.callCount(), 0)
  assert.equal(fs.existsSync(requestPath), false)
})

test('request publication rechecks the saved run and intent and gives cut work back on drift', async t => {
  const { rt, cancel, post, save, requestPath } = runtime(t)
  save(record())
  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  rt.flushUpdateNotes = async publish => {
    save({ ...record(), runId: 'replacement-check-id' })
    return publish()
  }
  assert.deepEqual(await post('self-update-start', forced), { started: false, reason: 'check-stale' })
  assert.equal(cancel.mock.callCount(), 1)
  assert.equal(resume.mock.callCount(), 1)
  assert.equal(rt.updateHold.closed, false)
  assert.equal(fs.existsSync(requestPath), false)
})

test('a forced newer release uses the ordinary request and the owner route only opts in on literal true', async t => {
  const { rt, post, save, requestPath } = runtime(t)
  const check = t.mock.method(rt, 'selfUpdateCheck', async () => ({ state: 'current' }))
  for (const reinstall of [true, 'true', false]) await post('self-update-check', { reinstall })
  assert.deepEqual(check.mock.calls.map(call => call.arguments), [[true], [], []])
  save({ ...record(), version: 1, reinstall: undefined, plugins: [], laneVersion: TO })
  const answer = await post('self-update-start', { ...forced, reinstall: false })
  assert.equal(answer.started, true)
  const request = read(requestPath)
  assert.deepEqual(oldRequestOf(request, bootId), request)
  assert.deepEqual(Object.keys(request).sort(), ['bootId', 'requestId', 'requestedAt', 'version'])
})

test('a frozen request reader or a new boot unlinks a reinstall request and the hold gives work back', t => {
  const f = fixture(t)
  const request = {
    version: 1, requestId: 'request-001', bootId, requestedAt: new Date().toISOString(),
    reinstall: { version: FROM, sequence: 42, plugins: [{ name: BOTS, sha256: plugin.sha256 }] },
  }
  const path = join(f.store, 'request.json')
  for (const [take, supervisorBoot] of [[oldTakeRequest, bootId], [takeRequest, 'restarted-supervisor']]) {
    write(path, request)
    let now = 0
    const resumes = []
    const hold = createUpdateHold({
      readStatus: () => ({ supervised: true, profileKnown: true, readable: true, run: null }),
      requestPresent: () => !!identity(path), onResume: reason => { resumes.push(reason) },
      now: () => now, schedule: () => ({ unref() {} }),
    })
    hold.close(request.requestId)
    hold.wrote()
    assert.equal(take(f.store, file => readJson(() => f.store, f.store, file), supervisorBoot, false, new Set()), null)
    assert.equal(fs.existsSync(path), false)
    hold.tick()
    now += GONE_WAIT_MS + 1
    hold.tick()
    assert.equal(hold.closed, false)
    assert.deepEqual(resumes, ['request-unanswered'])
  }
})
