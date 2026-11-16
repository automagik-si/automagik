// #1404: the follow-ups from the independent test of the Hermes picker. Detection leaves no
// timer behind; a turn on a stopped saved Bot names its own start line; an attach takes a
// record folder only when it belongs to the picked home; the start line names the Bot's own
// home; attach applies detection's shared-folder block. Everything runs on scratch folders,
// a fake Hermes CLI and a local identity server; nothing leaves this computer.
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { attachSupervisor } from '../src/host/hermes-attach.js'
import { detectHermesBots, detectSupervisor } from '../src/host/hermes-detect.js'
import { install } from '../src/host/hermes-remote.js'
import { HERMES_MINIMUM } from '../src/host/hermes-ssh.js'
import { fakeContext } from './fake-ctx.js'

async function hasPython() {
  return new Promise(resolve => {
    const proc = spawnChild('python3', ['--version'], { stdio: 'ignore' })
    proc.on('error', () => resolve(false))
    proc.on('close', code => resolve(code === 0))
  })
}

// ---------------------------------------------------------------- item 1: detection timers

function child() {
  const proc = new EventEmitter()
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough()
  proc.pid = 1300; proc.exitCode = null
  proc.stdin.on('error', () => {})
  proc.kill = () => { proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); return true }
  return proc
}
function fakeSsh(frames) {
  const calls = []
  const spawn = () => {
    const proc = child()
    calls.push(proc)
    proc.stdin.on('data', chunk => {
      const { nonce } = JSON.parse(String(chunk).trim())
      for (const frame of frames) proc.stdout.write(`${JSON.stringify({ nonce, ...frame })}\n`)
      proc.exitCode = 0
      proc.emit('close', 0)
    })
    return proc
  }
  return { spawn, calls }
}
const timers = () => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
const settle = () => new Promise(resolve => setImmediate(resolve))
const home = '/srv/sample-hermes'

test('#1404 a successful detection leaves no timer armed, with the default 60 s deadlines', async () => {
  await settle()
  const before = timers()
  const ssh = fakeSsh([
    { type: 'home', home, state: 'stopped', sandbox: false, serve: null },
    { type: 'bot', home, id: 'default', name: 'Sample', model: '', provider: '', running: false, recordDir: '', port: 0, start: 'hermes serve' },
    { type: 'ready', homes: 1, bots: 1, hermes: true },
  ])
  const found = await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn })
  assert.equal(found.bots.length, 1)
  await settle()
  assert.equal(timers(), before, 'no timer outlives a finished detection')
})

test('#1404 a failed detection leaves no timer armed', async () => {
  await settle()
  const before = timers()
  const ssh = fakeSsh([{ type: 'error', code: 'hermes-not-found' }])
  await assert.rejects(detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn }), error => error.code.startsWith('bot/hermes'))
  await settle()
  assert.equal(timers(), before, 'no timer outlives a failed detection')
})

test('#1404 an already cancelled detection starts nothing and arms no timer', async () => {
  await settle()
  const before = timers()
  const ssh = fakeSsh([])
  await assert.rejects(detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn, signal: AbortSignal.abort() }), /cancelled/)
  assert.equal(ssh.calls.length, 0, 'no SSH command for a cancelled detection')
  await settle()
  assert.equal(timers(), before)
})

test('#1404 a detected home keeps the shared-folder reason it was blocked for', async () => {
  const ssh = fakeSsh([
    { type: 'home', home, state: 'stopped', sandbox: false, blocked: 'shared-beside', serve: null },
    { type: 'home', home: '/srv/other-hermes', state: 'stopped', sandbox: false, serve: null },
    { type: 'ready', homes: 2, bots: 0, hermes: true },
  ])
  const found = await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn })
  assert.deepEqual(found.homes.map(row => [row.home, row.blocked]), [[home, 'shared-beside'], ['/srv/other-hermes', '']])
})

// ------------------------------------------------- item 2: a turn on a stopped saved Bot

