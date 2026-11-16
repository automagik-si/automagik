// Hermes detection reads every home with a config, each home's own serve record, and each
// home's profiles as bots: names first, the model a secondary line, and a stopped bot shown
// with how to start it. Every test proves the same boundaries: only config.yaml, serve
// records and `hermes profile list`/`serve --status` are read, never .env or auth, and
// nothing on the remote is started, stopped or signalled.
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { attachSupervisor } from '../src/host/hermes-attach.js'
import { detectHermesBots, detectSupervisor } from '../src/host/hermes-detect.js'
import { HERMES_MINIMUM } from '../src/host/hermes-ssh.js'

// Keep the existing attach fixture's private token and isolated account, but remove all
// rendezvous records. The fake logs the environment used for the diagnostic CLI call.
async function gatewayAttachFixture(t, { mode = 'running', record = false } = {}) {
  const fixture = await attachFixture(t)
  for (const folder of [fixture.chosen, fixture.other, fixture.shared]) {
    if (!record || folder !== fixture.chosen) await rm(join(folder, 'host-serve.json'))
  }
  fixture.log = join(fixture.root, 'gateway-calls.jsonl')
  await writeFile(fixture.log, '')
  await writeFile(join(fixture.root, 'gateway-mode.json'), JSON.stringify(mode))
  await writeFile(fixture.hermes, `#!/usr/bin/env python3
import json, os, sys, time
root = os.path.dirname(__file__)
args = sys.argv[1:]
with open(os.path.join(root, "gateway-calls.jsonl"), "a") as handle:
    handle.write(json.dumps({"args": args, "home": os.environ.get("HERMES_HOME")}) + "\\n")
if args == ["--version"]:
    print("Hermes Agent v0.23.1")
elif args == ["profile", "list"]:
    mode = json.load(open(os.path.join(root, "gateway-mode.json")))
    print(" Profile Model Gateway Alias Distribution")
    print(" ------- ----- ------- ----- ------------")
    print(" Oak (oak) sample/model stopped oak -")
    print(" Atlas (default) gateway-cli-output-marker %s default -" % ("stopped" if mode == "stopped" else "running"), flush=True)
    print("gateway-cli-stderr-marker", file=sys.stderr, flush=True)
    if mode == "fail":
        sys.exit(7)
    if mode == "slow":
        time.sleep(9)
else:
    sys.exit(2)
`)
  return fixture
}

async function gatewayCalls(fixture) {
  return (await readFile(fixture.log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function assertGatewayError(result, gateway = false) {
  const error = result.frames.find(frame => frame.type === 'error')
  assert.ok(error, result.raw)
  assert.deepEqual(error, {
    type: 'error', nonce: error.nonce, code: 'serve-not-running', ...(gateway ? { gateway: true } : {}),
  }, 'only the public error and the optional true gateway diagnosis leave the reader')
  assert.equal(Object.hasOwn(error, 'absent'), false)
  assert.doesNotMatch(result.raw, /gateway-cli-output-marker|gateway-cli-stderr-marker/)
  assert.equal(result.err, '', 'CLI stderr stays inside the reader too')
  assert.equal(result.frames.some(frame => ['record', 'token', 'ready'].includes(frame.type)), false)
}

test('an absent serve record diagnoses a running gateway using the picked Hermes home without exposing CLI output', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t)
  const result = await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home })
  assertGatewayError(result, true)
  const calls = await gatewayCalls(fixture)
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['profile', 'list']])
  assert.equal(calls[1].home, fixture.home, 'profile list is scoped to the picked home')
})

test('an absent serve record can diagnose the default home without changing the CLI environment', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t)
  assertGatewayError(await runAttach(fixture, { gatewayLockDir: fixture.chosen }), true)
  const listed = (await gatewayCalls(fixture)).find(call => call.args[0] === 'profile')
  assert.ok(listed)
  assert.equal(listed.home, process.env.HERMES_HOME ?? null)
})

test('an absent serve record with every gateway stopped stays plain not-running and hides CLI output', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t, { mode: 'stopped' })
  assertGatewayError(await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home }))
  assert.deepEqual((await gatewayCalls(fixture)).map(call => call.args), [['--version'], ['profile', 'list']])
})

test('a nonzero gateway CLI exit cannot diagnose a running gateway from its output', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t, { mode: 'fail' })
  assertGatewayError(await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home }))
  assert.deepEqual((await gatewayCalls(fixture)).map(call => call.args), [['--version'], ['profile', 'list']])
})

test('a gateway CLI timeout stays plain not-running even after printing a running row', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t, { mode: 'slow' })
  assertGatewayError(await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home }))
  assert.deepEqual((await gatewayCalls(fixture)).map(call => call.args), [['--version'], ['profile', 'list']])
})

test('an explicit state folder without a usable Hermes home never asks the gateway CLI', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t)
  for (const hermesHome of [undefined, '', 'relative-home', join(fixture.root, 'missing-home'), fixture.hermes]) {
    await writeFile(fixture.log, '')
    assertGatewayError(await runAttach(fixture, { stateDir: fixture.chosen, hermesHome }))
    assert.deepEqual((await gatewayCalls(fixture)).map(call => call.args), [['--version']], String(hermesHome))
  }
})

test('a present serve record with a dead port never falls back to gateway diagnosis', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await gatewayAttachFixture(t, { record: true })
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const deadPort = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const path = join(fixture.chosen, 'host-serve.json')
  const record = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...record, port: deadPort }))
  assertGatewayError(await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home }))
  assert.deepEqual((await gatewayCalls(fixture)).map(call => call.args), [['--version']], 'the running gateway fake is never consulted')
})

test('detection carries a CLI gateway into both the Python bot frame and the JS result when no serve is live', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false })
  const specPath = join(fixture.root, 'spec.json')
  const spec = JSON.parse(await readFile(specPath, 'utf8'))
  spec.homes[fixture.primary].profiles[0].gateway = 'running'
  spec.homes[fixture.clone].profiles[0].name = 'Oak'
  await writeFile(specPath, JSON.stringify(spec))
  const { frames } = await runReader(fixture)
  assert.equal(frames.some(frame => frame.type === 'error'), false, JSON.stringify(frames))
  const row = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.ok(row)
  assert.equal(row.running, false)
  assert.equal(row.gateway, true)
  const ssh = fakeSsh({ frames: frames.map(({ nonce, ...frame }) => frame) })
  const found = await detectHermesBots({ host: 'sample-box' }, { spawn: ssh.spawn, deadlines })
  const bot = found.bots.find(bot => bot.home === fixture.primary && bot.id === 'default')
  assert.equal(bot.running, false)
  assert.equal(bot.gateway, true)
})

test('a bot served by a live serve suppresses its CLI gateway in the reader frame and JS result', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: true, cloneRecord: false })
  const specPath = join(fixture.root, 'spec.json')
  const spec = JSON.parse(await readFile(specPath, 'utf8'))
  spec.homes[fixture.clone].profiles[0].name = 'Oak'
  await writeFile(specPath, JSON.stringify(spec))
  const { frames } = await runReader(fixture)
  const row = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.ok(row, JSON.stringify(frames))
  assert.equal(row.running, true)
  assert.equal(row.gateway, false)
  const ssh = fakeSsh({ frames: frames.map(({ nonce, ...frame }) => frame) })
  const found = await detectHermesBots({ host: 'sample-box' }, { spawn: ssh.spawn, deadlines })
  const bot = found.bots.find(bot => bot.home === fixture.primary && bot.id === 'default')
  assert.equal(bot.running, true)
  assert.equal(bot.gateway, false)
})

test('the detection result keeps only boolean true gateways on stopped bots', async () => {
  for (const [gateway, running] of [['yes', false], [1, false], [false, false], [true, false], [true, true]]) {
    const ssh = fakeSsh({ frames: [
      { type: 'home', home: '/srv/sample-hermes', state: running ? 'running' : 'stopped', sandbox: false, serve: null },
      { type: 'bot', home: '/srv/sample-hermes', id: 'default', name: 'Atlas', model: 'sample/model', provider: '',
        running, gateway, recordDir: running ? '/srv/sample-hermes/gateway-locks' : '', port: running ? 9300 : 0, start: 'hermes serve' },
      { type: 'ready', homes: 1, bots: 1, hermes: true },
    ] })
    const found = await detectHermesBots({ host: 'sample-box' }, { spawn: ssh.spawn, deadlines })
    assert.equal(found.bots.length, 1)
    assert.equal(found.bots[0].gateway, gateway === true && !running, JSON.stringify({ gateway, running }))
  }
})

const deadlines = { start: 8000, control: 2000, cancel: 400 }
const token = randomBytes(24).toString('hex')

