import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { PROTON_FIELDS, protonItems, validProtonConnection, validProtonItem, validProtonToken } from '../src/host/vault-proton.js'
import { FIELDS, validToken } from '../../vault-dsh/src/proton-pass/parse.js'

const provider = 'proton-pass'
const bot = 'local-fixture'
const name = 'FIXTURE_KEY'
const command = 'fixture-command'
const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const noRead = 'Vault values cannot reach a shell on this version; nothing was read.'
const success = { ok: true, value: true }
const id = () => randomBytes(64).toString('base64url') + '=='

async function team(t, { existing = false, legacy = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'proton-routes-'))
  const token = 'pst_' + randomBytes(32).toString('hex') + '::' + randomBytes(32).toString('base64url')
  const secret = randomBytes(32).toString('hex')
  const reference = { provider, connection: provider, item: id() + '/' + id(), field: 'password', scope: 'all' }
  const write = (file, value) => writeFileSync(join(home, file), JSON.stringify(value))
  write('state.json', { version: 1, revision: 1, mainBotIds: [bot], rooms: {}, exchanges: [], questions: {},
    bots: { [bot]: { id: bot, sessionId: bot, name: 'Local Fixture', role: 'Coordinator' } } })
  if (existing) write('vault-sources.json', { version: 1, sources: { [name]: reference } })
  const calls = [], notes = [], warnings = []
  let session, picker, failure
  const item = { id: reference.item, name: 'Fixture item', vault: 'Fixture vault',
    fields: [{ id: 'password', label: 'Password', value: secret }, { id: 'totp', label: secret }, { id: 'note', label: null }],
    value: secret }
  const service = {
    ...(legacy ? {} : { providers: ['bitwarden', 'onepassword', provider] }),
    sessionOf: options => options.provider === provider ? session : undefined,
    activeConnection: () => session === undefined ? undefined : { provider, connection: provider },
    status() {
      if (failure === 'cloud') throw Object.assign(new Error('fixture cloud'), { code: 'cloud' })
      return { state: session === undefined ? 'locked' : 'unlocked' }
    },
    unlock(options) {
      calls.push('set')
      assert.equal(options.provider === provider && options.connection === provider && options.token === token, true)
      assert.equal(options.signal instanceof AbortSignal && !options.signal.aborted, true)
      if (failure !== undefined) return { ok: false, code: failure }
      session = randomUUID()
      return { ok: true }
    },
    lock(options) {
      assert.equal(options?.provider, provider)
      calls.push('lock')
      session = undefined
      return true
    },
    listItems(options) {
      calls.push('items')
      assert.equal(options.provider === provider && options.connection === provider && options.signal instanceof AbortSignal, true)
      return picker?.(options.signal) ?? { ok: true,
        items: [{ ...item, id: '../bad' }, { ...item, name: 'x'.repeat(513) },
          { ...item, vault: null }, { ...item, fields: [{ id: 'totp', label: secret }] }, item] }
    },
    read() { calls.push('read'); assert.fail('the host must refuse shell delivery before reading') },
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
  const scan = value => assert.equal([token, secret].some(canary => value.includes(canary)), false, 'no plaintext canaries')
  t.after(async () => {
    try {
      await ctx.dispose()
      scan(JSON.stringify([notes, warnings, calls]))
      for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) scan(readFileSync(join(entry.parentPath, entry.name), 'utf8'))
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await rt.load()
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://dsh.internal/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers: { origin: 'http://localhost', host: 'localhost' },
    }))
    const answer = await response.json()
    scan(JSON.stringify(answer))
    return answer
  }
  const agent = { id: bot, session: { id: bot, header: { id: bot, cwd: home } } }
  const ask = () => ctx.registeredTools.get('request_secret').execute({ name, command, shell: 'bash', purpose: 'Use the fixture' }, { agent })
  const card = () => rt.state.secretRequests?.[bot]?.at(-1)
  const detail = () => call('secret-source-detail', { requestId: card().id })
  const allow = ({ commandDigest, snapshot }) => call('secret-allow', { requestId: card().id, commandDigest, snapshot })
  const execute = () => ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')(
    { name: 'bash', arguments: { command }, agent }, () => 'fixture shell')
  const audit = () => {
    const path = join(home, 'vault-audit.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : []
  }
  return { call, calls, rt, ask, card, detail, allow, execute, audit, reference,
    set: (patch = {}) => call('vault-token-set', { provider, token, ...patch }),
    lock: (patch = {}) => call('vault-lock', { provider, ...patch }),
    clear: (patch = {}) => call('vault-token-clear', { provider, ...patch }),
    list: () => call('vault-items', { provider, search: 'Fixture' }),
    map: (patch = {}) => call('secret-source-set', { name, ...reference, ...patch }),
    setFailure: code => { failure = code },
    setPicker: callback => { picker = callback },
    expire: () => { session = undefined },
  }
}

