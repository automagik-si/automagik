import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { SUPERVISOR_FILES } from '../src/host/supervisor/copy.js'
import { stageInstall, takeProfileLock, VENDOR } from '../src/host/supervisor/stage.js'
import { completeSwitch, planSwitch } from '../src/host/supervisor/switch.js'
import { writeJsonAtomic } from '../src/host/supervisor/store.js'
import { BOTS, eventsOf, fixture, FROM, HOST, lane, putDownloads, read, RUN_ID, TO, write } from './fixtures/supervisor.mjs'

const DRIVER = fileURLToPath(new URL('./fixtures/supervisor-driver.mjs', import.meta.url))
const stateOf = f => read(join(f.store, 'state.json'))
const supervisorOf = f => read(join(f.store, 'supervisor.json'))
const opts = f => ['--dsh-home', f.home, '--profile', f.profile]

function launch(t, bin, args, env) {
  const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  let closed = false
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      closed = true
      resolve({ code, signal, stdout, stderr })
    })
  })
  t.after(async () => {
    if (!closed) child.kill('SIGTERM')
    await exit
  })
  return { child, exit, stdout: () => stdout, stderr: () => stderr }
}

async function until(get, message) {
  for (let i = 0; i < 400; i++) {
    const value = get()
    if (value) return value
    await wait(25)
  }
  assert.fail(message)
}

async function setup(t, f) {
  const installed = join(f.profileDir, 'node_modules', BOTS)
  const host = join(installed, 'src/host')
  fs.mkdirSync(join(host, 'supervisor'), { recursive: true })
  for (const file of [...SUPERVISOR_FILES, 'supervisor/launcher.sh']) {
    fs.copyFileSync(join(HOST, file), join(host, file))
  }
  const manifest = join(installed, 'package.json')
  write(manifest, { ...read(manifest), type: 'module' })
  const cli = launch(t, process.execPath, [join(host, 'supervisor/main.js'), 'install-copy', ...opts(f)], f.env)
  const result = await cli.exit
  assert.equal(result.code, 0, result.stderr)
  const launcher = result.stdout.trim()
  const current = join(f.store, 'supervisor/current')
  assert.equal(read(join(current, 'version.json')).version, FROM)
  for (const file of SUPERVISOR_FILES) assert.ok(fs.existsSync(join(current, file)), file)
  const check = launch(t, process.execPath, [join(current, 'supervisor/main.js'), '--self-check'], f.env)
  assert.equal((await check.exit).code, 0)
  return launcher
}

function request(f, overrides = {}) {
  const value = {
    version: 1, requestId: 'owner-request', bootId: supervisorOf(f).bootId, requestedAt: new Date().toISOString(),
    ...overrides,
  }
  writeJsonAtomic(join(f.store, 'request.json'), value, { profileDir: f.profileDir })
}

function driver(t, f) {
  // One signed lane per fixture: a second driver must not re-sign the file the first one trusts.
  const signed = f.signed ??= lane(f)
  const options = {
    home: f.home, profile: f.profile, command: f.command, version: FROM, laneUrl: signed.laneUrl, keys: signed.keys,
    tarballs: [...f.tarballs].map(([url, bytes]) => [url, bytes.toString('base64')]),
  }
  return launch(t, process.execPath, [DRIVER], { ...f.env, SUPERVISOR_DRIVER: JSON.stringify(options) })
}

const boots = f => eventsOf(f).filter(item => item.event === 'boot')