function runtime(t, config = {}, failure) {
  const ctx = fakeContext(), endpoints = new Map(), sshCalls = []
  ctx.llm.registerAdapter = () => () => {}
  const rt = {
    ctx, state: { prefs: { hermesRemote: {
      enabled: true, setupVersion: 1, mode: 'ssh', authMode: 'token', address: '', attached: true,
      ssh: { host: 'sample-box', hermesHome: '/srv/sample home', recordDir: '/srv/sample home/gateway-locks' },
      profile: 'default', profiles: [{ id: 'default', name: 'Sample', model: 'sample-model', provider: 'sample' }],
      models: [{ id: 'attach', name: 'sample-model (sample)', provider: 'hermes-remote', model: 'sample-model', providerId: 'sample', contextWindow: 200000 }],
      ...config,
    } } },
    hooks: { endpoint: (name, fn) => endpoints.set(name, fn) },
    load: async () => {}, loadSecrets: async () => {}, save: async () => {},
    secretValue: () => undefined, secretEndpoint: async () => {}, noteFailure: () => {},
  }
  install(rt, {
    deadlines: { start: 1000, control: 100, cancel: 100 },
    fetch: async () => { assert.fail('no REST call for a stopped serve') },
    transport: () => { assert.fail('a stopped serve opens no chat wire') },
    startSsh: async (ssh, options) => { sshCalls.push({ ssh, options }); throw Object.assign(Error('Sample refusal'), { code: failure }) },
  })
  t.after(() => ctx.dispose())
  return { rt, endpoints, sshCalls }
}
async function turn(h) {
  const agent = h.rt.ctx.scopeAgent('sample-chat')
  h.rt.ctx.provide('agents', { get: id => id === 'sample-chat' ? agent : undefined, list: () => [agent], roots: () => [agent] })
  const chunks = []
  for await (const chunk of h.rt.hermesRemote.adapter.stream(markAgentLoopRequest({
    provider: 'hermes-remote', model: 'attach', sessionId: 'sample-chat',
    signal: new AbortController().signal, messages: [{ role: 'user', content: 'Sample message' }],
  }))) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  return chunks[0].reason.failure.message
}

const QUOTED = "HERMES_HOME='/srv/sample home' hermes serve"
for (const [code, message] of [
  ['bot/hermes-attach-not-running', `Hermes is not running on the other computer. Start it there with “${QUOTED}”, then try again.`],
  ['bot/hermes-attach-record', `Hermes is not running on the other computer. Start it there with “${QUOTED}”, then try again.`],
  ['bot/hermes-attach-gateway-running', `Hermes is running on the other computer as a gateway, but no “hermes serve” is running. Start “${QUOTED}” there, then try again.`],
  ['bot/hermes-attach-gateway', `Hermes is running there as a gateway that owns its sessions. Start “${QUOTED}” there, then try again.`],
]) {
  test(`#1404 a turn on a saved Bot whose serve is stopped (${code}) names its own start line`, async t => {
    const h = runtime(t, {}, code)
    const said = await turn(h)
    assert.equal(said, message)
    assert.doesNotMatch(said, /[Rr]econcile/)
    assert.equal(h.sshCalls.length, 1)
  })
}

test('#1404 a saved Bot without a saved home is told the plain start line', async t => {
  const h = runtime(t, { ssh: { host: 'sample-box' } }, 'bot/hermes-attach-not-running')
  assert.equal(await turn(h), 'Hermes is not running on the other computer. Start it there with “hermes serve”, then try again.')
})

test('#1404 connect keeps the attach code its screen maps, and the saved extra homes reach attach', async t => {
  const h = runtime(t, { extraHomes: ['/srv/sample home', '/srv/second'] }, 'bot/hermes-attach-not-running')
  await assert.rejects(h.endpoints.get('hermes-remote-connect')({}), error => error.code === 'bot/hermes-attach-not-running')
  assert.deepEqual(h.sshCalls[0].options.extraHomes, ['/srv/sample home', '/srv/second'])
})

// ------------------------------------------- items 3 and 5: the record folder's own home