function child() {
  const proc = new EventEmitter()
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.stdout.resume?.()
  proc.pid = 1300
  proc.exitCode = null
  proc.killed = false
  proc.signals = []
  proc.stdin.on('error', () => {})
  proc.kill = signal => { proc.signals.push(signal); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); return true }
  return proc
}

// A stand-in for the local ssh client: one command, no tunnel, and the frames the reader sent.
function fakeSsh({ frames = [], onHandshake } = {}) {
  const calls = []
  let remote
  const spawn = (command, args) => {
    const proc = child()
    const call = { command, args, proc }
    calls.push(call)
    remote = proc
    proc.stdin.on('data', chunk => {
      const handshake = JSON.parse(String(chunk).trim())
      call.handshake = handshake
      onHandshake?.(handshake)
      for (const frame of frames) remote.stdout.write(`${JSON.stringify({ nonce: handshake.nonce, ...frame })}\n`)
      remote.exitCode = 0
      remote.emit('close', 0)
    })
    return proc
  }
  return { spawn, calls, get remote() { return remote } }
}

const bot = (overrides = {}) => ({ home: '/Users/someone/.hermes', id: 'default', name: 'Atlas', model: 'acme/llama9:70b', provider: 'acme', running: true, recordDir: '/Users/someone/.hermes/.local/state/hermes/gateway-locks', port: 9300, start: 'hermes serve', ...overrides })

test('detection returns every home and bot, over one read-only SSH command and no tunnel', async () => {
  const frames = [
    { type: 'stage', name: 'detect-homes' },
    { type: 'stage', name: 'detect-profiles' },
    { type: 'stage', name: 'detect-serves' },
    { type: 'home', home: '/Users/someone/.hermes', state: 'stopped', sandbox: false, serve: null },
    { type: 'home', home: '/Users/someone/.local/share/clone/hermes', state: 'running', sandbox: false, serve: { port: 9301, recordDir: '/Users/someone/.local/share/clone/hermes/.local/state/hermes/gateway-locks', served: ['default'] } },
    { type: 'bot', ...bot() },
    { type: 'bot', ...bot({ home: '/Users/someone/.local/share/clone/hermes', id: 'default', name: 'Luna', model: 'anthropic/claude-sonnet', provider: '', recordDir: '/Users/someone/.local/share/clone/hermes/.local/state/hermes/gateway-locks', port: 9301, start: 'HERMES_HOME=/Users/someone/.local/share/clone/hermes hermes serve' }) },
    { type: 'bot', ...bot({ home: '/Users/someone/.local/share/clone/hermes', id: 'workshop', name: 'Workshop', model: '', provider: '', running: false, recordDir: '', port: 0, start: 'hermes --profile workshop serve' }) },
    { type: 'ready', homes: 2, bots: 3, hermes: true },
  ]
  const ssh = fakeSsh({ frames })
  const seen = []
  const found = await detectHermesBots({ host: 'example.invalid', hermesHome: '/Users/someone/.hermes' }, {
    spawn: ssh.spawn, deadlines, onProgress: stage => seen.push(stage),
  })
  assert.equal(ssh.calls.length, 1, 'one SSH command, never a tunnel')
  assert.equal(ssh.calls[0].args.includes('-N'), false)
  assert.ok(ssh.calls[0].args.at(-1).startsWith('exec python3 -u -c '))
  assert.equal(ssh.calls[0].handshake.hermesHome, '/Users/someone/.hermes')
  assert.deepEqual(seen, ['homes', 'profiles', 'serves'])
  assert.deepEqual(found.homes.map(home => [home.home, home.state]), [
    ['/Users/someone/.hermes', 'stopped'],
    ['/Users/someone/.local/share/clone/hermes', 'running'],
  ])
  // Every bot is kept by name; the model stays the second line and is never split.
  assert.deepEqual(found.bots.map(row => [row.name, row.model, row.provider, row.running]), [
    ['Atlas', 'acme/llama9:70b', 'acme', true],
    ['Luna', 'anthropic/claude-sonnet', '', true],
    ['Workshop', '', '', false],
  ])
  const stopped = found.bots.find(row => row.id === 'workshop')
  assert.equal(stopped.recordDir, '')
  assert.match(stopped.start, /hermes --profile workshop serve/)
})

test('a malformed or foreign detection frame refuses instead of guessing', async () => {
  for (const frames of [
    [{ type: 'home', home: 'relative/path' }, { type: 'ready' }],
    [{ type: 'bot', ...bot() }, { type: 'ready' }],
    [{ type: 'home', home: '/Users/someone/.hermes' }, { type: 'bot', ...bot({ home: '/Users/other/.hermes' }) }, { type: 'ready' }],
    [{ type: 'home', home: '/Users/someone/.hermes' }, { type: 'bot', ...bot({ recordDir: 'relative' }) }, { type: 'ready' }],
    [{ type: 'ready', nonce: 'not-this-connection' }],
  ]) {
    const ssh = fakeSsh({ frames })
    await assert.rejects(detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn, deadlines }),
      error => /handshake|protocol|invalid/i.test(error.message) || error.code === 'bot/hermes-ssh-handshake', JSON.stringify(frames))
  }
})

test('a later duplicate bot row never replaces the first home row', async () => {
  const frames = [
    { type: 'home', home: '/Users/someone/.hermes', state: 'running', sandbox: false, serve: { port: 9300, recordDir: '/Users/someone/.hermes/a', served: ['default'] } },
    { type: 'bot', ...bot({ recordDir: '/Users/someone/.hermes/a', port: 9300 }) },
    { type: 'bot', ...bot({ recordDir: '/Users/someone/.hermes/b', port: 9301 }) },
    { type: 'ready' },
  ]
  const ssh = fakeSsh({ frames })
  const found = await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn, deadlines })
  assert.equal(found.bots.length, 1)
  assert.equal(found.bots[0].recordDir, '/Users/someone/.hermes/a')
  assert.equal(found.bots[0].port, 9300)
})

test('two home frames with the same path keep the first one’s serve', async () => {
  const frames = [
    { type: 'home', home: '/Users/someone/.hermes', state: 'running', sandbox: false, serve: { port: 9300, recordDir: '/Users/someone/.hermes/a', served: ['default'] } },
    { type: 'home', home: '/Users/someone/.hermes', state: 'running', sandbox: false, serve: { port: 9301, recordDir: '/Users/someone/.hermes/b', served: ['default'] } },
    { type: 'bot', ...bot({ recordDir: '/Users/someone/.hermes/a', port: 9300 }) },
    { type: 'ready' },
  ]
  const ssh = fakeSsh({ frames })
  const found = await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn, deadlines })
  assert.equal(found.homes.length, 1)
  assert.equal(found.homes[0].serve.port, 9300)
  assert.equal(found.homes[0].serve.recordDir, '/Users/someone/.hermes/a')
})

test('an added folder with a parent segment is never scanned', async () => {
  const frames = [
    { type: 'home', home: '/Users/someone/.hermes', state: 'stopped', sandbox: false, serve: null },
    { type: 'bot', ...bot({ running: false, recordDir: '', port: 0 }) },
    { type: 'ready' },
  ]
  const ssh = fakeSsh({ frames })
  await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn, deadlines, extraHomes: ['/srv/../etc', '/srv/good-hermes'] })
  assert.deepEqual(ssh.calls[0].handshake.extraHomes, ['/srv/good-hermes'])
})

test('a detection failure keeps its kind and never leaks SSH text or a token', async () => {
  const ssh = fakeSsh({ frames: [{ type: 'error', code: 'unsupported-platform' }] })
  await assert.rejects(detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn, deadlines }), error => error.code === 'bot/hermes-ssh-platform')
  const leaked = fakeSsh({ frames: [{ type: 'error', code: 'remote-script', name: 'Fault', line: 7 }] })
  await assert.rejects(detectHermesBots({ host: 'example.invalid' }, { spawn: leaked.spawn, deadlines }), error => error.code === 'bot/hermes-ssh-script')
})

test('the reader opens only config.yaml and serve records, and cannot start or stop anything', () => {
  for (const forbidden of ['Popen', 'start_new_session', 'SIGTERM', 'serve --stop', 'session.create', 'write(', 'chmod(']) {
    assert.ok(!detectSupervisor.includes(forbidden), forbidden)
  }
  assert.match(detectSupervisor, /config\.yaml/)
  assert.match(detectSupervisor, /host-serve\.json/)
  assert.match(detectSupervisor, /"profile", "list"/)
  assert.match(detectSupervisor, /"serve", "--status"/)
  // Never a credential file: the detector does not even know their names.
  for (const forbidden of ['host-serve.token', '.env', 'auth.json', 'auth.lock', 'credentials']) {
    assert.doesNotMatch(detectSupervisor, new RegExp(`["']${forbidden.replace('.', '\\.')}["']`), forbidden)
  }
})

