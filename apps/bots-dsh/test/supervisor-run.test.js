import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createUpdateHold, install as installUpdateHold } from '../src/host/self-update-hold.js'
import { install as installSelfUpdate, selfUpdateStatus } from '../src/host/self-update.js'
import { LISTENER_UNKNOWN } from '../src/host/supervisor/child.js'
import { selfUpdateCheck } from '../src/host/self-update-check.js'
import { refreshCopy, reinstallCopies, runningCopy, SELF_CHECK_OK, SUPERVISOR_FILES } from '../src/host/supervisor/copy.js'
import { stageInstall, takeProfileLock, VENDOR } from '../src/host/supervisor/stage.js'
import { completeSwitch, planSwitch } from '../src/host/supervisor/switch.js'
import { writeJsonAtomic } from '../src/host/supervisor/store.js'
import { batch, bootstrap, shell } from './fixtures/supervisor-health-wire.mjs'
import { BOTS, digest, eventsOf, fixture, FROM, HOST, lane, putDownloads, read, RUN_ID, TO, WELCOME, write } from './fixtures/supervisor.mjs'

const DRIVER = fileURLToPath(new URL('./fixtures/supervisor-driver.mjs', import.meta.url))
const stateOf = f => read(join(f.store, 'state.json'))
const whole = path => {
  try { return read(path) } catch (error) { if (error instanceof SyntaxError) return undefined; throw error }
}
const supervisorOf = f => read(join(f.store, 'supervisor.json'))
const opts = f => ['--dsh-home', f.home, '--profile', f.profile]

function launch(t, bin, args, env, detached = false) {
  const logs = fs.mkdtempSync(join(tmpdir(), 'supervisor-logs-'))
  const stdout = join(logs, 'stdout')
  const stderr = join(logs, 'stderr')
  const out = fs.openSync(stdout, 'w')
  const err = fs.openSync(stderr, 'w')
  let child
  try {
    child = spawn(bin, args, { env, detached, stdio: ['ignore', out, err] })
  } finally {
    fs.closeSync(out)
    fs.closeSync(err)
  }
  let closed = false
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      closed = true
      resolve({ code, signal, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') })
    })
  })
  t.after(async () => {
    if (!closed) child.kill('SIGTERM')
    try { await exit } finally { fs.rmSync(logs, { recursive: true, force: true }) }
  })
  return { child, exit, stdout: () => fs.readFileSync(stdout, 'utf8'), stderr: () => fs.readFileSync(stderr, 'utf8') }
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
  const checkResult = await check.exit
  assert.equal(checkResult.code, 0)
  assert.equal(checkResult.stdout.trim(), SELF_CHECK_OK)
  return launcher
}

function request(f, overrides = {}) {
  const value = {
    version: 1, requestId: 'owner-request', bootId: supervisorOf(f).bootId, requestedAt: new Date().toISOString(),
    ...overrides,
  }
  writeJsonAtomic(join(f.store, 'request.json'), value, { profileDir: f.profileDir })
}

function driver(t, f, imageHost) {
  // One signed lane per fixture: a second driver must not re-sign the file the first one trusts.
  const signed = f.signed ??= lane(f)
  const options = {
    home: f.home, profile: f.profile, command: f.command, version: FROM, laneUrl: signed.laneUrl, keys: signed.keys,
    tarballs: [...f.tarballs].map(([url, bytes]) => [url, bytes.toString('base64')]), imageHost,
  }
  return launch(t, process.execPath, [DRIVER], { ...f.env, SUPERVISOR_DRIVER: JSON.stringify(options) },
    f.env.SUPERVISOR_CUT_AFTER !== undefined)
}

const boots = f => eventsOf(f).filter(item => item.event === 'boot')
const announced = running => running.stdout().includes('token=<redacted>')
const pinsFor = f => Object.fromEntries(f.release.map(item => [item.name, `file:${VENDOR}/${item.sha256}.tgz`]))

function imageDriver(t, f, mode = 'normal') {
  // Delivery 6's fake health transport, on the announce-only fake DSH.
  fakeTransport(f)
  f.env.SUPERVISOR_IMAGE_HOOKS = '1'
  return driver(t, f, mode)
}

async function unusedLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('the fixed launcher checks each copy, falls back to bare DSH, and preserves the original argv', async t => {
  const f = fixture(t, { mode: 'exit' })
  writeJsonAtomic(join(f.store, 'update.lock'), { pid: 2147483647, host: hostname(), startedAt: Date.now() }, {
    profileDir: f.profileDir,
  })
  const launcher = await setup(t, f)
  const current = join(f.store, 'supervisor/current')
  const kept = join(f.store, 'supervisor/kept')
  fs.cpSync(current, kept, { recursive: true })
  fs.writeFileSync(join(current, 'supervisor/main.js'), '')
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
  const bare = launch(t, 'sh', [launcher, ...opts(f), '--', ...f.command], { ...f.env, SUPERVISOR_MODE: 'bare-announces' })
  const bareResult = await bare.exit
  assert.equal(bareResult.code, 23)
  assert.equal(bareResult.stdout, 'dsh web: https://example.invalid/?token=REDACTED&next=ok\n')
  assert.equal(bareResult.stderr, 'diagnostic token=REDACTED\n')
  assert.deepEqual(boots(f).at(-1), { event: 'boot', args: f.command.slice(3), home: f.home })
})

test('a boot-bound request updates once, keeps the old version and rotates the supervisor copy', async t => {
  const f = fixture(t)
  const launcher = await setup(t, f)
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not announce its launch URL')
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
    entries: pinsFor(f), base: { [BOTS]: f.manifest.dependencies[BOTS] },
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
  const stopped = await running.exit
  assert.equal(stopped.code, 0)
  assert.match(stopped.stdout, /token=<redacted>&access_token=<redacted>/)
  assert.match(stopped.stderr, /token=<redacted> https:\/\/example.invalid\/\?api_key=<redacted>/)
  for (const secret of ['stdout-secret', 'stderr-secret', 'query-secret', 'access-secret']) {
    assert.ok(!stopped.stdout.includes(secret))
    assert.ok(!stopped.stderr.includes(secret))
  }
  assert.equal(eventsOf(f).at(-1).signal, 'SIGHUP')
})

for (const [mode, phase, reason] of [
  ['lock-edit-while-staging', 'notUpdated', 'switch-refused'],
  ['relink-fails', 'notUpdated', 'stage-failed'],
  ['compatibility-repair', 'notUpdated', 'stage-failed'],
  ['relink-staged-symlink', 'notUpdated', 'stage-failed'],
  ['trial-exit', 'rolledBack', 'health-failed'],
]) {
  test(`records ${phase} after ${mode}`, async t => {
    const f = fixture(t, { mode })
    if (mode === 'trial-exit') fakeTransport(f)
    const lockfile = join(f.profileDir, 'pnpm-lock.yaml')
    const manifest = join(f.profileDir, 'package.json')
    const originalLockfile = fs.readFileSync(lockfile)
    const originalManifest = fs.readFileSync(manifest)
    const originalArchive = fs.readFileSync(f.archive)
    const running = driver(t, f)
    await until(() => announced(running), 'fake child did not start')
    request(f)
    await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === phase, 'missing verdict')
    assert.equal(stateOf(f).reason, reason)
    assert.equal(boots(f).length, phase === 'rolledBack' ? 3 : 2)
    assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, FROM)
    if (phase === 'rolledBack') {
      assert.equal(stateOf(f).rollback.failed, 'exited')
      assert.equal(fs.existsSync(join(f.store, 'current.json')), false)
      running.child.kill('SIGTERM')
      assert.equal((await running.exit).code, 0)
    } else {
      assert.equal(fs.existsSync(join(f.store, `stage-${stateOf(f).runId}`)), false, 'staging still exists after notUpdated')
      if (mode === 'lock-edit-while-staging') assert.match(fs.readFileSync(lockfile, 'utf8'), /owner: edited/)
      if (mode === 'compatibility-repair') {
        assert.equal(fs.readFileSync(join(f.root, 'repair-inherited-restrictions'), 'utf8'), 'yes')
      }
      if (mode.startsWith('relink-') || mode === 'compatibility-repair') {
        assert.deepEqual(fs.readFileSync(lockfile), originalLockfile)
        assert.deepEqual(fs.readFileSync(manifest), originalManifest)
        assert.deepEqual(fs.readFileSync(f.archive), originalArchive)
        assert.deepEqual(fs.readdirSync(join(f.profileDir, VENDOR)), [basename(f.archive)])
        assert.equal(fs.readFileSync(join(f.profileDir, 'vendor/owner.tgz'), 'utf8'), 'owner archive')
        assert.equal(eventsOf(f).filter(event => event.event === 'install' && event.live).length, 1)
        assert.deepEqual(boots(f)[1], boots(f)[0])
        assert.equal(fs.existsSync(join(f.profileDir, 'node_modules/invalid-link')), false)
        assert.ok(eventsOf(f).some(event => event.event === 'probe'))
      }
      running.child.kill('SIGTERM')
      assert.equal((await running.exit).code, 0)
    }
  })
}