async function attachWorld(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hermes-1404-attach-')))
  const tokens = new Set()
  const server = createHttpServer((request, response) => {
    const offered = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (request.url !== '/api/host/identity' || !tokens.has(offered)) { response.writeHead(401); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, role: 'serve', pid: process.pid, protocolVersion: 1 }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const spec = { homes: {} }
  const hermes = join(root, 'hermes')
  await writeFile(hermes, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
spec = json.load(open(os.environ["FAKE_HERMES_SPEC"]))
ids = spec["homes"].get(os.environ.get("HERMES_HOME", ""), ["default"])
if args == ["--version"]:
    print("Hermes Agent v0.23.1")
elif args == ["profile", "list"]:
    print("")
    print(" Profile          Model                        Gateway      Alias        Distribution")
    print(" ---------------- ---------------------------- ------------ ------------ --------------------")
    for ident in ids:
        print("  Sample (%s) sample/model running %s -" % (ident, ident))
    print("")
elif args[:2] == ["profile", "show"]:
    print("Profile: Sample (%s)" % args[2])
    print("Model:   sample/model (acme)")
    print("Gateway: running")
elif args[:1] == ["-p"] and args[-1:] == ["--json"]:
    print(json.dumps({"default": "sample/model", "provider": "acme"}))
else:
    sys.exit(1)
`, { mode: 0o755 })
  await chmod(hermes, 0o755)
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const world = {
    root, spec, hermes, account: join(root, 'state', 'hermes', 'gateway-locks'),
    async home(path, { config = true, soul = true, profiles = ['default'] } = {}) {
      await mkdir(path, { recursive: true })
      if (config) await writeFile(join(path, 'config.yaml'), 'model: sample/model\n')
      if (soul) await writeFile(join(path, 'SOUL.md'), '# Sample\n')
      spec.homes[path] = profiles
      return path
    },
    async serve(folder, { home = '', profiles = ['default'], pid = process.pid } = {}) {
      await mkdir(folder, { recursive: true })
      const value = randomBytes(24).toString('hex')
      tokens.add(value)
      await writeFile(join(folder, 'host-serve.json'), JSON.stringify({ role: 'serve', port, pid, protocolVersion: 1, home, profiles, tokenFingerprint: createHash('sha256').update(value).digest('hex').slice(0, 16) }))
      await writeFile(join(folder, 'host-serve.token'), value, { mode: 0o600 })
      await chmod(join(folder, 'host-serve.token'), 0o600)
      return value
    },
    run({ hermesHome = '', stateDir = '', extraHomes = [], envHermesHome = '', gatewayLockDir = '' } = {}) {
      return new Promise((resolve, reject) => {
        const proc = spawnChild('python3', ['-u', '-c', attachSupervisor], {
          env: { ...process.env, HOME: root, HERMES_HOME: envHermesHome, HERMES_GATEWAY_LOCK_DIR: gatewayLockDir, XDG_STATE_HOME: join(root, 'state'), FAKE_HERMES_SPEC: join(root, 'spec.json') },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let out = '', err = ''
        proc.on('error', reject)
        proc.stdout.on('data', data => { out += String(data) })
        proc.stderr.on('data', data => { err += String(data) })
        proc.on('close', () => {
          try {
            const frames = out.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
            resolve({ frames, raw: out, err, token: frames.find(frame => frame.type === 'token')?.value, error: frames.find(frame => frame.type === 'error')?.code })
          } catch (error) { reject(new Error(`${error.message}: ${out} ${err}`)) }
        })
        writeFile(join(root, 'spec.json'), JSON.stringify(spec)).then(() => {
          proc.stdin.write(`${JSON.stringify({ nonce: randomBytes(8).toString('hex'), hermesPath: hermes, hermesHome, stateDir, extraHomes, minVersion: HERMES_MINIMUM, startMs: 20000, controlMs: 8000 })}\n`)
          proc.stdin.end()
        }, reject)
      })
    },
  }
  return world
}
const refused = (result, ...tokens) => {
  assert.equal(result.error, 'serve-record', JSON.stringify(result.frames))
  assert.equal(result.token, undefined, 'no token frame')
  for (const value of tokens) assert.ok(!result.raw.includes(value), 'the other serve’s token never leaves')
}

test('#1404 a clone picked with the default home’s account folder is refused before any token is read', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const primary = await w.home(join(w.root, '.hermes'))
  const clone = await w.home(join(w.root, 'clone'))
  const accountToken = await w.serve(w.account)
  refused(await w.run({ hermesHome: clone, stateDir: w.account, extraHomes: [clone] }), accountToken)
  const own = await w.run({ hermesHome: primary, stateDir: w.account, extraHomes: [clone] })
  assert.equal(own.error, undefined, JSON.stringify(own.frames))
  assert.equal(own.token, accountToken, 'the default home keeps its own nameless account record')
})

test('#1404 an account record that names the clone is the clone’s pick only', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const primary = await w.home(join(w.root, '.hermes'))
  const clone = await w.home(join(w.root, 'clone'))
  const accountToken = await w.serve(w.account, { home: clone })
  assert.equal((await w.run({ hermesHome: clone, stateDir: w.account, extraHomes: [clone] })).token, accountToken)
  refused(await w.run({ hermesHome: primary, stateDir: w.account, extraHomes: [clone] }), accountToken)
})

test('#1404 with no default home, a nameless record two homes could serve belongs to neither', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const first = await w.home(join(w.root, 'first'))
  const second = await w.home(join(w.root, 'second'))
  const accountToken = await w.serve(w.account)
  refused(await w.run({ hermesHome: first, stateDir: w.account, extraHomes: [first, second] }), accountToken)
  refused(await w.run({ hermesHome: second, stateDir: w.account, extraHomes: [first, second] }), accountToken)
})

test('#1404 a default home with its own serve leaves a profile-matched account record to the clone', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const primary = await w.home(join(w.root, '.hermes'), { profiles: ['default'] })
  const clone = await w.home(join(w.root, 'clone'), { profiles: ['default', 'workshop'] })
  await w.serve(join(primary, 'gateway-locks'), { pid: process.pid + 100000 })
  const accountToken = await w.serve(w.account, { profiles: ['workshop'] })
  const picked = await w.run({ hermesHome: clone, stateDir: w.account, extraHomes: [clone] })
  assert.equal(picked.error, undefined, JSON.stringify(picked.frames))
  assert.equal(picked.token, accountToken)
  refused(await w.run({ hermesHome: primary, stateDir: w.account, extraHomes: [clone] }), accountToken)
})

test('#1404 a conventional record folder that is a link to another disk is still the home’s own', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  await w.home(join(w.root, '.hermes'))
  const clone = await w.home(join(w.root, 'clone'))
  const elsewhere = join(w.root, 'other-disk', 'locks')
  const own = await w.serve(elsewhere)
  await symlink(elsewhere, join(clone, 'gateway-locks'))
  const picked = await w.run({ hermesHome: clone, stateDir: join(clone, 'gateway-locks'), extraHomes: [clone] })
  assert.equal(picked.error, undefined, JSON.stringify(picked.frames))
  assert.equal(picked.token, own)
})

test('#1404 a record folder inside another home is never the picked home’s', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const primary = await w.home(join(w.root, '.hermes'))
  const clone = await w.home(join(w.root, 'clone'))
  const primaryToken = await w.serve(join(primary, 'sandbox', 'locks'))
  refused(await w.run({ hermesHome: clone, stateDir: join(primary, 'sandbox', 'locks'), extraHomes: [clone] }), primaryToken)
})

test('#1404 two config-only homes sharing one folder: attach refuses both, picked or saved before', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const first = await w.home(join(w.root, 'pair', 'first'), { soul: false })
  const second = await w.home(join(w.root, 'pair', 'second'), { soul: false })
  const beside = join(w.root, 'pair', 'gateway-locks')
  const shared = await w.serve(beside)
  for (const picked of [first, second]) {
    refused(await w.run({ hermesHome: picked, stateDir: beside, extraHomes: [first, second] }), shared)
    const saved = await w.run({ hermesHome: picked, extraHomes: [first, second] })
    assert.equal(saved.token, undefined, 'a pick without a record folder never takes the shared one')
    assert.ok(!saved.raw.includes(shared))
  }
})

test('#1404 a config-only home beside a record-only home is refused too', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const first = await w.home(join(w.root, 'mixed', 'first'), { soul: false })
  const second = join(w.root, 'mixed', 'second')
  await w.serve(join(second, 'sandbox', 'locks'))
  const beside = join(w.root, 'mixed', 'gateway-locks')
  const shared = await w.serve(beside)
  refused(await w.run({ hermesHome: first, stateDir: beside, extraHomes: [first, second] }), shared)
  assert.equal((await w.run({ hermesHome: first, extraHomes: [first, second] })).token, undefined)
})

test('#1404 a lone config-only home and a marked home beside another app’s settings still attach', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await attachWorld(t)
  const lone = await w.home(join(w.root, 'solo', 'hermes'), { soul: false })
  const loneToken = await w.serve(join(w.root, 'solo', 'gateway-locks'))
  assert.equal((await w.run({ hermesHome: lone, stateDir: join(w.root, 'solo', 'gateway-locks'), extraHomes: [lone] })).token, loneToken)
  const marked = await w.home(join(w.root, 'marked', 'hermes'))
  await mkdir(join(w.root, 'marked', 'other-app'), { recursive: true })
  await writeFile(join(w.root, 'marked', 'other-app', 'config.yaml'), 'theme: dark\n')
  const markedToken = await w.serve(join(w.root, 'marked', 'gateway-locks'))
  assert.equal((await w.run({ hermesHome: marked, stateDir: join(w.root, 'marked', 'gateway-locks'), extraHomes: [marked] })).token, markedToken)
  assert.equal((await w.run({ hermesHome: marked, extraHomes: [marked] })).token, markedToken, 'and without a record folder')
})

// ---------------------------------------------------------- item 4: the detected start line

async function readerWorld(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hermes-1404-detect-')))
  const closed = createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve))
  const port = closed.address().port; await new Promise(resolve => closed.close(resolve))
  const hermes = join(root, 'hermes')
  await writeFile(hermes, `#!/usr/bin/env python3
import sys
args = sys.argv[1:]
if args == ["profile", "list"]:
    print("")
    print(" Profile          Model                        Gateway      Alias        Distribution")
    print(" ---------------- ---------------------------- ------------ ------------ --------------------")
    print("  Sample (default) sample/model stopped default -")
    print("")
    sys.exit(0)
if args == ["serve", "--status"]:
    print("No hermes dashboard or serve processes running.")
    sys.exit(0)
sys.exit(2)
`, { mode: 0o755 })
  await chmod(hermes, 0o755)
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const make = async path => { await mkdir(path, { recursive: true }); await writeFile(join(path, 'config.yaml'), 'model: sample/model\n'); await writeFile(join(path, 'SOUL.md'), '# Sample\n'); return path }
  // A leftover record: its process is gone and nothing listens on its port.
  const leftover = async folder => { await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'host-serve.json'), JSON.stringify({ role: 'serve', pid: 2 ** 22 + 12345, port, profiles: ['default'], home: '' })) }
  const run = ({ envHermesHome = '', ...handshake } = {}) => new Promise((resolve, reject) => {
    const proc = spawnChild('python3', ['-u', '-c', detectSupervisor], {
      env: { ...process.env, HOME: root, HERMES_HOME: envHermesHome, HERMES_GATEWAY_LOCK_DIR: '', XDG_STATE_HOME: join(root, 'state') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    proc.on('error', reject)
    proc.stdout.on('data', data => { out += String(data) })
    proc.on('close', () => resolve(out.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(frame => frame.type === 'bot')))
    proc.stdin.write(`${JSON.stringify({ nonce: randomBytes(8).toString('hex'), hermesPath: hermes, startMs: 20000, controlMs: 8000, ...handshake })}\n`)
    proc.stdin.end()
  })
  return { root, make, leftover, run }
}

test('#1404 a stopped clone with a leftover record is told a start line for its own home', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await readerWorld(t)
  await w.make(join(w.root, '.hermes'))
  const clone = await w.make(join(w.root, '.local', 'share', 'clone', 'hermes'))
  await w.leftover(join(clone, 'gateway-locks'))
  const bots = await w.run()
  const row = bots.find(bot => bot.home === clone)
  assert.equal(row.running, false)
  assert.equal(row.start, `HERMES_HOME=${clone} hermes --profile default serve`)
  assert.equal(bots.find(bot => bot.home === join(w.root, '.hermes')).start, 'hermes serve', 'the default home’s line is unchanged')
})

test('#1404 when the login names another default home, ~/.hermes is started by its own path', async t => {
  if (!await hasPython()) { t.skip('python3 is not available'); return }
  const w = await readerWorld(t)
  const account = await w.make(join(w.root, '.hermes'))
  const team = await w.make(join(w.root, 'team'))
  await w.leftover(join(account, 'gateway-locks'))
  const bots = await w.run({ envHermesHome: team })
  assert.equal(bots.find(bot => bot.home === account).start, `HERMES_HOME=${account} hermes --profile default serve`)
  assert.equal(bots.find(bot => bot.home === team).start, 'hermes serve', 'the login’s own default needs no HERMES_HOME')
})

// --------------------------------------- #1383: the look-alike folders a blocked bot names
test('#1383 a blocked bot keeps the folders it names; a bot that is not blocked keeps none', async () => {
  const ssh = fakeSsh([
    { type: 'home', home, state: 'stopped', sandbox: false, blocked: 'shared-beside', serve: null },
    { type: 'home', home: '/srv/other-hermes', state: 'stopped', sandbox: false, serve: null },
    { type: 'bot', home, id: 'default', name: 'Sample', model: '', provider: '', running: false, recordDir: '', port: 0, blocked: 'shared-beside', besides: ['/srv/other-tool'], start: 'hermes serve' },
    { type: 'bot', home: '/srv/other-hermes', id: 'default', name: 'Other', model: '', provider: '', running: false, recordDir: '', port: 0, besides: ['/srv/other-tool'], start: 'hermes serve' },
    { type: 'ready', homes: 2, bots: 2, hermes: true },
  ])
  const found = await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn })
  assert.deepEqual(found.bots.map(row => [row.home, row.blocked, row.besides]), [[home, 'shared-beside', ['/srv/other-tool']], ['/srv/other-hermes', '', undefined]])
  assert.ok(!('besides' in found.homes[0]), 'home entries do not carry the folders')
})

test('#1383 one bad folder drops the whole list, never the row or its block', async () => {
  for (const besides of [['/srv/a-tool', 'relative/tool'], ['/srv/a-tool', '/srv/bad\ntool'], ['/srv/a-tool', '/srv/a-tool'], ['/a', '/b', '/c', '/d', '/e'], [], '/srv/a-tool', ['/srv/a-tool', 7]]) {
    const ssh = fakeSsh([
      { type: 'home', home, state: 'stopped', sandbox: false, blocked: 'shared-beside', serve: null },
      { type: 'bot', home, id: 'default', name: 'Sample', model: '', provider: '', running: false, recordDir: '', port: 0, blocked: 'shared-beside', besides, start: 'hermes serve' },
      { type: 'ready', homes: 1, bots: 1, hermes: true },
    ])
    const found = await detectHermesBots({ host: 'example.invalid' }, { spawn: ssh.spawn })
    assert.equal(found.bots.length, 1, JSON.stringify(besides))
    assert.equal(found.bots[0].blocked, 'shared-beside')
    assert.ok(!('besides' in found.bots[0]), JSON.stringify(besides))
  }
})
