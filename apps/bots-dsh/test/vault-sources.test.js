import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { keySecretOf, tokenSecretOf } from '../src/host/connectors/catalog.js'
import { fakeContext } from './fake-ctx.js'

const MAIN = 'primary-fixture'
const MEMBER = 'member-fixture'
const SESSION = 'capability-fixture'
const NAME = 'SAMPLE_KEY'
const SESSION_KEY = 'SESSION_KEY'
const BROKEN = 'The vault mapping file could not be read; no secret can be used until it is fixed.'
const DUAL_LIST = 'unavailable: this name is defined both in secrets.json and in vault-sources.json'
const dual = name => `${name} is defined both in secrets.json and in vault-sources.json, so it cannot be used. The user must delete one of them in Settings › Secrets.`
const mappedWrite = name => `The name ${name} is mapped to a vault item. A typed value cannot share it; delete the mapping first or use another name.`
const typedWrite = name => `The name ${name} is already a typed secret. Delete it in Settings › Secrets first, or map the vault item under another name.`
const off = name => `${name} is unavailable because the vault plugin is off.`
const on = name => `${name} comes from a vault, and this version of the Bot team cannot use vault secrets yet.`
const fresh = () => `fixture-${randomBytes(12).toString('hex')}`

const team = {
  version: 1, revision: 7, mainBotIds: [MAIN], rooms: {}, exchanges: [], questions: {},
  bots: {
    [MAIN]: { id: MAIN, sessionId: MAIN, name: 'Primary Fixture', role: 'Coordinator', lab: 'deepseek', instructions: '', createdAt: 1 },
    [MEMBER]: { id: MEMBER, sessionId: MEMBER, name: 'Member Fixture', role: 'Assistant', lab: 'deepseek', instructions: '', createdAt: 2, private: true },
  },
}
const typed = (name, value, extra = {}) => ({
  name, value, purpose: 'Typed fixture', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 2, ...extra,
})
const mapping = (extra = {}) => ({
  provider: 'bitwarden', connection: 'fixture-account', item: 'fixture-entry', field: 'fixture-slot',
  scope: [MEMBER], purpose: 'Vault fixture', requestedBy: null, createdAt: 1, updatedAt: 2, ...extra,
})
const json = (file, data) => writeFileSync(file, JSON.stringify(data))
const setTyped = (home, entries) => json(join(home, 'secrets.json'), { version: 1, secrets: entries })
const setSources = (home, rows) => json(join(home, 'vault-sources.json'), { version: 1, sources: rows })
function tempHome(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vault-sources-'))
  json(join(home, 'state.json'), { ...team, ...extra })
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return home
}
async function start(t, home, { service = false, inject = false, services = {} } = {}) {
  let contribution, route, guard
  const warnings = []
  const shellEnv = { register(entry) {
    contribution = entry
    return () => { contribution = undefined }
  } }
  const secretSources = new Proxy({}, { get() { assert.fail('the vault service was called') } })
  const ctx = fakeContext({ services: { ...services, shellEnv, ...(service ? { secretSources } : {}) } })
  let stopService = () => {}
  if (inject) ctx.inject = (names, attach) => {
    if (names.length === 1 && names[0] === 'secretSources' && service) {
      attach({ secretSources, effect(setup) { stopService = setup() } })
    } else if (names.length === 1 && names[0] === 'shellEnv') attach({ shellEnv, effect: ctx.effect })
  }
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.connection.fetch.register = options => { route = options; return () => {} }
  const register = ctx.on
  ctx.on = (name, listener, options) => {
    if (name === 'tools/execute' && /[\\/]src[\\/]host[\\/]private-bots\.js:/.test(new Error().stack)) guard = listener
    return register(name, listener, options)
  }
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup() {} } }) }
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  t.after(() => ctx.dispose())
  await rt.load()
  await rt.loadSecrets()
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const view = async payload => {
    const answer = await call('state', payload)
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    return answer.value
  }
  const tool = async (name, args, agentId = MAIN) => {
    let concluded = false
    if (name === 'request_secret') args = { purpose: 'Fixture', ...args }
    const text = await ctx.registeredTools.get(name).execute(args, { agent: { id: agentId }, concludeTurn() { concluded = true } })
    return { text, concluded }
  }
  const env = (contributor = contribution) => contributor?.resolve({ agent: { id: MAIN }, arguments: {} }) ?? {}
  const maskToolResult = async value => {
    const redact = ctx.listeners.get('tools/execute').find(listener => listener.name === 'redactToolResult')
    return redact({}, async () => ({ content: [{ text: value }] }))
  }
  return { ctx, rt, call, view, tool, env, warnings, guard, stopService, maskToolResult, declared: () => contribution }
}

