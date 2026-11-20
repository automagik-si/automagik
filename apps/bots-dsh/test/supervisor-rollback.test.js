import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runSupervisor } from '../src/host/supervisor/main.js'
import { finishRolledBack, restoreData, runRollback, teamSnapshot } from '../src/host/supervisor/rollback.js'
import { PROFILE_INPUTS, VENDOR } from '../src/host/supervisor/stage.js'
import { writeJsonAtomic } from '../src/host/supervisor/store.js'
import { completeSwitch, planSwitch, validTerminalJournal } from '../src/host/supervisor/switch.js'
import { BOTS, eventsOf, fixture, FROM, HOST, lane, read, RUN_ID, TO, write } from './fixtures/supervisor.mjs'

const now = new Date().toISOString()
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
  write(path, options.originalTeam ?? originalTeam)
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

  f.config.stateFormats = options.legacy ? undefined : [0, 1, 2]
  const run = {
    version: 1, phase: 'switching', reason: null, runId: RUN_ID, bootId: 'sup_fixture',
    from: FROM, to: TO, sequence: 42, names: [BOTS], startedAt: now, updatedAt: now,
    ...(!options.legacy ? { fromVersions: { [BOTS]: FROM }, priorCurrent } : {}),
  }
  run.journal = planSwitch(f.config, staging, run)
  completeSwitch(f.config, staging, run, () => {})
  if (options.contractMissing) fs.unlinkSync(join(kept, 'node_modules', BOTS, 'src/host/update-contract.json'))
  if (options.teamMissing) fs.unlinkSync(path)
  else write(path, options.legacy ? { version: 2, revision: 8, note: 'readable team' } : trialTeam)
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
      start: () => {
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

async function recoverThroughDriver(f) {
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
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { exited = true; resolve(code) })
  })
  try {
    for (let n = 0; n < 200 && !exited; n++) {
      const state = read(f.state)
      if (state.phase === 'rolledBack' && eventsOf(f).some(event => event.event === 'boot')) return state
      await wait(25)
    }
    assert.fail('recovered supervisor did not serve FROM: ' + fs.readFileSync(stderrPath, 'utf8'))
  } finally {
    if (!exited) child.kill('SIGTERM')
    assert.equal(await exit, 0, fs.readFileSync(stderrPath, 'utf8'))
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
  ['unparsable', '{', { restored: false, why: 'unknown', trialKept: false }],
  ['missing', undefined, { restored: true, why: 'team-lost', trialKept: false }],
]) {
  test('team restore handles ' + caseName + ' trial data', t => {
    const f = prepare(t)
    if (trial === undefined) fs.unlinkSync(f.path)
    else if (typeof trial === 'string') fs.writeFileSync(f.path, trial)
    else write(f.path, trial)
    const run = read(f.state)
    restoreData(f.config, run, changes => Object.assign(run, changes))
    assert.deepEqual(run.rollback.data, data)
    if (data.restored) assert.deepEqual(read(f.path), originalTeam)
    else if (typeof trial === 'string') assert.equal(fs.readFileSync(f.path, 'utf8'), trial)
    else assert.deepEqual(read(f.path), trial)
  })
}

test('restore takes the writer lock and preserves a live peer\'s team', t => {
  const f = prepare(t)
  write(join(f.botsHome, 'state.lock'), { token: 'other', host: hostname(), pid: process.ppid })
  const run = read(f.state)
  restoreData(f.config, run, changes => Object.assign(run, changes))
  assert.deepEqual(run.rollback.data, { restored: false, why: 'team-in-use', trialKept: false })
  assert.deepEqual(read(f.path), trialTeam)
})

