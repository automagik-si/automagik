import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { endpointOf } from '../../vault-dsh/src/hashicorp-vault/parse.js'
import { privateInputs } from '../../vault-dsh/test/fixtures/fake-vault.mjs'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const provider = 'hashicorp-vault'
const bot = 'local-fixture'
const name = 'FIXTURE_KEY'
const command = 'fixture-command'
const mismatch = 'This mapping belongs to another Vault server; connect to that server or map again.'
const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const noRead = 'Vault values cannot reach a shell on this version; nothing was read.'
const local = { origin: 'http://localhost', host: 'localhost' }
const success = { ok: true, value: true }
const same = (actual, expected) => assert.equal(JSON.stringify(actual) === JSON.stringify(expected), true, 'only expected fields are returned')

async function team(t, { existing = false, legacy = false, d4Selection = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hashicorp-routes-'))
  const input = privateInputs(randomBytes(32).toString('hex'))
  const tokenOptions = { provider, address: input.address, token: input.token, namespace: input.namespace }
  const connection = endpointOf(input.address, input.namespace).connection
  const reference = { provider, connection, item: JSON.stringify([input.mount, input.path]), field: input.field, scope: 'all' }
  const write = (file, data) => writeFileSync(join(home, file), JSON.stringify(data))
  write('state.json', { version: 1, revision: 1, mainBotIds: [bot], rooms: {}, exchanges: [], questions: {},
    bots: { [bot]: { id: bot, sessionId: bot, name: 'Local Fixture', role: 'Coordinator' } } })
  if (existing) write('vault-sources.json', { version: 1, sources: { [name]: reference } })
  const calls = []
  const notes = []
  const warnings = []
  const reported = []
  let current
  let cloud = false
  let picker
  const service = {
    ...(legacy ? {} : { providers: ['bitwarden', 'onepassword', provider] }),
    ...(d4Selection ? { providerSelection: { provider: 'bitwarden', generation: 0 } } : {}),
    connectionFor: options => endpointOf(options.address, options.namespace)?.connection,
    activeConnection: () => current === undefined ? undefined : { provider, connection: current },
    status(options) {
      calls.push('status' + (options?.provider === provider ? ':vault' : ':legacy'))
      if (cloud && options?.provider === provider) throw Object.assign(new Error('fixture'), { code: 'cloud' })
      return { state: current === undefined ? 'locked' : 'unlocked' }
    },
    unlock(options) {
      calls.push(options.provider === provider && options.token === input.token
        ? (options.mount === input.mount ? 'connect-mapped' : options.mount === undefined ? 'connect' : 'invalid') : 'invalid')
      if (cloud) return { ok: false, code: 'cloud' }
      if (service.providerSelection !== undefined && service.providerSelection.provider !== options.provider) {
        service.providerSelection = { provider: options.provider, generation: service.providerSelection.generation + 1 }
      }
      current = endpointOf(options.address, options.namespace).connection
      return { ok: true }
    },
    lock(options) {
      calls.push(options?.provider === provider ? 'lock:vault' : 'lock:all')
      current = undefined
      return true
    },
    listItems(options) {
      if (options.provider !== provider || options.connection !== current || options.mount !== input.mount) calls.push('invalid')
      calls.push('items')
      if (picker !== undefined) return picker(options.signal)
      return { ok: true, items: options.folder === ''
        ? [{ id: 'fixture-folder', name: 'fixture-folder/', folder: true, unrelated: input.value },
          { id: '../unsafe', name: 'unsafe', folder: false }]
        : [{ id: 'fixture-folder/' + input.path, name: input.path, folder: false }] }
    },
    listFields(options) {
      if (options.provider !== provider || options.connection !== current || options.mount !== input.mount || options.path !== input.path) calls.push('invalid')
      calls.push('fields')
      return { ok: true, fields: [input.field, input.field, 'bad\0field'], unrelated: input.value }
    },
    read() { calls.push('read'); assert.fail('no adapter read may follow Allow') },
  }
  const ctx = fakeContext({ services: { secretSources: service } })
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  rt.deliver = async note => { notes.push(note) }
  rt.noteFailure = failure => { reported.push(failure) }
  const canaries = Object.values(input)
  t.after(async () => {
    try {
      await ctx.dispose()
      assert.equal(calls.includes('invalid'), false)
      const logs = JSON.stringify([notes, warnings, reported, calls])
      assert.equal(canaries.some(text => logs.includes(JSON.stringify(text).slice(1, -1))), false)
      for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const file = readFileSync(join(entry.parentPath, entry.name), 'utf8')
        const forbidden = entry.name === 'vault-sources.json' ? [input.token, input.address, input.namespace, input.value] : canaries
        assert.equal(forbidden.some(text => file.includes(text) || file.includes(JSON.stringify(text).slice(1, -1))), false, 'private fixture material stayed within the mapping boundary')
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await rt.load()
  const request = async (endpoint, payload = {}, headers = local) => {
    const response = await route.fetch(new Request('http://dsh.internal/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    const body = await response.json()
    assert.equal([input.token, input.address, input.namespace, input.value].some(text => JSON.stringify(body).includes(JSON.stringify(text).slice(1, -1))), false)
    return { body, cache: response.headers.get('cache-control') }
  }
  const call = async (...args) => (await request(...args)).body
  const agent = { id: bot, session: { id: bot, header: { id: bot, cwd: home } } }
  const ask = () => ctx.registeredTools.get('request_secret').execute({ name, command, shell: 'bash', purpose: 'Use the fixture' }, { agent })
  const card = () => rt.state.secretRequests?.[bot]?.at(-1)
  const detail = () => call('secret-source-detail', { requestId: card().id })
  const allow = ({ commandDigest, snapshot }, requestId = card().id) => call('secret-allow', { requestId, commandDigest, snapshot })
  const execute = () => ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')(
    { name: 'bash', arguments: { command }, agent }, () => 'fixture shell')
  const audit = () => {
    const path = join(home, 'vault-audit.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : []
  }
  return { call, request, calls, rt, ask, card, detail, allow, execute, audit, reference, input,
    selection: () => service.providerSelection,
    set: (options = {}, headers) => request('vault-token-set', { ...tokenOptions, ...options }, headers),
    lock: () => call('vault-lock', { provider }),
    genericLock: () => call('vault-lock'),
    clear: () => call('vault-token-clear', { provider }),
    itemArgs: { provider, mount: input.mount },
    map: () => call('secret-source-set', { name, ...reference }),
    setCloud: () => { cloud = true },
    setPicker: callback => { picker = callback },
  }
}

test('local Vault Settings routes dispatch explicitly, round-trip mappings and keep picker shapes private', async t => {
  const h = await team(t)
  const initial = await h.call('vault-status', { provider })
  assert.deepEqual(initial.value.providers, ['bitwarden', 'onepassword', provider])
  assert.equal(initial.value.state, 'locked')
  assert.equal((await h.set({}, { origin: 'https://example.invalid' })).body.ok, false)
  assert.equal((await h.set({}, { ...local, 'x-automagik-principal': 'fixture' })).body.ok, false)
  assert.equal(h.calls.includes('connect'), false)
  const response = await h.set()
  same(response, { body: success, cache: 'no-store' })
  assert.equal((await h.call('vault-status')).value.connection === h.reference.connection, true)
  same((await h.call('vault-items', h.itemArgs)).value, { items: [{ id: 'fixture-folder', name: 'fixture-folder/', folder: true }] })
  same((await h.call('vault-items', { ...h.itemArgs, folder: 'fixture-folder' })).value,
    { items: [{ id: 'fixture-folder/' + h.input.path, name: h.input.path, folder: false }] })
  const field = await h.request('vault-fields', { ...h.itemArgs, path: h.input.path })
  same(field.body.value, { fields: [h.input.field] })
  assert.equal(field.cache, 'no-store')
  assert.equal((await h.map()).ok, true)
  assert.equal((await h.call('secret-source-set', { ...h.reference, name: 'OTHER_KEY', connection: 'hv:' + '0'.repeat(32) })).ok, false)
  assert.equal((await h.call('vault-unlock', { password: 'fixture' })).ok, false)
  assert.equal((await h.set()).body.ok, true)
  assert.equal(h.calls.includes('connect-mapped'), true)
  same(await h.lock(), success)
  assert.equal((await h.call('vault-status')).value.state, 'locked')
  same(await h.call('vault-token-clear', { provider }), success)
  assert.equal(h.calls.filter(op => op === 'lock:vault').length, 2)
})

test('a replaced address or namespace refuses the prior identity and cancels cards, grants and picker work', async t => {
  for (const setting of ['address', 'namespace']) await t.test(setting, async t => {
    const h = await team(t, { existing: true })
    assert.equal(await h.ask(), locked)
    same((await h.set()).body, success)
    await h.ask()
    const approval = h.card()
    const initial = (await h.detail()).value
    same(await h.allow(initial), success)
    await h.ask()
    const pending = h.card()
    const details = (await h.detail()).value
    const started = Promise.withResolvers()
    h.setPicker(async signal => {
      started.resolve()
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { ok: false, code: 'locked' }
    })
    const picker = h.call('vault-items', h.itemArgs)
    await started.promise
    same((await h.set({ [setting]: h.input[setting] + (setting === 'address' ? '/alt' : '-alt') })).body, success)
    assert.equal((await picker).ok, false)
    assert.equal(pending.status, 'canceled')
    assert.equal(approval.status, 'allowed')
    assert.equal((await h.allow(details, pending.id)).error?.message, mismatch)
    assert.equal(await h.execute(), 'fixture shell')
    assert.equal((await h.call('vault-status')).value.reason, mismatch)
    assert.equal((await h.call('vault-items', h.itemArgs)).error?.message, mismatch)
    assert.equal((await h.call('vault-fields', { ...h.itemArgs, path: h.input.path })).error?.message, mismatch)
    assert.match(await h.ask(), /nothing was read/)
    assert.equal(h.audit().filter(row => row.decision === 'canceled' && row.result === 'revoked').length, 2)
    same((await h.set()).body, success)
    await h.ask()
    assert.equal(h.card().status, 'pending')
  })
})

test('D4 provider selection stays on HashiCorp while an endpoint replacement revokes its old connection', async t => {
  for (const setting of ['address', 'namespace']) await t.test(setting, async t => {
    const h = await team(t, { existing: true, d4Selection: true })
    assert.deepEqual(h.selection(), { provider: 'bitwarden', generation: 0 })
    same((await h.set()).body, success)
    assert.deepEqual(h.selection(), { provider, generation: 1 })
    await h.ask()
    const oldCard = h.card()
    const snapshot = (await h.detail()).value
    same(await h.allow(snapshot), success)
    await h.ask()
    const pending = h.card()
    const pendingSnapshot = (await h.detail()).value
    same((await h.set({ [setting]: h.input[setting] + '-replacement' })).body, success)
    assert.deepEqual(h.selection(), { provider, generation: 1 })
    assert.equal(pending.status, 'canceled')
    assert.equal((await h.allow(pendingSnapshot, pending.id)).error?.message, mismatch)
    assert.equal(await h.execute(), 'fixture shell')
    assert.equal((await h.call('vault-status')).value.reason, mismatch)
    assert.equal(h.audit().filter(row => row.decision === 'canceled' && row.result === 'revoked').length, 2)
    assert.equal(oldCard.status, 'allowed')
  })
})

test('matching connection allows one attempt and saves two audit decisions with no picker or read during execution', async t => {
  const h = await team(t, { existing: true })
  same((await h.set()).body, success)
  await h.call('vault-items', h.itemArgs)
  await h.call('vault-fields', { ...h.itemArgs, path: h.input.path })
  const before = h.calls.filter(op => ['items', 'fields', 'read'].includes(op)).length
  await h.ask()
  const snapshot = await h.detail()
  assert.equal(snapshot.value.item === h.reference.item && snapshot.value.field === h.reference.field, true)
  same(await h.allow(snapshot.value), success)
  assert.equal((await h.execute()).error.message, noRead)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal(h.calls.filter(op => ['items', 'fields', 'read'].includes(op)).length, before)
  assert.deepEqual(h.audit().slice(-2).map(row => [row.decision, row.result]), [['allowed', 'ok'], ['refused', 'refused']])
  same(await h.lock(), success)
})

test('a lock fences a token set queued behind a mapping mutation', async t => {
  const h = await team(t, { existing: true })
  same((await h.set()).body, success)
  await h.ask()
  const writing = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.rt.deliver = async () => { writing.resolve(); await release.promise }
  const mutation = h.call('secret-source-clear', { name })
  await writing.promise
  const admitted = { 'vault-token-set': Promise.withResolvers(), 'vault-lock': Promise.withResolvers() }
  const dispatch = h.rt.vaultEndpoint
  t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
    const response = dispatch(...args)
    admitted[args[0]]?.resolve()
    return response
  })
  const pending = h.set()
  await admitted['vault-token-set'].promise
  const lock = h.lock()
  await admitted['vault-lock'].promise
  release.resolve()
  same(await lock, success)
  same(await mutation, success)
  assert.equal((await pending).body.error?.message, locked)
  assert.equal(h.calls.filter(op => op.startsWith('connect')).length, 1)
})

test('a HashiCorp token clear fences a token set queued behind a mapping mutation', async t => {
  const h = await team(t, { existing: true })
  same((await h.set()).body, success)
  await h.ask()
  const writing = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.rt.deliver = async () => { writing.resolve(); await release.promise }
  const mutation = h.call('secret-source-clear', { name })
  await writing.promise
  const admitted = { 'vault-token-set': Promise.withResolvers(), 'vault-token-clear': Promise.withResolvers() }
  const dispatch = h.rt.vaultEndpoint
  t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
    const response = dispatch(...args)
    admitted[args[0]]?.resolve()
    return response
  })
  const pending = h.set()
  await admitted['vault-token-set'].promise
  const clear = h.clear()
  await admitted['vault-token-clear'].promise
  release.resolve()
  same(await clear, success)
  same(await mutation, success)
  assert.equal((await pending).body.error?.message, locked)
  assert.equal((await h.call('vault-status')).value.state, 'locked')
  assert.equal(h.calls.filter(op => op.startsWith('connect')).length, 1)
  assert.equal(h.calls.includes('lock:vault'), true)
})

test('generic vault-lock reaches and locks the active HashiCorp adapter', async t => {
  const h = await team(t, { existing: true, d4Selection: true })
  same((await h.set()).body, success)
  assert.deepEqual(h.selection(), { provider, generation: 1 })
  await h.ask()
  same(await h.genericLock(), success)
  assert.equal(h.calls.includes('lock:all'), true)
  assert.equal((await h.call('vault-status')).value.state, 'locked')
  assert.equal(await h.ask(), locked)
})

test('Cloud refuses credential entry and legacy services expose no HashiCorp operations', async t => {
  const cloud = await team(t)
  cloud.setCloud()
  assert.match((await cloud.set()).body.error?.message, /unavailable in Automagik Cloud/)
  assert.match((await cloud.call('vault-status', { provider })).value.reason, /unavailable in Automagik Cloud/)
  const old = await team(t, { existing: true, legacy: true })
  assert.equal((await old.call('vault-status')).value.state, 'unavailable')
  assert.equal((await old.set()).body.ok, false)
  assert.equal((await old.call('vault-items', old.itemArgs)).ok, false)
  assert.equal(old.calls.length, 0)
})