async function refusalOf(promise, message) {
  const answer = await promise
  assert.equal(answer.ok, false)
  assert.equal(answer.error.message, message)
}

test('without mappings, typed environment, list and cards work as before', async t => {
  const home = tempHome(t)
  const value = fresh()
  setTyped(home, [typed(NAME, value)])
  const h = await start(t, home)
  assert.ok(h.env().DSH_SECRET_SAMPLE_KEY === value)
  assert.deepEqual(Object.keys(h.declared().variables), ['DSH_SECRET_SAMPLE_KEY'])
  assert.match((await h.tool('list_secrets', {})).text, /you may use it as \$DSH_SECRET_SAMPLE_KEY/)
  assert.match((await h.tool('request_secret', { name: NAME })).text, /already saved/)
  const asked = await h.tool('request_secret', { name: 'NEW_KEY', purpose: 'Fixture' })
  assert.equal(asked.concluded, true)
  assert.equal((await h.view()).secretRequests[MAIN][0].name, 'NEW_KEY')
})

test('dual names refuse all uses and stale cards while retaining masking after typed deletion', async t => {
  const home = tempHome(t, { secretRequests: {
    [MAIN]: [{ id: 'stale-card', name: NAME, status: 'pending', kind: 'allow', sessionId: MAIN, purpose: 'Fixture' }],
  } })
  const value = fresh()
  setTyped(home, [typed(NAME, value), typed(SESSION_KEY, fresh(), { session: SESSION, scope: [] })])
  setSources(home, { [NAME]: mapping(), [SESSION_KEY]: mapping() })
  const h = await start(t, home)
  assert.deepEqual(h.env(), {})
  assert.equal(h.declared(), undefined)
  assert.equal(h.rt.secretValue(NAME), undefined)
  assert.equal(h.rt.canUseSecret(NAME, MAIN), false)
  assert.equal(h.rt.canUseSecretInSession(SESSION_KEY, SESSION), false)
  assert.deepEqual(await h.rt.sessionSecretNames(SESSION), [])
  assert.deepEqual(await h.rt.sessionSecretNames(SESSION, { stored: true }), [SESSION_KEY])
  assert.equal(h.rt.secretStored(NAME), true)
  assert.equal(h.rt.secretHeldReason(NAME), dual(NAME))
  await assert.rejects(h.rt.bindSessionSecrets([SESSION_KEY], SESSION), { message: dual(SESSION_KEY) })

  const list = (await h.tool('list_secrets', {})).text.split('\n')
  assert.equal(list.filter(line => line.endsWith(DUAL_LIST)).length, 2)
  assert.equal(list.filter(line => line.startsWith(`- ${SESSION_KEY} `)).length, 1)
  assert.deepEqual(await h.tool('request_secret', { name: NAME }), { text: dual(NAME), concluded: false })
  const files = ['secrets.json', 'vault-sources.json'].map(file => join(home, file))
  const before = files.map(file => readFileSync(file))
  await refusalOf(h.call('secret-allow', { requestId: 'stale-card' }), dual(NAME))
  await refusalOf(h.call('secret-set', { requestId: 'stale-card' }), mappedWrite(NAME))
  await refusalOf(h.call('secret-update', { name: NAME, scope: [] }), dual(NAME))
  await refusalOf(h.call('secret-set', { name: NAME, value: fresh() }), mappedWrite(NAME))
  assert.deepEqual(files.map(file => readFileSync(file)), before)
  const view = await h.view()
  assert.deepEqual(view.secretRequests[MAIN].map(card => [card.id, card.status]), [['stale-card', 'pending']])
  assert.deepEqual(view.secretSources.rows.find(row => row.name === NAME), {
    name: NAME, purpose: 'Vault fixture', scope: [MEMBER], requestedBy: null, createdAt: 1, updatedAt: 2, definedTwice: true,
  })

  const masked = { content: [{ text: '[secret:SAMPLE_KEY]' }] }
  assert.equal(h.rt.redactSecretsAnywhere(value), '[secret:SAMPLE_KEY]')
  assert.deepEqual(await h.maskToolResult(value), masked)
  assert.equal((await h.call('secret-delete', { name: NAME })).ok, true)
  assert.equal(h.rt.redactSecretsAnywhere(value), '[secret:SAMPLE_KEY]')
  assert.deepEqual(await h.maskToolResult(value), masked)
})