test('the fixed launcher checks each copy, falls back to bare DSH, and preserves the original argv', async t => {
  const f = fixture(t, { mode: 'exit' })
  writeJsonAtomic(join(f.store, 'update.lock'), { pid: 2147483647, host: hostname(), startedAt: Date.now() }, {
    profileDir: f.profileDir,
  })
  const launcher = await setup(t, f)
  const current = join(f.store, 'supervisor/current')
  const kept = join(f.store, 'supervisor/kept')
  fs.cpSync(current, kept, { recursive: true })
  fs.writeFileSync(join(current, 'supervisor/main.js'), 'broken {')
  const wrapped = launch(t, 'sh', [launcher, ...opts(f), '--', ...f.command], f.env)
  const wrappedResult = await wrapped.exit
  assert.equal(wrappedResult.code, 23, wrappedResult.stderr)
  const [first] = boots(f)
  assert.match(first.boot, /^sup_[a-f0-9-]+$/)
  assert.equal(first.boot, supervisorOf(f).bootId)
  assert.equal(first.version, read(join(current, 'version.json')).version)
  assert.equal(first.home, f.home)
  assert.deepEqual(first.args, f.command.slice(3))
  assert.equal(fs.existsSync(join(f.store, 'update.lock')), false)

  fs.writeFileSync(join(kept, 'supervisor/main.js'), 'broken {')
  const bare = launch(t, 'sh', [launcher, ...opts(f), '--', ...f.command], f.env)
  assert.equal((await bare.exit).code, 23)
  assert.deepEqual(boots(f).at(-1), { event: 'boot', args: f.command.slice(3), home: f.home })
})

test('a boot-bound request updates once, keeps the old version and rotates the supervisor copy', async t => {
  const f = fixture(t)
  const launcher = await setup(t, f)
  const running = driver(t, f)
  await until(() => running.stdout().includes('token=x'), 'fake child did not announce its launch URL')
  assert.deepEqual(supervisorOf(f), { version: 1, bootId: boots(f)[0].boot, runId: null })
  const competing = await driver(t, f).exit
  assert.equal(competing.code, 1)
  assert.match(competing.stderr, /already has a supervisor/)
  assert.equal(boots(f).length, 1)

  const earlier = join(f.store, 'versions', '3.160.1')
  fs.mkdirSync(earlier, { recursive: true })
  writeJsonAtomic(join(f.store, 'current.json'), {
    version: 1, live: { version: FROM, sequence: 41 }, kept: { version: '3.160.1' }, lastSequence: 41,
  }, { profileDir: f.profileDir })

  for (const invalid of [
    { bootId: 'another-boot' }, { requestedAt: new Date(Date.now() - 61_000).toISOString() },
    { url: 'a request cannot pick the release' },
  ]) {
    request(f, invalid)
    await until(() => !fs.existsSync(join(f.store, 'request.json')), 'rejected request was not cleared')
    assert.equal(fs.existsSync(join(f.store, 'state.json')), false)
  }
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'update did not become healthy')
  const currentVersion = join(f.store, 'supervisor/current/version.json')
  await until(() => fs.existsSync(currentVersion) && read(currentVersion).version === TO, 'supervisor copy was not refreshed')
  const state = stateOf(f)
  assert.equal(state.requestId, 'owner-request')
  assert.equal(state.startedBy, 'owner-route')
  assert.equal(state.bootId, supervisorOf(f).bootId)
  assert.equal(state.runId, supervisorOf(f).runId)
  assert.equal(state.from, FROM)
  assert.equal(state.to, TO)
  assert.deepEqual(state.journal.steps, state.journal.done)
  assert.equal(state.journal.keep, `versions/${FROM}`)
  assert.deepEqual(read(join(f.store, 'current.json')), {
    version: 1, live: { version: TO, sequence: 42 }, kept: { version: FROM }, lastSequence: 42,
  })
  assert.deepEqual(read(join(f.store, 'supervisor/kept/version.json')), { version: FROM })
  assert.ok(fs.existsSync(launcher))
  assert.equal(fs.existsSync(earlier), false)
  assert.equal(fs.existsSync(join(f.store, `stage-${state.runId}`)), false)
  assert.equal(eventsOf(f).filter(event => event.event === 'add').length, 1)
  assert.equal(eventsOf(f).filter(event => event.event === 'install' && event.live).length, 1)
  assert.deepEqual(boots(f).map(event => [event.boot, event.version]), [[state.bootId, FROM], [state.bootId, FROM]])

  request(f)
  await until(() => !fs.existsSync(join(f.store, 'request.json')), 'duplicate request was not cleared')
  assert.equal(stateOf(f).runId, state.runId)
  running.child.kill('SIGHUP')
  assert.equal((await running.exit).code, 0)
  assert.equal(eventsOf(f).at(-1).signal, 'SIGHUP')
})

