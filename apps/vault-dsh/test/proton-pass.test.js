import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { apply } from '../index.js'
import { createProtonPass } from '../src/proton-pass/adapter.js'
import { runPass } from '../src/proton-pass/run.js'
import { FIELDS, pickerFields, selectField, validToken } from '../src/proton-pass/parse.js'
import { equalPrivate, fakeClock } from './fixtures/harness.mjs'
import { digest, fixtureValue } from './fixtures/fake-pass-cli.mjs'

const provider = 'proton-pass'
const ok = { ok: true }
const fail = code => ({ ok: false, code })
const validVersion = 'Proton Pass CLI 2.7.1 (fixture)'
const token = () => 'pst_' + randomBytes(32).toString('hex') + '::' + randomBytes(32).toString('base64url')
const newId = () => randomBytes(64).toString('base64url') + '=='
const absoluteMs = 110 * 60000

function fixture(t, { timers, idleLockMinutes, runner, mounted = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'proton-fixture-'))
  const path = name => join(root, name)
  const binary = readFileSync(new URL('./fixtures/fake-pass-cli.mjs', import.meta.url), 'utf8')
  writeFileSync(path('pass-cli'), '#!' + process.execPath + '\n' + binary, { mode: 0o700 })
  const credential = token(), replacement = token()
  const share = newId(), id = newId()
  const ref = { provider, connection: provider, item: share + '/' + id, field: 'password' }
  const first = { id, title: 'Fixture item', share_id: share, item_type: 'login', state: 'Active' }
  let control = { version: validVersion, mode: 'ok', tokenHash: digest(credential), share, id, items: [first] }
  const configure = patch => {
    control = { ...control, ...patch }
    writeFileSync(path('control.json'), JSON.stringify(control))
  }
  configure({})
  const keys = new Set()
  const parent = { PATH: root, HOME: root, USERPROFILE: root, TMP: root, HTTPS_PROXY: credential, HTTP_PROXY: credential,
    ALL_PROXY: credential, PROTON_PASS_ENVIRONMENT: credential, PASS_LOG_LEVEL: credential, MUON_LOG_LEVEL: credential,
    RUST_BACKTRACE: credential, PROTON_PASS_AGENT_REASON: credential, PROTON_PASS_KEY_PROVIDER: credential,
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: credential, PROTON_PASS_ENCRYPTION_KEY: credential, PROTON_PASS_SESSION_DIR: root }
  const run = (args, settings) => {
    if (settings.record?.key !== undefined) keys.add(settings.record.key)
    const invoke = () => runPass(args, settings, { parent })
    return runner === undefined ? invoke() : runner(args, settings, invoke)
  }
  const adapter = mounted ? undefined : createProtonPass({ idleLockMinutes }, { root, timers, run })
  let service = adapter
  const events = () => existsSync(path('events.jsonl'))
    ? readFileSync(path('events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const operations = () => events().map(event => event.operation)
  const dirs = () => readdirSync(root).filter(entry => entry.startsWith('automagik-proton-pass-')).map(path)
  const until = async (op, count = 1) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (operations().filter(operation => operation === op).length >= count) return
      await wait(10)
    }
    assert.fail('the fake CLI did not reach ' + op)
  }
  const scan = () => {
    const canaries = [credential, replacement, ...keys]
    for (const key of keys) for (const field of ['password', 'note', 'shadow', 'totp', 'card', 'wifi', 'ssh']) {
      canaries.push(...fixtureValue(key, field).trim().split('\n'))
    }
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      assert.equal(canaries.some(value => text.includes(value)), false, 'no plaintext fixture credentials on disk')
    }
  }
  let restoreEnv, dispose
  const mount = () => {
    const old = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }
    process.env.PATH = root
    process.env.TMPDIR = root
    restoreEnv = () => {
      for (const [name, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    apply({ provide: (_name, value) => { service = value }, effect: install => { dispose = install() } })
    return service
  }
  t.after(async () => {
    try {
      if (service !== undefined) await service.prepareQuit()
      scan()
      assert.equal(events().every(event => event.validEnv && event.validArgs), true, 'only approved argv and env reached the fake CLI')
    } finally {
      restoreEnv?.()
      rmSync(root, { recursive: true, force: true })
    }
  })
  return { root, path, adapter, credential, replacement, ref, first, share, configure, dirs, until, events, operations, scan, mount, dispose: () => dispose(),
    unlock: (options = {}) => service.unlock({ provider, connection: provider, token: credential, ...options }),
    read: (options = {}) => service.read({ ...ref, ...options }),
    list: (options = {}) => service.listItems({ provider, connection: provider, ...options }),
    value: field => fixtureValue([...keys].at(-1), field),
  }
}

test('only CLI 2.7.1 passes, malformed PATs never spawn and failed login leaves no record', async t => {
  const h = fixture(t)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  const badTail = alphabet[alphabet.indexOf(h.credential.at(-1)) + 1]
  for (const token of ['', h.credential + '\n', h.credential.slice(0, -1) + badTail, h.credential.replace(/^pst_./, 'pst_:')]) {
    equalPrivate(await h.unlock({ token }), fail('refused'))
  }
  equalPrivate(await h.unlock({ connection: 'other' }), fail('refused'))
  assert.equal(h.events().length, 0)
  for (const version of ['2.6.1', '2.7.0', '2.7.2', '2.8.0', '3.0.0']) {
    h.configure({ version: 'Proton Pass CLI ' + version + ' (fixture)' })
    equalPrivate(await h.unlock(), fail('version'))
  }
  for (const version of ['garbage', validVersion + '\n']) {
    h.configure({ version })
    equalPrivate(await h.unlock(), fail('version'))
  }
  assert.ok(h.operations().every(op => op === 'version'))
  h.configure({ version: validVersion, mode: 'invalid-token' })
  equalPrivate(await h.unlock(), fail('auth'))
  assert.deepEqual(h.dirs(), [])
  rmSync(h.path('pass-cli'))
  equalPrivate(await h.unlock(), fail('unavailable'))
})

test('read snapshots ids and selects only the exact built-in property with byte-exact output', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.adapter.status(), { state: 'unlocked' })
  assert.match(h.adapter.session, /^[\da-f-]{36}$/)
  const mutable = { ...h.ref }
  const reading = h.adapter.read(mutable)
  mutable.item = h.share + '/' + newId()
  mutable.field = 'note'
  equalPrivate(await reading, { ok: true, value: h.value() })
  for (const [mode, field, valueField] of [
    ['note-kind', 'note', 'note'], ['alias', 'note', 'note'], ['card', 'verification_number', 'card'],
    ['wifi', 'ssid', 'wifi'], ['ssh', 'private_key', 'ssh'],
  ]) {
    h.configure({ mode })
    equalPrivate(await h.read({ field }), { ok: true, value: h.value(valueField) })
  }
  for (const [mode, field, code] of [
    ['empty', 'password', 'field'], ['wrong-value', 'password', 'field'], ['alias', 'password', 'field'],
    ['trash', 'password', 'revoked'], ['bad-state', 'note', 'refused'], ['wrong-id', 'password', 'refused'],
    ['wrong-share', 'password', 'refused'], ['bad-unit', 'note', 'refused'], ['bad-object', 'note', 'refused'],
    ['bad-array', 'note', 'refused'], ['multi-kind', 'note', 'refused'], ['unknown-kind', 'note', 'refused'],
  ]) {
    h.configure({ mode })
    equalPrivate(await h.read({ field }), fail(code))
  }
  const before = h.events().length
  equalPrivate(await h.read({ field: 'totp' }), fail('field'))
  equalPrivate(await h.read({ item: h.ref.item + '\n' }), fail('refused'))
  assert.equal(h.events().length, before)
  assert.equal(h.events().filter(event => event.operation === 'login').length, 1)
  assert.equal(new Set(h.events().flatMap(event => event.keyHash ?? [])).size, 1)
  h.scan()
  assert.equal(await h.adapter.lock(), true)
  assert.deepEqual(h.dirs(), [])
  h.scan()
})