test('manual recovery keeps the snapshot when the renamed-back child also fails', async t => {
  const f = fixture(t, { mode: 'rollback-unhealthy' })
  fakeTransport(f)
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  request(f)
  const stopped = await running.exit
  assert.equal(stopped.code, 1)
  const state = stateOf(f)
  assert.equal(state.phase, 'manualRecovery')
  assert.equal(state.reason, 'health-failed')
  assert.equal(state.rollback.failed, 'exited')
  assert.equal(state.rollback.previousFailed, 'port')
  assert.deepEqual(state.rollback.tried, ['rename-back', 'restart', 'health'])
  assert.deepEqual(state.rollback.location.modules, { previous: 'live', candidate: 'staging' })
  assert.match(stopped.stderr, /node_modules previous=live, candidate=staging/)
  assert.equal(boots(f).length, 3)
  assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, FROM)
  assert.ok(fs.existsSync(join(f.store, 'versions', FROM, 'data', 'bots-state.json')))
  assert.ok(fs.existsSync(join(f.store, 'stage-' + state.runId)))
  const next = driver(t, f)
  assert.equal((await next.exit).code, 1)
  assert.equal(boots(f).length, 3)
  assert.equal(stateOf(f).bootId, supervisorOf(f).bootId)
})

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


test('bare launcher fallback refuses unsafe or unreadable state and permits completed terminal state', async t => {
  const f = fixture(t, { mode: 'exit' })
  const launcher = join(f.store, 'supervisor/launcher.sh')
  const main = join(f.store, 'supervisor/current/supervisor/main.js')
  fs.mkdirSync(join(main, '..'), { recursive: true })
  fs.copyFileSync(join(HOST, 'supervisor/launcher.sh'), launcher)
  fs.writeFileSync(main, '')
  const state = join(f.store, 'state.json')
  const bare = async () => {
    const output = join(f.root, 'launcher.stderr')
    const fd = fs.openSync(output, 'w')
    let child
    try {
      child = spawn('sh', [launcher, ...opts(f), '--', ...f.command], { env: f.env, stdio: ['ignore', 'ignore', fd] })
    } finally { fs.closeSync(fd) }
    const code = await new Promise((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    return { code, stderr: fs.readFileSync(output, 'utf8') }
  }
  const steps = ['keep-modules', 'keep-archive:' + 'a'.repeat(64) + '.tgz',
    'keep-lockfile', 'install-lockfile', 'install-entries', 'install-modules']
  const completed = { op: 'switch', pending: null, steps, done: steps }
  const undone = { ...completed, undo: true, done: [] }
  for (const raw of [
    '{malformed', JSON.stringify({ version: 1, phase: 'switching' }),
    JSON.stringify({ version: 1, phase: 'manualRecovery' }),
    JSON.stringify({ version: 1, phase: 'healthy', journal: { ...completed, pending: 'keep-modules' } }),
    JSON.stringify({ version: 1, phase: 'notUpdated', journal: { ...completed, done: [] } }),
    JSON.stringify({ version: 1, phase: 'notUpdated', journal: completed }),
    JSON.stringify({ version: 1, phase: 'rolledBack', journal: completed }),
    JSON.stringify({ version: 1, phase: 'healthy', journal: undone }),
    JSON.stringify({ version: 1, phase: 'healthy', journal: { ...completed, steps: ['keep-modules'], done: ['keep-modules'] } }),
  ]) {
    fs.writeFileSync(state, raw)
    const result = await bare()
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stderr, /^automagik supervisor: .*state\.json\n$/)
    assert.equal(boots(f).length, 0)
  }
  fs.unlinkSync(state)
  fs.symlinkSync(join(f.root, 'missing'), state)
  assert.equal((await bare()).code, 1)
  assert.equal(boots(f).length, 0)
  fs.unlinkSync(state)
  write(state, { version: 1, phase: 'healthy', journal: completed })
  assert.equal((await bare()).code, 23)
  assert.equal(boots(f).length, 1)
  write(state, { version: 1, phase: 'rolledBack', journal: undone })
  assert.equal((await bare()).code, 23)
  assert.equal(boots(f).length, 2)
})

test('a public launch URL stays separate from authenticated local health probes', async t => {
  const f = fixture(t)
  const port = await unusedLoopbackPort()
  const publicUrl = 'https://example.invalid/web/'
  f.command.splice(f.command.indexOf('--host'), 4, '--port=' + port, '--public-url', publicUrl)
  const running = driver(t, f)
  await until(() => announced(running), 'DSH did not announce its public URL')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'local listener was not healthy')
  assert.ok(running.stdout().includes(publicUrl + '?token=<redacted>'))
  assert.deepEqual(eventsOf(f).filter(event => event.event === 'probe'), [
    ...['/', '/', '/?token=<redacted>'].map(url => ({ event: 'probe', url, host: '127.0.0.1:' + port })),
    ...['self-update-status', 'state'].map(endpoint => ({
      event: 'probe', url: '/api/omni-ui', host: '127.0.0.1:' + port, endpoint, health: true,
    })),
    ...['/', batch, bootstrap, shell].map(url => ({ event: 'probe', url, host: '127.0.0.1:' + port })),
  ])
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
})

test('an unexpected signal exit is a supervisor failure', async t => {
  const f = fixture(t, { mode: 'signal-death' })
  const result = await driver(t, f).exit
  assert.equal(result.code, 137, result.stderr)
  assert.equal(result.signal, null)
  assert.equal(boots(f).length, 1)
})

test('a forwarded service stop exits successfully even if DSH exits non-zero', async t => {
  const f = fixture(t, { mode: 'signal-forward' })
  const running = driver(t, f)
  await until(() => eventsOf(f).some(event => event.event === 'waiting-for-signal'), 'DSH signal handlers were not ready')
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
  assert.equal(eventsOf(f).at(-1).signal, 'SIGTERM')
})

for (const mode of ['pre-switch-unhealthy', 'restored-unhealthy']) {
  test('requires serving HTTP before giving work back after ' + mode, async t => {
    const f = fixture(t, { mode })
    const running = driver(t, f)
    await until(() => announced(running), 'DSH did not start')
    if (mode === 'pre-switch-unhealthy') fs.appendFileSync(f.signed.path, '\n')
    request(f)
    assert.equal((await running.exit).code, 1)
    const state = stateOf(f)
    assert.equal(state.phase, 'manualRecovery')
    assert.equal(state.reason, 'health-failed')
    assert.equal(boots(f).length, mode === 'pre-switch-unhealthy' ? 1 : 2)
    assert.ok(eventsOf(f).some(event => event.event === 'probe'))
    assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, FROM)
    if (mode === 'restored-unhealthy') {
      assert.equal(state.journal.undo, true)
      assert.deepEqual(state.journal.done, [])
    } else {
      assert.equal(state.journal, undefined)
    }
  })
}

async function interruptedCandidate(f, edit = () => {}) {
  await stageInstall(f.config, f.staging, putDownloads(f), f.versions)
  const run = {
    version: 1, runId: RUN_ID, bootId: 'sup_previous', requestId: 'owner-request',
    from: FROM, to: TO, names: [BOTS], sequence: 42, startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), phase: 'switching', reason: null,
  }
  const save = () => writeJsonAtomic(join(f.store, 'state.json'), run, { profileDir: f.profileDir, durable: true })
  run.journal = planSwitch(f.config, f.staging, run)
  completeSwitch(f.config, f.staging, run, save)
  edit(run)
  save()
}

