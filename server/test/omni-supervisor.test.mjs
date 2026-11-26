import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { redactTokens } from '../lib.mjs'
import { createOmniSupervisor } from '../omni-supervisor.mjs'

const fakeRoot = '/workspace/omni'
const home = join(fakeRoot, 'sandbox')
const lockPath = join(fakeRoot, 'automagik-build', 'supervisor.lock')
const pidPath = join(home, 'run', 'supervisor.pid')
const markerPath = join(home, 'automagik-supervised.json')
const cliPath = join(home, 'runtime', 'node_modules', '@automagik', 'omni', 'bin', 'omni')
const bun = 'a fake Bun executable'
const sha256 = createHash('sha256').update(bun).digest('hex')
const bunPath = join(fakeRoot, 'automagik-bun', `1.4.4-${sha256.slice(0, 12)}`, 'bun')
const marker = { version: '2.261112.6', bun: { version: '1.4.4', sha256 } }

const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
const gone = () => Object.assign(new Error('gone'), { code: 'ESRCH' })
const info = isDir => ({ isDirectory: () => isDir, isFile: () => !isDir, uid: process.getuid() })
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const contents = new Map()
  const dirs = new Set()
  const opened = new Map()
  const groups = new Set()
  const effects = []
  const children = []
  const warnings = []
  const logs = []
  const controls = { lease: true, surviveKill: false, spawnError: false }
  let nextFd = 12
  const fs = {
    lstatSync(path, { throwIfNoEntry = true } = {}) {
      if (dirs.has(path)) return info(true)
      if (contents.has(path)) return info(false)
      if (throwIfNoEntry) throw missing()
    },
    statSync: (path) => fs.lstatSync(path),
    mkdirSync: path => dirs.add(path),
    openSync(path, flags, mode) {
      effects.push(['open', path, mode])
      if (!contents.has(path)) contents.set(path, '')
      const fd = nextFd++
      opened.set(fd, path)
      return fd
    },
    fstatSync: fd => fs.lstatSync(opened.get(fd)),
    fchmodSync: (fd, mode) => effects.push(['chmod', fd, mode]),
    closeSync(fd) {
      assert.ok(opened.delete(fd))
      effects.push(['close', fd])
    },
    readFileSync(path) {
      if (!contents.has(path)) throw missing()
      return contents.get(path)
    },
    createReadStream(path) {
      effects.push(['hash', path])
      return Readable.from([fs.readFileSync(path)])
    },
    unlinkSync(path) {
      assert.ok(opened.size, 'stale PID removal requires the lease descriptor')
      effects.push(['unlink', path])
      if (!contents.delete(path)) throw missing()
    },
  }
  const env = {
    HOME: '/workspace', OMNI_HOME: fakeRoot, PATH: '/bin', TMPDIR: '/scratch', LANG: 'C.UTF-8',
    HTTPS_PROXY: 'https://proxy.example', no_proxy: 'localhost', SSL_CERT_FILE: '/ca.pem',
    NODE_EXTRA_CA_CERTS: '/extra.pem', DO_NOT_TRACK: '0',
    DEEPSEEK_API_KEY: 'private', OMNI_API_KEY: 'private', DSH_AUTH_TOKEN: 'private',
    HC_SOCKET: 'private', NODE_OPTIONS: 'private',
  }
  const supervisor = createOmniSupervisor({
    env, fs, log: line => logs.push(line), warn: line => warnings.push(line),
    spawn(file, args, options) {
      const child = new EventEmitter()
      if (file === '/usr/bin/flock') {
        effects.push(['flock', args, options.stdio])
        assert.ok(opened.has(options.stdio[3]))
        queueMicrotask(() => child.emit('exit', controls.lease ? 0 : 1, null))
      } else {
        assert.equal(opened.size, 1, 'the parent keeps the lease open across all Omni instances')
        if (!controls.spawnError) {
          child.pid = 100 + children.length
          groups.add(child.pid)
        } else {
          queueMicrotask(() => child.emit('error', missing()))
        }
        Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() })
        children.push({ file, args, options, child })
      }
      return child
    },
    kill(pid, signal) {
      effects.push(['signal', pid, signal])
      if (!groups.has(Math.abs(pid))) throw gone()
      if (signal === 'SIGKILL' && !controls.surviveKill) {
        groups.delete(-pid)
        children.find(row => row.child.pid === -pid)?.child.emit('exit', null, signal)
      }
    },
  })
  t.after(async () => {
    groups.clear()
    for (const { child } of children) child.emit('exit', 0, null)
    const stopped = supervisor.stop()
    t.mock.timers.tick(50)
    await stopped
  })
  return {
    controls, contents, effects, opened, children, groups, warnings, logs, supervisor,
    publish(value = marker) {
      dirs.add(home)
      dirs.add(join(home, 'run'))
      contents.set(markerPath, JSON.stringify(value))
      contents.set(cliPath, 'fake Omni CLI')
      contents.set(bunPath, bun)
      contents.set(pidPath, '999999\n')
    },
    async start() { supervisor.start(); await flush() },
    async tick(ms) { t.mock.timers.tick(ms); await flush() },
    signals: () => effects.filter(([event, , name]) => event === 'signal' && name !== 0),
  }
}

