import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inheritedSockets } from '../src/close-inherited.cjs'
import { CLOSE_INHERITED, DETACH_CLEAN } from '../src/child-paths.js'
import { startDsh, stopDsh } from '../src/dsh.js'
import { startDetached } from '../src/herdr.js'

const linuxOnly = { skip: process.platform !== 'linux', timeout: 15_000 }
const helper = fileURLToPath(new URL('../src/close-inherited.cjs', import.meta.url))
const herdr = new URL('../src/herdr.js', import.meta.url).href

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-inherited-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('only non-CLOEXEC sockets above stderr and outside keep are inherited', linuxOnly, t => {
  const root = scratch(t)
  const fdDir = join(root, 'fd')
  const infoDir = join(root, 'fdinfo')
  mkdirSync(fdDir)
  mkdirSync(infoDir)
  const entries = [
    [0, 'socket:[1]', '04002'],
    [1, 'socket:[1]', '04002'],
    [2, 'socket:[1]', '04002'],
    [3, 'socket:[1]', '04002'],
    [4, 'socket:[2]', '02004002'],
    [5, 'pipe:[2]', '04002'],
    [6, '/tmp/ada', '04002'],
    [40, 'socket:[3]', '04002'],
    [41, 'socket:[4]', '04002'],
    [42, 'socket:[5]', null],
    [43, 'socket:[6]', 'invalid'],
  ]
  for (const [fd, link, flags] of entries) {
    symlinkSync(link, join(fdDir, String(fd)))
    if (flags !== null) writeFileSync(join(infoDir, String(fd)), `pos:\t0\nflags:\t${flags}\n`)
  }
  assert.deepEqual(inheritedSockets({ fdDir, infoDir, keep: [3, 41] }), [40])
})

const socketReader = `
const fs = require('node:fs')
function sockets(pid = 'self') {
  const dir = '/proc/' + pid + '/fd'
  return fs.readdirSync(dir).flatMap(name => {
    try {
      const link = fs.readlinkSync(dir + '/' + name)
      return link.startsWith('socket:[') ? [link] : []
    } catch { return [] }
  })
}
`

async function listener(t) {
  const server = createServer(socket => socket.end())
  t.after(() => server.close())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server, port: server.address().port,
    fd: server._handle.fd,
    inode: readlinkSync('/proc/self/fd/' + server._handle.fd),
  }
}

function intermediate(t, args, fd) {
  const stdio = Array(41).fill('ignore')
  stdio[3] = 'ipc'
  stdio[40] = fd
  const child = spawn(process.execPath, args, { stdio, detached: true })
  t.after(() => stopGroup(child))
  return child
}

async function stopGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  await exited
}

test('preload closes the inherited listener, preserves IPC and spares the parent', linuxOnly,
  async t => {
    const root = scratch(t)
    const fixture = join(root, 'child.cjs')
    writeFileSync(fixture, socketReader + `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
})
child.once('spawn', () => process.send({
  own: sockets(), grandchild: sockets(child.pid), pid: child.pid,
}))
setInterval(() => {}, 1000)
`)
    const { server, fd, inode, port } = await listener(t)
    // Requiring the helper alone closes nothing: this also proves the inherited-fd fixture.
    const untreated = intermediate(t, ['--require', helper, fixture], fd)
    const [before] = await once(untreated, 'message')
    assert.ok(before.own.includes(inode))
    assert.ok(before.grandchild.includes(inode))
    await stopGroup(untreated)

    const cleaned = intermediate(t, ['--require', CLOSE_INHERITED, fixture], fd)
    const [after] = await once(cleaned, 'message')
    assert.equal(after.own.includes(inode), false)
    assert.equal(after.grandchild.includes(inode), false)
    // close(), not shutdown(): the parent's copy still accepts connections.
    const connection = createConnection({ host: '127.0.0.1', port })
    t.after(() => connection.destroy())
    await once(connection, 'connect')
    connection.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const rebound = createServer()
    t.after(() => rebound.close())
    rebound.listen(port, '127.0.0.1')
    await once(rebound, 'listening')
    assert.equal(cleaned.exitCode, null)
    process.kill(after.pid, 0)
  })

