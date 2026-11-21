import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { ROUTE } from '../src/host/constants.js'
import { install, RESUME_DELAY_MS } from '../src/host/resume.js'
import { newerCheckedCandidate, savedCheckSummary } from '../src/host/self-update-check.js'
import { readUpdateRecovery, startUpdateRecovery } from '../src/host/self-update-recovery.js'
import { storeDirOf, writeJsonAtomic } from '../src/host/self-update.js'
import { fakeContext } from './fake-ctx.js'

const bootId = 'supervisor-boot'
const run = {
  version: 1, runId: 'update-run', requestId: 'update-request', bootId, phase: 'healthy',
  from: '3.161.0', to: '3.162.0', reason: null,
  startedAt: '2026-11-20T12:00:00.000Z', updatedAt: '2026-11-20T12:00:01.000Z',
}

function files(t) {
  const home = mkdtempSync(join(tmpdir(), 'bots-update-recovery-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const store = storeDirOf(profileDir)
  return { home, profileDir, store, save: (file, data) => writeJsonAtomic(join(store, file), data, { profileDir }) }
}

const checked = at => ({
  version: 1, runId: 'dry-check', checkedAt: new Date(at).toISOString(), state: 'available', reason: null,
  laneVersion: '3.162.0', sequence: 162, supervisor: true,
  plugins: [{ name: '@automagik/bots-dsh', from: '3.161.0', to: '3.162.0' }],
  extra: 'private field',
})

test('ordinary status reads the saved check and current recovery for the owner without downloading or probing', async t => {
  const f = files(t)
  t.mock.method(globalThis, 'fetch', () => assert.fail('status tried to fetch a release or probe a registry'))
  const env = { AUTOMAGIK_SUPERVISOR_BOOT: bootId, AUTOMAGIK_SUPERVISOR_VERSION: '1.0.0' }
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    })
  }
  const record = checked(Date.now())
  f.save('check.json', record)
  f.save('supervisor.json', { version: 1, bootId, runId: run.runId })
  f.save('state.json', run)
  const tracker = startUpdateRecovery({
    profileDir: f.profileDir, run, ownsTeam: () => true, currentRun: () => run, warn: assert.fail,
    items: [{ kind: 'input', id: 'secret-message-id', name: 'Ada', sessionId: 'ada-chat' }],
  })
  tracker.resumed('input', 'secret-message-id')
  tracker.finish()
  const directory = readdirSync(f.store).sort()
  const before = readFileSync(join(f.store, 'check.json'), 'utf8')

  const ctx = fakeContext({ services: { profileContext: { dir: f.profileDir } } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path === ROUTE) route = options; return register(options) }
  const teamHome = join(f.home, 'team')
  const rt = createRuntime(ctx, { home: teamHome, browser: false, memory: false, updateCheck: false })
  rt.selfUpdateCheck = () => assert.fail('status started a dry check')
  const post = async payload => (await route.fetch(new Request('http://fixture.invalid' + ROUTE, {
    method: 'POST', body: JSON.stringify({ endpoint: 'self-update-status', payload }),
  }))).json()
  try {
    const reply = await post()
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.value.check, {
      checkedAt: record.checkedAt, laneVersion: record.laneVersion, sequence: record.sequence,
      plugins: record.plugins, state: record.state, fresh: true, newer: true,
    })
    assert.deepEqual(reply.value.recovery, {
      runId: run.runId, requestId: run.requestId, complete: true,
      items: [{ kind: 'input', name: 'Ada', sessionId: 'ada-chat', state: 'resumed' }],
    })
    const health = await post({ health: true })
    assert.equal(health.ok, true)
    assert.equal(health.value.check, undefined)
    assert.equal(health.value.recovery, undefined)
    assert.deepEqual(readdirSync(f.store).sort(), directory)
    assert.equal(readFileSync(join(f.store, 'check.json'), 'utf8'), before)

    f.save('current.json', { version: 1, live: { version: record.laneVersion, sequence: record.sequence }, kept: null,
      lastSequence: record.sequence })
    rt.config.selfUpdate = true
    rt.selfUpdateStartRefusal = () => null
    const consumed = (await post()).value
    assert.equal(consumed.check.fresh, true)
    assert.equal(consumed.check.newer, false)
    assert.equal(consumed.startEnabled, true)
    assert.equal(consumed.startRefusal, null)

    f.save('supervisor.json', { version: 1, bootId, runId: 'another-run' })
    assert.equal((await post()).value.recovery, undefined)
    writeFileSync(join(teamHome, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'peer' }))
    assert.equal((await post()).error.code, 'bot/read-only')
  } finally {
    try { await ctx.dispose() } finally { rt.dispose() }
  }
})