for (const cut of ['after intent', 'after current.json', 'legacy current.json', 'after current.json in the image', 'after intent in the image']) {
  test('finishes the version-record commit ' + cut + ' without relinking again', async t => {
    const f = fixture(t, { mode: 'relink-fails' })
    const previous = { version: 1, live: { version: FROM, sequence: 41 }, kept: null, lastSequence: 41 }
    const next = { version: 1, live: { version: TO, sequence: 42 }, kept: { version: FROM }, lastSequence: 42 }
    const current = join(f.store, 'current.json')
    const inImage = cut.endsWith('in the image')
    const afterIntent = cut.startsWith('after intent')
    const base = { [BOTS]: inImage && !afterIntent ? 'file:vendor/image-bots.tgz' : f.manifest.dependencies[BOTS] }
    const committed = { ...next, entries: pinsFor(f), base }
    write(current, afterIntent ? previous : inImage ? committed : next)
    await interruptedCandidate(f, run => {
      run.phase = 'health'
      run.journal.relinking = true
      if (cut !== 'legacy current.json') run.journal.commitCurrent = true
    })
    if (inImage) fs.unlinkSync(join(f.staging.profileDir, 'package.json'))
    const running = inImage ? imageDriver(t, f) : driver(t, f)
    await until(() => stateOf(f).phase === 'healthy', 'version-record recovery did not finish')
    assert.deepEqual(read(current), committed)
    assert.equal(stateOf(f).journal.commitCurrent, true)
    assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, TO)
    assert.equal(eventsOf(f).filter(event => event.event === 'install' && event.live).length, 0)
    assert.equal(boots(f).length, 1)
    running.child.kill(inImage ? 'SIGINT' : 'SIGTERM')
    assert.equal((await running.exit).code, inImage ? 1 : 0)
  })
}

test('discards a distinct boot-bound request posted during recovery', async t => {
  const f = fixture(t, { mode: 'relink-paused' })
  await interruptedCandidate(f)
  const running = driver(t, f)
  await until(() => eventsOf(f).some(event => event.event === 'install' && event.live), 'recovery did not enter relink')
  assert.notEqual(supervisorOf(f).bootId, 'sup_previous')
  request(f, { requestId: 'during-recovery' })
  assert.equal(read(join(f.store, 'request.json')).requestId, 'during-recovery')
  fs.writeFileSync(join(f.root, 'resume-relink'), '')
  await until(() => !fs.existsSync(join(f.store, 'request.json')), 'recovery request was not discarded')
  assert.equal(stateOf(f).phase, 'healthy')
  await wait(1200)
  assert.equal(stateOf(f).runId, RUN_ID)
  assert.equal(stateOf(f).requestId, 'owner-request')
  request(f, { requestId: 'after-recovery' })
  await until(() => stateOf(f).requestId === 'after-recovery' && stateOf(f).phase === 'notUpdated', 'idle request was not accepted')
  assert.equal(stateOf(f).reason, 'not-newer')
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
})

test('image callbacks run for each child and preserve the original base through a second update', async t => {
  const f = fixture(t)
  const first = imageDriver(t, f, 'throw-on-start')
  await until(() => announced(first), 'the initial image child did not announce')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'the image trial did not finish')
  assert.equal(fs.existsSync(join(f.store, 'supervisor')), false)
  const current = join(f.store, 'current.json')
  const base = { [BOTS]: f.manifest.dependencies[BOTS] }
  assert.deepEqual(read(current).entries, pinsFor(f))
  assert.deepEqual(read(current).base, base)
  const hooks = eventsOf(f).filter(event => event.event === 'image-start' || event.event === 'image-launch')
  assert.deepEqual(hooks, [1, 2].flatMap(index => [
    { event: 'image-start' }, { event: 'image-launch', url: `http://127.0.0.1:3080/?token=image-child-${index}` },
  ]))
  assert.equal(boots(f)[0].boot, boots(f)[1].boot)
  const notes = eventsOf(f).filter(event => event.event === 'image-line').map(event => event.line)
  assert.equal(notes.filter(line => line === 'diagnostic token=<redacted>').length, 2)
  assert.equal(notes.filter(line => line === 'dsh web: http://127.0.0.1:3080/?token=<redacted>').length, 2)
  await until(() => eventsOf(f).some(event => event.event === 'image-save' && event.phase === 'healthy'),
    'the image host did not receive the terminal save')
  const saves = eventsOf(f).filter(event => event.event === 'image-save')
  assert.equal(saves[0].phase, 'checking')
  assert.equal(saves.at(-1).phase, 'healthy')
  assert.ok(saves.every(event => event.matchesDisk))
  first.child.kill('SIGINT')
  const stopped = await first.exit
  assert.equal(stopped.code, 1)
  assert.match(stopped.stdout, /token=<redacted>/)
  assert.match(stopped.stderr, /diagnostic token=<redacted>/)
  assert.equal((stopped.stderr.match(/could not notify the host before starting DSH/g) ?? []).length, 2)
  assert.match(stopped.stderr, /could not notify the host of the saved update state/)
  assert.doesNotMatch(stopped.stderr, /private hook details|example\.invalid\/secret/)
  assert.doesNotMatch(stopped.stdout + stopped.stderr, /image-child-|image-diagnostic/)
  assert.equal(eventsOf(f).at(-1).signal, 'SIGTERM')

  const next = '3.160.4', bytes = Buffer.from('the second signed archive')
  const url = `https://github.com/example/fixture/releases/download/v${next}/bots-dsh.tgz`
  f.release = [{ ...f.release[0], url, version: next, size: bytes.length,
    sha256: digest('sha256', bytes), integrity: `sha512-${digest('sha512', bytes, 'base64')}` }]
  f.tarballs = new Map([[url, bytes]])
  f.env.SUPERVISOR_PACKAGES = JSON.stringify({ [f.release[0].sha256]: { name: BOTS, version: next } })
  f.signed = lane(f, pointer => { pointer.version = next; pointer.sequence = 43 })
  const second = imageDriver(t, f)
  await until(() => announced(second), 'the replacement supervisor did not start DSH')
  request(f)
  await until(() => stateOf(f).phase === 'healthy' && stateOf(f).to === next, 'the second update did not finish')
  assert.deepEqual(read(current), {
    version: 1, live: { version: next, sequence: 43 }, kept: { version: TO }, lastSequence: 43,
    entries: pinsFor(f), base,
  })
  second.child.kill('SIGINT')
  assert.equal((await second.exit).code, 1)
})

test('only the current child can publish a launch URL while the previous pipes drain', async t => {
  const f = fixture(t, { mode: 'retired-announcement' })
  const running = imageDriver(t, f)
  await until(() => boots(f).length === 1, 'initial child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'the image trial did not finish')
  // Both children's announcements and the retired child's late line reach stdout, redacted.
  await until(() => (running.stdout().match(/token=<redacted>/g)?.length ?? 0) === 3 &&
    running.stderr().includes('dsh web: http://127.0.0.1:3080/?token=<redacted>'), 'retired output did not drain')
  assert.deepEqual(eventsOf(f).filter(event => event.event === 'image-launch'), [
    { event: 'image-launch', url: 'http://127.0.0.1:3080/?token=image-child-1' },
    { event: 'image-launch', url: 'http://127.0.0.1:3080/?token=image-child-2' },
  ])
  running.child.kill('SIGINT')
  const result = await running.exit
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.stdout + result.stderr, /retired-(?:stdout|stderr)/)
})

