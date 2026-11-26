import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import workerThreads from 'node:worker_threads'
import { deflateSync, gzipSync } from 'node:zlib'
import { install } from '../src/host/endpoint.js'
import { atLoginUsable, bunPathOf, createOmniInstaller, routeOf, verifyOmniArchive } from '../src/host/omni-github.js'
import { fakeContext } from './fake-ctx.js'

const pin = { version: '2.261112.6', commit: 'e'.repeat(40), tree: 'b'.repeat(40) }
const older = '2.261109.2'
const newer = '2.261118.15'
const tag = 'v' + pin.version
const fallback = { version: pin.version, tag, commit: pin.commit }
const binary = Buffer.from('fake Bun')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = data => new Response(JSON.stringify(data))
const pidError = () => Object.assign(new Error('No such process'), { code: 'ESRCH' })

function zipFile(name, bytes) {
  const filename = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt32LE(bytes.length, 20)
  central.writeUInt32LE(bytes.length, 24)
  central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + bytes.length, 16)
  return Buffer.concat([local, filename, bytes, central, filename, end])
}

const zip = zipFile('bun-linux-x64/bun', binary)
const descriptor = { version: '1.4.4', sha256: sha(binary), zip: sha(zip), asset: 'linux-x64' }
const entries = [
  { type: '0', path: 'packages/cli/bin/omni', exec: true, body: Buffer.from('fake Omni') },
  { type: '2', path: 'packages/cli/alias', target: 'bin/omni' },
]
const defaultPayload = { version: older, reason: 'behind' }

async function until(read, message = 'waiting for the Omni job') {
  for (let i = 0; i < 800; i++) {
    const value = await read()
    if (value) return value
    await delay(2)
  }
  assert.fail(message)
}

const image = { AUTOMAGIK_GATE_IMAGE: '1', AUTOMAGIK_OMNI_SUPERVISOR: '1' }

function fixture(t, settings = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'omni-github-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'root')
  const home = join(root, 'sandbox')
  const build = join(root, 'automagik-build')
  const marker = join(home, 'automagik-supervised.json')
  const intent = join(home, 'automagik-install.json')
  const env = { HOME: join(scratch, 'home'), OMNI_HOME: root, PATH: join(scratch, 'path'), ...settings.env }
  mkdirSync(env.PATH.split(delimiter)[0], { recursive: true })
  const calls = [], requests = [], signals = [], groups = new Map(), pids = new Set([process.pid])
  let lastPid = 40000
  let installer
  const fetch = async (url, options) => {
    requests.push(url)
    const fake = settings.fetch?.(url, options)
    if (fake !== undefined) return fake
    if (url.endsWith('git/ref/tags/' + tag)) return json({ object: { type: 'commit', sha: pin.commit } })
    if (url.endsWith('git/commits/' + pin.commit)) return json({ tree: { sha: pin.tree } })
    if (url.startsWith('https://codeload.github.com/')) return new Response('archive bytes')
    if (url.endsWith('/bun-linux-x64.zip')) return new Response(zip)
    if (url.endsWith('/releases/latest')) return json({ tag_name: 'v' + newer })
    if (url.endsWith('/dist-tags')) return json({ latest: older })
    if (url.includes('/@automagik%2fomni/')) return new Response(null, { status: settings.npmStatus ?? 200 })
    assert.fail('Unexpected URL: ' + url)
  }
  const spawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: ++lastPid, stdout: new PassThrough(), stderr: new PassThrough() })
    const call = { file, args, options, child }
    calls.push(call)
    groups.set(child.pid, call)
    const finish = (code = 0, output, exitSignal) => {
      if (output !== undefined) child.stdout.write(typeof output === 'string' ? output : JSON.stringify(output) + '\n')
      groups.delete(child.pid)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', code, exitSignal)
    }
    call.finish = finish
    queueMicrotask(() => {
      if (settings.onSpawn?.(call) === false) return
      if (args[0] === 'pm') writeFileSync(join(args.at(-1), 'automagik-omni-' + pin.version + '.tgz'), 'packed Omni')
      const running = installer?.view()
      const report = { ok: true, version: running?.release.version ?? args[2]?.split('@').at(-1), apiUrl: 'http://127.0.0.1:8181/', home }
      finish(0, args.includes('--sandbox') ? report : undefined)
    })
    return child
  }
  const kill = (pid, signal) => {
    if (pid > 0 && pids.has(pid) && signal === 0) return
    const group = groups.get(-pid)
    if (!group) throw pidError()
    if (signal === 0) return
    signals.push([pid, signal])
    if (settings.onKill?.(group, signal) === false) return
    group.finish(null, undefined, signal)
  }
  const options = {
    env, platform: 'linux', arch: 'x64', pin, descriptor, fetch, spawn, kill,
    run: async () => settings.login ? 0 : 1,
    verifyArchive: async (stream) => {
      assert.equal(await new Response(stream).text(), 'archive bytes')
      return entries
    },
    ...settings.options,
  }
  installer = createOmniInstaller(options)
  return {
    root, home, build, marker, intent, calls, requests, signals, groups, pids, env, installer, options,
    async done() {
      return until(() => {
        const view = installer.view()
        return view && view.phase !== 'running' ? view : null
      })
    },
  }
}

test('routes terminal, GitHub, npm job and refusal across service and npm states', () => {
  for (const [login, npm, V, eligible, npmJobUsable, expected] of [
    [true, 'published', newer, false, true, 'terminal'],
    [true, 'published', pin.version, true, true, 'terminal'],
    [true, 'published', older, true, true, 'github'],
    [true, 'published', older, false, false, 'terminal'],
    [true, 'unpublished', older, true, true, 'github'],
    [true, 'unpublished', newer, false, true, 'unpublished'],
    [true, 'unknown', older, true, true, 'terminal'],
    [true, 'unknown', newer, false, false, 'terminal'],
    [false, 'published', pin.version, true, true, 'npm'],
    [false, 'published', newer, false, true, 'npm'],
    [false, 'published', newer, false, false, 'no-systemd'],
    [false, 'published', older, true, true, 'github'],
    [false, 'published', older, false, false, 'no-systemd'],
    [false, 'unpublished', older, true, true, 'github'],
    [false, 'unpublished', newer, false, true, 'no-systemd'],
    [false, 'unknown', older, true, true, 'github'],
    [false, 'unknown', older, false, false, 'no-systemd'],
    [true, 'published', pin.version + '-rc.1', true, true, 'github'],
  ]) {
    assert.equal(routeOf({ npm, V, P: pin.version, atLoginUsable: login, eligible, npmJobUsable }), expected)
  }
})

test('probes the Linux systemd user session with a two-second limit and skips the probe in the image and on macOS', async () => {
  const calls = []
  const run = async (...args) => { calls.push(args); return calls.length === 1 ? 0 : 1 }
  const env = { DEEPSEEK_API_KEY: 'hidden', DBUS_SESSION_BUS_ADDRESS: 'bus' }
  assert.equal(await atLoginUsable({ env, platform: 'linux', run }), true)
  assert.equal(await atLoginUsable({ env, platform: 'linux', run }), false)
  assert.equal(await atLoginUsable({ env, platform: 'darwin', run }), true)
  assert.equal(await atLoginUsable({ env: image, platform: 'linux', run }), false)
  assert.equal(calls.length, 2)
  const [file, args, options] = calls[0]
  assert.equal(file, 'systemctl')
  assert.deepEqual(args, ['--user', 'show-environment'])
  assert.equal(options.timeout, 2000)
  assert.equal(options.env.DBUS_SESSION_BUS_ADDRESS, 'bus')
  assert.equal(options.env.DEEPSEEK_API_KEY, undefined)
})

