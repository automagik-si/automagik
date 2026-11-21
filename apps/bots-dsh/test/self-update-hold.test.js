import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntime } from '../index.js'
import { AGENT_TOOLS } from '../src/host/agent-access.js'
import { UPDATE_CUT } from '../src/host/constants.js'
import { install as installResume, RESUME_DELAY_MS } from '../src/host/resume.js'
import { createUpdateHold, GONE_WAIT_MS, install, PROFILE_WAIT_MS, STALL_MS, STOP_WAIT_MS, UNANSWERED_MS } from '../src/host/self-update-hold.js'
import { storeDirOf, writeJsonAtomic } from '../src/host/self-update.js'
import { requestOf } from '../src/host/supervisor/request.js'
import { fakeContext } from './fake-ctx.js'

const bootId = 'd5b-fixture-boot'
const verdict = (phase, requestId = 'new-request') => ({ runId: 'live-run', phase, requestId, updatedAt: new Date(0).toISOString() })
const tickPromises = () => new Promise(resolve => setImmediate(resolve))
const clockHold = ({ run, ...options } = {}) => {
  let now = 0
  let status = run
  let stored
  const warnings = []
  const resumes = []
  const hold = createUpdateHold({
    now: () => now,
    schedule: () => ({ unref() {} }),
    readStatus: () => {
      if (status instanceof Error) throw status
      return { supervised: true, profileKnown: true, run: status }
    },
    requestPresent: id => stored === id,
    onResume: reason => { resumes.push(reason) },
    warn: (...args) => warnings.push(args),
    ...options,
  })
  return {
    hold, warnings, resumes,
    status(value, pollNow = true) { status = value; if (pollNow) hold.tick() },
    store(value) { stored = value; hold.tick() },
    advance(ms) { now += ms; hold.tick() },
  }
}

test('an unpublished click never expires and a missing or replaced request gets a grace period after publication', () => {
  const c = clockHold({ run: verdict('notUpdated', 'previous-request') })
  assert.equal(c.hold.closed, false)
  c.hold.close('new-request')
  c.advance(UNANSWERED_MS + 1)
  assert.equal(c.hold.owns('new-request'), true)
  c.hold.wrote()
  c.store('new-request')
  c.advance(STOP_WAIT_MS)
  c.store('replacement-request')
  c.advance(GONE_WAIT_MS)
  assert.equal(c.hold.closed, true)
  c.advance(1)
  assert.deepEqual(c.resumes, ['request-unanswered'])
  assert.equal(c.hold.closed, false)
})

test('a file still present gets the supervisor TTL and its polling allowance', () => {
  const c = clockHold()
  c.hold.close('new-request')
  c.hold.wrote()
  c.store('new-request')
  c.advance(UNANSWERED_MS)
  assert.equal(c.hold.closed, true)
  c.advance(1)
  assert.deepEqual(c.resumes, ['request-unanswered'])
})

test('an unreadable status resets the published request absence timer and cannot expire it', () => {
  const c = clockHold()
  c.hold.close('new-request')
  c.hold.wrote()
  c.store('new-request')
  c.status(new Error('state.json unreadable'))
  c.store(undefined)
  c.advance(UNANSWERED_MS + 1)
  assert.equal(c.hold.closed, true)
  assert.deepEqual(c.resumes, [])

  c.status(verdict('healthy', 'previous-request'))
  c.advance(GONE_WAIT_MS - 1)
  c.status(new Error('state.json unreadable again'))
  c.advance(GONE_WAIT_MS + 1)
  assert.equal(c.hold.closed, true)
  c.status(null)
  c.advance(GONE_WAIT_MS)
  assert.equal(c.hold.closed, true)
  c.status(verdict('staging'))
  c.advance(GONE_WAIT_MS + 1)
  assert.equal(c.hold.closed, true)
  c.status(verdict('notUpdated'))
  assert.deepEqual(c.resumes, ['notUpdated'])
})

for (const [phase, end] of [['staging', 'notUpdated'], ['restarting', 'healthy'], ['health', 'rolledBack']]) {
  test(`a fresh child waits during ${phase} and reserves recovery before admitting input on ${end}`, async () => {
    const plan = Promise.withResolvers()
    const c = clockHold({ run: verdict(phase), bootPlan: () => plan.promise })
    const gate = c.hold.gate()
    const step = c.hold.wait()
    c.status(verdict(end))
    await gate
    assert.equal(c.hold.closed, true)
    plan.resolve()
    await step
    assert.equal(c.hold.closed, false)
    assert.deepEqual(c.resumes, [])
  })
}