test('check freshness rejects future and ten-minute-old results and the current version consumes an offer', t => {
  const f = files(t)
  const now = Date.now()
  assert.equal(savedCheckSummary(f.profileDir, now), null)
  for (const [time, fresh] of [[now - 600_000, false], [now - 599_999, true], [now, true], [now + 1, false]]) {
    f.save('check.json', checked(time))
    assert.equal(savedCheckSummary(f.profileDir, now).fresh, fresh)
  }
  const check = savedCheckSummary(f.profileDir, now + 1)
  assert.equal(newerCheckedCandidate(check, null), true)
  assert.equal(newerCheckedCandidate(check, { live: { version: 'v3.161.0' }, lastSequence: 162 }), true)
  assert.equal(newerCheckedCandidate(check, { live: { version: '3.162.0' }, lastSequence: 162 }), false)
  assert.equal(newerCheckedCandidate(check, { live: { version: '3.163.0' }, lastSequence: 162 }), false)
  assert.equal(newerCheckedCandidate(check, { live: null, lastSequence: 163 }), false)
  f.save('check.json', { ...checked(now), plugins: [{ name: 'foreign', from: '3.161.0', to: '3.162.0' }] })
  assert.equal(savedCheckSummary(f.profileDir, now), null)
})

test('the boot resume pass durably reports pending, resumed and failed work for its exact run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = files(t)
  const ctx = fakeContext({ services: { profileContext: { dir: f.profileDir } } })
  const blocked = Promise.withResolvers()
  const sends = []
  ctx.sessions = { get: () => undefined, flush: async () => true }
  const rt = {
    ctx, home: f.home, config: {},
    state: { tasks: { found: { title: 'Draft the report' }, missing: { title: 'Build the chart' } } },
    chatOwners: new Map(), groupOwners: new Map(), live: new Map(),
    load: async () => {}, save: async () => {}, readOnly: () => undefined, warn() {},
    lockTerm: () => 1, holdsLock: () => true, teamLoaded: () => true, onLockGained: () => () => {},
    botOf() {}, deliver: async () => {},
    selfUpdateStatus: () => ({ run }),
    resolveAgent: id => id === 'found' ? blocked.promise : Promise.resolve(),
  }
  const notes = { turns: {}, queued: {}, held: {}, cut: ['found', 'missing'] }
  writeFileSync(join(f.home, 'inflight.json'), JSON.stringify(notes))
  f.save('state.json', run)
  const supervisor = readFileSync(join(f.store, 'state.json'), 'utf8')
  const previousRun = process.env.AUTOMAGIK_SUPERVISOR_RUN
  process.env.AUTOMAGIK_SUPERVISOR_RUN = run.runId
  try { install(rt) } finally {
    if (previousRun === undefined) delete process.env.AUTOMAGIK_SUPERVISOR_RUN
    else process.env.AUTOMAGIK_SUPERVISOR_RUN = previousRun
  }
  t.after(() => ctx.dispose())
  await immediate()
  t.mock.timers.tick(RESUME_DELAY_MS)
  await immediate()
  const pending = readUpdateRecovery(f.profileDir, run)
  assert.equal(pending.complete, false)
  assert.deepEqual(pending.items.map(item => item.state), ['pending', 'pending'])
  const mode = statSync(join(f.store, 'work-recovery-update-run.json')).mode & 0o777
  assert.equal(mode, 0o600)
  blocked.resolve({ status: 'running', session: { id: 'found' }, followup: message => sends.push(message) })
  assert.deepEqual((await rt.resumesDone).resumed, ['found'])
  assert.equal(sends.length, 1)
  assert.deepEqual(readUpdateRecovery(f.profileDir, run), {
    runId: run.runId, requestId: run.requestId, complete: true,
    items: [
      { kind: 'turn', sessionId: 'found', name: 'Draft the report', state: 'resumed' },
      { kind: 'turn', sessionId: 'missing', name: 'Build the chart', state: 'failed' },
    ],
  })
  for (const other of [
    { ...run, requestId: 'another-request' }, { ...run, runId: 'another-run' }, { ...run, phase: 'manualRecovery' },
  ]) assert.equal(readUpdateRecovery(f.profileDir, other), null)
  assert.equal(readFileSync(join(f.store, 'state.json'), 'utf8'), supervisor)
  assert.equal(startUpdateRecovery({
    profileDir: f.profileDir, run, items: [], ownsTeam: () => false, currentRun: () => run, warn: assert.fail,
  }), null)
})

test('the same-process give-back reports only the supervisor run that accepted its request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = files(t)
  const ctx = fakeContext({ services: { profileContext: { dir: f.profileDir } } })
  ctx.sessions = { get: () => undefined, flush: async () => true }
  const sent = []
  const verdict = { ...run, phase: 'notUpdated', reason: 'download-failed' }
  let live = null
  const rt = {
    ctx, home: f.home, config: {}, state: { tasks: { work: { title: 'Keep working' } } },
    chatOwners: new Map(), groupOwners: new Map(), live: new Map(),
    load: async () => {}, save: async () => {}, readOnly: () => undefined, warn() {},
    lockTerm: () => 1, holdsLock: () => true, teamLoaded: () => true, onLockGained: () => () => {},
    botOf() {}, deliver: async () => {},
    selfUpdateStatus: () => ({ run: live }),
    resolveAgent: async () => ({ status: 'running', session: { id: 'work' }, followup: message => sent.push(message) }),
  }
  install(rt)
  t.after(() => ctx.dispose())
  await immediate()
  t.mock.timers.tick(RESUME_DELAY_MS)
  await rt.resumesDone
  for (const [requestId, reports] of [['unanswered-request', false], [verdict.requestId, true]]) {
    await rt.markUpdateStop(['work'])
    await rt.flushUpdateNotes(() => ({ started: true, requestId }))
    live = verdict
    await rt.resumeUpdateStopped()
    await immediate()
    assert.equal(readUpdateRecovery(f.profileDir, verdict)?.complete === true, reports)
  }
  assert.equal(sent.length, 2)
  assert.deepEqual(readUpdateRecovery(f.profileDir, verdict).items,
    [{ kind: 'turn', sessionId: 'work', name: 'Keep working', state: 'resumed' }])
})

