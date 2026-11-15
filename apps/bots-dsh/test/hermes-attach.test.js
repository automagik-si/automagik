// Attach reads a running machine-level `hermes serve` through SSH: its record and 0600
// token, its profiles, and a local tunnel. Every test here proves the same boundaries:
// nothing on the remote is started or stopped, the token never reaches a message or a
// detail line, and closing only ends this computer's SSH tunnel.
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { attachSupervisor, startHermesAttach } from '../src/host/hermes-attach.js'
import { HERMES_MINIMUM } from '../src/host/hermes-ssh.js'
import { HermesTransport, RemoteChat } from '../src/host/hermes-transport.js'
import { desktop8Session } from './fixtures/hermes-desktop8.mjs'

const deadlines = { start: 8000, control: 2000, cancel: 400 }
const token = randomBytes(24).toString('hex')
const profiles = [
  { id: 'default', name: 'Hefesto', model: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', running: true },
  { id: 'second', name: 'Second Bot', model: 'openai/gpt-5.1', provider: 'openai', running: false },
]

function child() {
  const proc = new EventEmitter()
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.stdout.resume?.()
  proc.pid = 1200
  proc.exitCode = null
  proc.killed = false
  proc.signals = []
  proc.stdin.on('error', () => {})
  proc.kill = signal => { proc.signals.push(signal); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); return true }
  return proc
}

// A stand-in for the local ssh client: one command reads the record, one tunnel forwards.
function fakeSsh(t, { frames = [], onHandshake, tunnelFail = false } = {}) {
  const calls = []
  let remote, tunnel
  const spawn = (command, args) => {
    const proc = child()
    const call = { command, args, proc }
    calls.push(call)
    if (args.includes('-N')) {
      tunnel = proc
      setImmediate(() => tunnelFail
        ? tunnel.stderr.write('debug1: cannot listen to port: 40123\n')
        : tunnel.stderr.write('debug1: Local forwarding listening on 127.0.0.1 port 40123.\n'))
    } else {
      remote = proc
      proc.stdin.on('data', chunk => {
        const handshake = JSON.parse(String(chunk).trim())
        call.handshake = handshake
        onHandshake?.(handshake)
        for (const frame of frames) remote.stdout.write(`${JSON.stringify({ nonce: handshake.nonce, ...frame })}\n`)
        remote.exitCode = 0
        remote.emit('close', 0)
      })
    }
    return proc
  }
  return { spawn, calls, get remote() { return remote }, get tunnel() { return tunnel } }
}

const readyFrames = () => [
  { type: 'record', port: 9119, pid: 77, version: '0.22.5', profiles },
  { type: 'token', value: token },
  { type: 'ready', port: 9119 },
]

test('attach reads the record and token, tunnels to the recorded port and needs no remote process', async t => {
  const ssh = fakeSsh(t, { frames: readyFrames() })
  const connection = await startHermesAttach({ host: 'example.invalid', hermesHome: '/remote/scratch' }, {
    spawn: ssh.spawn, allocatePort: async () => 40123, deadlines,
  })
  t.after(() => connection.close())
  assert.equal(connection.attached, true)
  assert.equal(connection.address, 'http://127.0.0.1:40123')
  assert.equal(connection.credential, token)
  assert.deepEqual(connection.authHeaders, { Authorization: `Bearer ${token}` })
  assert.deepEqual(connection.profiles.map(row => [row.id, row.name, row.model, row.provider, row.running]), [
    ['default', 'Hefesto', 'anthropic/claude-sonnet-4-5', 'anthropic', true],
    ['second', 'Second Bot', 'openai/gpt-5.1', 'openai', false],
  ])
  assert.equal(connection.defaultProfile, 'default')
  // One read-only command and one tunnel, both over the same SSH details.
  assert.equal(ssh.calls.length, 2)
  const [reading, tunnel] = ssh.calls
  assert.ok(reading.args.at(-1).startsWith('exec python3 -u -c '))
  assert.ok(reading.args.includes('ClearAllForwardings=yes'))
  assert.ok(tunnel.args.includes('-N'))
  assert.ok(tunnel.args.includes('127.0.0.1:40123:127.0.0.1:9119'))
  // The remote command is told the release floor and the person's Hermes path only.
  assert.equal(reading.handshake.minVersion, HERMES_MINIMUM)
  assert.equal(reading.handshake.hermesHome, '/remote/scratch', 'the optional home scopes the read-only CLI')
  assert.equal('credential' in reading.handshake, false, 'no app-owned credential is minted for an attached serve')
  await connection.close()
  assert.deepEqual(ssh.tunnel.signals, ['SIGTERM'])
  assert.deepEqual(ssh.remote.signals, [], 'Hermes is never signalled')
})

