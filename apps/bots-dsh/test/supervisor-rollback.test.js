import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { connectorState } from '../src/host/connectors/credential-state.js'
import { homeLock } from '../src/host/home-lock.js'
import { runSupervisor } from '../src/host/supervisor/main.js'
import { finishRolledBack, restoreData, runRollback, teamSnapshot } from '../src/host/supervisor/rollback.js'
import { PROFILE_INPUTS, VENDOR } from '../src/host/supervisor/stage.js'
import { writeJsonAtomic } from '../src/host/supervisor/store.js'
import { completeSwitch, planSwitch, validTerminalJournal } from '../src/host/supervisor/switch.js'
import { BOTS, eventsOf, fixture, FROM, HOST, lane, read, RUN_ID, TO, write } from './fixtures/supervisor.mjs'

const now = new Date().toISOString()
const saveTo = run => changes => Object.assign(run, changes)
const originalTeam = { version: 1, revision: 7, note: 'original roster' }
const trialTeam = { version: 3, revision: 8, note: 'edited during trial' }
const priorCurrent = { version: 1, live: { version: FROM, sequence: 41 }, kept: null, lastSequence: 41 }
const nextCurrent = { version: 1, live: { version: TO, sequence: 42 }, kept: { version: FROM }, lastSequence: 42 }
const cutError = new Error('service group interrupted')
const frozen = fileURLToPath(new URL('./fixtures/supervisor-5b/', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/supervisor-driver.mjs', import.meta.url))

function install5b(f) {
  const kept = join(f.store, 'supervisor/kept')
  const current = join(f.store, 'supervisor/current')
  fs.mkdirSync(join(current, 'supervisor'), { recursive: true })
  fs.writeFileSync(join(current, 'supervisor/main.js'), '')
  fs.cpSync(frozen, kept, { recursive: true, filter: path => basename(path) !== 'README.md' })
  fs.writeFileSync(join(kept, 'package.json'), '{"type":"module"}\n')
  fs.writeFileSync(join(kept, 'version.json'), JSON.stringify({ version: FROM }) + '\n')
  const launcher = join(f.store, 'supervisor/launcher.sh')
  fs.copyFileSync(join(HOST, 'supervisor/launcher.sh'), launcher)
  return { kept, launcher }
}

async function launch(f, launcher) {
  // This fake DSH exits before opening a socket and records each boot.
  const stderrPath = join(f.root, 'launcher.stderr')
  const stderr = fs.openSync(stderrPath, 'w')
  let child
  try {
    child = spawn('sh', [launcher, '--dsh-home', f.home, '--profile', f.profile, '--', ...f.command], {
      env: { ...f.env, SUPERVISOR_MODE: 'exit' }, stdio: ['ignore', 'ignore', stderr],
      signal: AbortSignal.timeout(5000),
    })
  } finally {
    fs.closeSync(stderr)
  }
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { status, stderr: fs.readFileSync(stderrPath, 'utf8') }
}

function prepare(t, options = {}) {
  const f = fixture(t)
  const { profileDir, staging } = f
  const path = join(f.botsHome, 'state.json')
  const state = join(f.store, 'state.json')
  const current = join(f.store, 'current.json')
  const kept = join(f.store, 'versions', FROM)
  const backup = join(f.store, 'rollback-data', RUN_ID)
  const originalLock = fs.readFileSync(join(profileDir, 'pnpm-lock.yaml'))
  if (options.absent) fs.unlinkSync(path)
  else write(path, options.originalTeam ?? originalTeam)
  if (options.contract) write(join(profileDir, 'node_modules', BOTS, 'src/host/update-contract.json'),
    { version: 1, holdRun: true, ...options.contract })
  fs.mkdirSync(join(staging.profileDir, 'node_modules', BOTS), { recursive: true })
  fs.mkdirSync(staging.source)
  for (const file of PROFILE_INPUTS) fs.copyFileSync(join(profileDir, file), join(staging.source, file))

  const archive = f.release[0].sha256 + '.tgz'
  const pin = VENDOR + '/' + archive
  const candidateArchive = join(profileDir, pin)
  const candidate = structuredClone(f.manifest)
  candidate.dependencies[BOTS] = 'file:' + pin
  write(join(staging.profileDir, 'package.json'), candidate)
  write(join(staging.profileDir, 'node_modules', BOTS, 'package.json'), { version: TO })
  fs.writeFileSync(join(staging.profileDir, 'pnpm-lock.yaml'), 'candidate: file:' + pin + '\n')
  fs.writeFileSync(candidateArchive, 'new archive')
  write(join(staging.root, 'created-archives.json'), [archive])

  f.config.stateFormats = options.reads ?? [0, 1, 2]
  const run = {
    version: 1, phase: 'switching', reason: null, runId: RUN_ID, bootId: 'sup_fixture',
    from: FROM, to: TO, sequence: 42, names: [BOTS], startedAt: now, updatedAt: now,
    ...(!options.legacy ? { fromVersions: { [BOTS]: FROM }, priorCurrent } : {}),
  }
  run.journal = planSwitch(f.config, staging, run, options.contract)
  completeSwitch(f.config, staging, run, () => {})
  if (options.contractMissing) fs.unlinkSync(join(kept, 'node_modules', BOTS, 'src/host/update-contract.json'))
  if (options.teamMissing) fs.unlinkSync(path)
  else if (!options.absent) write(path, options.legacy ? { version: 2, revision: 8, note: 'readable team' } : trialTeam)
  if (options.committed) write(current, nextCurrent)
  else write(current, priorCurrent)
  Object.assign(run, {
    phase: 'rollingBack', reason: 'health-failed',
    rollback: { failed: 'page', step: 'stop', trialFrom: now, tried: [], restoreCurrent: !!options.committed },
    journal: { ...run.journal, undo: true, undoReason: 'health-failed' },
  })
  persist(f, state, run)
  return { ...f, run, path, state, current, kept, backup, candidateArchive, originalLock }
}

const persist = (f, path, value) => writeJsonAtomic(path, value, { profileDir: f.profileDir, durable: true })
const versionAt = f => read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version

function assertPrevious(f, team = originalTeam) {
  assert.equal(versionAt(f), FROM)
  assert.deepEqual(fs.readFileSync(join(f.profileDir, 'pnpm-lock.yaml')), f.originalLock)
  const manifest = read(join(f.profileDir, 'package.json'))
  assert.deepEqual(manifest.dependencies, f.manifest.dependencies)
  assert.ok(fs.existsSync(f.archive))
  assert.equal(fs.existsSync(f.candidateArchive), false)
  assert.equal(fs.readFileSync(join(f.profileDir, 'vendor/owner.tgz'), 'utf8'), 'owner archive')
  assert.deepEqual(read(f.path), team)
  assert.deepEqual(read(f.current), priorCurrent)
}

async function rollback(f, { cutAt, frozenCheck, ...hooks } = {}) {
  const run = read(f.state)
  const signal = new AbortController()
  const checkpoints = []
  const cut = label => {
    const index = checkpoints.push(label)
    if (index === cutAt || label === cutAt || (typeof cutAt === 'function' && cutAt(run))) {
      signal.abort(cutError)
      throw cutError
    }
  }
  const save = (changes = {}) => {
    const next = { ...run, ...changes }
    persist(f, f.state, next)
    Object.assign(run, next)
    cut('save:' + run.phase + ':' + run.rollback.step)
  }
  let outcome
  try {
    await runRollback({
      config: f.config, staging: f.staging, run, save, signal: signal.signal,
      stop: async () => {},
      restoreCurrent: () => persist(f, f.current, run.priorCurrent),
      start: verifyHandoff => {
        verifyHandoff()
        assert.equal(run.phase, 'rollingBack')
        assert.equal(run.rollback.step, 'restart')
        assertPrevious(f, hooks.team)
        return {}
      },
      health: async (_child, expect) => {
        assert.deepEqual(expect, { [BOTS]: run.fromVersions ? FROM : null })
        return { ok: true }
      },
      manualRecovery: (_code, reason, fields) => save({ phase: 'manualRecovery', reason, ...fields }),
      afterRename: step => cut('rename:' + step),
      beforeVerdict: () => cut('before-verdict'),
      ...hooks,
    })
  } catch (error) {
    if (error !== cutError) throw error
  } finally {
    outcome = read(f.state)
  }
  if (signal.signal.aborted && frozenCheck && outcome.phase === 'rollingBack') {
    const { launcher } = install5b(f)
    const tree = JSON.stringify(outcome.journal)
    const old = await launch(f, launcher)
    assert.equal(old.status, 1, old.stderr)
    assert.equal(read(f.state).phase, 'manualRecovery')
    assert.equal(JSON.stringify(read(f.state).journal), tree)
    assert.equal(eventsOf(f).filter(event => event.event === 'boot').length, 0)
    persist(f, f.state, outcome)
  }
  return { run: outcome, checkpoints }
}

async function recoverThroughDriver(f, expected = 'rolledBack') {
  const { home, profile, command } = f
  command[command.indexOf('--port') + 1] = '3080'
  const options = { ...lane(f), home, profile, command, version: FROM, tarballs: [] }
  const stderrPath = join(f.root, 'recovered.stderr')
  const stderr = fs.openSync(stderrPath, 'w')
  let child
  try {
    child = spawn(process.execPath, [driver], {
      env: { ...f.env, SUPERVISOR_DRIVER: JSON.stringify(options),
        SUPERVISOR_ANNOUNCE_ONLY: '1', SUPERVISOR_FAKE_TRANSPORT: '1' },
      stdio: ['ignore', 'ignore', stderr],
    })
  } finally {
    fs.closeSync(stderr)
  }
  let exited = false
  let observed = false
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { exited = true; resolve(code) })
  })
  try {
    for (let n = 0; n < 200; n++) {
      const state = read(f.state)
      if (state.phase === expected && (expected !== 'rolledBack' || eventsOf(f).some(event => event.event === 'boot'))) {
        observed = true
        return state
      }
      if (exited) break
      await wait(25)
    }
    assert.fail('recovered supervisor did not serve FROM: ' + fs.readFileSync(stderrPath, 'utf8'))
  } finally {
    if (!exited && (!observed || expected === 'rolledBack')) child.kill('SIGTERM')
    const code = await exit
    if (observed) assert.equal(code, expected === 'rolledBack' ? 0 : 1, fs.readFileSync(stderrPath, 'utf8'))
  }
}