test('large recovery records bound both bytes and entries and count every omitted outcome', t => {
  const f = files(t)
  const track = (target, items) => startUpdateRecovery({
    profileDir: f.profileDir, run: target, ownsTeam: () => true, currentRun: () => target, warn: assert.fail, items,
  })
  const item = (id, name = 'Task') => ({ kind: 'turn', id: `task-${id}`, sessionId: `task-${id}`, name })
  const items = [item('huge', '🧾'.repeat(20_000)), ...Array.from({ length: 170 }, (_, id) => item(id))]
  const recovery = track(run, items)
  const file = join(f.store, `work-recovery-${run.runId}.json`)
  const pending = readUpdateRecovery(f.profileDir, run)
  assert.equal(pending.items.length, 100)
  assert.equal(pending.items.some(row => row.sessionId === 'task-huge'), false)
  assert.ok(statSync(file).size < 64 * 1024)
  assert.deepEqual(pending.omitted, { pending: 71, resumed: 0, failed: 0, unconfirmed: 0 })
  recovery.resumed('turn', 'task-0')
  recovery.resumed('turn', 'task-huge')
  recovery.resumed('turn', 'task-169')
  assert.deepEqual(readUpdateRecovery(f.profileDir, run).omitted, { pending: 69, resumed: 2, failed: 0, unconfirmed: 0 })
  recovery.finish()
  const done = readUpdateRecovery(f.profileDir, run)
  assert.equal(done.complete, true)
  assert.equal(done.items[0].state, 'resumed')
  assert.deepEqual(done.omitted, { pending: 0, resumed: 2, failed: 69, unconfirmed: 0 })

  const next = { ...run, runId: 'next-update', requestId: 'next-request' }
  track(next, Array.from({ length: 20 }, (_, id) => item(id, '🧾'.repeat(1500))))
  const sized = readUpdateRecovery(f.profileDir, next)
  assert.ok(sized.items.length > 0 && sized.items.length < 20)
  assert.equal(sized.items.length + sized.omitted.pending, 20)
  assert.ok(statSync(join(f.store, `work-recovery-${next.runId}.json`)).size <= 60 * 1024)
  const recovered = track(next, [])
  recovered.finish()
  assert.deepEqual(readUpdateRecovery(f.profileDir, next).omitted, {
    pending: 0, resumed: 0, failed: 0, unconfirmed: sized.omitted.pending,
  })
})

test('successive runs prune only superseded recovery records under the owner lock', t => {
  const f = files(t)
  f.save('state.json', run)
  f.save('check.json', checked(Date.now()))
  f.save('work-recovery-note.json', { human: true })
  let current
  const runFor = id => ({ ...run, runId: `update-run-${id}`, requestId: `update-request-${id}` })
  const put = (id, ownsTeam, warn = assert.fail) => startUpdateRecovery({
    profileDir: f.profileDir, run: runFor(id),
    items: [{ kind: 'input', id: 'pending-input', sessionId: 'chat', name: 'Main Bot' }],
    ownsTeam, currentRun: () => current, warn,
  })
  const recoveryFiles = () => readdirSync(f.store).filter(name => name.startsWith('work-recovery-update'))
  current = runFor(1)
  const old = put(1, () => true)
  assert.equal(put(2, () => false), null)
  assert.deepEqual(recoveryFiles(), ['work-recovery-update-run-1.json'])
  current = runFor(2)
  put(2, () => true).finish()
  old.resumed('input', 'pending-input')
  old.finish()
  assert.deepEqual(recoveryFiles(), ['work-recovery-update-run-2.json'])

  current = runFor(3)
  const blocked = join(f.store, 'work-recovery-update-run-3.json')
  mkdirSync(blocked)
  const warnings = []
  const late = put(3, () => true, (...args) => warnings.push(args))
  assert.equal(warnings.length, 1)
  rmSync(blocked, { recursive: true })
  assert.equal(readUpdateRecovery(f.profileDir, current), null)
  current = runFor(4)
  put(4, () => true).finish()
  late.resumed('input', 'pending-input')
  late.finish()
  assert.equal(readUpdateRecovery(f.profileDir, current).complete, true)
  assert.deepEqual(readdirSync(f.store).sort(), [
    'check.json', 'state.json', 'work-recovery-note.json', 'work-recovery-update-run-4.json',
  ])
})
