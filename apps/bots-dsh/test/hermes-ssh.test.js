import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile, rm, access } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter, dirname } from 'node:path'
import { test } from 'node:test'
import { HERMES_MINIMUM, redactSshText, startHermesSsh, trustHermesSshHostKey } from '../src/host/hermes-ssh.js'

// A sample host key: random bytes in a public key's wire shape, never a real key.
const sampleKey = () => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), randomBytes(32)]).toString('base64')
const fingerprintOf = blob => `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`

async function fixture(t, scenario = 'ready') {
  const home = await mkdtemp(join(tmpdir(), 'hermes-ssh-'))
  const executable = join(home, 'ssh'), record = join(home, 'record.jsonl')
  const script = await readFile(new URL('./fixtures/hermes-fake-ssh.mjs', import.meta.url), 'utf8')
  await writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 })
  const credential = randomBytes(32).toString('hex')
  const remotePort = randomInt(1024, 65536), localPort = randomInt(1024, 65536)
  const config = { host: `${randomUUID()}.invalid`, user: `sample-${randomUUID()}`, port: randomInt(1024, 65536), identityFile: join(home, randomUUID()), hermesPath: `/sample/${randomUUID()}/hermes` }
  // HOME is the test's own folder: the start script and the trust step write under it only.
  const hostKey = sampleKey(), knownHosts = join(home, '.ssh', 'known_hosts')
  // Two clocks meet at close. This computer stops the start script after 0.8 of the cancel
  // deadline it keeps; the script's own stop budget (its grace alone 0.4) comes from the
  // cancel it is handed. The fake SSH runs the real start script for the runtime scenarios
  // only. With both the same short deadline, a loaded computer killed the script before its
  // closed frame and reported a cleanup it could not confirm (#1223). So keep this
  // computer's deadline long for those scenarios and hand the script a short one on its way
  // to stdin, far inside it: its closed frame is then read before close() judges.
  // The handoff is per start script: every real-start open gets it, and handed() is the
  // last one while handoffs() counts them. A test that keeps a cancel of its own only
  // moves this computer's wait; the start script is still handed the short cancel.
  const realStart = scenario.startsWith('runtime-'), scriptCancelMs = 300
  const deadlines = { start: 5000, control: 3000, cancel: realStart ? 2000 : 250 }
  let handed, handoffs = 0
  const handShortCancel = spawn => (...args) => {
    const child = spawn(...args)
    if (!realStart) return child
    let childHanded = false
    const write = child.stdin.write.bind(child.stdin)
    child.stdin.write = (data, ...rest) => {
      if (childHanded || typeof data !== 'string' || !data.startsWith('{')) return write(data, ...rest)
      childHanded = true
      handed = scriptCancelMs
      handoffs++
      return write(`${JSON.stringify({ ...JSON.parse(data), cancelMs: scriptCancelMs })}\n`, ...rest)
    }
    return child
  }
  const options = { env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${home}${delimiter}${process.env.PATH}`, HERMES_SSH_RECORD: record, HERMES_SSH_SCENARIO: scenario, HERMES_SSH_REMOTE_PORT: String(remotePort), HERMES_SSH_HOST_KEY: hostKey, HERMES_SSH_KNOWN_HOSTS: knownHosts }, allocatePort: async () => localPort,
    deadlines, randomBytes: size => size === 32 ? Buffer.from(credential, 'hex') : randomBytes(size) }
  const connections = []
  const records = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const untilRecord = predicate => new Promise((resolve, reject) => {
    let settled = false
    const check = async () => {
      try {
        if (!settled && predicate(await records())) { settled = true; events.close(); resolve() }
      } catch (error) { settled = true; events.close(); reject(error) }
    }
    // Subscribe before the first read, so no record append can fall in a gap.
    const events = watch(home, () => { void check() })
    t.after(() => events.close())
    void check()
  })
  const open = async (ssh = config, overrides = {}) => { const connection = await startHermesSsh(ssh, { ...options, ...overrides, spawn: handShortCancel(overrides.spawn ?? spawnChild) }); connections.push(connection); return connection }
  t.after(async () => { for (const connection of connections) await connection.close().catch(error => error.localClosed); await rm(home, { recursive: true, force: true }) })
  const trust = (expected, overrides = {}) => trustHermesSshHostKey(config, expected, { env: options.env, home, temp: home, deadlines: options.deadlines, ...overrides })
  return { home, config, options, open, trust, credential, localPort, remotePort, records, untilRecord, hostKey, knownHosts, scriptCancelMs, handed: () => handed, handoffs: () => handoffs }
}

test('system ssh respects config/key arguments, enforces known-host key-only auth and tunnels numeric loopback', async t => {
  const f = await fixture(t)
  const connection = await f.open()
  assert.equal(connection.address, `http://127.0.0.1:${f.localPort}`)
  assert.equal(connection.credential, f.credential)
  const records = await f.records(), starts = records.filter(record => record.event === 'spawn')
  assert.equal(starts.length, 2)
  for (const { args } of starts) {
    for (const option of ['BatchMode=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'PreferredAuthentications=publickey', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'ControlMaster=no']) assert.ok(args.includes(option), option)
    assert.equal(args[args.indexOf('-p') + 1], String(f.config.port))
    assert.equal(args[args.indexOf('-i') + 1], f.config.identityFile)
    assert.equal(args[args.indexOf('--') + 1], `${f.config.user}@${f.config.host}`)
    assert.ok(!JSON.stringify(args).includes(f.credential))
  }
  const tunnel = starts.find(record => record.role === 'tunnel')
  assert.equal(tunnel.args[tunnel.args.indexOf('-L') + 1], `127.0.0.1:${f.localPort}:127.0.0.1:${f.remotePort}`)
  // The start connection takes none of the host's own configured forwards; the tunnel
  // cannot clear them without losing its own.
  assert.ok(starts.find(record => record.role === 'supervisor').args.includes('ClearAllForwardings=yes'))
  assert.ok(!tunnel.args.includes('ClearAllForwardings=yes'))
  assert.ok(starts.find(record => record.role === 'supervisor').args.at(-1).startsWith('exec python3 -u -c '))
  assert.equal(records.find(record => record.event === 'input').hermesPath, f.config.hermesPath)
  assert.ok(!JSON.stringify(records).includes(f.credential))
  await assert.rejects(access(f.config.identityFile)) // It was passed to ssh, never read/copied by DSH.
  const closing = connection.close()
  assert.equal(connection.close(), closing)
  await closing
  const ended = (await f.records()).filter(record => record.event === 'closed')
  assert.deepEqual(ended.map(record => record.role).sort(), ['supervisor', 'tunnel'])
})

test('SSH aliases and blank optional fields retain system configuration and remote executable autodetection', async t => {
  const f = await fixture(t)
  const alias = `sample-${randomUUID()}`
  await f.open({ host: alias })
  const records = await f.records()
  for (const record of records.filter(record => record.event === 'spawn')) {
    assert.equal(record.args[record.args.indexOf('--') + 1], alias)
    assert.ok(!record.args.includes('-p') && !record.args.includes('-i'))
  }
  assert.equal(records.find(record => record.event === 'input').hermesPath, '')
})

test('unknown/changed host keys and key authentication failures are fixed actionable errors with no raw output', async t => {
  const codes = { 'host-key-unknown': 'bot/hermes-ssh-host-key-unknown', 'host-key-changed': 'bot/hermes-ssh-host-key', 'auth-failed': 'bot/hermes-ssh-auth', 'interactive-auth': 'bot/hermes-ssh-interactive', unreachable: 'bot/hermes-ssh-unreachable', 'unsupported-platform': 'bot/hermes-ssh-platform' }
  for (const [scenario, kind] of [['host-key', 'host-key-unknown'], ['changed-key', 'host-key-changed'], ['auth', 'auth-failed'], ['auth-delayed', 'auth-failed'], ['interactive', 'interactive-auth'], ['unreachable', 'unreachable'], ['python-missing', 'unsupported-platform']]) {
    const f = await fixture(t, scenario)
    let failure
    await assert.rejects(f.open(), error => { failure = error; return error.code === codes[kind] && error.sshError === kind && !error.stack.includes(f.config.host) && !error.stack.includes(f.config.identityFile) && !error.stack.includes(f.credential) })
    assert.equal(failure.sshStage, 'ssh-sign-in', scenario)
    assert.ok(!failure.cleanupUnknown, `${scenario}: no start script ran, so no cleanup is owed`)
    assert.equal((await f.records()).filter(record => record.event === 'spawn').length, 1)
    // A new host's key is named for the trust step; a changed key never is.
    if (scenario === 'host-key') assert.deepEqual({ keyType: failure.sshDetail.keyType, fingerprint: failure.sshDetail.fingerprint }, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(f.hostKey) })
    else assert.ok(!failure.sshDetail?.fingerprint && !failure.sshDetail?.keyType, scenario)
    // The identity files SSH offered, by name only; a key from the agent is only counted.
    if (kind === 'auth-failed') assert.deepEqual({ identities: failure.sshDetail.identities, agentKeys: failure.sshDetail.agentKeys }, { identities: ['id_sample', 'id_other'], agentKeys: 1 })
    assert.ok(!JSON.stringify(failure.sshDetail ?? {}).includes('/sample/home'), 'no path of an identity file is kept')
  }
})