test('verifies lightweight and annotated tags before codeload by commit and refuses API errors or pin mismatches', async (t) => {
  const annotation = 'a'.repeat(40)
  for (const type of ['lightweight', 'annotated', 'tag mismatch', 'tree mismatch', 'API error']) {
    const f = fixture(t, { fetch(url) {
      if (url.endsWith('git/ref/tags/' + tag)) {
        if (type === 'API error') return new Response(null, { status: 403 })
        if (type === 'annotated') return json({ object: { type: 'tag', sha: annotation } })
        if (type === 'tag mismatch') return json({ object: { type: 'commit', sha: annotation } })
      }
      if (url.endsWith('/git/tags/' + annotation)) return json({ object: { type: 'commit', sha: pin.commit } })
      if (type === 'tree mismatch' && url.endsWith('/git/commits/' + pin.commit)) return json({ tree: { sha: annotation } })
    } })
    await f.installer.start(defaultPayload)
    const job = await f.done()
    const ok = type === 'lightweight' || type === 'annotated'
    assert.equal(job.phase, ok ? 'done' : 'failed', job.error)
    assert.equal(f.requests.includes('https://codeload.github.com/automagik-si/omni/tar.gz/' + pin.commit), ok)
    assert.equal(f.requests.some(url => url.endsWith('git/tags/' + annotation)), type === 'annotated')
    if (!ok) {
      assert.match(job.error, /could not check|commit this Automagik|Git tree/i)
      assert.deepEqual(f.calls, [])
      assert.deepEqual(readdirSync(f.build), [])
    }
  }
})

test('a rejected archive is never extracted, and Bun is neither downloaded nor run', async (t) => {
  const f = fixture(t, { options: { verifyArchive: async () => { throw new Error('pinned Git tree mismatch') } } })
  await f.installer.start(defaultPayload)
  const job = await f.done()
  assert.match(job.error, /Git tree mismatch/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.requests.some(url => url.includes('oven-sh')), false)
  assert.deepEqual(readdirSync(f.build), [])
})

test('checks Bun zip and binary SHA-256, and uses only the content-addressed executable', async (t) => {
  for (const key of ['zip', 'sha256']) {
    const f = fixture(t, { options: { descriptor: { ...descriptor, [key]: '0'.repeat(64) } } })
    const pathBun = join(f.env.PATH, 'bun')
    writeFileSync(pathBun, binary, { mode: 0o755 })
    await f.installer.start(defaultPayload)
    const job = await f.done()
    assert.match(job.error, new RegExp('Bun ' + (key === 'zip' ? 'zip' : 'binary')))
    assert.equal(f.calls.length, 0)
    assert.equal(existsSync(join(f.root, 'automagik-bun')), false)
  }
  const f = fixture(t)
  const bun = bunPathOf(f.root, descriptor)
  mkdirSync(dirname(bun), { recursive: true })
  writeFileSync(bun, 'corrupted Bun', { mode: 0o755 })
  await f.installer.start(defaultPayload)
  assert.equal((await f.done()).phase, 'done')
  assert.deepEqual(readFileSync(bun), binary)
  const firstBunDownloads = f.requests.filter(url => url.includes('oven-sh')).length
  await f.installer.start(defaultPayload)
  assert.equal((await f.done()).phase, 'done')
  assert.equal(f.requests.filter(url => url.includes('oven-sh')).length, firstBunDownloads)
  assert.equal(f.calls.length, 10, 'the Bun binary is reused, and the pinned source is rebuilt')
  assert.ok(f.calls.every(call => call.file === bun))
})

test('runs the four fixed build commands in scratch, supplies missing shims and allowlists the two environments', async (t) => {
  let shims
  const f = fixture(t, {
    login: true,
    env: { DEEPSEEK_API_KEY: 'private value', OMNI_API_KEY: 'secret', HC_SOCKET: '/live.socket', DSH_TOKEN: 'token',
      NPM_CONFIG_REGISTRY: 'https://npm.example/', HTTPS_PROXY: 'https://proxy.example/', DBUS_SESSION_BUS_ADDRESS: 'bus' },
    onSpawn(call) {
      if (call.args[0] === 'install') {
        shims = readdirSync(call.options.env.PATH.split(delimiter)[1]).sort()
        assert.equal(statSync(join(call.options.cwd, 'packages/cli/bin/omni')).mode & 0o111, 0o111)
      }
    },
  })
  writeFileSync(join(f.env.PATH, 'cp'), '', { mode: 0o755 })
  await f.installer.start(defaultPayload)
  const job = await f.done()
  assert.equal(job.phase, 'done', job.error)
  assert.deepEqual(shims, ['mkdir', 'rm'])
  const [deps, turbo, prepack, pack, cli] = f.calls
  assert.deepEqual(deps.args, ['install', '--frozen-lockfile', '--ignore-scripts'])
  assert.deepEqual(turbo.args, ['x', 'turbo', 'run', 'build', '--filter=@automagik/omni'])
  assert.deepEqual(prepack.args, ['run', 'prepack'])
  assert.deepEqual(pack.args.slice(0, -1), ['pm', 'pack', '--ignore-scripts', '--destination'])
  assert.equal(turbo.options.cwd, deps.options.cwd)
  assert.equal(pack.options.cwd, prepack.options.cwd)
  assert.equal(relative(deps.options.cwd, prepack.options.cwd), 'packages/cli')
  assert.match(deps.options.env.HOME, /automagik-build\/omni-.+\/home$/)
  assert.equal(deps.options.env.BUN_INSTALL_CACHE_DIR, join(f.build, 'cache'))
  assert.equal(deps.options.env.DBUS_SESSION_BUS_ADDRESS, undefined)
  assert.equal(cli.options.env.HOME, f.env.HOME)
  assert.equal(cli.options.env.DBUS_SESSION_BUS_ADDRESS, 'bus')
  assert.equal(cli.options.env.OMNI_HOME, f.root)
  assert.ok(f.calls.every(({ options }) => options.detached && !options.shell
    && options.env.HTTPS_PROXY === f.env.HTTPS_PROXY && options.env.NPM_CONFIG_REGISTRY === f.env.NPM_CONFIG_REGISTRY
    && ['DEEPSEEK_API_KEY', 'OMNI_API_KEY', 'HC_SOCKET', 'DSH_TOKEN'].every(key => !Object.hasOwn(options.env, key))))
  const target = join(f.root, 'packages', 'automagik-omni-' + pin.version + '-' + pin.commit.slice(0, 12) + '.tgz')
  assert.deepEqual(cli.args, [join(prepack.options.cwd, 'bin/omni'), 'install', '--sandbox', '--home', f.home, '--package', 'file:' + target, '--at-login', '--json'])
  assert.deepEqual(job.report, { version: pin.version, apiUrl: 'http://127.0.0.1:8181', home: f.home })
  assert.deepEqual(readdirSync(f.build), ['cache'])
  assert.equal(readFileSync(target, 'utf8'), 'packed Omni')
})

test('creates no shims when all three commands exist and leaves off mode flags without systemd on desktop', async (t) => {
  const f = fixture(t)
  for (const name of ['mkdir', 'cp', 'rm']) writeFileSync(join(f.env.PATH, name), '', { mode: 0o755 })
  const { job } = await f.installer.start(defaultPayload)
  assert.equal(job.reason, 'no-systemd')
  assert.equal((await f.done()).phase, 'done')
  assert.equal(f.calls[0].options.env.PATH, [dirname(f.calls[0].file), f.env.PATH].join(delimiter))
  assert.deepEqual(f.calls.at(-1).args.slice(-1), ['--json'])
  assert.ok(!f.calls.at(-1).args.some(arg => arg === '--at-login' || arg === '--no-start'))
})