// The reader itself, run against scratch homes and a fake Hermes CLI. The fake writes every
// argv it sees, so "started nothing" is shown by the calls the reader made, not by its words.
async function readerFixture(t, { primaryRecord = false, cloneRecord = true, cloneHomeField = '', primaryHomeField = '', cloneProfilesFail = false, extraHomes = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-detect-'))
  const primary = join(root, '.hermes')
  const clone = join(root, '.local', 'share', 'clone', 'hermes')
  const primaryLock = join(primary, 'gateway-locks')
  const cloneLock = join(clone, '.local', 'state', 'hermes', 'gateway-locks')
  for (const folder of [primary, clone, join(clone, 'profiles', 'workshop'), primaryLock, cloneLock, join(root, 'state')]) await mkdir(folder, { recursive: true })
  await writeFile(join(primary, 'config.yaml'), 'model:\n  default: openai/gpt-5.1\n  provider: openai\n')
  await writeFile(join(primary, 'SOUL.md'), '# Primary\n')
  await writeFile(join(clone, 'config.yaml'), 'model:\n  default: "anthropic/claude-sonnet"\n  provider: anthropic\n')
  await writeFile(join(clone, 'SOUL.md'), '# Clone\n')
  await writeFile(join(clone, 'profiles', 'workshop', 'config.yaml'), 'model: "acme/llama9:70b-q4"\n')
  const server = createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  if (primaryRecord) await writeFile(join(primaryLock, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port, profiles: ['default'], home: primaryHomeField }))
  if (cloneRecord) await writeFile(join(cloneLock, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port, profiles: ['default', 'workshop'], home: cloneHomeField }))
  const hermes = join(root, 'hermes')
  const spec = join(root, 'spec.json')
  const log = join(root, 'calls.log')
  const homes = {
    [primary]: { profiles: [{ name: 'Atlas', id: 'default', model: 'openai/gpt-5.1', gateway: primaryRecord ? 'running' : 'stopped' }] },
    [clone]: { fail: cloneProfilesFail, profiles: [{ name: 'Luna', id: 'default', model: 'anthropic/claude', gateway: 'running' }, { name: 'Workshop', id: 'workshop', model: 'acme/llama9:70b-q4', gateway: 'stopped' }] },
  }
  for (const [path, profiles] of extraHomes) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'config.yaml'), 'model: other/model\n')
    await writeFile(join(path, 'SOUL.md'), '# Home\n')
    homes[path] = { profiles }
  }
  await writeFile(spec, JSON.stringify({ homes }))
  await writeFile(hermes, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
home = os.environ.get("HERMES_HOME", "")
with open(os.environ["FAKE_HERMES_LOG"], "a") as handle:
    handle.write(json.dumps(args) + "\\n")
spec = json.load(open(os.environ["FAKE_HERMES_SPEC"]))
if args == ["profile", "list"]:
    entry = spec["homes"].get(home)
    if not entry or entry.get("fail"):
        sys.exit(1)
    print("")
    print(" Profile          Model                        Gateway      Alias        Distribution")
    print(" ---------------- ---------------------------- ------------ ------------ --------------------")
    for row in entry["profiles"]:
        print("  %s (%s) %s %s %s -" % (row["name"], row["id"], row["model"], row["gateway"], row["id"]))
    print("")
    sys.exit(0)
if args == ["serve", "--status"]:
    print("No hermes dashboard or serve processes running.")
    sys.exit(0)
sys.exit(2)
`, { mode: 0o755 })
  await chmod(hermes, 0o755)
  await writeFile(join(primary, '.env'), 'placeholder do not read\n')
  await writeFile(join(clone, 'auth.json'), 'placeholder do not read\n')
  await writeFile(join(primary, 'auth.lock'), 'placeholder do not read\n')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { root, primary, clone, primaryLock, cloneLock, hermes, log, port }
}

function runReader(fixture, options = {}) {
  const { gatewayLockDir = '', envHermesHome = '', ...handshake } = options
  return new Promise((resolve, reject) => {
    const proc = spawnChild('python3', ['-u', '-c', detectSupervisor], {
      env: { ...process.env, HOME: fixture.root, HERMES_HOME: envHermesHome, HERMES_GATEWAY_LOCK_DIR: gatewayLockDir, XDG_STATE_HOME: join(fixture.root, 'state'), FAKE_HERMES_SPEC: join(fixture.root, 'spec.json'), FAKE_HERMES_LOG: fixture.log },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    proc.on('error', error => reject(error))
    proc.stdout.on('data', data => { out += String(data) })
    proc.stderr.on('data', data => { err += String(data) })
    proc.on('close', () => {
      const frames = out.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      resolve({ frames, raw: out, err })
    })
    proc.stdin.write(`${JSON.stringify({ nonce: randomBytes(8).toString('hex'), hermesPath: fixture.hermes, startMs: 20000, controlMs: 8000, ...handshake })}\n`)
    proc.stdin.end()
  })
}

async function hasPython() {
  return new Promise(resolve => {
    const proc = spawnChild('python3', ['--version'], { stdio: 'ignore' })
    proc.on('error', () => resolve(false))
    proc.on('close', code => resolve(code === 0))
  })
}

const botsOf = frames => frames.filter(frame => frame.type === 'bot')

test('every home with a config is asked for its bots, by name, with the model as a second line', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t)
  const { frames } = await runReader(fixture)
  assert.equal(frames.find(frame => frame.type === 'error'), undefined, JSON.stringify(frames.find(frame => frame.type === 'error')))
  const rows = botsOf(frames)
  assert.deepEqual(rows.map(row => [row.home, row.name, row.model, row.provider, row.running]), [
    [fixture.primary, 'Atlas', 'openai/gpt-5.1', 'openai', false],
    [fixture.clone, 'Luna', 'anthropic/claude-sonnet', 'anthropic', true],
    [fixture.clone, 'Workshop', 'acme/llama9:70b-q4', '', true],
  ])
  const stopped = rows.find(row => row.name === 'Atlas')
  assert.equal(stopped.recordDir, '', 'a stopped bot carries no serve to read')
  assert.equal(stopped.start, 'hermes serve')
  assert.equal(frames.find(frame => frame.type === 'ready').bots, 3)
  assert.equal(frames.find(frame => frame.type === 'ready').homes, 2)
})

test('two homes each read their own serve record, so one never masks the other', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: true })
  const { frames } = await runReader(fixture)
  const homes = frames.filter(frame => frame.type === 'home')
  assert.equal(homes.length, 2)
  assert.deepEqual(homes.map(home => home.state), ['running', 'running'])
  const rows = botsOf(frames)
  const primary = rows.find(row => row.name === 'Atlas')
  const clone = rows.find(row => row.name === 'Luna')
  assert.equal(primary.running, true)
  assert.equal(clone.running, true)
  assert.notEqual(primary.recordDir, clone.recordDir, 'each serve keeps its own record folder')
  assert.equal(primary.recordDir, fixture.primaryLock)
  assert.equal(clone.recordDir, fixture.cloneLock)
})

test('a record in a home’s own state folder belongs to that home, even when it names another host home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false })
  // The sandboxed serve's record reports the host home, which exists on the host. The
  // record sits in the clone home's own state folder: the clone owns it, not that folder.
  const record = JSON.parse(await readFile(join(fixture.cloneLock, 'host-serve.json'), 'utf8'))
  await writeFile(join(fixture.cloneLock, 'host-serve.json'), JSON.stringify({ ...record, home: fixture.primary }))
  const { frames } = await runReader(fixture)
  const rows = botsOf(frames)
  const cloneBot = rows.find(row => row.home === fixture.clone && row.id === 'default')
  assert.ok(cloneBot, JSON.stringify(frames))
  assert.equal(cloneBot.running, true, 'the sandboxed bot is Running')
  assert.equal(cloneBot.recordDir, fixture.cloneLock, 'its own record folder, never the named host home')
  const primaryBot = rows.find(row => row.home === fixture.primary)
  assert.ok(primaryBot, 'the host home is still shown')
  assert.equal(primaryBot.running, false, 'the host home is Not running')
  assert.equal(primaryBot.recordDir, '', 'the host home cannot be picked with the clone’s serve')
})

test('a sandboxed clone and the host home each run their own serve and bot', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: true })
  // The clone's record reports the host home too; both homes run their own serve.
  const cloneRecord = JSON.parse(await readFile(join(fixture.cloneLock, 'host-serve.json'), 'utf8'))
  await writeFile(join(fixture.cloneLock, 'host-serve.json'), JSON.stringify({ ...cloneRecord, home: fixture.primary }))
  const { frames } = await runReader(fixture)
  const rows = botsOf(frames)
  const cloneBot = rows.find(row => row.home === fixture.clone && row.id === 'default')
  const primaryBot = rows.find(row => row.home === fixture.primary)
  assert.equal(cloneBot.running, true)
  assert.equal(primaryBot.running, true)
  assert.notEqual(cloneBot.recordDir, primaryBot.recordDir)
  assert.equal(cloneBot.recordDir, fixture.cloneLock)
  assert.equal(primaryBot.recordDir, fixture.primaryLock)
})

test('a shared record naming no home never replaces a home’s own bot', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: true })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid + 1, port: fixture.port + 1, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { gatewayLockDir: shared })
  const primaryRows = botsOf(frames).filter(row => row.home === fixture.primary)
  assert.equal(primaryRows.length, 1, 'the home has one bot row, never a refused duplicate')
  assert.equal(primaryRows[0].recordDir, fixture.primaryLock, 'its own record folder')
  assert.equal(primaryRows[0].port, fixture.port, 'its own port')
  assert.ok(!botsOf(frames).some(row => row.recordDir === shared), 'the refused record is not a row')
})

test('a LIVE shared record naming a home that owns a different live serve is not credited to it', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: true })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  // A genuine second serve: a live pid and a listening port.
  const child = spawnChild('python3', ['-c', 'import time\ntime.sleep(30)'])
  const listener = createServer(socket => socket.end())
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  t.after(() => { child.kill(); listener.close() })
  await new Promise(resolve => setTimeout(resolve, 50))
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: child.pid, port: listener.address().port, profiles: ['default'], home: fixture.primary }))
  const { frames } = await runReader(fixture, { gatewayLockDir: shared })
  const primaryRows = botsOf(frames).filter(row => row.home === fixture.primary)
  assert.equal(primaryRows.length, 1)
  assert.equal(primaryRows[0].recordDir, fixture.primaryLock, 'the home keeps its own record folder')
  assert.equal(primaryRows[0].port, fixture.port, 'and its own port')
  assert.ok(!botsOf(frames).some(row => row.recordDir === shared), 'the other live serve is never credited here')
})

test('a nameless account record belongs to the default home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { gatewayLockDir: shared })
  const primaryRows = botsOf(frames).filter(row => row.home === fixture.primary)
  assert.equal(primaryRows.length, 1)
  assert.equal(primaryRows[0].running, true, 'the default home’s serve is found')
  assert.equal(primaryRows[0].recordDir, shared, 'the account folder is its own record folder')
  assert.ok(botsOf(frames).filter(row => row.home === fixture.clone).every(row => row.running === false), 'the second home is not credited')
})

test('default and second home both run their own record and are both pickable', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: true, primaryRecord: false })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  // The default home's serve publishes in the account folder with no home field.
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { gatewayLockDir: shared })
  const rows = botsOf(frames)
  const primaryBot = rows.find(row => row.home === fixture.primary)
  const cloneBot = rows.find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(primaryBot.running, true)
  assert.equal(cloneBot.running, true)
  assert.equal(primaryBot.recordDir, shared)
  assert.equal(cloneBot.recordDir, fixture.cloneLock)
  assert.ok(primaryBot.port > 0 && cloneBot.port > 0)
})

test('a sandbox record under the clone home is found where the home keeps it, and the bot is shown', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneHomeField: '/home/sandbox/.hermes' })
  const { frames } = await runReader(fixture)
  const clone = botsOf(frames).find(row => row.home === fixture.clone)
  assert.ok(clone, JSON.stringify(frames))
  assert.equal(clone.running, true, 'a sandbox-internal home path does not hide its bot')
  assert.equal(clone.recordDir, fixture.cloneLock)
})

test('a home under the share folder with its record in the folder beside it is found', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false })
  const atelier = join(fixture.root, '.local', 'share', 'atelier', 'hermes')
  const beside = join(fixture.root, '.local', 'share', 'atelier', 'gateway-locks')
  await mkdir(atelier, { recursive: true })
  await mkdir(beside, { recursive: true })
  await writeFile(join(atelier, 'config.yaml'), 'model: atelier/model\n')
  await writeFile(join(atelier, 'SOUL.md'), '# Atelier\n')
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[atelier] = { profiles: [{ name: 'Atelier', id: 'default', model: 'atelier/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === atelier)
  assert.ok(bot, JSON.stringify(frames))
  assert.equal(bot.running, true)
  assert.equal(bot.recordDir, beside, 'the gateway-locks folder beside the home')
  assert.equal(bot.name, 'Atelier')
})

test('a person-added Hermes folder is scanned with the gateway-locks folder beside it', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false })
  const custom = join(fixture.root, 'studio', 'picked-home')
  const beside = join(fixture.root, 'studio', 'gateway-locks')
  await mkdir(custom, { recursive: true })
  await mkdir(beside, { recursive: true })
  await writeFile(join(custom, 'config.yaml'), 'model: picked/model\n')
  await writeFile(join(custom, 'SOUL.md'), '# Picked\n')
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[custom] = { profiles: [{ name: 'Picked', id: 'default', model: 'picked/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const { frames } = await runReader(fixture, { extraHomes: [custom] })
  const bot = botsOf(frames).find(row => row.home === custom)
  assert.ok(bot, JSON.stringify(frames))
  assert.equal(bot.running, true)
  assert.equal(bot.recordDir, beside)
  assert.equal(bot.name, 'Picked')
})

test('a saved clone home never becomes the default home when its serve is stopped', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  // The saved pick names the clone home; the default home must stay the login default.
  const { frames } = await runReader(fixture, { hermesHome: fixture.clone, gatewayLockDir: shared })
  const primaryBot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  const cloneBot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(primaryBot.running, true, 'the default home keeps its running serve')
  assert.equal(primaryBot.recordDir, shared)
  assert.equal(cloneBot.running, false, 'the stopped clone is not credited')
})

test('a saved clone home never becomes the default home when both run', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: true })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { hermesHome: fixture.clone, gatewayLockDir: shared })
  const primaryBot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  const cloneBot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(primaryBot.running, true, 'the default home is pickable')
  assert.equal(primaryBot.recordDir, shared)
  assert.equal(cloneBot.running, true, 'the clone is pickable on its own record')
  assert.equal(cloneBot.recordDir, fixture.cloneLock)
  assert.notEqual(primaryBot.recordDir, cloneBot.recordDir)
})

test('after picking the clone once, a restart shows both homes right and both pickable', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: true })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  // Before the pick, then after a restart with the clone saved as the connection's home.
  for (const saved of [undefined, fixture.clone]) {
    const { frames } = await runReader(fixture, { hermesHome: saved, gatewayLockDir: shared })
    const primaryBot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
    const cloneBot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
    assert.equal(primaryBot.running, true, `default is pickable (saved=${saved ?? 'none'})`)
    assert.equal(primaryBot.recordDir, shared)
    assert.equal(cloneBot.running, true, `clone is pickable (saved=${saved ?? 'none'})`)
    assert.equal(cloneBot.recordDir, fixture.cloneLock)
  }
})

test('a home written with a trailing slash is listed once and keeps its beside record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const beside = join(fixture.root, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { hermesHome: `${fixture.primary}/` })
  assert.equal(frames.filter(frame => frame.type === 'home' && frame.home === fixture.primary).length, 1, 'one home, not two')
  const bot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.equal(bot.running, true, 'the beside record is still found')
  assert.equal(bot.recordDir, beside)
})

test('a home written with a double slash and a dot segment is listed once', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const beside = join(fixture.root, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const spelled = `${dirname(fixture.primary)}//./${fixture.primary.split('/').at(-1)}`
  const { frames } = await runReader(fixture, { hermesHome: spelled })
  assert.equal(frames.filter(frame => frame.type === 'home' && frame.home === fixture.primary).length, 1)
  assert.equal(botsOf(frames).find(row => row.home === fixture.primary).running, true)
})