test('an image candidate that fails health rolls back in process and the previous child publishes its own URL', async t => {
  const f = fixture(t, { mode: 'trial-sign-in' })
  const running = imageDriver(t, f)
  await until(() => announced(running), 'the initial image child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'rolledBack', 'the image rollback did not finish')
  assert.equal(stateOf(f).rollback.failed, 'sign-in')
  assert.equal(previousVersion(f), FROM)
  // Initial child, the failed trial and the restored previous child: one supervisor boot, three children.
  await until(() => eventsOf(f).filter(event => event.event === 'image-launch').length === 3, 'the restored child did not publish')
  assert.deepEqual(eventsOf(f).filter(event => event.event === 'image-launch').map(event => event.url), [1, 2, 3]
    .map(index => `http://127.0.0.1:3080/?token=image-child-${index}`))
  assert.equal(eventsOf(f).filter(event => event.event === 'image-start').length, 3)
  assert.equal(new Set(boots(f).map(item => item.boot)).size, 1)
  assert.equal(fs.existsSync(join(f.store, 'supervisor')), false)
  running.child.kill('SIGINT')
  assert.equal((await running.exit).code, 1)
})

test('the image host never announces same-version reinstall, even beside capable store copies (RFC 0041 R9)', async t => {
  const f = fixture(t)
  await setup(t, f)
  // A plain-host supervisor would announce it here: the store holds capable current and kept copies.
  assert.equal(reinstallCopies(f.store), true)
  const dsh = f.command[1]
  fs.writeFileSync(dsh, fs.readFileSync(dsh, 'utf8')
    .replace("event: 'boot', args", "event: 'boot', reinstall: process.env.AUTOMAGIK_SUPERVISOR_REINSTALL, args"))
  f.env.AUTOMAGIK_SUPERVISOR_REINSTALL = 'inherited-boot-id'
  const running = imageDriver(t, f)
  await until(() => announced(running), 'the image child did not start')
  assert.equal(boots(f).length, 1)
  assert.equal(boots(f)[0].reinstall, undefined)
  running.child.kill('SIGINT')
  assert.equal((await running.exit).code, 1)
})

test('an already aborted image supervisor returns without opening the store or starting DSH', async t => {
  const f = fixture(t)
  const result = await imageDriver(t, f, 'already-aborted').exit
  assert.equal(result.code, 1)
  assert.deepEqual(eventsOf(f), [])
  assert.equal(fs.existsSync(join(f.store, 'supervisor.json')), false)
  assert.equal(fs.existsSync(join(f.store, 'update.lock')), false)
})

test('a candidate publishes its own inventory while the executing generation survives two rotations', async t => {
  const f = fixture(t)
  await setup(t, f)
  const root = join(f.store, 'supervisor')
  const executing = runningCopy(f.store, join(root, 'current'))
  const bot = join(f.profileDir, 'node_modules', BOTS)
  const host = join(bot, 'src/host')
  const main = join(host, 'supervisor/main.js')
  const original = fs.readFileSync(main, 'utf8')
  const extra = 'supervisor/new-module.js'
  fs.writeFileSync(join(host, extra), 'export const newModule = true\n')
  write(join(host, 'supervisor/files.json'), [...SUPERVISOR_FILES, extra])

  // A zero exit without the self-check marker cannot publish a copy.
  fs.writeFileSync(main, '')
  write(join(bot, 'package.json'), { name: BOTS, type: 'module', version: TO })
  await assert.rejects(refreshCopy(f.store, f.profileDir, TO, undefined, executing), /self-check result/)
  assert.equal(read(join(root, 'current/version.json')).version, FROM)
  assert.equal(fs.existsSync(join(root, 'next')), false)

  fs.writeFileSync(main, "import './new-module.js'\n" + original)
  await refreshCopy(f.store, f.profileDir, TO, undefined, executing)
  assert.equal(fs.existsSync(join(root, 'current', extra)), true)
  assert.equal(read(join(root, 'kept/version.json')).version, FROM)
  assert.equal(executing.owns(join(root, 'kept')), true)
  const next = '3.160.4'
  write(join(bot, 'package.json'), { name: BOTS, type: 'module', version: next })
  await refreshCopy(f.store, f.profileDir, next, undefined, executing)
  assert.equal(read(join(root, 'current/version.json')).version, next)
  assert.equal(read(join(root, 'kept/version.json')).version, TO)
  assert.equal(read(join(root, 'running/version.json')).version, FROM)
  executing.release()
  assert.equal(fs.existsSync(join(root, 'running')), false)
})

test('the supervised dry check and installer use the same private pnpm registry without a request field', async t => {
  const f = fixture(t)
  const privateRegistry = 'https://private.example.invalid/npm/'
  fs.unlinkSync(join(f.profileDir, '.npmrc'))
  const userConfig = join(f.root, 'user.npmrc')
  fs.writeFileSync(userConfig, 'registry=' + privateRegistry + '\n')
  f.env.NPM_CONFIG_USERCONFIG = userConfig
  f.env.SUPERVISOR_EXPECT_REGISTRY = privateRegistry
  for (const key of ['PATH', 'NPM_CONFIG_USERCONFIG', 'SUPERVISOR_FIXTURE']) {
    const before = process.env[key]
    process.env[key] = f.env[key]
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
  }
  const running = driver(t, f)
  await until(() => announced(running), 'DSH did not start')
  const pings = []
  let resolved = privateRegistry
  const checkOptions = {
    profileDir: f.profileDir, ...f.signed, inDesktop: false, getDshVersion: () => '0.2.2-rc.2',
    env: { AUTOMAGIK_SUPERVISOR_BOOT: supervisorOf(f).bootId, AUTOMAGIK_SUPERVISOR_VERSION: FROM },
    ctx: { get: name => name === 'profileContext' ? { installAnchor: f.command[1] } : name === 'pluginManager' ? {
      profile: { dir: f.profileDir },
      async registries() {
        assert.ok(this.profile.dir.startsWith(f.store + '/check-'))
        return { resolved }
      },
    } : undefined },
    fetch: async url => {
      if (f.tarballs.has(url)) return new Response(f.tarballs.get(url))
      pings.push(url)
      assert.equal(url, privateRegistry + '-/ping')
      return new Response('{}')
    },
  }
  const check = await selfUpdateCheck(checkOptions)
  assert.equal(check.state, 'available')
  assert.deepEqual(pings, [privateRegistry + '-/ping'])
  resolved = 'https://other.example.invalid/'
  const mismatch = await selfUpdateCheck(checkOptions)
  assert.equal(mismatch.state, 'refused')
  assert.equal(mismatch.reason, 'registry-unreachable')
  assert.deepEqual(pings, [privateRegistry + '-/ping'])
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'update did not use the private registry')
  assert.ok(eventsOf(f).find(event => event.event === 'add').args.includes('--registry=' + privateRegistry))
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
})

test('the dry check compares resolved-only registry answers from staging and refuses config dependencies before pnpm', async t => {
  const f = fixture(t)
  const signed = lane(f)
  for (const key of ['PATH', 'NPM_CONFIG_USERCONFIG', 'SUPERVISOR_FIXTURE']) {
    const before = process.env[key]
    process.env[key] = f.env[key]
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
  }
  let resolved = 'https://other.example.invalid/'
  let managerCwd
  const pings = []
  const opts = { ...signed, profileDir: f.profileDir, inDesktop: false, getDshVersion: () => '0.2.2-rc.2',
    env: { AUTOMAGIK_SUPERVISOR_BOOT: 'sup_fixture', AUTOMAGIK_SUPERVISOR_VERSION: FROM },
    ctx: { get: name => name === 'profileContext' ? { installAnchor: f.command[1] } : name === 'pluginManager' ? {
      profile: { dir: f.profileDir },
      async registries() {
        managerCwd = this.profile.dir
        return { resolved }
      },
    } : undefined },
    fetch: async url => {
      if (f.tarballs.has(url)) return new Response(f.tarballs.get(url))
      pings.push(url)
      return new Response('{}')
    },
  }
  assert.equal((await selfUpdateCheck(opts)).reason, 'registry-unreachable')
  assert.deepEqual(pings, [])
  assert.ok(managerCwd.startsWith(f.store + '/check-'))
  const probes = join(f.root, 'pnpm-probes')
  assert.ok(fs.readFileSync(probes, 'utf8').trim().split('\n').every(path => path.startsWith(f.store + '/check-')))
  resolved = 'https://registry.example.invalid/npm/'
  assert.equal((await selfUpdateCheck(opts)).state, 'available')
  assert.deepEqual(pings, [resolved + '-/ping'])

  fs.unlinkSync(probes)
  managerCwd = undefined
  fs.appendFileSync(join(f.profileDir, 'pnpm-workspace.yaml'), 'configDependencies: { example: 1 }\n')
  assert.equal((await selfUpdateCheck(opts)).reason, 'registry-unreachable')
  assert.equal(fs.existsSync(probes), false)
  assert.equal(managerCwd, undefined)
  assert.deepEqual(pings, [resolved + '-/ping'])
})

test('refuses an ephemeral port with a public URL in the check and before switching', async t => {
  const f = fixture(t)
  f.command.push('--public-url', 'https://example.invalid/')
  f.env.SUPERVISOR_ANNOUNCE_ONLY = '1'
  const running = driver(t, f)
  await until(() => announced(running), 'DSH did not announce its public URL')
  const env = {
    [LISTENER_UNKNOWN]: boots(f)[0].listenerUnknown,
    AUTOMAGIK_SUPERVISOR_BOOT: supervisorOf(f).bootId, AUTOMAGIK_SUPERVISOR_VERSION: FROM,
  }
  assert.equal(env[LISTENER_UNKNOWN], '1')
  assert.equal(selfUpdateStatus({ profileDir: f.profileDir, env, inDesktop: false }).reason, 'listener-unknown')
  const check = await selfUpdateCheck({ ...f.signed, profileDir: f.profileDir, env, inDesktop: false,
    fetch: () => assert.fail('a listener refusal must precede any network operation'),
  })
  assert.equal(check.reason, 'listener-unknown')
  assert.equal(check.state, 'refused')
  assert.equal(read(join(f.store, 'check.json')).reason, 'listener-unknown')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'notUpdated', 'request was not refused')
  assert.equal(stateOf(f).reason, 'listener-unknown')
  assert.deepEqual(eventsOf(f).map(event => event.event), ['boot'])
  assert.equal(fs.existsSync(join(f.store, 'current.json')), false)
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
})