test('closing an attach never asks the remote to stop, clean or close anything', async t => {
  const ssh = fakeSsh(t, { frames: readyFrames() })
  const connection = await startHermesAttach({ host: 'example.invalid' }, { spawn: ssh.spawn, allocatePort: async () => 40123, deadlines })
  const writes = []
  ssh.remote.stdin.on('data', chunk => writes.push(String(chunk)))
  await connection.close()
  assert.deepEqual(writes, [], 'no close frame is written to the remote reader')
  assert.deepEqual(ssh.remote.signals, [])
  assert.deepEqual(ssh.tunnel.signals, ['SIGTERM'])
})

test('no serve means not running and how to start it; a gateway-only host says so', async t => {
  for (const [code, pattern] of [
    ['serve-not-running', /not running/i],
    ['serve-gateway', /gateway/i],
    ['serve-record', /record or private token is stale/i],
    ['serve-profiles', /profiles could not be read/i],
  ]) {
    const ssh = fakeSsh(t, { frames: [{ type: 'error', code }] })
    await assert.rejects(startHermesAttach({ host: 'example.invalid' }, { spawn: ssh.spawn, allocatePort: async () => 40123, deadlines }), error => {
      assert.equal(error.code, `bot/hermes-attach-${code.replace('serve-', '')}`, code)
      assert.match(error.message, pattern)
      if (code === 'serve-not-running') assert.match(error.message, /hermes serve/)
      return true
    })
  }
})

test('the token never appears in an error, a detail line or a stack', async t => {
  for (const frames of [
    [{ type: 'record', port: 9119, pid: 77, profiles }, { type: 'token', value: token }, { type: 'error', code: 'serve-record' }],
    [{ type: 'record', port: 9119, pid: 77, profiles }, { type: 'token', value: token }, { type: 'ready', port: 9119 }, { type: 'error', code: 'handshake' }],
  ]) {
    const ssh = fakeSsh(t, { frames })
    await assert.rejects(startHermesAttach({ host: 'example.invalid' }, { spawn: ssh.spawn, allocatePort: async () => 40123, deadlines }), error => {
      for (const form of [error.message, error.stack, JSON.stringify(error.sshDetail ?? {})]) assert.ok(!form.includes(token), form)
      return true
    })
  }
})

test('an unreadable or missing record frame refuses instead of tunnelling to a guess', async t => {
  for (const frames of [
    [{ type: 'token', value: token }, { type: 'ready', port: 9119 }],
    [{ type: 'record', port: 0, pid: 77, profiles }, { type: 'token', value: token }, { type: 'ready', port: 9119 }],
    [{ type: 'record', port: 9119, pid: 77, profiles: [] }, { type: 'token', value: token }, { type: 'ready', port: 9119 }],
    [{ type: 'record', port: 9119, pid: 77, profiles }, { type: 'token', value: 'short' }, { type: 'ready', port: 9119 }],
  ]) {
    const ssh = fakeSsh(t, { frames })
    await assert.rejects(startHermesAttach({ host: 'example.invalid' }, { spawn: ssh.spawn, allocatePort: async () => 40123, deadlines }), error => {
      assert.match(error.code, /^bot\/hermes-/)
      assert.equal(ssh.calls.length, 1, 'no tunnel is opened without a valid record and token')
      return true
    })
  }
})

