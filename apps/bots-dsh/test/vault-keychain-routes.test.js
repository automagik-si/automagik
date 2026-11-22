import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createMacosKeychain } from '../../vault-dsh/src/macos-keychain/adapter.js'
import { digest, fakeSecurity } from '../../vault-dsh/test/fixtures/fake-security.mjs'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const provider = 'macos-keychain'
const connection = 'login-keychain'
const member = 'fixture-member'
const main = 'fixture-main'
const group = 'fixture-group'
const name = 'FIXTURE_KEY'
const command = 'fixture-command'
const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const handoff = 'Vault values cannot reach a shell on this version; nothing was read.'
const local = { origin: 'http://localhost' }
const success = { ok: true, value: true }
const same = (actual, expected) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'only expected fields are returned')

async function mount(t, { mapping = true, linux = false, cloud = false } = {}) {
  const home = mkdtempSync(join(os.tmpdir(), 'keychain-routes-'))
  const path = join(home, 'Library/Keychains/login.keychain-db')
  const serviceName = ' ' + randomBytes(12).toString('hex') + '  '
  const account = '  ' + randomBytes(12).toString('hex') + ' '
  const item = JSON.stringify([path, serviceName, account])
  const reference = { provider, connection, item, field: 'password', scope: [member] }
  const auditPath = join(home, 'vault-audit.jsonl')
  const sourcesPath = join(home, 'vault-sources.json')
  const writeMappings = row => writeFileSync(sourcesPath, JSON.stringify({ version: 1, sources: { [name]: row } }))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '', { mode: 0o600 })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [main], exchanges: [], questions: {},
    bots: {
      [main]: { id: main, sessionId: main, name: 'Primary Fixture', role: 'Coordinator' },
      [member]: { id: member, sessionId: member, name: 'Member Fixture', role: 'Assistant', private: true },
    },
    rooms: { room: { id: 'room', name: 'Group Fixture', members: [main, member], sessions: { [member]: group } } },
  }))
  if (mapping) writeMappings(reference)
  const passwd = t.mock.method(os, 'userInfo', () => ({ homedir: home }))
  syncBuiltinESMExports()

  const fake = fakeSecurity(path)
  const adapter = createMacosKeychain({}, {
    platform: linux ? 'linux' : 'darwin', passwd: os.userInfo, run: fake.run, isCloud: () => cloud,
  })
  const calls = []
  let picker
  const service = {
    providers: ['bitwarden', 'hashicorp-vault', provider],
    providerBinding: id => id === provider ? adapter.binding : undefined,
    activeConnection: () => adapter.connection === undefined ? undefined : { provider, connection: adapter.connection },
    status: options => options.provider === provider ? adapter.status() : { state: 'unlocked' },
    unlock(options) {
      calls.push('unlock')
      assert.ok(options.provider === provider && options.connection === connection
        && options.password === undefined && options.token === undefined)
      return adapter.unlock(options)
    },
    lock(options) {
      calls.push(options?.provider === 'hashicorp-vault' ? 'lock-other' : 'lock-keychain')
      return options?.provider === 'hashicorp-vault' ? true : adapter.retire()
    },
    listItems: options => picker ? picker(options) : adapter.listItems(options),
    read() { calls.push('read'); return { ok: false, code: 'refused' } },
  }

  const services = { secretSources: service }
  const ctx = fakeContext({ services })
  const warnings = [], notes = [], reports = []
  let attach, detach, route
  ctx.inject = (names, mount) => {
    if (names.length !== 1 || names[0] !== 'secretSources') return
    attach = next => {
      services.secretSources = next
      mount({ secretSources: next, effect(setup) { detach = setup() } })
    }
    attach(service)
  }
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  rt.warn = (...args) => warnings.push(args)
  rt.deliver = async note => { notes.push(note) }
  rt.noteFailure = report => { reports.push(report) }
  const canary = fake.value()
  const clean = value => !String(value).includes(canary)
  t.after(async () => {
    try {
      await ctx.dispose()
      await adapter.prepareQuit()
      assert.equal(calls.includes('read'), false, 'the mounted host made zero value reads')
      for (const log of [notes, warnings, reports, calls, fake.calls]) {
        assert.ok(clean(JSON.stringify(log)) && !JSON.stringify(log).includes(serviceName) && !JSON.stringify(log).includes(account))
      }
      for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const bytes = readFileSync(join(entry.parentPath, entry.name), 'utf8')
        assert.ok(clean(bytes), 'value stayed out of state, sessions, diagnostics and both audit files')
        if (entry.name !== 'vault-sources.json') assert.ok(!bytes.includes(serviceName) && !bytes.includes(account))
      }
    } finally {
      passwd.mock.restore()
      syncBuiltinESMExports()
      rmSync(home, { recursive: true, force: true })
    }
  })

  await rt.load()
  const request = async (endpoint, payload = {}, headers = local) => {
    const response = await route.fetch(new Request('http://dsh.internal/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    const body = await response.json()
    assert.ok(clean(JSON.stringify(body)), 'route disclosed no value')
    return { body, cache: response.headers.get('cache-control') }
  }
  const call = async (...args) => (await request(...args)).body
  const agent = (sessionId = member) => ({ id: sessionId, session: { id: sessionId, header: { id: sessionId, cwd: home } } })
  const ask = (sessionId = member) => ctx.registeredTools.get('request_secret').execute({
    name, command, shell: 'bash', purpose: 'Use the fixture',
  }, { agent: agent(sessionId) })
  const card = () => rt.state.secretRequests?.[member]?.at(-1)
  const detail = (row = card()) => request('secret-source-detail', { requestId: row.id })
  const allow = (details, row = card()) => call('secret-allow', { requestId: row.id, commandDigest: details.commandDigest, snapshot: details.snapshot })
  const execute = () => ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')(
    { name: 'bash', arguments: { command }, agent: agent() }, () => 'fixture shell')
  const audit = () => existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse) : []
  const unlock = (headers, args) => request('vault-unlock', { provider, ...args }, headers)
  const lock = (target = provider) => call('vault-lock', { provider: target })
  const pick = () => request('vault-items', { provider, service: serviceName, account })
  const approve = async () => {
    assert.match(await ask(), /card asking the user/)
    same(await allow((await detail()).body.value), success)
  }
  return { adapter, service, fake, reference, home, path, account, serviceName, call, unlock, lock, ask, pick, card, detail, allow,
    execute, audit, auditPath, rt, calls, approve, writeMappings,
    rawPick: options => adapter.listItems(options),
    setPicker: next => { picker = next },
    stop() { detach(); delete services.secretSources },
    replace: next => { detach(); attach(next) },
  }
}