for (const [verdict, lastPhase, mode] of [['healthy', 'health', ''], ['notUpdated', 'staging', 'frozen-fails']]) {
  test('stops for recovery without signaling DSH if publishing ' + verdict + ' fails', async t => {
    const f = fixture(t, { mode })
    f.command[f.command.indexOf('--port') + 1] = '3080'
    f.env.SUPERVISOR_ANNOUNCE_ONLY = '1'
    f.env.SUPERVISOR_VERDICT_FAILURE = verdict
    const running = driver(t, f)
    const pidPath = join(f.root, 'dsh-child-pid')
    try {
      await until(() => announced(running), 'DSH did not start')
      request(f)
      await until(() => running.stderr().includes('could not record the update verdict'), 'missing recovery diagnostic')
      const result = await running.exit
      assert.equal(result.code, 1)
      assert.equal(stateOf(f).phase, lastPhase)
      if (verdict === 'healthy') assert.equal(stateOf(f).journal.commitCurrent, true)
      assert.equal(read(join(f.store, 'request.json')).requestId, 'during-verdict-failure')
      assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 0))
      assert.equal(eventsOf(f).filter(event => event.event === 'stop').length, verdict === 'healthy' ? 1 : 0)
    } finally {
      if (fs.existsSync(pidPath)) {
        try {
          const stopped = eventsOf(f).filter(event => event.event === 'stop').length
          process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGTERM')
          await until(() => eventsOf(f).filter(event => event.event === 'stop').length > stopped, 'fixture DSH did not stop')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }
  })
}

function fakeTransport(f) {
  f.command[f.command.indexOf('--port') + 1] = '3080'
  f.env.SUPERVISOR_ANNOUNCE_ONLY = '1'
  f.env.SUPERVISOR_FAKE_TRANSPORT = '1'
}

const previousVersion = f => read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version

for (const fault of ['port', 'sign-in', 'plugins', 'roster', 'page']) {
  test('a failed trial ' + fault + ' rolls back to a healthy previous child', async t => {
    const f = fixture(t, { mode: 'trial-' + fault })
    fakeTransport(f)
    const prior = { version: 1, live: { version: FROM, sequence: 41 }, kept: null, lastSequence: 41 }
    const current = join(f.store, 'current.json')
    writeJsonAtomic(current, prior, { profileDir: f.profileDir, durable: true })
    const before = fs.readFileSync(current)
    const running = driver(t, f)
    await until(() => announced(running), 'fake child did not start')
    request(f)
    await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'rolledBack', 'missing rollback')
    assert.equal(stateOf(f).rollback.failed, fault)
    const output = running.stdout() + running.stderr() + JSON.stringify(stateOf(f))
    for (const secret of ['stdout-secret', 'fixture-token', 'fixture-cookie']) assert.ok(!output.includes(secret))
    assert.equal(previousVersion(f), FROM)
    assert.deepEqual(fs.readFileSync(current), before)
    assert.equal(boots(f).length, 3)
    assert.ok(boots(f).every(boot => boot.boot === supervisorOf(f).bootId))
    running.child.kill('SIGTERM')
    assert.equal((await running.exit).code, 0)
  })
}

test('the second boot after a missing roster reads the saved team and its replacement is retained', async t => {
  const f = fixture(t, { mode: 'trial-team-missing' })
  fakeTransport(f)
  write(join(f.botsHome, 'state.json'), { version: 2, revision: 7, note: 'preserve me' })
  const path = join(f.botsHome, 'state.json')
  const original = fs.readFileSync(path)
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'rolledBack', 'missing rollback')
  const state = stateOf(f)
  const saved = join(f.store, 'rollback-data', state.runId)
  assert.equal(state.rollback.failed, 'roster')
  assert.equal(state.rollback.teamMissing, true)
  assert.deepEqual(state.rollback.data, { restored: true, why: 'team-lost', trialKept: true })
  assert.deepEqual(fs.readFileSync(path), original)
  assert.deepEqual(fs.readFileSync(join(saved, 'bots-state.json')), original)
  assert.deepEqual(read(join(saved, 'trial-bots-state.json')), { version: 2, revision: 1, bots: {} })
  assert.equal(previousVersion(f), FROM)
  assert.equal(boots(f).length, 3)
})

test('recovery refuses to start a trial with an unrelated dependency edit', async t => {
  const f = fixture(t, { mode: 'trial-dependency-edit' })
  fakeTransport(f)
  f.env.SUPERVISOR_PAUSE_TRIAL_HEALTH = '1'
  const manifest = join(f.profileDir, 'package.json')
  const first = driver(t, f)
  await until(() => announced(first), 'initial child did not start')
  request(f)
  // The candidate's fake DSH rewrites the manifest in place (truncate, then write), so a poll can
  // read it half written: that read is not yet the edit. The read after the child exits stays strict.
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'health'
    && whole(manifest)?.dependencies['custom-plugin'] === '^2.0.0', 'trial did not change the manifest during health')
  first.child.kill('SIGTERM')
  assert.equal((await first.exit).code, 0)
  const cut = stateOf(f)
  assert.equal(cut.phase, 'health')
  assert.ok(cut.trialStartedAt)
  assert.equal(previousVersion(f), TO)

  delete f.env.SUPERVISOR_PAUSE_TRIAL_HEALTH
  const recovered = driver(t, f)
  assert.equal((await recovered.exit).code, 1)
  const result = stateOf(f)
  assert.equal(result.phase, 'manualRecovery')
  assert.equal(result.reason, 'rollback-failed')
  assert.equal(result.rollback.step, 'manifest')
  assert.deepEqual(result.rollback.tried, [])
  assert.deepEqual(result.rollback.location.modules, { previous: 'kept', candidate: 'live' })
  assert.deepEqual(result.rollback.location.lockfile, { previous: 'kept', candidate: 'live' })
  assert.equal(previousVersion(f), TO)
  assert.equal(read(manifest).dependencies['custom-plugin'], '^2.0.0')
  assert.equal(eventsOf(f).filter(event => event.event === 'install' && event.live).length, 1)
  assert.equal(result.rollback.failed, 'plugins')
  assert.equal(boots(f).length, 2)
})

test('recovery rejects a trial that lost the team and saved an empty replacement before the roster RPC', async t => {
  const f = fixture(t, { mode: 'trial-team-missing-recover' })
  fakeTransport(f)
  f.env.SUPERVISOR_PAUSE_TRIAL_HEALTH = '1'
  f.env.SUPERVISOR_RECORD_HEALTH = '1'
  const path = join(f.botsHome, 'state.json')
  const original = { version: 2, revision: 7, bots: { ada: {}, bea: {} } }
  write(path, original)
  const first = driver(t, f)
  await until(() => announced(first), 'initial child did not start')
  request(f)
  const replacement = { version: 2, revision: 1, bots: {} }
  await until(() => eventsOf(f).some(event => event.event === 'team-replaced'), 'candidate did not replace the team')
  assert.deepEqual(read(path), replacement)
  first.child.kill('SIGTERM')
  assert.equal((await first.exit).code, 0)
  assert.equal(stateOf(f).phase, 'health')
  assert.ok(!eventsOf(f).some(event => event.candidate && event.endpoint === 'state'))

  delete f.env.SUPERVISOR_PAUSE_TRIAL_HEALTH
  const recovered = driver(t, f)
  await until(() => stateOf(f).phase === 'rolledBack', 'recovery did not restore the previous team')
  const state = stateOf(f)
  assert.equal(state.rollback.failed, 'roster')
  assert.deepEqual(state.rollback.data, { restored: true, why: 'team-lost', trialKept: true })
  assert.equal(boots(f).length, 3)
  assert.equal(previousVersion(f), FROM)
  assert.equal(fs.existsSync(join(f.store, 'current.json')), false)
  assert.deepEqual(read(path), original)
  assert.deepEqual(read(join(f.store, 'rollback-data', state.runId, 'trial-bots-state.json')), replacement)
  assert.deepEqual(eventsOf(f).filter(event => event.event === 'roster-at-boot').at(-1),
    { event: 'roster-at-boot', installed: FROM, bots: ['ada', 'bea'] })
  recovered.child.kill('SIGTERM')
  assert.equal((await recovered.exit).code, 0)
})