test('the start script is the only source of its kinds: a remote cannot claim a host-key verdict', async t => {
  const f = await fixture(t, 'frame-host-key')
  await assert.rejects(f.open(), error => error.code === 'bot/hermes-ssh-handshake' && error.sshError === 'handshake' && !error.sshDetail?.fingerprint)
})

test('missing Hermes and unsupported ownership flags stop before a tunnel and clean the supervisor', async t => {
  for (const [scenario, kind] of [['missing', 'hermes-not-found'], ['old-contract', 'update-required']]) {
    const f = await fixture(t, scenario)
    await assert.rejects(f.open(), error => error.code === (kind === 'hermes-not-found' ? 'bot/hermes-ssh-missing' : 'bot/hermes-ssh-update') && error.sshError === kind && !error.cleanupUnknown)
    assert.equal((await f.records()).filter(record => record.event === 'spawn').length, 1)
    assert.equal((await f.records()).at(-1).event, 'closed')
  }
})

test('startup timeout is bounded and failed forwarding closes the remote supervisor without uncertain retries', async t => {
  const f = await fixture(t, 'timeout')
  // Long enough for the fake ssh to start and write its record on a busy computer: it is
  // read below, and a start deadline of a few frames would end before the process exists.
  await assert.rejects(f.open(undefined, { deadlines: { start: 1000, control: 3000, cancel: 1000 } }), error => error.sshError === 'timeout' && error.code === 'bot/hermes-ssh-timeout')
  assert.equal((await f.records()).filter(record => record.event === 'spawn').length, 1)
  const broken = await fixture(t, 'tunnel-failure')
  await assert.rejects(broken.open(), error => error.code === 'bot/hermes-ssh-tunnel' && error.sshError === 'tunnel' && error.sshStage === 'tunnel' && !error.cleanupUnknown)
  assert.ok((await broken.records()).some(record => record.role === 'supervisor' && record.event === 'closed'))
})

test('abort before startup creates no process; abort of an active connection closes supervisor and tunnel', async t => {
  const f = await fixture(t)
  const before = new AbortController(); before.abort()
  await assert.rejects(f.open(undefined, { signal: before.signal }), /cancelled/)
  const active = new AbortController()
  const connection = await f.open(undefined, { signal: active.signal })
  active.abort()
  await connection.close()
  assert.deepEqual((await f.records()).filter(record => record.event === 'closed').map(record => record.role).sort(), ['supervisor', 'tunnel'])
})

test('abort interrupts a pending port allocation instead of waiting for a control deadline', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const pending = f.open(undefined, { signal: controller.signal, allocatePort: () => { controller.abort(); return new Promise(() => {}) } })
  await assert.rejects(pending, /cancelled/)
  assert.equal((await f.records()).filter(record => record.event === 'spawn').length, 1)
  assert.equal((await f.records()).at(-1).event, 'closed')
})