test('Settings restricts references, token entry and picker rows to the Proton contract', async t => {
  const h = await team(t)
  assert.deepEqual((await h.call('vault-status', { provider })).value.providers, ['bitwarden', 'onepassword', provider])
  assert.equal((await h.set({ token: 'bad' })).error.message, 'Enter your Proton Pass personal access token.')
  assert.equal((await h.set({ connection: 'wrong' })).ok, false)
  assert.deepEqual(h.calls, [])
  for (const [code, message] of [
    ['version', 'Install Proton Pass CLI 2.7.1.'], ['auth', 'The Proton Pass token could not be set.'],
    ['cloud', 'Proton Pass is unavailable in Automagik Cloud.'],
  ]) {
    h.setFailure(code)
    assert.equal((await h.set()).error.message, message)
  }
  assert.equal((await h.call('vault-status', { provider })).value.reason, 'Proton Pass is unavailable in Automagik Cloud.')
  h.setFailure(undefined)
  assert.deepEqual(await h.set(), success)
  assert.deepEqual((await h.list()).value.items, [{
    id: h.reference.item, name: 'Fixture item', vault: 'Fixture vault', fields: [{ selector: 'password', label: 'Password' }],
  }])
  for (const patch of [{ item: 'unsafe' }, { item: h.reference.item + '\n' }, { field: 'totp' }, { connection: 'wrong' }]) {
    assert.equal((await h.map(patch)).ok, false)
  }
  assert.equal((await h.map()).value.name, name)
  assert.equal((await h.lock({ connection: 'wrong' })).ok, false)
  assert.equal((await h.clear({ connection: 'wrong' })).ok, false)
  assert.equal((await h.call('vault-status', { provider })).value.state, 'unlocked')
  assert.deepEqual(await h.lock(), success)
  assert.deepEqual(await h.set({ connection: provider }), success)
  assert.deepEqual(await h.clear(), success)
  assert.equal((await h.call('vault-status', { provider })).value.state, 'locked')
})

test('legacy services refuse Proton clear without locking the legacy vault', async t => {
  const h = await team(t, { legacy: true })
  assert.equal((await h.clear()).ok, false)
  assert.deepEqual(h.calls, [])
})

test('Allow publishes a single consumed grant, and the first shell attempt records a refusal without an adapter read', async t => {
  const h = await team(t, { existing: true })
  assert.deepEqual(await h.set(), success)
  await h.ask()
  const { value } = await h.detail()
  assert.deepEqual([value.provider, value.item, value.field], [provider, h.reference.item, 'password'])
  assert.deepEqual(await h.allow(value), success)
  assert.equal((await h.execute()).error.message, noRead)
  assert.equal(await h.execute(), 'fixture shell')
  assert.deepEqual(h.audit().slice(-2).map(row => [row.decision, row.result]), [['allowed', 'ok'], ['refused', 'refused']])
  assert.deepEqual(h.calls, ['set'])
})

test('Allow refuses a locked session and expiry across either persistence boundary', async t => {
  for (const boundary of ['before', 'save', 'audit']) await t.test(boundary, async t => {
    const h = await team(t, { existing: true })
    assert.deepEqual(await h.set(), success)
    await h.ask()
    const { value } = await h.detail()
    if (boundary === 'before') h.expire()
    else if (boundary === 'save') {
      const save = h.rt.save.bind(h.rt)
      t.mock.method(h.rt, 'save', async options => {
        await save(options)
        if (h.card().status === 'allowed') h.expire()
      })
    } else {
      // The audit queue asks for the team lock after the required save has completed.
      let saved = false
      let approvalChecks = 0
      const save = h.rt.save.bind(h.rt)
      const holdsLock = h.rt.holdsLock.bind(h.rt)
      t.mock.method(h.rt, 'save', async options => { await save(options); saved = options?.required === true })
      t.mock.method(h.rt, 'holdsLock', () => {
        if (saved && h.card().status === 'allowed' && ++approvalChecks === 2) h.expire()
        return holdsLock()
      })
    }
    assert.equal((await h.allow(value)).error.message, locked)
    assert.equal(await h.execute(), 'fixture shell')
    assert.equal(h.calls.includes('read'), false)
    if (boundary !== 'before') assert.equal(h.card().status, 'canceled')
    if (boundary === 'audit') assert.equal(h.audit().some(row => row.decision === 'allowed'), true)
  })
})

test('an admitted Proton lock immediately fences Allow while its save is paused', async t => {
  const h = await team(t, { existing: true })
  assert.deepEqual(await h.set(), success)
  await h.ask()
  const { value } = await h.detail()
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), admitted = Promise.withResolvers()
  const save = h.rt.save.bind(h.rt)
  t.mock.method(h.rt, 'save', async options => {
    if (h.card()?.status === 'allowed') { entered.resolve(); await release.promise }
    return save(options)
  })
  const dispatch = h.rt.vaultEndpoint
  t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
    const pending = dispatch(...args)
    if (args[0] === 'vault-lock') admitted.resolve()
    return pending
  })
  const allowing = h.allow(value)
  await entered.promise
  const locking = h.lock()
  try { await admitted.promise }
  finally { release.resolve() }
  assert.equal((await allowing).error.message, locked)
  assert.deepEqual(await locking, success)
  assert.equal(h.card().status, 'canceled')
  assert.equal(await h.execute(), 'fixture shell')
})