test('a symlinked spelling of a home is the same home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const beside = join(fixture.root, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const link = join(fixture.root, 'hermes-link')
  await symlink(fixture.primary, link)
  const { frames } = await runReader(fixture, { hermesHome: link })
  assert.equal(frames.filter(frame => frame.type === 'home' && frame.home === fixture.primary).length, 1)
  const bot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.equal(bot.running, true, 'the real home owns the beside record')
})

test('a clone home written with a trailing slash still finds its beside serve', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false, cloneProfilesFail: true })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { hermesHome: `${fixture.clone}/` })
  assert.equal(frames.filter(frame => frame.type === 'home').length, 2, 'default and clone only')
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.ok(bot)
  assert.equal(bot.running, true, 'the clone beside serve is not hidden')
  assert.equal(bot.recordDir, beside)
})

test('a symlinked home keeps the record folder beside the link', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const real = join(fixture.root, 'moved', 'hermes')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'config.yaml'), 'model: moved/model\n')
  await writeFile(join(real, 'SOUL.md'), '# Moved\n')
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[real] = { profiles: [{ name: 'Moved', id: 'default', model: 'moved/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const links = join(fixture.root, 'links')
  await mkdir(links, { recursive: true })
  const link = join(links, 'hermes-link')
  await symlink(real, link)
  const beside = join(links, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { hermesHome: link })
  const bot = botsOf(frames).find(row => row.home === real)
  assert.ok(bot, JSON.stringify(frames))
  assert.equal(bot.running, true, 'the serve beside the link is found')
  assert.equal(bot.recordDir, beside)
})

test('a home moved to another disk and linked back keeps the record beside the link', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const moved = await mkdtemp(join(tmpdir(), 'hermes-moved-'))
  t.after(() => rm(moved, { recursive: true, force: true }))
  await writeFile(join(moved, 'config.yaml'), 'model: moved/model\n')
  await writeFile(join(moved, 'SOUL.md'), '# Moved\n')
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[moved] = { profiles: [{ name: 'Moved', id: 'default', model: 'moved/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const links = join(fixture.root, 'links')
  await mkdir(links, { recursive: true })
  const link = join(links, 'moved-hermes')
  await symlink(moved, link)
  const beside = join(links, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { hermesHome: link })
  const bot = botsOf(frames).find(row => row.home === moved)
  assert.ok(bot, JSON.stringify(frames))
  assert.equal(bot.running, true)
  assert.equal(bot.recordDir, beside)
})

test('the login default home is normalized before it owns the account record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { envHermesHome: `${fixture.primary}/`, gatewayLockDir: shared })
  const bot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.equal(bot.running, true, 'the trailing-slash login home is the default home')
  assert.equal(bot.recordDir, shared)
})

test('a record naming the default home with a trailing slash is attributed to it', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared-locks')
  await mkdir(shared, { recursive: true })
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: `${fixture.primary}/` }))
  const { frames } = await runReader(fixture, { gatewayLockDir: shared })
  const bot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.equal(bot.running, true)
  assert.equal(bot.recordDir, shared)
})