test('mapped-only names explain service availability and never create cards', async t => {
  const home = tempHome(t)
  setSources(home, { [NAME]: mapping() })
  const absent = await start(t, home)
  assert.equal(absent.rt.secretValue(NAME), undefined)
  assert.equal(absent.rt.secretStored(NAME), false)
  assert.deepEqual(await absent.tool('request_secret', { name: NAME }), { text: off(NAME), concluded: false })
  assert.match((await absent.tool('list_secrets', {})).text,
    /SAMPLE_KEY — Vault fixture — for Member Fixture — unavailable: it comes from a vault, and the vault plugin is off/)
  assert.deepEqual((await absent.view()).secretRequests, {})
  await absent.ctx.dispose()

  const present = await start(t, home, { service: true, inject: true })
  assert.deepEqual(await present.tool('request_secret', { name: NAME }), { text: on(NAME), concluded: false })
  assert.match((await present.tool('list_secrets', {})).text, /unavailable: it comes from a vault, and this version cannot use vault secrets yet/)
  present.stopService()
  assert.equal((await present.tool('request_secret', { name: NAME })).text, off(NAME))
})

test('broken mapping files stop all use, warn once per change and recover on the next load', async t => {
  const home = tempHome(t)
  const file = join(home, 'vault-sources.json')
  const value = fresh()
  setTyped(home, [typed(NAME, value)])
  writeFileSync(file, 'invalid-fixture')
  const h = await start(t, home)
  const cases = [
    () => writeFileSync(file, 'invalid-fixture'),
    () => json(file, { version: 2, sources: {} }),
    () => json(file, { version: 1, sources: [] }),
    () => setSources(home, { invalid: mapping() }),
    () => setSources(home, { [NAME]: { provider: 'bitwarden' } }),
    () => setSources(home, { [NAME]: mapping({ provider: 'unknown' }) }),
    () => setSources(home, { [NAME]: mapping({ field: '' }) }),
    () => setSources(home, { [NAME]: mapping({ item: 'x'.repeat(513) }) }),
    () => setSources(home, { [NAME]: mapping({ scope: [1] }) }),
    () => setSources(home, { [NAME]: mapping({ scope: { bot: MEMBER } }) }),
    () => setSources(home, { [NAME]: mapping({ value: fresh() }) }),
    () => setSources(home, { [NAME]: mapping(), NEXT: mapping({ connection: 'other-fixture' }) }),
    ...(process.platform === 'win32' ? [] : [() => {
      rmSync(file)
      symlinkSync(join(home, 'absent-fixture'), file)
    }]),
  ]
  for (const corrupt of cases) {
    corrupt()
    assert.deepEqual(await h.tool('request_secret', { name: NAME }), { text: BROKEN, concluded: false })
    const warned = () => h.warnings.filter(([, line]) => line.includes('unreadable vault mapping file')).length
    const count = warned()
    assert.ok(count > 0)
    assert.equal((await h.tool('list_secrets', {})).text, BROKEN)
    assert.deepEqual((await h.view()).secretSources, { broken: true, rows: [] })
    assert.deepEqual(h.env(), {})
    assert.equal(h.rt.secretValue(NAME), undefined)
    assert.equal(h.rt.secretHeldReason(NAME), BROKEN)
    assert.equal(warned(), count)
    if (fs.lstatSync(file).isSymbolicLink()) rmSync(file)
    setSources(home, {})
    assert.match((await h.tool('list_secrets', {})).text, /you may use it as \$DSH_SECRET_SAMPLE_KEY/)
    assert.ok(h.env().DSH_SECRET_SAMPLE_KEY === value)
  }
})