test('a stalled or unreadable run keeps admission closed until its own verdict', async () => {
  const c = clockHold({ run: verdict('healthy', 'previous-request') })
  c.hold.close('new-request')
  c.hold.wrote()
  c.advance(GONE_WAIT_MS)
  assert.deepEqual(c.resumes, [])
  c.status(verdict('staging'))
  c.advance(STALL_MS + 1)
  c.advance(STALL_MS)
  assert.equal(c.warnings.length, 1)
  assert.equal(c.hold.closed, true)
  c.status(new Error('unreadable'))
  c.advance(UNANSWERED_MS)
  c.status(null)
  c.advance(UNANSWERED_MS)
  c.status(verdict('restarting'))
  assert.equal(c.hold.closed, true)
  assert.deepEqual(c.resumes, [])
  c.status(verdict('notUpdated'))
  c.status(verdict('notUpdated'))
  assert.deepEqual(c.resumes, ['notUpdated'])
})

test('a trial that observed health ignores a gap and keeps its gate pending in manual recovery', async () => {
  const c = clockHold({ run: verdict('health') })
  const controller = new AbortController()
  const gate = c.hold.gate(controller.signal)
  const step = c.hold.wait(controller.signal)
  c.status(null)
  assert.equal(c.hold.closed, true)
  c.status(verdict('manualRecovery'))
  assert.equal(c.hold.closed, true)
  const reason = new Error('disposed')
  controller.abort(reason)
  await assert.rejects(gate, error => error === reason)
  await assert.rejects(step, error => error === reason)
  // A new supervisor boot will not return the old boot's live run.
  assert.equal(clockHold().hold.closed, false)
})

test('a supervised first unreadable status stays closed until readable or the boot ceiling', async () => {
  const statuses = [
    { supervised: true, profileKnown: false, run: null },
    { supervised: true, profileKnown: true, readable: false, run: null },
  ]
  for (const initial of statuses) {
    let status = initial
    const c = clockHold({ readStatus: () => status })
    assert.equal(c.hold.closed, true)
    c.advance(PROFILE_WAIT_MS - 1)
    assert.equal(c.hold.closed, true)
    assert.equal(c.warnings.length, 0)
    c.advance(1)
    assert.equal(c.hold.closed, false)
    assert.equal(c.warnings.length, 1)

    const trial = clockHold({ readStatus: () => status })
    assert.equal(trial.hold.closed, true)
    status = { supervised: true, profileKnown: true, readable: true, run: verdict('manualRecovery') }
    trial.advance(PROFILE_WAIT_MS - 1)
    assert.equal(trial.hold.state, 'manual')
    trial.advance(PROFILE_WAIT_MS)
    assert.equal(trial.hold.closed, true)
    status = { ...status, run: verdict('rolledBack') }
    trial.advance(1)
    await trial.hold.wait()
    assert.equal(trial.hold.closed, false)
  }
})

test('the old unreferenced poll releases surviving waiters after disposal without resuming', async () => {
  let poll
  let unrefs = 0
  const c = clockHold({ run: verdict('health'), schedule(callback) { poll = callback; return { unref() { unrefs++ } } } })
  c.hold.close('new-request')
  c.hold.wrote()
  const waiting = c.hold.wait()
  c.hold.dispose()
  assert.equal(unrefs, 1)
  c.status(verdict('notUpdated'), false)
  poll()
  await waiting
  assert.equal(unrefs, 1)
  assert.deepEqual(c.resumes, [])
})

function profile(t) {
  const root = mkdtempSync(join(tmpdir(), 'bots-update-click-'))
  // node:test runs after hooks in the order they were registered, so a runtime's own stop hook,
  // registered after this one, would run once the folder is gone, while its notes writer can
  // still be writing into the team folder (ENOTEMPTY, or a note failing on a missing folder).
  // Every runtime built on this profile stops here first, newest first, and only then the folder goes.
  const stops = []
  t.after(async () => {
    for (const stop of stops.reverse()) await stop()
    rmSync(root, { recursive: true, force: true })
  })
  const profileDir = join(root, 'profiles', 'web')
  const home = join(root, 'team')
  mkdirSync(profileDir, { recursive: true })
  const env = { AUTOMAGIK_BOTS_HOME: home, AUTOMAGIK_SUPERVISOR_BOOT: bootId, AUTOMAGIK_SUPERVISOR_VERSION: 'v1.2.3' }
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key]
    process.env[key] = value
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  const store = storeDirOf(profileDir)
  const saved = checkedAt => writeJsonAtomic(join(store, 'check.json'), {
    version: 1, runId: 'check-run', checkedAt: new Date(checkedAt).toISOString(), state: 'available', reason: null,
    laneVersion: '1.2.4', sequence: 5, supervisor: true, plugins: [],
  }, { profileDir })
  saved(Date.now())
  return { home, profileDir, request: join(store, 'request.json'), saved, onStop: stop => stops.push(stop) }
}