test('local-only unlock and an exact Find → Save → reload → private detail round trip', async t => {
  const h = await mount(t, { mapping: false })
  assert.ok((await h.call('vault-status', { provider })).value.providers.includes(provider))
  assert.equal((await h.unlock({ origin: 'https://remote.invalid' })).body.ok, false)
  assert.equal((await h.unlock({ ...local, 'x-automagik-principal': 'fixture' })).body.ok, false)
  assert.equal((await h.unlock(local, { connection: 'other' })).body.ok, false)
  assert.equal((await h.unlock(local, { password: 'unused' })).body.ok, false)
  assert.equal(h.calls.length, 0)
  same(await h.unlock(), { body: success, cache: 'no-store' })
  assert.equal((await h.call('vault-status')).value.connection, connection)
  const picked = await h.pick()
  same(picked, { body: { ok: true, value: { items: [{
    id: h.reference.item, service: h.serviceName, account: h.account, fields: [{ selector: 'password', label: 'Password' }],
  }] } }, cache: 'no-store' })
  assert.deepEqual(h.fake.calls.map(row => [row.operation, row.service, row.account]), [['metadata', digest(h.serviceName), digest(h.account)]])
  h.setPicker(() => {
    const service = h.serviceName + 'other'
    return { ok: true, items: [{ id: JSON.stringify([h.path, service, h.account]), service, account: h.account, fields: ['password'] }] }
  })
  assert.equal((await h.pick()).body.ok, false)
  assert.equal((await h.call('vault-items', { provider, service: '\u0085', account: h.account })).ok, false)
  const [row] = picked.body.value.items
  assert.ok((await h.call('secret-source-set', { ...h.reference, item: row.id, field: row.fields[0].selector, name })).ok)
  assert.equal((await h.call('secret-source-set', { ...h.reference, field: 'notes', name })).ok, false)
  const persisted = JSON.parse(readFileSync(join(h.home, 'vault-sources.json'), 'utf8')).sources[name]
  same([persisted.item, persisted.field, persisted.provider], [row.id, 'password', provider])
  // Reload from disk with a different Mac home. Durable rows do not depend on this host's passwd home.
  const otherHome = JSON.stringify(['/Users/Other/Library/Keychains/login.keychain-db', h.serviceName, h.account])
  h.writeMappings({ ...persisted, item: otherHome })
  await h.rt.loadSecrets()
  assert.equal(h.rt.secretSourcesView().broken, false)
  h.writeMappings(persisted)
  await h.rt.loadSecrets()
  assert.match(await h.ask(), /card asking the user/)
  const detail = await h.detail()
  assert.equal(detail.cache, 'no-store')
  same([detail.body.value.item, detail.body.value.field], [row.id, 'password'])
  assert.equal(JSON.stringify(h.card()).includes(h.serviceName), false)
})