test('every rollback save and reverse rename is replayable and the frozen 5b copy refuses in-progress cuts', async t => {
  const uninterrupted = prepare(t, { committed: true })
  const { checkpoints } = await rollback(uninterrupted)
  assert.equal(checkpoints.filter(label => label.startsWith('rename:')).length, 6)
  assert.ok(checkpoints.includes('before-verdict'))
  assert.equal(checkpoints.at(-1), 'save:rolledBack:health')
  // Zero denotes the durable rollback intent before the first rollback operation.
  for (let i = 0; i <= checkpoints.length; i++) {
    await t.test(i === 0 ? 'after intent' : i + ' ' + checkpoints[i - 1], async t => {
      const f = prepare(t, { committed: true })
      if (i === 0) {
        const { launcher } = install5b(f)
        const saved = read(f.state)
        assert.equal((await launch(f, launcher)).status, 1)
        assert.equal(eventsOf(f).length, 0)
        persist(f, f.state, saved)
      } else {
        const cut = await rollback(f, { cutAt: i, frozenCheck: true })
        assert.equal(cut.checkpoints.length, i)
      }
      const terminal = await recoverThroughDriver(f)
      assert.equal(eventsOf(f).filter(event => event.event === 'boot').length, 1)
      assert.equal(terminal.phase, 'rolledBack')
      assert.equal(validTerminalJournal(terminal), true)
      assert.equal(Object.hasOwn(terminal.journal, 'undoReason'), false)
      assertPrevious(f)
      finishRolledBack(f.config, f.staging, terminal)
      assert.deepEqual(read(join(f.backup, 'bots-state.json')), originalTeam)
      assert.deepEqual(read(join(f.backup, 'trial-bots-state.json')), trialTeam)
    })
  }
})