test('the image publishes the exact 0600 marker after a successful --no-start install', async (t) => {
  let f
  f = fixture(t, { env: image, onSpawn({ args }) {
    if (!args.includes('--sandbox')) return
    assert.deepEqual(args.slice(-2), ['--no-start', '--json'])
    assert.equal(existsSync(f.marker), false)
    assert.equal(JSON.parse(readFileSync(f.intent, 'utf8')).version, pin.version)
  } })
  await f.installer.start(defaultPayload)
  assert.equal((await f.done()).phase, 'done')
  assert.deepEqual(JSON.parse(readFileSync(f.marker, 'utf8')), { version: pin.version, bun: { version: descriptor.version, sha256: descriptor.sha256 } })
  assert.equal(statSync(f.marker).mode & 0o777, 0o600)
  assert.equal(existsSync(f.intent), false)
  await assert.rejects(f.installer.start(defaultPayload), /already installed/)
})

test('an image refuses a nonempty sandbox unless it recognizes an interrupted install', async (t) => {
  const f = fixture(t, { env: image })
  mkdirSync(f.home, { recursive: true })
  const state = join(f.home, 'sandbox.json')
  writeFileSync(state, JSON.stringify({ atLogin: false, ports: { api: 8989 } }))
  await assert.rejects(f.installer.start(defaultPayload), /already installed/)
  assert.ok(!existsSync(f.build))
  writeFileSync(f.intent, JSON.stringify({ version: newer, startedAt: '2026-11-20T10:00:00.000Z' }))
  await assert.rejects(f.installer.start(defaultPayload), /Retry the interrupted Omni install at version/)
  writeFileSync(f.intent, JSON.stringify({ version: pin.version, startedAt: '2026-11-20T10:00:00.000Z' }))
  await f.installer.start(defaultPayload)
  assert.equal((await f.done()).phase, 'done')
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).ports.api, 8989)
})

test('published npm image installs V, skips source build and records the validated CLI version', async (t) => {
  const f = fixture(t, { env: image })
  const { job } = await f.installer.start({ version: newer, reason: 'unpublished' })
  assert.equal(job.source, 'npm')
  assert.equal(job.reason, 'no-systemd')
  const done = await f.done()
  assert.equal(done.phase, 'done', done.error)
  assert.deepEqual(done.steps.map(step => step.state), ['done', 'skipped', 'skipped', 'done'])
  assert.deepEqual(f.calls.map(call => call.args), [['x', '--bun', '@automagik/omni@' + newer, 'install', '--sandbox', '--home', f.home, '--no-start', '--json']])
  assert.equal(f.requests.some(url => url.startsWith('https://api.github.com/')), false)
  assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).version, newer)
})

test('a real npm CLI failure falls back in the same image job only when V equals the pin', async (t) => {
  for (const version of [pin.version, newer]) {
    const f = fixture(t, { env: image, onSpawn(call) {
      if (call.args[0] === 'x' && call.args[1] === '--bun') {
        call.finish(7, { ok: false, error: 'npm registry unavailable' })
        return false
      }
    } })
    const { job } = await f.installer.start({ version, reason: 'no-systemd' })
    const done = await f.done()
    assert.equal(done.id, job.id)
    assert.equal(done.reason, 'no-systemd')
    assert.equal(done.npm.exitCode, 7)
    assert.equal(done.fellBack, version === pin.version)
    assert.equal(done.phase, version === pin.version ? 'done' : 'failed', done.error)
    assert.equal(existsSync(f.marker), version === pin.version)
    assert.equal(existsSync(f.intent), version !== pin.version)
  }
})

test('a cancelled npm install that later fails ends there without attempting GitHub', async (t) => {
  const f = fixture(t, { env: image, onSpawn() { return false } })
  const { job: { id } } = await f.installer.start({ version: pin.version, reason: 'no-systemd' })
  const call = await until(() => f.calls[0])
  assert.equal(f.installer.cancel({ id }).job.step, 'install')
  call.finish(7, { ok: false, error: 'npm registry unavailable' })
  const done = await f.done()
  assert.equal(done.phase, 'failed')
  assert.equal(done.fellBack, false)
  assert.equal(done.npm.exitCode, 7)
  assert.deepEqual(f.signals, [])
  assert.ok(!f.requests.some(url => url.includes('api.github.com')))
})

test('the host derives the route and allows a real terminal failure to fall back', async (t) => {
  const f = fixture(t, { login: true })
  const payload = { version: pin.version, reason: 'npm-failed' }
  for (const exitCode of [undefined, 0, 130]) {
    await assert.rejects(f.installer.start({ ...payload, exitCode }), /through Omni’s terminal/)
  }
  const { job } = await f.installer.start({ ...payload, exitCode: 3 })
  assert.equal(job.reason, 'npm-failed')
  assert.equal(job.npm.exitCode, 3)
  assert.equal((await f.done()).phase, 'done')
})

test('refuses unsafe directories and desktop config files, a live sandbox pid and sticky at-login state', async (t) => {
  for (const path of ['root', 'sandbox', 'runtime', 'automagik-build', 'config.json']) {
    const f = fixture(t)
    const dest = path === 'root' ? f.root : path === 'sandbox' ? f.home : path === 'runtime' ? join(f.home, path)
      : path === 'config.json' ? join(f.home, 'config', path) : join(f.root, path)
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(f.env.PATH, dest)
    await assert.rejects(f.installer.start(defaultPayload), /Unsafe Omni path/)
    assert.equal(f.calls.length, 0)
  }
  const f = fixture(t)
  mkdirSync(join(f.home, 'run'), { recursive: true })
  mkdirSync(join(f.home, 'config'))
  writeFileSync(join(f.home, 'config', 'config.json'), '{}')
  writeFileSync(join(f.home, 'run', 'supervisor.pid'), '98765\nleftover text')
  f.pids.add(98765)
  await assert.rejects(f.installer.start(defaultPayload), /an Omni here is running/i)
  f.pids.delete(98765)
  const state = join(f.home, 'sandbox.json')
  writeFileSync(state, '{"atLogin":true}')
  await assert.rejects(f.installer.start(defaultPayload), /set to start at login/)
  writeFileSync(state, '{"atLogin":')
  await f.installer.start(defaultPayload)
  assert.equal((await f.done()).phase, 'done')
  assert.equal(existsSync(join(f.home, 'run', 'supervisor.pid')), true)
})

test('refuses an existing build directory owned by another user', async (t) => {
  const f = fixture(t)
  mkdirSync(f.build, { recursive: true })
  const original = fs.lstatSync
  const check = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const stat = original(path, ...args)
    if (path === f.build) stat.uid++
    return stat
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.installer.start(defaultPayload), { message: 'Unsafe Omni path: ' + f.build })
    assert.deepEqual(readdirSync(f.build), [])
    assert.deepEqual(f.calls, [])
  } finally {
    check.mock.restore()
    syncBuiltinESMExports()
  }
})

test('refuses unsupported, Unfold, multiuser, old images and requested versions newer than the pin without npm', async (t) => {
  for (const [options, message] of [
    [{ platform: 'win32' }, /Linux or macOS/],
    [{ arch: 'riscv64' }, /Linux or macOS/],
    [{ env: { AUTOMAGIK_PRELOAD: 'Unfold' } }, /bundled with Unfold/],
    [{ env: { AUTOMAGIK_MULTIUSER: '1' } }, /multiuser mode/],
    [{ env: { AUTOMAGIK_GATE_IMAGE: '1' } }, /This server image cannot keep Omni running; update the image/],
  ]) {
    const f = fixture(t, { env: options.env, options: { ...options, env: undefined } })
    const installer = createOmniInstaller({ ...f.options, env: f.env })
    await assert.rejects(installer.start(defaultPayload), message)
    assert.throws(() => installer.cancel(), message)
    assert.throws(() => installer.ack({ id: 'old' }), message)
    assert.equal(f.requests.length, 0)
  }
  const f = fixture(t, { login: true, npmStatus: 404 })
  await assert.rejects(f.installer.start({ version: newer, reason: 'unpublished' }), /pins an older Omni/)
})