test('a stopped home added beside a running sibling does not claim the shared record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared')
  const runner = join(shared, 'runner')
  const stopped = join(shared, 'stopped')
  for (const home of [runner, stopped]) {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.yaml'), 'model: shared/model\n')
    await writeFile(join(home, 'SOUL.md'), '# Home\n')
  }
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[stopped] = { profiles: [{ name: 'Stopped', id: 'default', model: 'shared/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  // Add another Hermes supplies only the stopped home.
  const { frames } = await runReader(fixture, { extraHomes: [stopped] })
  const bot = botsOf(frames).find(row => row.home === stopped && row.id === 'default')
  assert.ok(bot, JSON.stringify(frames))
  assert.equal(bot.running, false, 'the stopped home is not answered by its running sibling')
  assert.equal(bot.blocked, 'shared-beside')
  assert.ok(!botsOf(frames).some(row => row.recordDir === beside), 'the shared record is not claimed')
})

test('a stopped linked home beside a running linked sibling does not claim the shared record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const reals = join(fixture.root, 'reals')
  const runner = join(reals, 'runner')
  const stopped = join(reals, 'stopped')
  for (const home of [runner, stopped]) {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.yaml'), 'model: shared/model\n')
    await writeFile(join(home, 'SOUL.md'), '# Home\n')
  }
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[stopped] = { profiles: [{ name: 'Stopped', id: 'default', model: 'shared/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const shared = join(fixture.root, 'shared')
  await mkdir(shared, { recursive: true })
  await symlink(runner, join(shared, 'runner-link'))
  const stoppedLink = join(shared, 'stopped-link')
  await symlink(stopped, stoppedLink)
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { extraHomes: [stoppedLink] })
  const bot = botsOf(frames).find(row => row.home === stopped && row.id === 'default')
  assert.ok(bot, JSON.stringify(frames))
  assert.equal(bot.running, false)
  assert.equal(bot.blocked, 'shared-beside')
  assert.ok(!botsOf(frames).some(row => row.recordDir === beside))
})

test('a fresh real-shaped Hermes home beside a running home makes the shared record ambiguous', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const fresh = join(dirname(fixture.clone), 'fresh')
  await mkdir(fresh, { recursive: true })
  await writeFile(join(fresh, 'config.yaml'), 'model: fresh/model\n')
  await writeFile(join(fresh, 'SOUL.md'), '# Fresh, never started\n')
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, false, 'a fresh never-started Hermes home is a sibling too')
  assert.equal(bot.blocked, 'shared-beside')
})

test('R-a: a lone clone beside an unrelated config.yaml folder stays running and pickable', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const notes = join(dirname(fixture.clone), 'notes')
  await mkdir(notes, { recursive: true })
  await writeFile(join(notes, 'config.yaml'), 'note: another app settings\n')
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, true, 'another app settings folder is not a Hermes home')
  assert.equal(bot.recordDir, beside)
  assert.equal(bot.blocked, '')
})

test('R-b: a stopped default beside an unrelated config.yaml folder shows only its start line', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const notes = join(fixture.root, 'notes')
  await mkdir(notes, { recursive: true })
  await writeFile(join(notes, 'config.yaml'), 'note: another app settings\n')
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.equal(bot.running, false)
  assert.equal(bot.blocked, '', 'the unrelated folder gives no shared-folder reason')
  assert.ok(bot.start.startsWith('hermes'), 'the ordinary start line remains')
})

test('K5: a real sibling holding only SOUL.md is still a Hermes home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const fresh = join(dirname(fixture.clone), 'fresh')
  await mkdir(fresh, { recursive: true })
  await writeFile(join(fresh, 'SOUL.md'), '# Fresh, never configured\n')
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, false, 'SOUL.md alone is a real Hermes home')
  assert.equal(bot.blocked, 'shared-beside')
})

test('a sibling holding only gateway-locks is not a Hermes home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  await mkdir(join(dirname(fixture.clone), 'backup', 'gateway-locks'), { recursive: true })
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, true, 'gateway-locks alone is not Hermes identity')
  assert.equal(bot.recordDir, beside)
})

test('an ordinary config.yaml folder beside a running home does not make it ambiguous', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const notes = join(dirname(fixture.clone), 'notes')
  await mkdir(notes, { recursive: true })
  await writeFile(join(notes, 'config.yaml'), 'note: not a Hermes home\n')
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, true, 'a notes folder with config.yaml is not a Hermes sibling')
  assert.equal(bot.recordDir, beside)
})

test('an ordinary gateway-locks folder beside a running home does not make it ambiguous', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  await mkdir(join(dirname(fixture.clone), 'backup', 'gateway-locks'), { recursive: true })
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, true, 'a backup/gateway-locks folder is not a Hermes sibling')
  assert.equal(bot.recordDir, beside)
})

test('unrelated config.yaml folders beside the clone and the stopped default leave both true', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  for (const folder of [join(dirname(fixture.clone), 'notes'), join(fixture.root, 'notes')]) {
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'config.yaml'), 'note: not a Hermes home\n')
  }
  const { frames } = await runReader(fixture)
  const cloneBot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  const defaultBot = botsOf(frames).find(row => row.home === fixture.primary && row.id === 'default')
  assert.equal(cloneBot.running, true)
  assert.equal(cloneBot.recordDir, beside)
  assert.equal(defaultBot.running, false, 'the stopped default stays stopped, not blocked')
  assert.equal(defaultBot.blocked, '', 'an unrelated folder does not block the default')
  assert.ok(defaultBot.start.startsWith('hermes'))
})