async function clickBench(t) {
  const timer = setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    timer(callback, ms === RESUME_DELAY_MS ? 0 : ms, ...args))
  const files = profile(t)
  const agents = []
  const ctx = fakeContext({ services: { profileContext: { dir: files.profileDir }, agents: { list: () => agents } } })
  const status = { available: true, run: null }
  let owned = true
  const rt = {
    ctx, config: { selfUpdate: true }, home: files.home, statePath: join(files.home, 'state.json'), lockTerm: () => 1,
    state: { tasks: { running: {} } }, load: async () => {}, holdsLock: () => owned,
    chatOwners: new Map(), groupOwners: new Map(), readOnly: () => undefined, selfUpdateStatus: () => status, warn() {},
  }
  installResume(rt)
  const stop = install(rt)
  files.onStop(async () => { stop(); await ctx.dispose() })
  // The boot's pass reads and notes on disk: wait for it, bounded only so a pass that never ends
  // fails on the assertion below instead of the file's timeout. The bound keeps the event loop
  // alive (the pass's own delay timer is unreferenced) and is cleared once the pass is done.
  let bound
  await Promise.race([rt.resumesDone, new Promise(resolve => { bound = timer(resolve, 5_000) })])
  clearTimeout(bound)
  assert.equal(rt.resumeBootPending(), false)
  return { files, agents, rt, status, loseTeam() { owned = false } }
}

test('a synchronous turn end cannot be missed while the stop notes are being written, and 5a accepts the request', async t => {
  const { files, agents, rt } = await clickBench(t)
  const written = Promise.withResolvers()
  const mark = rt.markUpdateStop
  rt.markUpdateStop = async ids => {
    assert.deepEqual(ids, ['running'])
    await written.promise
    return mark(ids)
  }
  agents.push({
    id: 'running', status: 'running', session: { id: 'running' },
    cancel(cause, opts) {
      assert.deepEqual(cause, { kind: 'hook', reason: UPDATE_CUT })
      assert.deepEqual(opts, { keepInbox: true })
      assert.equal(rt.updateHold.closed, true)
      assert.equal(existsSync(files.request), false)
      rt.updateTurnEnded('running')
    },
  })
  const result = rt.selfUpdateStart()
  await tickPromises()
  assert.equal(existsSync(files.request), false)
  written.resolve()
  const started = await result
  assert.deepEqual(started, { started: true, requestId: started.requestId, stopped: 1, stillRunning: 0 })
  const request = JSON.parse(readFileSync(files.request))
  assert.deepEqual(requestOf(request, bootId), request)
  assert.equal(request.requestId, started.requestId)
})

test('the stop wait is unreferenced and publishes at ten seconds for a turn that has not ended', async t => {
  const { files, agents, rt } = await clickBench(t)
  agents.push({ id: 'running', status: 'running', cancel() {} })
  const timer = setTimeout
  const refs = []
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    if (ms !== STOP_WAIT_MS) return timer(callback, ms)
    return { unref() { refs.push(callback) } }
  })
  const clear = clearTimeout
  t.mock.method(globalThis, 'clearTimeout', handle => { if (handle?.constructor !== Object) clear(handle) })
  const result = rt.selfUpdateStart()
  assert.equal(refs.length, 1)
  assert.equal(existsSync(files.request), false)
  refs[0]()
  assert.equal((await result).stillRunning, 1)
})

test('stop notes that cannot be written give work back without publishing', async t => {
  const { files, rt } = await clickBench(t)
  mkdirSync(join(files.home, 'inflight.json'), { recursive: true })
  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'notes-unwritable' })
  assert.equal(existsSync(files.request), false)
  assert.equal(resume.mock.callCount(), 1)
})