test('a second start joins the running job and another installer cannot acquire a live or unreadable lock', async (t) => {
  const f = fixture(t, { onSpawn(call) { if (call.args[0] === 'install') return false } })
  const [started, same] = await Promise.all([
    f.installer.start(defaultPayload), f.installer.start({ version: newer, reason: 'unpublished' }),
  ])
  assert.equal(same.job.id, started.job.id)
  const call = await until(() => f.calls[0])
  const owner = join(f.build, 'install.lock', 'owner.json')
  assert.equal(JSON.parse(readFileSync(owner, 'utf8')).pid, process.pid)
  await assert.rejects(createOmniInstaller(f.options).start(defaultPayload), /Another Omni install/)
  writeFileSync(owner, 'unreadable owner')
  await assert.rejects(createOmniInstaller(f.options).start(defaultPayload), /Another Omni install/)
  call.finish(41)
  assert.equal((await f.done()).phase, 'failed')
  assert.deepEqual(readdirSync(f.build), ['cache'])
})

test('reclaims a lock after boot change, PID exit or PID reuse', async (t) => {
  for (const reason of ['boot', 'pid', 'ticks']) {
    const f = fixture(t, { options: { boot: 'this-boot', ticks: () => '222' } })
    const lock = join(f.build, 'install.lock')
    mkdirSync(lock, { recursive: true })
    const owner = { pid: 6000, bootId: reason === 'boot' ? 'older-boot' : 'this-boot', startTicks: reason === 'ticks' ? '333' : '222', at: 0 }
    if (reason !== 'pid') f.pids.add(owner.pid)
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner))
    await f.installer.start(defaultPayload)
    assert.equal((await f.done()).phase, 'done')
    assert.equal(existsSync(lock), false)
  }
})

test('cancels a process group before cleaning the checkout and ignores a stale cancellation', async (t) => {
  let f, checkout
  f = fixture(t, { options: { termMs: 1, wait: async () => {} },
    onSpawn(call) {
      if (call.args[0] === 'install') { checkout = call.options.cwd; return false }
    },
    onKill(_call, signal) {
      assert.equal(existsSync(checkout), true)
      return signal !== 'SIGTERM'
    },
  })
  const { job } = await f.installer.start(defaultPayload)
  const call = await until(() => f.calls[0])
  assert.deepEqual(f.installer.status({ id: 'old' }), { job: null })
  assert.equal(f.installer.cancel({ id: 'old' }).job.cancelRequested, false)
  const running = f.installer.cancel({ id: job.id }).job
  assert.equal(running.phase, 'running')
  assert.equal(running.cancelRequested, true)
  const done = await f.done()
  assert.equal(done.phase, 'cancelled')
  assert.deepEqual(f.signals, [[-call.child.pid, 'SIGTERM'], [-call.child.pid, 'SIGKILL']])
  assert.equal(existsSync(checkout), false)
  assert.deepEqual(f.installer.cancel({ id: job.id }), { job: done })
})

test('an install-time cancel leaves the CLI alone and the first acknowledgement claims only successful completion', async (t) => {
  for (const code of [0, 9]) {
    const f = fixture(t, { onSpawn(call) { if (call.args.includes('--sandbox')) return false } })
    const { job: { id } } = await f.installer.start(defaultPayload)
    const call = await until(() => f.calls.find(call => call.args.includes('--sandbox')))
    assert.equal(f.installer.ack({ id }).claimed, false)
    const requested = f.installer.cancel({ id }).job
    assert.equal(requested.step, 'install')
    assert.equal(requested.cancelRequested, true)
    assert.deepEqual(f.signals, [])
    call.finish(code, { ok: true, version: pin.version, apiUrl: 'http://127.0.0.1:8200' })
    const done = await f.done()
    assert.equal(done.phase, code === 0 ? 'done' : 'failed')
    assert.equal(done.cancelRequested, true)
    assert.equal(f.installer.ack({ id }).claimed, code === 0)
    assert.equal(f.installer.ack({ id }).claimed, false)
    assert.equal(f.installer.status().job.acknowledged, code === 0)
    assert.deepEqual(f.installer.ack({ id: 'old' }), { job: null, claimed: false })
  }
})

test('bounds and redacts logs and errors including credentials split across chunks', async (t) => {
  const f = fixture(t, { onSpawn(call) {
    if (call.args[0] === 'install') {
      for (let i = 0; i < 70; i++) call.child.stdout.write('y'.repeat(1024) + '\n')
      call.child.stdout.write('x'.repeat(9000))
      call.child.stdout.write('\nurl=https://private-user:private-pass@example.test\nauthorization: Basic par')
      call.child.stdout.write('tial-credential\n{"api_key":"two word password"}\n')
      call.child.stderr.write('failed to\u001b[0mken=unprefixed-credential\n')
      call.finish(1)
      return false
    }
  } })
  await f.installer.start(defaultPayload)
  const done = await f.done()
  assert.equal(done.phase, 'failed')
  assert.ok(Buffer.byteLength(done.log) <= 48 * 1024)
  assert.match(done.log, /long line omitted/)
  for (const secret of ['private-user', 'private-pass', 'partial-credential', 'two word password', 'unprefixed-credential']) {
    assert.ok(!done.log.includes(secret) && !done.error.includes(secret), secret)
  }
  assert.match(done.error, /failed token=\[hidden\]/)
  assert.deepEqual(readdirSync(f.build), ['cache'])
})

test('trims an overfull job log at a newline boundary', async t => {
  const lines = Array.from({ length: 70 }, (_, i) => `log ${i} `.padEnd(1024, 'y') + '\n')
  const f = fixture(t, { onSpawn(call) {
    if (call.args[0] === 'install') {
      for (const line of lines) call.child.stdout.write(line)
      call.finish(1)
      return false
    }
  } })
  await f.installer.start(defaultPayload)
  const done = await f.done()
  const retained = Math.floor(48 * 1024 / Buffer.byteLength(lines[0]))
  assert.equal(done.log, lines.slice(-retained).join(''))
})

test('rejects a mismatched CLI report and never marks the image ready', async (t) => {
  for (const report of [
    { version: older, apiUrl: 'http://127.0.0.1:81' },
    { version: pin.version, apiUrl: 'https://example.com/' },
    { version: pin.version, apiUrl: 'http://name:secret@127.0.0.1:81/' },
  ]) {
    const f = fixture(t, { env: image, onSpawn(call) {
      if (call.args.includes('--sandbox')) { call.finish(0, { ok: true, ...report }); return false }
    } })
    await f.installer.start(defaultPayload)
    assert.match((await f.done()).error, /expected version and a local API URL/)
    assert.ok(!existsSync(f.marker) && existsSync(f.intent))
  }
})

test('download, build and install timeouts end at their own step and reap any child', async (t) => {
  for (const step of ['download', 'build', 'install']) {
    const f = fixture(t, {
      options: { [step + 'Ms']: 20 },
      fetch(url) {
        if (step === 'download' && url.endsWith('git/ref/tags/' + tag)) return new Promise(() => {})
      },
      onSpawn({ args }) {
        if ((step === 'build' && args[0] === 'install') || (step === 'install' && args.includes('--sandbox'))) return false
      },
    })
    await f.installer.start(defaultPayload)
    const failed = await f.done()
    assert.equal(failed.phase, 'failed')
    assert.ok(failed.steps.some(row => row.id === step && row.state === 'failed'), failed.error)
    assert.match(failed.error, /took too long/)
    assert.equal(f.signals.length, step === 'download' ? 0 : 1)
    assert.equal(existsSync(join(f.build, 'install.lock')), false)
  }
})

function endpointFixture(f, team) {
  const { ctx } = fakeContext({ services: { omniTeam: team }, entries: { 'omni-ai': {} } })
  return install(ctx, { env: f.env, omniInstaller: f.options }).handle
}

