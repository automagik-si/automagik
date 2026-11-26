import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { equalPrivate, fakeVault } from '../../vault-dsh/test/fixtures/harness.mjs'
import { fakeOnePassword, useFakeVaultExecutables } from '../../vault-dsh/test/fixtures/onepassword.mjs'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const name = 'SERVICE_KEY'
const bot = 'fixture'
const provider = 'onepassword'
const blocked = "The first cut supports one vault connection. Remove the other vault's mappings first."
const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const unavailable = 'The vault did not answer; nothing was read. Ask again when it is available.'
const cloud = '1Password is unavailable in Automagik Cloud.'
const teamScratch = tmpdir()
const bitwarden = { provider: 'bitwarden', connection: 'bitwarden', item: 'fixture-bw-item', field: 'login.password', scope: 'all' }
const digest = text => createHash('sha256').update(text).digest('hex')
const id = () => randomBytes(13).toString('hex')
const opMapping = () => ({ provider, connection: provider, item: id() + '/' + id(), field: 'Section_' + id() + '/' + id(), scope: 'all' })

async function team(t, { rows, legacy = false, readOnly = false, service, token } = {}) {
  const home = mkdtempSync(join(teamScratch, 'vault-provider-'))
  const write = (file, data) => writeFileSync(join(home, file), JSON.stringify(data))
  const sources = sources => write('vault-sources.json', { version: 1, sources })
  write('state.json', { version: 1, revision: 1, mainBotIds: [bot], rooms: {}, exchanges: [], questions: {},
    bots: { [bot]: { id: bot, sessionId: bot, name: 'Fixture', role: 'Coordinator' } } })
  if (rows !== undefined) sources(rows)
  const calls = []
  const privateToken = token ?? randomBytes(24).toString('base64url')
  const tokenHash = digest(privateToken)
  const states = { bitwarden: 'locked', onepassword: 'locked' }
  let cloudMode = false
  let items = []
  const fake = {
    status(options) {
      const selected = options?.provider ?? 'bitwarden'
      calls.push(['status', options])
      if (cloudMode && selected === provider) throw Object.assign(new Error('fixture'), { code: 'cloud' })
      return { state: states[selected] }
    },
    unlock(options) {
      const { provider: selected = 'bitwarden', connection, token } = options
      calls.push(['unlock', selected, connection, typeof token === 'string' && digest(token) === tokenHash])
      if (cloudMode && selected === provider) return { ok: false, code: 'cloud' }
      if (fake.providerSelection !== undefined && selected !== fake.providerSelection.provider) {
        fake.providerSelection = { provider: selected, generation: fake.providerSelection.generation + 1 }
      }
      states[selected] = 'unlocked'
      return { ok: true }
    },
    lock(options) {
      calls.push(['lock', options])
      for (const selected of options === undefined ? Object.keys(states) : [options.provider]) states[selected] = 'locked'
      return true
    },
    listItems(options) {
      calls.push(['items', options])
      return { ok: true, items }
    },
    read() { assert.fail('approval must not read the vault') },
  }
  if (!legacy) {
    fake.providers = ['bitwarden', provider]
    fake.providerSelection = { provider: 'bitwarden', generation: 0 }
  }
  const ctx = fakeContext()
  let replace
  ctx.inject = (dependencies, attach) => {
    if (dependencies.length !== 1 || dependencies[0] !== 'secretSources') return
    let detach
    replace = next => {
      detach?.()
      if (next !== undefined) attach({ secretSources: next, effect: setup => { detach = setup() } })
    }
    replace(service ?? fake)
    ctx.effect(() => () => detach?.())
  }
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args)
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  await rt.load()
  if (readOnly) rt.readOnly = () => 'Fixture is read-only.'
  rt.deliver = async () => {}
  const failures = []
  rt.noteFailure = value => failures.push(value)
  t.after(async () => {
    try {
      await ctx.dispose()
      assert.equal(JSON.stringify([calls, warnings, failures]).includes(privateToken), false)
      for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) assert.equal(readFileSync(join(entry.parentPath, entry.name), 'utf8').includes(privateToken), false)
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const request = async (endpoint, payload = {}, headers = { origin: 'http://localhost', host: 'localhost' }) => {
    const response = await route.fetch(new Request('http://dsh.internal/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    const result = await response.json()
    assert.equal(JSON.stringify(result).includes(privateToken), false)
    return { result, cache: response.headers.get('cache-control') }
  }
  const call = async (...args) => (await request(...args)).result
  async function tool(toolName, args) {
    let concluded = false
    const text = await ctx.registeredTools.get(toolName).execute(args, {
      agent: { id: bot, session: { id: bot, header: { id: bot, cwd: home } } },
      callId: 'fixture-call', concludeTurn() { concluded = true },
    })
    return { text, concluded }
  }
  const ask = (key = name) => tool('request_secret', { name: key, purpose: 'Use the fixture', command: 'fixture-command', shell: 'bash' })
  const set = (headers, connection) => request('vault-token-set', { provider, token: privateToken, connection }, headers)
  const mappingFile = () => JSON.parse(readFileSync(join(home, 'vault-sources.json'), 'utf8'))
  return { rt, request, call, calls, states, sources, ask, set, mappingFile, replace,
    cloud: () => { cloudMode = true }, picker: data => { items = data },
    list: async () => (await tool('list_secrets', {})).text,
    card: () => rt.state.secretRequests?.[bot]?.at(-1),
  }
}

async function withVault(t, run) {
  await import('../../vault-dsh/test/harness-resolve.mjs')
  const { apply: applyVault } = await import('../../vault-dsh/index.js')
  const op = fakeOnePassword(t)
  const bw = fakeVault(t)
  const restore = useFakeVaultExecutables(op, bw)
  let service
  applyVault({ provide(_name, value) { service = value }, effect() {} })
  try { await run({ service, op, bw }) }
  finally {
    try { await service.prepareQuit() } finally { restore() }
  }
}

async function queueBehindMapping(t, h, endpoint, request, interrupt) {
  h.states.onepassword = 'unlocked'
  assert.equal((await h.ask()).concluded, true)
  const writing = Promise.withResolvers()
  const release = Promise.withResolvers()
  h.rt.deliver = async () => {
    writing.resolve()
    await release.promise
  }
  const mutation = h.call('secret-source-clear', { name })
  const admitted = Promise.withResolvers()
  const dispatch = h.rt.vaultEndpoint
  const hook = t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
    const response = dispatch(...args)
    if (args[0] === endpoint) admitted.resolve()
    return response
  })
  let pending
  try {
    await writing.promise
    pending = request()
    await admitted.promise
    await interrupt()
  } finally {
    hook.mock.restore()
    release.resolve()
    await mutation
  }
  return pending
}

test('Settings, list_secrets, request_secret and Allow use the mapped provider in both state inversions', async t => {
  const row = opMapping()
  const h = await team(t, { rows: { [name]: row } })
  h.states.onepassword = 'unlocked'
  const status = await h.call('vault-status', { provider: 'bitwarden' })
  assert.deepEqual(status.value, { present: true, state: 'unlocked', connection: provider, provider, providers: ['bitwarden', provider] })
  assert.match(await h.list(), /available: ask with request_secret/)
  assert.equal((await h.ask()).concluded, true)
  const card = h.card()
  assert.equal(card.status, 'pending')
  const { value: detail } = await h.call('secret-source-detail', { requestId: card.id })
  assert.equal(detail.provider === provider && detail.item === row.item && detail.field === row.field, true)
  const approve = () => h.call('secret-allow', { requestId: card.id, commandDigest: detail.commandDigest, snapshot: detail.snapshot })
  h.states.bitwarden = 'unlocked'
  h.states.onepassword = 'locked'
  assert.equal((await approve()).error?.message, locked)
  assert.match(await h.list(), /locked: the user must unlock the vault/)
  h.states.onepassword = 'unlocked'
  assert.deepEqual(await approve(), { ok: true, value: true })
  h.states.onepassword = 'locked'
  assert.equal((await h.ask()).text, locked)
  assert.ok(h.calls.filter(([op]) => op === 'status').every(([, options]) => options.provider === provider))
})

test('the inverse mapping uses Bitwarden even while 1Password is unlocked', async t => {
  const h = await team(t, { rows: { [name]: bitwarden } })
  h.states.onepassword = 'unlocked'
  assert.equal((await h.call('vault-status', { provider })).value.state, 'locked')
  assert.equal((await h.ask()).text, locked)
  assert.match(await h.list(), /locked: the user must unlock the vault/)
  h.states.bitwarden = 'unlocked'
  h.states.onepassword = 'locked'
  assert.equal((await h.ask()).concluded, true)
  assert.equal(h.card().status, 'pending')
  const { value } = await h.call('secret-source-detail', { requestId: h.card().id })
  assert.equal((await h.call('secret-allow', { requestId: h.card().id, ...value })).ok, true)
  assert.ok(h.calls.filter(([op]) => op === 'status').every(([, options]) => options.provider === 'bitwarden'))
})

test('legacy services serve Bitwarden only, even when a 1Password mapping exists', async t => {
  const h = await team(t, { legacy: true, rows: { [name]: opMapping() } })
  h.states.bitwarden = 'unlocked'
  assert.equal((await h.call('vault-status')).value.state, 'unavailable')
  assert.match(await h.list(), /unavailable: the vault did not answer/)
  assert.equal((await h.ask()).text, unavailable)
  assert.equal((await h.set()).result.ok, false)
  assert.equal(h.calls.length, 0)
  h.sources({ [name]: bitwarden })
  assert.equal((await h.ask()).concluded, true)
  assert.deepEqual(h.calls, [['status', undefined]])
})

test('source loading and writes enforce one provider and one connection, including a same-name switch', async t => {
  const row = opMapping()
  const h = await team(t, { rows: { [name]: row } })
  assert.equal((await h.call('state')).value.secretSources.broken, false)
  for (const conflict of [{ ...bitwarden, connection: row.connection }, { ...row, connection: 'other' }]) {
    for (const attempted of [name, 'SECOND_KEY']) {
      assert.equal((await h.call('secret-source-set', { name: attempted, ...conflict })).error?.message, blocked)
    }
    h.sources({ [name]: row, SECOND_KEY: conflict })
    assert.equal((await h.call('state')).value.secretSources.broken, true)
    h.sources({ [name]: row })
  }
  assert.equal((await h.call('secret-source-set', { name: 'INVALID_KEY', ...row, field: '../invalid' })).ok, false)
  assert.equal((await h.call('vault-unlock', {})).error?.message, blocked)
  assert.equal((await h.call('secret-source-clear', { name })).ok, true)
  assert.equal((await h.call('secret-source-set', { name, ...bitwarden })).ok, true)
  assert.equal((await h.set()).result.error?.message, blocked)
  assert.equal(h.calls.some(([op]) => op === 'unlock'), false)
  assert.equal((await h.call('secret-source-clear', { name })).ok, true)
  assert.equal((await h.set()).result.ok, true)
})

test('token routes are explicitly registered, non-cacheable and local-only', async t => {
  const h = await team(t)
  for (const headers of [
    { origin: 'https://fixture.invalid', host: 'fixture.invalid' },
    { origin: 'null', host: 'fixture.invalid' },
    { origin: 'http://127.0.0.1:3081', host: '127.0.0.1:3081', 'x-automagik-principal': 'fixture' },
    {},
  ]) {
    for (const answer of [await h.set(headers), await h.request('vault-token-clear', { provider }, headers)]) {
      assert.equal(answer.cache, 'no-store')
      assert.equal(answer.result.error?.message, 'Unlock the vault in Settings on this computer.')
    }
  }
  assert.equal(h.calls.length, 0)
  assert.deepEqual(await h.set(), { result: { ok: true, value: true }, cache: 'no-store' })
  assert.deepEqual(h.calls.at(-1), ['unlock', provider, provider, true])
  assert.deepEqual(await h.request('vault-token-clear', { provider }), { result: { ok: true, value: true }, cache: 'no-store' })
  assert.deepEqual(h.calls.at(-1), ['lock', { provider }])
  await assert.rejects(h.rt.vaultEndpoint('vault-token-unknown', { provider }), /Unknown vault operation/)
  assert.equal(h.calls.some(([op]) => op === 'items'), false)
})

test('a read-only host refuses local token changes before calling the adapter', async t => {
  const h = await team(t, { readOnly: true })
  assert.equal((await h.set()).result.error?.code, 'bot/read-only')
  assert.equal((await h.call('vault-token-clear', { provider })).error?.code, 'bot/read-only')
  assert.equal(h.calls.length, 0)
})

test('Settings reports a fixed Cloud refusal and never passes through CLI text', async t => {
  const h = await team(t)
  h.cloud()
  const status = await h.request('vault-status', { provider })
  assert.equal(status.cache, 'no-store')
  assert.equal(status.result.value?.reason, cloud)
  assert.equal(status.result.value.state, 'unavailable')
  assert.equal((await h.set()).result.error?.message, cloud)
})

test('the 1Password picker round-trips canonical IDs without returning values or extra fields', async t => {
  const h = await team(t)
  const row = opMapping()
  const transient = randomBytes(24).toString('hex')
  h.states.onepassword = 'unlocked'
  h.picker([
    { id: row.item, name: 'Fixture item', vault: 'Fixture vault', value: transient, fields: [
      { id: 'password', label: 'Password', value: transient },
      { id: row.field, label: 'Password', section: 'Fixture section', value: transient },
      { id: 'x/y/z', label: 'Invalid' },
    ] },
    { id: '00000000-0000-0000-0000-000000000001', name: 'Wrong provider', fields: [{ id: 'password', label: 'Password' }] },
  ])
  const response = await h.request('vault-items', { provider, search: ' fixture ' })
  assert.equal(response.cache, 'no-store')
  assert.equal(JSON.stringify(response).includes(transient), false)
  assert.deepEqual(h.calls.at(-1), ['items', { provider, connection: provider, search: 'fixture' }])
  const { items } = response.result.value
  const expectedFields = [{ selector: 'password', label: 'Password' },
    { selector: row.field, label: 'Password', section: 'Fixture section' }]
  assert.equal(JSON.stringify(items) === JSON.stringify([{ id: row.item, name: 'Fixture item', fields: expectedFields, vault: 'Fixture vault' }]), true)
  const saved = await h.call('secret-source-set', { name, provider, connection: provider, item: items[0].id, field: items[0].fields[1].selector, scope: 'all' })
  assert.equal(saved.ok, true)
  assert.equal(JSON.stringify(saved).includes(row.item) || JSON.stringify(saved).includes(row.field), false)
  const reloaded = h.mappingFile().sources[name]
  assert.equal(reloaded.item === row.item && reloaded.field === row.field && reloaded.provider === provider, true)
  assert.equal((await h.call('vault-status')).value.provider, provider)
})

test('the generic lock route cancels an active 1Password read and drops the token', async t => {
  await withVault(t, async ({ service, op }) => {
    const h = await team(t, { service, token: op.credential })
    assert.equal((await h.set(undefined, op.ref.connection)).result.ok, true)
    op.configure({ mode: 'hang' })
    const pending = service.read(op.ref)
    await op.waitForRead()
    const remote = { origin: 'https://fixture.invalid', host: 'fixture.invalid', 'x-automagik-principal': 'fixture' }
    assert.deepEqual(await h.request('vault-lock', {}, remote), { result: { ok: true, value: true }, cache: 'no-store' })
    equalPrivate(await pending, { ok: false, code: 'locked' })
    assert.equal((await h.call('vault-status', { provider })).value.state, 'locked')
    const commands = op.commands().length
    equalPrivate(await service.read(op.ref), { ok: false, code: 'locked' })
    assert.equal(op.commands().length, commands)
    assert.equal(service.activeConnection(), undefined)
  })
})

test('the generic lock route refuses success if Bitwarden cleanup fails', async t => {
  await withVault(t, async ({ service, bw }) => {
    const h = await team(t, { service })
    assert.equal((await h.call('vault-unlock', { password: bw.password })).ok, true)
    bw.configure({ lock: 'error' })
    assert.equal((await h.call('vault-lock')).error?.message, 'The vault could not be locked.')
    bw.configure({ lock: 'ok' })
    assert.equal((await h.call('vault-lock')).value, true)
  })
})

test('a queued Bitwarden unlock stays locked after the generic lock route runs', async t => {
  const h = await team(t, { rows: { [name]: opMapping() } })
  const password = randomBytes(24).toString('hex')
  const result = await queueBehindMapping(t, h, 'vault-unlock', () => h.call('vault-unlock', { password }),
    async () => { assert.equal((await h.call('vault-lock')).value, true) })
  assert.equal(result.error?.message, locked)
  assert.equal((await h.call('vault-status')).value.state, 'locked')
  assert.equal(h.calls.some(([op]) => op === 'unlock'), false)
})

test('a queued token entry cannot reach a replacement plugin instance', async t => {
  const h = await team(t, { rows: { [name]: opMapping() } })
  let unlocks = 0
  const replacement = {
    providers: ['bitwarden', provider],
    status: () => ({ state: 'locked' }),
    unlock() { unlocks++; return { ok: true } },
  }
  const result = await queueBehindMapping(t, h, 'vault-token-set', h.set, () => h.replace(replacement))
  assert.equal(result.result.error?.message, locked)
  assert.equal(unlocks, 0)
  assert.equal((await h.call('vault-status', { provider })).value.state, 'locked')
})

test('token clear cancels a Bitwarden unlock already running and retires the attempted credential', async t => {
  await withVault(t, async ({ service, op, bw }) => {
    const h = await team(t, { service, token: op.credential })
    bw.configure({ hold: ['unlock'] })
    const pending = h.call('vault-unlock', { password: bw.password })
    try {
      await bw.waitFor('unlock')
      assert.equal((await h.call('vault-token-clear', { provider })).value, true)
      assert.equal((await pending).error?.message, locked)
      assert.equal(bw.commands().at(-1), 'lock')
      assert.equal((await h.call('vault-status')).value.state, 'locked')
    } finally { bw.release('unlock') }
  })
})

test('a D3 token clear refusal leaves an admitted Bitwarden unlock running', async t => {
  const bw = fakeVault(t)
  const h = await team(t, { service: bw.service })
  bw.configure({ hold: ['unlock'] })
  const pending = h.call('vault-unlock', { password: bw.password })
  try {
    await bw.waitFor('unlock')
    assert.equal((await h.call('vault-token-clear', { provider })).error?.message, 'The vault did not answer.')
  } finally { bw.release('unlock') }
  assert.deepEqual(await pending, { ok: true, value: true })
  assert.equal((await h.call('vault-status')).value.state, 'unlocked')
  assert.equal(bw.commands().includes('lock'), false)
})

test('token clear reports a supported provider returning false from lock', async t => {
  const calls = []
  const service = {
    providers: ['bitwarden', provider],
    async lock(options) { calls.push(options); return false },
  }
  const h = await team(t, { service })
  assert.equal((await h.call('vault-token-clear', { provider })).error?.message,
    'The 1Password service account token could not be cleared.')
  assert.deepEqual(calls, [{ provider }])
})

test('provider switch invalidates credential entry already queued for the former provider', async t => {
  const h = await team(t, { rows: { [name]: opMapping() } })
  const password = randomBytes(24).toString('hex')
  const admitted = Promise.withResolvers()
  const dispatch = h.rt.vaultEndpoint
  const hook = t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
    const result = dispatch(...args)
    if (args[0] === 'vault-unlock') admitted.resolve()
    return result
  })
  let queued
  try {
    const switched = await queueBehindMapping(t, h, 'vault-token-set', h.set, async () => {
      queued = h.call('vault-unlock', { password })
      await admitted.promise
    })
    assert.equal(switched.result.ok, true)
    assert.equal((await queued).error?.message, locked)
    assert.deepEqual(h.calls.filter(([op]) => op === 'unlock'), [['unlock', provider, provider, true]])
  } finally { hook.mock.restore() }
})

