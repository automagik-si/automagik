import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { connectCore, CoreConnection, encodeFrame, KINDS } from '../src/host/code-core.js'
import { coreSockets } from '../src/host/core-probe.js'
import { listenForCoreStatus } from './fixtures/fake-core-probe.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'code-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_RUNTIME_DIR: join(root, 'run'),
    XDG_STATE_HOME: join(root, 'state'),
    AUTOMAGIK_HERDR_TEST_ROOTS: root,
  }
  const config = join(env.XDG_CONFIG_HOME, 'herdr-core', 'config.toml')
  const configure = (socket) => {
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, `socket = ${JSON.stringify(socket)} # the core's custom path\n`)
  }
  const attempted = new Error('fixture intercepted spawn')
  const spawn = t.mock.fn(() => { throw attempted })
  const connect = () => connectCore({ env, spawn })
  return { root, env, configure, attempted, spawn, connect }
}

test('a configured socket with no listener returns no-core without spawning', async (t) => {
  const f = fixture(t)
  f.configure(join(f.root, 'configured'))
  await assert.rejects(f.connect, { kind: 'no-core' })
  assert.equal(f.spawn.mock.callCount(), 0)
})

test('a stale HC_SOCKET falls through to a live configured socket without a suffix', async (t) => {
  const f = fixture(t)
  f.env.HC_SOCKET = join(f.root, 'stale.sock')
  const live = join(f.root, 'configured core')
  f.configure(live)
  const status = listenForCoreStatus(t, live)
  await status.ready
  await assert.rejects(f.connect, error => error === f.attempted)
  assert.equal(f.spawn.mock.callCount(), 1)
  assert.equal(f.spawn.mock.calls[0].arguments[2].env.HC_SOCKET, live)
  assert.deepEqual(status.requests, [{ jsonrpc: '2.0', id: 1, method: 'server.status', params: {} }])
})

test('the resolved session can contain spaces, and its stopped listener cannot start a core', async (t) => {
  const f = fixture(t)
  f.env.HC_SESSION = 'team one'
  const path = join(f.env.XDG_RUNTIME_DIR, 'herdr-core', 'team one.sock')
  mkdirSync(dirname(path), { recursive: true })
  const status = listenForCoreStatus(t, path)
  await status.ready
  await assert.rejects(f.connect, error => error === f.attempted)
  assert.equal(f.spawn.mock.calls[0].arguments[2].env.HC_SOCKET, path)
  await status.close()
  await assert.rejects(f.connect, { kind: 'no-core' })
  assert.equal(f.spawn.mock.callCount(), 1)
})

test('HC_SOCKET wins over the test override and a lock accepts an extensionless socket', async (t) => {
  const f = fixture(t)
  f.env.HC_SOCKET = join(f.root, 'explicit')
  f.env.AUTOMAGIK_HERDR_CORE_SOCKET = join(f.root, 'test.sock')
  const recorded = join(f.root, 'recorded')
  const lock = join(f.env.XDG_STATE_HOME, 'herdr-core', 'default', 'core.lock')
  mkdirSync(dirname(lock), { recursive: true })
  writeFileSync(lock, `${recorded}\n`)
  const explicit = listenForCoreStatus(t, f.env.HC_SOCKET)
  const fallback = listenForCoreStatus(t, recorded)
  await Promise.all([explicit.ready, fallback.ready])
  assert.deepEqual(coreSockets(f.env), [
    f.env.HC_SOCKET, f.env.AUTOMAGIK_HERDR_CORE_SOCKET,
    join(f.env.XDG_RUNTIME_DIR, 'herdr-core', 'default.sock'), recorded,
  ])
  assert.deepEqual(coreSockets(f.env, { platform: 'win32' }), [])
  await assert.rejects(f.connect, error => error === f.attempted)
  assert.equal(fallback.requests.length, 0)
  await explicit.close()
  await assert.rejects(f.connect, error => error === f.attempted)
  assert.equal(f.spawn.mock.calls[1].arguments[2].env.HC_SOCKET, recorded)
})

test('a listener that refuses server.status does not count as an answer', async (t) => {
  const f = fixture(t)
  const path = join(f.root, 'refused')
  f.env.HC_SOCKET = path
  const { createServer } = await import('node:net')
  const server = createServer(socket => socket.once('data', () => socket.end('{"jsonrpc":"2.0","id":1,"error":{"code":-1}}\n')))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve))
  await assert.rejects(f.connect, { kind: 'no-core' })
  assert.equal(f.spawn.mock.callCount(), 0)
})

test('watch replays at most eight early resize hints in order and delivers live hints without arguments', async (t) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.emit('exit') },
  })
  const core = new CoreConnection(child)
  t.after(() => core.close())
  const hello = core.start()
  child.stdout.write('{"result":{"framed":true,"generation":1}}\n')
  await hello

  const attached = core.attach({ terminal: 'fake', cols: 80, rows: 24 })
  const channel = 7
  const data = text => encodeFrame(channel, KINDS.data, text)
  const hint = payload => encodeFrame(channel, KINDS.resize, payload)
  child.stdout.write(Buffer.concat([
    data('old'), hint('opaque'),
    encodeFrame(0, KINDS.data, JSON.stringify({ id: 1, result: { channel } })),
    data('next'),
    ...Array.from({ length: 9 }, () => hint(Buffer.alloc(0))), data('last'),
  ]))
  await attached
  assert.equal(core.earlyBytes, Buffer.byteLength('oldnextlast'))
  const events = []
  core.watch(channel, {
    onData: bytes => events.push(bytes.toString()),
    onResize: (...args) => { assert.deepEqual(args, []); events.push('hint') },
  })
  assert.deepEqual(events, ['old', 'hint', 'next', ...Array(7).fill('hint'), 'last'])
  assert.equal(core.earlyBytes, 0)
  child.stdout.write(hint(Buffer.alloc(29, 255)))
  assert.equal(events.at(-1), 'hint')
  core.detach(channel)
  child.stdout.write(data('unread'))
  assert.equal(core.earlyBytes, 0, 'a detached channel cannot buffer more data')
})