test('the installed 5b copy starts FROM after rolledBack and the frozen launcher gates both broken copies', async t => {
  const f = prepare(t)
  const { kept, launcher } = install5b(f)
  const saved = read(f.state)
  const broken = join(kept, 'supervisor/main.js')
  const original = fs.readFileSync(broken)
  fs.writeFileSync(broken, '')
  assert.equal((await launch(f, launcher)).status, 1)
  assert.equal(eventsOf(f).length, 0)
  assert.deepEqual(read(f.state), saved)
  await rollback(f)
  fs.writeFileSync(broken, original)
  assert.equal((await launch(f, launcher)).status, 23)
  assert.match(eventsOf(f).at(-1).boot, /^sup_/)
  assert.equal(versionAt(f), FROM)
  fs.writeFileSync(broken, '')
  assert.equal((await launch(f, launcher)).status, 23)
  assert.equal(eventsOf(f).at(-1).boot, undefined)
})

for (const [caseName, trial, data] of [
  ['newer', trialTeam, { restored: true, trialKept: true }],
  ['same', { version: 2, revision: 7 }, { restored: false, why: 'same-format', trialKept: false }],
  ['older', { version: 0, revision: 8 }, { restored: false, why: 'same-format', trialKept: false }],
  ['missing', undefined, { restored: true, why: 'team-lost', trialKept: false }],
]) {
  test('team restore handles ' + caseName + ' trial data', async t => {
    const f = prepare(t)
    if (trial === undefined) fs.unlinkSync(f.path)
    else if (typeof trial === 'string') fs.writeFileSync(f.path, trial)
    else write(f.path, trial)
    const run = read(f.state)
    await restoreData(f.config, run, saveTo(run))
    assert.deepEqual(run.rollback.data, data)
    if (data.restored) assert.deepEqual(read(f.path), originalTeam)
    else if (typeof trial === 'string') assert.equal(fs.readFileSync(f.path, 'utf8'), trial)
    else assert.deepEqual(read(f.path), trial)
  })
}

