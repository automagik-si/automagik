import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import test from 'node:test'
import {
  bareDshEnv, dshArgs, imageSupervisorHost, loadImageSupervisor,
  prepareImageLaunch, prepareImageVolume, sameDirectory, refuseUnfinishedUpdate, superviseDsh,
} from '../entrypoint.mjs'
import { LAUNCH_FILE } from '../gate-view.mjs'
import { healthReport } from '../healthcheck.mjs'
import { PROFILE, profileDirOf } from '../lib.mjs'
import { updateStoreOf } from '../profile-update.mjs'
import { holdVolumeLease } from '../volume-lock.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'image-supervisor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('loads only an image supervisor with the image host capability and its package version', async t => {
  const root = fixture(t), warnings = []
  const load = seed => loadImageSupervisor(seed, message => warnings.push(message))
  assert.equal(await load(root), null)
  for (const [name, content] of [
    ['old', 'export function runSupervisor() {}'],
    ['broken', 'export const IMAGE_HOST = 1'],
    ['missing-store', 'export const IMAGE_HOST = 1; export function runSupervisor() {}'],
    ['supported', 'export const IMAGE_HOST = 1; export function runSupervisor() {}'],
  ]) {
    const bot = join(root, name, 'node_modules/@automagik/bots-dsh')
    const main = join(bot, 'src/host/supervisor/main.js')
    mkdirSync(dirname(main), { recursive: true })
    writeFileSync(main, content)
    writeFileSync(join(bot, 'package.json'), '{"version":"3.161.1","type":"module"}')
    if (name !== 'missing-store') writeFileSync(join(dirname(main), 'store.js'), 'export function usableStore(path) { return path }')
  }
  assert.equal(await load(join(root, 'old')), null)
  assert.equal(await load(join(root, 'broken')), null)
  assert.equal(await load(join(root, 'missing-store')), null)
  const supported = await load(join(root, 'supported'))
  assert.equal(typeof supported.runSupervisor, 'function')
  assert.equal(supported.usableStore('profile'), 'profile')
  assert.equal(supported.version, '3.161.1')
  assert.deepEqual(warnings, Array(4).fill("in-app update unavailable: this image's Bot team has no supervisor"))
})

test('only mode off can serve through the supervisor and unfinished updates require it', () => {
  const loaded = {}
  assert.equal(imageSupervisorHost({}, loaded), loaded)
  assert.equal(imageSupervisorHost({ AUTOMAGIK_MULTIUSER: '0' }, loaded), loaded)
  assert.equal(imageSupervisorHost({ AUTOMAGIK_MULTIUSER: '1' }, loaded), false)
  assert.equal(imageSupervisorHost({}, null), null)
  for (const mode of [{ AUTOMAGIK_MULTIUSER: '1' }, {}]) {
    const bare = imageSupervisorHost(mode, mode.AUTOMAGIK_MULTIUSER ? loaded : null)
    for (const reason of ['matching-image', 'signed-update-ahead', 'self-update-unfinished']) {
      const warnings = []
      assert.equal(refuseUnfinishedUpdate(bare, { reason, result: reason }, message => warnings.push(message)), reason === 'self-update-unfinished')
      assert.equal(warnings.length, Number(reason === 'self-update-unfinished'))
      if (warnings.length) assert.match(warnings[0], /unfinished.*server\/README\.md/)
    }
  }
  assert.equal(refuseUnfinishedUpdate(loaded, { reason: 'self-update-unfinished', result: 'self-update-unfinished' }), false)
})

test('bare launch strips only inherited supervisor capabilities', () => {
  const env = {
    DSH_HOME: '/data/dsh', AUTOMAGIK_SUPERVISOR_BOOT: 'a', AUTOMAGIK_SUPERVISOR_VERSION: 'b',
    AUTOMAGIK_SUPERVISOR_LISTENER_UNKNOWN: '0',
  }
  assert.deepEqual(bareDshEnv(env), { DSH_HOME: env.DSH_HOME })
  assert.equal(env.AUTOMAGIK_SUPERVISOR_BOOT, 'a')
})

