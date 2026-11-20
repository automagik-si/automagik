import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import inspector from 'node:inspector'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { apply } from '../index.js'
import { createHashicorpVault } from '../src/hashicorp-vault/adapter.js'
import { canonicalNamespace, endpointOf, provider } from '../src/hashicorp-vault/parse.js'
import { runVault } from '../src/hashicorp-vault/run.js'
import { privateInputs } from './fixtures/fake-vault.mjs'
import { equalPrivate, fakeClock } from './fixtures/harness.mjs'

const tokenOf = () => randomBytes(32).toString('hex')
const reference = (input, connection, field = input.field) => ({
  provider, connection, item: JSON.stringify([input.mount, input.path]), field,
})

function fake(t, { timers, timeout } = {}) {
  if (process.platform === 'win32') { t.skip('POSIX executable fixture'); return }
  const root = mkdtempSync(join(tmpdir(), 'vault-kv-test-'))
  const bin = join(root, 'vault')
  const home = join(root, 'ambient')
  const cache = join(home, '.config', 'hcp', 'hvd')
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'hvd_proxy_config.json'), '{}')
  writeFileSync(join(home, '.vault-token'), '\n')
  writeFileSync(join(home, '.vault'), 'token_helper = "helper"\n')
  writeFileSync(join(root, 'helper'), '#!/bin/sh\nprintf "helper fail\\n" >> "' + join(root, 'calls') + '"\n', { mode: 0o700 })
  writeFileSync(bin, Buffer.concat([Buffer.from('#!' + process.execPath + '\n'), readFileSync(new URL('./fixtures/fake-vault.mjs', import.meta.url))]), { mode: 0o700 })
  const input = privateInputs(tokenOf())
  const connection = endpointOf(input.address, input.namespace).connection
  const configure = options => writeFileSync(join(root, 'controls'), JSON.stringify({
    check: createHash('sha256').update('check:' + input.token).digest('hex'), ...options,
  }))
  configure({})
  const commands = () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : []
  const parent = { PATH: root, HOME: home, USERPROFILE: home, VAULT_CONFIG_PATH: join(home, '.vault'), VAULT_ADDR: 'ignored',
    VAULT_TOKEN: 'ignored', VAULT_NAMESPACE: 'ignored', HCP_TEST: 'ignored', SSL_CERT_FILE: 'ignored', SSL_CERT_DIR: 'ignored',
    HTTPS_PROXY: 'ignored', HTTP_PROXY: 'ignored', NO_PROXY: 'ignored', GODEBUG: 'ignored', LD_PRELOAD: 'ignored', BW_PASSWORD: 'ignored' }
  const options = { timers, run: (args, settings) => runVault(args,
    timeout !== undefined && args[0] !== 'version' ? { ...settings, timeout } : settings, { parent, scratch: root }) }
  const vault = createHashicorpVault({ idleLockMinutes: 1 }, options)
  t.after(async () => {
    try {
      await vault.prepareQuit()
      assert.equal(commands().some(line => line.endsWith('fail')), false)
      assert.equal(readdirSync(root).some(name => name.startsWith('vault-cli-')), false)
      for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        const file = readFileSync(join(entry.parentPath, entry.name), 'utf8')
        assert.equal(Object.values(input).some(canary => file.includes(canary) || file.includes(JSON.stringify(canary).slice(1, -1))), false, 'scratch files contain no private fixture material')
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  return { vault, input, connection, options, configure, commands,
    connect: () => vault.unlock({ address: input.address, namespace: input.namespace, token: input.token }),
    read: field => vault.read(reference(input, connection, field)) }
}

test('verified KV v1 and v2 select exact own string fields and expose field names to the picker', async t => {
  for (const v1 of [true, false]) await t.test(v1 ? 'KV v1' : 'KV v2', async t => {
    const h = fake(t)
    if (!h) return
    h.configure({ v1 })
    equalPrivate(await h.connect(), { ok: true })
    equalPrivate(h.vault.status(), { state: 'unlocked' })
    assert.deepEqual(h.commands(), ['version pass', 'connect pass'])
    for (const [field, suffix] of [[h.input.field, ''], [' ' + h.input.field + ' ', 'padded'],
      ['request_id', 'request'], ['lease_id', 'lease'], ['data', 'data'], ['__proto__', 'own']]) {
      equalPrivate(await h.read(field), { ok: true, value: h.input.value + suffix })
    }
    for (const field of ['nothing', 'numeric', 'toString']) equalPrivate(await h.read(field), { ok: false, code: 'field' })
    const listed = await h.vault.listFields({ ...h.input, connection: h.connection })
    assert.equal(listed.ok && listed.fields.includes(h.input.field) && !JSON.stringify(listed).includes(JSON.stringify(h.input.value).slice(1, -1)), true)
    const args = { connection: h.connection, mount: h.input.mount }
    const root = await h.vault.listItems(args)
    assert.equal(root.items.length, 50)
    equalPrivate(root.items.slice(0, 2), [{ id: h.input.path, name: h.input.path, folder: false }, { id: 'folder', name: 'folder/', folder: true }])
    equalPrivate(await h.vault.listItems({ ...args, folder: 'folder' }), { ok: true, items: [{ id: 'folder/nested', name: 'nested', folder: false }] })
    h.configure({ v1, errors: { list: 'missing' } })
    equalPrivate(await h.vault.listItems(args), { ok: true, items: [] })
    h.configure({ v1, rotate: true })
    equalPrivate(await h.read(), { ok: true, value: h.input.value + 'rotated' })
    assert.deepEqual(h.commands().slice(-3), ['version pass', 'preflight pass', 'read pass'])
  })
})

test('mount and reference validation refuse aliases before the data child', async t => {
  const h = fake(t)
  if (!h) return
  equalPrivate(await h.connect(), { ok: true })
  for (const patch of [{ wrongMount: true }, { type: 'database' }, { engine: '3' }, { type: 'kv', v1: true }]) {
    h.configure(patch)
    equalPrivate(await h.read(), { ok: false, code: 'refused' })
    assert.deepEqual(h.commands().slice(-2), ['version pass', 'preflight pass'])
  }
  const size = h.commands().length
  for (const item of [JSON.stringify([h.input.mount, './path']), JSON.stringify([h.input.mount, '-path']),
    JSON.stringify([h.input.mount, 'a//b']), JSON.stringify([h.input.mount, 'a/../b']),
    JSON.stringify(['m'.repeat(128), 'p'.repeat(400)]), ' ' + reference(h.input, h.connection).item]) {
    equalPrivate(await h.vault.read({ ...reference(h.input, h.connection), item }), { ok: false, code: 'refused' })
  }
  assert.equal(h.commands().length, size)
})

test('policy, revocation, authentication, connection failure, and unknown diagnostics stay distinct', async t => {
  const h = fake(t)
  if (!h) return
  for (const [failure, code] of [['denied', 'denied'], ['auth', 'auth'], ['transport', 'unavailable']]) {
    h.configure({ errors: { preflight: failure } })
    equalPrivate(await h.vault.unlock({ ...h.input, mount: h.input.mount }), { ok: false, code })
    equalPrivate(h.vault.status(), { state: 'locked' })
  }
  h.configure({ errors: { connect: 'denied' } })
  equalPrivate(await h.connect(), { ok: true })
  for (const [failure, expected] of [['denied', { ok: false, code: 'revoked', audit: 'refused' }],
    ['missing', { ok: false, code: 'revoked' }], ['404', { ok: false, code: 'revoked' }],
    ['transport', { ok: false, code: 'unavailable' }], ['unknown', { ok: false, code: 'refused' }]]) {
    h.configure({ errors: { read: failure } })
    equalPrivate(await h.read(), expected)
  }
  h.configure({ deleted: true })
  equalPrivate(await h.read(), { ok: false, code: 'revoked' })
  h.configure({ errors: { read: 'expired' } })
  equalPrivate(await h.read(), { ok: false, code: 'auth' })
  equalPrivate(h.vault.status(), { state: 'locked' })
  equalPrivate(await h.read(), { ok: false, code: 'locked' })
})

test('stable 2.0 through 2.2 only, invalid endpoints and Cloud stay ahead of authenticated children', async t => {
  const h = fake(t)
  if (!h) return
  for (const version of ['Vault v2.0.0', 'Vault v2.1.7 (cgo)', 'Vault v2.2.1, built elsewhere']) {
    h.configure({ version })
    equalPrivate(await h.connect(), { ok: true })
  }
  for (const version of ['Vault v2.3.0', 'Vault v2.2.0-rc.1', 'Vault v2.0.0-beta', 'Vault v3.0.0', 'Vault v1.20.0']) {
    h.configure({ version })
    equalPrivate(await h.read(), { ok: false, code: 'version' })
    equalPrivate(h.vault.status(), { state: 'locked' })
    h.configure({})
    equalPrivate(await h.connect(), { ok: true })
  }
  const size = h.commands().length
  for (const address of ['', 'http://example.invalid', 'https://person@example.invalid', 'https://example.invalid/?', 'https://example.invalid/#', 'http://127.1']) {
    equalPrivate(await h.vault.unlock({ ...h.input, address }), { ok: false, code: 'refused' })
  }
  equalPrivate(await h.vault.unlock({ ...h.input, token: '' }), { ok: false, code: 'refused' })
  const previous = process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE
  process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE = 'fixture'
  try { equalPrivate(await h.connect(), { ok: false, code: 'cloud' }) }
  finally {
    if (previous === undefined) delete process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE
    else process.env.AUTOMAGIK_GATE_CLOUD_WORKSPACE = previous
  }
  assert.equal(h.commands().length, size)
})

test('canonical identity binds namespace and endpoint, and survives reconnect only', async t => {
  const timers = fakeClock()
  const h = fake(t, { timers })
  if (!h) return
  const { address, namespace } = h.input
  const expected = 'hv:' + createHash('sha256').update(JSON.stringify({ v: 1, address, namespace: canonicalNamespace(namespace) })).digest('hex').slice(0, 32)
  assert.equal(h.connection === expected, true)
  assert.equal(endpointOf(address.toUpperCase() + '/', namespace).connection === h.connection, true)
  assert.equal(endpointOf(address + '/prefix', namespace).connection === h.connection, false)
  assert.equal(endpointOf(address, namespace + '2').connection === h.connection, false)
  equalPrivate(await h.connect(), { ok: true })
  equalPrivate(await h.vault.read(reference(h.input, endpointOf(address, namespace + '2').connection)), { ok: false, code: 'connection' })
  timers.tick(60000)
  equalPrivate(await h.read(), { ok: false, code: 'locked' })
  equalPrivate(await h.connect(), { ok: true })
  await h.vault.retire()
  assert.equal(h.vault.connection, undefined)
  const restarted = createHashicorpVault({}, h.options)
  t.after(() => restarted.prepareQuit())
  equalPrivate(await restarted.read(reference(h.input, h.connection)), { ok: false, code: 'locked' })
  await restarted.unlock(h.input)
  equalPrivate(await restarted.read(reference(h.input, h.connection)), { ok: true, value: h.input.value })
  await restarted.prepareQuit()
  equalPrivate(await restarted.read(reference(h.input, h.connection)), { ok: false, code: 'locked' })
})

test('lock, idle expiry and dispose forget the endpoint and refuse reads before spawning', async t => {
  const timers = fakeClock()
  const h = fake(t, { timers })
  if (!h) return
  equalPrivate(await h.connect(), { ok: true })
  await h.vault.retire()
  assert.equal(h.vault.connection, undefined)
  let children = h.commands().length
  equalPrivate(await h.read(), { ok: false, code: 'locked' })
  assert.equal(h.commands().length, children)

  equalPrivate(await h.connect(), { ok: true })
  timers.tick(60000)
  assert.equal(h.vault.connection, undefined)
  children = h.commands().length
  equalPrivate(await h.read(), { ok: false, code: 'locked' })
  assert.equal(h.commands().length, children)

  equalPrivate(await h.connect(), { ok: true })
  await h.vault.prepareQuit()
  assert.equal(h.vault.connection, undefined)
  children = h.commands().length
  equalPrivate(await h.read(), { ok: false, code: 'locked' })
  assert.equal(h.commands().length, children)
})

test('child output cap, timeout and cancellation refuse without retaining output', async t => {
  const h = fake(t, { timeout: 700 })
  if (!h) return
  await h.connect()
  h.configure({ cap: 'read' })
  equalPrivate(await h.read(), { ok: false, code: 'refused' })
  h.configure({ hang: 'read' })
  equalPrivate(await h.read(), { ok: false, code: 'refused' })
  const count = h.commands().filter(line => line === 'read start').length
  const pending = h.read()
  for (let attempt = 0; attempt < 100 && h.commands().filter(line => line === 'read start').length === count; attempt++) await wait(5)
  assert.equal(h.commands().filter(line => line === 'read start').length, count + 1)
  await h.vault.retire()
  equalPrivate(await pending, { ok: false, code: 'locked' })
})

test('Windows lookup uses vault.exe and a case-insensitive exact allowlist', async () => {
  const calls = []
  const input = privateInputs(tokenOf())
  const parent = { Path: 'C:\\Vault', systemroot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe',
    Vault_AGENT_ADDR: 'ignored', VAULT_TOKEN: 'ignored', HCP_TEST: 'ignored', UserProfile: 'ignored' }
  const options = { platform: 'win32', parent, exists: file => file === win32.join(parent.Path, 'vault.exe'),
    spawnChild(file, args, launch) {
      calls.push({ file, args, launch })
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    } }
  equalPrivate(await runVault(['version'], {}, options), { code: 0, stdout: '', stderr: '' })
  equalPrivate(await runVault(['read', '-format=json', '--', 'sys/internal/ui/mounts'], { credential: input }, options), { code: 0, stdout: '', stderr: '' })
  const keys = ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'TMPDIR', 'LANG', 'VAULT_DISABLE_REDIRECTS', 'VAULT_CLI_NO_COLOR', 'VAULT_MAX_RETRIES']
  assert.deepEqual(Object.keys(calls[0].launch.env).sort(), keys.sort())
  assert.deepEqual(Object.keys(calls[1].launch.env).sort(), [...keys, 'VAULT_ADDR', 'VAULT_NAMESPACE', 'VAULT_TOKEN'].sort())
  assert.equal(calls[1].launch.env.VAULT_TOKEN === input.token, true)
  for (const { file, launch } of calls) {
    assert.equal(file, win32.join(parent.Path, 'vault.exe'))
    assert.equal(launch.shell, false)
    assert.deepEqual(launch.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(existsSync(launch.env.TMPDIR), false)
  }
})

test('replacing an endpoint cancels a data child and binds subsequent reads to the replacement', async () => {
  const input = privateInputs(tokenOf())
  const original = endpointOf(input.address, input.namespace).connection
  const namespace = input.namespace + '-alt'
  const replacement = endpointOf(input.address, namespace).connection
  const started = Promise.withResolvers()
  const run = async ([verb, , , path], { signal, credential }) => {
    const output = data => ({ code: 0, stdout: JSON.stringify({ data }), stderr: '' })
    if (verb === 'version') return { code: 0, stdout: 'Vault v2.2.2\n', stderr: '' }
    if (path === 'sys/internal/ui/mounts') return output({})
    if (path === 'sys/internal/ui/mounts/' + input.mount) {
      return output({ type: 'kv', path: input.mount + '/', options: { version: '1' } })
    }
    if (credential.namespace === canonicalNamespace(namespace)) return output({ [input.field]: input.value })
    started.resolve()
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { failure: 'cancelled' }
  }
  const vault = createHashicorpVault({}, { run })
  try {
    equalPrivate(await vault.unlock(input), { ok: true })
    const pending = vault.read(reference(input, original))
    await started.promise
    equalPrivate(await vault.unlock({ ...input, namespace }), { ok: true })
    equalPrivate(await pending, { ok: false, code: 'locked' })
    equalPrivate(await vault.read(reference(input, original)), { ok: false, code: 'connection' })
    equalPrivate(await vault.read(reference(input, replacement)), { ok: true, value: input.value })
  } finally { await vault.prepareQuit() }
})

test('the runner refuses tracing even on the credential-free version probe', async t => {
  const trace = t.mock.method(inspector, 'url', () => 'active')
  syncBuiltinESMExports()
  let starts = 0
  try {
    equalPrivate(await runVault(['version'], {}, { spawnChild() { starts++ } }), { failure: 'refused' })
    assert.equal(starts, 0)
  } finally {
    trace.mock.restore()
    syncBuiltinESMExports()
  }
})

test('the mounted service advertises Vault and preserves the enumerable v1 surface', async () => {
  let service
  apply({ provide(_name, value) { service = value }, effect() {} })
  try {
    assert.deepEqual(service.providers, ['bitwarden', 'onepassword', provider])
    assert.deepEqual(Object.keys(service).sort(), ['listItems', 'lock', 'prepareQuit', 'read', 'status', 'unlock', 'version'])
    equalPrivate(await service.unlock({ provider, token: '', address: '' }), { ok: false, code: 'refused' })
    equalPrivate(await service.status({ provider }), { state: 'locked' })
  } finally { await service.prepareQuit() }
})

test('the namespace takes the CLI\'s canonical form, so equivalent spellings are one connection', () => {
  const address = 'https://vault.example.invalid'
  assert.equal(canonicalNamespace(''), '')
  assert.equal(canonicalNamespace('  '), '')
  assert.equal(canonicalNamespace('team'), 'team/')
  assert.equal(canonicalNamespace(' /team/ '), 'team/')
  assert.equal(canonicalNamespace('a/b'), 'a/b/')
  const one = endpointOf(address, 'team')
  assert.equal(one.namespace, 'team/')
  assert.equal(endpointOf(address, '/team/').connection, one.connection)
  assert.notEqual(endpointOf(address, 'other').connection, one.connection)
  assert.notEqual(endpointOf(address, '').connection, one.connection)
})