test('holds the kernel lease while idle and starts only from a published marker using the exact runtime and env', async t => {
  const f = fixture(t)
  await f.start()
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.effects, [
    ['open', lockPath, 0o600], ['chmod', 12, 0o600],
    ['flock', ['--exclusive', '--nonblock', '3'], ['ignore', 'ignore', 'ignore', 12]],
  ])
  assert.equal(f.opened.size, 1)
  f.publish({ ...marker, bun: { ...marker.bun, path: '/ignored/bun' }, cliPath: '/ignored/omni' })
  await f.tick(3000)
  const [{ file, args, options, child }] = f.children
  assert.equal(file, bunPath)
  assert.deepEqual(args, [cliPath, 'sandbox', 'run', '--home', home, '--embedded'])
  assert.deepEqual(options, {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: '/workspace', OMNI_HOME: fakeRoot, PATH: '/bin', TMPDIR: '/scratch', LANG: 'C.UTF-8',
      HTTPS_PROXY: 'https://proxy.example', no_proxy: 'localhost', SSL_CERT_FILE: '/ca.pem',
      NODE_EXTRA_CA_CERTS: '/extra.pem', DO_NOT_TRACK: '1',
    },
  })
  f.groups.delete(child.pid)
  child.emit('exit', 0, null)
  await f.supervisor.stop()
  assert.equal(f.opened.size, 0)
  assert.ok(f.contents.has(lockPath), 'the lock inode is kept for future holders')
})

test('a competing lease blocks launch and stale PID removal with at most one warning per minute', async t => {
  const f = fixture(t)
  f.publish()
  f.controls.lease = false
  await f.start()
  await f.tick(3000)
  assert.equal(f.opened.size, 0)
  assert.equal(f.children.length, 0)
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /lease/)
  assert.equal(f.contents.has(pidPath), true)
  await f.tick(57_000)
  assert.equal(f.warnings.length, 2)
  f.controls.lease = true
  await f.tick(3000)
  assert.equal(f.children.length, 1)
  assert.equal(f.contents.has(pidPath), false)
  const stop = f.supervisor.stop()
  await flush()
  f.children[0].child.emit('exit', 0, null)
  await stop
})

test('invalid marker names and a bad Bun checksum cannot spawn or remove the PID', async t => {
  const f = fixture(t)
  f.publish({ ...marker, bun: { ...marker.bun, version: '../ignored' } })
  await f.start()
  assert.equal(f.children.length, 0)
  assert.equal(f.contents.has(pidPath), true)
  assert.equal(f.effects.filter(([event]) => event === 'hash').length, 0)
  f.publish()
  f.contents.set(bunPath, 'tampered')
  await f.tick(60_000)
  await f.supervisor.stop()
  assert.equal(f.children.length, 0)
  assert.equal(f.contents.has(pidPath), true)
  assert.match(f.warnings.at(-1), /Bun checksum mismatch/)
})

test('on a crash, kills and reaps the group before retrying, rehashes Bun and leaves later PID files alone', async t => {
  const f = fixture(t)
  f.publish()
  await f.start()
  assert.equal(f.contents.has(pidPath), false)
  f.contents.set(pidPath, 'left by Omni')
  f.controls.surviveKill = true
  f.children[0].child.emit('exit', 1, null)
  await flush()
  assert.deepEqual(f.signals(), [['signal', -100, 'SIGKILL']])
  await f.tick(1000)
  assert.equal(f.children.length, 1)
  f.groups.delete(100)
  await f.tick(50)
  await f.tick(999)
  assert.equal(f.children.length, 1)
  await f.tick(1)
  assert.equal(f.children.length, 2)
  assert.equal(f.contents.get(pidPath), 'left by Omni')
  assert.deepEqual(f.effects.filter(([event]) => event === 'unlink'), [['unlink', pidPath]])
  assert.equal(f.effects.filter(([event]) => event === 'hash').length, 2)
  f.controls.surviveKill = false
  const stop = f.supervisor.stop()
  await flush()
  f.children[1].child.emit('exit', 0, null)
  await stop
})

test('backs off from one second to thirty on spawn errors and never restarts after stop', async t => {
  const f = fixture(t)
  f.controls.spawnError = true
  f.publish()
  await f.start()
  for (const [i, seconds] of [1, 2, 4, 8, 16, 30, 30].entries()) {
    assert.match(f.warnings.at(-1), new RegExp(`restarting in ${seconds}s`))
    await f.tick(seconds * 1000 - 1)
    assert.equal(f.children.length, i + 1)
    await f.tick(1)
  }
  await f.supervisor.stop()
  await f.tick(60_000)
  f.supervisor.start()
  assert.equal(f.children.length, 8)
  assert.deepEqual(f.signals(), [])
  assert.equal(f.opened.size, 0)
})

