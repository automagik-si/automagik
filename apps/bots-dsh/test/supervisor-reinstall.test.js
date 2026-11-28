import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installCopy, refreshCopy, reinstallCopies } from '../src/host/supervisor/copy.js'
import { runSupervisor } from '../src/host/supervisor/main.js'
import { requestOf } from '../src/host/supervisor/request.js'
import { writeJsonAtomic } from '../src/host/supervisor/store.js'
import { validJournal } from '../src/host/supervisor/switch.js'
import { selfUpdateStatus } from '../src/host/self-update.js'
import { runOf as runOf5b } from './fixtures/supervisor-5b/supervisor/records.js'
import { validJournal as oldJournal } from './fixtures/supervisor-5b/supervisor/switch.js'
import { runOf as runOf6 } from './fixtures/supervisor-6/supervisor/records.js'
import { frozen6Bytes } from './fixtures/supervisor-6.mjs'
import { healthReply } from './fixtures/supervisor-health-wire.mjs'
import { BOTS, digest, eventsOf, fixture, FROM, HOST, read, REGISTRY, TO, WELCOME, write } from './fixtures/supervisor.mjs'

const here = fileURLToPath(import.meta.url)
const frozen5b = fileURLToPath(new URL('./fixtures/supervisor-5b/', import.meta.url))
const holdFixture = new URL('./fixtures/supervisor-reinstall-hold.mjs', import.meta.url).href
const older = '3.160.1'
const team = { version: 2, revision: 3, note: 'preserve me' }
const marker = 'src/host/test-reinstall-marker'
const stateOf = f => read(join(f.store, 'state.json'))
const currentOf = f => read(join(f.store, 'current.json'))
const activeBytes = f => fs.readFileSync(join(f.profileDir, 'node_modules', BOTS, marker), 'utf8')
const has = fs.existsSync
const verdicts = ['healthy', 'rolledBack', 'notUpdated', 'manualRecovery']

