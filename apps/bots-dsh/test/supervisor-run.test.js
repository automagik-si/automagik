import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { hostname } from 'node:os'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { selfUpdateCheck } from '../src/host/self-update-check.js'
import { refreshCopy, runningCopy, SELF_CHECK_OK, SUPERVISOR_FILES } from '../src/host/supervisor/copy.js'
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
const announced = running => running.stdout().includes('token=<redacted>')

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
  const bare = launch(t, 'sh', [launcher, ...opts(f), '--', ...f.command], f.env)
  assert.equal((await bare.exit).code, 23)
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
  ['relink-staged-symlink', 'notUpdated', 'stage-failed'],
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
    await until(() => announced(running), 'fake child did not start')
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
      if (mode.startsWith('relink-')) {
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
  const completed = { op: 'switch', pending: null, steps: ['keep-modules'], done: ['keep-modules'] }
  for (const raw of [
    '{malformed', JSON.stringify({ version: 1, phase: 'switching' }),
    JSON.stringify({ version: 1, phase: 'manualRecovery' }),
    JSON.stringify({ version: 1, phase: 'healthy', journal: { ...completed, pending: 'keep-modules' } }),
    JSON.stringify({ version: 1, phase: 'notUpdated', journal: { ...completed, done: [] } }),
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
})

test('a public launch URL stays separate from the credential-free local HTTP probe', async t => {
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
    { event: 'probe', url: '/', host: '127.0.0.1:' + port },
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

for (const cut of ['after intent', 'after current.json', 'legacy current.json']) {
  test('finishes the version-record commit ' + cut + ' without relinking again', async t => {
    const f = fixture(t, { mode: 'relink-fails' })
    const previous = { version: 1, live: { version: FROM, sequence: 41 }, kept: null, lastSequence: 41 }
    const next = { version: 1, live: { version: TO, sequence: 42 }, kept: { version: FROM }, lastSequence: 42 }
    const current = join(f.store, 'current.json')
    write(current, cut === 'after intent' ? previous : next)
    await interruptedCandidate(f, run => {
      run.phase = 'health'
      run.journal.relinking = true
      if (cut !== 'legacy current.json') run.journal.commitCurrent = true
    })
    const running = driver(t, f)
    await until(() => stateOf(f).phase === 'healthy', 'version-record recovery did not finish')
    assert.deepEqual(read(current), next)
    assert.equal(stateOf(f).journal.commitCurrent, true)
    assert.equal(read(join(f.profileDir, 'node_modules', BOTS, 'package.json')).version, TO)
    assert.equal(eventsOf(f).filter(event => event.event === 'install' && event.live).length, 0)
    assert.equal(boots(f).length, 1)
    running.child.kill('SIGTERM')
    assert.equal((await running.exit).code, 0)
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
  const check = await selfUpdateCheck({
    profileDir: f.profileDir, ...f.signed, inDesktop: false, getDshVersion: () => '0.2.2-rc.2',
    env: { AUTOMAGIK_SUPERVISOR_BOOT: supervisorOf(f).bootId, AUTOMAGIK_SUPERVISOR_VERSION: FROM },
    ctx: { get: name => name === 'pluginManager' ? { registries: async () => ({ resolved: privateRegistry }) } : undefined },
    fetch: async url => {
      if (f.tarballs.has(url)) return new Response(f.tarballs.get(url))
      pings.push(url)
      assert.equal(url, privateRegistry + '-/ping')
      return new Response('{}')
    },
  })
  assert.equal(check.state, 'available')
  assert.deepEqual(pings, [privateRegistry + '-/ping'])
  request(f)
  await until(() => fs.existsSync(join(f.store, 'state.json')) && stateOf(f).phase === 'healthy', 'update did not use the private registry')
  assert.ok(eventsOf(f).find(event => event.event === 'add').args.includes('--registry=' + privateRegistry))
  running.child.kill('SIGTERM')
  assert.equal((await running.exit).code, 0)
})
