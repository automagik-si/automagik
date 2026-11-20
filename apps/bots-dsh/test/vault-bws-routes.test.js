import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkSetToken, createBitwardenSecrets } from '../../vault-dsh/src/bws/adapter.js'
import { endpointOf } from '../../vault-dsh/src/hashicorp-vault/parse.js'
import { createKeychain, keychainIdentity } from '../../vault-dsh/src/keychain/index.js'
import { completed, digest, fakeSpawn, fakeToken, memoryKeychain } from '../../vault-dsh/test/fixtures/bws.mjs'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { renderVaultSettings } from './fixtures/vault-settings-render.mjs'

const provider = 'bitwarden-secrets'
const providers = ['bitwarden', 'onepassword', 'hashicorp-vault', 'secret-service', 'proton-pass', provider]
const uuid = randomUUID()
const onePassword = { provider: 'onepassword', connection: 'onepassword', item: 'a'.repeat(26) + '/' + 'b'.repeat(26), field: 'password' }
const bitwarden = { provider: 'bitwarden', connection: 'bitwarden', item: uuid, field: 'login.password' }
const bws = { provider, connection: provider, item: uuid, field: 'value' }
const secretName = 'FIXTURE_KEY'
const direct = { origin: 'http://localhost', host: 'localhost' }
const secondConnection = "The first cut supports one vault connection. Remove the other vault's mappings first."
const changedConnection = 'The vault connection changed. Check it and try again.'
const couldNotSet = 'The Bitwarden Secrets Manager access token could not be set.'
const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'