test('S1: a running sibling without SOUL.md, marked by config.yaml and skeleton, is still a sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared')
  const ash = join(shared, 'ash')
  const oak = join(shared, 'oak')
  await makeHome(ash, { skeleton: ['sessions', 'memories'] })
  await makeHome(oak, { soul: true })
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[oak] = { profiles: [{ name: 'Oak', id: 'default', model: 'made-up/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { extraHomes: [oak] })
  const bot = botsOf(frames).find(row => row.home === oak && row.id === 'default')
  assert.equal(bot.running, false, 'Oak must not claim Ash\'s record')
  assert.equal(bot.blocked, 'shared-beside')
  assert.ok(!botsOf(frames).some(row => row.recordDir === beside))
})

test('S2: the same sibling rule holds through two links', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const reals = join(fixture.root, 'reals')
  const ash = join(reals, 'ash')
  const oak = join(reals, 'oak')
  await makeHome(ash, { skeleton: ['cron', 'logs'] })
  await makeHome(oak, { soul: true })
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[oak] = { profiles: [{ name: 'Oak', id: 'default', model: 'made-up/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const shared = join(fixture.root, 'shared')
  await mkdir(shared, { recursive: true })
  await symlink(ash, join(shared, 'ash-link'))
  const oakLink = join(shared, 'oak-link')
  await symlink(oak, oakLink)
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { extraHomes: [oakLink] })
  const bot = botsOf(frames).find(row => row.home === oak && row.id === 'default')
  assert.equal(bot.running, false)
  assert.equal(bot.blocked, 'shared-beside')
  assert.ok(!botsOf(frames).some(row => row.recordDir === beside))
})

test('14: a running sibling whose SOUL.md was deleted is still a sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared')
  const ash = join(shared, 'ash')
  const oak = join(shared, 'oak')
  await makeHome(ash, { soul: true, skeleton: ['sessions', 'logs'] })
  await rm(join(ash, 'SOUL.md'))
  await makeHome(oak, { soul: true })
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[oak] = { profiles: [{ name: 'Oak', id: 'default', model: 'made-up/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { extraHomes: [oak] })
  const bot = botsOf(frames).find(row => row.home === oak && row.id === 'default')
  assert.equal(bot.running, false)
  assert.equal(bot.blocked, 'shared-beside')
})

test('15: an old-Hermes sibling with config.yaml and state.db is still a sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared')
  const old = join(shared, 'old')
  const oak = join(shared, 'oak')
  await makeHome(old, { state: true })
  await makeHome(oak, { soul: true })
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[oak] = { profiles: [{ name: 'Oak', id: 'default', model: 'made-up/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { extraHomes: [oak] })
  const bot = botsOf(frames).find(row => row.home === oak && row.id === 'default')
  assert.equal(bot.running, false)
  assert.equal(bot.blocked, 'shared-beside')
})

test('16: an added home without SOUL.md, alone in its folder, is still pickable', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const oak = join(fixture.root, 'solo', 'oak')
  await makeHome(oak, { config: true })
  const own = join(oak, '.local', 'state', 'hermes', 'gateway-locks')
  await mkdir(own, { recursive: true })
  await writeFile(join(own, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[oak] = { profiles: [{ name: 'Oak', id: 'default', model: 'made-up/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const { frames } = await runReader(fixture, { extraHomes: [oak] })
  const bot = botsOf(frames).find(row => row.home === oak && row.id === 'default')
  assert.equal(bot.running, true)
  assert.equal(bot.recordDir, own)
})

test('R-c accepted limit: another tool with config.yaml and two skeleton folders blocks the home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  await makeHome(join(dirname(fixture.clone), 'other-tool'), { skeleton: ['sessions', 'logs'] })
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, false, 'safety over pickability for a tool with two skeleton folders')
  assert.equal(bot.blocked, 'shared-beside')
  assert.ok(!botsOf(frames).some(row => row.recordDir === beside))
})

test('an unrelated folder with config.yaml and only a logs folder stays pickable', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  await makeHome(join(dirname(fixture.clone), 'tool'), { skeleton: ['logs'] })
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, true, 'one generic folder is not two Hermes skeleton folders')
  assert.equal(bot.recordDir, beside)
})

test('a link to the home itself is not a sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  await symlink(fixture.clone, join(dirname(fixture.clone), 'hermes-current'))
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, true, 'the link resolves to the home itself')
  assert.equal(bot.recordDir, beside)
})

test('a stopped full copy of a Hermes home beside it is a real sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const beside = join(dirname(fixture.clone), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  await makeHome(join(dirname(fixture.clone), 'copy'), { soul: true, skeleton: ['sessions', 'memories', 'cron', 'logs'] })
  const { frames } = await runReader(fixture)
  const bot = botsOf(frames).find(row => row.home === fixture.clone && row.id === 'default')
  assert.equal(bot.running, false, 'a full Hermes copy is a sibling; safety over pickability')
  assert.equal(bot.blocked, 'shared-beside')
})

test('a moved home linked back keeps the record beside the link when the real parent has a sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, primaryRecord: false })
  const reals = join(fixture.root, 'reals')
  const real = join(reals, 'hermes')
  await makeHome(real, { soul: true })
  await makeHome(join(reals, 'other'), { soul: true })
  const links = join(fixture.root, 'links')
  await mkdir(links, { recursive: true })
  const link = join(links, 'hermes-link')
  await symlink(real, link)
  const beside = join(links, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[real] = { profiles: [{ name: 'Moved', id: 'default', model: 'made-up/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const { frames } = await runReader(fixture, { hermesHome: link })
  const bot = botsOf(frames).find(row => row.home === real && row.id === 'default')
  assert.equal(bot.running, true, 'the link parent decides its own beside folder')
  assert.equal(bot.recordDir, beside)
})

test('the per-folder owner count still refuses a shared folder for two config-only homes', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const shared = join(fixture.root, 'shared')
  const ash = join(shared, 'ash')
  const oak = join(shared, 'oak')
  await makeHome(ash, { config: true })
  await makeHome(oak, { config: true })
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[oak] = { profiles: [{ name: 'Oak', id: 'default', model: 'made-up/model', gateway: 'stopped' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const { frames } = await runReader(fixture, { extraHomes: [ash, oak] })
  const bot = botsOf(frames).find(row => row.home === oak && row.id === 'default')
  assert.equal(bot.running, false, 'two known homes share the folder; no owner')
  assert.equal(bot.blocked, 'shared-beside')
  assert.ok(!botsOf(frames).some(row => row.recordDir === beside))
})

test('a record folder beside two homes under one parent belongs to neither', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { primaryRecord: false, cloneRecord: false })
  const picked = join(fixture.root, 'picked-home')
  await mkdir(picked, { recursive: true })
  await writeFile(join(picked, 'config.yaml'), 'model: picked/model\n')
  await writeFile(join(picked, 'SOUL.md'), '# Picked\n')
  const spec = JSON.parse(await readFile(join(fixture.root, 'spec.json'), 'utf8'))
  spec.homes[picked] = { profiles: [{ name: 'Picked', id: 'default', model: 'picked/model', gateway: 'running' }] }
  await writeFile(join(fixture.root, 'spec.json'), JSON.stringify(spec))
  const beside = join(fixture.root, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port: fixture.port, profiles: ['default'], home: '' }))
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames } = await runReader(fixture, { hermesHome: fixture.primary, extraHomes: [picked], gatewayLockDir: account })
  const rows = botsOf(frames)
  const primaryBot = rows.find(row => row.home === fixture.primary)
  const pickedBot = rows.find(row => row.home === picked)
  assert.equal(primaryBot.running, false, 'the default home does not take it')
  assert.equal(primaryBot.blocked, 'shared-beside', 'the default home says why it cannot be picked')
  assert.equal(pickedBot.running, false, 'the added home does not take it either')
  assert.equal(pickedBot.blocked, 'shared-beside')
  assert.ok(!rows.some(row => row.recordDir === beside), 'an ambiguous beside folder is not credited')
})

test('a stopped bot is shown with how to start it, and the reader runs nothing else', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false })
  const { frames } = await runReader(fixture)
  const stopped = botsOf(frames).filter(row => row.running === false)
  assert.deepEqual(stopped.map(row => row.name), ['Atlas', 'Luna', 'Workshop'])
  assert.ok(stopped.every(row => row.start.startsWith('hermes') || row.start.startsWith('HERMES_HOME=')))
  assert.match(botsOf(frames).find(row => row.home === fixture.clone).start, /^HERMES_HOME=.*hermes serve$/)
  const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls, [['profile', 'list'], ['profile', 'list'], ['serve', '--status'], ['serve', '--status']])
  assert.ok(!calls.some(call => call[0] === 'serve' && call[1] !== '--status'), 'no serve is started or stopped')
})

test('the reader never opens .env, auth files or a token, even when they hold bait', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t)
  const { raw } = await runReader(fixture)
  assert.ok(!raw.includes('placeholder do not read'), 'no credential file is read')
})

test('when `profile list` fails, the home still appears with its default bot and its own model', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneRecord: false, cloneProfilesFail: true })
  const { frames } = await runReader(fixture)
  const clone = botsOf(frames).filter(row => row.home === fixture.clone)
  assert.deepEqual(clone.map(row => [row.id, row.name, row.model, row.running]), [['default', 'default', 'anthropic/claude-sonnet', false]])
})

// The chosen serve's own record and token, and nothing beside it. Two lock folders exist;
// the other one is readable and valid, so reading it would succeed rather than hide a fallback.
async function makeHome(path, { soul = false, config = true, skeleton = [], state = false } = {}) {
  await mkdir(path, { recursive: true })
  if (config) await writeFile(join(path, 'config.yaml'), 'model: made-up/model\n')
  if (soul) await writeFile(join(path, 'SOUL.md'), '# Made-up home\n')
  for (const name of skeleton) await mkdir(join(path, name), { recursive: true })
  if (state) await writeFile(join(path, 'state.db'), '')
}