test('capability check preserves legacy replies and advertises only a route the host can start', async (t) => {
  const cases = [
    [{ login: true }, older, { ok: false, reason: 'behind', version: older, npm: older, github: 'v' + newer, fallback }],
    [{ login: true }, pin.version, { ok: true, fallback }],
    [{ login: true, npmStatus: 404 }, older, { ok: false, reason: 'unpublished', version: older, npm: older, github: 'v' + newer, fallback }],
    [{ login: true, npmStatus: 500 }, older, { ok: true, unchecked: true, fallback }],
    [{ env: image }, older, { ok: false, reason: 'no-systemd', version: older, npmHas: false, fallback }],
    [{ env: image }, newer, { ok: false, reason: 'no-systemd', version: newer, npmHas: true, fallback: null }],
    [{ env: { AUTOMAGIK_GATE_IMAGE: '1' } }, older, { ok: false, reason: 'no-systemd', version: older, npmHas: false, fallback: null }],
    [{ login: true, env: { AUTOMAGIK_MULTIUSER: '1' } }, older, { ok: true, fallback: null }],
    [{ env: { ...image, AUTOMAGIK_MULTIUSER: '1' } }, newer, { ok: false, reason: 'no-systemd', version: newer, npmHas: false, fallback: null }],
    [{ login: true, env: { AUTOMAGIK_HOST: 'unfold' } }, older, { ok: true, fallback: null }],
  ]
  for (const [settings, version, expected] of cases) {
    const f = fixture(t, settings)
    const handle = endpointFixture(f)
    assert.deepEqual(await handle('omni-server-check', { version, fallback: true }), { ok: true, value: expected })
  }
  const f = fixture(t, { options: { platform: 'darwin' } })
  assert.deepEqual(await endpointFixture(f)('omni-server-check', { version: older }), { ok: true, value: { ok: true } })
})

test('start rechecks npm even after a capability check cached a different answer', async (t) => {
  let status = 200
  const f = fixture(t, { login: true, onSpawn() { return false },
    fetch(url) {
      if (url.endsWith('/@automagik%2fomni/' + older)) return new Response(null, { status })
    },
  })
  const handle = endpointFixture(f)
  assert.equal((await handle('omni-server-check', { version: older, fallback: true })).value.reason, 'behind')
  status = 404
  const { value: { job } } = await handle('omni-github-install', defaultPayload)
  assert.equal(job.reason, 'unpublished')
  const call = await until(() => f.calls[0])
  call.finish(1)
  await until(async () => (await handle('omni-github-status')).value.job.phase === 'failed')
})

test('the endpoint and plugin view share the job, reject extra fields and honor the team read-only message', async (t) => {
  const f = fixture(t, { onSpawn(call) { if (call.args.includes('--sandbox')) return false } })
  let readOnly = 'Read-only team view.'
  const handle = endpointFixture(f, { readOnly: () => readOnly })
  for (const [action, payload] of [
    ['install', { ...defaultPayload, extra: true }],
    ['install', { ...defaultPayload, exitCode: 3 }],
    ['install', { reason: 'npm-failed', exitCode: 3 }],
    ['status', { id: 4 }],
    ['cancel', null],
    ['ack', {}],
  ]) {
    assert.equal((await handle('omni-github-' + action, payload)).error.code, 'omni-ai/invalid')
  }
  for (const [action, payload] of [['install', defaultPayload], ['cancel', {}], ['ack', { id: 'old' }]]) {
    assert.deepEqual(await handle('omni-github-' + action, payload), { ok: false, error: { code: 'omni-ai/refused', message: readOnly } })
  }
  assert.deepEqual(await handle('omni-github-status', {}), { ok: true, value: { job: null } })
  assert.equal((await handle('omni-plugins')).value.server, null)
  readOnly = undefined
  const started = await handle('omni-github-install', defaultPayload)
  assert.equal(started.ok, true)
  const id = started.value.job.id
  const call = await until(() => f.calls.find(call => call.args.includes('--sandbox')))
  assert.deepEqual((await handle('omni-plugins')).value.server, (await handle('omni-github-status', { id })).value.job)
  call.finish(0, { ok: true, version: pin.version, apiUrl: 'http://localhost:8181' })
  await until(async () => (await handle('omni-github-status', { id })).value.job.phase === 'done')
  assert.equal((await handle('omni-github-ack', { id })).value.claimed, true)
  assert.equal((await handle('omni-github-ack', { id })).value.claimed, false)
  assert.equal((await handle('omni-plugins')).value.server.acknowledged, true)
})

const gitApi = 'https://api.github.com/repos/automagik-si/omni/git/'
const gitUrl = 'https://github.com/automagik-si/omni.git/git-upload-pack'
const gitType = 'application/x-git-upload-pack-result'
const tagRef = 'refs/tags/' + tag
const refPath = 'ref/tags/' + tag
const annotation = 'a'.repeat(40)
const clock = 1_800_000_000_000
const limited = (headers = {}) => new Response(null, {
  status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(clock / 1000 + 600), ...headers },
})
const gitSha = bytes => createHash('sha1').update(bytes).digest()
const gitObject = (type, body) => gitSha(Buffer.concat([Buffer.from(type + ' ' + body.length + '\0'), body]))
const treeEntry = (entry, digest) => gitObject('tree', Buffer.concat([Buffer.from(entry + '\0'), digest]))
const source = Buffer.from('fake Omni')
const sourceTree = ['100755 omni', '40000 bin', '40000 cli', '40000 packages']
  .reduce((digest, entry) => treeEntry(entry, digest), gitObject('blob', source)).toString('hex')
const commitBody = Buffer.from([
  'tree ' + sourceTree, 'parent ' + annotation,
  'author Omni Fixture <fixture@example.test> 1700000000 +0000',
  'committer Omni Fixture <fixture@example.test> 1700000000 +0000',
  '', 'Pinned source', '',
].join('\n'))
const gitPin = { ...pin, commit: gitObject('commit', commitBody).toString('hex'), tree: sourceTree }
const commitPath = 'commits/' + gitPin.commit
const codeloadFor = commit => 'https://codeload.github.com/automagik-si/omni/tar.gz/' + commit
const codeload = codeloadFor(gitPin.commit)
const bunUrl = 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip'
const pkt = value => Buffer.concat([
  Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4, '0')), Buffer.from(value),
])
const refs = (...lines) => Buffer.concat([...lines.map(line => pkt(line + '\n')), Buffer.from('0000')])
const refLine = gitPin.commit + ' ' + tagRef
const gitResponse = (bytes, contentType = gitType) => new Response(bytes, { headers: { 'content-type': contentType } })

function gitPackFixture({ body = commitBody, count = 1, type = 1, size = body.length, extra = '', badTrailer = false } = {}) {
  const header = Buffer.from('5041434b0000000200000000', 'hex')
  header.writeUInt32BE(count, 8)
  const object = [(type << 4) | (size & 15)]
  for (let rest = size >> 4; rest; rest >>= 7) {
    object[object.length - 1] |= 128
    object.push(rest & 127)
  }
  const contents = Buffer.concat([header, Buffer.from(object), deflateSync(body), Buffer.from(extra)])
  return Buffer.concat([contents, badTrailer ? Buffer.alloc(20) : gitSha(contents)])
}

function packReply(pack = gitPackFixture(), { lf = '\n', end = '0000', shallow = gitPin.commit, action = 'shallow' } = {}) {
  return Buffer.concat([
    pkt('shallow-info' + lf), pkt(action + ' ' + shallow + lf), Buffer.from('0001'), pkt('packfile' + lf),
    pkt(Buffer.concat([Buffer.from([1]), pack.subarray(0, 13)])), pkt('\x02progress\n'),
    pkt(Buffer.concat([Buffer.from([1]), pack.subarray(13)])), Buffer.from(end),
  ])
}