const usableHost = { usableStore: () => true }
const volumeOptions = root => {
  const dshHome = join(root, 'dsh')
  return { dshHome, gateView: join(root, 'gate-view'), privateDirs: { DSH_HOME: dshHome } }
}

for (const [name, state, usable, code, supervised] of [
  ['absent and unusable', null, false, 0, false],
  ['done but unusable', '{"version":1,"phase":"healthy"}', false, 0, false],
  ['unfinished and unusable', '{"version":1,"phase":"health"}', false, 1, false],
  ['invalid and unusable', '{', false, 1, false],
  ['done and usable', '{"version":1,"phase":"healthy"}', true, 0, true],
  ['unfinished and usable', '{"version":1,"phase":"health"}', true, 0, true],
]) test(`selects the image launch when the update store is ${name}`, async t => {
  const volume = volumeOptions(fixture(t)), home = volume.dshHome, profile = profileDirOf(home)
  const store = updateStoreOf(profile)
  mkdirSync(profile, { recursive: true })
  mkdirSync(store, { recursive: true })
  const locks = [join(profile, 'package.json.lock'), join(store, 'update.lock')]
  for (const lock of locks) writeFileSync(lock, 'stale')
  if (state !== null) writeFileSync(join(store, 'state.json'), state)
  const host = { usableStore(path) { assert.equal(path, profile); return usable } }
  const release = await prepareImageVolume(volume)
  t.after(release)
  const warnings = []
  const launch = prepareImageLaunch(host, { target: profile }, home, message => warnings.push(message))
  assert.deepEqual(launch, { host: supervised ? host : null, code })
  assert.equal(warnings.length, Number(!supervised))
  if (!usable && code === 0) assert.deepEqual(warnings, [
    "in-app update unavailable: the update store must be on the profile's filesystem and writable",
  ])
  if (code) assert.match(warnings[0], /existing in-app update state.*server\/README\.md/)
  assert.ok(locks.every(lock => existsSync(lock) === !supervised))
})

const hostLock = '.automagik-image-supervisor.lock'
const probeLease = (dir, name = hostLock) => spawnSync('/usr/bin/flock', [
  '--nonblock', join(dir, name), process.execPath, '-e', '',
]).status
const snapshot = root => readdirSync(root, { recursive: true }).sort().map(name => {
  const path = join(root, name), stat = statSync(path)
  return [name, stat.mode, stat.mtimeMs, stat.ctimeMs, stat.isFile() ? readFileSync(path) : null]
})

test('clears only the two computed stale lock paths after the kernel lease is held', async t => {
  const volume = volumeOptions(fixture(t)), home = volume.dshHome, profile = profileDirOf(home), store = updateStoreOf(profile)
  const stale = [join(store, 'update.lock'), join(profile, 'package.json.lock')]
  const keep = [join(store, 'state.json'), join(store, 'current.json'), join(profile, 'package.json'),
    join(home, 'update', 'another-profile', 'update.lock'), join(profile, 'other.lock')]
  for (const file of [...stale, ...keep]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'previous-container' }))
  }
  await assert.rejects(prepareImageVolume({ ...volume, hold: async () => { throw new Error('volume busy') } }), /volume busy/)
  assert.ok(stale.every(existsSync))
  const release = await prepareImageVolume(volume)
  try {
    assert.equal(prepareImageLaunch(usableHost, { target: profile }, home).host, usableHost)
    for (const dir of [home, dirname(volume.gateView)]) {
      assert.equal(probeLease(dir), 1, 'a competing process cannot acquire the active lease')
    }
    assert.ok(stale.every(file => !existsSync(file)))
    assert.ok(keep.every(existsSync))
  } finally {
    release()
  }
  for (const dir of [home, dirname(volume.gateView)]) assert.equal(probeLease(dir), 0)
})