async function team(t, { initial, keychain = memoryKeychain(), identity: sharedIdentity, validateSet = true,
  timers, legacyService, hashicorpPicker } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vault-bws-host-'))
  const write = (file, data) => writeFileSync(join(home, file), JSON.stringify(data))
  const rows = sources => write('vault-sources.json', { version: 1, sources })
  const map = row => rows({ [secretName]: { ...row, scope: 'all' } })
  write('state.json', { version: 1, revision: 1, mainBotIds: ['fixture'], rooms: {}, exchanges: [], questions: {},
    bots: { fixture: { id: 'fixture', sessionId: 'fixture', name: 'Fixture', role: 'Coordinator' } } })
  if (initial) map(initial)
  const states = { bitwarden: 'locked', onepassword: 'locked', 'proton-pass': 'locked', 'hashicorp-vault': 'locked' }
  const identity = sharedIdentity ?? keychainIdentity({ get: () => ({ dir: home }) })
  const project = { id: randomUUID(), name: 'Fixture project' }
  const value = randomBytes(24).toString('hex')
  const note = randomBytes(24).toString('hex')
  const token = fakeToken()
  const item = { id: uuid, projectId: project.id, key: 'Fixture item', value, note }
  const canaries = [value, note, token]
  let reads = 0
  let runs = 0
  const adapter = createBitwardenSecrets({}, { identity, keychain, timers,
    async run(args) {
      runs++
      if (args[0] === '--version') return completed(0, 'bws 2.1.0\n')
      if (args[1] === 'get') reads++
      return completed(0, JSON.stringify(args[0] === 'project' ? [project] : args[1] === 'list' ? [item] : item))
    },
  })
  let override
  let failRetirement = false
  let hashicorpConnection
  const service = {
    providers, providerSelection: { provider: 'bitwarden', generation: 0 },
    activeConnection: () => hashicorpConnection !== undefined ? { provider: 'hashicorp-vault', connection: hashicorpConnection }
      : adapter.connection === undefined ? undefined : { provider, connection: adapter.connection },
    connectionFor: ({ address, namespace }) => endpointOf(address, namespace)?.connection,
    status({ provider: selected } = {}) {
      return selected === provider ? override?.() ?? adapter.status() : { state: states[selected ?? 'bitwarden'] }
    },
    async setToken(options) {
      if (failRetirement) return { ok: false, code: 'unavailable' }
      if (service.providerSelection.provider !== provider) {
        service.providerSelection = { provider, generation: service.providerSelection.generation + 1 }
      }
      return adapter.setToken(options)
    },
    async unlock(options) {
      if (options.provider === provider) return adapter.unlock(options)
      if (options.provider === 'hashicorp-vault' && hashicorpPicker !== undefined) {
        canaries.push(options.token)
        await adapter.lock()
        hashicorpConnection = service.connectionFor(options)
        states[options.provider] = 'unlocked'
        service.providerSelection = { provider: options.provider, generation: service.providerSelection.generation + 1 }
        return { ok: true }
      }
      if (options.provider !== 'proton-pass') return { ok: false, code: 'refused' }
      canaries.push(options.token)
      await adapter.lock()
      states['proton-pass'] = 'unlocked'
      service.providerSelection = { provider: 'proton-pass', generation: service.providerSelection.generation + 1 }
      return { ok: true }
    },
    clearToken(options) { return options.provider === provider ? adapter.clearToken(options) : { ok: false, code: 'refused' } },
    async lock({ provider: selected } = {}) {
      for (const legacy of Object.keys(states)) if (selected === undefined || selected === legacy) states[legacy] = 'locked'
      return selected === undefined || selected === provider ? adapter.lock() : true
    },
    listItems: options => options.provider === 'hashicorp-vault' ? hashicorpPicker(options) : adapter.listItems(options),
    read: (ref, options) => adapter.read(ref, options),
  }
  Object.defineProperties(service, {
    activationId: { value: ({ provider: selected }) => selected === provider ? adapter.activationId : undefined },
    checkAvailability: { value: ({ provider: selected }) => selected === provider ? adapter.availability() : undefined },
  })
  if (validateSet) Object.defineProperty(service, 'checkSetToken', { value: checkSetToken })
  const ctx = fakeContext({ services: { secretSources: legacyService ?? service } })
  let route
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  rt.deliver = async () => {}
  const failures = []
  rt.noteFailure = failure => failures.push(failure)
  const noCanaries = text => assert.equal(canaries.some(value => text.includes(value)), false)
  t.after(async () => {
    try {
      await adapter.prepareQuit()
      await ctx.dispose()
      noCanaries(JSON.stringify([warnings, failures]))
      for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) noCanaries(readFileSync(join(entry.parentPath, entry.name), 'utf8'))
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  await rt.load()
  const call = async (endpoint, payload = {}, headers = direct) => {
    const response = await route.fetch(new Request('http://dsh.internal/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    if (endpoint.startsWith('vault-')) assert.equal(response.headers.get('cache-control'), 'no-store')
    const data = await response.json()
    noCanaries(JSON.stringify(data))
    return data
  }
  const status = async () => (await call('vault-status', { provider })).value
  const settingsMutation = async (endpoint, payload) => {
    const { credentialRevision } = await status()
    return call(endpoint, { credentialRevision, ...payload })
  }
  const setPayload = overrides => ({ provider, token, connection: provider, server: 'us', ...overrides })
  const set = overrides => settingsMutation('vault-token-set', setPayload(overrides))
  const unlock = () => settingsMutation('vault-unlock', { provider, connection: provider })
  const save = row => (row.provider === provider ? settingsMutation : call)('secret-source-set', { name: secretName, scope: 'all', ...row })
  const agent = { id: 'fixture', session: { id: 'fixture', header: { id: 'fixture', cwd: home } } }
  const ask = () => ctx.registeredTools.get('request_secret').execute({
    name: secretName, purpose: 'Use the fixture', command: 'fixture-command', shell: 'bash',
  }, { agent, callId: 'fixture-call', concludeTurn() {} })
  const execute = () => ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')({
    name: 'bash', agent, arguments: { command: 'fixture-command' },
  }, () => assert.fail('the approved shell must refuse before execution'))
  const audit = () => readFileSync(join(home, 'vault-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  return { call, set, setPayload, status, unlock, save, map, rows, ask, execute, audit, project, keychain, identity, states, rt,
    reads: () => reads, runs: () => runs, stopVault: () => adapter.prepareQuit(), activationId: () => adapter.activationId,
    refuseRetirement: () => { failRetirement = true }, overrideStatus: fn => { override = fn } }
}

test('Settings dispatches project picking and mappings, with canaries absent from responses, logs and approval audit', async t => {
  const h = await team(t)
  assert.equal((await h.call('vault-status', { provider })).value.state, 'locked')
  assert.equal(h.keychain.calls.length, 0)
  assert.equal((await h.set()).ok, true)
  assert.equal((await h.save(bitwarden)).error?.message, secondConnection)
  assert.equal((await h.save({ ...bws, connection: 'Work' })).error?.message, secondConnection)
  const listed = await h.call('vault-items', { provider })
  assert.deepEqual(listed.value, { projects: [h.project] })
  const items = await h.call('vault-items', { provider, project: h.project.id })
  assert.deepEqual(items.value, { items: [
    { id: uuid, name: 'Fixture item', vault: h.project.name, fields: [{ selector: 'value', label: 'Value' }] },
  ] })
  assert.equal((await h.save(bws)).ok, true)
  await h.ask()
  const pending = h.rt.state.secretRequests?.fixture?.at(-1)
  assert.equal(pending?.status, 'pending')
  const detail = await h.call('secret-source-detail', { requestId: pending.id })
  assert.equal((await h.call('secret-allow', { requestId: pending.id, ...detail.value })).ok, true)
  assert.equal((await h.execute()).error?.message, 'Vault values cannot reach a shell on this version; nothing was read.')
  assert.equal(h.reads(), 0)
  assert.equal((await h.call('vault-lock')).ok, true)
  assert.equal((await h.unlock()).ok, true)
  h.rows({ [secretName]: { ...bws, scope: 'all' }, OTHER_KEY: { ...onePassword, scope: 'all' } })
  assert.equal((await h.call('state')).value.secretSources.broken, true)
})

test('mapped Secrets Manager ignores unlocked legacy providers and both legacy mappings ignore active bws', async t => {
  const h = await team(t, { initial: bws })
  for (const legacy of [bitwarden, onePassword]) {
    h.states[legacy.provider] = 'unlocked'
    const status = await h.call('vault-status', { provider: legacy.provider })
    assert.equal(status.value.provider === provider && status.value.state === 'locked', true)
    assert.equal(status.value.connectionKnown, true)
    assert.match(await h.ask(), /vault is locked/i)
    assert.equal((await h.set()).ok, true)
    h.map(legacy)
    h.states[legacy.provider] = 'locked'
    const inverse = await h.call('vault-status', { provider })
    assert.equal(inverse.value.provider === legacy.provider && inverse.value.state === 'locked', true)
    assert.match(await h.ask(), /vault did not answer/i)
    assert.equal((await h.call('vault-lock')).ok, true)
    h.map(bws)
  }
})

test('operational reasons stay outside the strict v1 status object, and failed retirement prevents writes', async t => {
  const h = await team(t, { validateSet: false })
  h.refuseRetirement()
  assert.equal((await h.set()).ok, false)
  assert.equal(h.keychain.calls.length, 0)
  h.overrideStatus(() => ({ state: 'locked', reason: 'untrusted' }))
  assert.deepEqual((await h.call('vault-status', { provider })).value,
    { present: true, state: 'unavailable', provider, connection: provider, connectionKnown: false, providers })
  h.overrideStatus(() => { throw Object.assign(new Error('untrusted'), { code: 'keychain' }) })
  assert.equal((await h.call('vault-status', { provider })).value.reason, 'No system keychain.')
})

test('remote, Pocket and Cloud credential verbs refuse before reaching the keychain', async t => {
  const h = await team(t)
  const verbs = ['vault-unlock', 'vault-token-set', 'vault-token-clear']
  const payload = { provider, connection: provider, server: 'us', token: fakeToken() }
  for (const headers of [
    { origin: 'https://fixture.invalid', host: 'fixture.invalid' },
    { ...direct, 'x-automagik-principal': 'fixture' },
  ]) {
    for (const endpoint of verbs) assert.equal((await h.call(endpoint, payload, headers)).error?.message,
      'Unlock the vault in Settings on this computer.')
  }
  const name = 'AUTOMAGIK_GATE_CLOUD_WORKSPACE'
  const before = process.env[name]
  process.env[name] = 'fixture'
  try {
    for (const endpoint of verbs) assert.equal((await h.call(endpoint, payload)).error?.message,
      'Bitwarden Secrets Manager is unavailable in Automagik Cloud.')
  } finally {
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
  assert.equal(h.keychain.calls.length, 0)
})

test('a queued Set or Clear cannot use the revision superseded by a pending store', async t => {
  const h = await team(t)
  let entered = Promise.withResolvers()
  let release = Promise.withResolvers()
  const original = h.keychain.store
  h.keychain.store = async (id, value) => {
    entered.resolve()
    await release.promise
    return original(id, value)
  }
  const first = h.set()
  await entered.promise
  const vaultEndpoint = h.rt.vaultEndpoint
  let admitted = Promise.withResolvers()
  h.rt.vaultEndpoint = (...args) => {
    const result = vaultEndpoint(...args)
    admitted.resolve()
    return result
  }
  const secondToken = fakeToken()
  const second = h.call('vault-token-set', h.setPayload({ token: secondToken, server: 'eu' }))
  await admitted.promise
  release.resolve()
  assert.equal((await first).ok, true)
  assert.equal((await second).error?.message, changedConnection)
  const firstRevision = (await h.status()).credentialRevision
  assert.equal(typeof firstRevision, 'string')
  entered = Promise.withResolvers()
  release = Promise.withResolvers()
  const pending = h.call('vault-token-set', h.setPayload({ token: secondToken, server: 'eu', credentialRevision: firstRevision }))
  await entered.promise
  admitted = Promise.withResolvers()
  const staleClear = h.call('vault-token-clear', { provider, connection: provider, credentialRevision: firstRevision })
  await admitted.promise
  release.resolve()
  assert.equal((await pending).ok, true)
  assert.equal((await staleClear).error?.message, changedConnection)
  const id = h.identity.item(provider)
  assert.deepEqual([...h.keychain.entries.keys()], [id])
  const actual = JSON.parse(Buffer.from(h.keychain.entries.get(id), 'base64').toString('utf8'))
  assert.equal(actual.server === 'eu' && digest(actual.token) === digest(secondToken), true)
  const { credentialRevision } = await h.status()
  assert.equal((await h.call('vault-token-clear', { provider, credentialRevision })).ok, true)
  assert.equal(h.keychain.entries.size, 0)
})

function windowsKeychain({ afterStore } = {}) {
  const calls = []
  const entries = new Map()
  const keychain = createKeychain({ platform: 'win32', parent: { SystemRoot: 'C:\\Windows' },
    exists: file => file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnChild: fakeSpawn(({ stdin, args }) => {
      if (args[0] === '/PID') return completed(1)
      const [operation, id, blob] = stdin.split('\n')
      calls.push([operation, id])
      if (operation === 'store') {
        entries.set(id, blob)
        return afterStore === undefined ? completed() : afterStore()
      }
      if (operation === 'clear') entries.delete(id)
      if (operation === 'exists') return completed(entries.has(id) ? 0 : 10)
      if (operation === 'lookup') return entries.has(id) ? completed(0, entries.get(id)) : completed(10)
      return completed()
    }),
  })
  return { keychain, entries, calls }
}

async function settings(h) {
  const errors = []
  const requests = []
  let pendingStatus
  const view = renderVaultSettings({
    roster: { byId: {}, bots: [], secretSourcesPresent: true },
    call(endpoint, payload) {
      requests.push(endpoint)
      const pending = h.call(endpoint, payload).then(answer => {
        if (!answer.ok) throw new Error(answer.error.message)
        return answer.value
      })
      if (endpoint === 'vault-status') pendingStatus = pending
      return pending
    },
    async run(promise) {
      try { await promise; return true } catch (error) { errors.push(error.message); return false }
    },
  })
  const ready = async () => { view.render(); await pendingStatus; await view.ready() }
  await ready()
  view.fill('Vault provider', provider)
  await ready()
  const click = async label => { await view.button(label).props.onClick(); await ready() }
  return { ...view, click, errors, requests }
}

test('rendered Settings can Set, Unlock and Clear an unmapped Work label across a restart', async t => {
  const { keychain, entries, calls } = windowsKeychain()
  const old = await team(t, { keychain })
  const connection = 'Work'
  const id = old.identity.item(connection)
  const original = await settings(old)
  const label = 'Vault connection label'
  assert.equal(original.input(label).props.value, provider)
  original.fill(label, connection)
  original.input('Bitwarden Secrets Manager access token').props.ref.current.value = old.setPayload().token
  await original.click('Set token')
  assert.deepEqual(original.errors, [])
  assert.equal(original.input(label), undefined)
  assert.equal((await old.status()).connectionKnown, true)
  assert.equal((await old.call('vault-lock')).ok, true)
  await old.stopVault()
  const h = await team(t, { keychain, identity: old.identity })
  const before = calls.length
  assert.equal((await h.call('vault-token-clear', { provider })).error?.message, 'Choose a vault connection to clear.')
  assert.equal(calls.length, before)
  assert.equal(entries.has(id), true)
  const restarted = await settings(h)
  assert.equal(restarted.input(label).props.value, provider)
  const fresh = await h.status()
  assert.equal(fresh.connectionKnown, false)
  assert.equal(fresh.credentialRevision, undefined)
  await restarted.click('Clear token')
  assert.deepEqual(restarted.errors, ['No saved token for this connection.'])
  assert.deepEqual(calls.slice(before), [['exists', h.identity.item(provider)]])
  assert.equal(typeof (await h.status()).credentialRevision, 'string')
  assert.equal(entries.has(id), true)
  restarted.fill(label, connection)
  await restarted.click('Unlock')
  assert.equal((await h.status()).connection, connection)
  assert.equal(restarted.input(label), undefined)
  await restarted.click('Lock')
  assert.equal(restarted.input(label).props.value, connection)
  const clearing = calls.length
  await restarted.click('Clear token')
  assert.deepEqual(restarted.errors, ['No saved token for this connection.'])
  assert.deepEqual(calls.slice(clearing), [['exists', id], ['clear', id], ['exists', id]])
  assert.deepEqual(await keychain.lookup(id), { ok: true })
  assert.equal(entries.has(id), false)
})

test('rendered Settings requires the token to be entered again after a label or server edit', async t => {
  const h = await team(t)
  const view = await settings(h)
  const field = 'Bitwarden Secrets Manager access token'
  const label = 'Vault connection label'
  view.fill(label, 'Work')
  for (const [target, value] of [[label, 'Personal'], ['Server (us, eu, or HTTPS URL)', 'eu']]) {
    const oldInput = view.input(field).props.ref.current
    oldInput.value = h.setPayload().token
    view.fill(target, value)
    assert.equal(oldInput.value === '', true)
    const newInput = view.input(field).props.ref.current
    assert.notEqual(newInput, oldInput)
    oldInput.value = h.setPayload().token
    await view.click('Set token')
    assert.equal(view.requests.includes('vault-token-set'), false)
    oldInput.value = ''
  }
  view.input(field).props.ref.current.value = h.setPayload().token
  await view.click('Set token')
  assert.equal(view.requests.filter(endpoint => endpoint === 'vault-token-set').length, 1)
  assert.deepEqual(view.errors, [])
  assert.equal(h.keychain.entries.has(h.identity.item('Personal')), true)
})

test('a stale rendered Secrets Manager Lock leaves Proton unlocked and legacy Lock still locks all', async t => {
  const h = await team(t)
  assert.equal((await h.set()).ok, true)
  const stale = await settings(h)
  const lock = stale.button('Lock').props.onClick
  const token = 'pst_' + randomBytes(32).toString('hex') + '::' + randomBytes(32).toString('base64url')
  assert.equal((await h.call('vault-token-set', { provider: 'proton-pass', token })).ok, true)
  await lock()
  assert.deepEqual(stale.errors, [])
  assert.equal((await h.call('vault-status', { provider: 'proton-pass' })).value.state, 'unlocked')
  assert.equal((await h.call('vault-lock')).ok, true)
  assert.equal((await h.call('vault-status', { provider: 'proton-pass' })).value.state, 'locked')
})

test('a named Secrets Manager Lock cannot dispatch to a D3 vault service', async t => {
  let locks = 0
  const h = await team(t, { legacyService: { lock() { locks++ } } })
  assert.equal((await h.call('vault-lock', { provider })).error?.message, 'The vault did not answer.')
  assert.equal(locks, 0)
  assert.equal((await h.call('vault-lock')).ok, true)
  assert.equal(locks, 1)
})

test('Clear ends the Secrets Manager activation and old grant even when deletion is unavailable', async t => {
  const cloud = 'AUTOMAGIK_GATE_CLOUD_WORKSPACE'
  for (const [reason, message] of [
    ['missing keychain', 'No system keychain.'],
    ['Cloud', 'Bitwarden Secrets Manager is unavailable in Automagik Cloud.'],
  ]) {
    await t.test(reason, async t => {
      const h = await team(t, { initial: bws })
      assert.equal((await h.set()).ok, true)
      const { credentialRevision } = await h.status()
      assert.notEqual(h.activationId(), undefined)
      await h.ask()
      const requestId = h.rt.state.secretRequests.fixture.at(-1).id
      const detail = await h.call('secret-source-detail', { requestId })
      assert.equal((await h.call('secret-allow', { requestId, ...detail.value })).ok, true)

      const previous = process.env[cloud]
      const calls = h.keychain.calls.length
      if (reason === 'Cloud') process.env[cloud] = 'fixture'
      else h.keychain.available = false
      try {
        assert.equal((await h.call('vault-token-clear', { provider, connection: provider, credentialRevision })).error?.message, message)
      } finally {
        h.keychain.available = true
        if (previous === undefined) delete process.env[cloud]
        else process.env[cloud] = previous
      }
      assert.equal(h.keychain.calls.length, calls)
      assert.equal(h.activationId(), undefined)
      assert.equal((await h.status()).state, 'locked')
      assert.equal((await h.execute()).error?.message, locked)
      const { decision, result } = h.audit().at(-1)
      assert.deepEqual([decision, result], ['locked', 'locked'])
      assert.equal(h.reads(), 0)
    })
  }
})

test('Clear of an inactive Secrets Manager credential leaves an in-flight HashiCorp picker running', async t => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const items = [{ id: 'fixture-folder', name: 'fixture-folder/', folder: true }]
  const h = await team(t, { hashicorpPicker: async ({ signal }) => {
    started.resolve(signal)
    await release.promise
    return { ok: true, items }
  } })
  const connection = 'Work'
  assert.equal((await h.set({ connection })).ok, true)
  const { credentialRevision } = await h.status()
  const hashicorp = 'hashicorp-vault'
  assert.equal((await h.call('vault-token-set', {
    provider: hashicorp, address: 'https://127.0.0.1', token: randomBytes(32).toString('hex'),
  })).ok, true)
  assert.equal(h.activationId(), undefined)

  const picker = h.call('vault-items', { provider: hashicorp, mount: 'kv' })
  const signal = await started.promise
  try {
    assert.equal((await h.call('vault-token-clear', { provider, connection, credentialRevision })).ok, true)
    assert.equal(h.keychain.entries.has(h.identity.item(connection)), false)
  } finally { release.resolve() }
  assert.equal(signal.aborted, false)
  assert.deepEqual((await picker).value, { items })
})

test('Clear after restart and Unlock rejects an immediate Save key from an unpolled window', async t => {
  const old = await team(t)
  assert.equal((await old.set()).ok, true)
  await old.stopVault()
  const h = await team(t, { keychain: old.keychain, identity: old.identity })
  assert.equal((await h.status()).credentialRevision, undefined)
  assert.equal((await h.unlock()).ok, true)
  const { credentialRevision } = await h.status()
  assert.equal(typeof credentialRevision, 'string')
  assert.equal((await h.call('vault-items', { provider })).ok, true)
  const items = await h.call('vault-items', { provider, project: h.project.id })
  assert.equal(items.value.items[0].id, uuid)
  assert.equal((await h.call('vault-token-clear', { provider, credentialRevision })).ok, true)
  for (const observed of [credentialRevision, undefined]) {
    assert.equal((await h.call('secret-source-set', { ...bws, name: secretName, scope: 'all', credentialRevision: observed }))
      .error?.message, changedConnection)
  }
  assert.notEqual((await h.status()).credentialRevision, credentialRevision)
  assert.deepEqual((await h.call('state')).value.secretSources.rows, [])
})

test('an unpolled window cannot submit a picker, Replace, Unlock or Clear after another window replaces the token', async t => {
  const h = await team(t)
  assert.equal((await h.set()).ok, true)
  const { credentialRevision } = await h.status()
  const listed = await h.call('vault-items', { provider })
  assert.equal(listed.ok, true)
  const items = await h.call('vault-items', { provider, project: h.project.id })
  assert.equal(items.value.items[0].id, uuid)
  assert.equal((await h.set({ server: 'eu', credentialRevision })).ok, true)
  const calls = h.keychain.calls.length
  const runs = h.runs()
  const observed = { provider, connection: provider, credentialRevision }
  for (const [endpoint, payload] of [
    ['secret-source-set', { ...bws, name: secretName, scope: 'all', ...observed }],
    ['vault-token-set', h.setPayload(observed)],
    ['vault-unlock', observed],
    ['vault-token-clear', observed],
  ]) {
    assert.equal((await h.call(endpoint, payload)).error?.message, changedConnection)
  }
  assert.equal(h.keychain.calls.length, calls)
  assert.equal(h.runs(), runs)
  assert.deepEqual((await h.call('state')).value.secretSources.rows, [])
  const after = await h.status()
  assert.equal(after.state, 'unlocked')
  assert.notEqual(after.credentialRevision, credentialRevision)
})


test('replacing the server under one label revokes old cards and grants and refuses a stale approval', async t => {
  const connection = 'Work'
  const h = await team(t, { initial: { ...bws, connection } })
  assert.equal((await h.set({ connection })).ok, true)
  const before = (await h.call('vault-status', { provider })).value
  const ask = async () => {
    await h.ask()
    const card = h.rt.state.secretRequests.fixture.at(-1)
    const detail = await h.call('secret-source-detail', { requestId: card.id })
    assert.equal(detail.ok, true)
    return { card, approval: { requestId: card.id, ...detail.value } }
  }
  const first = await ask()
  assert.equal((await h.call('secret-allow', first.approval)).ok, true)
  const pending = await ask()
  assert.equal(pending.card.status, 'pending')

  assert.equal((await h.set({ connection, server: 'eu' })).ok, true)
  const after = (await h.call('vault-status', { provider })).value
  assert.equal(after.state === 'unlocked' && after.connection === before.connection, true)
  assert.notEqual(after.credentialRevision, before.credentialRevision)
  assert.equal(pending.card.status, 'canceled')
  assert.equal((await h.call('secret-allow', pending.approval)).ok, false)
  const decisions = h.audit().map(({ decision, result }) => [decision, result])
  assert.equal(decisions.filter(([decision, result]) => decision === 'canceled' && result === 'revoked').length, 2)
  assert.deepEqual(decisions.at(-1), ['refused', 'refused'])
  assert.equal(decisions.filter(([decision]) => decision === 'allowed').length, 1)

  assert.equal((await h.call('vault-lock')).ok, true)
  assert.equal((await h.call('vault-token-clear', { provider, credentialRevision: after.credentialRevision })).ok, true)
  assert.equal(h.keychain.entries.size, 0)
})

test('Unlock after a second process replaces Work refuses the old card and grant without a read', async t => {
  const connection = 'Work'
  const h = await team(t, { initial: { ...bws, connection } })
  assert.equal((await h.set({ connection, server: 'us' })).ok, true)
  const ask = async () => {
    await h.ask()
    const card = h.rt.state.secretRequests.fixture.at(-1)
    assert.equal(card.status, 'pending')
    const detail = await h.call('secret-source-detail', { requestId: card.id })
    assert.equal(detail.ok, true)
    return { requestId: card.id, ...detail.value }
  }
  assert.equal((await h.call('secret-allow', await ask())).ok, true)
  const oldCard = await ask()
  const { credentialRevision } = await h.status()
  assert.equal((await h.call('vault-lock', { provider })).ok, true)
  const other = await team(t, { keychain: h.keychain, identity: h.identity })
  assert.equal((await other.set({ connection, server: 'eu' })).ok, true)
  assert.equal((await h.call('vault-unlock', { provider, connection, credentialRevision })).ok, true)
  const status = await h.status()
  assert.equal(status.state, 'unlocked')
  assert.notEqual(status.credentialRevision, credentialRevision)
  assert.equal((await h.call('secret-allow', oldCard)).error?.message, locked)
  assert.equal((await h.execute()).error?.message, locked)
  const decisions = h.audit().map(({ decision, result }) => [decision, result])
  assert.deepEqual(decisions.slice(-2), [['locked', 'locked'], ['locked', 'locked']])
  assert.equal(decisions.filter(([decision]) => decision === 'allowed').length, 1)
  assert.equal(h.reads(), 0)
})

test('idle expiry during the required approval save refuses the card and the old grant without a read', async t => {
  let expire
  const timers = {
    setTimeout(fn, ms) {
      if (ms === 300000) { expire = fn; return fn }
      return setTimeout(fn, ms)
    },
    clearTimeout(handle) {
      if (handle === expire) expire = undefined
      else clearTimeout(handle)
    },
  }
  const h = await team(t, { initial: bws, timers })
  assert.equal((await h.set()).ok, true)
  const ask = async () => {
    await h.ask()
    const card = h.rt.state.secretRequests.fixture.at(-1)
    assert.equal(card.status, 'pending')
    const detail = await h.call('secret-source-detail', { requestId: card.id })
    assert.equal(detail.ok, true)
    return { card, approval: { requestId: card.id, ...detail.value } }
  }
  assert.equal((await h.call('secret-allow', (await ask()).approval)).ok, true)
  const { card, approval } = await ask()
  const saving = Promise.withResolvers()
  const releaseSave = Promise.withResolvers()
  const persist = h.rt.save
  h.rt.save = async options => {
    if (options?.required) {
      saving.resolve()
      await releaseSave.promise
    }
    return persist(options)
  }
  const allowing = h.call('secret-allow', approval)
  await saving.promise
  try {
    expire()
  } finally {
    h.rt.save = persist
    releaseSave.resolve()
  }
  assert.equal((await allowing).error?.message, locked)
  assert.equal(card.status, 'canceled')
  assert.equal((await h.execute()).error?.message, locked)
  const decisions = h.audit().map(({ decision, result }) => [decision, result])
  assert.deepEqual(decisions.slice(-2), [['locked', 'locked'], ['locked', 'locked']])
  assert.equal(decisions.filter(([decision]) => decision === 'allowed').length, 1)
  assert.equal(h.reads(), 0)
})

test('Replace preflights a missing keychain inside the queued Settings mutation and preserves approvals', async t => {
  const h = await team(t, { initial: bws })
  assert.equal((await h.set()).ok, true)
  const { credentialRevision } = await h.status()
  await h.ask()
  const granted = h.rt.state.secretRequests.fixture.at(-1)
  const detail = await h.call('secret-source-detail', { requestId: granted.id })
  assert.equal((await h.call('secret-allow', { requestId: granted.id, ...detail.value })).ok, true)
  await h.ask()
  const pending = h.rt.state.secretRequests.fixture.at(-1)
  const runs = h.runs()
  const calls = h.keychain.calls.length
  const audit = h.audit()

  const probing = Promise.withResolvers()
  const releaseProbe = Promise.withResolvers()
  h.overrideStatus(() => {
    probing.resolve()
    return releaseProbe.promise
  })
  const asking = h.ask()
  await probing.promise
  h.overrideStatus(undefined)

  const refreshing = Promise.withResolvers()
  const releaseRefresh = Promise.withResolvers()
  const refresh = h.rt.refresh
  h.rt.refresh = async () => {
    refreshing.resolve()
    await releaseRefresh.promise
    return refresh()
  }
  const replacement = h.call('vault-token-set', h.setPayload({ server: 'eu', credentialRevision }))
  await refreshing.promise
  h.keychain.available = false
  h.rt.refresh = refresh
  releaseRefresh.resolve()
  assert.equal((await replacement).error?.message, 'No system keychain.')
  h.keychain.available = true

  assert.equal(h.runs(), runs)
  assert.equal(h.keychain.calls.length, calls)
  assert.deepEqual(h.audit(), audit)
  assert.equal(pending.status, 'pending')
  const status = await h.status()
  assert.equal(status.state, 'unlocked')
  assert.equal(status.credentialRevision, credentialRevision)
  assert.equal((await h.execute()).error?.message, 'Vault values cannot reach a shell on this version; nothing was read.')
  const pendingDetail = await h.call('secret-source-detail', { requestId: pending.id })
  assert.equal(pendingDetail.ok, true)
  assert.equal((await h.call('secret-allow', { requestId: pending.id, ...pendingDetail.value })).ok, true)
  releaseProbe.resolve({ state: 'unlocked' })
  assert.match(await asking, /card .* is on screen/i)
  assert.equal(h.rt.state.secretRequests.fixture.at(-1).status, 'pending')
  assert.equal(h.reads(), 0)
})

test('a failed required revocation save refuses replacement before a delayed store can start', async t => {
  const h = await team(t, { initial: bws })
  assert.equal((await h.set()).ok, true)
  const { credentialRevision } = await h.status()
  await h.ask()
  const card = h.rt.state.secretRequests.fixture.at(-1)
  assert.equal(card.status, 'pending')

  const saving = Promise.withResolvers()
  const releaseSave = Promise.withResolvers()
  const releaseStore = Promise.withResolvers()
  const persist = h.rt.save
  const store = h.keychain.store
  let stores = 0
  h.rt.save = async options => {
    if (!options?.required) return persist(options)
    saving.resolve()
    await releaseSave.promise
    throw new Error('fixture revocation save refused')
  }
  h.keychain.store = async (...args) => {
    stores++
    await releaseStore.promise
    return store(...args)
  }
  const runs = h.runs()
  const replacement = h.call('vault-token-set', h.setPayload({ server: 'eu', credentialRevision }))
  await saving.promise
  try {
    assert.match(await h.ask(), /vault is locked/i)
  } finally {
    releaseSave.resolve()
    releaseStore.resolve()
    h.rt.save = persist
  }
  assert.equal((await replacement).error?.message, couldNotSet)
  assert.equal(stores, 0)
  assert.equal(h.runs(), runs)
  assert.equal((await h.status()).credentialRevision, credentialRevision)

  let saved = false
  h.rt.save = async options => {
    await persist(options)
    if (options?.required) saved = true
  }
  h.keychain.store = async (...args) => {
    assert.equal(saved, true)
    return store(...args)
  }
  assert.equal((await h.set({ server: 'eu', credentialRevision })).ok, true)
  assert.notEqual((await h.status()).credentialRevision, credentialRevision)
})

test('a committed replacement publishes its revision even if the confirming lookup prevents activation', async t => {
  const h = await team(t, { initial: bws })
  assert.equal((await h.set()).ok, true)
  const { credentialRevision } = await h.status()
  const previous = h.keychain.entries.get(h.identity.item(provider))
  const store = h.keychain.store
  h.keychain.store = async (id, blob) => {
    const stored = await store(id, blob)
    h.keychain.entries.set(id, previous)
    return stored
  }
  assert.equal((await h.set({ server: 'eu', credentialRevision })).error?.message, couldNotSet)
  const status = await h.status()
  assert.equal(status.state, 'locked')
  assert.notEqual(status.credentialRevision, credentialRevision)
  assert.equal((await h.call('vault-unlock', { provider, credentialRevision })).error?.message, changedConnection)
})

test('a store that writes the replacement then times out stays locked and publishes a new revision', async t => {
  let stall = false
  const { keychain, entries, calls } = windowsKeychain({ afterStore: () => stall ? undefined : completed() })
  const h = await team(t, { keychain })
  assert.equal((await h.set()).ok, true)
  const { credentialRevision } = await h.status()
  const id = h.identity.item(provider)
  const before = calls.length
  stall = true
  assert.equal((await h.set({ server: 'eu', credentialRevision })).error?.message, couldNotSet)
  assert.deepEqual(calls.slice(before), [['store', id]])
  const stored = JSON.parse(Buffer.from(entries.get(id), 'base64').toString('utf8'))
  assert.equal(stored.server, 'eu')
  const status = await h.status()
  assert.equal(status.state, 'locked')
  assert.notEqual(status.credentialRevision, credentialRevision)
  assert.equal((await h.call('vault-unlock', { provider, credentialRevision })).error?.message, changedConnection)
  assert.equal((await h.unlock()).ok, true)
})

test('malformed and oversized Set leave the current session, pending card and grant intact without helper calls', async t => {
  const h = await team(t, { initial: bws })
  assert.equal((await h.set()).ok, true)
  const { credentialRevision } = await h.status()
  await h.ask()
  const granted = h.rt.state.secretRequests.fixture.at(-1)
  const detail = await h.call('secret-source-detail', { requestId: granted.id })
  assert.equal((await h.call('secret-allow', { requestId: granted.id, ...detail.value })).ok, true)
  await h.ask()
  const pending = h.rt.state.secretRequests.fixture.at(-1)
  const runs = h.runs()
  const calls = h.keychain.calls.length
  const audit = h.audit()
  const token = fakeToken()
  for (const invalid of [token.slice(0, token.lastIndexOf(':')) + ':AA==', fakeToken(randomBytes(1425).toString('base64'))]) {
    const result = await h.call('vault-token-set', h.setPayload({ token: invalid, credentialRevision }))
    assert.equal(result.error?.message, couldNotSet)
  }
  assert.equal(h.runs(), runs)
  assert.equal(h.keychain.calls.length, calls)
  assert.deepEqual(h.audit(), audit)
  assert.equal(pending.status, 'pending')
  const status = await h.status()
  assert.equal(status.state, 'unlocked')
  assert.equal(status.credentialRevision, credentialRevision)
  assert.equal((await h.execute()).error?.message, 'Vault values cannot reach a shell on this version; nothing was read.')
  assert.equal(h.reads(), 0)
})