test('known CLI errors and output cap fail closed and invalidated sessions lock', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  for (const [mode, code] of [
    ['share-missing', 'revoked'], ['unknown', 'refused'], ['offline', 'unavailable'], ['policy', 'refused'],
    ['warn', 'refused'], ['oversize', 'unavailable'],
  ]) {
    h.configure({ mode })
    equalPrivate(await h.read(), fail(code))
  }
  for (const mode of ['invalidated', 'invalidated-cause', 'auth']) {
    h.configure({ mode })
    equalPrivate(await h.read(), fail('auth'))
    assert.equal(h.adapter.session, undefined)
    assert.deepEqual(h.dirs(), [])
    equalPrivate(await h.read(), fail('locked'))
    h.configure({ mode: 'ok' })
    equalPrivate(await h.unlock(), ok)
  }
})

test('picker returns bounded metadata grouped by share without fetching any item details', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  const unknown = { ...h.first, id: newId(), title: 'Unknown needle', item_type: 'future_kind' }
  h.configure({ items: [
    { ...h.first, id: 'bad' }, { ...h.first, share_id: newId() }, { ...h.first, item_type: 5 },
    unknown, ...Array.from({ length: 60 }, () => ({ ...h.first, id: newId() })),
  ] })
  const find = await h.list({ search: 'NEEDLE' })
  assert.deepEqual(find, { ok: true, items: [{ id: h.share + '/' + unknown.id, name: unknown.title,
    vault: 'Fixture vault', fields: [{ id: 'note', label: 'Note' }] }] })
  const all = await h.list()
  assert.equal(all.items.length, 50)
  assert.deepEqual(all.items[1].fields.map(row => row.id), ['username', 'email', 'password', 'note'])
  assert.equal(h.operations().includes('item view'), false)
})