test('a lock during request save cancels the just-added card and audits the revocation', async t => {
  const h = await team(t, { existing: true })
  assert.deepEqual(await h.set(), success)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const save = h.rt.save.bind(h.rt)
  t.mock.method(h.rt, 'save', async options => {
    if (h.card()?.status === 'pending') { entered.resolve(); await release.promise }
    return save(options)
  })
  const asking = h.ask()
  await entered.promise
  try { assert.deepEqual(await h.lock(), success) }
  finally { release.resolve() }
  assert.equal(await asking, locked)
  assert.equal(h.card().status, 'canceled')
  assert.deepEqual(h.audit().slice(-2).map(row => [row.decision, row.result]), [['asked', 'ok'], ['canceled', 'revoked']])
})

test('replacement keeps a late picker answer from the previous session out of Settings', async t => {
  const h = await team(t)
  assert.deepEqual(await h.set(), success)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  h.setPicker(signal => { entered.resolve(signal); return release.promise })
  const picking = h.list()
  const signal = await entered.promise
  assert.equal(signal.aborted, false)
  try {
    assert.deepEqual(await h.set(), success)
    assert.equal(signal.aborted, false)
  } finally { release.resolve({ ok: true, items: [] }) }
  assert.equal((await picking).error.message, locked)
})

test('clear and set preserve admission order behind a paused mapping mutation', async t => {
  for (const clearFirst of [false, true]) await t.test(clearFirst ? 'Clear then Set' : 'Set then Clear', async t => {
    const h = await team(t, { existing: true })
    assert.deepEqual(await h.set(), success)
    await h.ask()
    const waiting = Promise.withResolvers(), release = Promise.withResolvers()
    h.rt.deliver = async () => { waiting.resolve(); await release.promise }
    const mutation = h.call('secret-source-clear', { name })
    await waiting.promise
    const admitted = { 'vault-token-set': Promise.withResolvers(), 'vault-token-clear': Promise.withResolvers() }
    const dispatch = h.rt.vaultEndpoint
    t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
      const pending = dispatch(...args)
      admitted[args[0]]?.resolve()
      return pending
    })
    let setting, clearing
    try {
      if (clearFirst) {
        clearing = h.clear()
        await admitted['vault-token-clear'].promise
        setting = h.set()
        await admitted['vault-token-set'].promise
      } else {
        setting = h.set()
        await admitted['vault-token-set'].promise
        clearing = h.clear()
        await admitted['vault-token-clear'].promise
      }
    } finally { release.resolve() }
    assert.deepEqual(await mutation, success)
    assert.deepEqual(await clearing, success)
    if (clearFirst) assert.deepEqual(await setting, success)
    else assert.equal((await setting).error.message, locked)
    assert.deepEqual(h.calls, clearFirst ? ['set', 'lock', 'set'] : ['set', 'lock'])
  })
})

test('host and adapter admission agree and picker projection bounds untrusted metadata', () => {
  const valid = { id: id() + '/' + id(), name: 'Fixture', vault: 'Vault', fields: [
    { id: 'password', label: 'Password' }, { id: 'password', label: 'Password again' },
    { id: 'totp', label: 'Hidden' }, { id: 'note', label: '' },
  ] }
  const canonical = 'pst_' + randomBytes(32).toString('hex') + '::' + randomBytes(32).toString('base64url')
  assert.deepEqual([...PROTON_FIELDS], [...FIELDS])
  for (const value of [canonical, canonical + '=', canonical.slice(0, -1) + '*', null]) {
    assert.equal(validProtonToken(value), validToken(value))
  }
  assert.equal(validProtonToken(canonical), true)
  assert.equal(validProtonConnection(undefined), true)
  assert.equal(validProtonConnection(provider), true)
  assert.equal(validProtonConnection('other'), false)
  assert.equal(validProtonItem(valid.id), true)
  assert.equal(validProtonItem('bad/' + id()), false)
  assert.deepEqual(protonItems([valid]), [{ id: valid.id, name: 'Fixture', vault: 'Vault',
    fields: [{ selector: 'password', label: 'Password again' }] }])
  const malformed = [{ ...valid, id: 'bad' }, { ...valid, name: 'x'.repeat(513) },
    { ...valid, vault: null }, { ...valid, fields: [{ id: 'totp', label: 'Hidden' }] }]
  assert.deepEqual(protonItems(malformed), [])
  assert.equal(protonItems(Array.from({ length: 60 }, () => valid)).length, 50)
})

test('Bot team documentation tells owners to remove Proton mappings before rollback', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /Remove Proton Pass mappings before rolling back/)
})