test('a broken mapping file on a cold start is still read when there is no typed file', async t => {
  const home = tempHome(t)
  writeFileSync(join(home, 'vault-sources.json'), 'invalid-fixture')
  const h = await start(t, home)
  assert.equal((await h.tool('request_secret', { name: NAME })).text, BROKEN)
  assert.equal((await h.tool('list_secrets', {})).text, BROKEN)
  assert.deepEqual((await h.view()).secretSources, { broken: true, rows: [] })
})

test('source writes enforce exact names, typed occupancy, service presence and one connection', async t => {
  const home = tempHome(t)
  setTyped(home, [typed(NAME, fresh()), typed(SESSION_KEY, fresh(), { session: SESSION, scope: [] })])
  const absent = await start(t, home)
  const write = { name: 'VAULT_KEY', ...mapping() }
  await refusalOf(absent.call('secret-source-set', write), 'The vault plugin is not on.')
  await absent.ctx.dispose()

  const h = await start(t, home, { service: true })
  for (const name of [NAME, SESSION_KEY]) await refusalOf(h.call('secret-source-set', { ...write, name }), typedWrite(name))
  const badName = 'A name uses capitals, digits, and underscores, and starts with a letter'
  await refusalOf(h.call('secret-source-set', { ...write, name: 'vault-key' }), badName)
  await refusalOf(h.call('secret-source-clear', { name: '$DSH_SECRET_VAULT_KEY' }), badName)
  const answer = await h.call('secret-source-set', { ...write, provider: 'ignored', value: fresh() })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value, {
    name: 'VAULT_KEY', scope: [MEMBER], purpose: 'Vault fixture', requestedBy: null,
    createdAt: answer.value.createdAt, updatedAt: answer.value.updatedAt, definedTwice: false,
  })
  const file = join(home, 'vault-sources.json')
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(stored, { version: 1, sources: { VAULT_KEY: mapping({
    createdAt: answer.value.createdAt, updatedAt: answer.value.updatedAt,
  }) } })
  await refusalOf(h.call('secret-source-set', { ...write, name: 'OTHER_KEY', connection: 'other-fixture' }),
    'The first cut supports one Bitwarden connection.')
  await h.rt.forgetBotSecrets(MEMBER)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sources.VAULT_KEY.scope, [])
})

test('source-set refuses while typed occupancy is unreadable', async t => {
  const home = tempHome(t)
  mkdirSync(join(home, 'secrets.json'))
  const h = await start(t, home, { service: true })
  const response = await h.call('secret-source-set', { name: NAME, ...mapping() })
  assert.equal(response.ok, false)
  assert.match(response.error.message, /^The secrets file could not be read/)
  assert.deepEqual((await h.view()).secretSources, { broken: false, rows: [] })
})