test('read timeout and whole picker deadline kill a hanging fake CLI', async t => {
  const timers = fakeClock()
  const h = fixture(t, { timers, runner: (args, settings, invoke) => args[1] === 'view'
    ? runPass(args, { ...settings, timeout: 350 }, { parent: { PATH: h.root } }) : invoke() })
  equalPrivate(await h.unlock(), ok)
  h.configure({ mode: 'read-hang' })
  equalPrivate(await h.read(), fail('unavailable'))
  h.configure({ mode: 'list-hang' })
  const listing = h.list()
  await h.until('item list')
  timers.tick(10000)
  equalPrivate(await listing, fail('unavailable'))
})

test('replacement and lock during login retire the right record exactly once', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  const first = h.adapter.session
  const [firstDir] = h.dirs()
  h.configure({ tokenHash: digest(h.replacement) })
  equalPrivate(await h.unlock({ token: h.replacement }), ok)
  assert.equal(existsSync(firstDir), false)
  assert.equal(h.dirs().length, 1)
  assert.notEqual(h.adapter.session, first)
  h.configure({ mode: 'invalid-token' })
  equalPrivate(await h.unlock({ token: h.replacement }), fail('auth'))
  assert.deepEqual(h.dirs(), [])
  assert.equal(h.adapter.session, undefined)

  h.configure({ mode: 'login-hang' })
  const interrupted = h.unlock({ token: h.replacement })
  await h.until('login', 4)
  const [interruptedDir] = h.dirs()
  const locked = h.adapter.lock()
  h.configure({ mode: 'ok' })
  const replacing = h.unlock({ token: h.replacement })
  assert.equal(await locked, true)
  equalPrivate(await interrupted, fail('locked'))
  equalPrivate(await replacing, ok)
  assert.equal(existsSync(interruptedDir), false)
  assert.equal(h.dirs().length, 1)
  assert.equal(h.events().filter(row => row.operation === 'logout' && row.dir === interruptedDir).length, 1)
})