function tarEntry(name, type, bytes, mode = '0000644') {
  const header = Buffer.alloc(512)
  header.write(name)
  header.write(mode, 100)
  header.write(bytes.length.toString(8).padStart(11, '0'), 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar', 257)
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

function gitArchive(body = source, commit = gitPin.commit) {
  return gzipSync(Buffer.concat([
    tarEntry('pax_global_header', 'g', Buffer.from('52 comment=' + commit + '\n')),
    tarEntry('omni-fixture/packages/cli/bin/omni', '0', body, '0000755'), Buffer.alloc(1024),
  ]))
}

function gitFixture(t, {
  api = path => path === refPath ? limited() : undefined,
  lsRefs = () => gitResponse(refs(refLine)), pack = () => gitResponse(packReply()),
  archive, env, options,
} = {}) {
  const sent = [], waits = []
  const archiveUrl = codeloadFor(options?.pin?.commit ?? gitPin.commit)
  const f = fixture(t, {
    env, options: {
      pin: gitPin, now: () => clock, wait: async ms => { waits.push(ms) },
      ...(archive ? { verifyArchive: verifyOmniArchive } : {}), ...options,
    },
    fetch(url, request) {
      sent.push([url, request])
      if (url.startsWith(gitApi)) {
        const path = url.slice(gitApi.length)
        const answer = api(path)
        if (answer !== undefined) return answer
        if (path === refPath) return json({ object: { type: 'commit', sha: gitPin.commit } })
        if (path === commitPath) return json({ tree: { sha: gitPin.tree } })
        assert.fail('Unexpected REST read: ' + path)
      }
      if (url === gitUrl) {
        if (request.body.includes('command=ls-refs\n')) return lsRefs()
        if (request.body.includes('command=fetch\n')) return pack()
        assert.fail('Unexpected Git request: ' + request.body)
      }
      if (url === archiveUrl && archive) return new Response(archive)
    },
  })
  return {
    ...f, sent, waits,
    github: () => f.requests.filter(url => url.startsWith(gitApi) || url === gitUrl || url === archiveUrl || url === bunUrl),
    async install() {
      await f.installer.start(defaultPayload)
      return f.done()
    },
  }
}

test('a primary REST limit verifies the tag, packed commit and real archive before building', async t => {
  const f = gitFixture(t, { archive: gitArchive() })
  const job = await f.install()
  assert.equal(job.phase, 'done', job.error)
  assert.match(job.log, /GitHub's API rate limit was reached; checked Omni's v2\.261112\.6 tag and commit over Git instead\./)
  assert.deepEqual(f.waits, [])
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl, codeload, bunUrl])
  const requests = f.sent.filter(([url]) => url === gitUrl).map(([, request]) => request)
  for (const request of requests) {
    assert.equal(request.method, 'POST')
    assert.equal(request.redirect, 'error')
    assert.deepEqual(request.headers, {
      'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request', accept: gitType,
    })
  }
  assert.equal(requests[0].body, '0014command=ls-refs\n00010009peel\n0025ref-prefix ' + tagRef + '\n0000')
  assert.equal(requests[1].body, '0012command=fetch\n00010032want ' + gitPin.commit +
    '\n000ddeepen 1\n0012filter tree:0\n0010no-progress\n0009done\n0000')
})

test('a REST limit at the annotated-tag peel or commit read restarts the whole check over Git', async t => {
  const tagPath = 'tags/' + annotation
  for (const last of [tagPath, commitPath]) {
    const f = gitFixture(t, { api(path) {
      if (path === last) return limited()
      if (path === refPath) return json({ object: { type: 'tag', sha: annotation } })
      if (path === tagPath) return json({ object: { type: 'commit', sha: gitPin.commit } })
    } })
    const job = await f.install()
    assert.equal(job.phase, 'done', job.error)
    const reads = last === commitPath ? [refPath, tagPath, commitPath] : [refPath, tagPath]
    assert.deepEqual(f.github(), [...reads.map(path => gitApi + path), gitUrl, gitUrl, codeload, bunUrl])
  }
})

test('Git peels annotated tags and selects only the exact tag name', async t => {
  const longer = annotation + ' ' + tagRef + '0'
  for (const [lines, error] of [
    [[annotation + ' ' + tagRef + ' peeled:' + gitPin.commit], null],
    [[longer, refLine], null],
    [[gitPin.commit + ' ' + tagRef + ' peeled:' + annotation], /is not the commit/],
    [[longer], /GitHub has no v2\.261112\.6 tag for Omni/],
  ]) {
    const f = gitFixture(t, { lsRefs: () => gitResponse(refs(...lines)) })
    const job = await f.install()
    assert.equal(job.phase, error ? 'failed' : 'done', job.error)
    if (error) {
      assert.equal(job.next, 'update')
      assert.match(job.error, error)
      assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
      assert.deepEqual(f.calls, [])
    }
  }
})

test('Git accepts terminal response-end markers, LF-less text, uppercase IDs and media type parameters', async t => {
  for (const [lf, end, advertised] of [
    ['\n', '00000002', gitPin.commit.toUpperCase() + ' ' + tagRef],
    ['', '0000', annotation.toUpperCase() + ' ' + tagRef + ' peeled:' + gitPin.commit.toUpperCase()],
  ]) {
    const f = gitFixture(t, {
      lsRefs: () => gitResponse(Buffer.concat([pkt(advertised + lf), Buffer.from(end)]), gitType.toUpperCase() + ' ; charset=utf-8'),
      pack: () => gitResponse(packReply(undefined, { lf, end, shallow: gitPin.commit.toUpperCase() })),
    })
    const job = await f.install()
    assert.equal(job.phase, 'done', job.error)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl, codeload, bunUrl])
  }
})

test('malformed Git ref replies preserve the rate-limit refusal and stop before fetching the commit', async t => {
  for (const answer of [
    () => gitResponse(refs(refLine, refLine)),
    () => gitResponse(refs(gitPin.commit + ' bogus')),
    () => gitResponse('<html>proxy</html>'),
    () => gitResponse(refs(refLine), 'text/html'),
    () => gitResponse(refs(refLine), gitType + '-invalid'),
    () => gitResponse(refs(refLine).subarray(0, -5)),
    () => gitResponse(Buffer.concat([refs(refLine), Buffer.from('0000')])),
    () => gitResponse(Buffer.concat([refs(refLine), Buffer.from('0002extra')])),
    () => gitResponse('00020000'),
    () => gitResponse('00010000'),
    () => gitResponse(Buffer.concat([pkt(refLine + '\n\n'), Buffer.from('0000')])),
  ]) {
    const f = gitFixture(t, { lsRefs: answer })
    const job = await f.install()
    assert.equal(job.phase, 'failed')
    assert.equal(job.next, 'retry')
    assert.match(job.error, /rate limit.*about 10 minutes/)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
    assert.deepEqual(f.calls, [])
  }
})

test('invalid advertised ref names yield a retry even with a valid pin or with no matching tag', async t => {
  const invalid = ['..', '\x00', '\x1f', '\x7f', ' ', '~', '^', ':', '?', '*', '[', '\\', '@{', '/', '.', '.lock', '/.hidden']
  for (const [index, suffix] of invalid.entries()) {
    const lines = [...(index % 2 === 0 ? [] : [refLine]), refLine + suffix]
    const f = gitFixture(t, { lsRefs: () => gitResponse(refs(...lines)) })
    const job = await f.install()
    assert.equal(job.phase, 'failed', JSON.stringify(suffix))
    assert.equal(job.next, 'retry', JSON.stringify(suffix))
    assert.match(job.error, /rate limit/)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
  }
})