test('losing team ownership during the last note write fences publication and give-back', async t => {
  const { files, rt, loseTeam } = await clickBench(t)
  const flush = rt.flushUpdateNotes
  t.mock.method(rt, 'flushUpdateNotes', publish => flush(() => { loseTeam(); return publish() }))
  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'bot/read-only' })
  assert.equal(existsSync(files.request), false)
  assert.equal(resume.mock.callCount(), 0)
})

test('publication waits for newer input noted during the last write', async t => {
  const { files, rt } = await clickBench(t)
  const message = createUserMessage({ content: [{ type: 'text', text: 'another input' }], source: { kind: 'user' } })
  const flush = rt.flushUpdateNotes
  t.mock.method(rt, 'flushUpdateNotes', publish => {
    const pending = flush(() => {
      const notes = JSON.parse(readFileSync(join(files.home, 'inflight.json')))
      assert.equal(notes.held.chat[0].message.id, message.id)
      return publish()
    })
    queueMicrotask(() => { void rt.noteHeldInput('chat', [message]) })
    return pending
  })
  assert.equal((await rt.selfUpdateStart()).started, true)
})

test('a directory sync failure after the supervisor takes the request still follows its ID', async t => {
  const { files, rt, status } = await clickBench(t)
  const sync = fs.fsyncSync
  let taken
  t.mock.method(fs, 'fsyncSync', fd => {
    if (existsSync(files.request) && fs.fstatSync(fd).isDirectory()) {
      taken = requestOf(JSON.parse(readFileSync(files.request)), bootId)
      fs.unlinkSync(files.request)
      throw new Error('directory sync failed')
    }
    return sync(fd)
  })
  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  const started = await rt.selfUpdateStart()
  assert.equal(started.started, true)
  assert.equal(taken.requestId, started.requestId)
  assert.equal(existsSync(files.request), false)
  assert.equal(rt.updateHold.closed, true)
  status.run = verdict('staging', taken.requestId)
  rt.updateHold.tick()
  assert.equal(resume.mock.callCount(), 0)
  status.run = verdict('notUpdated', taken.requestId)
  rt.updateHold.tick()
  assert.equal(resume.mock.callCount(), 1)
})

test('a failure before rename gives work back instead of treating a replacement as published', async t => {
  const { files, rt } = await clickBench(t)
  writeJsonAtomic(files.request, { requestId: 'someone-else' }, { profileDir: files.profileDir })
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === files.request) throw new Error('rename failed')
    return rename(from, to)
  })
  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'no-store' })
  assert.equal(JSON.parse(readFileSync(files.request)).requestId, 'someone-else')
  assert.equal(resume.mock.callCount(), 1)
})

test('a replacement request on disk starts the grace period for the accepted click', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const { files, rt } = await clickBench(t)
  // The on-disk request belongs to the accepted click at first.
  const started = await rt.selfUpdateStart()
  assert.equal(started.started, true)
  const resume = t.mock.method(rt, 'resumeUpdateStopped', () => {})
  rt.updateHold.tick()
  writeJsonAtomic(files.request, { requestId: 'replacement' }, { profileDir: files.profileDir })
  rt.updateHold.tick()
  now += GONE_WAIT_MS + 1
  rt.updateHold.tick()
  assert.equal(rt.updateHold.closed, false)
  assert.equal(resume.mock.callCount(), 1)
})

test('the status and start share static refusals and leave the setting off by default', async t => {
  const { files, rt, status } = await clickBench(t)
  delete rt.config.selfUpdate
  assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'self-update-off' })
  rt.config.selfUpdate = true
  for (const reason of ['desktop-app', 'no-supervisor', 'no-store', 'store-invalid', 'listener-unknown']) {
    Object.assign(status, { available: false, reason })
    assert.equal(rt.selfUpdateStartRefusal(), reason)
    assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason })
  }
  status.available = true
  for (const checkedAt of [Date.now() - 601_000, Date.now() + 60_000]) {
    files.saved(checkedAt)
    assert.equal(rt.selfUpdateStartRefusal(), 'check-stale')
    assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'check-stale' })
  }
  files.saved(Date.now())
  rt.statePath = join(files.home, 'somewhere-else.json')
  assert.equal(rt.selfUpdateStartRefusal(), 'team-home-custom')
  assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'team-home-custom' })
  rt.statePath = join(files.home, 'state.json')
  assert.equal(rt.selfUpdateStartRefusal(), null)
  rt.updateHold.close('pending')
  assert.equal(rt.selfUpdateStartRefusal(), 'update-running')
  assert.deepEqual(await rt.selfUpdateStart(), { started: false, reason: 'update-running' })
})