test('switch admission and removal retries preserve selection until cleanup succeeds', async t => {
  const h = fixture(t, { mounted: true })
  const remove = fs.rmSync
  let failRemoval = false
  const mocked = t.mock.method(fs, 'rmSync', (path, options) => {
    if (failRemoval && h.dirs().includes(path)) throw Object.assign(new Error('fixture removal refused'), { code: 'EPERM' })
    return remove(path, options)
  })
  syncBuiltinESMExports()
  try {
    const service = h.mount()
    assert.equal(Object.keys(service).includes('sessionOf'), false)
    equalPrivate(await h.unlock(), ok)
    const identity = service.sessionOf({ provider })
    assert.equal(service.sessionOf({ provider: 'bitwarden' }), undefined)
    const selection = service.providerSelection
    const before = h.events().length
    equalPrivate(await h.unlock({ connection: 'other' }), fail('refused'))
    equalPrivate(await h.unlock({ token: h.credential + '=' }), fail('refused'))
    assert.equal(service.providerSelection, selection)
    assert.equal(service.sessionOf({ provider }), identity)
    assert.equal(h.events().length, before)

    failRemoval = true
    const switchAway = () => service.unlock({ provider: 'onepassword', token: h.replacement, connection: 'fixture' })
    equalPrivate(await switchAway(), fail('unavailable'))
    equalPrivate(await switchAway(), fail('unavailable'))
    assert.equal(service.providerSelection, selection)
    assert.equal(service.sessionOf({ provider }), undefined)
    assert.equal(h.dirs().length, 1)
    assert.equal(h.operations().filter(op => op === 'logout').length, 1)
    failRemoval = false
    equalPrivate(await switchAway(), fail('unavailable')) // Only the fake pass-cli is on PATH.
    assert.equal(service.providerSelection.provider, 'onepassword')
    assert.deepEqual(h.dirs(), [])
    const switched = service.providerSelection
    const count = h.events().length
    equalPrivate(await h.unlock({ token: h.credential + '=' }), fail('refused'))
    assert.equal(service.providerSelection, switched)
    assert.equal(h.events().length, count)
    equalPrivate(await h.unlock(), ok)
    equalPrivate(await h.dispose(), ok)
    assert.deepEqual(h.dirs(), [])
    assert.equal(h.operations().filter(op => op === 'logout').length, 2)
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})

test('logout failures and hangs still remove the session within the quit budget', async t => {
  const h = fixture(t)
  equalPrivate(await h.unlock(), ok)
  h.configure({ mode: 'logout-fail' })
  assert.equal(await h.adapter.lock(), true)
  assert.deepEqual(h.dirs(), [])
  equalPrivate(await h.unlock(), ok)
  h.configure({ mode: 'logout-hang' })
  const start = performance.now()
  equalPrivate(await h.adapter.prepareQuit(), ok)
  assert.ok(performance.now() - start < 4250)
  assert.deepEqual(h.dirs(), [])
  assert.equal(h.operations().filter(op => op === 'logout').length, 2)
})

test('an aborted child that never closes cannot hold up local removal', async t => {
  const h = fixture(t, { runner: (args, { signal }, invoke) => {
    if (args[1] !== 'view') return invoke()
    started.resolve(signal)
    return hung.promise
  } })
  const started = Promise.withResolvers()
  const hung = Promise.withResolvers()
  equalPrivate(await h.unlock(), ok)
  const read = h.read()
  const signal = await started.promise
  const start = performance.now()
  try {
    assert.equal(await h.adapter.lock(), true)
    assert.equal(signal.aborted, true)
    assert.ok(performance.now() - start < 4500)
    assert.deepEqual(h.dirs(), [])
    assert.equal(h.operations().includes('logout'), false)
  } finally { hung.resolve({ failure: 'cancelled' }) }
  equalPrivate(await read, fail('locked'))
})

test('idle and absolute expiry lock, and an in-session version change skips logout', async t => {
  const timers = fakeClock()
  const h = fixture(t, { timers, idleLockMinutes: 1 })
  equalPrivate(await h.unlock(), ok)
  timers.tick(60000)
  assert.equal(h.adapter.session, undefined)
  await h.until('logout')
  await h.adapter.lock()
  assert.deepEqual(h.dirs(), [])

  equalPrivate(await h.unlock(), ok)
  const now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now + absoluteMs)
  assert.equal(h.adapter.session, undefined)
  equalPrivate(await h.read(), fail('locked'))
  await h.adapter.lock()
  assert.deepEqual(h.dirs(), [])
  clock.mock.restore()

  equalPrivate(await h.unlock(), ok)
  h.configure({ version: 'Proton Pass CLI 2.8.0 (fixture)' })
  equalPrivate(await h.read(), fail('version'))
  assert.equal(h.adapter.session, undefined)
  assert.deepEqual(h.dirs(), [])
  equalPrivate(await h.unlock(), fail('version'))
  h.configure({ version: validVersion })
  equalPrivate(await h.unlock(), ok)
  h.configure({ version: 'Proton Pass CLI 2.8.0 (fixture)' })
  assert.equal(await h.adapter.lock(), true)
  assert.deepEqual(h.dirs(), [])
  assert.equal(h.operations().filter(op => op === 'logout').length, 2)
})

test('successful reads renew idle time only up to the absolute deadline', async t => {
  const timers = fakeClock()
  const h = fixture(t, { timers, idleLockMinutes: 480 })
  let now = Date.now()
  const clock = t.mock.method(Date, 'now', () => now)
  const tick = ms => { now += ms; timers.tick(ms) }
  try {
    equalPrivate(await h.unlock(), ok)
    tick(absoluteMs - 1000)
    equalPrivate(await h.read(), { ok: true, value: h.value() })
    tick(999)
    assert.equal(h.operations().includes('logout'), false)
    tick(1)
    await h.until('logout')
    assert.equal(h.adapter.session, undefined)
    assert.equal(await h.adapter.lock(), true)
    assert.deepEqual(h.dirs(), [])
  } finally { clock.mock.restore() }
})