async function attachFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-attach-chosen-'))
  const home = join(root, 'studio', 'chosen-home')
  const otherHome = join(root, 'other-home')
  const chosen = join(home, '.local', 'state', 'hermes', 'gateway-locks')
  const other = join(otherHome, '.local', 'state', 'hermes', 'gateway-locks')
  const shared = join(root, 'shared-locks')
  for (const folder of [home, otherHome, chosen, other, shared]) await mkdir(folder, { recursive: true })
  await writeFile(join(home, 'config.yaml'), 'model: chosen/model\n')
  await writeFile(join(home, 'SOUL.md'), '# Chosen\n')
  await writeFile(join(otherHome, 'config.yaml'), 'model: other/model\n')
  await writeFile(join(otherHome, 'SOUL.md'), '# Other\n')
  const otherToken = randomBytes(24).toString('hex')
  const sharedToken = randomBytes(24).toString('hex')
  const tokens = new Set([token, otherToken, sharedToken])
  const server = createHttpServer((request, response) => {
    const offered = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (request.url !== '/api/host/identity' || !tokens.has(offered)) { response.writeHead(401); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, role: 'serve', pid: process.pid, protocolVersion: 1 }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  // The clone's record reports the host home, which exists; only its own folder and token
  // make it the clone's serve.
  await writeFile(join(chosen, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid: process.pid, protocolVersion: 1, tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16), profiles: ['default'], home: '' }))
  await writeFile(join(chosen, 'host-serve.token'), token, { mode: 0o600 })
  await chmod(join(chosen, 'host-serve.token'), 0o600)
  await writeFile(join(other, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid: process.pid, protocolVersion: 1, tokenFingerprint: createHash('sha256').update(otherToken).digest('hex').slice(0, 16), profiles: ['default'], home: '' }))
  await writeFile(join(other, 'host-serve.token'), otherToken, { mode: 0o600 })
  await chmod(join(other, 'host-serve.token'), 0o600)
  await writeFile(join(shared, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid: process.pid, protocolVersion: 1, home: '', tokenFingerprint: createHash('sha256').update(sharedToken).digest('hex').slice(0, 16), profiles: ['default'] }))
  await writeFile(join(shared, 'host-serve.token'), sharedToken, { mode: 0o600 })
  await chmod(join(shared, 'host-serve.token'), 0o600)
  const hermes = join(root, 'hermes')
  await writeFile(hermes, `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("Hermes Agent v0.23.1")
elif args == ["profile", "list"]:
    print("")
    print(" Profile          Model                        Gateway      Alias        Distribution")
    print(" ---------------- ---------------------------- ------------ ------------ --------------------")
    print("  Chosen (default) chosen/model                 running      default      -")
    print("")
elif args in (["profile", "show", "default"],):
    print("Profile: Chosen (default)")
    print("Model:   chosen/model (acme)")
    print("Gateway: running")
elif args[0:1] == ["-p"] and args[-1:] == ["--json"]:
    print(json.dumps({"default": "chosen/model", "provider": "acme"}))
else:
    sys.exit(1)
`, { mode: 0o755 })
  await chmod(hermes, 0o755)
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { root, home, otherHome, chosen, other, shared, port, otherToken, sharedToken, hermes }
}

function runAttach(fixture, { stateDir, hermesHome, gatewayLockDir = fixture.other } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnChild('python3', ['-u', '-c', attachSupervisor], {
      env: { ...process.env, HOME: fixture.root, HERMES_GATEWAY_LOCK_DIR: gatewayLockDir, XDG_STATE_HOME: join(fixture.root, 'state') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    proc.on('error', reject)
    proc.stdout.on('data', data => { out += String(data) })
    proc.stderr.on('data', data => { err += String(data) })
    proc.on('close', () => {
      try { resolve({ frames: out.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)), raw: out, err }) }
      catch (error) { reject(new Error(`${error.message}: ${out} ${err}`)) }
    })
    proc.stdin.write(`${JSON.stringify({ nonce: randomBytes(8).toString('hex'), hermesPath: fixture.hermes, hermesHome, stateDir: stateDir ?? '', minVersion: HERMES_MINIMUM, startMs: 20000, controlMs: 8000 })}\n`)
    proc.stdin.end()
  })
}

test('the token route reads only the chosen serve’s record and token, never the other', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const { frames } = await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home })
  assert.equal(frames.find(frame => frame.type === 'error'), undefined, JSON.stringify(frames))
  assert.equal(frames.find(frame => frame.type === 'token').value, token)
  assert.ok(!frames.some(frame => JSON.stringify(frame).includes(fixture.otherToken)), 'the other serve’s token never leaves')
  assert.equal(frames.find(frame => frame.type === 'record').profiles[0].name, 'Chosen')
})

test('an explicit serve folder is the only one read: a valid record beside it is no fallback', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const { frames } = await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home })
  assert.equal(frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.equal(frames.find(frame => frame.type === 'token'), undefined, 'HERMES_GATEWAY_LOCK_DIR is not used for a chosen bot')
})

test('a sandbox-internal home name still attaches to the chosen serve’s own record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const record = JSON.parse(await readFile(join(fixture.chosen, 'host-serve.json'), 'utf8'))
  await writeFile(join(fixture.chosen, 'host-serve.json'), JSON.stringify({ ...record, home: '/home/sandbox/.hermes' }))
  const { frames } = await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home })
  assert.equal(frames.find(frame => frame.type === 'error'), undefined, JSON.stringify(frames))
  assert.equal(frames.find(frame => frame.type === 'token')?.value, token)
})

test('the sandboxed clone and the host home each pick only their own token', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  // The clone's record still names the host home. Each explicitly picked serve folder
  // reads its own record and token: the clone never takes the host home's, and the host
  // home never takes the clone's.
  const clonePick = await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home })
  assert.equal(clonePick.frames.find(frame => frame.type === 'token')?.value, token)
  assert.ok(!clonePick.raw.includes(fixture.otherToken))
  const hostPick = await runAttach(fixture, { stateDir: fixture.other, hermesHome: fixture.otherHome })
  assert.equal(hostPick.frames.find(frame => frame.type === 'token')?.value, fixture.otherToken)
  assert.ok(!hostPick.raw.includes(token))
})

test('the home’s own record wins over a nameless shared account record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const { frames, raw } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: fixture.shared })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, token)
  assert.ok(!raw.includes(fixture.sharedToken), 'the nameless shared token never leaves')
})

test('the home’s own record wins over a shared record naming an unknown sandbox home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const record = JSON.parse(await readFile(join(fixture.shared, 'host-serve.json'), 'utf8'))
  await writeFile(join(fixture.shared, 'host-serve.json'), JSON.stringify({ ...record, pid: process.pid + 1, home: '/home/sandbox/.hermes' }))
  const { frames, raw } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: fixture.shared })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, token, 'the home’s own record wins')
  assert.ok(!raw.includes(fixture.sharedToken), 'an unknown sandbox home is never a fallback')
})

test('a nameless shared account record is never used for a home with no own record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const { frames, raw } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: fixture.shared })
  assert.equal(frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.equal(frames.find(frame => frame.type === 'token'), undefined)
  assert.ok(!raw.includes(fixture.sharedToken), 'a nameless record is not another home’s fallback')
})

test('a shared record naming a home that owns a different serve is never its pick', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const record = JSON.parse(await readFile(join(fixture.shared, 'host-serve.json'), 'utf8'))
  await writeFile(join(fixture.shared, 'host-serve.json'), JSON.stringify({ ...record, pid: process.pid + 1, home: fixture.home }))
  const { frames, raw } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: fixture.shared })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, token, 'its own record, own token')
  assert.ok(!raw.includes(fixture.sharedToken), 'never the shared serve’s token')
})

test('default and second home both pick only their own token', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const defaultHome = join(fixture.root, '.hermes')
  await mkdir(defaultHome, { recursive: true })
  const secondPick = await runAttach(fixture, { stateDir: fixture.chosen, hermesHome: fixture.home })
  assert.equal(secondPick.frames.find(frame => frame.type === 'token')?.value, token)
  assert.ok(!secondPick.raw.includes(fixture.sharedToken), 'the second home never takes the account token')
  const defaultPick = await runAttach(fixture, { stateDir: fixture.shared, hermesHome: defaultHome })
  assert.equal(defaultPick.frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
  assert.ok(!defaultPick.raw.includes(token), 'the default home never takes the second token')
})

test('a nameless account record is used for the default home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const home = join(fixture.root, '.hermes')
  await mkdir(home, { recursive: true })
  const { frames, raw } = await runAttach(fixture, { stateDir: '', hermesHome: home, gatewayLockDir: fixture.shared })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
  assert.ok(!raw.includes(token), 'the other serve’s token never leaves')
})