test('the start route requires the team lock and is absent from the read and tool lists', async t => {
  const { home, profileDir, onStop } = profile(t)
  const ctx = fakeContext({ services: { profileContext: { dir: profileDir } } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = value => { route = value; return register(value) }
  const rt = createRuntime(ctx, { home, selfUpdate: true })
  onStop(async () => { rt.dispose(); await ctx.dispose() })
  const post = async endpoint => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint }),
  }))).json()
  const starting = await post('self-update-status')
  assert.equal(starting.value.startEnabled, true)
  assert.equal(starting.value.startRefusal, 'starting-up')
  const endpoint = 'self-update-start'
  const extension = t.mock.fn()
  rt.hooks.endpoint(endpoint, extension, { read: true })
  const start = t.mock.method(rt, 'selfUpdateStart', async () => ({ started: true }))
  assert.deepEqual(await post(endpoint), { ok: true, value: { started: true } })
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-window' }))
  assert.equal((await post(endpoint)).error.code, 'bot/read-only')
  assert.equal(start.mock.callCount(), 1)
  assert.equal(extension.mock.callCount(), 0)
  assert.equal(AGENT_TOOLS.some(tool => tool.endpoint === endpoint), false)
  assert.equal(rt.teamTools.some(tool => /self[-_]update[-_]start/.test(tool.name)), false)
  const channel = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  const reads = channel.slice(channel.indexOf('const READS ='), channel.indexOf('const CLI_LOGIN ='))
  assert.equal(reads.includes(endpoint), false)
})

for (const [name, rollback, force, refusal, problem, unbound] of [
  ['a forced start requires explicit rollback capability', undefined, true, 'rollback-missing'],
  ['a forced start refuses an empty rollback capability', '', true, 'rollback-missing'],
  ['a 5a boot refuses an inherited rollback flag', '1', true, 'rollback-missing'],
  ['a 5a boot refuses rollback capability from another boot', 'sup_old-boot', true, 'rollback-missing'],
  ['an unbound forced start refuses before closing the hold', bootId, true, 'page-outdated', false, true],
  ['a bound forced start with rollback for this boot follows the ordinary hold and request path', bootId, true],
  ['a forced start refuses invalid state even when status is available and admission is open', bootId, true, 'store-invalid', true],
  ['an ordinary start does not require rollback capability', undefined, false],
  ['an ordinary start keeps its eligibility with a reported store problem and an open hold', undefined, false, null, true],
]) {
  test(name, async t => {
    const key = 'AUTOMAGIK_SUPERVISOR_ROLLBACK'
    const previous = process.env[key]
    if (rollback === undefined) delete process.env[key]
    else process.env[key] = rollback
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })

    const { files, agents, rt, status } = await clickBench(t)
    assert.equal(rt.updateHold.closed, false)
    if (problem) Object.assign(status, { run: null, problem: 'Invalid state.json', available: true })
    const close = t.mock.method(rt.updateHold, 'close')
    const notes = t.mock.method(rt, 'markUpdateStop')
    const inboxes = t.mock.method(rt, 'noteUpdateInboxes')
    const flush = t.mock.method(rt, 'flushUpdateNotes')
    const cancel = t.mock.fn(() => rt.updateTurnEnded('running'))
    agents.push({ id: 'running', status: 'running', cancel })
    assert.equal(rt.selfUpdateStartRefusal(), null)
    const result = force ? await rt.selfUpdateStart(undefined, unbound ? { force: true }
      : { force: true, runId: 'check-run', reinstall: false }) : await rt.selfUpdateStart()
    if (refusal) {
      assert.deepEqual(result, { started: false, reason: refusal })
      for (const step of [close, notes, inboxes, flush, cancel]) assert.equal(step.mock.callCount(), 0)
      assert.equal(rt.updateHold.closed, false)
      assert.equal(existsSync(files.request), false)
      assert.equal(existsSync(join(files.home, 'inflight.json')), false)
    } else {
      assert.deepEqual(result, { started: true, requestId: result.requestId, stopped: 1, stillRunning: 0 })
      for (const step of [close, notes, inboxes, cancel]) assert.equal(step.mock.callCount(), 1)
      assert.equal(rt.updateHold.closed, true)
      const request = JSON.parse(readFileSync(files.request))
      assert.deepEqual(requestOf(request, bootId), request)
      assert.equal(request.requestId, result.requestId)
    }
  })
}

