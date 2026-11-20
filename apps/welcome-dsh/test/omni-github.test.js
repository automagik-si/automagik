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
import { install } from '../src/host/endpoint.js'
import { atLoginUsable, bunPathOf, createOmniInstaller, routeOf } from '../src/host/omni-github.js'
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