test('startup sweeps only dead-pid directories and cloud or tracing refuses credentialed children', async t => {
  const h = fixture(t)
  const dead = h.path('automagik-proton-pass-2147483647-gone')
  const live = h.path('automagik-proton-pass-' + process.pid + '-alive')
  mkdirSync(dead)
  mkdirSync(live)
  createProtonPass({}, { root: h.root })
  assert.equal(existsSync(dead), false)
  assert.equal(existsSync(live), true)
  rmSync(live, { recursive: true })
  const previous = process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE
  process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE = 'fixture'
  try {
    await assert.rejects(h.adapter.status(), { code: 'cloud' })
    equalPrivate(await h.unlock(), fail('cloud'))
    equalPrivate(await h.read(), fail('cloud'))
    equalPrivate(await h.list(), fail('cloud'))
  } finally {
    if (previous === undefined) delete process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE
    else process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE = previous
  }
  const trace = t.mock.method(inspector, 'url', () => 'fixture inspector')
  syncBuiltinESMExports()
  try { equalPrivate(await h.unlock(), fail('refused')) }
  finally { trace.mock.restore(); syncBuiltinESMExports() }
  assert.deepEqual(h.events(), [])
})

test('all admitted built-in fields use exact properties and every picker kind has its fixed field list', () => {
  const share = newId(), id = newId()
  const fields = {
    Login: ['username', 'email', 'password'],
    CreditCard: ['cardholder_name', 'number', 'verification_number', 'expiration_date', 'pin'],
    Wifi: ['ssid', 'password'], SshKey: ['private_key'],
    Note: [], Alias: [], Identity: [], Custom: [],
  }
  assert.deepEqual([...FIELDS], ['username', 'email', 'password', 'note', 'cardholder_name', 'number',
    'verification_number', 'expiration_date', 'pin', 'ssid', 'private_key'])
  for (const [kind, allowed] of Object.entries(fields)) {
    const payload = Object.fromEntries(allowed.map(field => [field, '  exact ' + field + '\n']))
    const content = { [kind]: ['Note', 'Alias'].includes(kind) ? null : payload }
    const result = { code: 0, stderr: '', stdout: JSON.stringify({ item: {
      id, share_id: share, state: 'Active', content: { title: 'Fixture', note: '  exact note\n', content,
        extra_fields: [{ name: 'password', content: { Hidden: 'shadow' } }] },
    } }) }
    equalPrivate(selectField(result, share, id, 'note'), { ok: true, value: '  exact note\n' })
    for (const field of FIELDS) equalPrivate(selectField(result, share, id, field),
      field === 'note' ? { ok: true, value: '  exact note\n' }
        : allowed.includes(field) ? { ok: true, value: payload[field] } : fail('field'))
  }
  for (const [kind, ids] of Object.entries({ login: [...fields.Login, 'note'],
    credit_card: [...fields.CreditCard, 'note'], wifi: [...fields.Wifi, 'note'],
    ssh_key: [...fields.SshKey, 'note'], future_kind: ['note'] })) {
    assert.deepEqual(pickerFields(kind).map(row => row.id), ids)
    assert.ok(pickerFields(kind).every(row => typeof row.label === 'string' && row.label.length > 0))
  }
})

test('admission is canonical and failed login confirmation or vault listing retires its record', async t => {
  const h = fixture(t, { runner: async (args, settings, invoke) => {
    const result = await invoke()
    if (args[0] === 'login' && badLogin) return { ...result, stdout: 'Successfully logged in\n' }
    if (args[0] === 'vault' && badVault) return { ...result, stdout: '{"vaults":null}' }
    return result
  } })
  let badLogin = true, badVault = false
  assert.equal(validToken(h.credential), true)
  for (const malformed of [null, 5, h.credential.replace(/^pst_./, 'pst_:'),
    h.credential.replace(/^pst_./, 'pst_ '), h.credential.slice(0, -1) + '*']) {
    assert.equal(validToken(malformed), false)
    equalPrivate(await h.unlock({ token: malformed }), fail('refused'))
  }
  assert.deepEqual(h.events(), [])
  equalPrivate(await h.unlock(), fail('refused'))
  assert.deepEqual(h.dirs(), [])
  badLogin = false; badVault = true
  equalPrivate(await h.unlock(), fail('refused'))
  assert.deepEqual(h.dirs(), [])
  badVault = false
  equalPrivate(await h.unlock(), ok)
  h.scan()
  assert.equal(h.events().filter(row => row.operation === 'login').length, 3)
})