test('preload preserves IPC at a high descriptor', linuxOnly, async t => {
  const root = scratch(t)
  const probe = join(root, 'probe.cjs')
  writeFileSync(probe, `
const assert = require('node:assert/strict')
assert.equal(process.channel?.fd, 40)
assert.equal(process.env.NODE_CHANNEL_FD, undefined)
`)
  const stdio = Array(41).fill('ignore')
  stdio[2] = 'pipe'
  stdio[40] = 'ipc'
  const child = spawn(process.execPath, [
    '--require', probe, '--require', CLOSE_INHERITED, '-e', `
process.once('message', message => {
  process.send({ message, fd: process.channel.fd }, () => process.disconnect())
})
`,
  ], { stdio })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const messages = []
  child.on('message', message => messages.push(message))
  const closed = once(child, 'close')
  child.send('ping')
  const [code, signal] = await closed
  assert.equal(code, 0, stderr)
  assert.equal(signal, null)
  assert.deepEqual(messages, [{ message: 'ping', fd: 40 }])
})

test('startDsh preloads cleanup before the bin and keeps its URL and IPC', async t => {
  const root = scratch(t)
  const bin = join(root, 'dsh.cjs')
  writeFileSync(bin, `
process.send({ ready: true })
console.log('dsh web: http://127.0.0.1:54321/?token=fixture')
setInterval(() => {}, 1000)
`)
  let message
  const { child, url } = await startDsh({
    node: process.execPath, bin, port: 54321, env: process.env, cwd: root, timeoutMs: 5000,
    spawn: (node, args, options) => {
      assert.equal(node, process.execPath)
      assert.deepEqual(args.slice(0, 3), ['--require', CLOSE_INHERITED, bin])
      assert.equal(options.env.NODE_OPTIONS, process.env.NODE_OPTIONS)
      return spawn(node, args, options)
    },
    onSpawn: child => {
      t.after(() => stopDsh(child))
      message = once(child, 'message')
      message.catch(() => {})
    },
  })
  assert.equal(url, 'http://127.0.0.1:54321/?token=fixture')
  assert.deepEqual((await message)[0], { ready: true })
  await stopDsh(child)
})

test('startDsh puts the preload before the bin in its spawn arguments', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  })
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  const started = startDsh({
    node: '/tmp/ada/node', bin: '/tmp/ada/dsh.cjs', env, port: 54321,
    spawn: (file, args, options) => {
      assert.equal(file, '/tmp/ada/node')
      assert.deepEqual(args.slice(0, 3), ['--require', CLOSE_INHERITED, '/tmp/ada/dsh.cjs'])
      assert.equal(options.env, env)
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc'])
      return child
    },
  })
  child.stdout.emit('data', 'dsh web: http://127.0.0.1:54321/?token=fixture')
  assert.equal((await started).url, 'http://127.0.0.1:54321/?token=fixture')
  assert.equal(env.NODE_OPTIONS, undefined)
})

test('the TUI runner closes inherited sockets as its first body statement', () => {
  const source = readFileSync(new URL('../src/dsh-tui-run.mjs', import.meta.url), 'utf8')
  const body = source.split('\n').filter(line => !/^(\/\/|import\s|\s*$)/.test(line)).join('\n')
  assert.ok(body.startsWith('closeInheritedSockets()\n'))
  assert.match(source, /import \{ closeInheritedSockets \} from '\.\/close-inherited.cjs'/)
})

test('the packaged TUI runner includes every relative import beside it', () => {
  const runner = readFileSync(new URL('../src/dsh-tui-run.mjs', import.meta.url), 'utf8')
  const prepare = readFileSync(new URL('../scripts/prepare-runtime.mjs', import.meta.url), 'utf8')
  const imports = [...runner.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)]
  assert.ok(imports.length > 0)
  for (const [, file] of imports) {
    const copy = `cpSync(join(APP, 'src', '${file}'), join(dshTuiBuild, '${file}'))`
    assert.ok(prepare.includes(copy), `prepare-runtime must copy ${file} beside the runner`)
  }
})