test('the start route passes the force option only for a boolean true', async t => {
  const { home, profileDir, onStop } = profile(t)
  const ctx = fakeContext({ services: { profileContext: { dir: profileDir } } })
  const register = ctx.connection.fetch.register
  let route
  ctx.connection.fetch.register = value => { route = value; return register(value) }
  const rt = createRuntime(ctx, { home, selfUpdate: true })
  onStop(async () => { rt.dispose(); await ctx.dispose() })
  const start = t.mock.method(rt, 'selfUpdateStart', async () => ({ started: true }))

  for (const force of [true, false, 'true', undefined]) {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint: 'self-update-start', payload: { force } }),
    }))
    assert.deepEqual(await response.json(), { ok: true, value: { started: true } })
  }
  assert.deepEqual(start.mock.calls.map(call => call.arguments[1]), [
    { force: true }, { force: false }, { force: false }, { force: false },
  ])
})

test('an expected run holds real admission past the boot ceiling and is consumed by its own verdict', async () => {
  const plans = []
  const c = clockHold({ expectedRun: 'live-run', run: new Error('profile and state unavailable'),
    bootPlan: () => { plans.push('plan') } })
  let stepped = false
  const gate = c.hold.wait().then(() => { stepped = true })
  c.advance(PROFILE_WAIT_MS + 1)
  c.status({ ...verdict('rolledBack'), runId: 'other-run' })
  await tickPromises()
  assert.equal(stepped, false)
  assert.deepEqual(c.hold.proof(), { state: 'closed', run: null })
  c.status(verdict('rollingBack'))
  assert.deepEqual(c.hold.proof(), { state: 'closed', run: 'live-run' })
  c.status(verdict('manualRecovery'))
  assert.equal(c.hold.closed, true)
  assert.deepEqual(plans, [])
  c.status(verdict('rolledBack'))
  await gate
  c.status(verdict('rolledBack'))
  assert.deepEqual(plans, ['plan'])
  c.hold.close('second-request')
  c.hold.wrote()
  c.status({ ...verdict('checking', 'second-request'), runId: 'second-run' })
  assert.deepEqual(c.hold.proof(), { state: 'closed', run: 'second-run' })
  c.status({ ...verdict('notUpdated', 'second-request'), runId: 'second-run' })
  assert.deepEqual(c.resumes, ['notUpdated'])
})

test('disposing a held trial releases no work when the previous child later receives rolledBack', async () => {
  const plans = []
  const trial = clockHold({ expectedRun: 'live-run', run: verdict('health'), bootPlan: () => { plans.push('trial') } })
  assert.equal(trial.hold.closed, true)
  trial.status(verdict('rollingBack'))
  trial.hold.dispose()
  const previous = clockHold({ expectedRun: 'live-run', run: verdict('rollingBack'), bootPlan: () => { plans.push('previous') } })
  const gate = previous.hold.gate()
  assert.deepEqual(plans, [])
  previous.status(verdict('rolledBack'))
  await gate
  trial.status(verdict('rolledBack'))
  assert.deepEqual(plans, ['previous'])
})


test('hold proof follows the latest owner request in a child started for an earlier run', () => {
  let run
  let profileKnown = true
  let readable = true
  const hold = createUpdateHold({
    expectedRun: 'boot-run',
    readStatus: () => ({ supervised: true, profileKnown, readable, run }),
    schedule: () => ({}),
  })
  assert.deepEqual(hold.proof(), { state: 'closed', run: null })
  run = { ...verdict('health'), runId: 'wrong-run' }
  assert.deepEqual(hold.proof(), { state: 'closed', run: null })
  run.runId = 'boot-run'
  profileKnown = false
  assert.deepEqual(hold.proof(), { state: 'closed', run: null })
  profileKnown = true
  assert.deepEqual(hold.proof(), { state: 'closed', run: 'boot-run' })
  readable = false
  assert.deepEqual(hold.proof(), { state: 'closed', run: null })
  readable = true
  run = { ...verdict('healthy'), runId: 'boot-run' }
  assert.deepEqual(hold.proof(), { state: 'open', run: null })
  hold.close('second-click')
  hold.wrote()
  assert.deepEqual(hold.proof(), { state: 'closed', run: null })
  run = { ...verdict('checking', 'second-click'), runId: 'second-run' }
  assert.deepEqual(hold.proof(), { state: 'closed', run: 'second-run' })
  run.phase = 'notUpdated'
  assert.deepEqual(hold.proof(), { state: 'open', run: null })
})
