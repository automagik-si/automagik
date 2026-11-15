// Hermes detection reads every home with a config, each home's own serve record, and each
// home's profiles as bots: names first, the model a secondary line, and a stopped bot shown
// with how to start it. Every test proves the same boundaries: only config.yaml, serve
// records and `hermes profile list`/`serve --status` are read, never .env or auth, and
// nothing on the remote is started, stopped or signalled.
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { attachSupervisor } from '../src/host/hermes-attach.js'
import { detectHermesBots, detectSupervisor } from '../src/host/hermes-detect.js'
import { HERMES_MINIMUM } from '../src/host/hermes-ssh.js'

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
async function readerFixture(t, { primaryRecord = false, cloneRecord = true, cloneHomeField = '', cloneProfilesFail = false, extraHomes = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-detect-'))
  const primary = join(root, '.hermes')
  const clone = join(root, '.local', 'share', 'clone', 'hermes')
  const primaryLock = join(primary, 'gateway-locks')
  const cloneLock = join(clone, '.local', 'state', 'hermes', 'gateway-locks')
  for (const folder of [primary, clone, join(clone, 'profiles', 'workshop'), primaryLock, cloneLock, join(root, 'state')]) await mkdir(folder, { recursive: true })
  await writeFile(join(primary, 'config.yaml'), 'model:\n  default: openai/gpt-5.1\n  provider: openai\n')
  await writeFile(join(clone, 'config.yaml'), 'model:\n  default: "anthropic/claude-sonnet"\n  provider: anthropic\n')
  await writeFile(join(clone, 'profiles', 'workshop', 'config.yaml'), 'model: "acme/llama9:70b-q4"\n')
  const server = createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  if (primaryRecord) await writeFile(join(primaryLock, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: process.pid, port, profiles: ['default'], home: primary }))
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
  await writeFile(join(primary, '.env'), 'FAKE_SECRET=DO-NOT-READ-7f3a\n')
  await writeFile(join(clone, 'auth.json'), '{"token":"DO-NOT-READ-7f3a"}\n')
  await writeFile(join(primary, 'auth.lock'), 'DO-NOT-READ-7f3a\n')
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  return { root, primary, clone, primaryLock, cloneLock, hermes, log, port }
}

function runReader(fixture, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnChild('python3', ['-u', '-c', detectSupervisor], {
      env: { ...process.env, HOME: fixture.root, HERMES_HOME: '', HERMES_GATEWAY_LOCK_DIR: '', XDG_STATE_HOME: join(fixture.root, 'state'), FAKE_HERMES_SPEC: join(fixture.root, 'spec.json'), FAKE_HERMES_LOG: fixture.log },
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
    proc.stdin.write(`${JSON.stringify({ nonce: randomBytes(8).toString('hex'), hermesPath: fixture.hermes, startMs: 20000, controlMs: 8000, ...options })}\n`)
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

test('a sandbox record under the clone home is found where the home keeps it, and the bot is shown', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const fixture = await readerFixture(t, { cloneHomeField: '/home/sandbox/.hermes' })
  const { frames } = await runReader(fixture)
  const clone = botsOf(frames).find(row => row.home === fixture.clone)
  assert.ok(clone, JSON.stringify(frames))
  assert.equal(clone.running, true, 'a sandbox-internal home path does not hide its bot')
  assert.equal(clone.recordDir, fixture.cloneLock)
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
  assert.ok(!raw.includes('DO-NOT-READ-7f3a'), 'no credential file is read')
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
async function attachFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-attach-chosen-'))
  const home = join(root, 'chosen-home')
  const otherHome = join(root, 'other-home')
  const chosen = join(home, '.local', 'state', 'hermes', 'gateway-locks')
  const other = join(otherHome, '.local', 'state', 'hermes', 'gateway-locks')
  for (const folder of [home, otherHome, chosen, other]) await mkdir(folder, { recursive: true })
  await writeFile(join(home, 'config.yaml'), 'model: chosen/model\n')
  await writeFile(join(otherHome, 'config.yaml'), 'model: other/model\n')
  const otherToken = randomBytes(24).toString('hex')
  const tokens = new Set([token, otherToken])
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
  await writeFile(join(chosen, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid: process.pid, protocolVersion: 1, home: otherHome, tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16), profiles: ['default'] }))
  await writeFile(join(chosen, 'host-serve.token'), token, { mode: 0o600 })
  await chmod(join(chosen, 'host-serve.token'), 0o600)
  await writeFile(join(other, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid: process.pid, protocolVersion: 1, home: otherHome, tokenFingerprint: createHash('sha256').update(otherToken).digest('hex').slice(0, 16), profiles: ['default'] }))
  await writeFile(join(other, 'host-serve.token'), otherToken, { mode: 0o600 })
  await chmod(join(other, 'host-serve.token'), 0o600)
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
  return { root, home, otherHome, chosen, other, otherToken, hermes }
}

function runAttach(fixture, { stateDir, hermesHome } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnChild('python3', ['-u', '-c', attachSupervisor], {
      env: { ...process.env, HOME: fixture.root, HERMES_GATEWAY_LOCK_DIR: fixture.other, XDG_STATE_HOME: join(fixture.root, 'state') },
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