test('Linux and Cloud have explicit Settings refusal reasons', { skip: process.platform === 'darwin' }, async t => {
  await t.test('Linux', async t => {
    const h = await mount(t, { mapping: false, linux: true })
    const status = (await h.call('vault-status', { provider })).value
    assert.equal(status.state, 'unavailable')
    assert.equal(status.reason, 'macOS Keychain needs macOS.')
    assert.equal((await h.unlock()).body.error.message, status.reason)
    assert.equal(h.fake.calls.length, 0)
  })
  await t.test('Cloud', async t => {
    const h = await mount(t, { mapping: false, cloud: true })
    const status = (await h.call('vault-status', { provider })).value
    assert.equal(status.state, 'unavailable')
    assert.equal(status.reason, 'macOS Keychain is unavailable in Automagik Cloud.')
    assert.equal((await h.unlock()).body.error.message, status.reason)
    assert.equal(h.fake.calls.length, 0)
  })
})

test('the open plugin gate grants once even when a later adapter read would hit OS refusal', async t => {
  const h = await mount(t)
  await h.unlock()
  h.fake.setMode('locked')
  await h.approve()
  assert.equal(h.fake.calls.length, 0)
  assert.equal(h.card().status, 'allowed')
  assert.equal((await h.execute()).error.message, handoff)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal(h.fake.calls.length, 0)
  assert.deepEqual(h.audit().map(row => [row.decision, row.result]),
    [['asked', 'ok'], ['allowed', 'ok'], ['refused', 'refused']])
  same(await h.adapter.read(h.reference), { ok: false, code: 'refused' })
  assert.deepEqual(h.fake.calls.map(row => row.operation), ['read'])
})

