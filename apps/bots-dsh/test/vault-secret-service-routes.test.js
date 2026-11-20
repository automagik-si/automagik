import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const provider = 'secret-service'
const bot = 'fixture-bot'
const name = 'FIXTURE_KEY'
const command = 'fixture-command'
const created = '18446744073709551615'
const newCanary = () => randomBytes(24).toString('hex')
const ok = value => ({ ok: true, value })
const local = { origin: 'http://localhost', host: 'localhost' }
const locked = 'The vault is locked. Unlock it in Settings › Vault and ask again; nothing was read.'
const equal = (a, b) => assert.equal(JSON.stringify(a) === JSON.stringify(b), true, 'only the expected fixture data is returned')

function scan(data, canaries) {
  const encodings = sample => {
    const bytes = Buffer.from(sample)
    return [sample, JSON.stringify(sample).slice(1, -1), bytes.toString('hex'),
      bytes.toString('base64'), bytes.toString('base64url'), [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' '),
      [...bytes].map(byte => '%' + byte.toString(16).padStart(2, '0')).join('')]
  }
  assert.equal(canaries.some(sample => encodings(sample).some(encoded => data.includes(encoded))), false,
    'person-only fixture data stayed within its boundary')
}

async function team(t, { legacy = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ss-host-'))
  const file = join(home, 'vault-sources.json')
  const [label, collection, attribute, value, pathComponent] = Array.from({ length: 5 }, newCanary)
  const path = '/org/freedesktop/secrets/collection/' + pathComponent + '/12'
  const item = JSON.stringify([path, created, createHash('sha256').update(JSON.stringify([['fixture', attribute]])).digest('hex').slice(0, 32)])
  const handle = randomBytes(16).toString('hex')
  const all = [label, collection, attribute, value, path, pathComponent, handle]
  const logs = []
  const calls = []
  let lastItem = item
  let open = false
  let generation = 0
  let selection = Object.freeze({ provider: 'bitwarden', generation: 0 })
  let gate = Object.freeze({ provider, generation })
  let detailHook
  let detailResult
  let unlockCode
  const close = () => {
    open = false
    gate = Object.freeze({ provider, generation: ++generation })
  }
  const status = () => ({ state: open ? 'unlocked' : 'locked' })
  const service = legacy ? { status } : {
    providers: ['bitwarden', provider],
    get providerSelection() { return selection },
    providerBinding(which) { return which === provider ? gate : undefined },
    status,
    unlock({ provider: which, ...options }) {
      assert.equal(Object.keys(options).every(key => key === 'signal'), true)
      assert.equal(which, provider)
      calls.push('unlock')
      if (unlockCode !== undefined) return { ok: false, code: unlockCode }
      close()
      open = true
      if (selection.provider !== which) selection = Object.freeze({ provider: which, generation: selection.generation + 1 })
      return { ok: true }
    },
    lock(options) {
      calls.push(options?.provider === provider ? 'targeted-lock' : 'generic-lock')
      close()
      return true
    },
    listItems(options) {
      assert.equal(options.provider, provider)
      calls.push('picker')
      return open ? { ok: true, items: [
        { handle, name: label, collection, field: 'secret', created, item, value },
        { collection, locked: true, item, value },
        { collection, handle: 'invalid', name: label, field: 'secret' },
      ] } : { ok: false, code: 'locked' }
    },
    resolveHandle(options) {
      assert.equal(options.provider, provider)
      calls.push('resolve')
      return open && options.handle === handle ? { ok: true, item: lastItem } : { ok: false, code: 'revoked' }
    },
    async itemDetail(options) {
      assert.equal(options.provider === provider && options.item === item, true)
      calls.push('detail')
      await detailHook?.()
      return detailResult ?? { ok: true, name: label, collection, created }
    },
    read() {
      calls.push('GetSecret')
      return { ok: true, value }
    },
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [bot], rooms: {}, exchanges: [], questions: {},
    bots: { [bot]: { id: bot, sessionId: bot, name: 'Fixture', role: 'Coordinator' } },
  }))
  const ctx = fakeContext({ services: { secretSources: service } })
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.logger.warn = (...args) => logs.push(args)
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  rt.deliver = async note => { logs.push(note) }
  rt.noteFailure = failure => { logs.push(failure) }
  const scanHome = () => {
    scan(JSON.stringify(logs), all)
    for (const entry of readdirSync(home, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      if (entry.name === 'vault-sources.json') {
        const data = JSON.parse(text)
        // Only the reference field of the chosen mapping may contain the canonical path.
        if (data.sources?.[name]?.item === item) delete data.sources[name].item
        scan(JSON.stringify(data), all)
      } else scan(text, all)
    }
  }
  t.after(async () => {
    try { await ctx.dispose(); scanHome() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  await rt.load()
  const request = async (endpoint, payload = {}, headers = local) => {
    const response = await route.fetch(new Request('http://dsh.internal/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    const body = await response.json()
    const permitted = endpoint === 'vault-items' ? [label, collection, handle]
      : endpoint === 'secret-source-detail' ? [label, collection] : []
    scan(JSON.stringify(body), all.filter(canary => !permitted.includes(canary)))
    return { body, cache: response.headers.get('cache-control') }
  }
  const call = async (...args) => (await request(...args)).body
  const agent = { id: bot, session: { id: bot, header: { id: bot, cwd: home } } }
  const ask = () => ctx.registeredTools.get('request_secret').execute({ name, command, shell: 'bash', purpose: 'Use the fixture' }, { agent })
  const list = () => ctx.registeredTools.get('list_secrets').execute({}, { agent })
  const card = () => rt.state.secretRequests?.[bot]?.at(-1)
  const detail = () => request('secret-source-detail', { requestId: card().id })
  const allow = ({ commandDigest, snapshot }, requestId = card().id) => call('secret-allow', { requestId, commandDigest, snapshot })
  const execute = () => ctx.listeners.get('tools/execute').find(listener => listener.name === 'refuseVaultExecution')(
    { name: 'bash', arguments: { command }, agent }, () => 'fixture shell')
  const audit = () => readFileSync(join(home, 'vault-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  return {
    call, request, ask, list, card, detail, allow, execute, audit, calls, scanHome, item, label, collection, handle, rt,
    unlock: headers => request('vault-unlock', { provider }, headers),
    lock: () => call('vault-lock', { provider }),
    map: extra => call('secret-source-set', { name, provider, handle, scope: [bot], ...extra }),
    clear: () => call('secret-source-clear', { name }),
    row: () => JSON.parse(readFileSync(file, 'utf8')).sources[name],
    exists: () => existsSync(file),
    setItem: value => { lastItem = value },
    onDetail: hook => { detailHook = hook },
    setDetail: result => { detailResult = result },
    setUnlock: code => { unlockCode = code },
    close,
    corrupt() {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      data.sources[name].item = JSON.stringify(['/org/freedesktop/secrets/aliases/login', '1', '0'.repeat(32)])
      writeFileSync(file, JSON.stringify(data))
    },
  }
}

test('local-only passwordless unlock, targeted lock and handle-only mapping validate the reference', async t => {
  const h = await team(t)
  assert.equal((await h.unlock({ origin: 'https://example.invalid' })).body.ok, false)
  assert.equal((await h.unlock({ ...local, 'x-automagik-principal': 'fixture' })).body.ok, false)
  assert.equal(h.calls.length, 0)
  h.setUnlock('unsupported')
  assert.equal((await h.unlock()).body.error?.message, 'Only GNOME Keyring is supported in this version.')
  h.setUnlock('cloud')
  assert.equal((await h.unlock()).body.error?.message, 'Secret Service is unavailable in Automagik Cloud.')
  h.setUnlock(undefined)
  equal(await h.unlock(), { body: ok(true), cache: 'no-store' })
  assert.equal((await h.call('vault-status')).value.provider, provider)
  const picker = await h.request('vault-items', { provider, search: 'fixture' })
  equal(picker.body.value.items, [
    { handle: h.handle, name: h.label, collection: h.collection, field: 'secret', created },
    { collection: h.collection, locked: true },
  ])
  assert.equal(picker.cache, 'no-store')
  assert.equal((await h.map({ handle: undefined, item: h.item, field: 'secret', connection: provider })).ok, false)
  h.setItem(JSON.stringify(['/org/freedesktop/secrets/aliases/default', '1', '0'.repeat(32)]))
  assert.equal((await h.map()).ok, false)
  assert.equal(h.exists(), false)
  h.setItem(h.item)
  assert.equal((await h.map()).ok, true)
  const row = h.row()
  assert.equal(row.item === h.item && row.provider === provider && row.field === 'secret' && row.connection === provider, true)
  assert.equal(Object.hasOwn(row, 'handle'), false)
  assert.equal(row.purpose, '')
  h.scanHome()
  equal(await h.lock(), ok(true))
  assert.equal(h.calls.at(-1), 'targeted-lock')
  assert.equal(await h.ask(), locked)
  h.corrupt()
  assert.equal((await h.call('vault-status', { provider })).ok, true)
  assert.equal(h.rt.secretSourcesView().broken, true)
})

test('scoped request, live detail and Allow consume one grant with zero GetSecret calls', async t => {
  const h = await team(t)
  equal((await h.unlock()).body, ok(true))
  assert.equal((await h.map()).ok, true)
  assert.match(await h.ask(), /exact command/)
  const pending = h.card()
  assert.equal(pending.status, 'pending')
  scan(JSON.stringify(pending), [h.label, h.collection, h.item, h.handle])
  scan(await h.list(), [h.label, h.collection, h.item, h.handle])
  const response = await h.detail()
  assert.equal(response.cache, 'no-store')
  const detail = response.body.value
  equal(detail, { provider, name: h.label, collection: h.collection, created, field: 'secret',
    snapshot: detail.snapshot, commandDigest: pending.commandDigest })
  h.scanHome()
  const checkpoint = h.calls.length
  equal(await h.allow(detail), ok(true))
  assert.equal((await h.execute()).error.message, 'Vault values cannot reach a shell on this version; nothing was read.')
  assert.equal(await h.execute(), 'fixture shell')
  assert.deepEqual(h.calls.slice(checkpoint), [])
  assert.deepEqual(h.audit().slice(-2).map(row => [row.decision, row.result]), [['allowed', 'ok'], ['refused', 'refused']])
  equal(await h.lock(), ok(true))
  equal(await h.clear(), ok(true))
})

test('snapshot and grant bind to a gate generation, including close and reopen', async t => {
  const h = await team(t)
  await h.unlock()
  await h.map()
  await h.ask()
  const first = (await h.detail()).body.value
  await h.lock()
  await h.unlock()
  assert.equal((await h.allow(first)).error.message, locked)
  await h.ask()
  const second = (await h.detail()).body.value
  const refreshed = (await h.detail()).body.value
  assert.equal((await h.allow(second)).ok, false)
  equal(await h.allow(refreshed), ok(true))
  h.close()
  await h.unlock()
  assert.equal((await h.execute()).error.message, locked)
  assert.equal(await h.execute(), 'fixture shell')
  assert.equal(h.calls.includes('GetSecret'), false)
})

test('detail rechecks a pending request, mapping and gate after asynchronous lookup', async t => {
  const h = await team(t)
  await h.unlock()
  await h.map()
  for (const change of ['lock', 'clear', 'cancel']) {
    await h.ask()
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    h.onDetail(async () => { entered.resolve(); await release.promise })
    const pending = h.detail()
    await entered.promise
    if (change === 'lock') await h.lock()
    if (change === 'clear') await h.clear()
    if (change === 'cancel') await h.call('secret-cancel', { requestId: h.card().id })
    release.resolve()
    const answer = await pending
    assert.equal(answer.body.ok, false)
    assert.equal(answer.cache, 'no-store')
    h.onDetail(undefined)
    if (change === 'lock') await h.unlock()
    if (change === 'clear') await h.map()
  }
  await h.ask()
  h.setDetail({ ok: false, code: 'revoked', error: h.label })
  assert.match((await h.detail()).body.error.message, /Map it again/)
})

test('legacy service cannot open or save this provider', async t => {
  const h = await team(t, { legacy: true })
  assert.equal((await h.unlock()).body.ok, false)
  assert.equal((await h.map()).ok, false)
})