test('status gates both locked and live sessions on CLI 2.7.1 and local lock is idempotent', async t => {
  const h = fixture(t)
  equalPrivate(await h.adapter.status(), { state: 'locked' })
  assert.equal(await h.adapter.lock(), true)
  h.configure({ version: 'Proton Pass CLI 2.7.2 (fixture)' })
  await assert.rejects(h.adapter.status(), { message: 'The vault did not answer.' })
  h.configure({ version: validVersion })
  equalPrivate(await h.unlock(), ok)
  h.configure({ version: 'Proton Pass CLI 2.7.2 (fixture)' })
  await assert.rejects(h.adapter.status(), { message: 'The vault did not answer.' })
  assert.equal(h.adapter.session, undefined)
  assert.deepEqual(h.dirs(), [])
  assert.equal(await h.adapter.lock(), true)
})

test('Proton documentation states setup, private session lifetime and unsupported access', () => {
  const vault = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(vault, /Proton Pass CLI 2\.7\.1/)
  assert.match(vault, /read access to a\s+vault/)
  assert.match(vault, /Settings › Secrets › Vault › Proton Pass/)
  assert.match(vault, /used once to sign in and is dropped/)
  assert.match(vault, /encrypted session\s+in a private temporary folder with a memory-only key/)
  assert.match(vault, /\*\*Lock\*\*, idle lock, a provider switch, disabling the plugin and quitting remove/)
  assert.match(vault, /110 minutes/)
  for (const phrase of ['built-in fields', 'Custom fields', 'individually shared items', 'Agent tokens',
    'Proton may record reads', 'Forward proxies are unsupported', 'unavailable in Automagik Cloud']) {
    assert.ok(vault.includes(phrase), phrase)
  }
})

test('Windows runner resolves pass-cli.exe without a shell and strips ambient credentials', async () => {
  const calls = []
  const parent = { PATH: 'C:\\Tools', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', COMSPEC: 'C:\\Windows\\cmd.exe',
    HTTPS_PROXY: 'secret proxy', PROTON_PASS_AGENT_REASON: 'secret reason',
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: 'ambient token', RUST_BACKTRACE: 'full' }
  const spawnChild = (file, args, options) => {
    calls.push({ file, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('close', 0, null))
    return child
  }
  const options = { platform: 'win32', parent, exists: file => file === 'C:\\Tools\\pass-cli.exe', spawnChild }
  equalPrivate(await runPass(['--version'], { timeout: 5000 }, options), { code: 0, stdout: '', stderr: '' })
  const record = { dir: 'C:\\Temp\\record', home: 'C:\\Temp\\record\\home', key: randomBytes(32).toString('base64url') }
  equalPrivate(await runPass(['login'], { record, token: 'fixture credential', timeout: 15000 }, options),
    { code: 0, stdout: '', stderr: '' })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.file, 'C:\\Tools\\pass-cli.exe')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.windowsHide, true)
    assert.equal(call.options.env.HTTPS_PROXY, undefined)
    assert.equal(call.options.env.PROTON_PASS_AGENT_REASON, undefined)
    assert.equal(call.options.env.RUST_BACKTRACE, undefined)
  }
  assert.deepEqual(calls[0].args, ['--version'])
  assert.equal(calls[0].options.env.PROTON_PASS_ENCRYPTION_KEY, undefined)
  assert.equal(calls[0].options.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, undefined)
  assert.deepEqual(calls[1].args, ['login'])
  assert.equal(calls[1].options.env.PROTON_PASS_ENCRYPTION_KEY, record.key)
  assert.equal(calls[1].options.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, 'fixture credential')
})

test('each CLI operation receives its fixed timeout', async t => {
  const limits = new Map()
  const h = fixture(t, { runner: (args, settings, invoke) => {
    limits.set(args[0] === '--version' ? 'version' : args.slice(0, 2).join(' '), settings.timeout)
    return invoke()
  } })
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.read(), { ok: true, value: h.value() })
  assert.equal((await h.list()).ok, true)
  assert.equal(await h.adapter.lock(), true)
  assert.deepEqual(Object.fromEntries(limits), {
    version: 5000, login: 15000, 'vault list': 10000, 'item view': 10000,
    'item list': 10000, logout: 3000,
  })
})
