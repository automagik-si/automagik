import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { checkSetToken, createBitwardenSecrets } from '../src/bws/adapter.js'
import { classify } from '../src/bws/classify.js'
import { normalizeServer, runBws } from '../src/bws/run.js'
import { createKeychain, keychainIdentity } from '../src/keychain/index.js'
import { bwsReports } from './fixtures/bws-reports.mjs'
import { completed, digest, fakeSpawn, fakeToken, memoryKeychain } from './fixtures/bws.mjs'
import { fakeVault } from './fixtures/harness.mjs'
import { fakeOnePassword, useFakeVaultExecutables } from './fixtures/onepassword.mjs'

const provider = 'bitwarden-secrets'
const unavailable = { ok: false, code: 'unavailable' }
const locked = { ok: false, code: 'locked' }
const ok = { ok: true }
const json = value => completed(0, JSON.stringify(value))

function profile(t) {
  const home = mkdtempSync(join(tmpdir(), 'bws-fixture-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return { home, identity: keychainIdentity({ get: name => name === 'profileContext' ? { dir: home } : undefined }) }
}

function fixture(t, { run, keychain = memoryKeychain(), timers } = {}) {
  const { identity } = profile(t)
  const calls = []
  const token = fakeToken()
  const project = { id: randomUUID(), name: 'Project A' }
  const other = { id: randomUUID(), name: 'Project B' }
  const item = { id: randomUUID(), key: 'DUPLICATE', projectId: project.id,
    value: randomBytes(16).toString('hex') + '\n', note: randomBytes(16).toString('hex') }
  const second = { ...item, id: randomUUID(), projectId: other.id }
  const defaults = (args) => {
    if (args[0] === '--version') return completed(0, 'bws 2.1.0\n')
    if (args[0] === 'project') return json([project, other])
    if (args[1] === 'list') return json([args[2] === project.id ? item : second])
    return json(item)
  }
  const execute = (args, options) => {
    calls.push({ args, hasToken: options.token === undefined ? false : digest(options.token) === digest(token),
      server: options.server, timeout: options.timeout })
    return Promise.resolve(run?.(args, options) ?? defaults(args))
  }
  const start = () => createBitwardenSecrets({}, { keychain, identity, run: execute, timers })
  const adapter = start()
  t.after(() => adapter.prepareQuit())
  const ref = { provider, connection: 'Fixture', item: item.id, field: 'value' }
  const credentials = { token, connection: ref.connection, server: 'us' }
  return { adapter, start, ref, credentials, calls, keychain, identity, project, other, item, second }
}

test('every bws invocation uses a private, secret-free profile and scrubs ambient overrides', async t => {
  const { home } = profile(t)
  const token = fakeToken()
  const attempts = []
  const fake = fakeSpawn(({ args, options, stdin, file }) => {
    const config = readFileSync(args[1], 'utf8')
    const version = args.at(-1) === '--version'
    attempts.push({
      shape: args[0] === '--config-file' && args[2] === '--profile' && args[3] === 'automagik'
        && !args.includes('--server-url') && (version || args.slice(4).join(' ') === '--output json --color no project list'),
      safe: !args.some(arg => arg.includes(token)) && !config.includes(token) && stdin === undefined && file === 'fake-bws',
      env: Object.keys(options.env).sort(),
      credential: typeof options.env.BWS_ACCESS_TOKEN === 'string' && digest(options.env.BWS_ACCESS_TOKEN) === digest(token),
      mode: process.platform === 'win32' || (statSync(dirname(args[1])).mode & 0o777) === 0o700,
      config, dir: dirname(args[1]),
    })
    if (!config.includes('state_opt_out = "true"') || args.includes('--server-url') || options.env.BWS_SERVER_URL) return completed(9)
    return completed()
  })
  const options = { tmpRoot: home, spawnChild: fake, resolveHelper: () => ({ file: 'fake-bws', prefix: [] }),
    parent: { PATH: 'fixture', bws_config_file: 'ambient', BWS_PROFILE: 'ambient', BWS_SERVER_URL: 'ambient',
      BWS_ACCESS_TOKEN: fakeToken(), RUST_LOG: 'trace', rust_backtrace: 'full', RUST_LIB_BACKTRACE: '1',
      RUST_SPANTRACE: '1', COLORBT_SHOW_HIDDEN: '1', BW_SESSION: fakeToken() } }
  assert.equal((await runBws(['--version'], { timeout: 100, token }, options)).code, 0)
  assert.equal((await runBws(['project', 'list'], { timeout: 100, token, server: 'eu' }, options)).code, 0)
  const [version, auth] = attempts
  assert.equal(attempts.every(row => row.shape && row.safe && row.mode), true)
  assert.deepEqual(version.env, ['PATH'])
  assert.deepEqual(auth.env, ['BWS_ACCESS_TOKEN', 'PATH'])
  assert.equal(version.credential, false)
  assert.equal(auth.credential, true)
  assert.match(version.config, /^\[profiles\.automagik\]\nserver_api = "https:\/\/api\.bitwarden\.com"/)
  assert.match(auth.config, /server_identity = "https:\/\/identity\.bitwarden\.eu"/)
  assert.notEqual(version.dir, auth.dir)
  assert.equal(existsSync(version.dir) || existsSync(auth.dir), false)
  assert.deepEqual(readdirSync(home), [])
})

test('authenticated bws pins the absolute version-probed executable past a relative PATH decoy', { skip: process.platform === 'win32' }, async t => {
  const { home } = profile(t)
  const decoy = join(home, 'decoy')
  const preferred = join(home, 'preferred')
  const trusted = join(home, 'trusted')
  for (const dir of [decoy, preferred, trusted]) mkdirSync(dir)
  for (const dir of [decoy, trusted]) writeFileSync(join(dir, 'bws'), '', { mode: 0o700 })
  const calls = []
  const options = {
    tmpRoot: home, parent: { PATH: [relative(process.cwd(), decoy), preferred, trusted].join(':') },
    spawnChild: fakeSpawn(({ file, args, options }) => {
      const version = args.at(-1) === '--version'
      calls.push({ file, version, hasToken: options.env.BWS_ACCESS_TOKEN === credentials.token })
      if (version) {
        writeFileSync(join(preferred, 'bws'), '', { mode: 0o700 })
        return completed(0, 'bws 2.1.0\n')
      }
      return json([])
    }),
  }
  const { adapter, credentials } = fixture(t, { run: (args, limits) => runBws(args, limits, options) })
  assert.deepEqual(await adapter.setToken(credentials), ok)
  assert.deepEqual(calls, [
    { file: join(trusted, 'bws'), version: true, hasToken: false },
    { file: join(trusted, 'bws'), version: false, hasToken: true },
  ])
})

test('profile realpaths and exact labels determine the opaque credential identity', async t => {
  const { home } = profile(t)
  const dirs = ['one', 'two'].map(name => join(home, 'profiles', name))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  const [a, b] = dirs.map(dir => keychainIdentity({ get: () => ({ dir }) }))
  const expected = 'automagik-vault:v1:' + digest(JSON.stringify({
    profile: realpathSync(dirs[0]), provider, connection: 'Work',
  })).slice(0, 32)
  assert.equal(a.item('Work'), expected)
  assert.equal(new Set([expected, b.item('Work'), a.item('work')]).size, 3)
  assert.equal(normalizeServer('HTTPS://EXAMPLE.INVALID:443/root///'), 'https://example.invalid/root')
  for (const invalid of ['http://example.invalid', 'https://user@example.invalid', 'https://example.invalid/?arg=one', 'https://example.invalid/\n']) {
    assert.equal(normalizeServer(invalid), undefined)
  }
})

test('activation verifies once, polling does not renew, and restart unlock reads the credential once', async t => {
  let idle
  let resets = 0
  const timers = {
    setTimeout(fn, ms) {
      if (ms === 300000) { idle = fn; resets++ }
      return fn
    },
    clearTimeout(fn) { if (idle === fn) idle = undefined },
  }
  const { adapter, start, keychain, calls, credentials, identity, ref } = fixture(t, { timers })
  assert.deepEqual(await adapter.status(), { state: 'locked' })
  assert.deepEqual(await adapter.listItems(ref), locked)
  assert.equal(keychain.calls.length, 0)
  assert.deepEqual(await adapter.setToken(credentials), ok)
  const activation = adapter.activationId
  assert.equal(typeof activation, 'symbol')
  assert.equal(calls.filter(call => call.hasToken).length, 1)
  const reads = keychain.calls.length
  assert.deepEqual(await adapter.status(), { state: 'unlocked' })
  assert.equal((await adapter.listItems(ref)).ok, true)
  assert.equal(keychain.calls.length, reads)
  assert.equal(resets, 1)
  idle()
  assert.equal(adapter.activationId, undefined)
  assert.deepEqual(await adapter.read(ref), locked)
  assert.deepEqual(await adapter.status(), { state: 'locked' })
  await adapter.prepareQuit()
  const restarted = start()
  t.after(() => restarted.prepareQuit())
  assert.deepEqual(await restarted.status(), { state: 'locked' })
  const before = calls.filter(call => call.hasToken).length
  assert.deepEqual(await restarted.unlock({ connection: ref.connection }), ok)
  assert.equal(typeof restarted.activationId, 'symbol')
  assert.notEqual(restarted.activationId, activation)
  assert.equal(calls.filter(call => call.hasToken).length, before + 1)
  assert.deepEqual(keychain.calls.slice(reads), [['lookup', identity.item(ref.connection)]])
  assert.deepEqual(await restarted.clearToken(), ok)
  assert.equal(restarted.activationId, undefined)
  assert.deepEqual(await restarted.read(ref), locked)
  assert.equal(keychain.entries.size, 0)
})

test('same-label server replacement leaves one item and an unsuccessful write preserves it', async t => {
  const { adapter, credentials, keychain, identity, ref } = fixture(t)
  const id = identity.item(ref.connection)
  assert.deepEqual(await adapter.setToken(credentials), ok)
  const activation = adapter.activationId
  const original = digest(keychain.entries.get(id))
  const store = keychain.store
  keychain.store = async () => ({ ok: false, code: 'keychain' })
  assert.deepEqual(await adapter.setToken({ ...credentials, server: 'eu' }), { ok: false, code: 'keychain' })
  assert.equal(digest(keychain.entries.get(id)) === original, true)
  assert.deepEqual(await adapter.read(ref), locked)
  assert.equal(adapter.activationId, undefined)
  keychain.store = store
  assert.deepEqual(await adapter.setToken({ ...credentials, server: 'https://EXAMPLE.invalid:443/' }), ok)
  assert.notEqual(adapter.activationId, activation)
  assert.deepEqual([...keychain.entries.keys()], [id])
  const blob = JSON.parse(Buffer.from(keychain.entries.get(id), 'base64').toString('utf8'))
  assert.equal(blob.v === 1 && blob.server === 'https://example.invalid' && digest(blob.token) === digest(credentials.token), true)
  assert.deepEqual(keychain.calls.map(([operation]) => operation), ['store', 'lookup', 'store', 'lookup'])
  await adapter.lock()
  assert.equal(adapter.activationId, undefined)
  assert.deepEqual(await adapter.unlock(ref), ok)
  assert.equal(typeof adapter.activationId, 'symbol')
  await adapter.prepareQuit()
  assert.equal(adapter.activationId, undefined)
})

test('a Clear from another adapter during Set leaves the replacement discoverable by its label', async t => {
  const { adapter: a, start, credentials, keychain, identity, ref } = fixture(t)
  const b = start()
  t.after(() => b.prepareQuit())
  assert.deepEqual(await b.setToken(credentials), ok)
  const writing = Promise.withResolvers()
  const release = Promise.withResolvers()
  const store = keychain.store
  keychain.store = async (id, blob) => {
    writing.resolve()
    await release.promise
    return store(id, blob)
  }
  const setting = a.setToken({ ...credentials, server: 'eu' })
  await writing.promise
  try {
    assert.deepEqual(await b.clearToken(ref), ok)
    assert.deepEqual(await b.read(ref), locked)
    assert.equal(keychain.entries.size, 0)
  } finally { release.resolve() }
  assert.deepEqual(await setting, ok)
  assert.deepEqual([...keychain.entries.keys()], [identity.item(ref.connection)])
  assert.deepEqual(await b.unlock(ref), ok)
  assert.deepEqual(await b.clearToken(ref), ok)
  assert.equal(keychain.entries.size, 0)
})

test('a Clear after another adapter stores but before it confirms leaves both adapters locked', async t => {
  const { adapter: a, start, credentials, keychain, ref } = fixture(t)
  const b = start()
  t.after(() => b.prepareQuit())
  assert.deepEqual(await b.setToken(credentials), ok)
  const visible = Promise.withResolvers()
  const release = Promise.withResolvers()
  const store = keychain.store
  keychain.store = async (id, blob) => {
    const stored = await store(id, blob)
    visible.resolve()
    await release.promise
    return stored
  }
  const setting = a.setToken({ ...credentials, server: 'eu' })
  await visible.promise
  try {
    assert.deepEqual(await b.clearToken(ref), ok)
    assert.equal(keychain.entries.size, 0)
  } finally { release.resolve() }
  assert.deepEqual(await setting, { ok: false, code: 'set', committed: true })
  assert.deepEqual(await a.read(ref), locked)
  assert.deepEqual(await b.read(ref), locked)
})

test('clear waits for a pending store and lock cancels a keychain lookup before verification', async t => {
  const { adapter, calls, credentials, keychain, ref } = fixture(t)
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const store = keychain.store
  keychain.store = async (id, value) => {
    started.resolve()
    await release.promise
    return store(id, value)
  }
  const saving = adapter.setToken(credentials)
  await started.promise
  const clearing = adapter.clearToken(ref)
  release.resolve()
  assert.deepEqual(await saving, { ...locked, committed: true })
  assert.deepEqual(await clearing, ok)
  assert.equal(keychain.entries.size, 0)
  await adapter.setToken(credentials)
  await adapter.lock()
  const lookedUp = Promise.withResolvers()
  const wait = keychain.lookup
  keychain.lookup = async (id, signal) => {
    lookedUp.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return wait(id, signal)
  }
  const count = calls.filter(call => call.hasToken).length
  const unlocking = adapter.unlock({ connection: ref.connection })
  await lookedUp.promise
  await adapter.lock()
  assert.deepEqual(await unlocking, locked)
  assert.equal(calls.filter(call => call.hasToken).length, count)
})

test('malformed credentials and Cloud are refused before any keychain access', async t => {
  const { adapter, calls, credentials, keychain } = fixture(t)
  for (const suffix of ['\r', '\n', ' ', '"', "'", '\\', '\0']) {
    assert.deepEqual(await adapter.setToken({ ...credentials, token: credentials.token + suffix }), { ok: false, code: 'refused' })
  }
  const cloud = 'AUTOMAGIK_GATE_CLOUD_WORKSPACE'
  const prior = process.env[cloud]
  process.env[cloud] = 'fixture'
  try {
    for (const result of [await adapter.setToken(credentials), await adapter.unlock(credentials), await adapter.clearToken()]) {
      assert.deepEqual(result, { ok: false, code: 'cloud' })
    }
    await assert.rejects(adapter.status(), { code: 'cloud' })
    assert.equal(calls.length + keychain.calls.length, 0)
  } finally {
    if (prior === undefined) delete process.env[cloud]
    else process.env[cloud] = prior
  }
})

test('Set accepts only canonical padded or unpadded base64 for the 16-byte access-token key', () => {
  const token = fakeToken()
  const [prefix, padded] = token.split(':')
  const unpadded = padded.slice(0, -2)
  const last = 'AQgw'.indexOf(unpadded.at(-1))
  const noncanonical = unpadded.slice(0, -1) + 'BRhx'[last]
  for (const key of [padded, unpadded]) {
    assert.equal(checkSetToken({ token: prefix + ':' + key, connection: 'Work', server: 'us' }), true)
  }
  for (const key of [unpadded + '=', padded + '=', noncanonical, noncanonical + '==', randomBytes(15).toString('base64'),
    randomBytes(17).toString('base64'), '-' + unpadded.slice(1)]) {
    assert.equal(checkSetToken({ token: prefix + ':' + key, connection: 'Work', server: 'us' }), false)
  }
})

test('the picker lists projects then matching keys, drops both canaries, and reads preserve bytes', async t => {
  let mismatch = false
  const f = fixture(t, { run: args => mismatch && args[1] === 'get' ? json({ ...f.item, id: f.second.id }) : undefined })
  const { adapter, credentials, ref, item, second, project, other, calls } = f
  assert.deepEqual(await adapter.setToken(credentials), ok)
  assert.deepEqual(await adapter.listItems({ ...ref, project: project.id }), unavailable)
  assert.deepEqual(await adapter.listItems(ref), { ok: true, projects: [project, other], items: [] })
  assert.equal(calls.some(call => call.args[0] === 'secret'), false)
  for (const [selected, row] of [[project, item], [other, second]]) {
    const response = await adapter.listItems({ ...ref, project: selected.id })
    const text = JSON.stringify(response)
    assert.equal(text.includes(item.note) || text.includes(item.value.trim()), false)
    assert.deepEqual(response, { ok: true, items: [{ id: row.id, name: row.key, vault: selected.name, fields: [{ id: 'value', label: 'Value' }] }] })
  }
  const result = await adapter.read(ref)
  assert.equal(result.ok && digest(result.value) === digest(item.value), true)
  mismatch = true
  assert.deepEqual(await adapter.read(ref), unavailable)
})

test('captured bws 2.1.0 diagnostics classify auth, which locks the adapter', async t => {
  const report = name => completed(1, '', bwsReports[name])
  const backtrace = bwsReports.unauthorized.split('\n\nBacktrace omitted.')[0] +
    '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ BACKTRACE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '   1: bws::main\n      at crates/bws/src/main.rs:107\n'
  const auth = [...['invalidClient', 'invalidGrant', 'unauthorized'].map(report), completed(1, '', backtrace)]
  for (const result of auth) assert.equal(classify('2.1.0', result), 'auth')
  assert.equal(classify('2.1.1', auth[0]), 'unavailable')
  const windows = auth[0].stderr.replace('crates/bws/src/main.rs', 'crates\\bws\\src\\main.rs').replaceAll('\n', '\r\n')
  assert.equal(classify('2.1.0', completed(1, '', windows)), 'auth')
  const nested = auth[0].stderr.replace('   0: ', '   0: Request failed\n   1: ')
  assert.equal(classify('2.1.0', completed(1, '', nested)), 'auth')
  const tls = completed(1, '', bwsReports.closed.replace(/tcp connect error\n   3: Connection refused \(os error 111\)/,
    'invalid peer certificate'))
  const transient = [...['notFound', 'rateLimited', 'outage', 'closed'].map(report), tls]
  const invalidBodies = ['invalid_client', '"invalid_grant"', '{"error":"other"}'].map(body =>
    completed(1, '', auth[0].stderr.replace('{"error":"invalid_client"}', body)))
  for (const result of [...transient, ...invalidBodies, completed(1, '', '401 Unauthorized'),
    completed(1, '', auth[2].stderr.replace('   0: ', '   1: ')),
    { failure: 'timeout' }, { failure: 'output' }, completed(0, '', 'No organization')]) {
    assert.equal(classify('2.1.0', result), 'unavailable')
  }
  let result = completed(0, '', 'Access token is not associated with an organization')
  const { adapter, credentials, project, ref, keychain } = fixture(t, {
    run: args => args[0] === 'project' || (args[0] === 'secret' && args[1] === 'list') || args[1] === 'get' ? result : undefined,
  })
  assert.deepEqual(await adapter.setToken(credentials), unavailable)
  assert.equal(keychain.entries.size, 0)
  result = json([project])
  assert.deepEqual(await adapter.setToken(credentials), ok)
  await adapter.listItems(ref)
  result = { failure: 'output' }
  assert.deepEqual(await adapter.listItems({ ...ref, project: project.id }), unavailable)
  for (result of transient) {
    assert.deepEqual(await adapter.read(ref), unavailable)
    assert.deepEqual(await adapter.status(), { state: 'unlocked' })
  }
  for (const failure of auth) {
    const activation = adapter.activationId
    result = failure
    assert.deepEqual(await adapter.read(ref), { ok: false, code: 'auth' })
    assert.equal(adapter.activationId, undefined)
    assert.deepEqual(await adapter.read(ref), locked)
    result = json([project])
    assert.deepEqual(await adapter.unlock(ref), ok)
    assert.notEqual(adapter.activationId, activation)
  }
})

test('the shared runner caps a project secret list before the adapter projects it', async t => {
  const { home } = profile(t)
  const { adapter, credentials, ref, project } = fixture(t, { run(args, limits) {
    if (args[0] === 'secret') return runBws(args, limits, {
      tmpRoot: home, resolveHelper: () => ({ file: 'fake-bws', prefix: [] }),
      spawnChild: fakeSpawn(() => json([{ id: ref.item, key: 'Fixture key', projectId: project.id,
        value: randomBytes(3 * 1024 * 1024 + 1).toString('base64') }])),
    })
  } })
  assert.deepEqual(await adapter.setToken(credentials), ok)
  assert.equal((await adapter.listItems(ref)).ok, true)
  assert.deepEqual(await adapter.listItems({ ...ref, project: project.id }), unavailable)
  assert.deepEqual(readdirSync(home), [])
})

test('failed Bitwarden retirement blocks the Secrets Manager switch at the service seam', async t => {
  const { apply } = await import('../index.js')
  const bw = fakeVault(t)
  writeFileSync(join(bw.parent.PATH, 'secret-tool'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const restore = useFakeVaultExecutables(fakeOnePassword(t), bw)
  let service
  let profileRequested = false
  apply({
    get(name) { profileRequested = name === 'profileContext'; return { dir: bw.parent.HOME } },
    provide(_name, value) { service = value }, effect() {},
  })
  try {
    assert.equal(profileRequested, true)
    assert.deepEqual(await service.unlock({ password: bw.password, connection: bw.connection }), ok)
    const initial = service.providerSelection
    bw.configure({ lock: 'error' })
    assert.deepEqual(await service.setToken({ provider, connection: provider, server: 'us', token: fakeToken() }), unavailable)
    assert.equal(service.providerSelection, initial)
    assert.equal(bw.commands().at(-1), 'lock')
  } finally {
    bw.configure({ lock: 'ok' })
    try { await service.prepareQuit() } finally { restore() }
  }
})

test('invalid Secrets Manager Set preserves an unlocked Bitwarden session and starts no helpers', async t => {
  const { apply } = await import('../index.js')
  const bw = fakeVault(t)
  const restore = useFakeVaultExecutables(fakeOnePassword(t), bw)
  const parent = bw.parent.PATH
  const marker = join(parent, 'd4c-helper-called')
  for (const helper of ['bws', 'secret-tool']) {
    writeFileSync(join(parent, helper), '#!' + process.execPath + '\n' +
      "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'called')\n", { mode: 0o700 })
  }
  let service
  apply({ get: () => ({ dir: bw.parent.HOME }), provide(_name, value) { service = value }, effect() {} })
  try {
    assert.deepEqual(await service.unlock({ password: bw.password, connection: bw.connection }), ok)
    const previous = service.providerSelection
    const commands = bw.commands()
    const token = fakeToken()
    assert.equal(Object.keys(service).includes('checkSetToken'), false)
    assert.equal(service.checkSetToken({ token, connection: provider, server: 'us' }), true)
    for (const options of [
      { token: token.slice(0, token.lastIndexOf(':')) + ':AA==', server: 'us' },
      { token, server: 'http://127.0.0.1' },
      { token: fakeToken(randomBytes(1425).toString('base64')), server: 'us' },
    ]) {
      const input = { provider, connection: provider, ...options }
      assert.equal(service.checkSetToken(input), false)
      assert.deepEqual(await service.setToken(input), { ok: false, code: 'refused' })
    }
    assert.deepEqual(bw.commands(), commands)
    assert.equal(service.providerSelection, previous)
    assert.equal((await service.status()).state, 'unlocked')
    assert.equal(existsSync(marker), false)
  } finally {
    try { await service.prepareQuit() } finally { restore() }
  }
})

test('Cloud and missing-keychain refusals preserve an active 1Password session at the service seam', async t => {
  const { apply } = await import('../index.js')
  const bw = fakeVault(t)
  const op = fakeOnePassword(t)
  const restore = useFakeVaultExecutables(op, bw)
  const marker = 'AUTOMAGIK_GATE_CLOUD_WORKSPACE'
  const previousMarker = process.env[marker]
  let service
  apply({ get: () => ({ dir: bw.parent.HOME }), provide(_name, value) { service = value }, effect() {} })
  try {
    delete process.env[marker]
    assert.deepEqual(await service.unlock({ provider: 'onepassword', connection: op.ref.connection, token: op.credential }), ok)
    const selection = service.providerSelection
    const connection = service.activeConnection()
    const commands = op.commands()
    const target = { provider, connection: 'Work' }
    const set = { ...target, token: fakeToken(), server: 'us' }
    if (process.platform === 'linux') {
      assert.deepEqual(await service.unlock(target), { ok: false, code: 'keychain' })
      assert.deepEqual(await service.setToken(set), { ok: false, code: 'keychain' })
    }
    process.env[marker] = 'fixture'
    assert.deepEqual(await service.unlock(target), { ok: false, code: 'cloud' })
    assert.deepEqual(await service.setToken(set), { ok: false, code: 'cloud' })
    delete process.env[marker]
    assert.equal(service.providerSelection, selection)
    assert.equal(service.activeConnection()?.connection === connection.connection, true)
    assert.deepEqual(op.commands(), commands)
    assert.equal((await service.status({ provider: 'onepassword' })).state, 'unlocked')
    assert.equal(await service.lock({ provider }), true)
    assert.equal((await service.status({ provider: 'onepassword' })).state, 'unlocked')
    assert.equal(await service.lock(), true)
    assert.equal((await service.status({ provider: 'onepassword' })).state, 'locked')
  } finally {
    if (previousMarker === undefined) delete process.env[marker]
    else process.env[marker] = previousMarker
    try { await service.prepareQuit() } finally { restore() }
  }
})

test('missing keychain helpers preserve an active provider on each platform at the service seam', async t => {
  const { apply } = await import('../index.js')
  const bw = fakeVault(t)
  const op = fakeOnePassword(t)
  const restore = useFakeVaultExecutables(op, bw)
  const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  try {
    for (const [label, platform, parent, expectedPaths] of [
      ['Linux without an absolute secret-tool', 'linux', { PATH: bw.parent.PATH }, []],
      ['macOS without security', 'darwin', {}, ['/usr/bin/security']],
      ['Windows without SystemRoot', 'win32', {}, []],
      ['Windows without PowerShell', 'win32', { SystemRoot: 'C:\\Windows' }, [powerShell]],
    ]) {
      await t.test(label, async () => {
        let spawns = 0
        const probes = new Set()
        const keychain = createKeychain({ platform, parent,
          exists(file) { probes.add(file); return false },
          spawnChild() { spawns++; throw new Error('fixture must not spawn a keychain helper') },
        })
        let service
        apply({ get: () => ({ dir: bw.parent.HOME }), provide(_name, value) { service = value }, effect() {} }, {}, { keychain })
        try {
          assert.deepEqual(await service.unlock({ provider: 'onepassword', connection: op.ref.connection, token: op.credential }), ok)
          const selection = service.providerSelection
          const target = { provider, connection: 'Work' }
          const unavailableKeychain = { ok: false, code: 'keychain' }
          assert.equal(Object.keys(service).includes('activationId'), false)
          assert.equal(Object.keys(service).includes('checkAvailability'), false)
          assert.equal(service.checkAvailability(target), 'keychain')
          assert.deepEqual(await service.unlock(target), unavailableKeychain)
          assert.deepEqual(await service.setToken({ ...target, token: fakeToken(), server: 'us' }), unavailableKeychain)
          assert.equal(service.providerSelection, selection)
          assert.equal((await service.status({ provider: 'onepassword' })).state, 'unlocked')
          const identity = keychainIdentity({ get: () => ({ dir: bw.parent.HOME }) })
          assert.deepEqual(await keychain.lookup(identity.item('Work')), unavailableKeychain)
          assert.deepEqual([...probes], expectedPaths)
          assert.equal(spawns, 0)
        } finally { await service.prepareQuit() }
      })
    }
  } finally { restore() }
})

test('the service exposes the real Secrets Manager activation across Set, Lock, Unlock and Clear', {
  skip: process.platform === 'win32',
}, async t => {
  const { apply } = await import('../index.js')
  const bw = fakeVault(t)
  const op = fakeOnePassword(t)
  const restore = useFakeVaultExecutables(op, bw)
  let service
  try {
    writeFileSync(join(bw.parent.PATH, 'bws'), '#!/bin/sh\n' +
      'shift 4\n' +
      'case "$*" in\n' +
      '  --version) [ -z "$BWS_ACCESS_TOKEN" ] && printf "bws 2.1.0\\n";;\n' +
      '  "--output json --color no project list") [ -n "$BWS_ACCESS_TOKEN" ] && printf "[]\\n";;\n' +
      '  *) exit 1;;\n' +
      'esac\n', { mode: 0o700 })
    apply({ get: () => ({ dir: bw.parent.HOME }), provide(_name, value) { service = value }, effect() {} },
      {}, { keychain: memoryKeychain() })
    const target = { provider, connection: 'Work' }
    assert.equal(service.activationId(target), undefined)
    assert.deepEqual(await service.setToken({ ...target, token: fakeToken(), server: 'us' }), ok)
    const first = service.activationId(target)
    assert.equal(typeof first, 'symbol')
    assert.equal(await service.lock({ provider }), true)
    assert.equal(service.activationId(target), undefined)
    assert.deepEqual(await service.unlock(target), ok)
    const second = service.activationId(target)
    assert.equal(typeof second, 'symbol')
    assert.notEqual(second, first)
    assert.deepEqual(await service.clearToken(target), ok)
    assert.equal(service.activationId(target), undefined)

    await t.test('Clear also leaves an unrelated service activation in flight', async () => {
      assert.deepEqual(await service.setToken({ ...target, token: fakeToken(), server: 'us' }), ok)
      const unlocking = service.unlock({ provider: 'onepassword', connection: op.ref.connection, token: op.credential })
      const clearing = service.clearToken(target)
      assert.deepEqual(await unlocking, ok)
      assert.deepEqual(await clearing, ok)
      assert.equal((await service.status({ provider: 'onepassword' })).state, 'unlocked')
    })
  } finally {
    try { await service?.prepareQuit() } finally { restore() }
  }
})