for (const [scenario, end, why] of [
  ['release', 1000], ['stale', 60_000], ['persistent', 65_000, 'team-in-use'],
  ['abort', 500], ['index changes', 1000, 'snapshot-changed'], ['claim loses ownership', 0, 'team-in-use'],
]) {
  test('rollback lock retries handle ' + scenario, async t => {
    const f = prepare(t)
    const run = read(f.state)
    const lockPath = join(f.botsHome, 'state.lock')
    const epoch = 1_800_000_000_000
    const peer = { token: 'other', host: hostname(), pid: process.ppid }
    write(lockPath, peer)
    fs.utimesSync(lockPath, new Date(epoch), new Date(epoch))
    let elapsed = 0, created = 0
    const attempts = []
    const abort = new AbortController()
    const createLock = path => {
      assert.equal(path, lockPath)
      created++
      const lock = homeLock(path, { now: () => epoch + elapsed, isAlive: () => true })
      return { ...lock, claim() {
        attempts.push(elapsed)
        if (scenario === 'claim loses ownership') return undefined
        return lock.claim()
      } }
    }
    const wait = async (ms, signal) => {
      assert.equal(signal, abort.signal)
      assert.equal(run.rollback.data, undefined)
      assert.equal(run.journal.restore, undefined)
      assert.equal(fs.existsSync(f.backup), false)
      assert.deepEqual(read(f.path), trialTeam)
      elapsed += ms
      if (scenario === 'persistent') fs.utimesSync(lockPath, new Date(epoch + elapsed), new Date(epoch + elapsed))
      if (elapsed !== end) return
      if (scenario === 'abort') abort.abort(cutError)
      if (scenario === 'release' || scenario === 'index changes') fs.unlinkSync(lockPath)
      if (scenario === 'index changes') {
        const index = join(f.kept, 'data.json')
        fs.appendFileSync(index, ' ')
      }
    }
    const options = { now: () => elapsed, wait, createLock, signal: abort.signal }
    const attempt = restoreData(f.config, run, saveTo(run), options)
    if (why || abort.signal.aborted || scenario === 'abort') {
      await assert.rejects(attempt, why ? new RegExp(why) : cutError)
      assert.deepEqual(read(f.path), trialTeam)
      assert.equal(run.rollback.data, undefined)
    } else {
      await attempt
      assert.deepEqual(read(f.path), originalTeam)
    }
    const lastAttempt = scenario === 'abort' ? end - 250 : end
    assert.deepEqual(attempts, Array.from({ length: lastAttempt / 250 + 1 }, (_, i) => i * 250))
    assert.equal(created, 1)
    if (scenario === 'abort') {
      fs.unlinkSync(lockPath)
      await restoreData(f.config, run, saveTo(run))
      assert.deepEqual(read(f.path), originalTeam)
    }
  })
}

test('loss after restore intent stops without retrying or writing the live team', async t => {
  const f = prepare(t)
  const run = read(f.state)
  const lockPath = join(f.botsHome, 'state.lock')
  const other = { host: hostname(), pid: process.ppid, token: 'other' }
  await assert.rejects(restoreData(f.config, run, changes => {
    Object.assign(run, changes)
    if (changes.journal.restore) write(lockPath, other)
  }, { wait: () => assert.fail('the acquired lock must not be retried') }), /team-in-use/)
  assert.deepEqual(read(lockPath), other)
  assert.deepEqual(read(f.path), trialTeam)
  assert.equal(run.rollback.data, undefined)
})

