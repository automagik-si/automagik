import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import inspector from 'node:inspector'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { resolveBw, runBw } from '../src/bw/run.js'

test('Windows resolves standalone and npm JS executables without a shell', () => {
  const dir = 'C:\\Program Files\\Fixture'
  const standalone = dir + '\\bw.exe'
  const script = dir + '\\node_modules\\@bitwarden\\cli\\build\\bw.js'
  const execPath = 'C:\\Fixture\\Automagik.exe'
  const options = { platform: 'win32', env: { Path: `"${dir}";relative` }, execPath }
  assert.deepEqual(resolveBw({ ...options, exists: path => [standalone, script].includes(path) }), {
    file: standalone, prefix: [],
  })
  assert.deepEqual(resolveBw({ ...options, exists: path => path === script }), { file: execPath, prefix: [script], node: true })
  assert.equal(resolveBw({ ...options, exists: path => path.endsWith('.cmd') }), undefined)
})

for (const cancel of ['abort', 'timeout']) test(`Windows ${cancel} invokes taskkill and waits for the CLI to close`, async () => {
  const ctrl = new AbortController()
  const cli = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() })
  cli.kill = () => assert.fail('taskkill must be used')
  const killer = new EventEmitter()
  let killed
  const called = new Promise(resolve => { killed = resolve })
  let settled = false
  const operation = runBw(['status'], { timeout: cancel === 'timeout' ? 10 : 1000, signal: ctrl.signal }, {
    platform: 'win32', parent: { Path: 'C:\\Tools', SystemRoot: 'C:\\Windows' }, exists: () => true,
    spawnChild(file, args, options) {
      assert.equal(options.shell, false)
      if (file === 'C:\\Tools\\bw.exe') return cli
      assert.equal(file, 'C:\\Windows\\System32\\taskkill.exe')
      assert.deepEqual(args, ['/PID', '42', '/T', '/F'])
      killed()
      return killer
    },
  }).then(result => { settled = true; return result })
  if (cancel === 'abort') ctrl.abort()
  await called
  killer.emit('close', 0)
  assert.equal(settled, false)
  cli.emit('close', null, 'SIGKILL')
  assert.deepEqual(await operation, { failure: cancel === 'abort' ? 'cancelled' : 'timeout' })
})

test('startup debug tracing still refuses a sensitive spawn after NODE_DEBUG is removed', async () => {
  const sentinel = randomBytes(32).toString('hex')
  const runner = new URL('../src/bw/run.js', import.meta.url).href
  const command = `
    import { writeSync } from 'node:fs';
    import { runBw } from ${JSON.stringify(runner)};
    const password = process.env.CHECK_PASSWORD;
    delete process.env.CHECK_PASSWORD;
    delete process.env.NODE_DEBUG;
    const result = await runBw(['unlock'], { timeout: 10, password }, { spawnChild() { process.exit(9) } });
    writeSync(1, JSON.stringify(result));
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', command], {
    env: { CHECK_PASSWORD: sentinel, NODE_DEBUG: 'child_process' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  const [code] = await once(child, 'close')
  assert.equal(out.includes(sentinel) || err.includes(sentinel), false)
  assert.equal(code, 0)
  assert.equal(out === '{"failure":"refused"}', true)
})

test('effective inspector state refuses a sensitive spawn', async t => {
  const debug = t.mock.method(inspector, 'url', () => 'ws://localhost/fixture')
  syncBuiltinESMExports()
  try {
    const result = await runBw(['status'], { session: randomBytes(32).toString('base64'), timeout: 10 }, {
      spawnChild() { assert.fail('spawned while the inspector was active') },
    })
    assert.deepEqual(result, { failure: 'refused' })
  } finally { debug.mock.restore(); syncBuiltinESMExports() }
})