for (const firstHosts of [true, false]) {
  test(`a ${firstHosts ? 'bare' : 'supervised'} contender changes no files while a ${firstHosts ? 'supervised' : 'bare'} image holds the lease`, async t => {
    const root = fixture(t), volume = volumeOptions(root)
    const { dshHome, gateView } = volume
    const profile = profileDirOf(dshHome), store = updateStoreOf(profile)
    for (const dir of [profile, store, gateView]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{}')
    writeFileSync(join(store, 'state.json'), '{"version":1,"phase":"healthy"}')
    const start = async (host, hold) => {
      const release = await prepareImageVolume({ ...volume, hold })
      assert.equal(prepareImageLaunch(host, { target: profile }, dshHome).host, host)
      return release
    }
    const release = await start(firstHosts ? usableHost : null)
    t.after(release)
    for (const dir of [dshHome, gateView]) writeFileSync(join(dir, LAUNCH_FILE), 'winner credential')
    writeFileSync(join(gateView, 'profile-state.json'), 'winner state')
    const locks = [join(profile, 'package.json.lock'), join(store, 'update.lock')]
    for (const lock of locks) writeFileSync(lock, 'winner lock')
    const before = snapshot(root)
    let attempted = false
    await assert.rejects(start(firstHosts ? null : usableHost, async (home, name) => {
      attempted = true
      assert.equal(home, root)
      assert.equal(name, hostLock)
      assert.equal(probeLease(home, name), 1)
      assert.equal(probeLease(dshHome, name), 1)
      throw new Error('volume busy')
    }), /another server holds this volume/)
    assert.equal(attempted, true)
    const report = await healthReport({ root, dshHome, viewDir: gateView, env: {}, probe: async () => null })
    assert.deepEqual(report.dsh, { up: false, status: null })
    assert.deepEqual(snapshot(root), before)
  })
}

test('a second DSH home sharing the gate view waits for the volume lease and leaves every file intact', async t => {
  const root = fixture(t), volume = volumeOptions(root)
  const dshHome = join(root, 'second-dsh')
  mkdirSync(dshHome)
  const release = await prepareImageVolume(volume)
  t.after(release)
  writeFileSync(join(volume.gateView, LAUNCH_FILE), 'winner credential')
  writeFileSync(join(volume.gateView, 'profile-state.json'), 'winner state')
  const before = snapshot(root), attempted = []
  let settled = false
  const contender = prepareImageVolume({
    ...volume, dshHome, privateDirs: { DSH_HOME: dshHome },
    hold(dir, name) {
      attempted.push(dir)
      return holdVolumeLease(dir, name, 1)
    },
  }).finally(() => { settled = true })
  const refused = assert.rejects(contender, /another server holds this volume/)
  await wait(50)
  assert.equal(settled, false, 'the contender waits while the view is leased')
  assert.deepEqual(snapshot(root), before)
  await refused
  assert.deepEqual(attempted, [root])
  assert.deepEqual(snapshot(root), before)
})

test('a DSH home that resolves to the gate volume is refused before any lease', async t => {
  const volume = fixture(t), dshHome = join(fixture(t), 'home-link')
  symlinkSync(volume, dshHome)
  const calls = []
  await assert.rejects(prepareImageVolume({
    dshHome, gateView: join(volume, 'gate-view'), privateDirs: { DSH_HOME: dshHome },
    hold(dir, name) {
      calls.push(dir)
      return holdVolumeLease(dir, name, 1)
    },
  }), /gate-view overlaps DSH_HOME/)
  assert.deepEqual(calls, [])
})

test('a killed lease holder leaves disk locks that the replacement can clear', async t => {
  const volume = volumeOptions(fixture(t)), home = volume.dshHome, profile = profileDirOf(home), store = updateStoreOf(profile)
  const ready = join(home, 'lease-held')
  const program = `
    import { prepareImageVolume } from ${JSON.stringify(new URL('../entrypoint.mjs', import.meta.url).href)}
    import { mkdirSync, writeFileSync } from 'node:fs'
    await prepareImageVolume(${JSON.stringify(volume)})
    for (const path of [${JSON.stringify(store)}, ${JSON.stringify(profile)}]) mkdirSync(path, { recursive: true })
    const data = JSON.stringify({ pid: Number(process.argv[1]), host: 'old-hostname' })
    writeFileSync(${JSON.stringify(join(store, 'update.lock'))}, data)
    writeFileSync(${JSON.stringify(join(profile, 'package.json.lock'))}, data)
    writeFileSync(${JSON.stringify(ready)}, '')
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, String(process.pid)], {
    stdio: 'ignore',
  })
  const exit = once(child, 'exit')
  try {
    for (let i = 0; !existsSync(ready) && i < 400; i++) {
      assert.equal(child.exitCode, null, 'lease fixture exited before acquiring the lease')
      await wait(10)
    }
    assert.ok(existsSync(ready), 'lease fixture did not acquire the lease')
  } finally {
    child.kill('SIGKILL')
    await exit
  }
  const release = await prepareImageVolume(volume)
  try {
    assert.equal(prepareImageLaunch(usableHost, { target: profile }, home).host, usableHost)
    assert.equal(existsSync(join(store, 'update.lock')), false)
    assert.equal(existsSync(join(profile, 'package.json.lock')), false)
  } finally { release() }
})

function superviseFixture(t, runSupervisor) {
  const dshHome = fixture(t), gateView = join(dshHome, 'gate-view')
  mkdirSync(gateView)
  const messages = [], notices = [], abort = new AbortController()
  const log = message => messages.push(message)
  const run = (refreshView = () => messages.push('view refreshed'), onChildStart) => superviseDsh({
    host: { runSupervisor, version: '3.161.1' }, dshHome, gateView,
    publicArgs: ['--public-url', 'https://example.invalid/'], env: { DSH_HOME: dshHome },
    signal: abort.signal, log, warn: log, noteDsh: line => notices.push(line), onChildStart,
    observeVendors: () => messages.push('observing vendors'), refreshView, refreshRetryMs: 1,
  })
  return { dshHome, gateView, abort, messages, notices, run }
}

test('hosts one supervisor, clears the launch files between children and publishes both credentials privately', async t => {
  const urls = ['http://127.0.0.1:3081/?token=first-fixture', 'https://example.invalid/?token=second-fixture']
  const f = superviseFixture(t, async options => {
    assert.deepEqual(options.command, [process.execPath, ...dshArgs(['--public-url', 'https://example.invalid/'])])
    assert.equal(options.profile, PROFILE)
    assert.equal(options.home, f.dshHome)
    assert.equal(options.env.DSH_HOME, f.dshHome)
    assert.equal(options.version, '3.161.1')
    assert.equal(options.refreshCopy, false)
    assert.equal(options.signal, f.abort.signal)
    for (const url of urls) {
      options.onChildStart()
      assert.ok(files.every(file => !existsSync(file)))
      options.onLaunchUrl(url)
      for (const file of files) {
        assert.equal(readFileSync(file, 'utf8'), url + '\n')
        assert.equal(statSync(file).mode & 0o777, 0o600)
      }
    }
    options.onLine('vendor token=<redacted>')
    options.onLine('x'.repeat(9000))
    rmSync(f.gateView, { recursive: true })
    options.onLaunchUrl(urls[1])
    assert.equal(readFileSync(files[0], 'utf8'), urls[1] + '\n')
    return 19
  })
  const files = [f.dshHome, f.gateView].map(path => join(path, LAUNCH_FILE))
  for (const file of files) writeFileSync(file, 'old')
  const code = await f.run()
  assert.deepEqual(f.messages.filter(message => message.startsWith('dsh supervisor:')), [])
  assert.equal(code, 19)
  assert.equal(f.messages.filter(message => message === 'observing vendors').length, 1)
  assert.equal(f.messages.filter(message => message === 'view refreshed').length, 2)
  assert.equal(f.messages.filter(message => message.startsWith('startup: http://127.0.0.1:3081/')).length, 3)
  assert.ok(f.messages.some(message => message.includes('could not publish the gate launch URL')))
  assert.equal(f.notices[0], 'vendor token=<redacted>')
  assert.equal(f.notices[1].length, 4097)
  for (const token of ['first-fixture', 'second-fixture']) {
    assert.ok(![...f.messages, ...f.notices].join('\n').includes(token))
  }
})

test('entrypoint child start still proceeds if launch cleanup or view refresh throws', async t => {
  const f = superviseFixture(t, async ({ onChildStart, onLaunchUrl }) => {
    assert.doesNotThrow(onChildStart)
    rmSync(join(f.gateView, LAUNCH_FILE), { recursive: true })
    assert.doesNotThrow(onChildStart)
    onLaunchUrl('https://example.invalid/?token=replacement-fixture')
    return 19
  })
  mkdirSync(join(f.gateView, LAUNCH_FILE))
  assert.equal(await f.run(() => { throw new Error('https://example.invalid/private?token=refresh-secret') }), 19)
  assert.equal(f.messages.filter(message => message.startsWith('startup: could not clear')).length, 1)
  // The first refresh is superseded by the second child's; only the newest one retries and reports.
  assert.equal(f.messages.filter(message => message.startsWith('startup: could not refresh')).length, 1)
  assert.doesNotMatch(f.messages.join('\n'), /refresh-secret|replacement-fixture/)
  assert.equal(readFileSync(join(f.gateView, LAUNCH_FILE), 'utf8'), 'https://example.invalid/?token=replacement-fixture\n')
})

test('child start clears the gate launch file and refreshes state when the operator launch path is a directory', async t => {
  const f = superviseFixture(t, ({ onChildStart }) => {
    assert.doesNotThrow(onChildStart)
    assert.equal(existsSync(gateLaunch), false)
    return 19
  })
  const operatorLaunch = join(f.dshHome, LAUNCH_FILE), gateLaunch = join(f.gateView, LAUNCH_FILE)
  mkdirSync(operatorLaunch)
  writeFileSync(gateLaunch, 'previous credential')
  assert.equal(await f.run(), 19)
  assert.ok(statSync(operatorLaunch).isDirectory())
  assert.equal(f.messages.filter(message => message === 'view refreshed').length, 1)
  assert.equal(f.messages.filter(message => message.startsWith('startup: could not clear')).length, 1)
})

test('child start and state saves queue profile publications in order', async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  const events = []
  const f = superviseFixture(t, async ({ onChildStart, onSave }) => {
    assert.equal(onChildStart(), undefined)
    assert.equal(onSave(), undefined)
    assert.equal(onSave(), undefined)
    try {
      await entered.promise
      assert.deepEqual(events, ['start 1'])
    } finally { resume.resolve() }
    return 19
  })
  let calls = 0
  assert.equal(await f.run(async () => {
    const call = ++calls
    events.push(`start ${call}`)
    if (call === 1) {
      entered.resolve()
      await resume.promise
    }
    events.push(`finish ${call}`)
  }), 19)
  // Publications never overlap; the two saves made during the first one coalesce into one later
  // publication, which reads the state after both.
  assert.deepEqual(events, ['start 1', 'finish 1', 'start 2', 'finish 2'])
})

test('the entrypoint abort reaches the supervisor, whose own code is returned for the shutdown to settle', async t => {
  const f = superviseFixture(t, async ({ signal }) => {
    const done = once(signal, 'abort')
    setImmediate(() => f.abort.abort())
    await done
    return 1
  })
  assert.equal(await f.run(), 1)
  const early = superviseFixture(t, ({ signal }) => {
    assert.equal(signal.aborted, true)
    return 1
  })
  early.abort.abort()
  assert.equal(await early.run(), 1)
})

test('a thrown supervisor returns 1 with one warning', async t => {
  const f = superviseFixture(t, () => { throw new Error('fixture failed') })
  assert.equal(await f.run(), 1)
  assert.ok(f.messages.includes('dsh supervisor: fixture failed'))
})

test('the host service beside DSH starts at each child start and its failure never stops the child', async t => {
  let starts = 0
  const f = superviseFixture(t, async ({ onChildStart }) => {
    onChildStart()
    onChildStart()
    return 0
  })
  assert.equal(await f.run(undefined, () => {
    if (++starts === 2) throw new Error('omni failed https://example.invalid/?token=omni-secret')
  }), 0)
  assert.equal(starts, 2)
  assert.equal(f.messages.filter(message => message === 'startup: could not start a service beside DSH').length, 1)
  assert.doesNotMatch(f.messages.join('\n'), /omni-secret/)
})

test('a refresh that times out on the publication lock is retried past any count while the supervisor runs', async t => {
  let calls = 0, published
  const done = new Promise(resolve => { published = resolve })
  const f = superviseFixture(t, async ({ onSave }) => {
    onSave({ phase: 'healthy' })
    await done
    return 0
  })
  assert.equal(await f.run(() => {
    // Fifteen lock timeouts: more than the old ten-attempt budget.
    if (++calls <= 15) throw new Error('Image profile lock was not acquired')
    f.messages.push('view refreshed')
    published()
  }), 0)
  assert.equal(calls, 16)
  assert.equal(f.messages.filter(message => message === 'view refreshed').length, 1)
  assert.equal(f.messages.filter(message => message.startsWith('startup: could not refresh')).length, 0)
  assert.equal(f.messages.filter(message => message.startsWith('startup: the gate profile state is waiting')).length, 1)
})

test('saves made while a publication is blocked coalesce into one later publication of the newest state', async t => {
  const order = []
  let phase = 'checking', blocked = 3, published
  const done = new Promise(resolve => { published = resolve })
  const f = superviseFixture(t, async ({ onSave }) => {
    onSave()
    for (const next of ['downloading', 'staging', 'switching', 'healthy']) {
      await new Promise(resolve => setTimeout(resolve, 2))
      phase = next
      onSave()
    }
    await done
    return 0
  })
  assert.equal(await f.run(() => {
    if (blocked-- > 0) throw new Error('Image profile lock was not acquired')
    order.push(phase)
    if (phase === 'healthy') published()
  }), 0)
  // Every publication reads the state when it runs; the last one is the terminal verdict.
  assert.equal(order.at(-1), 'healthy')
  assert.ok(order.length < 5, `publications were not coalesced: ${order.join(',')}`)
})

test('shutdown waits for a blocked publication only up to its drain deadline', async t => {
  const f = superviseFixture(t, async ({ onSave }) => {
    onSave()
    return 7
  })
  const started = Date.now()
  assert.equal(await superviseDsh({
    host: { runSupervisor: async ({ onSave }) => { onSave(); return 7 }, version: '3.161.1' },
    dshHome: f.dshHome, gateView: f.gateView, publicArgs: [], env: { DSH_HOME: f.dshHome },
    signal: f.abort.signal, log: () => {}, warn: () => {}, noteDsh: () => {}, observeVendors: () => {},
    refreshView: () => new Promise(() => {}), refreshRetryMs: 1, refreshDrainMs: 50,
  }), 7)
  assert.ok(Date.now() - started < 2000)
})

test('a DSH home that is the gate volume under another path (a second bind mount) is refused without waiting', async t => {
  const volume = fixture(t), dshHome = fixture(t)
  const calls = []
  await assert.rejects(prepareImageVolume({
    dshHome, gateView: join(volume, 'gate-view'), privateDirs: { DSH_HOME: dshHome },
    same: (left, right) => left === volume && right === dshHome,
    hold(dir, name) {
      calls.push(dir)
      return holdVolumeLease(dir, name, 1)
    },
  }), /^Error: gate-view overlaps DSH_HOME$/)
  assert.deepEqual(calls, [])
})

test('sameDirectory compares the directory identity, not the path', t => {
  const dir = fixture(t), other = fixture(t), link = join(fixture(t), 'alias')
  symlinkSync(dir, link)
  assert.equal(sameDirectory(dir, link), true)
  assert.equal(sameDirectory(dir, other), false)
  assert.equal(sameDirectory(dir, join(other, 'missing')), false)
})

test('a shutdown during the retry backoff starts no new publication attempt', async t => {
  let calls = 0
  const f = superviseFixture(t, async ({ onSave }) => {
    onSave()
    return 5
  })
  const messages = []
  assert.equal(await superviseDsh({
    host: { runSupervisor: async ({ onSave }) => { onSave(); return 5 }, version: '3.161.1' },
    dshHome: f.dshHome, gateView: f.gateView, publicArgs: [], env: { DSH_HOME: f.dshHome },
    signal: f.abort.signal, log: () => {}, warn: message => messages.push(message), noteDsh: () => {},
    observeVendors: () => {}, refreshRetryMs: 30, refreshDrainMs: 1000,
    refreshView: () => { calls++; throw new Error('Image profile lock was not acquired') },
  }), 5)
  // The first attempt failed before shutdown began; the backoff ended after it, so no retry ran.
  assert.equal(calls, 1)
  assert.deepEqual(messages, ['startup: could not refresh the gate profile state'])
})