test('malformed supervisor records are bounded and never leak transient credentials', async t => {
  for (const scenario of ['wrong-nonce', 'bad-frame', 'oversized']) {
    const f = await fixture(t, scenario)
    await assert.rejects(f.open(), error => error.code === 'bot/hermes-ssh-handshake' && error.sshError === 'handshake' && !error.stack.includes(f.credential) && !error.stack.includes(f.config.host) && !JSON.stringify(error.sshDetail ?? {}).includes(f.credential))
    assert.ok(!JSON.stringify(await f.records()).includes(f.credential))
  }
})

test('close reports unconfirmed remote cleanup and still terminates local children within the grace', async t => {
  const f = await fixture(t, 'ignore-close')
  const connection = await f.open()
  const starts = (await f.records()).filter(record => record.event === 'spawn')
  let unknown
  await assert.rejects(connection.close(), error => { unknown = error; return error.cleanupUnknown && /could not be confirmed|background remote work may continue/.test(error.message) && !error.message.includes(f.credential) })
  await unknown.localClosed
  for (const { pid } of starts) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('invalid SSH fields are rejected before any executable can be started', async () => {
  let spawned = false
  for (const ssh of [{ host: '-option' }, { host: 'sample;command' }, { host: 'sample', user: '-option' }, { host: 'sample', port: '1;command' }, { host: 'sample', identityFile: '-option' }, { host: 'sample', hermesPath: 'sample\ncommand' }]) {
    await assert.rejects(startHermesSsh(ssh, { spawn: () => { spawned = true } }), error => error.code === 'bot/hermes-ssh-details' && error.sshError === 'invalid-details' && error.sshStage === 'details')
  }
  assert.equal(spawned, false)
})

async function fakeRuntime(f) {
  const executable = join(f.home, randomUUID())
  await writeFile(executable, `#!${process.execPath}\n${await readFile(new URL('./fixtures/hermes-fake-runtime.mjs', import.meta.url), 'utf8')}`, { mode: 0o700 })
  return executable
}

test('explicit Hermes home owns the token and backend, without inheriting another profile', async t => {
  const f = await fixture(t, 'runtime-ready')
  const hermesPath = await fakeRuntime(f)
  const hermesHome = join(f.home, 'separate-agent')
  await (await import('node:fs/promises')).mkdir(hermesHome)
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n')
  const connection = await f.open({ ...f.config, hermesPath, hermesHome })
  try {
    const runtime = (await f.records()).find(record => record.event === 'runtime-start')
    assert.equal(runtime.home, hermesHome)
    assert.equal(runtime.profile, undefined)
    assert.deepEqual(runtime.args.slice(0, 3), ['--profile', 'default', 'serve'])
    assert.ok(runtime.args[runtime.args.indexOf('--ssh-session-token-file') + 1].startsWith(join(hermesHome, 'desktop-ssh')))
  } finally { await connection.close() }
})

async function waitFor(predicate) {
  const until = Date.now() + 5000
  while (!(await predicate())) {
    assert.ok(Date.now() < until, 'fake child did not reach its expected lifecycle state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('our remote supervisor runs only the fake Hermes, sends the token through a private file, and stops its owned child', async t => {
  const f = await fixture(t, 'runtime-ready')
  const hermesPath = await fakeRuntime(f)
  const connection = await f.open({ ...f.config, hermesPath })
  const runtime = (await f.records()).find(record => record.event === 'runtime-start')
  assert.ok(runtime)
  for (const flag of ['serve', '--isolated', '--host', '--port', '--ssh-session-token-file', '--ssh-owner-nonce']) assert.ok(runtime.args.includes(flag))
  assert.equal(runtime.args[runtime.args.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(runtime.args[runtime.args.indexOf('--port') + 1], '0')
  assert.equal(runtime.tokenMode, 0o600)
  // Where Hermes itself requires its token: ~/.hermes/desktop-ssh/<32 hex>/<nonce>.token,
  // the folder private. Any other path makes serve exit before it is ready.
  const tokenPath = runtime.args[runtime.args.indexOf('--ssh-session-token-file') + 1], nonce = runtime.args[runtime.args.indexOf('--ssh-owner-nonce') + 1]
  assert.match(tokenPath.slice(join(f.home, '.hermes', 'desktop-ssh').length), /^\/[0-9a-f]{32}\/[0-9a-f]{16}\.token$/)
  assert.ok(tokenPath.startsWith(join(f.home, '.hermes', 'desktop-ssh')) && tokenPath.endsWith(`/${nonce}.token`))
  assert.equal(runtime.folderMode, 0o700)
  assert.equal(runtime.tokenHash, (await import('node:crypto')).createHash('sha256').update(f.credential).digest('hex'))
  assert.ok(!JSON.stringify(await f.records()).includes(f.credential))
  await connection.close()
  assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' })
  assert.ok((await f.records()).some(record => record.event === 'runtime-stop'))
  await assert.rejects(access(tokenPath))
  assert.deepEqual(await readdir(join(f.home, '.hermes', 'desktop-ssh')), [], 'the token folder goes with the start script')
})

test('our supervisor checks actual fake capability output before starting a child', async t => {
  const f = await fixture(t, 'runtime-old')
  const hermesPath = await fakeRuntime(f)
  await assert.rejects(f.open({ ...f.config, hermesPath }), error => error.sshError === 'update-required' && error.code === 'bot/hermes-ssh-update' && !error.cleanupUnknown)
  assert.ok(!(await f.records()).some(record => record.event === 'runtime-start'))
})

// The release just under one: the last patch before it, or the last one of the minor before.
const below = release => { const [major, minor, patch] = release.split('.').map(Number); return patch ? `${major}.${minor}.${patch - 1}` : minor ? `${major}.${minor - 1}.9999` : `${major - 1}.9999.9999` }
const versioned = (f, values) => ({ env: { ...f.options.env, ...values } })

test('an older Hermes is refused before serve, with the release it reported, the minimum and its install kind', async t => {
  assert.match(HERMES_MINIMUM, /^\d+\.\d+\.\d+$/, 'the contract file names the minimum release')
  assert.equal(JSON.parse(await readFile(new URL('../src/host/hermes-contract.json', import.meta.url), 'utf8')).minimumRelease, HERMES_MINIMUM, 'one place holds it')
  // Numbers, not text: 0.9.30 sorts after 0.21.5 as a string and is still older.
  const [major, minor] = HERMES_MINIMUM.split('.').map(Number)
  for (const [older, install] of [[below(HERMES_MINIMUM), 'git'], [minor > 9 ? `${major}.9.30` : `${major - 1}.30.30`, 'docker']]) {
    const f = await fixture(t, 'runtime-ready')
    const hermesPath = await fakeRuntime(f)
    let refusal
    await assert.rejects(f.open({ ...f.config, hermesPath }, versioned(f, { HERMES_FAKE_VERSION: older, HERMES_FAKE_INSTALL: install })), error => { refusal = error; return true })
    assert.deepEqual({ kind: refusal.sshError, code: refusal.code, stage: refusal.sshStage, cleanupUnknown: refusal.cleanupUnknown }, { kind: 'update-required', code: 'bot/hermes-ssh-update', stage: 'remote-start', cleanupUnknown: undefined })
    assert.deepEqual({ version: refusal.sshDetail.version, minimum: refusal.sshDetail.minimum, install: refusal.sshDetail.install }, { version: older, minimum: HERMES_MINIMUM, install })
    assert.match(refusal.message, new RegExp(`to v${HERMES_MINIMUM.replaceAll('.', '\\.')} or newer`))
    const records = await f.records()
    assert.deepEqual(records.filter(record => record.role === 'runtime').map(record => record.event), ['version'], 'asked for its version, then nothing: no capability probe, no serve')
    await assert.rejects(access(join(f.home, '.hermes', 'desktop-ssh')), 'no token was written')
  }
})

test('the minimum release itself is accepted, and so is a build past it', async t => {
  const [major, minor] = HERMES_MINIMUM.split('.').map(Number)
  for (const values of [{ HERMES_FAKE_VERSION: HERMES_MINIMUM }, { HERMES_FAKE_VERSION: `${major}.${minor + 79}.0` },
    // A source checkout past a release, as upstream prints it, and an install that names no kind.
    { HERMES_FAKE_VERSION_LINE: `Hermes Agent v${HERMES_MINIMUM}+1935.g0a1b2c3 (2026.9.24) · stable · local 0a1b2c3d4e5f`, HERMES_FAKE_INSTALL: '' }]) {
    const f = await fixture(t, 'runtime-ready')
    const hermesPath = await fakeRuntime(f)
    const connection = await f.open({ ...f.config, hermesPath }, versioned(f, values))
    assert.deepEqual((await f.records()).filter(record => record.role === 'runtime').map(record => record.event), ['version', 'probe', 'runtime-start'], JSON.stringify(values))
    await connection.close()
  }
})

test('a version that names no release is reported as it is, not guessed', async t => {
  for (const [line, shown] of [
    ['Hermes Agent vgit.0a1b2c3 (2026.9.24) · upstream 0a1b2c3d', ['Hermes Agent vgit.0a1b2c3 (2026.9.24) · upstream 0a1b2c3d']],
    ['Hermes Agent vunknown', ['Hermes Agent vunknown']],
    // Half a release is not a release; neither is one inside another word.
    [`Hermes Agent v${HERMES_MINIMUM.split('.').slice(0, 2).join('.')}`, [`Hermes Agent v${HERMES_MINIMUM.split('.').slice(0, 2).join('.')}`]],
    [`Sample tool 999.0.0`, ['Sample tool 999.0.0']],
    // No first line at all: what it did print is shown, with the home folder by its short name.
    ['', ['Install directory: ~/.hermes/hermes-agent']],
  ]) {
    const f = await fixture(t, 'runtime-ready')
    const hermesPath = await fakeRuntime(f)
    let refusal
    await assert.rejects(f.open({ ...f.config, hermesPath }, versioned(f, { HERMES_FAKE_VERSION_LINE: line })), error => { refusal = error; return true })
    assert.deepEqual({ kind: refusal.sshError, code: refusal.code, stage: refusal.sshStage }, { kind: 'version-unknown', code: 'bot/hermes-ssh-version', stage: 'remote-start' }, line)
    assert.deepEqual({ version: refusal.sshDetail.version, minimum: refusal.sshDetail.minimum, install: refusal.sshDetail.install, hermes: refusal.sshDetail.hermes }, { version: undefined, minimum: HERMES_MINIMUM, install: 'git', hermes: shown }, line)
    assert.ok(!(await f.records()).some(record => ['probe', 'runtime-start'].includes(record.event)), 'neither taken for new nor started')
  }
})

test('our supervisor bounds the remote lease with heartbeats even when SSH stdin stays open', async t => {
  const f = await fixture(t, 'runtime-ready')
  const hermesPath = await fakeRuntime(f)
  const { spawn } = await import('node:child_process')
  const connection = await f.open({ ...f.config, hermesPath }, { spawn: (...args) => {
    const child = spawn(...args)
    const write = child.stdin.write.bind(child.stdin)
    child.stdin.write = (data, ...rest) => data === 'ping\n' ? true : write(data, ...rest)
    return child
  } })
  await waitFor(async () => (await f.records()).some(record => record.event === 'runtime-stop'))
  await connection.close()
  for (const { pid } of (await f.records()).filter(record => record.event === 'spawn' || record.event === 'runtime-start')) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('the remote supervisor force-stops only its owned fake child when graceful termination expires', async t => {
  const f = await fixture(t, 'runtime-ignore-term')
  const hermesPath = await fakeRuntime(f)
  // Only this computer's stop is short here: the start and the tunnel keep a long
  // deadline, and the fixture still hands the start script its own short cancel.
  const deadlines = { start: 10000, control: 3000, cancel: 1000 }
  const connection = await f.open({ ...f.config, hermesPath }, { deadlines })
  // The 1000 ms kept here is this computer's wait (800 ms); the script's stop budget
  // comes from the 300 ms the fixture hands it (grace 120, cancel 210).
  assert.equal(f.handed(), f.scriptCancelMs, 'the start script was handed the short cancel in place of the one kept here')
  assert.ok(f.scriptCancelMs < deadlines.cancel * 0.8, "the script's clock ends inside the wait this computer keeps")
  const runtime = (await f.records()).find(record => record.event === 'runtime-start')
  await connection.close()
  assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' })
})

test('a missing local ssh executable reports unreachable without claiming a remote cleanup failure', async t => {
  const f = await fixture(t)
  await assert.rejects(f.open(undefined, { sshCommand: join(f.home, randomUUID()) }), error => error.sshError === 'unreachable' && error.code === 'bot/hermes-ssh-unreachable' && !error.cleanupUnknown && !error.message.includes(f.home))
})

test('application exit detaches the private control channel and stops the owned fake server and tunnel', async t => {
  const f = await fixture(t, 'runtime-ready')
  const hermesPath = await fakeRuntime(f)
  const { spawn } = await import('node:child_process')
  const program = `import { startHermesSsh } from ${JSON.stringify(new URL('../src/host/hermes-ssh.js', import.meta.url).href)};
    await startHermesSsh(JSON.parse(process.env.HERMES_SSH_FIXTURE_CONFIG), { env: process.env, allocatePort: async () => Number(process.env.HERMES_SSH_FIXTURE_LOCAL_PORT), deadlines: { start: 10000, control: 3000, cancel: 2000 } });
    process.exit(0);`
  const app = spawn(process.execPath, ['--input-type=module', '-e', program], { env: { ...f.options.env, HERMES_SSH_FIXTURE_CONFIG: JSON.stringify({ ...f.config, hermesPath }), HERMES_SSH_FIXTURE_LOCAL_PORT: String(f.localPort) }, stdio: ['ignore', 'ignore', 'ignore'] })
  const status = await new Promise((resolve, reject) => { app.once('error', reject); app.once('close', resolve) })
  assert.equal(status, 0)
  await waitFor(async () => (await f.records()).some(record => record.event === 'runtime-stop') && (await f.records()).filter(record => record.event === 'closed').length === 2)
  const records = await f.records()
  assert.deepEqual(records.filter(record => record.event === 'closed').map(record => record.role).sort(), ['supervisor', 'tunnel'])
  // The live supervisor reaps its owned server; orphaned SSH clients are reaped by
  // the host after the app exits, so their PID disappearance is not a portable gate.
  assert.throws(() => process.kill(records.find(record => record.event === 'runtime-start').pid, 0), { code: 'ESRCH' })
})


for (const [exitsFirst, withoutWaitid] of [[false, false], [true, false], [true, true]]) {
  test(`owned group cleanup includes a TERM-ignoring descendant when its leader exits ${exitsFirst ? 'before close' : 'on TERM'}${withoutWaitid ? ' without waitid' : ''}`, { timeout: 10000 }, async t => {
    const f = await fixture(t, withoutWaitid ? 'runtime-leader-exits-first-no-waitid' : exitsFirst ? 'runtime-leader-exits-first' : 'runtime-leader-exits-term')
    const hermesPath = await fakeRuntime(f)
    const deadlines = { start: 10000, control: 3000, cancel: 1000 }
    const connection = await f.open({ ...f.config, hermesPath }, { deadlines })
    // The fixture hands this start script 300 ms; the 1000 ms here is only this
    // computer's 800 ms wait for the group to end.
    assert.equal(f.handed(), f.scriptCancelMs, 'the start script was handed the short cancel in place of the one kept here')
    assert.ok(f.scriptCancelMs < deadlines.cancel * 0.8, "the script's clock ends inside the wait this computer keeps")
    const records = await f.records()
    const leader = records.find(record => record.event === 'runtime-start')
    const descendant = records.find(record => record.event === 'descendant-start')
    assert.ok(descendant, 'the fake descendant has installed its TERM refusal before readiness')
    t.after(() => { try { process.kill(descendant.pid, 'SIGKILL') } catch {} })
    if (exitsFirst) {
      process.kill(leader.pid, 'SIGTERM')
      await f.untilRecord(records => records.some(record => record.event === 'runtime-stop'))
    }
    let unknown
    try { await connection.close() } catch (error) { unknown = error }
    if (unknown) {
      assert.equal(unknown.cleanupUnknown, true)
      assert.equal(unknown.code, 'bot/hermes-ssh-cleanup')
      assert.ok(unknown.localClosed instanceof Promise, 'unknown close exposes eventual local reaping')
      await unknown.localClosed
    } else {
      assert.throws(() => process.kill(descendant.pid, 0), { code: 'ESRCH' }, 'a clean verdict proves the whole owned group is gone')
    }
    assert.ok((await f.records()).some(record => record.event === 'descendant-term'), 'TERM targeted the group even after the leader exited')
  })
}

test('an unknown close retains an explicit completion promise until local SSH close events are reaped', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'ignore-close')
  const { spawn } = await import('node:child_process')
  const delivered = []
  let localCount = 0, allClosed
  const closed = new Promise(resolve => { allClosed = resolve })
  const connection = await f.open(undefined, { spawn: (...args) => {
    const child = spawn(...args)
    localCount++
    const on = child.on.bind(child)
    child.on = (event, callback) => event === 'close' ? on(event, (...values) => {
      delivered.push(() => callback(...values))
      if (delivered.length === localCount) allClosed()
    }) : on(event, callback)
    return child
  } })
  const starts = (await f.records()).filter(record => record.event === 'spawn')
  let unknown
  await assert.rejects(connection.close(), error => { unknown = error; return error.cleanupUnknown === true && error.code === 'bot/hermes-ssh-cleanup' })
  assert.ok(unknown.localClosed instanceof Promise, 'the caller can await actual local process reaping after the bounded unknown verdict')
  let completed = false
  void unknown.localClosed.then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  await closed
  for (const release of delivered) release()
  await unknown.localClosed
  for (const { pid } of starts) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})


test('the actual supervisor retains its ownership pin on older Python without waitid', async t => {
  const f = await fixture(t, 'runtime-no-waitid')
  const hermesPath = await fakeRuntime(f)
  const connection = await f.open({ ...f.config, hermesPath })
  const runtime = (await f.records()).find(record => record.event === 'runtime-start')
  await connection.close()
  assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' })
})

test('the actual supervisor refuses an unsupported platform before launching a runtime', async t => {
  const f = await fixture(t, 'runtime-unsupported-platform')
  const hermesPath = await fakeRuntime(f)
  await assert.rejects(f.open({ ...f.config, hermesPath }), error => error.code === 'bot/hermes-ssh-platform' && error.sshError === 'unsupported-platform' && !error.cleanupUnknown)
  assert.ok(!(await f.records()).some(record => record.event === 'runtime-start'))
})

test('the last lines are cleaned before their end is taken: a token the cut falls inside leaves no part of itself', async t => {
  const f = await fixture(t, 'runtime-exit-cut')
  const hermesPath = await fakeRuntime(f)
  let failure
  await assert.rejects(f.open({ ...f.config, hermesPath }), error => { failure = error; return error.code === 'bot/hermes-ssh-exited' })
  assert.match(failure.sshDetail.hermes.join('\n'), /private-output \[hidden\]/, 'the token is hidden where it was whole')
  const kept = JSON.stringify(failure.sshDetail) + failure.stack
  for (let at = 0; at + 6 <= f.credential.length; at++) assert.ok(!kept.includes(f.credential.slice(at, at + 6)), `a part of the token is kept (from ${at})`)
})

test('a Hermes that exits early is its own kind, with its exit code and last lines cleaned', async t => {
  const f = await fixture(t, 'runtime-exit-early')
  const hermesPath = await fakeRuntime(f)
  // The fixture keeps this computer's deadline long here and hands the start script a short
  // cancel, so its closed clean frame is read before close() judges.
  let failure
  await assert.rejects(f.open({ ...f.config, hermesPath }), error => { failure = error; return error.code === 'bot/hermes-ssh-exited' && error.sshError === 'hermes-exited' && !error.cleanupUnknown })
  assert.equal(failure.sshStage, 'hermes-start')
  assert.equal(failure.sshDetail.exit, 3)
  const said = failure.sshDetail.hermes.join('\n')
  assert.match(said, /sample start failure/)
  assert.match(said, /could not read ~\/\.hermes\/config\.yaml/, 'the file is still named, without the home it is in')
  assert.match(said, /sample cache at ~\/\.cache\/sample/, 'the remote script shortens the home it runs in')
  for (const secret of [f.credential, '/home/sample-person', f.home, '\u001b']) assert.ok(!JSON.stringify(failure.sshDetail).includes(secret) && !failure.stack.includes(secret), secret)
  const nonce = (await f.records()).find(record => record.event === 'runtime-start').args.at(-1)
  assert.match(nonce, /^[0-9a-f]{16}$/)
  assert.ok(!JSON.stringify(failure.sshDetail).includes(nonce), 'the owner nonce is not kept either')
  assert.equal((await f.records()).filter(record => record.event === 'spawn').length, 1, 'no tunnel is opened to a Hermes that stopped')
  assert.equal(f.handed(), f.scriptCancelMs, 'the script was handed the short cancel in place of the one kept here')
  assert.ok(f.scriptCancelMs < f.options.deadlines.cancel * 0.8, "the script's clock ends inside the wait this computer keeps")
  assert.equal((await f.records()).at(-1).event, 'closed', 'the start script ended by itself, after its closed frame')
})

test('a Hermes that never says ready, or reports no usable port, is named by the start script', async t => {
  const slow = await fixture(t, 'runtime-never-ready')
  // Two clocks run here. This computer's start deadline counts from the call. The start
  // script's own counts from the moment SSH and Python are up, and is sent a little shorter
  // so that it ends first. With both short, a busy computer spends that little on starting
  // processes, and the bare timeout here wins (seen on CI). So this computer's deadline is
  // long, and the script is handed a short one in place of the one sent: long enough to probe
  // and start the fake Hermes and read its first line, and far from this computer's.
  // The stop window stays the fixture's long one (2000 ms): the script's stop budget is
  // handed 300 ms (grace 120, cancel 210), so 1600 ms leaves it far inside. An own 800 ms
  // left only 640 ms, 340 ms against the hand-off's upper bound: the #1223 shape.
  const deadlines = { start: 20000, control: 5000, cancel: slow.options.deadlines.cancel }, scriptStartMs = 3000
  const { spawn } = await import('node:child_process')
  // Hand the start script a deadline in place of the one sent, and record it: the script's
  // own clock then ends well before this computer's, and the test can say what it was given.
  const clockFor = (field, value) => {
    let handed
    const wrapped = (...args) => {
      const child = spawn(...args)
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = (data, ...rest) => {
        if (handed !== undefined || typeof data !== 'string' || !data.startsWith('{')) return write(data, ...rest)
        handed = value
        return write(`${JSON.stringify({ ...JSON.parse(data), [field]: value })}\n`, ...rest)
      }
      return child
    }
    return { spawn: wrapped, handed: () => handed }
  }
  const startClock = clockFor('startMs', scriptStartMs)
  let failure
  await assert.rejects(slow.open({ ...slow.config, hermesPath: await fakeRuntime(slow) }, { deadlines, spawn: startClock.spawn }), error => { failure = error; return error.code === 'bot/hermes-ssh-not-ready' && error.sshError === 'not-ready' })
  assert.equal(failure.sshStage, 'hermes-start')
  // What was really handed over: a deadline for the script that ends before this computer's.
  assert.equal(startClock.handed(), scriptStartMs, 'the start script was handed the short deadline')
  assert.ok(scriptStartMs < deadlines.start, "the script's deadline ends inside this computer's")
  assert.equal(slow.handed(), slow.scriptCancelMs, 'the fixture handed the short cancel through this test’s own wrapper')
  assert.ok(slow.scriptCancelMs < deadlines.cancel * 0.8, "the script's clock ends inside the wait this computer keeps")
  assert.equal(deadlines.cancel, slow.options.deadlines.cancel, "the stop window is the fixture's long one, not an own shorter cancel")
  assert.match(failure.sshDetail.hermes.join('\n'), /sample server still loading/)
  assert.ok(!JSON.stringify(failure.sshDetail).includes(slow.credential))
  const started = (await slow.records()).find(record => record.event === 'runtime-start')
  assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' }, 'the Hermes that was not ready is stopped')

  const port = await fixture(t, 'runtime-bad-port')
  // The port half starts a full fake runtime before it reads the bad port. Keep the
  // 10000/5000 start and control windows this half had before #1245, so a loaded computer
  // reports the port rather than a bare start timeout; the stop window and the script's
  // short cancel stay the fixture's.
  const portDeadlines = { ...port.options.deadlines, start: 10000, control: 5000 }
  let portHandshake
  const portSpawn = (...args) => {
    const child = spawnChild(...args)
    const write = child.stdin.write.bind(child.stdin)
    child.stdin.write = (data, ...rest) => {
      if (portHandshake !== undefined || typeof data !== 'string' || !data.startsWith('{')) return write(data, ...rest)
      portHandshake = JSON.parse(data)
      return write(data, ...rest)
    }
    return child
  }
  await assert.rejects(port.open({ ...port.config, hermesPath: await fakeRuntime(port) }, { deadlines: portDeadlines, spawn: portSpawn }), error => error.code === 'bot/hermes-ssh-port' && error.sshError === 'port-missing' && error.sshStage === 'hermes-start' && !error.cleanupUnknown)
  assert.equal((await port.records()).filter(record => record.event === 'spawn').length, 1)
  assert.ok(portHandshake.startMs > 5000, `the start script keeps a start clock wider than the fixture default (${portHandshake.startMs} ms)`)
  assert.equal(portHandshake.controlMs, portDeadlines.control, 'the start script keeps the restored control window')
  assert.equal(port.handed(), port.scriptCancelMs, 'the script was handed the short cancel in place of the one kept here')
  assert.ok(port.scriptCancelMs < portDeadlines.cancel * 0.8, "the script's clock ends inside the wait this computer keeps")
  assert.equal((await port.records()).at(-1).event, 'closed', 'the start script ended by itself, after its closed frame')
})

test('a second real-start open on one fixture hands each start script the short cancel', async t => {
  const f = await fixture(t, 'runtime-ready')
  const hermesPath = await fakeRuntime(f)
  const handshakes = []
  const capture = (...args) => {
    const child = spawnChild(...args)
    let captured = false
    const write = child.stdin.write.bind(child.stdin)
    child.stdin.write = (data, ...rest) => {
      if (!captured && typeof data === 'string' && data.startsWith('{')) { captured = true; handshakes.push(JSON.parse(data)) }
      return write(data, ...rest)
    }
    return child
  }
  const first = await f.open({ ...f.config, hermesPath }, { spawn: capture })
  const second = await f.open({ ...f.config, hermesPath }, { spawn: capture })
  assert.equal(handshakes.length, 2, 'both start scripts reached their handshake')
  assert.deepEqual(handshakes.map(handshake => handshake.cancelMs), [f.scriptCancelMs, f.scriptCancelMs], 'each start script was handed the short cancel, not the one kept here')
  assert.equal(f.handoffs(), 2, 'the fixture recorded one handoff per start script')
  await Promise.all([first.close(), second.close()])
})

test('a token of the wrong shape and a fault inside the start script are their own kinds', async t => {
  const token = await fixture(t, 'runtime-bad-token')
  await assert.rejects(token.open({ ...token.config, hermesPath: await fakeRuntime(token) }), error => error.code === 'bot/hermes-ssh-handshake' && error.sshError === 'handshake' && !error.cleanupUnknown)
  assert.ok(!(await token.records()).some(record => record.event === 'runtime-start'), 'no Hermes is started on a refused handshake')

  const fault = await fixture(t, 'runtime-script-fault')
  let failure
  await assert.rejects(fault.open({ ...fault.config, hermesPath: await fakeRuntime(fault) }), error => { failure = error; return error.code === 'bot/hermes-ssh-script' && error.sshError === 'remote-script' && !error.cleanupUnknown })
  // The fault's class and line only: never its message.
  assert.equal(failure.sshDetail.fault, 'TypeError')
  assert.ok(Number.isSafeInteger(failure.sshDetail.line) && failure.sshDetail.line > 0)
  assert.ok(!(await fault.records()).some(record => record.event === 'runtime-start'))
})

test('a stall is reported with the stage the start script had reached', async t => {
  const f = await fixture(t, 'stalled-start')
  // The stage is the one the fake ssh reports once it has started: the deadline has to
  // outlast that start on a busy computer, or the stall is reported at the sign-in.
  await assert.rejects(f.open(undefined, { deadlines: { start: 2000, control: 3000, cancel: 1000 } }), error => error.code === 'bot/hermes-ssh-timeout' && error.sshStage === 'hermes-start')
})

test('a tunnel that never listens and a busy forward from the host’s own config are told apart', async t => {
  const silent = await fixture(t, 'tunnel-silent')
  await assert.rejects(silent.open(undefined, { deadlines: { start: 3000, control: 200, cancel: 250 } }), error => error.code === 'bot/hermes-ssh-tunnel' && error.sshError === 'tunnel' && error.sshStage === 'tunnel' && !error.cleanupUnknown)
  const busy = await fixture(t, 'forward-conflict')
  let failure
  await assert.rejects(busy.open(), error => { failure = error; return error.code === 'bot/hermes-ssh-forward' && error.sshError === 'forward-conflict' && !error.cleanupUnknown })
  assert.equal(failure.sshDetail.port, 8080)
  assert.notEqual(busy.localPort, 8080)
  assert.match(failure.sshDetail.ssh.join('\n'), /Could not request local forwarding/)
})

test('what SSH itself said is kept without its trace, key names or home paths', async t => {
  const f = await fixture(t, 'unclassified')
  let failure
  await assert.rejects(f.open(), error => { failure = error; return error.code === 'bot/hermes-ssh' && error.sshError === 'unknown' })
  assert.ok(!failure.cleanupUnknown, 'SSH gave up before it sent the command: nothing remote is left to clean')
  assert.deepEqual(failure.sshDetail.ssh, ['A sample line SSH said, with ~/.ssh/[hidden] in it'])
  assert.ok(!JSON.stringify(failure.sshDetail).includes('debug1'))
})

test('the redaction removes tokens, nonces, key material and home paths, and keeps the rest', () => {
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(8).toString('hex'), key = sampleKey()
  const planted = [
    `token ${token} nonce ${nonce}`, `Authorization: Bearer ${randomUUID()}${randomUUID()}`, `OPENAI_API_KEY=sk-${randomUUID().replaceAll('-', '')}`,
    `debug1: Server host key: ssh-ed25519 ${fingerprintOf(key)}`, `ssh-ed25519 ${key} sample@example.invalid`,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nsampleSampleSample\n-----END OPENSSH PRIVATE KEY-----',
    'Traceback: /home/sample-person/.hermes/hermes-agent/run.py line 4', 'identity file /Users/sample-person/.ssh/id_sample_work type 3', 'cwd /root/.hermes/logs',
  ].join('\n')
  const cleaned = redactSshText(planted, [token, nonce])
  for (const secret of [token, nonce, key, fingerprintOf(key).slice(7), 'sample-person', 'id_sample_work', 'sampleSampleSample', '/root']) assert.ok(!cleaned.includes(secret), secret)
  assert.ok(!/sk-[0-9a-f]{8}/.test(cleaned) && !/Bearer [0-9a-f]{8}/.test(cleaned))
  for (const kept of ['Traceback: ~/.hermes/hermes-agent/run.py line 4', 'identity file ~/.ssh/[hidden] type 3', 'cwd ~/.hermes/logs', 'debug1: Server host key: ssh-ed25519 SHA256:[hidden]']) assert.ok(cleaned.includes(kept), kept)
  assert.equal(redactSshText('Hermes could not bind 127.0.0.1: address in use (errno 98)', [token]), 'Hermes could not bind 127.0.0.1: address in use (errno 98)')
  // The line that says where a changed key is saved stays useful; a key file's name never does.
  assert.equal(redactSshText('Offending ED25519 key in /home/sample-person/.ssh/known_hosts:12'), 'Offending ED25519 key in ~/.ssh/known_hosts:12')
  assert.equal(redactSshText('Bad owner or permissions on /Users/sample-person/.ssh/config'), 'Bad owner or permissions on ~/.ssh/config')
  for (const named of ['known_hosts.d/sample-work', 'config.d/sample-work', 'known_hosts_sample-work', 'id_sample_work.pub']) assert.equal(redactSshText(`read /home/sample-person/.ssh/${named}: failed`), 'read ~/.ssh/[hidden]: failed')
})

test('a new host key is saved only by the trust step, and only the key that was shown', async t => {
  const f = await fixture(t, 'host-key')
  let failure
  await assert.rejects(f.open(), error => { failure = error; return error.sshError === 'host-key-unknown' })
  // The failed test trusted nothing: strict checking, no accept-new, no known-hosts file.
  await assert.rejects(access(f.knownHosts))
  assert.ok((await f.records()).every(record => !record.args?.includes('StrictHostKeyChecking=accept-new')))
  assert.ok((await f.records()).filter(record => record.event === 'spawn').every(record => record.args.includes('StrictHostKeyChecking=yes')))

  const shown = { keyType: failure.sshDetail.keyType, fingerprint: failure.sshDetail.fingerprint }
  assert.deepEqual(await f.trust(shown), { trusted: true, added: 1 })
  assert.equal(await readFile(f.knownHosts, 'utf8'), `${f.config.user}@${f.config.host} ssh-ed25519 ${f.hostKey}\n`)
  assert.equal((await stat(f.knownHosts)).mode & 0o777, 0o600)
  const probe = (await f.records()).find(record => record.role === 'trust')
  // The trust probe signs in nowhere and still lists the person's own file, so SSH
  // itself refuses a host whose saved key differs.
  for (const option of ['PubkeyAuthentication=no', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'BatchMode=yes', 'ClearAllForwardings=yes']) assert.ok(probe.args.includes(option), option)
  assert.ok(probe.args.find(arg => arg.startsWith('UserKnownHostsFile=')).endsWith(` ${f.knownHosts}`))
  assert.equal(probe.args.at(-1), 'true')
  // Trusting again adds nothing: the key is known now.
  assert.deepEqual(await f.trust(shown), { trusted: true, added: 0 })
  assert.equal((await readFile(f.knownHosts, 'utf8')).trim().split('\n').length, 1)
  assert.deepEqual((await readdir(f.home)).filter(name => name.startsWith('automagik-host-key-')), [], 'the throwaway file is removed')
})

test('a changed host key is refused by the trust step and nothing is written', async t => {
  const f = await fixture(t, 'host-key')
  const saved = `${f.config.user}@${f.config.host} ssh-ed25519 ${sampleKey()}\n`
  await mkdir(dirname(f.knownHosts), { recursive: true })
  await writeFile(f.knownHosts, saved)
  await assert.rejects(f.trust({ keyType: 'ssh-ed25519', fingerprint: fingerprintOf(f.hostKey) }), error => error.code === 'bot/hermes-ssh-host-key' && error.sshError === 'host-key-changed' && error.sshStage === 'host-key')
  assert.equal(await readFile(f.knownHosts, 'utf8'), saved, 'the saved key is untouched and the new one is not added')
})

test('a host that presents another key than the one shown is refused and nothing is written', async t => {
  const f = await fixture(t, 'trust-swapped')
  const swapped = sampleKey()
  const env = { ...f.options.env, HERMES_SSH_SWAPPED_KEY: swapped }
  let failure
  await assert.rejects(f.trust({ keyType: 'ssh-ed25519', fingerprint: fingerprintOf(f.hostKey) }, { env }), error => { failure = error; return error.code === 'bot/hermes-ssh-host-key' && error.sshError === 'host-key-changed' })
  assert.equal(failure.sshDetail.mismatch, true)
  await assert.rejects(access(f.knownHosts))
  // A key type or fingerprint that is not one is refused before any SSH runs.
  const before = (await f.records()).length
  for (const expected of [{ keyType: 'ssh-ed25519', fingerprint: 'SHA256:short' }, { keyType: '-o', fingerprint: fingerprintOf(f.hostKey) }, {}]) await assert.rejects(f.trust(expected, { env }), error => error.code === 'bot/hermes-ssh-details')
  assert.equal((await f.records()).length, before)
})

test('a host whose config discards host keys cannot be trusted from here', async t => {
  const f = await fixture(t, 'host-key')
  const env = { ...f.options.env, HERMES_SSH_KNOWN_HOSTS: '/dev/null' }
  await assert.rejects(f.trust({ keyType: 'ssh-ed25519', fingerprint: fingerprintOf(f.hostKey) }, { env }), error => error.code === 'bot/hermes-ssh-host-key-unknown' && error.sshDetail.unsaved === true)
  assert.ok(!(await f.records()).some(record => record.role === 'trust'))
})