test('clear works with the service off and preserves broken mapping bytes', async t => {
  const home = tempHome(t)
  setSources(home, { [NAME]: mapping() })
  const h = await start(t, home)
  assert.equal((await h.call('secret-source-clear', { name: NAME })).ok, true)
  const file = join(home, 'vault-sources.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sources, {})
  writeFileSync(file, 'broken fixture')
  await refusalOf(h.call('secret-source-clear', { name: NAME }), BROKEN)
  assert.equal(readFileSync(file, 'utf8'), 'broken fixture')
})

async function intercept(t, object, key, replacement, task) {
  const original = object[key]
  const mock = t.mock.method(object, key, (...args) => replacement(original, ...args))
  syncBuiltinESMExports()
  try {
    const result = task()
    if (result?.then) await result
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
}

const failRenameTo = path => async (rename, source, target) => {
  if (target === path) throw Object.assign(new Error('fixture write failure'), { code: 'EISDIR' })
  return rename(source, target)
}

test('failed clear keeps the reservation and failed set rolls back its reservation', async t => {
  const home = tempHome(t)
  setTyped(home, [typed(NAME, fresh())])
  setSources(home, { [NAME]: mapping() })
  const h = await start(t, home, { service: true })
  const file = join(home, 'vault-sources.json')
  const before = readFileSync(file)
  await intercept(t, fsPromises, 'rename', failRenameTo(file), async () => {
    await assert.rejects(h.rt.secretEndpoint('secret-source-clear', { name: NAME }), { code: 'EISDIR' })
    assert.equal(h.rt.secretHeldReason(NAME), dual(NAME))
    assert.equal(h.rt.secretValue(NAME), undefined)
    await assert.rejects(h.rt.secretEndpoint('secret-source-set', { name: 'NEW_KEY', ...mapping() }), { code: 'EISDIR' })
    assert.equal(h.rt.secretSourceReason('NEW_KEY'), undefined)
  })
  assert.deepEqual(readFileSync(file), before)
})

test('failed typed deletion followed by queued mapping set checks the typed file on disk', async t => {
  const home = tempHome(t)
  setTyped(home, [typed(NAME, fresh())])
  const h = await start(t, home, { service: true })
  const path = join(home, 'secrets.json')
  const before = readFileSync(path)
  await intercept(t, fsPromises, 'rename', failRenameTo(path), async () => {
    const removal = h.rt.secretEndpoint('secret-delete', { name: NAME })
    const mappingWrite = h.rt.secretEndpoint('secret-source-set', { name: NAME, ...mapping() })
    await Promise.all([
      assert.rejects(removal, { code: 'EISDIR' }),
      assert.rejects(mappingWrite, { message: typedWrite(NAME) }),
    ])
  })
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(h.rt.secretSourcesView().rows, [])
})

test('two simultaneous clears survive a restart', async t => {
  const home = tempHome(t)
  setSources(home, { [NAME]: mapping(), SECOND_KEY: mapping() })
  const h = await start(t, home)
  assert.deepEqual(await Promise.all([NAME, 'SECOND_KEY'].map(name => h.rt.secretEndpoint('secret-source-clear', { name }))), [true, true])
  await h.ctx.dispose()
  const restarted = await start(t, home)
  assert.deepEqual(restarted.rt.secretSourcesView(), { broken: false, rows: [] })
})

test('a reader checks a new mapping before any state poll or shell resolution', async t => {
  const home = tempHome(t)
  const value = fresh()
  setTyped(home, [typed(NAME, value)])
  json(join(home, 'state.lock'), { pid: process.ppid, host: hostname(), token: 'fixture-writer' })
  const h = await start(t, home)
  assert.ok(h.rt.readOnly())
  const original = h.declared()
  assert.ok(original.variables.DSH_SECRET_SAMPLE_KEY)
  assert.ok(h.env(original).DSH_SECRET_SAMPLE_KEY === value)
  setSources(home, { [NAME]: mapping() })
  assert.deepEqual(h.env(original), {})
  assert.equal(h.declared(), undefined)
  await assert.rejects(h.rt.secretEndpoint('secret-source-clear', { name: NAME }), { message: h.rt.readOnly() })
})

test('mapping reads bracket the typed read, retry once and fail closed on a second mismatch', async t => {
  const home = tempHome(t)
  const value = fresh()
  setTyped(home, [typed(NAME, value)])
  setSources(home, {})
  const h = await start(t, home)
  const file = join(home, 'vault-sources.json')
  const empty = Buffer.from(JSON.stringify({ version: 1, sources: {} }))
  const reserved = Buffer.from(JSON.stringify({ version: 1, sources: { [NAME]: mapping() } }))
  const read = async (snapshots, task) => {
    const order = []
    let result
    await intercept(t, fs, 'readFileSync', (original, path, ...args) => {
      if (path === file) { order.push('mapping'); return snapshots.shift() }
      if (path === join(home, 'secrets.json')) order.push('typed')
      return original(path, ...args)
    }, () => { result = task() })
    assert.deepEqual(order, ['mapping', 'typed', 'mapping', 'mapping', 'typed', 'mapping'])
    assert.equal(snapshots.length, 0)
    return result
  }
  await read([reserved, empty, reserved, reserved], () => {
    assert.deepEqual(h.env(), {})
    assert.equal(h.rt.secretHeldReason(NAME), dual(NAME))
  })
  writeFileSync(file, reserved)
  await h.rt.loadSecrets()
  const afterRetry = await read([empty, reserved, empty, reserved], () => {
    void h.rt.loadSecrets()
    return h.rt.secretHeldReason(NAME)
  })
  assert.equal(afterRetry, BROKEN)
  writeFileSync(file, empty)
  assert.match((await h.tool('list_secrets', {})).text, /you may use it as \$DSH_SECRET_SAMPLE_KEY/)
})

test('adding a typed side changes the live key at the same team revision', async t => {
  const home = tempHome(t)
  setSources(home, { [NAME]: mapping() })
  const h = await start(t, home)
  const first = await h.view()
  const file = join(home, 'vault-sources.json')
  const bytes = readFileSync(file)
  assert.equal(first.secretSources.rows[0].definedTwice, false)
  setTyped(home, [typed(NAME, fresh())])
  const second = await h.view({ since: first.revision, live: first.liveKey })
  assert.equal(second.unchanged, true)
  assert.equal(second.revision, first.revision)
  assert.notEqual(second.liveKey, first.liveKey)
  assert.equal(second.secretSources.rows[0].definedTwice, true)
  assert.deepEqual(readFileSync(file), bytes)
})

test('disconnect retains an unmapped held credential and removes a dual credential only from typed storage', async t => {
  const id = 'notion'
  const heldName = keySecretOf(id)
  const dualName = tokenSecretOf(id)
  const home = tempHome(t, { connectors: { [id]: { connectedAt: 1 } } })
  setTyped(home, [typed(heldName, 'pin'), typed(dualName, fresh())])
  setSources(home, { [dualName]: mapping() })
  const h = await start(t, home)
  assert.equal(h.rt.secretStored(heldName), false)
  assert.equal(h.rt.secretStored(dualName), true)
  assert.equal((await h.call('connector-disconnect', { id })).ok, true)
  const keys = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')).secrets
  assert.deepEqual(keys.map(row => row.name), [heldName])
  assert.equal(h.rt.secretSourceReason(dualName), off(dualName))
})

test('custom connector references refuse before dispatch while ordinary missing references still expand empty', async t => {
  const home = tempHome(t)
  setSources(home, { [NAME]: mapping() })
  let loads = 0
  const h = await start(t, home, { services: { loader: { import: async () => { loads++; assert.fail('must not mount') } } } })
  const headers = { Authorization: 'Bearer $DSH_SECRET_UNMAPPED_KEY' }
  h.rt.state.connectors = { fixture: { custom: { url: 'https://fixture.invalid', headers } } }
  const { upstreamOf } = h.rt.connectorsInternals
  assert.equal(upstreamOf('fixture').headers.Authorization, 'Bearer ')
  headers.Authorization = 'Bearer $DSH_SECRET_SAMPLE_KEY'
  assert.throws(() => upstreamOf('fixture'), { code: 'bot/refused', message: off(NAME) })
  delete h.rt.state.connectors.fixture
  await h.rt.connectorEndpoint('connector-add', { name: 'Fixture Connector', command: 'unused', env: { AUTH: '$DSH_SECRET_SAMPLE_KEY' } })
  assert.equal(loads, 0)
  assert.ok(h.warnings.some(([, line]) => line.includes(off(NAME))))
})

test('custom connector references refuse before dispatch when the mapping file is broken', async t => {
  const home = tempHome(t)
  writeFileSync(join(home, 'vault-sources.json'), 'broken fixture')
  const h = await start(t, home, { services: { loader: { import: async () => assert.fail('must not dispatch') } } })
  h.rt.state.connectors = {
    fixture: { custom: { url: 'https://fixture.invalid', headers: { Authorization: 'Bearer $DSH_SECRET_SAMPLE_KEY' } } },
  }
  assert.throws(() => h.rt.connectorsInternals.upstreamOf('fixture'), { code: 'bot/refused', message: BROKEN })
  await h.rt.connectorEndpoint('connector-add', {
    name: 'Fixture Connector', command: 'unused', env: { AUTH: '$DSH_SECRET_SAMPLE_KEY' },
  })
  assert.ok(h.warnings.some(([, line]) => line.includes(BROKEN)))
})

test('the private-Bot file guard protects vault-sources.json even inside an open folder', async t => {
  const home = tempHome(t)
  setSources(home, { [NAME]: mapping() })
  const h = await start(t, home)
  h.rt.teamFolder = () => home
  const execute = file => h.guard({
    name: 'read', arguments: { file_path: join(home, file) }, agent: { id: MAIN, session: { header: { cwd: home } } },
  }, async () => true)
  assert.equal(await execute('ordinary-fixture.txt'), true)
  await assert.rejects(execute('vault-sources.json'), /private Bot/)
})