const protectedContract = { stateFormats: [0, 1, 2, 3, 4, 5], activations: ['base-role', 'stack-role'] }
for (const [name, from, to, active, result] of [
  ['format 4 subset', 4, 4, ['base-role'], 'keep'],
  ['format 5 subset', 5, 5, ['stack-role', 'base-role'], 'keep'],
  ['compatible cross-format', 4, 5, ['stack-role', 'base-role'], 'keep'],
  ['foreign activation at the same format', 4, 4, ['base-role', 'new-role'], 'restore'],
  ['missing trial list', 2, 4, undefined, 'restore'],
  ['empty trial list', 2, 4, [], 'restore'],
  ['invalid trial ID', 2, 4, ['BOGUS'], 'restore'],
  ['duplicate trial ID', 2, 5, ['base-role', 'base-role'], 'restore'],
  ['contradictory legacy marker', 2, 2, ['base-role'], 'restore'],
]) {
  test('rollback compares ' + name, async t => {
    const original = { ...originalTeam, version: from, ...(from >= 4 ? { stateActivations: ['base-role'] } : {}) }
    const f = prepare(t, { originalTeam: original, contract: protectedContract })
    const trial = { ...trialTeam, version: to, stateActivations: active }
    write(f.path, trial)
    const { run } = await rollback(f, { team: result === 'keep' ? JSON.parse(JSON.stringify(trial)) : original })
    assert.equal(run.phase, 'rolledBack')
    assert.deepEqual(run.rollback.data, result === 'keep' ? { restored: false, why: 'same-format', trialKept: false }
      : { restored: true, trialKept: true })
    assert.deepEqual(read(join(f.backup, 'bots-state.json')), original)
    const retained = join(f.backup, 'trial-bots-state.json')
    if (result === 'restore') assert.deepEqual(read(retained), JSON.parse(JSON.stringify(trial)))
    else assert.equal(fs.existsSync(retained), false)
  })
}

for (const [field, value, result] of [
  ['activations', undefined, 'restore'], ['activations', 'base-role', 'restore'], ['activations', ['base-role', 'base-role'], 'restore'],
  ['activations', [], 'restore'], ['reads', undefined, 'blocked'], ['reads', [2, '4'], 'blocked'], ['sha256', undefined, 'restore'],
]) {
  test('rollback needs valid captured ' + field + ' for protected trial, fixture ' + JSON.stringify(value), async t => {
    const f = prepare(t, { contract: protectedContract })
    const path = join(f.kept, 'data.json')
    const index = read(path)
    index.files[0][field] = value
    write(path, index)
    const trial = { version: 4, revision: 8, stateActivations: ['base-role'] }
    write(f.path, trial)
    const { run } = await rollback(f, result === 'blocked' ? { start: () => assert.fail('missing proof') } : {})
    assert.equal(run.phase, result === 'blocked' ? 'manualRecovery' : 'rolledBack')
    if (result === 'blocked') {
      assert.deepEqual(run.rollback.data, { restored: false, why: 'unknown', trialKept: false })
      assert.deepEqual(read(f.path), trial)
    } else {
      assert.deepEqual(read(f.path), originalTeam)
      assert.deepEqual(read(join(f.backup, 'trial-bots-state.json')), trial)
    }
  })
}

test('a historical index without a digest still allows a compatible legacy trial', async t => {
  const f = prepare(t)
  const path = join(f.kept, 'data.json')
  const index = read(path)
  delete index.files[0].sha256
  write(path, index)
  const team = { ...trialTeam, version: 2 }
  write(f.path, team)
  const { run } = await rollback(f, { team })
  assert.equal(run.phase, 'rolledBack')
  assert.deepEqual(run.rollback.data, { restored: false, why: 'same-format', trialKept: false })
})

for (const why of ['unknown', 'team-in-use', 'snapshot-changed', 'superseded']) {
  test('a recorded ' + why + ' skip replays directly into manual recovery', async t => {
    const f = prepare(t)
    const { run } = f
    const data = { restored: false, why, trialKept: false }
    run.rollback.data = data
    persist(f, f.state, run)
    const outcome = await rollback(f, { start: () => assert.fail('a blocked predecessor cannot start') })
    assert.deepEqual(outcome.checkpoints, ['save:manualRecovery:stop'])
    assert.equal(outcome.run.phase, 'manualRecovery')
    assert.deepEqual(outcome.run.rollback.data, data)
    assert.deepEqual(read(f.path), trialTeam)
  })
}

