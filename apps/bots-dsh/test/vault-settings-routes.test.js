import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeVault, equalPrivate } from '../../vault-dsh/test/fixtures/harness.mjs'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const name = 'SAMPLE_KEY'
const routes = ['vault-status', 'vault-unlock', 'vault-lock', 'vault-items']

async function team(t, { service, mapping } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vault-settings-'))
  const path = file => join(home, file)
  const warnings = []
  const failures = []
  const ctx = fakeContext({ services: service === undefined ? {} : { secretSources: service } })
  const state = {
    version: 1, revision: 1, mainBotIds: ['fixture'], rooms: {}, exchanges: [], questions: {},
    bots: { fixture: { id: 'fixture', sessionId: 'fixture', name: 'Fixture', role: 'Coordinator' } },
  }
  writeFileSync(path('state.json'), JSON.stringify(state))
  if (mapping) writeFileSync(path('vault-sources.json'), JSON.stringify({ version: 1, sources: { [name]: mapping } }))
  mkdirSync(path('directory'))
  let route
  ctx.logger.warn = (...args) => warnings.push(args)
  ctx.connection.fetch.register = options => {
    if (options.path === '/api/omni-ui') route = options
    return () => {}
  }
  ctx.sessions = { flush: async () => {} }
  apply(ctx, { home, github: false, diagnosticsFile: false })
  const rt = ctx.get('omniTeam')
  rt.noteFailure = entry => failures.push(entry)
  t.after(async () => {
    try { await ctx.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  await rt.load()
  // As DSH's HTTP bridge does: an internal URL, with the browser's own Origin and Host headers.
  const request = (endpoint, payload, origin = 'http://localhost', headers = undefined) => route.fetch(new Request('http://dsh.internal/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
    headers: headers ?? { origin, host: new URL(origin).host },
  }))
  const call = async (...args) => (await request(...args)).json()
  return { rt, call, request, path, home, ctx, warnings, failures }
}

test('settings drives the fake CLI, returns picker metadata only and writes just the existing mapping', async t => {
  const h = fakeVault(t)
  const host = await team(t, { service: h.service })
  equalPrivate(await host.call('vault-status'), { ok: true, value: { present: true, state: 'locked', connection: 'bitwarden' } })
  const response = await host.request('vault-unlock', { password: h.password, connection: 'ignored' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  equalPrivate(await response.json(), { ok: true, value: true })
  equalPrivate(await host.call('vault-status'), { ok: true, value: { present: true, state: 'unlocked', connection: 'bitwarden' } })
  const listed = await host.call('vault-items', { search: '--fixture search', connection: 'ignored' })
  const fields = [
    { selector: 'login.username', label: 'Username' },
    { selector: 'login.password', label: 'Password' },
    { selector: 'notes', label: 'Notes' },
    { selector: 'field:' + h.field, label: h.field },
    { selector: 'field:password', label: 'password' },
  ]
  equalPrivate(listed, { ok: true, value: { items: [{ id: h.id, name: h.value('name'), fields }] } })
  const saved = await host.call('secret-source-set', {
    name, connection: 'bitwarden', item: h.id, field: 'field:' + h.field, scope: ['fixture'], purpose: 'Use the fixture',
  })
  assert.equal(saved.ok, true)
  h.absence(JSON.stringify(saved))
  const data = JSON.parse(readFileSync(host.path('vault-sources.json'), 'utf8'))
  const row = data.sources[name]
  equalPrivate(row, { provider: 'bitwarden', connection: 'bitwarden', item: h.id, field: 'field:' + h.field,
    scope: ['fixture'], purpose: 'Use the fixture', requestedBy: null, createdAt: row.createdAt, updatedAt: row.updatedAt })
  h.absence(JSON.stringify({ ...row, item: null, field: null }))
  equalPrivate(await host.call('vault-lock'), { ok: true, value: true })
  equalPrivate(await host.call('vault-status'), { ok: true, value: { present: true, state: 'locked', connection: 'bitwarden' } })
  const roster = await host.call('state')
  assert.equal(roster.value?.secretSourcesPresent, true)
  h.absence(JSON.stringify(roster))
  for (const entry of readdirSync(host.home, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name !== 'vault-sources.json') h.absence(readFileSync(join(entry.parentPath, entry.name), 'utf8'))
  }
  h.absence(JSON.stringify([host.warnings, host.failures]))
})

test('the host chooses the saved connection and keeps thrown adapter text private', async t => {
  const h = fakeVault(t)
  const mapping = { ...h.ref, scope: 'all', purpose: '', requestedBy: null, createdAt: 1, updatedAt: 1 }
  let unlock = false, list = false, lock = false
  const diagnostic = 'fixture adapter output'
  const service = {
    status() { throw new Error(diagnostic) },
    unlock(args) { unlock = args.connection === h.connection && args.password === h.password; throw new Error(diagnostic) },
    listItems(args) { list = args.connection === h.connection && args.search === 'example'; throw new Error(diagnostic) },
    lock() { lock = true; throw new Error(diagnostic) },
  }
  const host = await team(t, { service, mapping })
  const status = await host.call('vault-status')
  equalPrivate(status, { ok: true, value: { present: true, state: 'unavailable', connection: h.connection } })
  const responses = [
    await host.call('vault-unlock', { password: h.password }),
    await host.call('vault-lock'),
    await host.call('vault-items', { search: ' example ' }),
  ]
  assert.equal(unlock && list && lock && responses.every(answer => answer.ok === false), true)
  const output = JSON.stringify([responses, host.warnings, host.failures])
  h.absence(output)
  assert.equal(output.includes(diagnostic), false)
  assert.equal(host.failures.length, 0)
})

test('the routes refuse an absent service, read-only hosts and insecure remote unlocks', async t => {
  const absent = await team(t)
  for (const endpoint of routes) {
    const answer = await absent.call(endpoint, {})
    assert.equal(answer.error?.message, 'The vault plugin is not on.')
  }
  const service = Object.fromEntries(['status', 'unlock', 'lock', 'listItems'].map(method =>
    [method, () => assert.fail('the service should never be called')]))
  const host = await team(t, { service })
  const remote = await host.call('vault-unlock', {}, 'http://fixture.example.test')
  assert.equal(remote.error?.message, 'Unlock the vault in Settings on this computer.')
  const insecure = 'Unlock the vault in Settings on this computer.'
  // The page's origin decides, never DSH's internal request URL.
  assert.equal((await (await host.request('vault-unlock', {}, undefined, {})).json()).error?.message, insecure)
  assert.equal((await (await host.request('vault-unlock', {}, undefined, { origin: 'null', host: 'fixture.example.test' })).json()).error?.message, insecure)
  assert.notEqual((await (await host.request('vault-unlock', {}, undefined, { host: '127.0.0.1:38535' })).json()).error?.message, insecure)
  // Q10: HTTPS from another host (Pocket, remote) is refused as well.
  assert.equal((await (await host.request('vault-unlock', {}, 'https://fixture.example.test')).json()).error?.message, insecure)
  host.rt.readOnly = () => 'fixture read-only'
  for (const endpoint of routes) {
    const answer = await host.call(endpoint, {})
    assert.equal(answer.error?.code, 'bot/read-only')
  }
  assert.equal([...host.ctx.registeredTools.keys()].some(tool => /^(bw|vault)_/.test(tool)), false)
})

test('status caps the entire service call at five seconds', async t => {
  const host = await team(t, { service: { status: () => new Promise(() => {}) } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = host.rt.vaultEndpoint('vault-status', {})
  await Promise.resolve()
  t.mock.timers.tick(4999)
  let finished = false
  void pending.then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  t.mock.timers.tick(1)
  equalPrivate(await pending, { present: true, state: 'unavailable', connection: 'bitwarden' })
})