if (process.env.REINSTALL_FIXTURE_DRIVER) {
  const options = JSON.parse(process.env.REINSTALL_FIXTURE_DRIVER)
  const { home, profile } = options
  const store = join(home, 'update', profile)
  const profileDir = join(home, 'profiles', profile)
  const statePath = join(store, 'state.json')
  const currentPath = join(store, 'current.json')
  const teamPath = join(process.env.AUTOMAGIK_BOTS_HOME, 'state.json')
  const { REINSTALL_CUT: cut, REINSTALL_FAIL_VERDICT: fail, REINSTALL_FAULT: fault, SUPERVISOR_FIXTURE: root } = process.env
  let lostTeam = false
  let previousState
  const record = event => fs.appendFileSync(join(root, 'events.jsonl'), JSON.stringify(event) + '\n')
  const hit = point => { if (cut === point) process.kill(-process.pid, 'SIGKILL') }
  if (process.env.REINSTALL_NO_DISK_SPACE) {
    const statfs = fs.statfsSync
    fs.statfsSync = (path, ...args) => {
      if (!path.startsWith(join(store, 'stage-'))) return statfs(path, ...args)
      assert.equal(fs.readFileSync(join(profileDir, 'package.json.lock'), 'utf8'), `${process.pid}\n`)
      record({ event: 'stage-space-checked' })
      return { bavail: 0, bsize: 4096 }
    }
  }
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === statePath) {
      const next = read(from)
      if (next.phase === fail) throw new Error('fixture verdict write failed')
      if (next.phase === 'notUpdated') hit('before-notUpdated')
      rename(from, to)
      if (verdicts.includes(next.phase)) hit(next.phase)
      if (next.phase === 'health') hit('trial-health')
      if (next.journal?.pending && next.journal.pending !== previousState?.journal?.pending) {
        hit('pending:' + next.journal.pending)
      }
      if (next.journal?.done.length > (previousState?.journal?.done.length ?? 0)) hit('done:' + next.journal.done.at(-1))
      if (next.journal?.relinked && !previousState?.journal?.relinked) hit('relinked')
      if (next.journal?.commitCurrent && !previousState?.journal?.commitCurrent) hit('commitCurrent')
      previousState = next
      return
    }
    if (to.startsWith(join(store, 'reinstall-trash') + '/')) {
      hit('before-trash')
      rename(from, to)
      hit('after-trash')
      return
    }
    rename(from, to)
    if (to === currentPath) hit('current')
    if (to === teamPath && previousState?.phase === 'rollingBack') hit('restored-data')
    if (previousState?.phase === 'switching' && previousState.journal?.pending) {
      // The pending save names the move even when install-entries writes through a sibling temp file.
      if (to !== currentPath) hit('rename:' + previousState.journal.pending)
    }
    if (previousState?.phase === 'rollingBack' || previousState?.journal?.undo === true) {
      const j = previousState.journal
      const step = j.pending ?? j.done.at(-1)
      const staged = join(store, 'stage-' + previousState.runId, 'profiles', profile)
      const destination = {
        'install-modules': join(staged, 'node_modules'),
        'install-entries': join(profileDir, 'package.json'),
        'install-lockfile': join(staged, 'pnpm-lock.yaml'),
        'keep-lockfile': join(profileDir, 'pnpm-lock.yaml'),
        'keep-modules': join(profileDir, 'node_modules'),
      }[step]
      if (to === destination || step?.startsWith('keep-archive:')
        && to === join(profileDir, 'vendor/automagik-update', step.slice('keep-archive:'.length))) hit('reverse:' + step)
    }
  }
  const fetch = async url => {
    if (url === REGISTRY + '-/ping') return new Response('{}')
    const archives = read(join(root, 'fixture-tarballs.json'))
    if (!Object.hasOwn(archives, url)) throw new Error('unexpected fixture fetch')
    return new Response(Buffer.from(archives[url], 'base64'))
  }
  const healthProbe = async (url, { cookie, payload } = {}) => {
    const run = read(statePath)
    const plugin = join(profileDir, 'node_modules', BOTS)
    const previous = fs.readFileSync(join(plugin, marker), 'utf8') === 'broken'
    const candidate = !previous && run.phase === 'health'
    if (fault === 'team-lost' && candidate && !lostTeam) {
      lostTeam = true
      fs.unlinkSync(teamPath)
    }
    const present = has(teamPath)
    if (payload?.endpoint === 'state') record({ event: 'reinstall-team-probe', candidate, present })
    const names = Object.keys(read(join(profileDir, 'package.json')).dependencies).filter(name => name.startsWith('@automagik/'))
    return healthReply({
      url, headers: { cookie }, payload, run: run.runId, present, bots: present && read(teamPath).note ? 1 : 0,
      plugins: names.map(name => ({
        name, version: read(join(profileDir, 'node_modules', name, 'package.json')).version,
        loaded: fault !== 'plugin-unloaded' || name !== BOTS,
      })),
      fault: fault === 'page' && candidate ? 'page' : undefined,
    })
  }
  process.exitCode = await runSupervisor({ ...options, fetch, healthProbe, healthTimeout: { first: 1500, second: 400 } })
} else {
  function bench(t, { kept = false, mode } = {}) {
    const f = fixture(t, { mode })
    const host = join(f.profileDir, 'node_modules', BOTS, 'src/host')
    fs.cpSync(HOST, host, { recursive: true })
    const temporaryHost = join(f.root, 'installed-host')
    fs.cpSync(HOST, temporaryHost, { recursive: true })
    fs.writeFileSync(join(host, 'test-reinstall-marker'), 'broken')
    fs.writeFileSync(join(temporaryHost, 'test-reinstall-marker'), 'repaired')
    f.env.SUPERVISOR_HOST_SOURCE = temporaryHost
    f.env.SUPERVISOR_ANNOUNCE_ONLY = '1'
    f.env.AUTOMAGIK_SUPERVISOR_REINSTALL = 'inherited-boot-id'
    f.command[f.command.indexOf('--port') + 1] = '3080'
    const dsh = f.command[1]
    fs.writeFileSync(dsh, fs.readFileSync(dsh, 'utf8').replace("event: 'boot', args", "event: 'boot', reinstall: process.env.AUTOMAGIK_SUPERVISOR_REINSTALL, args") + `
if (action === 'web' && mode !== 'exit' && process.env.REINSTALL_HOLD_FIXTURE) {
  const { observeHeldTurn } = await import(process.env.REINSTALL_HOLD_FIXTURE)
  await observeHeldTurn(profile, record)
}
`)
    write(join(f.botsHome, 'state.json'), team)
    f.currentPath = join(f.store, 'current.json')
    f.prior = { version: 1, live: { version: FROM, sequence: 42 }, kept: { version: older }, lastSequence: 42 }
    if (kept) {
      fs.mkdirSync(join(f.store, 'versions', older), { recursive: true })
      fs.writeFileSync(join(f.store, 'versions', older, 'kept-file'), 'kept release')
      write(f.currentPath, f.prior)
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keys = [{ keyId: 'fixture-reinstall', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }]
    const pathname = join(f.root, 'lane.json')
    const packages = {}, archives = {}
    const plugin = (name, version, contents = version + ' ' + name) => {
      const bytes = Buffer.from(contents)
      const sha256 = digest('sha256', bytes)
      const url = 'https://github.com/example/reinstall/' + sha256 + '.tgz'
      packages[sha256] = { name, version }
      archives[url] = bytes.toString('base64')
      return { name, version, url, size: bytes.length, sha256, integrity: 'sha512-' + digest('sha512', bytes, 'base64'),
        engines: { dsh: '>=0.2.2-rc.1' } }
    }
    const equal = plugin(BOTS, FROM)
    const newer = plugin(BOTS, TO)
    const altered = plugin(BOTS, FROM, 'changed signed tarball')
    const welcome = plugin(WELCOME, FROM)
    f.env.SUPERVISOR_PACKAGES = JSON.stringify(packages)
    write(join(f.root, 'fixture-tarballs.json'), archives)
    f.installHost = host
    f.equal = equal
    f.newer = newer
    f.altered = altered
    f.welcome = welcome
    f.intent = { version: FROM, sequence: 42, plugins: [{ name: BOTS, sha256: equal.sha256 }] }
    f.publish = ({ version = FROM, sequence = 42, plugins = [equal] } = {}) => {
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, keyId: keys[0].keyId, version, sequence, plugins }))
      fs.writeFileSync(pathname, bytes)
      fs.writeFileSync(pathname + '.sig', sign(null, bytes, privateKey).toString('base64'))
    }
    f.publish()
    f.signaturePath = pathname + '.sig'
    f.env.REINSTALL_FIXTURE_DRIVER = JSON.stringify({
      home: f.home, profile: f.profile, command: f.command, version: FROM, laneUrl: pathToFileURL(pathname).href, keys,
    })
    return f
  }

  async function until(readValue, message) {
    for (let i = 0; i < 400; i++) {
      const result = readValue()
      if (result) return result
      await wait(20)
    }
    assert.fail(message)
  }

  async function driver(t, f, options = {}) {
    let output = ''
    const count = eventsOf(f).filter(e => e.event === 'boot').length
    const child = spawn(process.execPath, ['--import', './test/harness-resolve.mjs', here], {
      env: { ...f.env, ...options }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    t.after(async () => {
      if (child.signalCode === null && child.exitCode === null) child.kill('SIGTERM')
      await exit
    })
    return {
      exit, child, output: () => output,
      boot: () => until(() => eventsOf(f).filter(e => e.event === 'boot')[count], 'fixture DSH did not boot'),
    }
  }

  function expectExit(driver) {
    return Promise.race([driver.exit, wait(10_000, undefined, { ref: false }).then(() => {
      assert.fail('fixture supervisor did not exit: ' + driver.output())
    })])
  }

  function request(f, boot, reinstall = f.intent) {
    const requestId = f.env.REINSTALL_HELD_REQUEST ?? 'request-' + Date.now()
    writeJsonAtomic(join(f.store, 'request.json'), {
      version: 1, requestId, bootId: boot.boot, requestedAt: new Date().toISOString(),
      ...(reinstall === false ? {} : { reinstall }),
    }, { profileDir: f.profileDir })
    return requestId
  }

  const terminal = (f, id) => until(() => {
    const path = join(f.store, 'state.json')
    if (!has(path)) return
    const state = stateOf(f)
    if (state.requestId === id && verdicts.includes(state.phase)) return state
  }, 'fixture did not record a verdict')
  const clean = (f, run) => until(() =>
    !has(join(f.store, 'reinstall', run.runId)) && !has(join(f.store, 'reinstall-trash', run.runId)), 'backup not disposed')

  function holdOwnerTurn(f) {
    f.env.REINSTALL_HOLD_FIXTURE = holdFixture
    f.env.REINSTALL_HELD_REQUEST = 'held-reinstall-request'
  }

  const waitTurn = (f, event, match) => until(
    () => eventsOf(f).find(entry => entry.event === event && match(entry)), 'fixture did not record ' + event)

  const statusFor = (f, boot) => selfUpdateStatus({ profileDir: f.profileDir, inDesktop: false, env: {
    AUTOMAGIK_SUPERVISOR_BOOT: boot.boot, AUTOMAGIK_SUPERVISOR_VERSION: FROM,
  } })

  function assertLegacyRefusal(verdict, reason) {
    assert.equal(verdict.reason, reason)
    for (const legacy of [runOf5b, runOf6]) {
      const readRun = legacy(verdict, [verdict.bootId])
      assert.equal(readRun?.phase, 'notUpdated')
      assert.equal(readRun.requestId, verdict.requestId)
    }
  }

  async function assertOwnerTurnResumes(f, id) {
    await waitTurn(f, 'turn-resumed', event => event.requestId === id)
    assert.ok(eventsOf(f).some(event => event.event === 'update-work-resumed' && event.requestId === id))
    assert.equal(eventsOf(f).filter(event => event.event === 'boot').length, 1)
  }

  test('first use repairs the installed tree and a trial failure restores its original bytes', async t => {
    for (const fault of [undefined, 'page', 'team-lost']) await t.test(fault ?? 'healthy', async t => {
      const f = bench(t)
      await installCopy(f.store, f.installHost)
      const run = await driver(t, f, { REINSTALL_FAULT: fault })
      const boot = await run.boot()
      assert.equal(boot.reinstall, boot.boot)
      assert.equal(has(f.currentPath), false)
      assert.equal(has(join(f.store, 'versions')), false)
      const result = await terminal(f, request(f, boot))
      assert.equal(result.phase, fault ? 'rolledBack' : 'healthy', JSON.stringify({ result, output: run.output() }))
      assert.equal(result.reinstall, true)
      assert.equal(result.journal.keep, 'reinstall/' + result.runId)
      assert.equal(result.journal.relinked, true)
      const boots = eventsOf(f).filter(event => event.event === 'boot')
      assert.deepEqual(boots.map(event => event.activationCompare),
        fault ? [undefined, `${boot.boot}:${result.runId}`, undefined] : [undefined, `${boot.boot}:${result.runId}`])
      assert.equal(activeBytes(f), fault ? 'broken' : 'repaired')
      assert.equal(has(join(f.store, 'versions')), false)
      if (fault) {
        assert.equal(has(f.currentPath), false)
        assert.equal(result.rollback.restoreCurrent, false)
      }
      else assert.deepEqual(currentOf(f), { ...f.prior, kept: null })
      if (fault === 'team-lost') assert.deepEqual(result.rollback.data, { restored: true, why: 'team-lost', trialKept: false })
      assert.deepEqual(read(join(f.botsHome, 'state.json')), team)
      await clean(f, result)
    })
  })

  test('reinstall trash is retried while set-aside recovery and the next upgrade keep their own trees', async t => {
    const f = bench(t, { kept: true })
    await installCopy(f.store, f.installHost)
    const recovery = join(f.store, 'reinstall/older-run-id')
    fs.mkdirSync(recovery, { recursive: true })
    fs.writeFileSync(join(recovery, 'snapshot'), 'manual recovery')
    const trash = join(f.store, 'reinstall-trash/interrupted-run')
    fs.mkdirSync(trash, { recursive: true })
    fs.writeFileSync(join(trash, 'partial-removal'), 'disposable')
    const proc = await driver(t, f)
    const boot = await proc.boot()
    for (let i = 0; i < 2; i++) {
      const run = await terminal(f, request(f, boot))
      assert.equal(run.phase, 'healthy', proc.output())
      assert.equal(activeBytes(f), 'repaired')
      assert.deepEqual(currentOf(f), f.prior)
      assert.equal(fs.readFileSync(join(recovery, 'snapshot'), 'utf8'), 'manual recovery')
      assert.equal(fs.readFileSync(join(f.store, 'versions', older, 'kept-file'), 'utf8'), 'kept release')
      assert.equal(has(trash), false)
      await clean(f, run)
    }
    f.publish({ version: TO, sequence: 43, plugins: [f.newer] })
    const upgrade = await terminal(f, request(f, boot, false))
    assert.equal(upgrade.phase, 'healthy', proc.output())
    assert.equal(upgrade.reinstall, undefined)
    assert.equal(upgrade.journal.keep, 'versions/' + FROM)
    assert.equal(fs.readFileSync(join(f.store, 'versions', FROM, 'node_modules', BOTS, marker), 'utf8'), 'repaired')
    assert.deepEqual(currentOf(f).kept, { version: FROM })
    assert.equal(eventsOf(f).filter(e => e.event === 'boot').every(e => e.boot === boot.boot), true)
  })

  for (const [name, change, reason] of [
    ['both profile and lane advanced to Y', f => {
      write(join(f.profileDir, 'node_modules', BOTS, 'package.json'), { name: BOTS, version: TO })
      f.publish({ version: TO, sequence: 43, plugins: [f.newer] })
    }, 'release-changed'],
    ['sequence changed', f => f.publish({ sequence: 43 }), 'release-changed'],
    ['lower sequence', f => f.publish({ sequence: 41, plugins: [f.altered] }), 'sequence-lower'],
    ['signature failed', f => fs.writeFileSync(f.signaturePath, 'invalid signature'), 'signature-invalid'],
    ['the current record became invalid', f => write(f.currentPath, { version: 0 }), 'store-invalid'],
    ['same tuple with changed SHA-256', f => f.publish({ plugins: [f.altered] }), 'release-changed'],
    ['added plugin', f => {
      const manifest = join(f.profileDir, 'package.json')
      const profile = read(manifest)
      profile.dependencies[WELCOME] = '^' + FROM
      write(manifest, profile)
      const dir = join(f.profileDir, 'node_modules', WELCOME)
      fs.mkdirSync(dir, { recursive: true })
      write(join(dir, 'package.json'), { version: FROM })
      f.publish({ plugins: [f.equal, f.welcome] })
    }, 'release-changed'],
    ['removed plugin', f => {
      f.intent.plugins.push({ name: WELCOME, sha256: f.welcome.sha256 })
      f.publish({ plugins: [f.equal, f.welcome] })
    }, 'release-changed'],
  ]) test('the supervisor refuses reinstall when ' + name, async t => {
    const f = bench(t, { kept: true })
    holdOwnerTurn(f)
    await installCopy(f.store, f.installHost)
    const proc = await driver(t, f, { REINSTALL_FAULT: 'plugin-unloaded' })
    const boot = await proc.boot()
    await waitTurn(f, 'turn-held', event => event.requestId === f.env.REINSTALL_HELD_REQUEST)
    change(f)
    const id = request(f, boot)
    const verdict = await terminal(f, id)
    const run = statusFor(f, boot).run
    assert.equal(run.phase, 'notUpdated', proc.output())
    assert.equal(run.reason, reason)
    assert.equal(run.detail, reason)
    assertLegacyRefusal(verdict, reason === 'release-changed' ? 'stage-failed' : reason)
    await assertOwnerTurnResumes(f, id)
    assert.equal(activeBytes(f), 'broken')
    assert.equal(eventsOf(f).some(e => e.event === 'stop' || e.event === 'add'), false)
  })

  for (const [name, reason] of [
    ['insufficient disk space', 'stage-failed'],
    ['unwritable refusal sidecar', 'store-invalid'],
    ['near-limit invalid current record', 'store-invalid'],
  ]) test('an early reinstall refusal releases the held turn after ' + name, async t => {
    const f = bench(t, { kept: true })
    holdOwnerTurn(f)
    await installCopy(f.store, f.installHost)
    const sidecar = join(f.store, 'reinstall-refusal.json')
    const noSpace = name === 'insufficient disk space'
    const blockedSidecar = name === 'unwritable refusal sidecar'
    const proc = await driver(t, f, {
      REINSTALL_FAULT: 'plugin-unloaded', ...(noSpace ? { REINSTALL_NO_DISK_SPACE: '1' } : {}),
    })
    const boot = await proc.boot()
    await waitTurn(f, 'turn-held', event => event.requestId === f.env.REINSTALL_HELD_REQUEST)
    if (blockedSidecar) {
      fs.mkdirSync(sidecar)
      write(f.currentPath, { version: 0 })
    } else if (!noSpace) {
      writeJsonAtomic(f.currentPath, { version: 0, padding: 'x'.repeat(64 * 1024 - 64) }, {
        profileDir: f.profileDir, durable: true,
      })
    }

    const id = request(f, boot)
    const verdict = await terminal(f, id)
    assertLegacyRefusal(verdict, reason)
    const status = statusFor(f, boot)
    assert.equal(status.run.phase, 'notUpdated', proc.output())
    assert.equal(status.run.reason, reason)
    if (blockedSidecar) {
      assert.ok(fs.lstatSync(sidecar).isDirectory())
      assert.equal(status.problem, 'Invalid current.json')
      assert.equal(status.run.detail, undefined)
    } else {
      assert.equal(status.run.detail, reason)
    }
    if (!noSpace && !blockedSidecar) assert.equal(verdict.priorCurrent, null)
    await assertOwnerTurnResumes(f, id)
    const events = eventsOf(f)
    if (noSpace) assert.equal(events.filter(event => event.event === 'stage-space-checked').length, 1)
    assert.equal(events.filter(event => event.event === 'update-work-resumed' && event.requestId === id).length, 1)
    assert.equal(events.filter(event => event.event === 'turn-resumed' && event.requestId === id).length, 1)
    assert.equal(events.some(event => event.event === 'stop' || event.event === 'add'), false)
    assert.equal(activeBytes(f), 'broken')
  })

  for (const [name, change, reason] of [
    ['a missing pnpm lockfile', f => fs.unlinkSync(join(f.profileDir, 'pnpm-lock.yaml')), 'stage-failed'],
    ['installed build metadata too large for the checking record', f => {
      const version = FROM + '+' + 'x'.repeat(64 * 1024 - 128)
      write(join(f.profileDir, 'node_modules', BOTS, 'package.json'), { name: BOTS, version })
    }, 'profile-invalid'],
  ]) test('reinstall refuses before stopping the child after ' + name, async t => {
    const f = bench(t, { kept: true })
    holdOwnerTurn(f)
    await installCopy(f.store, f.installHost)
    const proc = await driver(t, f, { REINSTALL_FAULT: 'plugin-unloaded' })
    const boot = await proc.boot()
    await waitTurn(f, 'turn-held', event => event.requestId === f.env.REINSTALL_HELD_REQUEST)
    change(f)
    const id = request(f, boot)
    const verdict = await terminal(f, id)
    assertLegacyRefusal(verdict, reason)
    const { run } = statusFor(f, boot)
    assert.equal(run.phase, 'notUpdated', proc.output())
    assert.equal(run.detail, reason)
    await assertOwnerTurnResumes(f, id)
    const events = eventsOf(f)
    assert.equal(events.filter(event => event.event === 'update-work-resumed' && event.requestId === id).length, 1)
    assert.equal(events.filter(event => event.event === 'turn-resumed' && event.requestId === id).length, 1)
    assert.equal(events.some(event => ['stop', 'add', 'reinstall-team-probe'].includes(event.event)), false)
    assert.equal(activeBytes(f), 'broken')
    assert.deepEqual(currentOf(f), f.prior)
    proc.child.kill('SIGTERM')
    await proc.exit
  })

  test('five-key requests are strict and never survive a boot change', t => {
    const f = bench(t)
    const boot = 'fixture-boot'
    const ordinary = { version: 1, requestId: 'owner-request', bootId: boot, requestedAt: new Date().toISOString() }
    assert.deepEqual(requestOf(ordinary, boot), ordinary)
    const extra = { ...ordinary, reinstall: f.intent }
    assert.deepEqual(requestOf(extra, boot), extra)
    assert.equal(requestOf(extra, 'different-boot'), null)
    for (const reinstall of [false, true, {}, {
      ...f.intent, plugins: [f.intent.plugins[0], f.intent.plugins[0]],
    }, { ...f.intent, extra: false }, { ...f.intent, plugins: [{ ...f.intent.plugins[0], untrusted: true }] }]) {
      assert.equal(requestOf({ ...ordinary, reinstall }, boot), null)
    }
    assert.equal(requestOf({ ...ordinary, unrelated: true }, boot), null)
  })

  const steps = ['keep-modules', 'keep-archive:' + 'a'.repeat(64) + '.tgz',
    'keep-lockfile', 'install-lockfile', 'install-entries', 'install-modules']
  const cuts = [
    ...steps.flatMap(step => ['pending:', 'rename:', 'done:'].map(point => [point + step])),
    ...steps.map(step => ['reverse:' + step, 'page']),
    ['relinked'], ['relinked', undefined, undefined, 'bad-link'],
    ['commitCurrent'], ['current'], ['healthy'], ['rolledBack', 'page'], ['restored-data', 'team-lost'],
    ['before-trash'], ['after-trash'], ['before-notUpdated', undefined, 'relink-fails'],
    ['notUpdated', undefined, 'relink-fails'], ['before-trash', undefined, 'relink-fails'], ['after-trash', undefined, 'relink-fails'],
  ]
  test('reinstall cuts preserve the correct tree and replay through disposal', { concurrency: 3 }, async t => {
    await Promise.all(cuts.map(([cut, fault, mode, afterCut]) => t.test([cut, mode ?? fault, afterCut].filter(Boolean).join(' '), async t => {
      const f = bench(t, { kept: true, mode })
      await installCopy(f.store, f.installHost)
      const first = await driver(t, f, { REINSTALL_CUT: cut, REINSTALL_FAULT: fault })
      const id = request(f, await first.boot())
      assert.deepEqual(await expectExit(first), { code: null, signal: 'SIGKILL' }, first.output())
      const interrupted = stateOf(f)
      assert.equal(validJournal(interrupted), true)
      if (cut === 'before-notUpdated') {
        assert.equal(has(join(f.store, interrupted.journal.keep, 'data.json')), true)
        assert.equal(activeBytes(f), 'broken')
      }
      if (cut === 'done:install-modules') {
        assert.equal(interrupted.journal.relinked, undefined)
        assert.equal(currentOf(f).live.version, FROM)
        assert.equal(eventsOf(f).some(e => e.event === 'install' && e.live), false)
      }
      if (afterCut === 'bad-link') {
        assert.equal(interrupted.phase, 'switching')
        assert.equal(interrupted.journal.relinked, true)
        assert.equal(activeBytes(f), 'repaired')
        fs.symlinkSync(join(f.store, 'stage-' + interrupted.runId, 'target'), join(f.profileDir, 'node_modules/invalid-link'))
      }
      const second = await driver(t, f, {
        REINSTALL_FAULT: fault, ...(afterCut === 'bad-link' ? { REINSTALL_HOLD_FIXTURE: holdFixture } : {}),
      })
      const result = await terminal(f, id)
      const stillOriginal = cut.startsWith('pending:') || ((cut.startsWith('done:') || cut.startsWith('rename:'))
        && !cut.endsWith('install-modules'))
      const phase = fault ? 'rolledBack' : stillOriginal || mode || afterCut ? 'notUpdated' : 'healthy'
      assert.equal(result.phase, phase, second.output())
      assert.equal(activeBytes(f), phase === 'healthy' ? 'repaired' : 'broken')
      assert.deepEqual(currentOf(f), f.prior)
      assert.deepEqual(read(join(f.botsHome, 'state.json')), team)
      if (cut === 'done:install-modules') assert.ok(eventsOf(f).some(e => e.event === 'install' && e.live))
      if (cut === 'before-notUpdated') assert.ok(eventsOf(f).filter(e => e.event === 'reinstall-team-probe' && !e.candidate).length >= 2)
      if (afterCut === 'bad-link') {
        assert.equal(result.reason, 'stage-failed')
        assert.equal(result.journal.undo, true)
        assert.equal(has(join(f.profileDir, 'node_modules/invalid-link')), false)
        const matchesRun = event => event.runId === result.runId
        await waitTurn(f, 'turn-held', matchesRun)
        await waitTurn(f, 'turn-resumed', matchesRun)
        assert.equal(eventsOf(f).filter(event => event.event === 'boot').length, 2)
      }
      await clean(f, result)
      // Stop the recovery child before the fixture removes its home.
      second.child.kill('SIGTERM')
      await second.exit
    })))
  })

  test('a cut after publishing current still allows rollback on the next health check', async t => {
    const f = bench(t)
    await installCopy(f.store, f.installHost)
    const first = await driver(t, f, { REINSTALL_CUT: 'current' })
    const id = request(f, await first.boot())
    assert.deepEqual(await expectExit(first), { code: null, signal: 'SIGKILL' })
    const interrupted = stateOf(f)
    assert.equal(interrupted.journal.commitCurrent, true)
    assert.equal(has(join(f.store, interrupted.journal.keep, 'data.json')), true)
    assert.equal(has(f.currentPath), true)
    assert.equal(activeBytes(f), 'repaired')
    await driver(t, f, { REINSTALL_FAULT: 'page' })
    const result = await terminal(f, id)
    assert.equal(result.phase, 'rolledBack')
    assert.equal(has(f.currentPath), false)
    assert.equal(activeBytes(f), 'broken')
    const [steady, originalTrial, replayTrial, previous] = eventsOf(f).filter(event => event.event === 'boot')
    assert.equal(steady.activationCompare, undefined)
    assert.equal(originalTrial.activationCompare, `${interrupted.bootId}:${result.runId}`)
    assert.notEqual(result.bootId, interrupted.bootId)
    assert.equal(replayTrial.activationCompare, `${result.bootId}:${result.runId}`)
    assert.equal(previous.activationCompare, undefined)
    await clean(f, result)
  })

  test('recovery relinks before re-entering early trial health without a durable relink flag', async t => {
    const f = bench(t)
    await installCopy(f.store, f.installHost)
    const first = await driver(t, f, { REINSTALL_CUT: 'trial-health' })
    const id = request(f, await first.boot())
    assert.deepEqual(await expectExit(first), { code: null, signal: 'SIGKILL' })
    const interrupted = stateOf(f)
    assert.equal(interrupted.journal.relinked, true)
    delete interrupted.journal.relinked
    write(join(f.store, 'state.json'), interrupted)
    const installs = () => eventsOf(f).filter(e => e.event === 'install' && e.live).length
    const before = installs()
    await driver(t, f)
    const result = await terminal(f, id)
    assert.equal(result.phase, 'healthy')
    assert.equal(installs(), before + 1)
    await clean(f, result)
  })

  test('recovery rolls back a relinked health trial with a live link into staging', async t => {
    const f = bench(t, { kept: true })
    await installCopy(f.store, f.installHost)
    const first = await driver(t, f, { REINSTALL_CUT: 'trial-health' })
    const id = request(f, await first.boot())
    assert.deepEqual(await expectExit(first), { code: null, signal: 'SIGKILL' })
    const interrupted = stateOf(f)
    assert.equal(interrupted.phase, 'health')
    assert.equal(interrupted.journal.relinked, true)
    assert.equal(activeBytes(f), 'repaired')
    const target = join(f.store, 'stage-' + interrupted.runId, 'lazy-file')
    const link = join(f.profileDir, 'node_modules/invalid-link')
    fs.writeFileSync(target, 'staged content')
    fs.symlinkSync(target, link)

    const second = await driver(t, f)
    const result = await terminal(f, id)
    assert.equal(result.phase, 'rolledBack', second.output())
    assert.equal(result.rollback.failed, 'plugins')
    assert.equal(result.rollback.starts, 1)
    assert.equal(activeBytes(f), 'broken')
    assert.equal(has(link), false)
    assert.deepEqual(currentOf(f), f.prior)
    const recoveredBoot = await second.boot()
    assert.equal(eventsOf(f).filter(event => event.event === 'boot' && event.boot === recoveredBoot.boot).length, 1)
    await clean(f, result)
    second.child.kill('SIGTERM')
    await second.exit
  })

  test('give-back replay checks the saved team lineage before publishing its verdict', async t => {
    const f = bench(t, { mode: 'relink-fails' })
    await installCopy(f.store, f.installHost)
    const first = await driver(t, f, { REINSTALL_CUT: 'before-notUpdated' })
    const id = request(f, await first.boot())
    assert.deepEqual(await expectExit(first), { code: null, signal: 'SIGKILL' })
    const interrupted = stateOf(f)
    assert.equal(interrupted.journal.undo, true)
    write(join(f.botsHome, 'state.json'), { ...team, revision: 1 })
    await driver(t, f)
    const result = await terminal(f, id)
    assert.equal(result.phase, 'manualRecovery')
    assert.equal(activeBytes(f), 'broken')
    assert.equal(has(join(f.store, result.journal.keep, 'data.json')), true)
    assert.equal(has(join(f.store, 'reinstall-trash', result.runId)), false)
  })

  test('a failed give-back verdict write keeps the undone journal and snapshot for replay', async t => {
    const f = bench(t, { mode: 'relink-fails' })
    await installCopy(f.store, f.installHost)
    const proc = await driver(t, f, { REINSTALL_FAIL_VERDICT: 'notUpdated' })
    const id = request(f, await proc.boot())
    assert.equal((await expectExit(proc)).code, 1, proc.output())
    assert.equal(stateOf(f).journal.undo, true)
    assert.equal(has(join(f.store, stateOf(f).journal.keep, 'data.json')), true)
    assert.equal(activeBytes(f), 'broken')
    const pid = Number(fs.readFileSync(join(f.root, 'dsh-child-pid')))
    try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await driver(t, f)
    const run = await terminal(f, id)
    assert.equal(run.phase, 'notUpdated')
    await clean(f, run)
  })

  function copyFrozen5b(root, version = FROM) {
    fs.cpSync(frozen5b, root, { recursive: true })
    write(join(root, 'package.json'), { type: 'module' })
    write(join(root, 'version.json'), { version })
  }

  test('capability follows the stored slots through two healthy copy rotations', async t => {
    const f = bench(t)
    const root = join(f.store, 'supervisor')
    const current = join(root, 'current')
    const kept = join(root, 'kept')
    await installCopy(f.store, f.installHost)
    assert.equal(reinstallCopies(f.store), true)
    fs.rmSync(current, { recursive: true })
    copyFrozen5b(current, older)
    await refreshCopy(f.store, f.profileDir, FROM)
    assert.equal(reinstallCopies(f.store), false)
    const initial = await driver(t, f)
    assert.equal((await initial.boot()).reinstall, undefined)
    initial.child.kill('SIGTERM')
    await initial.exit
    const next = join(f.profileDir, 'node_modules', BOTS, 'package.json')
    write(next, { version: TO })
    await refreshCopy(f.store, f.profileDir, TO)
    assert.equal(reinstallCopies(f.store), true)
    assert.equal(read(join(kept, 'version.json')).version, FROM)
    const ready = await driver(t, f)
    const boot = await ready.boot()
    assert.equal(boot.reinstall, boot.boot)
  })

  test('the capability recheck gives work back before stopping DSH and frozen 5b and delivery 6 copies can boot', async t => {
    const f = bench(t)
    const root = join(f.store, 'supervisor')
    holdOwnerTurn(f)
    await installCopy(f.store, f.installHost)
    const proc = await driver(t, f, { REINSTALL_FAULT: 'plugin-unloaded' })
    const boot = await proc.boot()
    assert.equal(boot.reinstall, boot.boot)
    await waitTurn(f, 'turn-held', event => event.requestId === f.env.REINSTALL_HELD_REQUEST)
    copyFrozen5b(join(root, 'kept'))
    const id = request(f, boot)
    const run = await terminal(f, id)
    assertLegacyRefusal(run, 'stage-failed')
    await assertOwnerTurnResumes(f, id)
    assert.equal(run.phase, 'notUpdated')
    assert.equal(run.reason, 'stage-failed')
    assert.equal(run.detail, undefined)
    assert.equal(eventsOf(f).some(e => e.event === 'stop'), false)
    const status = statusFor(f, boot)
    assert.equal(status.run.detail, 'reinstall-unsupported')
    proc.child.kill('SIGTERM')
    await proc.exit
    fs.rmSync(join(root, 'current'), { recursive: true })
    const fallback = frozenLauncher(f)
    const kept = join(root, 'kept')
    for (const version of ['5b', '6']) {
      if (version === '6') {
        fs.rmSync(kept, { recursive: true })
        const inventory = frozenHostFile('supervisor/files.json')
        assert.equal(inventory.status, 0)
        for (const file of JSON.parse(inventory.stdout)) {
          const blob = frozenHostFile(file)
          assert.equal(blob.status, 0, file)
          const path = join(kept, file)
          fs.mkdirSync(dirname(path), { recursive: true })
          fs.writeFileSync(path, blob.stdout)
        }
        write(join(kept, 'package.json'), { type: 'module' })
        write(join(kept, 'version.json'), { version: FROM })
      }
      const result = launchFrozen(fallback, f)
      assert.equal(result.status, 23, result.stderr)
      assert.equal(eventsOf(f).filter(e => e.event === 'boot').at(-1).version, FROM)
    }
  })

  function frozenHostFile(file) {
    const path = fileURLToPath(new URL('./fixtures/supervisor-6/' + file, import.meta.url))
    const result = spawnSync('cat', [path])
    if (result.status === 0) frozen6Bytes(file, result.stdout)
    return result
  }

  function launchFrozen(path, f, env = {}) {
    return spawnSync(path, ['--dsh-home', f.home, '--profile', f.profile, '--', ...f.command],
      { env: { ...f.env, ...env, SUPERVISOR_MODE: 'exit' }, encoding: 'utf8', timeout: 5000 })
  }

  function frozenLauncher(f) {
    const path = join(f.root, 'delivery-6-launcher.sh')
    fs.writeFileSync(path, frozen6Bytes('supervisor/launcher.sh'), { mode: 0o700 })
    return path
  }

  test('a capable kept copy can boot with capability only when the current slot is also capable', async t => {
    const f = bench(t)
    const launcher = frozenLauncher(f)
    await installCopy(f.store, f.installHost)
    const current = join(f.store, 'supervisor/current')
    const kept = join(f.store, 'supervisor/kept')
    fs.cpSync(current, kept, { recursive: true })
    write(join(kept, 'version.json'), { version: older })
    fs.writeFileSync(join(current, 'supervisor/main.js'), 'broken %% syntax')
    for (const capable of [true, false]) {
      if (!capable) fs.rmSync(join(current, 'supervisor/capabilities.json'))
      const result = launchFrozen(launcher, f)
      assert.equal(result.status, 23, result.stderr)
      const boot = eventsOf(f).filter(e => e.event === 'boot').at(-1)
      assert.equal(boot.version, older)
      assert.equal(boot.reinstall, capable ? boot.boot : undefined)
    }
  })

  test('the launcher still boots from either slot when the other cannot be inspected', async t => {
    const f = bench(t)
    const launcher = frozenLauncher(f)
    await installCopy(f.store, f.installHost)
    const current = join(f.store, 'supervisor/current')
    const kept = join(f.store, 'supervisor/kept')
    fs.cpSync(current, kept, { recursive: true })
    write(join(kept, 'version.json'), { version: older })
    // Inject traversal EACCES even when the tests run under an account that can bypass mode bits.
    const preload = join(f.root, 'unreadable-slot.mjs')
    fs.writeFileSync(preload, `
import fs from 'node:fs'
import { sep } from 'node:path'
for (const method of ['lstatSync', 'openSync']) {
  const original = fs[method]
  fs[method] = (path, ...args) => {
    if (String(path).startsWith(process.env.REINSTALL_UNREADABLE_SLOT + sep)) {
      throw Object.assign(new Error('fixture slot cannot be traversed'), { code: 'EACCES' })
    }
    return original(path, ...args)
  }
}
`)
    for (const [unreadable, version] of [[kept, FROM], [current, older]]) {
      const result = launchFrozen(launcher, f, {
        NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, REINSTALL_UNREADABLE_SLOT: unreadable,
      })
      assert.equal(result.status, 23, result.stderr)
      const boot = eventsOf(f).filter(event => event.event === 'boot').at(-1)
      assert.equal(boot.version, version)
      assert.equal(boot.reinstall, undefined)
    }
  })

  test('the fixed delivery 6 launcher only boots bare for completed reinstall journals', async t => {
    const f = bench(t)
    const launcher = frozenLauncher(f)
    await installCopy(f.store, f.installHost)
    const proc = await driver(t, f)
    const healthy = await terminal(f, request(f, await proc.boot()))
    await clean(f, healthy)
    proc.child.kill('SIGTERM')
    await proc.exit
    assert.equal(validJournal({ ...healthy, reinstall: undefined }), false)
    assert.equal(oldJournal(healthy), false)
    for (const phase of [...verdicts, 'switching', 'rollingBack']) {
      const { commitCurrent, ...rest } = healthy.journal
      const journal = ['rolledBack', 'notUpdated'].includes(phase)
        ? { ...rest, undo: true, done: [] } : healthy.journal
      write(join(f.store, 'state.json'), { ...healthy, phase, journal })
      for (const slot of ['current', 'kept']) {
        const dir = join(f.store, 'supervisor', slot, 'supervisor')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(join(dir, 'main.js'), 'broken %% syntax')
      }
      const result = launchFrozen(launcher, f)
      const complete = ['healthy', 'rolledBack', 'notUpdated'].includes(phase)
      assert.equal(result.status, complete ? 23 : 1, phase + ': ' + result.stderr)
      assert.equal(result.stderr.includes('update recovery state prevents starting DSH'), !complete)
    }
  })
}