for (const kind of ['kept', 'restored', 'absent']) {
  test('replacement at the spawn boundary blocks a previously proven ' + kind + ' team', async t => {
    const f = prepare(t, { absent: kind === 'absent' })
    if (kind === 'kept') write(f.path, { ...trialTeam, version: 2 })
    const replacement = { version: 2, revision: 30, bots: {}, note: 'replacement' }
    let handoffs = 0
    const code = await runSupervisor({ ...lane(f), home: f.home, profile: f.profile, command: f.command,
      version: FROM, env: f.env, onChildStart() { handoffs++; write(f.path, replacement) },
      fetch: () => assert.fail('rollback is offline'), healthTimeout: 300,
    })
    assert.equal(code, 1)
    assert.equal(handoffs, 1)
    assert.equal(eventsOf(f).length, 0)
    const saved = read(f.state)
    assert.equal(saved.phase, 'manualRecovery')
    assert.deepEqual(saved.rollback.data, { restored: false, why: 'superseded', trialKept: false })
    assert.deepEqual(read(f.path), replacement)
  })
}

test('rollback restores a supported roster and retains the encrypted trial', async t => {
  const f = prepare(t)
  const credentials = connectorState(f.botsHome, () => true)
  const clear = 'fixture-rollback-token9'
  const trial = credentials.encode({ ...trialTeam, connectors: {
    service: { custom: { command: 'mcp', env: { TOKEN: clear } } },
  } }).bytes
  const key = join(f.botsHome, 'connector-key')
  const bytes = fs.readFileSync(key)
  fs.writeFileSync(f.path, trial)
  const run = read(f.state)
  await restoreData(f.config, run, saveTo(run))
  assert.deepEqual(run.rollback.data, { restored: true, trialKept: true })
  assert.deepEqual(read(f.path), originalTeam)
  const retained = join(f.backup, 'trial-bots-state.json')
  assert.equal(fs.readFileSync(retained, 'utf8'), trial)
  assert.equal(trial.includes(clear), false)
  assert.deepEqual(fs.readFileSync(key), bytes)
  const restoredTrial = read(retained)
  credentials.decode(restoredTrial)
  assert.equal(restoredTrial.connectors.service.custom.env.TOKEN, clear)
  assert.equal(fs.existsSync(join(f.backup, 'connector-key')), false)
})

for (const modified of ['none', 'trial', 'snapshot', 'previous-after-completion']) {
  test('replays restore intent safely with ' + modified + ' changes', async t => {
    const f = prepare(t)
    const run = read(f.state)
    await assert.rejects(restoreData(f.config, run, changes => {
      Object.assign(run, changes)
      throw cutError
    }), error => error === cutError)
    assert.equal(run.journal.restored, undefined)
    assert.ok(run.journal.restore)
    const update = { version: 2, note: 'new edit' }
    if (modified === 'trial') write(f.path, update)
    if (modified === 'snapshot') write(teamSnapshot(f.config, run).saved, update)
    const save = changes => Object.assign(run, changes)
    if (modified === 'trial' || modified === 'snapshot') {
      await assert.rejects(restoreData(f.config, run, save), modified === 'trial' ? /superseded/ : /snapshot-changed/)
      assert.equal(run.rollback.data, undefined)
    } else await restoreData(f.config, run, save)
    if (modified === 'previous-after-completion') {
      write(f.path, update)
      await assert.rejects(restoreData(f.config, run, save), /superseded/)
      assert.deepEqual(read(f.path), update)
    } else {
      assert.deepEqual(read(f.path), modified === 'trial' ? update : modified === 'snapshot' ? trialTeam : originalTeam)
    }
    if (modified === 'none' || modified === 'previous-after-completion') {
      assert.deepEqual(run.rollback.data, { restored: true, trialKept: true })
    }
  })
}

for (const completed of [false, true]) {
  test('restore replay requires the displaced trial archive, recorded outcome: ' + completed, async t => {
    const f = prepare(t)
    const run = read(f.state)
    await restoreData(f.config, run, saveTo(run))
    assert.equal(run.rollback.data.trialKept, true)
    if (!completed) {
      delete run.rollback.data
      delete run.journal.restored
    }
    const archive = join(f.backup, 'trial-bots-state.json')
    fs.rmSync(archive)
    await assert.rejects(restoreData(f.config, run, saveTo(run)), /snapshot-changed/)
    write(archive, { version: 2, note: 'unexpected bytes' })
    await assert.rejects(restoreData(f.config, run, saveTo(run)), /snapshot-changed/)
    assert.deepEqual(read(f.path), originalTeam)
  })
}