test('a gateway lock folder inside the chosen home supplies its only record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const inside = join(fixture.home, 'custom-locks')
  await mkdir(inside, { recursive: true })
  await writeFile(join(inside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(inside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(inside, 'host-serve.token'), 0o600)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const { frames, err } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: inside })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken, JSON.stringify({ frames, err }))
})

test('a gateway-locks folder beside the chosen home supplies its only record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const beside = join(dirname(fixture.home), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
})

test('a symlinked home finds its record beside the link, as detection does', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const links = join(fixture.root, 'links')
  await mkdir(links, { recursive: true })
  const link = join(links, 'hermes-link')
  await symlink(fixture.home, link)
  const beside = join(links, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: link, gatewayLockDir: account })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken, 'the link beside record is used')
})

test('an ordinary config.yaml folder beside a home does not block its beside record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const notes = join(dirname(fixture.home), 'notes')
  await mkdir(notes, { recursive: true })
  await writeFile(join(notes, 'config.yaml'), 'note: not a Hermes home\n')
  const beside = join(dirname(fixture.home), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: account })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
})

test('an ordinary gateway-locks folder beside a home does not block its beside record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  await mkdir(join(dirname(fixture.home), 'backup', 'gateway-locks'), { recursive: true })
  const beside = join(dirname(fixture.home), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: account })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
})

test('an explicit shared folder is refused by the resolved home, real or link spelling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const shared = join(fixture.root, 'shared')
  const ash = join(shared, 'ash')
  const oak = join(fixture.root, 'reals', 'oak')
  await makeHome(ash, { skeleton: ['sessions', 'memories'] })
  await makeHome(oak, { soul: true })
  const oakLink = join(shared, 'oak-link')
  await symlink(oak, oakLink)
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  for (const spelling of [oak, oakLink]) {
    const result = await runAttach(fixture, { stateDir: beside, hermesHome: spelling, gatewayLockDir: account })
    assert.equal(result.frames.find(frame => frame.type === 'error')?.code, 'serve-record', spelling)
    assert.ok(!result.raw.includes(fixture.sharedToken), `no token for ${spelling}`)
  }
})

test('an explicit shared record is refused for a home beside a no-SOUL Hermes sibling', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const shared = join(fixture.root, 'shared')
  const ash = join(shared, 'ash')
  const oak = join(shared, 'oak')
  await makeHome(ash, { skeleton: ['sessions', 'memories'] })
  await makeHome(oak, { soul: true })
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const explicit = await runAttach(fixture, { stateDir: beside, hermesHome: oak, gatewayLockDir: account })
  assert.equal(explicit.frames.find(frame => frame.type === 'error')?.code, 'serve-record')
  assert.ok(!explicit.raw.includes(fixture.sharedToken))
  const implicit = await runAttach(fixture, { stateDir: '', hermesHome: oak, gatewayLockDir: account })
  assert.equal(implicit.frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.ok(!implicit.raw.includes(fixture.sharedToken))
})

test('the no-SOUL sibling refusal holds through two links', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const reals = join(fixture.root, 'reals')
  const ash = join(reals, 'ash')
  const oak = join(reals, 'oak')
  await makeHome(ash, { skeleton: ['cron', 'logs'] })
  await makeHome(oak, { soul: true })
  const shared = join(fixture.root, 'shared')
  await mkdir(shared, { recursive: true })
  await symlink(ash, join(shared, 'ash-link'))
  const oakLink = join(shared, 'oak-link')
  await symlink(oak, oakLink)
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const explicit = await runAttach(fixture, { stateDir: beside, hermesHome: oakLink, gatewayLockDir: account })
  assert.equal(explicit.frames.find(frame => frame.type === 'error')?.code, 'serve-record')
  assert.ok(!explicit.raw.includes(fixture.sharedToken))
  const implicit = await runAttach(fixture, { stateDir: '', hermesHome: oakLink, gatewayLockDir: account })
  assert.equal(implicit.frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.ok(!implicit.raw.includes(fixture.sharedToken))
})

test('an unrelated config.yaml plus logs folder does not block a beside record in attach', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  await makeHome(join(dirname(fixture.home), 'tool'), { skeleton: ['logs'] })
  const beside = join(dirname(fixture.home), 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home, gatewayLockDir: account })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
})

test('a solo added home without SOUL.md uses its own record in attach', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const solo = join(fixture.root, 'solo', 'oak')
  await makeHome(solo, { config: true })
  const own = join(solo, '.local', 'state', 'hermes', 'gateway-locks')
  await mkdir(own, { recursive: true })
  await writeFile(join(own, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(own, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(own, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames } = await runAttach(fixture, { stateDir: own, hermesHome: solo, gatewayLockDir: account })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, fixture.sharedToken)
})

test('an explicit shared record beside a stopped home with a running sibling is refused', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const shared = join(fixture.root, 'shared')
  const runner = join(shared, 'runner')
  const stopped = join(shared, 'stopped')
  for (const home of [runner, stopped]) {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.yaml'), 'model: sample/model\n')
    await writeFile(join(home, 'SOUL.md'), '# Home\n')
  }
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const explicit = await runAttach(fixture, { stateDir: beside, hermesHome: stopped, gatewayLockDir: account })
  assert.equal(explicit.frames.find(frame => frame.type === 'error')?.code, 'serve-record')
  assert.ok(!explicit.raw.includes(fixture.sharedToken))
  const implicit = await runAttach(fixture, { stateDir: '', hermesHome: stopped, gatewayLockDir: account })
  assert.equal(implicit.frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.ok(!implicit.raw.includes(fixture.sharedToken))
})

test('an explicit linked shared record is refused for a linked stopped home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  const reals = join(fixture.root, 'reals')
  const runner = join(reals, 'runner')
  const stopped = join(reals, 'stopped')
  for (const home of [runner, stopped]) {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.yaml'), 'model: sample/model\n')
    await writeFile(join(home, 'SOUL.md'), '# Home\n')
  }
  const shared = join(fixture.root, 'shared')
  await mkdir(shared, { recursive: true })
  await symlink(runner, join(shared, 'runner-link'))
  const stoppedLink = join(shared, 'stopped-link')
  await symlink(stopped, stoppedLink)
  const beside = join(shared, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const explicit = await runAttach(fixture, { stateDir: beside, hermesHome: stoppedLink, gatewayLockDir: account })
  assert.equal(explicit.frames.find(frame => frame.type === 'error')?.code, 'serve-record')
  assert.ok(!explicit.raw.includes(fixture.sharedToken))
  const implicit = await runAttach(fixture, { stateDir: '', hermesHome: stoppedLink, gatewayLockDir: account })
  assert.equal(implicit.frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.ok(!implicit.raw.includes(fixture.sharedToken))
})

test('a beside record shared by two homes is never an implicit pick for either', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  // Two Hermes homes under the same parent: the default and an added one.
  const defaultHome = join(fixture.root, '.hermes')
  const addedHome = join(fixture.root, 'picked-home')
  for (const home of [defaultHome, addedHome]) {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'config.yaml'), 'model: sample/model\n')
    await writeFile(join(home, 'SOUL.md'), '# Home\n')
  }
  const beside = join(fixture.root, 'gateway-locks')
  await mkdir(beside, { recursive: true })
  await writeFile(join(beside, 'host-serve.json'), JSON.stringify({ role: 'serve', port: fixture.port, pid: process.pid, protocolVersion: 1, profiles: ['default'], home: '' }))
  await writeFile(join(beside, 'host-serve.token'), fixture.sharedToken, { mode: 0o600 })
  await chmod(join(beside, 'host-serve.token'), 0o600)
  const account = join(fixture.root, 'account-locks')
  await mkdir(account, { recursive: true })
  const { frames, raw } = await runAttach(fixture, { stateDir: '', hermesHome: defaultHome, gatewayLockDir: account })
  assert.equal(frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.ok(!raw.includes(fixture.sharedToken), 'the ambiguous beside token never leaves')
})

test('without an explicit picked folder, a record naming another existing home is not used', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  await rm(join(fixture.chosen, 'host-serve.json'))
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home })
  assert.equal(frames.find(frame => frame.type === 'error')?.code, 'serve-not-running')
  assert.equal(frames.find(frame => frame.type === 'token'), undefined, 'the account default is never a fallback for another home')
})

test('without a chosen folder, the home’s own state folder is read before the account default', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await attachFixture(t)
  // The account default points at the other home's valid record; the chosen home's own
  // record must win, and its token is the one that leaves.
  const { frames } = await runAttach(fixture, { stateDir: '', hermesHome: fixture.home })
  assert.equal(frames.find(frame => frame.type === 'token')?.value, token)
})