test('stopping signals only the leader to drain, then kills remaining group members on leader exit', async t => {
  const f = fixture(t)
  f.publish()
  await f.start()
  const stop = f.supervisor.stop()
  await flush()
  assert.deepEqual(f.signals(), [['signal', 100, 'SIGTERM']])
  f.children[0].child.emit('exit', 0, null)
  await stop
  assert.deepEqual(f.signals(), [['signal', 100, 'SIGTERM'], ['signal', -100, 'SIGKILL']])
  assert.equal(f.opened.size, 0)
})

test('stopping a stuck Omni leader gives it exactly 60 seconds before killing and reaping the group', async t => {
  const f = fixture(t)
  f.publish()
  await f.start()
  const stop = f.supervisor.stop()
  await flush()
  assert.deepEqual(f.signals(), [['signal', 100, 'SIGTERM']])
  assert.equal(f.opened.size, 1)
  await f.tick(59_999)
  assert.equal(f.signals().length, 1)
  assert.equal(f.opened.size, 1)
  await f.tick(1)
  await stop
  assert.deepEqual(f.signals(), [['signal', 100, 'SIGTERM'], ['signal', -100, 'SIGKILL']])
  assert.equal(f.opened.size, 0)
})

test('Omni stream diagnostics redact across chunks, prefix stdout and stderr, and omit overlong lines', async t => {
  const f = fixture(t)
  f.publish()
  await f.start()
  const { child } = f.children[0]
  child.stdout.write('Omni request authorization: Bearer aabb')
  child.stdout.end('ccddeeff==\n')
  child.stderr.write('🍄'.repeat(16_385))
  child.stderr.end('continuation\nOmni ready\n')
  await flush()
  assert.deepEqual(f.logs, ['[omni] starting Omni 2.261112.6', '[omni] Omni request authorization: <redacted> <redacted>'])
  assert.deepEqual(f.warnings, ['[omni] [overlong line omitted]', '[omni] Omni ready'])
  const stop = f.supervisor.stop()
  await flush()
  child.emit('exit', 0, null)
  await stop
})

test('redacts complete credentials in Omni and proxy diagnostics', () => {
  const line = String.raw`Omni auth Basic dXNlcjpwYXNz== proxy=https://ci:proxy@secret@proxy.test:8443/path?access_token=abc&ready=yes {"api_key":"embedded \"text\" stays private","password":"two words","token":"short"} api-key=abc password: xyz client_secret=supersecret`
  const safe = redactTokens(line)
  for (const secret of ['dXNlcjpwYXNz', 'ci:proxy', '@secret', 'abc', 'embedded', 'stays private', 'two words',
    '"short"', 'xyz', 'supersecret']) assert.ok(!safe.includes(secret))
  assert.match(safe, /Basic <redacted> proxy=https:\/\/<redacted>@proxy\.test:8443\/path\?access_token=<redacted>&ready=yes/)
  assert.match(safe, /"api_key":"<redacted>","password":"<redacted>","token":"<redacted>"/)
  const providerKey = ['sk', 'fakeomnikey0123456789'].join('-')
  assert.equal(redactTokens(`Omni received ${providerKey}`), 'Omni received <redacted>')
  assert.equal(redactTokens('OMNI_API_KEY=z'), 'OMNI_API_KEY=<redacted>')
})

test('entrypoint rejects a custom OMNI_HOME that resolves into the gate view before launching children', t => {
  const root = mkdtempSync(join(tmpdir(), 'automagik-omni-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const alias = join(root, 'alias')
  symlinkSync(root, alias)
  const script = `
    import fs from 'node:fs'
    import childProcess from 'node:child_process'
    import { registerHooks, syncBuiltinESMExports } from 'node:module'
    const exists = fs.existsSync
    fs.existsSync = file => file !== '/data' && exists(file)
    childProcess.spawn = () => { throw new Error('unexpected child spawn') }
    syncBuiltinESMExports()
    registerHooks({
      load(url, context, next) {
        if (url === ${JSON.stringify(new URL('../profile-follow.mjs', import.meta.url).href)}) {
          return { format: 'module', shortCircuit: true,
            source: 'export function followImage() { throw new Error("unexpected profile follow") }' }
        }
        return next(url, context)
      },
    })
    await import(${JSON.stringify(new URL('../entrypoint.mjs', import.meta.url).href)})
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 5000, env: {
      HOME: root, PATH: process.env.PATH, AUTOMAGIK_HOME: root, OMNI_HOME: join(alias, 'gate-view', 'sandbox'),
    },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /gate-view overlaps omni/)
})