test('rollback replay preserves the verified archive when the kept snapshot changes after restore intent', async t => {
  const f = prepare(t)
  const before = await rollback(f, { cutAt: run => !!run.journal.restore })
  assert.equal(before.run.phase, 'rollingBack')
  assert.equal(before.run.journal.restored, undefined)
  const archived = join(f.backup, 'bots-state.json')
  const original = fs.readFileSync(archived)
  assert.deepEqual(JSON.parse(original), originalTeam)
  write(teamSnapshot(f.config, before.run).saved, { ...originalTeam, note: 'changed kept snapshot' })

  const terminal = await recoverThroughDriver(f, 'manualRecovery')
  assert.equal(eventsOf(f).length, 0)
  assert.deepEqual(terminal.rollback.data, { restored: false, why: 'snapshot-changed', trialKept: false })
  assert.deepEqual(fs.readFileSync(archived), original)
  assert.deepEqual(read(f.path), trialTeam)
})

for (const input of ['dependencies', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json', 'dsh']) {
  test('rollback rechecks ' + input + ' after the restored child passes health', async t => {
    const f = prepare(t)
    const result = await rollback(f, {
      health: async () => {
        if (input === 'dependencies' || input === 'dsh') {
          const file = join(f.profileDir, 'package.json')
          const manifest = read(file)
          if (input === 'dsh') manifest.dsh.profile.bundles.push('reconciled')
          else manifest.dependencies['custom-plugin'] = '^2.0.0'
          write(file, manifest)
        } else fs.appendFileSync(join(f.profileDir, input), '\n')
        return { ok: true }
      },
    })
    if (input === 'dsh') assert.equal(result.run.phase, 'rolledBack')
    else {
      assert.equal(result.run.phase, 'manualRecovery')
      assert.equal(result.run.reason, 'rollback-failed')
      assert.equal(result.run.rollback.step, 'verify')
    }
  })
}

test('a legacy journal verifies by digests and probes the restored set without version pins', async t => {
  const f = prepare(t, { legacy: true })
  const result = await rollback(f, { team: { version: 2, revision: 8, note: 'readable team' } })
  assert.equal(result.run.phase, 'rolledBack')
  assert.equal(result.run.rollback.unpinned, true)
})

test('a legacy FROM without the hold contract is restored and stopped before restart', async t => {
  const f = prepare(t, { legacy: true, contractMissing: true })
  const result = await rollback(f, { start: () => assert.fail('unsupported previous child started') })
  assert.equal(result.run.phase, 'manualRecovery')
  assert.equal(result.run.rollback.step, 'verify')
  assert.equal(versionAt(f), FROM)
})

test('each interrupted restart intent counts toward the three-start budget and an observed exit is terminal', async t => {
  const f = prepare(t)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { run } = await rollback(f, { cutAt: 'save:rollingBack:restart',
      start: () => assert.fail('cut should happen before the spawn') })
    assert.equal(run.rollback.starts, attempt)
    assert.equal(run.rollback.failures, undefined)
  }
  const exhausted = await rollback(f, { start: () => assert.fail('the budget is exhausted') })
  assert.equal(exhausted.run.phase, 'manualRecovery')
  assert.equal(exhausted.run.rollback.why, 'restart-budget')

  const exiting = prepare(t)
  const result = await rollback(exiting, {
    start: () => ({ result: { code: 1 } }), health: async () => ({ ok: false, failed: 'exited' }),
  })
  assert.equal(result.run.phase, 'manualRecovery')
  assert.equal(result.run.rollback.failures, 1)
  assert.equal(result.run.rollback.previousFailed, 'exited')
})

test('an asynchronous previous-child spawn error is observed once and stops recovery', async t => {
  const f = prepare(t)
  const source = lane(f)
  const command = [...f.command]
  command[0] = join(f.root, 'nonexistent-node')
  const run = () => runSupervisor({ ...source, command, home: f.home, profile: f.profile, version: FROM,
    env: f.env, fetch: () => assert.fail('rollback is offline'), healthTimeout: 300 })
  assert.equal(await run(), 1)
  const first = read(f.state)
  assert.equal(first.phase, 'manualRecovery')
  assert.equal(first.reason, 'health-failed')
  assert.equal(first.rollback.previousFailed, 'exited')
  assert.equal(first.rollback.failures, 1)
  assert.equal(first.rollback.starts, 1)
  assert.equal(await run(), 1)
  assert.equal(read(f.state).rollback.starts, 1)
})