test('a switch retry after failed retirement refuses a Bitwarden entry queued behind it', async t => {
  await withVault(t, async ({ service, op, bw }) => {
    const h = await team(t, { service, token: op.credential })
    assert.equal((await h.call('vault-unlock', { password: bw.password })).ok, true)
    const initial = service.providerSelection
    bw.configure({ lock: 'error' })
    assert.equal((await h.set()).result.error?.message, 'The 1Password service account token could not be set.')
    assert.equal(op.commands().length, 0)
    assert.deepEqual(service.providerSelection, initial)

    const unlocks = []
    const unlock = service.unlock
    t.mock.method(service, 'unlock', options => {
      unlocks.push(options.provider)
      return unlock(options)
    })
    const admitted = Promise.withResolvers()
    const dispatch = h.rt.vaultEndpoint
    t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
      const result = dispatch(...args)
      if (args[0] === 'vault-unlock') admitted.resolve()
      return result
    })
    bw.configure({ lock: 'ok', hold: ['lock'] })
    const retry = h.set()
    let queued
    try {
      await bw.waitFor('lock', 2)
      queued = h.call('vault-unlock', { password: bw.password })
      await admitted.promise
    } finally { bw.release('lock') }
    assert.equal((await retry).result.ok, true)
    assert.equal((await queued).error?.message, locked)
    assert.deepEqual(unlocks, [provider])
    assert.equal(service.providerSelection.provider, provider)
    assert.ok(service.providerSelection.generation > initial.generation)
  })
})