test('a lock or plugin replacement invalidates original detail, approval and stale grants', async t => {
  const h = await mount(t)
  await h.unlock()
  await h.ask()
  const detail = (await h.detail()).body.value
  same(await h.lock('hashicorp-vault'), success)
  assert.ok((await h.detail()).body.ok, 'an unrelated targeted lock preserves the gate')
  same(await h.allow(detail), success)
  same(await h.lock('hashicorp-vault'), success)
  assert.equal((await h.execute()).error.message, handoff, 'unrelated targeted lock preserves the grant')
  await h.ask()
  const old = (await h.detail()).body.value
  await h.lock()
  await h.unlock()
  assert.equal((await h.detail()).body.error.message, locked)
  assert.equal((await h.allow(old)).error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')

  await h.approve()
  await h.lock()
  await h.unlock()
  assert.equal((await h.execute()).error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')

  await h.approve()
  await h.ask()
  const prior = (await h.detail()).body.value
  // The replacement presents the same token. Its service identity still differs.
  h.replace({ ...h.service })
  assert.equal((await h.detail()).body.error.message, locked)
  assert.equal((await h.allow(prior)).error.message, locked)
  assert.equal((await h.execute()).error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal(h.fake.calls.length, 0)
})

test('a request refuses when its gate changes while status is being checked', async t => {
  const h = await mount(t)
  await h.unlock()
  const probing = Promise.withResolvers(), release = Promise.withResolvers()
  const status = h.service.status
  t.mock.method(h.service, 'status', async options => {
    const answer = status(options)
    probing.resolve()
    await release.promise
    return answer
  })
  const asking = h.ask()
  await probing.promise
  await h.lock()
  await h.unlock()
  release.resolve()
  assert.equal(await asking, locked)
  assert.equal(h.card(), undefined)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal(h.fake.calls.length, 0)
})

test('lock during a picker reply or approval persistence fails closed', async t => {
  const h = await mount(t)
  await h.unlock()
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  h.setPicker(async options => {
    const rows = await h.rawPick(options)
    started.resolve()
    await release.promise
    return rows
  })
  const picker = h.pick()
  await started.promise
  await h.lock()
  await h.unlock()
  release.resolve()
  assert.equal((await picker).body.error.message, locked)
  await h.ask()
  const detail = (await h.detail()).body.value
  const saving = Promise.withResolvers(), persist = Promise.withResolvers()
  const save = h.rt.save
  t.mock.method(h.rt, 'save', async options => {
    if (h.card().status === 'allowed') { saving.resolve(); await persist.promise }
    return save(options)
  })
  const allowing = h.allow(detail)
  await saving.promise
  await h.lock()
  await h.adapter.unlock()
  persist.resolve()
  assert.equal((await allowing).error.message, locked)
  assert.equal(h.card().status, 'canceled')
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal(h.audit().some(row => row.decision === 'allowed'), false)
})

test('a lock fences a Keychain unlock queued behind a mapping mutation', async t => {
  const h = await mount(t)
  await h.unlock()
  await h.ask()
  const writing = Promise.withResolvers(), release = Promise.withResolvers(), admitted = Promise.withResolvers()
  h.rt.deliver = async () => { writing.resolve(); await release.promise }
  const mutation = h.call('secret-source-clear', { name })
  await writing.promise
  const dispatch = h.rt.vaultEndpoint
  t.mock.method(h.rt, 'vaultEndpoint', (...args) => {
    const pending = dispatch(...args)
    if (args[0] === 'vault-unlock') admitted.resolve()
    return pending
  })
  const queued = h.unlock()
  await admitted.promise
  same(await h.lock(), success)
  release.resolve()
  same(await mutation, success)
  assert.equal((await queued).body.error.message, locked)
  assert.deepEqual(h.calls, ['unlock', 'lock-keychain'])
})

test('wrong Bot, group, deny, closed gate, changed mapping, plugin off and audit failure refuse', async t => {
  const h = await mount(t)
  writeFileSync(h.auditPath, 'x'.repeat(1024 * 1024))
  assert.match(await h.ask(main), /the user did not let you/)
  assert.match(await h.ask(group), /only work in your own chat/)
  assert.equal(await h.ask(), locked)
  assert.equal(h.card().status, 'locked')
  assert.ok(existsSync(h.auditPath + '.1'))
  await h.unlock()

  await h.ask()
  const denied = h.card()
  const snapshot = (await h.detail()).body.value
  same(await h.call('secret-cancel', { requestId: denied.id }), success)
  assert.equal((await h.allow(snapshot, denied)).ok, false)
  assert.equal(await h.execute(), 'fixture shell')

  await h.ask()
  const old = (await h.detail()).body.value
  h.writeMappings({ ...h.reference, scope: 'all' })
  assert.equal((await h.allow(old)).ok, false)
  assert.equal(await h.execute(), 'fixture shell')

  await h.ask()
  const auditStart = h.audit()
  assert.ok(auditStart.some(row => row.decision === 'denied' && row.result === 'refused'))
  assert.ok(auditStart.some(row => row.decision === 'locked' && row.result === 'locked'))
  const pending = (await h.detail()).body.value
  rmSync(h.auditPath)
  mkdirSync(h.auditPath)
  assert.equal((await h.allow(pending)).error.message, 'The approval could not be recorded; nothing was granted. Ask again.')
  assert.equal(h.card().status, 'canceled')
  assert.equal(await h.execute(), 'fixture shell')
  rmSync(h.auditPath, { recursive: true })
  h.stop()
  assert.match(await h.ask(), /vault plugin is off/)
  assert.equal(h.rt.secretValue(name), undefined)
  assert.equal(h.fake.calls.length, 0)
})

test('a service without a gate token cannot produce a private card, picker or grant', async t => {
  const h = await mount(t)
  await h.unlock()
  h.replace({ ...h.service, providerBinding: undefined })
  assert.equal(await h.ask(), locked)
  assert.equal(h.card(), undefined)
  assert.equal((await h.pick()).body.error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')
})