test('recovery restores a revision-1 team lost before the trial roster RPC', async t => {
  const f = fixture(t, { mode: 'trial-team-enoent-recover' })
  fakeTransport(f)
  f.env.SUPERVISOR_PAUSE_TRIAL_HEALTH = '1'
  f.env.SUPERVISOR_RECORD_HEALTH = '1'
  const path = join(f.botsHome, 'state.json')
  const original = { version: 2, revision: 1, bots: { ada: {}, bea: {} } }
  write(path, original)
  const first = driver(t, f)
  await until(() => announced(first), 'initial child did not start')
  request(f)
  await until(() => eventsOf(f).some(event => event.event === 'team-read' && event.present === false),
    'candidate did not read the missing team')
  assert.equal(fs.existsSync(path), false)
  first.child.kill('SIGTERM')
  assert.equal((await first.exit).code, 0)
  assert.equal(stateOf(f).phase, 'health')
  assert.ok(!eventsOf(f).some(event => event.candidate && event.endpoint === 'state'))

  delete f.env.SUPERVISOR_PAUSE_TRIAL_HEALTH
  const recovered = driver(t, f)
  await until(() => stateOf(f).phase === 'rolledBack', 'recovery did not restore the previous team')
  const state = stateOf(f)
  assert.equal(state.rollback.failed, 'roster')
  assert.deepEqual(state.rollback.data, { restored: true, why: 'team-lost', trialKept: false })
  assert.equal(boots(f).length, 3)
  assert.equal(fs.existsSync(join(f.store, 'current.json')), false)
  assert.deepEqual(read(path), original)
  assert.deepEqual(eventsOf(f).filter(event => event.event === 'roster-at-boot').at(-1),
    { event: 'roster-at-boot', installed: FROM, bots: ['ada', 'bea'] })
  recovered.child.kill('SIGTERM')
  assert.equal((await recovered.exit).code, 0)
})

test('a trial whose lane dependency changes rolls back even when its page answers', async t => {
  const f = fixture(t, { mode: 'trial-lane-dependency-edit' })
  fakeTransport(f)
  f.env.SUPERVISOR_RECORD_HEALTH = '1'
  f.env.SUPERVISOR_EXPECT_ROLLBACK = '1'
  const running = driver(t, f)
  await until(() => announced(running), 'initial child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'rolledBack', 'trial did not roll back')
  assert.equal(stateOf(f).rollback.failed, 'plugins')
  assert.ok(eventsOf(f).some(event => event.candidate && event.page && event.status === 200))
  assert.equal(previousVersion(f), FROM)
  assert.equal(boots(f).length, 3)
  assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
  assert.equal(fs.existsSync(join(f.store, 'current.json')), false)
})

test('a trial that exits after saving an empty team gives the original Bots back at the next boot', async t => {
  const f = fixture(t, { mode: 'trial-empty-team-exit' })
  fakeTransport(f)
  const path = join(f.botsHome, 'state.json')
  const original = { version: 2, revision: 7, bots: { ada: {}, bea: {} } }
  write(path, original)
  const running = driver(t, f)
  await until(() => announced(running), 'initial child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'rolledBack', 'missing rollback')
  const state = stateOf(f)
  assert.equal(state.rollback.failed, 'exited')
  assert.equal(state.rollback.teamMissing, undefined)
  assert.deepEqual(state.rollback.data, { restored: true, trialKept: true, why: 'team-lost' })
  assert.deepEqual(read(path), original)
  assert.deepEqual(read(join(f.store, 'rollback-data', state.runId, 'trial-bots-state.json')), { version: 2, revision: 1, bots: {} })
  assert.deepEqual(eventsOf(f).filter(event => event.event === 'roster-at-boot').at(-1),
    { event: 'roster-at-boot', installed: FROM, bots: ['ada', 'bea'] })
})

for (const field of ['dependency', 'compatibility', 'dsh']) {
  test('rollback compares the trial profile after a change to ' + field, async t => {
    const f = fixture(t, { mode: 'trial-' + field + '-edit' })
    fakeTransport(f)
    const running = driver(t, f)
    await until(() => announced(running), 'fake child did not start')
    request(f)
    const expected = field === 'dsh' ? 'rolledBack' : 'manualRecovery'
    await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === expected, 'missing decision')
    const state = stateOf(f)
    const manifest = read(join(f.profileDir, 'package.json'))
    if (field === 'dsh') {
      assert.equal(previousVersion(f), FROM)
      assert.ok(manifest.dsh.profile.bundles.includes('reconciled'))
    } else {
      assert.equal((await running.exit).code, 1)
      assert.equal(state.rollback.step, 'manifest')
      assert.deepEqual(state.rollback.tried, [])
      assert.equal(previousVersion(f), TO)
      assert.deepEqual(state.rollback.location.modules, { previous: 'kept', candidate: 'live' })
      assert.deepEqual(state.rollback.location.lockfile, { previous: 'kept', candidate: 'live' })
    }
  })
}

test('listener eligibility stays unknown until the child announces and a stale file is ignored', async t => {
  const f = fixture(t, { mode: 'signal-forward' })
  const running = driver(t, f)
  await until(() => fs.existsSync(join(f.store, 'supervisor.json')), 'supervisor did not announce')
  const env = { AUTOMAGIK_SUPERVISOR_BOOT: supervisorOf(f).bootId, AUTOMAGIK_SUPERVISOR_VERSION: FROM }
  assert.deepEqual(read(join(f.store, 'listener.json')), { version: 1, bootId: env.AUTOMAGIK_SUPERVISOR_BOOT, listener: 'unknown' })
  assert.equal(selfUpdateStatus({ profileDir: f.profileDir, env }).reason, 'listener-unknown')
  const check = await selfUpdateCheck({ ...f.signed, profileDir: f.profileDir, env, inDesktop: false,
    fetch: () => assert.fail('unknown listener must be refused before checking release'),
  })
  assert.equal(check.reason, 'listener-unknown')
  assert.equal(announced(running), false)
})

test('the launch line is forwarded after the listener is available to the plugin', async t => {
  const f = fixture(t)
  fakeTransport(f)
  const running = driver(t, f)
  await until(() => announced(running), 'DSH did not announce')
  const env = { AUTOMAGIK_SUPERVISOR_BOOT: supervisorOf(f).bootId, AUTOMAGIK_SUPERVISOR_VERSION: FROM,
    [LISTENER_UNKNOWN]: '1' }
  assert.deepEqual(read(join(f.store, 'listener.json')), {
    version: 1, bootId: env.AUTOMAGIK_SUPERVISOR_BOOT, listener: 'verified',
  })
  assert.equal(selfUpdateStatus({ profileDir: f.profileDir, env }).available, true)
})

test('an old child receives a full give-back window and releases a failed signature hold once', async t => {
  const f = fixture(t)
  fakeTransport(f)
  f.env.SUPERVISOR_FAKE_AGE_MS = '61000'
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  fs.appendFileSync(f.signed.path, '\n')
  const responses = []
  const hold = createUpdateHold({
    readStatus: () => ({ supervised: true, profileKnown: true, run: fs.existsSync(join(f.store, 'state.json')) ? stateOf(f) : null }),
    schedule: () => ({}), onResume: reason => { responses.push(reason) },
  })
  hold.close('owner-request')
  request(f)
  hold.wrote()
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'notUpdated', 'old child did not pass give-back health')
  assert.equal(stateOf(f).reason, 'signature-invalid')
  hold.tick()
  hold.tick()
  assert.deepEqual(responses, ['notUpdated'])
  assert.equal(boots(f).length, 1)
})

test('a 5b live package receives a 5b-readable refusal and opens its hold without a download', async t => {
  const f = fixture(t)
  fakeTransport(f)
  fs.unlinkSync(join(f.profileDir, 'node_modules', BOTS, 'src/host/update-contract.json'))
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  fs.unlinkSync(f.signed.path)
  const { runOf } = await import('./fixtures/supervisor-5b/supervisor/records.js')
  const resumes = []
  const hold = createUpdateHold({
    readStatus: () => ({ supervised: true, profileKnown: true, run: fs.existsSync(join(f.store, 'state.json')) ? runOf(stateOf(f), []) : null }),
    schedule: () => ({}), onResume: reason => { resumes.push(reason) },
  })
  hold.close('owner-request')
  request(f)
  hold.wrote()
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'notUpdated', 'old generation refusal missing')
  assert.equal(stateOf(f).reason, 'profile-invalid')
  assert.equal(stateOf(f).detail, 'previous-unsupported')
  assert.equal(previousVersion(f), FROM)
  assert.ok(eventsOf(f).every(event => event.event === 'boot'))
  hold.tick()
  hold.tick()
  assert.deepEqual(resumes, ['notUpdated'])
})