test('credential-first and mapping-first enforce a single live connection for both providers', async t => {
  await withVault(t, async ({ service, op, bw }) => {
    const bwRow = { ...bw.ref, scope: 'all' }
    const opRow = { ...op.ref, scope: 'all' }
    for (const [row, other] of [[bwRow, opRow], [opRow, bwRow]]) {
      const h = await team(t, { service, token: op.credential })
      const save = mapping => h.call('secret-source-set', { name, ...mapping })
      const enter = async connection => row.provider === provider
        ? (await h.set(undefined, connection)).result
        : h.call('vault-unlock', { password: bw.password, provider: row.provider, connection })
      assert.equal((await enter(row.connection)).ok, true)
      const status = (await h.call('vault-status', { provider: row.provider })).value
      assert.equal(status.connection === row.connection, true)
      assert.equal((await save(other)).error?.message, blocked)
      assert.equal((await save({ ...row, connection: 'other' })).error?.message, blocked)
      assert.equal((await save(row)).ok, true)
      assert.equal((await h.call('vault-lock')).value, true)
      assert.equal((await enter('other')).error?.message, blocked)
      const wrongProvider = row.provider === provider
        ? await h.call('vault-unlock', { password: bw.password })
        : (await h.set()).result
      assert.equal(wrongProvider.error?.message, blocked)
      assert.equal((await enter()).ok, true)
      assert.equal(service.activeConnection()?.connection === row.connection, true)
      assert.equal((await h.call('vault-lock')).value, true)
    }
    const empty = await team(t, { service, token: op.credential })
    assert.equal((await empty.set()).result.ok, true)
    assert.equal((await empty.call('secret-source-set', { ...opRow, name })).error?.message, blocked)
    assert.equal((await empty.call('secret-source-set', { ...opRow, name, connection: provider })).ok, true)
  })
})