test('Git rejects an otherwise valid ref response larger than 64 KiB', async t => {
  const extraRefs = Array.from({ length: 85 }, (_, i) => refLine + '-' + i + '/' + ('x'.repeat(174) + '/').repeat(4) + 'x')
  assert.ok(refs(...extraRefs.slice(0, -1), refLine).length <= 64 * 1024)
  const oversized = refs(...extraRefs, refLine)
  assert.ok(oversized.length > 64 * 1024)
  const f = gitFixture(t, { lsRefs: () => gitResponse(oversized) })
  const job = await f.install()
  assert.equal(job.phase, 'failed')
  assert.equal(job.next, 'retry')
  assert.match(job.error, /rate limit/)
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
})

test('Git rejects an oversized packet in a ref response under 64 KiB', async t => {
  const name = refLine + '/'
  const oversized = refs(name + 'x'.repeat(0xfff1 - 5 - name.length))
  assert.equal(oversized.toString('ascii', 0, 4), 'fff1')
  assert.ok(oversized.length < 64 * 1024)
  const f = gitFixture(t, { lsRefs: () => gitResponse(oversized) })
  const job = await f.install()
  assert.equal(job.phase, 'failed')
  assert.equal(job.next, 'retry')
  assert.match(job.error, /rate limit/)
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
})

test('Git requires an authentic single-commit pack and refuses an authentic commit with the wrong tree', async t => {
  const changedBody = Buffer.from(commitBody.toString().replace('Pinned source', 'Other source'))
  for (const reply of [
    packReply(gitPackFixture({ body: changedBody })),
    packReply(gitPackFixture({ count: 2 })),
    packReply(gitPackFixture({ badTrailer: true })),
    packReply(gitPackFixture({ type: 2 })),
    packReply(gitPackFixture({ size: commitBody.length + 1 })),
    packReply(gitPackFixture({ extra: 'junk after deflate' })),
    packReply(undefined, { shallow: 'invalid' }),
    packReply(undefined, { action: 'unshallow' }),
    packReply(undefined, { lf: '\n\n' }),
    packReply(undefined, { end: '00000001' }),
    packReply(undefined, { end: '00020000' }),
    packReply().subarray(0, -4),
  ]) {
    const f = gitFixture(t, { pack: () => gitResponse(reply) })
    const job = await f.install()
    assert.equal(job.phase, 'failed')
    assert.equal(job.next, 'retry')
    assert.match(job.error, /rate limit/)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl])
    assert.deepEqual(f.calls, [])
  }
  const f = gitFixture(t, { options: { pin: { ...gitPin, tree: annotation } } })
  const job = await f.install()
  assert.equal(job.phase, 'failed')
  assert.equal(job.next, 'update')
  assert.match(job.error, /commit does not have the Git tree/)
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl])
  assert.deepEqual(f.calls, [])
})

test('Git accepts a 64 KiB commit body and rejects an authentic body one byte larger', async t => {
  for (const size of [65_536, 65_537]) {
    const body = Buffer.alloc(size, 'x')
    commitBody.copy(body)
    body[size - 1] = 10
    const commit = gitObject('commit', body).toString('hex')
    const reply = packReply(gitPackFixture({ body }), { shallow: commit })
    assert.ok(reply.length < 64 * 1024)
    const f = gitFixture(t, {
      options: { pin: { ...gitPin, commit } },
      lsRefs: () => gitResponse(refs(commit + ' ' + tagRef)),
      pack: () => gitResponse(reply),
      archive: gitArchive(source, commit),
    })
    const job = await f.install()
    const pinChecks = [gitApi + refPath, gitUrl, gitUrl]
    if (size === 65_536) {
      assert.equal(job.phase, 'done', job.error)
      assert.deepEqual(f.github(), [...pinChecks, codeloadFor(commit), bunUrl])
    } else {
      assert.equal(job.phase, 'failed')
      assert.equal(job.next, 'retry')
      assert.match(job.error, /rate limit/)
      assert.deepEqual(f.github(), pinChecks)
      assert.deepEqual(f.calls, [])
    }
  }
})

test('Git rejects a band-3 error in an otherwise valid commit pack', async t => {
  const reply = packReply()
  const withError = Buffer.concat([reply.subarray(0, -4), pkt('\x03Git error\n'), reply.subarray(-4)])
  const f = gitFixture(t, { pack: () => gitResponse(withError) })
  const job = await f.install()
  assert.equal(job.phase, 'failed')
  assert.equal(job.next, 'retry')
  assert.match(job.error, /rate limit/)
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl])
})

test('the Git fallback still requires the archive commit and tree before Bun or build', async t => {
  for (const [archive, error] of [
    [gitArchive(Buffer.from('changed')), /does not match the pinned Git tree/],
    [gitArchive(source, annotation), /does not name the pinned commit/],
  ]) {
    const f = gitFixture(t, { archive })
    const job = await f.install()
    assert.equal(job.phase, 'failed')
    assert.equal(job.next, 'update')
    assert.match(job.error, error)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl, codeload])
    assert.deepEqual(f.calls, [])
  }
})

test('the real archive verifier starts its worker with an empty environment', async () => {
  const previous = process.env.GITHUB_TOKEN
  const { Worker } = workerThreads
  process.env.GITHUB_TOKEN = 'ghp_SENTINEL_ambient_archive_test'
  try {
    workerThreads.Worker = class extends Worker {
      constructor(url, options) {
        assert.deepEqual(options.env, {})
        super(url, options)
      }
    }
    syncBuiltinESMExports()
    const entries = await verifyOmniArchive(new Response(gitArchive()).body, gitPin, AbortSignal.timeout(2500))
    assert.deepEqual(entries.map(entry => [entry.path, Buffer.from(entry.body)]), [['packages/cli/bin/omni', source]])
  } finally {
    workerThreads.Worker = Worker
    syncBuiltinESMExports()
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
})

test('rate-limit refusal gives validated timing and advice for the kind of token used', async t => {
  for (const [headers, token, when] of [
    [{ 'retry-after': '61' }, undefined, 'in about 2 minutes'],
    [{ 'x-ratelimit-reset': String(clock / 1000 - 1) }, undefined, 'later'],
    [{ 'x-ratelimit-reset': String(clock / 1000 + 3601) }, undefined, 'in about an hour'],
    [{ 'x-ratelimit-reset': 'invalid' }, 'ghp_SENTINEL', 'later'],
    [{ 'retry-after': '86401' }, 'invalid token', 'in about 10 minutes'],
  ]) {
    const f = gitFixture(t, {
      env: { GITHUB_TOKEN: token }, api: () => limited(headers),
      lsRefs: () => new Response(null, { status: 404 }),
    })
    const job = await f.install()
    assert.equal(job.phase, 'failed')
    assert.equal(job.next, 'retry')
    assert.ok(job.error.startsWith("GitHub's API rate limit was reached, so Omni's " + tag + ' pin could not be checked.'))
    assert.ok(job.error.includes('Try again ' + when + '.'))
    assert.match(job.error, token === 'ghp_SENTINEL' ? /GITHUB_TOKEN's own limit/ : /same network shares this limit.*set GITHUB_TOKEN/i)
    assert.ok(job.error.length <= 600)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
  }
})

test('rate-limit refusal uses the remaining Retry-After time or the reset when it expires', async t => {
  for (const [elapsed, reset, when] of [
    [30, 600, 'in about 1 minute'],
    [90, 600, 'in about 9 minutes'],
    [90, 60, 'later'],
  ]) {
    let at = clock
    const f = gitFixture(t, {
      api: () => limited({ 'retry-after': '61', 'x-ratelimit-reset': String(clock / 1000 + reset) }),
      options: { now: () => at },
      lsRefs() {
        at += elapsed * 1000
        return new Response(null, { status: 404 })
      },
    })
    const job = await f.install()
    assert.equal(job.phase, 'failed')
    assert.equal(job.next, 'retry')
    assert.match(job.error, /rate limit/)
    assert.ok(job.error.includes('Try again ' + when + '.'), job.error)
    assert.deepEqual(f.github(), [gitApi + refPath, gitUrl])
  }
})

test('REST and Git retry transient failures twice, and ordinary REST exhaustion does not fall back', async t => {
  for (const network of [false, true]) {
    for (const failures of [2, 3]) {
      let reads = 0
      const f = gitFixture(t, { api(path) {
        if (path !== refPath || ++reads > failures) return
        if (network) return Promise.reject(new TypeError('Network unavailable'))
        return new Response(null, { status: 502 })
      } })
      const job = await f.install()
      assert.deepEqual(f.waits, [1000, 2000])
      const retries = Array(3).fill(gitApi + refPath)
      assert.deepEqual(f.github(), failures === 2 ? [...retries, gitApi + commitPath, codeload, bunUrl] : retries)
      assert.equal(job.phase, failures === 2 ? 'done' : 'failed', job.error)
      if (failures === 3) assert.equal(job.error, "Could not check Omni's " + tag + ' pin on GitHub.')
    }
  }
  let gitReads = 0
  const f = gitFixture(t, { lsRefs() {
    if (++gitReads === 1) return Promise.reject(new TypeError('Network unavailable'))
    return new Response(null, { status: 500 })
  } })
  const job = await f.install()
  assert.equal(job.phase, 'failed')
  assert.equal(job.next, 'retry')
  assert.match(job.error, /rate limit.*about 10 minutes/)
  assert.deepEqual(f.waits, [1000, 2000])
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl, gitUrl])
  assert.deepEqual(f.calls, [])
})