test('Linux detached launch waits for the hop exit and passes its environment', async () => {
  const child = new EventEmitter()
  const env = { ELECTRON_RUN_AS_NODE: 'original', PATH: '/tmp/ada' }
  let settled = false
  const started = startDetached('/tmp/ada/herdr', ['one'], {
    platform: 'linux', node: '/tmp/ada/node', env,
    spawn: (file, args, options) => {
      assert.equal(file, '/tmp/ada/node')
      assert.deepEqual(args, [
        '--require', CLOSE_INHERITED, DETACH_CLEAN, '/tmp/ada/herdr', 'one',
      ])
      assert.deepEqual(options, {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', AUTOMAGIK_HOP_RUN_AS_NODE: 'original' },
        detached: true, stdio: 'ignore', windowsHide: false,
      })
      return child
    },
  }).then(result => { settled = true; return result })
  child.emit('spawn')
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('exit', 0)
  assert.deepEqual(await started, { code: 0, stderr: '' })
  assert.equal(env.ELECTRON_RUN_AS_NODE, 'original')
})

test('Linux detached launch reports a missing target', linuxOnly, async () => {
  assert.deepEqual(await startDetached('/nonexistent/ada/herdr', []), {
    code: null, stderr: 'herdr could not start',
  })
})

test('other platforms still spawn the target directly and unref it', async () => {
  for (const platform of ['darwin', 'win32']) {
    const child = new EventEmitter()
    let unref = false
    child.unref = () => { unref = true }
    const env = { ELECTRON_RUN_AS_NODE: 'original' }
    const started = startDetached('/tmp/ada/herdr', ['one'], {
      platform, env,
      spawn: (file, args, options) => {
        assert.equal(file, '/tmp/ada/herdr')
        assert.deepEqual(args, ['one'])
        assert.deepEqual(options, {
          env, detached: true, stdio: 'ignore', windowsHide: false,
        })
        return child
      },
    })
    child.emit('spawn')
    assert.deepEqual(await started, { code: 0, stderr: '' })
    assert.equal(unref, true)
  }
})

for (const original of [undefined, '1']) {
  test(`Herdr hop removes inherited sockets and restores Node mode (${original})`, linuxOnly,
    async t => {
      let report
      t.after(() => {
        if (report && existsSync(report)) {
          const { pid } = JSON.parse(readFileSync(report, 'utf8'))
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
      })
      const root = scratch(t)
      report = join(root, 'report.json')
      const target = join(root, 'herdr-app')
      writeFileSync(target, `#!${process.execPath}\n` + socketReader + `
const pending = process.env.REPORT + '.tmp'
fs.writeFileSync(pending, JSON.stringify({
  pid: process.pid, sockets: sockets(),
  mode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  marker: process.env.AUTOMAGIK_HOP_RUN_AS_NODE ?? null,
}))
fs.renameSync(pending, process.env.REPORT)
setTimeout(() => process.exit(0), 10000)
`, { mode: 0o755 })
      const fixture = join(root, 'open.cjs')
      writeFileSync(fixture, socketReader + `
const env = { ...process.env, AUTOMAGIK_HERDR_APP: ${JSON.stringify(target)},
  REPORT: ${JSON.stringify(report)} }
delete env.ELECTRON_RUN_AS_NODE
delete env.AUTOMAGIK_HOP_RUN_AS_NODE
${original === undefined ? '' : "env.ELECTRON_RUN_AS_NODE = '1'"}
const before = sockets()
import(${JSON.stringify(herdr)}).then(async ({ openHerdr }) => {
  const result = await openHerdr({
    platform: 'linux', arch: 'x64', home: ${JSON.stringify(root)}, env,
    node: process.execPath,
    execFile: (_file, args, _options, done) => {
      if (args[0] !== 'status') return done(new Error('no display'), '', '')
      const ready = fs.existsSync(env.REPORT)
      done(ready ? null : Object.assign(new Error('waiting'), { code: 2 }), '', '')
    },
  })
  process.send({ result, before })
})
setInterval(() => {}, 1000)
`)
      const { fd, inode } = await listener(t)
      const caller = intermediate(t, [fixture], fd)
      const [{ result, before }] = await once(caller, 'message')
      assert.ok(before.includes(inode), 'caller must hold the listener before the hop')
      assert.equal(result.ok, true)
      const actual = JSON.parse(readFileSync(report, 'utf8'))
      assert.equal(actual.mode, original ?? null)
      assert.equal(actual.marker, null)
      assert.equal(actual.sockets.includes(inode), false)
    })
}