test('a missing team home can be recreated from the saved roster', async t => {
  const f = prepare(t)
  fs.rmSync(f.botsHome, { recursive: true })
  const run = read(f.state)
  await restoreData(f.config, run, saveTo(run))
  assert.deepEqual(run.rollback.data, { restored: true, why: 'team-lost', trialKept: false })
  assert.deepEqual(read(f.path), originalTeam)
})

test('a cut after writing the live team but before the restore save recognizes the restored bytes', async t => {
  const f = prepare(t)
  const run = read(f.state)
  await assert.rejects(restoreData(f.config, run, changes => {
    if (changes.journal.restored) throw cutError
    Object.assign(run, changes)
  }), error => error === cutError)
  assert.deepEqual(read(f.path), originalTeam)
  assert.equal(run.journal.restored, undefined)
  assert.ok(run.journal.restore)
  const trialCopy = join(f.backup, 'trial-bots-state.json')
  assert.deepEqual(read(trialCopy), trialTeam)
  await restoreData(f.config, run, saveTo(run))
  assert.deepEqual(read(f.path), originalTeam)
  assert.deepEqual(read(trialCopy), trialTeam)
  assert.equal(run.journal.restored, true)
})


test('an unreadable trial team is retained when health already observed team loss', async t => {
  const original = { version: 2, revision: 7, bots: { ada: {} } }
  const f = prepare(t, { originalTeam: original })
  fs.writeFileSync(f.path, '{')
  const run = read(f.state)
  run.rollback.teamMissing = true
  await restoreData(f.config, run, saveTo(run))
  assert.deepEqual(run.rollback.data, { restored: true, trialKept: true, why: 'team-lost' })
  assert.deepEqual(read(f.path), original)
  assert.equal(fs.readFileSync(join(f.backup, 'trial-bots-state.json'), 'utf8'), '{')
})


test('observed team loss restores the snapshot even if an equal-revision team appears', async t => {
  const f = prepare(t, { originalTeam: { ...originalTeam, revision: 1 } })
  const replacement = { version: 1, revision: 1, bots: {} }
  write(f.path, replacement)
  const run = read(f.state)
  run.rollback.teamMissing = true
  await restoreData(f.config, run, saveTo(run))
  assert.deepEqual(run.rollback.data, { restored: true, trialKept: true, why: 'team-lost' })
  assert.deepEqual(read(f.path), { ...originalTeam, revision: 1 })
  assert.deepEqual(read(join(f.backup, 'trial-bots-state.json')), replacement)
})

test('a descended empty roster and malformed bytes without loss evidence stay in place', async t => {
  const original = { version: 2, revision: 7, bots: { ada: {} } }
  for (const [bytes, why] of [[JSON.stringify({ version: 2, revision: 8, bots: {} }), 'same-format'], ['{', 'unknown']]) {
    const f = prepare(t, { originalTeam: original })
    fs.writeFileSync(f.path, bytes)
    const run = read(f.state)
    if (why === 'unknown') {
      await assert.rejects(restoreData(f.config, run, saveTo(run)), /unknown/)
      assert.equal(run.rollback.data, undefined)
    } else {
      await restoreData(f.config, run, saveTo(run))
      assert.deepEqual(run.rollback.data, { restored: false, why, trialKept: false })
    }
    assert.equal(fs.readFileSync(f.path, 'utf8'), bytes)
  }
})

test('a manifest changed after rollback preparation leaves the candidate and current record live', async t => {
  const f = prepare(t, { committed: true })
  const scratch = prepare(t, { committed: true })
  const { checkpoints } = await rollback(scratch)
  const cutAt = checkpoints.lastIndexOf('save:rollingBack:manifest') + 1
  assert.ok(cutAt > 0)
  const cut = await rollback(f, { cutAt })
  assert.ok(cut.run.rollback.manifestHash)
  const path = join(f.profileDir, 'package.json')
  const live = read(path)
  live.dependencies['custom-plugin'] = '^2.0.0'
  write(path, live)

  const result = await rollback(f)
  assert.equal(result.run.phase, 'manualRecovery')
  assert.equal(result.run.reason, 'rollback-failed')
  assert.equal(result.run.rollback.step, 'manifest')
  assert.deepEqual(result.run.rollback.tried, [])
  assert.equal(versionAt(f), TO)
  assert.deepEqual(read(path), live)
  assert.deepEqual(read(f.current), nextCurrent)
})