for (const contract of ['missing', 'invalid']) {
  test('an uninterrupted 5b refusal keeps work held when the legacy page fails (' + contract + ' contract)', async t => {
    const f = fixture(t, { mode: 'unchanged-page-fails' })
    fakeTransport(f)
    const path = join(f.profileDir, 'node_modules', BOTS, 'src/host/update-contract.json')
    if (contract === 'missing') fs.unlinkSync(path)
    else write(path, { version: 1, holdRun: false })
    f.env.SUPERVISOR_FAKE_AGE_MS = '61000'
    f.env.SUPERVISOR_RECORD_HEALTH = '1'
    const running = driver(t, f)
    await until(() => announced(running), 'fake child did not start')
    fs.unlinkSync(f.signed.path)
    const { runOf } = await import('./fixtures/supervisor-5b/supervisor/records.js')
    const resumes = []
    const hold = createUpdateHold({
      readStatus: () => ({ supervised: true, profileKnown: true, run: fs.existsSync(join(f.store, 'state.json')) ? runOf(stateOf(f), []) : null }),
      schedule: () => ({}), onResume: reason => { resumes.push(reason) },
    })
    hold.close('owner-request')
    request(f)
    hold.wrote()
    assert.equal((await running.exit).code, 1)
    assert.equal(stateOf(f).phase, 'manualRecovery')
    assert.equal(stateOf(f).reason, 'health-failed')
    assert.equal(stateOf(f).journal, undefined)
    assert.equal(previousVersion(f), FROM)
    assert.equal(boots(f).length, 1)
    assert.ok(eventsOf(f).some(event => event.endpoint === 'list-bots' && event.status === 200))
    assert.ok(eventsOf(f).some(event => event.page && event.status === 200))
    assert.ok(eventsOf(f).some(event => event.event === 'health-probe' && event.status === 500))
    hold.tick()
    assert.equal(hold.closed, true)
    assert.deepEqual(resumes, [])
  })
}

test('a crash after checking gives back a serving 5b profile with a 5b-readable verdict', async t => {
  const f = fixture(t)
  fakeTransport(f)
  fs.unlinkSync(join(f.profileDir, 'node_modules', BOTS, 'src/host/update-contract.json'))
  f.env.SUPERVISOR_CUT_AFTER = 'checking'
  f.env.SUPERVISOR_RECORD_HEALTH = '1'
  const first = driver(t, f)
  await until(() => announced(first), 'initial 5b child did not start')
  request(f)
  assert.equal((await first.exit).signal, 'SIGKILL')
  assert.equal(stateOf(f).phase, 'checking')
  assert.equal(Object.hasOwn(stateOf(f), 'journal'), false)
  fs.unlinkSync(f.signed.path)

  delete f.env.SUPERVISOR_CUT_AFTER
  const recovered = driver(t, f)
  await until(() => stateOf(f).phase === 'notUpdated', '5b give-back verdict missing')
  const { runOf } = await import('./fixtures/supervisor-5b/supervisor/records.js')
  const verdict = stateOf(f)
  assert.equal(runOf(verdict, [verdict.bootId]).reason, 'profile-invalid')
  assert.equal(verdict.detail, 'previous-unsupported')
  assert.deepEqual(verdict.fromVersions, { [BOTS]: FROM })
  assert.equal(previousVersion(f), FROM)
  const probes = eventsOf(f).filter(event => event.event === 'health-probe')
  assert.ok(probes.some(event => event.endpoint === 'list-bots' && event.health === undefined && event.status === 200))
  assert.ok(probes.some(event => event.page && event.status === 200))
  assert.ok(!probes.some(event => event.endpoint === 'self-update-status'))
  assert.equal(boots(f).length, 2)
  recovered.child.kill('SIGTERM')
  assert.equal((await recovered.exit).code, 0)
})

test('the frozen 5b supervisor accepts a request with d6\'s unchanged four keys', async t => {
  const f = fixture(t)
  fakeTransport(f)
  const frozen = join(f.root, 'frozen-supervisor')
  fs.cpSync(fileURLToPath(new URL('./fixtures/supervisor-5b/', import.meta.url)), frozen, { recursive: true })
  write(join(frozen, 'package.json'), { type: 'module' })
  write(join(frozen, 'version.json'), { version: FROM })
  f.env.SUPERVISOR_FROZEN_MAIN = join(frozen, 'supervisor/main.js')
  const running = driver(t, f)
  await until(() => announced(running), '5b did not start')
  write(join(f.store, 'check.json'), {
    version: 1, runId: 'generation-pairing-check', checkedAt: new Date().toISOString(), state: 'available',
    reason: null, laneVersion: TO, sequence: 42, supervisor: true, plugins: [{ name: BOTS, from: FROM, to: TO }],
  })
  const env = {
    AUTOMAGIK_BOTS_HOME: f.botsHome, AUTOMAGIK_SUPERVISOR_BOOT: supervisorOf(f).bootId,
    AUTOMAGIK_SUPERVISOR_VERSION: FROM, [LISTENER_UNKNOWN]: '0',
  }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const rt = {
    ctx: { get: name => name === 'profileContext' ? { dir: f.profileDir } : undefined },
    config: { selfUpdate: true }, statePath: join(f.botsHome, 'state.json'), holdsLock: () => true,
    markUpdateStop: () => true, flushUpdateNotes: publish => publish(),
  }
  installSelfUpdate(rt)
  const dispose = installUpdateHold(rt)
  t.after(dispose)
  let published
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === join(f.store, 'request.json')) published = read(source)
    return rename(source, target)
  })
  const click = await rt.selfUpdateStart()
  assert.equal(click.started, true)
  assert.deepEqual(Object.keys(published).sort(), ['bootId', 'requestId', 'requestedAt', 'version'])
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', '5b did not accept the request')
  assert.equal(stateOf(f).requestId, click.requestId)
  assert.equal(previousVersion(f), TO)
})

test('a service group cut just after rollback intent recovers the prior current record and profile', async t => {
  const f = fixture(t, { mode: 'trial-exit' })
  fakeTransport(f)
  write(join(f.botsHome, 'state.json'), { version: 2, revision: 7, note: 'preserve me' })
  const prior = { version: 1, live: { version: FROM, sequence: 41 }, kept: null, lastSequence: 41 }
  const candidate = { version: 1, live: { version: TO, sequence: 42 }, kept: { version: FROM }, lastSequence: 42 }
  write(join(f.store, 'current.json'), candidate)
  await interruptedCandidate(f, run => {
    run.phase = 'health'
    run.journal.relinking = true
    run.journal.commitCurrent = true
    run.priorCurrent = prior
    run.fromVersions = { [BOTS]: FROM }
  })
  f.env.SUPERVISOR_CUT_AFTER = 'stop'
  const interrupted = driver(t, f)
  assert.equal((await interrupted.exit).signal, 'SIGKILL')
  assert.equal(stateOf(f).rollback.restoreCurrent, true)
  assert.deepEqual(read(join(f.store, 'current.json')), candidate)
  assert.equal(previousVersion(f), TO)
  delete f.env.SUPERVISOR_CUT_AFTER
  const recovered = driver(t, f)
  await until(() => stateOf(f).phase === 'rolledBack', 'next supervisor did not finish rollback')
  assert.deepEqual(read(join(f.store, 'current.json')), prior)
  assert.equal(previousVersion(f), FROM)
  assert.deepEqual(read(join(f.profileDir, 'package.json')), f.manifest)
  assert.deepEqual(read(join(f.botsHome, 'state.json')), { version: 2, revision: 7, note: 'preserve me' })
  assert.ok(fs.existsSync(f.archive))
  recovered.child.kill('SIGTERM')
  assert.equal((await recovered.exit).code, 0)
})