for (const [mode, phase, reason] of [
  ['lock-edit-while-staging', 'notUpdated', 'switch-refused'],
  ['relink-fails', 'notUpdated', 'stage-failed'],
  ['trial-exit', 'manualRecovery', 'health-failed'],
]) {
  test(`records ${phase} after ${mode}`, async t => {
    const f = fixture(t, { mode })
    const lockfile = join(f.profileDir, 'pnpm-lock.yaml')
    const manifest = join(f.profileDir, 'package.json')
    const originalLockfile = fs.readFileSync(lockfile)
    const originalManifest = fs.readFileSync(manifest)
    const originalArchive = fs.readFileSync(f.archive)
    const running = driver(t, f)
    await until(() => running.stdout().includes('token=x'), 'fake child did not start')
    request(f)
    await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === phase, 'missing verdict')
    assert.equal(stateOf(f).reason, reason)
    assert.equal(boots(f).length, 2)
    assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, phase === 'manualRecovery' ? TO : FROM)
    if (phase === 'manualRecovery') {
      assert.equal((await running.exit).code, 19)
      const next = driver(t, f)
      assert.equal((await next.exit).code, 1)
      assert.equal(boots(f).length, 2)
      assert.equal(stateOf(f).bootId, supervisorOf(f).bootId)
    } else {
      assert.equal(fs.existsSync(join(f.store, `stage-${stateOf(f).runId}`)), false, 'staging still exists after notUpdated')
      if (mode === 'lock-edit-while-staging') assert.match(fs.readFileSync(lockfile, 'utf8'), /owner: edited/)
      if (mode === 'relink-fails') {
        assert.deepEqual(fs.readFileSync(lockfile), originalLockfile)
        assert.deepEqual(fs.readFileSync(manifest), originalManifest)
        assert.deepEqual(fs.readFileSync(f.archive), originalArchive)
        assert.deepEqual(fs.readdirSync(join(f.profileDir, VENDOR)), [basename(f.archive)])
        assert.equal(fs.readFileSync(join(f.profileDir, 'vendor/owner.tgz'), 'utf8'), 'owner archive')
        assert.equal(eventsOf(f).filter(event => event.event === 'install' && event.live).length, 1)
        assert.deepEqual(boots(f)[1], boots(f)[0])
      }
      running.child.kill('SIGTERM')
      assert.equal((await running.exit).code, 0)
    }
  })
}

for (const move of ['keep-lockfile', 'install-modules']) {
  test(`a new supervisor recovers an interrupted ${move} before the first child boot`, async t => {
    const f = fixture(t)
    const launcher = await setup(t, f)
    const release = await takeProfileLock(f.profileDir)
    try {
      await stageInstall(f.config, f.staging, putDownloads(f), f.versions)
      const run = {
        version: 1, runId: RUN_ID, bootId: 'sup_previous', requestId: 'owner-request',
        from: FROM, to: TO, names: [BOTS], sequence: 42, startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), phase: 'switching', reason: null,
      }
      run.journal = planSwitch(f.config, f.staging, run)
      const save = () => writeJsonAtomic(join(f.store, 'state.json'), run, { profileDir: f.profileDir, durable: true })
      assert.throws(() => completeSwitch(f.config, f.staging, run, save, step => {
        if (step === move) throw new Error('supervisor cut')
      }), /supervisor cut/)
    } finally { release() }

    const child = launch(t, 'sh', [launcher, ...opts(f), '--', ...f.command], f.env)
    const completed = move === 'install-modules'
    const phase = completed ? 'healthy' : 'notUpdated'
    await until(() => stateOf(f).phase === phase, child.stderr())
    assert.equal(stateOf(f).reason, completed ? 'health-check-finished' : 'supervisor-restarted')
    assert.equal(stateOf(f).runId, RUN_ID)
    assert.notEqual(stateOf(f).bootId, 'sup_previous')
    assert.equal(stateOf(f).bootId, supervisorOf(f).bootId)
    assert.equal(boots(f).length, 1)
    assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, completed ? TO : FROM)
    child.child.kill('SIGTERM')
    assert.equal((await child.exit).code, 0)
  })
}