test('the attach reader contains no start, stop, signal or kill path', () => {
  for (const forbidden of ['Popen', 'killpg', 'terminate', 'SIGTERM', 'SIGKILL', 'serve --isolated', '--isolated']) {
    assert.ok(!attachSupervisor.includes(forbidden), forbidden)
  }
  // No process is signalled or probed with a signal at all.
  const probes = [...attachSupervisor.matchAll(/os\.kill\([^)]*\)/g)].map(match => match[0])
  assert.deepEqual(probes, [])
  // It reads exactly the host rendezvous record and its private token, and runs the CLI
  // read-only: profile list/show and config get model.
  assert.match(attachSupervisor, /host-serve\.json/)
  assert.match(attachSupervisor, /host-serve\.token/)
  assert.match(attachSupervisor, /"profile", "list"/)
  assert.match(attachSupervisor, /"profile", "show"/)
  assert.match(attachSupervisor, /"config", "get", "model"/)
  assert.doesNotMatch(attachSupervisor, /"config", "set"/)
  assert.doesNotMatch(attachSupervisor, /"session\.create"/)
})

test('a model id ending in a colon or slash is kept whole', async t => {
  const frames = [
    { type: 'record', port: 9119, pid: 77, profiles: [
      { id: 'default', name: 'Default', model: 'org/model:', provider: 'org', running: true },
      { id: 'second', name: 'Second', model: 'path/model/', provider: 'path', running: false },
    ] },
    { type: 'token', value: token },
    { type: 'ready', port: 9119 },
  ]
  const ssh = fakeSsh(t, { frames })
  const connection = await startHermesAttach({ host: 'example.invalid' }, { spawn: ssh.spawn, allocatePort: async () => 40123, deadlines })
  t.after(() => connection.close())
  assert.deepEqual(connection.profiles.map(row => row.model), ['org/model:', 'path/model/'])
})