for (const repeat of [false, true]) {
  test('reverse rename fsync failure ' + (repeat ? 'uses a bounded retry budget' : 'replays on the next start'), async t => {
    const f = fixture(t, { mode: 'trial-page' })
    fakeTransport(f)
    f.env.SUPERVISOR_UNDO_FSYNC_FAILURE = '1'
    const first = driver(t, f)
    await until(() => announced(first), 'initial child did not start')
    request(f)
    assert.equal((await first.exit).code, 1)
    const cut = stateOf(f)
    assert.equal(cut.phase, 'rollingBack')
    assert.equal(cut.rollback.ioFailures, 1)
    assert.equal(cut.journal.done.at(-1), 'install-modules')
    assert.equal(fs.existsSync(join(f.profileDir, 'node_modules')), false)
    assert.ok(fs.existsSync(join(f.store, cut.journal.keep, 'node_modules')))

    if (!repeat) delete f.env.SUPERVISOR_UNDO_FSYNC_FAILURE
    const recovered = driver(t, f)
    if (repeat) {
      assert.equal((await recovered.exit).code, 1)
      const failed = stateOf(f)
      assert.equal(failed.phase, 'manualRecovery')
      assert.equal(failed.reason, 'rollback-failed')
      assert.equal(failed.rollback.ioFailures, 2)
      assert.deepEqual(failed.rollback.location.modules, { previous: 'kept', candidate: 'staging' })
    } else {
      await until(() => stateOf(f).phase === 'rolledBack', 'rollback did not replay the completed rename')
      assert.equal(stateOf(f).rollback.ioFailures, 1)
      assert.equal(previousVersion(f), FROM)
      recovered.child.kill('SIGTERM')
      assert.equal((await recovered.exit).code, 0)
    }
  })
}

test('a team lost before trial causes rollback without booting the candidate', async t => {
  const f = fixture(t, { mode: 'pretrial-team-missing' })
  fakeTransport(f)
  write(join(f.botsHome, 'state.json'), { version: 2, revision: 7, note: 'preserve me' })
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'rolledBack', 'missing rollback')
  const state = stateOf(f)
  assert.equal(boots(f).length, 2)
  assert.equal(state.rollback.failed, 'roster')
  assert.deepEqual(state.rollback.data, { restored: true, why: 'team-lost', trialKept: false })
  assert.deepEqual(read(join(f.botsHome, 'state.json')), { version: 2, revision: 7, note: 'preserve me' })
  assert.equal(previousVersion(f), FROM)
})

test('a genuinely new team can pass health with no team file at the switch', async t => {
  const f = fixture(t)
  fakeTransport(f)
  fs.unlinkSync(join(f.botsHome, 'state.json'))
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'missing health verdict')
  assert.equal(previousVersion(f), TO)
  assert.deepEqual(read(join(f.store, 'versions', FROM, 'data.json')).files, [])
})

test('a retry at the same sequence retains both trial copies and pins the mixed previous set', async t => {
  const f = fixture(t, { mode: 'trial-new-format', plugins: [BOTS, WELCOME] })
  fakeTransport(f)
  write(join(f.botsHome, 'state.json'), { version: 2, revision: 7, note: 'preserve me' })
  f.env.SUPERVISOR_ROLLBACK_VERDICT_PAUSE = '250'
  const older = '3.160.1'
  const welcome = join(f.profileDir, 'node_modules', WELCOME, 'package.json')
  write(welcome, { ...read(welcome), version: older })
  const previousKept = join(f.store, 'versions', '3.160.0')
  fs.mkdirSync(previousKept, { recursive: true })
  const current = join(f.store, 'current.json')
  write(current, { version: 1, live: { version: FROM, sequence: 42 }, kept: { version: '3.160.0' }, lastSequence: 42 })
  const before = fs.readFileSync(current)
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  const savedRuns = []
  for (const requestId of ['first-owner-request', 'retry-owner-request']) {
    request(f, { requestId })
    const state = await until(() => {
      if (!fs.existsSync(join(f.store, 'state.json'))) return
      const state = stateOf(f)
      if (state.phase === 'rolledBack' && state.requestId === requestId) return state
    }, 'missing rollback for ' + requestId)
    assert.deepEqual(state.fromVersions, { [BOTS]: FROM, [WELCOME]: older })
    assert.deepEqual(fs.readFileSync(current), before)
    assert.equal(read(welcome).version, older)
    assert.equal(previousVersion(f), FROM)
    assert.ok(fs.existsSync(previousKept))
    savedRuns.push(state.runId)
  }
  assert.equal(new Set(savedRuns).size, 2)
  for (const runId of savedRuns) {
    const saved = join(f.store, 'rollback-data', runId)
    assert.deepEqual(read(join(saved, 'trial-bots-state.json')), { version: 3, revision: 8, note: 'edited during trial' })
    assert.deepEqual(read(join(saved, 'bots-state.json')), { version: 2, revision: 7, note: 'preserve me' })
  }
})

test('a failed rolledBack verdict write leaves the previous child held until a supervised recovery', async t => {
  const f = fixture(t, { mode: 'trial-exit' })
  fakeTransport(f)
  f.env.SUPERVISOR_VERDICT_FAILURE = 'rolledBack'
  const pidPath = join(f.root, 'dsh-child-pid')
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  request(f)
  try {
    const result = await running.exit
    assert.equal(result.code, 1)
    assert.match(result.stderr, /could not record the update verdict/)
    const cut = stateOf(f)
    assert.equal(cut.phase, 'rollingBack')
    assert.equal(cut.rollback.starts, 1)
    assert.equal(cut.journal.undoReason, 'health-failed')
    assert.equal(previousVersion(f), FROM)
    assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 0))
  } finally {
    if (fs.existsSync(pidPath) && stateOf(f).rollback?.starts) {
      const stops = eventsOf(f).filter(event => event.event === 'stop').length
      process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGTERM')
      await until(() => eventsOf(f).filter(event => event.event === 'stop').length > stops, 'held fixture child did not stop')
    }
  }
  delete f.env.SUPERVISOR_VERDICT_FAILURE
  const recovered = driver(t, f)
  await until(() => stateOf(f).phase === 'rolledBack', 'verdict did not recover')
  assert.equal(stateOf(f).rollback.starts, 2)
  assert.equal(stateOf(f).journal.undoReason, undefined)
  recovered.child.kill('SIGTERM')
  assert.equal((await recovered.exit).code, 0)
})

test('give-back health checks the page and keeps work held when the unchanged page fails', async t => {
  const f = fixture(t, { mode: 'unchanged-page-fails' })
  fakeTransport(f)
  const running = driver(t, f)
  await until(() => announced(running), 'fake child did not start')
  fs.appendFileSync(f.signed.path, '\n')
  request(f)
  assert.equal((await running.exit).code, 1)
  const state = stateOf(f)
  assert.equal(state.phase, 'manualRecovery')
  assert.equal(state.reason, 'health-failed')
  assert.equal(state.journal, undefined)
  assert.equal(previousVersion(f), FROM)
  assert.equal(boots(f).length, 1)
})

test('a service cut between the previous child spawn and its health save consumes one restart', async t => {
  const f = fixture(t, { mode: 'trial-exit' })
  fakeTransport(f)
  f.env.SUPERVISOR_CUT_AFTER = 'spawn'
  const interrupted = driver(t, f)
  await until(() => announced(interrupted), 'fake child did not start')
  request(f)
  assert.equal((await interrupted.exit).signal, 'SIGKILL')
  const cut = stateOf(f)
  assert.equal(cut.phase, 'rollingBack')
  assert.equal(cut.rollback.step, 'restart')
  assert.equal(cut.rollback.starts, 1)
  assert.equal(cut.rollback.failures, undefined)
  assert.equal(previousVersion(f), FROM)
  delete f.env.SUPERVISOR_CUT_AFTER
  const recovered = driver(t, f)
  await until(() => stateOf(f).phase === 'rolledBack', 'rollback did not recover')
  assert.equal(stateOf(f).rollback.starts, 2)
  assert.equal(stateOf(f).rollback.failures, undefined)
  assert.equal(previousVersion(f), FROM)
  recovered.child.kill('SIGTERM')
  assert.equal((await recovered.exit).code, 0)
})

test('a public launch URL with the patched 401 verifies its listener and can update', async t => {
  const f = fixture(t)
  f.env.SUPERVISOR_PATCHED_401 = '1'
  const port = await unusedLoopbackPort()
  const publicUrl = 'https://example.invalid/web/'
  f.command.splice(f.command.indexOf('--host'), 4, '--port=' + port, '--public-url', publicUrl)
  const running = driver(t, f)
  await until(() => announced(running), 'DSH did not announce its public URL')
  const listener = join(f.store, 'listener.json')
  await until(() => read(listener).listener !== 'unknown', 'the public listener was not checked')
  assert.deepEqual(read(listener), { version: 1, bootId: supervisorOf(f).bootId, listener: 'verified-argv' })
  request(f)
  await until(
    () => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy',
    'update did not become healthy',
  )
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
})