test('request, Allow and list report reloaded mappings that differ from the live pair as unavailable', async t => {
  await withVault(t, async ({ service, op, bw }) => {
    const rows = { [name]: { ...op.ref, scope: 'all' } }
    const h = await team(t, { rows, service, token: op.credential })
    assert.equal((await h.set()).result.ok, true)
    assert.equal((await h.ask()).concluded, true)
    assert.match(await h.list(), /available: ask with request_secret/)
    const card = h.card()
    const { value: detail } = await h.call('secret-source-detail', { requestId: card.id })

    for (const enter of [
      async () => (await h.set(undefined, 'other')).result,
      () => h.call('vault-unlock', { password: bw.password }),
    ]) {
      h.sources({})
      assert.equal((await enter()).ok, true)
      h.sources(rows)
      assert.deepEqual(await h.ask(), { text: unavailable, concluded: false })
      assert.match(await h.list(), /unavailable: the vault did not answer/)
      assert.equal((await h.call('secret-allow', { requestId: card.id, ...detail })).error?.message, unavailable)
      assert.equal(card.status, 'pending')
    }
  })
})

test('built-in and sectioned 1Password picker selectors survive reload, fingerprint validation and read', async t => {
  await withVault(t, async ({ service, op }) => {
    const h = await team(t, { service, token: op.credential })
    assert.equal((await h.set(undefined, op.ref.connection)).result.ok, true)
    const { value: { items: [item] } } = await h.call('vault-items', { provider })
    const keys = [name, 'BUILTIN_KEY']
    for (const [key, field] of [[keys[0], op.ref.field], [keys[1], 'password']]) {
      const selected = item.fields.find(entry => entry.selector === field)
      assert.equal((await h.call('secret-source-set', {
        name: key, provider, connection: op.ref.connection, item: item.id, field: selected.selector, scope: 'all',
      })).ok, true)
    }
    const rows = h.mappingFile().sources
    const reloaded = await team(t, { rows, service, token: op.credential })
    for (const [key, field] of [[keys[0], op.ref.field], [keys[1], 'password']]) {
      assert.equal((await reloaded.ask(key)).concluded, true)
      const requestId = reloaded.card().id
      reloaded.sources({ ...rows, [key]: { ...rows[key], field: 'different' } })
      assert.match((await reloaded.call('secret-source-detail', { requestId })).error?.message, /vault mapping.*changed/)
      reloaded.sources(rows)
      const { value: detail } = await reloaded.call('secret-source-detail', { requestId })
      assert.equal(detail.item === op.ref.item && detail.field === field, true)
      assert.equal((await reloaded.call('secret-allow', { requestId, ...detail })).ok, true)
      const result = await service.read({ provider: detail.provider, item: detail.item,
        field: detail.field, connection: op.ref.connection })
      equalPrivate(result, { ok: true, value: op.value(field === 'password' ? 'first:password' : 'first') })
    }
    assert.equal(op.commands().filter(row => row.operation === 'read' && row.argsClean && row.envClean).length, 2)
  })
})