// The reader itself, run against a scratch state folder and a fake Hermes CLI: the 0600
// token file is the only credential, its fingerprint must match, and the recorded owner
// must answer as itself.
async function readerHome(t, { mode = 0o600, fingerprint = true, record = true, noProfiles = false, servePid } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-attach-'))
  const lock = join(home, 'locks')
  await writeFile(join(home, '.keep'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(lock, { recursive: true })
  const hermes = join(home, 'hermes')
  await writeFile(hermes, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
mode = os.environ.get("FAKE_READER", "")
lock = os.environ.get("HERMES_GATEWAY_LOCK_DIR", "")
models = {
    "default": ("acme/llama-9:70b-q4", "acme"),
    "second": ("openai/gpt-5.1", "openai"),
    "third": ("openrouter/auto", "openrouter"),
}
try:
    secret = open(os.path.join(lock, "host-serve.token")).read().strip()
except OSError:
    secret = ""
if args == ["--version"]:
    print("Hermes Agent v0.22.5")
elif args == ["profile", "list"]:
    if mode == "leak":
        print(secret)
        sys.exit(1)
    print("")
    print(" Profile          Model                        Gateway      Alias        Distribution")
    print(" ---------------- ---------------------------- ------------ ------------ --------------------")
    print(" A Very Long Display Name (default) acme/llama-9:70b-q4 running - -")
    if mode != "omit-second":
        print("  Second (second)  openai/gpt-5.1               stopped      second       -")
    print("  Third (third)    openrouter/auto              running      third        -")
    print("")
elif args in (["profile", "show", "default"], ["profile", "show", "second"], ["profile", "show", "third"]):
    ident = args[2]
    display = {"default": "A Very Long Display Name (default)", "second": "Second (second)", "third": "Third (third)"}[ident]
    model, provider = models[ident]
    gateway = "stopped" if ident == "second" else "running"
    print("")
    print("Profile: " + display)
    print("Path:    /tmp/hermes")
    print("Model:   " + model + " (" + provider + ")")
    print("Gateway: " + gateway)
    print("")
elif args[0:1] == ["-p"] and args[-1:] == ["--json"]:
    if mode == "scalar":
        sys.exit(1)
    ident = args[1]
    model, provider = models[ident]
    print(json.dumps({"default": model, "provider": provider}))
elif args[0:1] == ["-p"] and args[2:5] == ["config", "get", "model"]:
    if mode != "scalar":
        sys.exit(1)
    model, _ = models[args[1]]
    print(model)
else:
    sys.exit(1)
`, { mode: 0o755 })
  await chmod(hermes, 0o755)
  const server = createServer((request, response) => {
    if (request.url !== '/api/host/identity' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, role: 'serve', pid: servePid ?? process.pid, protocolVersion: 1 }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 5 }) })
  if (record) await writeFile(join(lock, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid: process.pid, protocolVersion: 1, tokenFingerprint: fingerprint ? createHash('sha256').update(token).digest('hex').slice(0, 16) : 'f'.repeat(16), profiles: noProfiles ? [] : ['default', 'second', 'third'] }))
  await writeFile(join(lock, 'host-serve.token'), token, { mode })
  await chmod(join(lock, 'host-serve.token'), mode)
  return { home, lock, hermes }
}

function runReader(t, { home, hermes }, { nonce = randomBytes(8).toString('hex'), mode = '' } = {}) {
  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawnChild('python3', ['-u', '-c', attachSupervisor], { env: { ...process.env, HERMES_GATEWAY_LOCK_DIR: join(home, 'locks'), ...(mode ? { FAKE_READER: mode } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) { reject(error); return }
    let out = '', err = ''
    proc.on('error', error => reject(Object.assign(error, { code: error.code === 'ENOENT' ? 'NO_PYTHON' : error.code })))
    proc.stdout.on('data', data => { out += String(data) })
    proc.stderr.on('data', data => { err += String(data) })
    proc.on('close', () => {
      let frames
      try { frames = out.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) } catch { reject(new Error(`bad reader output: ${out}\n${err}`)); return }
      resolve(frames)
    })
    proc.stdin.write(`${JSON.stringify({ nonce, hermesPath: hermes, minVersion: HERMES_MINIMUM, startMs: 20000, controlMs: 8000 })}\n`)
  })
}

async function hasPython() {
  return new Promise(resolve => {
    const proc = spawnChild('python3', ['--version'], { stdio: 'ignore' })
    proc.on('error', () => resolve(false))
    proc.on('close', code => resolve(code === 0))
  })
}

test('the reader reads only the 0600 token file and the fields of the bot model', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const home = await readerHome(t)
  const frames = await runReader(t, home)
  const record = frames.find(frame => frame.type === 'record')
  assert.ok(record, JSON.stringify(frames))
  assert.deepEqual(record.profiles.map(row => [row.id, row.name, row.model, row.provider, row.running]), [
    ['default', 'A Very Long Display Name', 'acme/llama-9:70b-q4', 'acme', true],
    ['second', 'Second', 'openai/gpt-5.1', 'openai', false],
    ['third', 'Third', 'openrouter/auto', 'openrouter', true],
  ])
  assert.equal(record.active, 'default')
  assert.equal(frames.find(frame => frame.type === 'token').value, token)
  assert.equal(frames.find(frame => frame.type === 'ready').port, record.port)
})

test('a release without --json prints the model as a whole scalar, colon and all', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const home = await readerHome(t)
  const frames = await runReader(t, home, { mode: 'scalar' })
  const record = frames.find(frame => frame.type === 'record')
  assert.ok(record, JSON.stringify(frames))
  assert.deepEqual(record.profiles.map(row => row.model), ['acme/llama-9:70b-q4', 'openai/gpt-5.1', 'openrouter/auto'])
})

test('a profile missing from the human table is still read from the record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const home = await readerHome(t)
  const record = (await runReader(t, home, { mode: 'omit-second' })).find(frame => frame.type === 'record')
  assert.ok(record, 'the record is emitted')
  assert.deepEqual(record.profiles.map(row => row.id), ['default', 'second', 'third'])
  assert.equal(record.profiles.find(row => row.id === 'second').model, 'openai/gpt-5.1')
})

test('a token printed in an early error tail is redacted before the token frame', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const home = await readerHome(t, { noProfiles: true })
  const frames = await runReader(t, home, { mode: 'leak' })
  const error = frames.find(frame => frame.type === 'error')
  assert.equal(error?.code, 'serve-profiles', JSON.stringify(frames))
  assert.equal(frames.find(frame => frame.type === 'token'), undefined)
  assert.ok(!JSON.stringify(frames).includes(token), 'the host token never leaves in an error tail')
})

test('a token file another user could read, or a stale fingerprint, is refused', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  for (const options of [{ mode: 0o644 }, { mode: 0o640 }, { fingerprint: false }]) {
    const home = await readerHome(t, options)
    const frames = await runReader(t, home)
    assert.equal(frames.find(frame => frame.type === 'error')?.code, 'serve-record', JSON.stringify(options))
    assert.equal(frames.find(frame => frame.type === 'token'), undefined)
  }
})

test('the reader says not running when no serve record exists, without reading a gateway record', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const missing = await readerHome(t, { record: false })
  assert.equal((await runReader(t, missing)).find(frame => frame.type === 'error')?.code, 'serve-not-running')
  // The reader opens host-serve.json and host-serve.token only; a gateway record is not its business.
  assert.doesNotMatch(attachSupervisor, /host-gateway\.json/)
})

test('a recorded port answered by another process is not attached', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const home = await readerHome(t, { servePid: 1 })
  const frames = await runReader(t, home)
  assert.equal(frames.find(frame => frame.type === 'error')?.code, 'serve-record')
})

// The wire the attached connection uses: JOIN the hidden Bot Chat, read the bot's own
// model from the config fields, and never ask for a model list or set a model.
test('an attached JOIN lists only Bot Chat and never asks for models or sets one', async () => {
  const transport = new HermesTransport({ address: 'http://127.0.0.1:40123', profile: 'sample', credential: token, authHeaders: { Authorization: `Bearer ${token}` }, allowLoopback: true, attached: true })
  const calls = []
  transport.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'session.list') return { sessions: [{ id: 'root', resolved_id: 'tip', title: 'Bot Chat' }] }
    if (method === 'session.resume') return desktop8Session('runtime', params.session_id).live
    throw Error(`Unexpected request: ${method}`)
  }
  const result = await transport.session({ canonicalBot: true }, { model: 'some/other-model', provider: 'elsewhere' })
  assert.equal(result.session_id, 'runtime')
  assert.deepEqual(calls.map(call => call.method), ['session.list', 'session.resume'])
  assert.deepEqual(calls[0].params, { title: 'Bot Chat', include_hidden: true })
  assert.equal(calls[1].params.close_on_disconnect, false)
  assert.ok(!calls.some(call => ['model.options', 'config.set', 'session.create'].includes(call.method)))
})

test('an attached close detaches the joined view, then closes the socket; never session.close', async () => {
  const transport = new HermesTransport({ address: 'http://127.0.0.1:40123', profile: 'sample', credential: token, authHeaders: { Authorization: `Bearer ${token}` }, allowLoopback: true, attached: true })
  const calls = []
  transport.request = async (method, params) => { calls.push({ method, params }); return { detached: true } }
  transport.close = () => calls.push({ method: 'ws.close' })
  const run = new RemoteChat(transport, { identity: { runtimeSessionId: 'runtime', storedSessionId: 'stored', subscriptionId: 'subscription' } })
  await run.close()
  assert.deepEqual(calls.map(call => call.method), ['session.detach', 'ws.close'])
  assert.deepEqual(calls[0].params, { session_id: 'runtime', subscription_id: 'subscription' })
  assert.ok(!calls.some(call => call.method === 'session.close'), 'an attached view never closes the bot session')
})

test('a serve without a subscription ref only loses the socket, and never asks to close', async () => {
  const transport = new HermesTransport({ address: 'http://127.0.0.1:40123', profile: 'sample', credential: token, authHeaders: { Authorization: `Bearer ${token}` }, allowLoopback: true, attached: true })
  const calls = []
  transport.request = async (method, params) => { calls.push({ method, params }); return {} }
  transport.close = () => calls.push({ method: 'ws.close' })
  const run = new RemoteChat(transport, { identity: { runtimeSessionId: 'runtime', storedSessionId: 'stored' } })
  await run.stop()
  assert.deepEqual(calls.map(call => call.method), ['ws.close'])
})

test('attach uses the bot model and the joined view only; no model list, no override', async () => {
  const transport = new HermesTransport({ address: 'http://127.0.0.1:40123', profile: 'sample', credential: token, authHeaders: { Authorization: `Bearer ${token}` }, allowLoopback: true, attached: true })
  assert.equal(transport.socketToken, token, 'the socket carries the host token as ?token=')
  const calls = []
  transport.request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'session.list') return { sessions: [{ id: 'root', resolved_id: 'tip', title: 'Bot Chat' }] }
    if (method === 'session.resume') return desktop8Session('runtime', params.session_id).live
    throw Error(method)
  }
  const run = new RemoteChat(transport, { identity: { canonicalBot: true } })
  await run.prepare({ model: 'not-the-bot-model', provider: 'not-the-bot-provider' })
  assert.ok(!calls.some(call => ['model.options', 'config.set', 'session.create', 'session.close'].includes(call.method)))
  assert.equal(run.identity.runtimeSessionId, 'runtime')
})

test('an approval is answered only for the joined session and epoch, and a cancel wins first', async () => {
  const transport = new HermesTransport({ address: 'http://127.0.0.1:40123', profile: 'sample', credential: token, authHeaders: { Authorization: `Bearer ${token}` }, allowLoopback: true, attached: true })
  transport.epoch = 'epoch-1'
  const answers = []
  transport.answer = (id, result) => answers.push({ id, result })
  let ask = null
  const asked = []
  const run = new RemoteChat(transport, {
    identity: { runtimeSessionId: 'runtime', storedSessionId: 'stored', epoch: 'epoch-1' },
    question: async (params, signal) => { asked.push(params.request_id); return new Promise(resolve => { ask = resolve; signal.addEventListener('abort', () => resolve('deny'), { once: true }) }) },
  })
  // Another session's approval is not ours to answer.
  await run.control({ kind: 'question', id: 1, method: 'approval', epoch: 'epoch-1', params: { session_id: 'other', request_id: 'r1' } })
  // Another epoch's approval is not ours either.
  await run.control({ kind: 'question', id: 2, method: 'approval', epoch: 'epoch-0', params: { session_id: 'runtime', request_id: 'r2' } })
  assert.deepEqual(asked, [])
  assert.deepEqual(answers, [])
  // The joined session's approval shows, and is answered once.
  const shown = run.control({ kind: 'question', id: 3, method: 'approval', epoch: 'epoch-1', params: { session_id: 'runtime', request_id: 'r3' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(asked, ['r3'])
  ask('once')
  await shown
  assert.deepEqual(answers, [{ id: 3, result: { choice: 'once' } }])
  // The other client answers first: the card is withdrawn, and this side sends nothing.
  answers.length = 0
  const withdrawn = run.control({ kind: 'question', id: 4, method: 'approval', epoch: 'epoch-1', params: { session_id: 'runtime', request_id: 'r4' } })
  await new Promise(resolve => setImmediate(resolve))
  run.receive({ kind: 'event', type: 'request.cancel', session_id: 'runtime', epoch: 'epoch-1', payload: { id: 4, method: 'approval', reason: 'answered elsewhere' } })
  ask('once')
  await withdrawn
  assert.deepEqual(answers, [])
})

test('a live legacy Bot Chat resume may omit profile_name and stored_session_id and keeps the joined id', async () => {
  const transport = new HermesTransport({ address: 'http://127.0.0.1:40123', profile: 'default', credential: token, authHeaders: { Authorization: `Bearer ${token}` }, allowLoopback: true, attached: true })
  transport.request = async method => {
    if (method === 'session.list') return { sessions: [{ id: 'stored', resolved_id: 'stored', title: 'Bot Chat' }] }
    if (method === 'session.resume') return { session_id: 'runtime', session_key: 'stored', message_count: 1, messages: [], info: { desktop_contract: 8, approval_mode: 'smart', model: 'mock-model', provider: 'custom:localmock', yolo: false, running: false, lazy: false } }
    throw Error(method)
  }
  const snapshot = await transport.session({ canonicalBot: true, storedSessionId: 'stored' })
  assert.equal(snapshot.session_id, 'runtime')
  assert.equal(snapshot.stored_session_id, 'stored')
})

test('the wire accepts a message.start event with no payload', async () => {
  const { hermesEventShape } = await import('../src/host/hermes-transport.js')
  assert.equal(hermesEventShape({ type: 'message.start', session_id: 'runtime', seq: 12 }), true)
  assert.equal(hermesEventShape({ type: 'sessions.changed' }), true)
  assert.equal(hermesEventShape({ type: 'session.info', session_id: 'runtime', seq: 2, payload: { approval_mode: 'smart', model: 'm', provider: 'p', yolo: false, running: false, lazy: false } }), true)
  assert.equal(hermesEventShape({ type: 'session.info', session_id: 'runtime', seq: 2, payload: {} }), true, 'info fields are optional on a live legacy session')
})