for (const modified of ['none', 'trial', 'snapshot', 'previous-after-completion']) {
  test('replays restore intent safely with ' + modified + ' changes', t => {
    const f = prepare(t)
    const run = read(f.state)
    assert.throws(() => restoreData(f.config, run, changes => {
      Object.assign(run, changes)
      throw cutError
    }), error => error === cutError)
    assert.equal(run.journal.restored, undefined)
    assert.ok(run.journal.restore)
    const update = { version: 2, note: 'new edit' }
    if (modified === 'trial') write(f.path, update)
    if (modified === 'snapshot') write(teamSnapshot(f.config, run).saved, update)
    const save = changes => Object.assign(run, changes)
    restoreData(f.config, run, save)
    if (modified === 'previous-after-completion') {
      write(f.path, update)
      restoreData(f.config, run, save)
      assert.deepEqual(read(f.path), update)
    } else {
      assert.deepEqual(read(f.path), modified === 'trial' ? update : modified === 'snapshot' ? trialTeam : originalTeam)
    }
    assert.deepEqual(run.rollback.data, modified === 'trial' ? { restored: false, why: 'superseded', trialKept: false }
      : modified === 'snapshot' ? { restored: false, why: 'snapshot-changed', trialKept: false } : { restored: true, trialKept: true })
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

  const terminal = await recoverThroughDriver(f)
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

test('a missing team home can be recreated from the saved roster', t => {
  const f = prepare(t)
  fs.rmSync(f.botsHome, { recursive: true })
  const run = read(f.state)
  restoreData(f.config, run, changes => Object.assign(run, changes))
  assert.deepEqual(run.rollback.data, { restored: true, why: 'team-lost', trialKept: false })
  assert.deepEqual(read(f.path), originalTeam)
})

test('a cut after writing the live team but before the restore save recognizes the restored bytes', t => {
  const f = prepare(t)
  const run = read(f.state)
  assert.throws(() => restoreData(f.config, run, changes => {
    if (changes.journal.restored) throw cutError
    Object.assign(run, changes)
  }), error => error === cutError)
  assert.deepEqual(read(f.path), originalTeam)
  assert.equal(run.journal.restored, undefined)
  assert.ok(run.journal.restore)
  const trialCopy = join(f.backup, 'trial-bots-state.json')
  assert.deepEqual(read(trialCopy), trialTeam)
  restoreData(f.config, run, changes => Object.assign(run, changes))
  assert.deepEqual(read(f.path), originalTeam)
  assert.deepEqual(read(trialCopy), trialTeam)
  assert.equal(run.journal.restored, true)
})


test('an unreadable trial team is retained when health already observed team loss', t => {
  const original = { version: 2, revision: 7, bots: { ada: {} } }
  const f = prepare(t, { originalTeam: original })
  fs.writeFileSync(f.path, '{')
  const run = read(f.state)
  run.rollback.teamMissing = true
  restoreData(f.config, run, changes => Object.assign(run, changes))
  assert.deepEqual(run.rollback.data, { restored: true, trialKept: true, why: 'team-lost' })
  assert.deepEqual(read(f.path), original)
  assert.equal(fs.readFileSync(join(f.backup, 'trial-bots-state.json'), 'utf8'), '{')
})


test('observed team loss restores the snapshot even if an equal-revision team appears', t => {
  const f = prepare(t, { originalTeam: { ...originalTeam, revision: 1 } })
  const replacement = { version: 1, revision: 1, bots: {} }
  write(f.path, replacement)
  const run = read(f.state)
  run.rollback.teamMissing = true
  restoreData(f.config, run, changes => Object.assign(run, changes))
  assert.deepEqual(run.rollback.data, { restored: true, trialKept: true, why: 'team-lost' })
  assert.deepEqual(read(f.path), { ...originalTeam, revision: 1 })
  assert.deepEqual(read(join(f.backup, 'trial-bots-state.json')), replacement)
})

test('a descended empty roster and malformed bytes without loss evidence stay in place', t => {
  const original = { version: 2, revision: 7, bots: { ada: {} } }
  for (const [bytes, why] of [[JSON.stringify({ version: 2, revision: 8, bots: {} }), 'same-format'], ['{', 'unknown']]) {
    const f = prepare(t, { originalTeam: original })
    fs.writeFileSync(f.path, bytes)
    const run = read(f.state)
    restoreData(f.config, run, changes => Object.assign(run, changes))
    assert.deepEqual(run.rollback.data, { restored: false, why, trialKept: false })
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