test('short secondary limits retry while long, exhausted or body-confirmed limits use Git', async t => {
  const secondary = seconds => new Response(null, { status: 429, headers: { 'retry-after': seconds } })
  const cases = [
    [() => secondary('3'), 1, [3000], false],
    [() => secondary('3'), 3, [3000, 3000], true],
    [() => secondary('60'), 1, [], true],
    [() => new Response('{"message":"API rate limit exceeded"}', { status: 403 }), 1, [], true],
    [() => new Response('Rate limit exceeded', { status: 429 }), 1, [], true],
  ]
  for (const [response, attempts, waits, fallbackUsed] of cases) {
    let reads = 0
    const f = gitFixture(t, { api(path) {
      if (path === refPath && ++reads <= attempts) return response()
    } })
    const job = await f.install()
    assert.equal(job.phase, 'done', job.error)
    assert.deepEqual(f.waits, waits)
    const rest = Array(attempts + Number(!fallbackUsed)).fill(gitApi + refPath)
    assert.deepEqual(f.github(), [...rest, ...(fallbackUsed ? [gitUrl, gitUrl] : [gitApi + commitPath]), codeload, bunUrl])
  }
})

test('a headerless REST rate limit uses the first 4 KiB and cancels the rest of its body', async t => {
  let cancelled = false
  const f = gitFixture(t, { api: () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('API rate limit exceeded'))
      controller.enqueue(Buffer.alloc(5 * 1024, 'x'))
    },
    cancel() { cancelled = true },
  }), { status: 403 }) })
  const job = await f.install()
  assert.equal(job.phase, 'done', job.error)
  assert.equal(cancelled, true)
  assert.deepEqual(f.github(), [gitApi + refPath, gitUrl, gitUrl, codeload, bunUrl])
})

test('bare REST failures and REST pin mismatches never send a Git request', async t => {
  for (const [path, response, error, next] of [
    [refPath, () => new Response(null, { status: 403 }), /Could not check/, 'retry'],
    [refPath, () => new Response(null, { status: 404 }), /Could not check/, 'retry'],
    [refPath, () => new Response('not JSON'), /Could not check/, 'retry'],
    [refPath, () => new Response('{"error":"forbidden","help":"see rate limit documentation"}', { status: 403 }), /Could not check/, 'retry'],
    [refPath, () => new Response('[{"error":"forbidden","help":"see rate limit documentation"}]', {
      status: 403, headers: { 'content-type': 'application/json' },
    }), /Could not check/, 'retry'],
    [refPath, () => new Response('[{"message":"API rate limit exceeded"}]', { status: 403 }), /Could not check/, 'retry'],
    [refPath, () => new Response('"API rate limit exceeded"', {
      status: 403, headers: { 'content-type': 'application/vnd.github+json; charset=utf-8' },
    }), /Could not check/, 'retry'],
    [refPath, () => new Response(JSON.stringify({
      error: 'forbidden', help: 'see rate limit documentation', pad: 'x'.repeat(5 * 1024),
    }), { status: 403 }), /Could not check/, 'retry'],
    [refPath, () => new Response('x'.repeat(4096) + 'rate limit', { status: 403 }), /Could not check/, 'retry'],
    [refPath, () => json({ object: { type: 'commit', sha: annotation } }), /is not the commit/, 'update'],
    [commitPath, () => json({ tree: { sha: annotation } }), /commit does not have the Git tree/, 'update'],
  ]) {
    const f = gitFixture(t, { api: read => read === path ? response() : undefined })
    const job = await f.install()
    assert.equal(job.phase, 'failed')
    assert.equal(job.next, next)
    assert.match(job.error, error)
    assert.deepEqual(f.waits, [])
    assert.deepEqual(f.github(), path === refPath ? [gitApi + refPath] : [gitApi + refPath, gitApi + commitPath])
    assert.deepEqual(f.calls, [])
  }
})

test('cancellation and download timeout interrupt backoff and release the lock before any retry', async t => {
  for (const timeout of [false, true]) {
    const waiting = Promise.withResolvers()
    const f = gitFixture(t, {
      api: () => new Response(null, { status: 502 }),
      options: {
        downloadMs: timeout ? 50 : 5000,
        wait(ms, value, { signal }) {
          waiting.resolve(signal)
          return delay(ms, value, { signal })
        },
      },
    })
    const { job: { id } } = await f.installer.start(defaultPayload)
    const signal = await waiting.promise
    if (!timeout) f.installer.cancel({ id })
    const job = await f.done()
    assert.equal(job.phase, timeout ? 'failed' : 'cancelled')
    assert.equal(signal.aborted, true)
    if (timeout) assert.equal(job.error, 'The Omni download step took too long.')
    assert.equal(existsSync(join(f.build, 'install.lock')), false)
    assert.deepEqual(f.github(), [gitApi + refPath])
    assert.deepEqual(f.calls, [])
  }
})

test('the GitHub token stays on fixed REST requests and out of both job outcomes and child environments', async t => {
  const token = 'ghp_SENTINEL_for_omni_test'
  for (const succeeds of [true, false]) {
    const f = gitFixture(t, {
      env: { GITHUB_TOKEN: token },
      api(path) {
        if (path === commitPath) return new Response(JSON.stringify({ message: 'rate limit ' + token }), { status: 403 })
      },
      pack: () => succeeds ? gitResponse(packReply()) : new Response(token, { status: 403 }),
    })
    const job = await f.install()
    assert.equal(job.phase, succeeds ? 'done' : 'failed', job.error)
    assert.equal(JSON.stringify(job).includes(token), false)
    assert.deepEqual(f.github(), [gitApi + refPath, gitApi + commitPath, gitUrl, gitUrl, ...(succeeds ? [codeload, bunUrl] : [])])
    for (const [url, request] of f.sent) {
      if (url.startsWith(gitApi)) {
        assert.equal(request.redirect, 'error')
        assert.deepEqual(request.headers, { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token })
      } else {
        assert.equal(new Headers(request.headers).has('authorization'), false, url)
      }
    }
    assert.equal(f.calls.length, succeeds ? 5 : 0)
    for (const { options } of f.calls) {
      assert.equal(Object.hasOwn(options.env, 'GITHUB_TOKEN'), false)
      assert.equal(JSON.stringify(options.env).includes(token), false)
    }
  }
})
