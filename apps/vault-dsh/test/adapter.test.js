import assert from 'node:assert/strict'
import { test } from 'node:test'
import { equalPrivate, fakeClock, fakeVault, unavailable } from './fixtures/harness.mjs'

const refusal = code => ({ ok: false, code })
const locked = refusal('locked')
const ok = { ok: true }
const staleMessage = 'Syncing failed: FetchError: request to https://vault.example.test/api/sync failed, reason: socket hang up'

const expectRead = (answer, value, stale = false) => {
  const expected = stale ? { ok: true, value, stale: true } : { ok: true, value }
  assert.equal(JSON.stringify(answer) === JSON.stringify(expected), true, 'selected field and freshness match')
}

test('version and status gate the key, and a forced sync takes a skewed rotation', async t => {
  const h = fakeVault(t, { lastSync: '2026-11-19T12:00:00Z' })
  equalPrivate(await h.service.status(), { state: 'locked', lastSync: Date.UTC(2026, 10, 19, 12) })
  equalPrivate(await h.service.listItems({ connection: h.connection }), locked)
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.service.status(), { state: 'unlocked', lastSync: Date.UTC(2026, 10, 19, 12) })
  expectRead(await h.service.read(h.ref), h.value('old'))
  h.configure({ version: '2026.10.9', rotate: 'new' })
  expectRead(await h.service.read({ ...h.ref, item: h.id.toUpperCase() }), h.value('new'))
  assert.deepEqual(h.commands(), [
    '--version', 'status', '--version', 'unlock', '--version', 'status',
    '--version', 'status', 'sync', 'get', '--version', 'status', 'sync', 'get',
  ])
  assert.equal(h.log().filter(row => row.command === 'sync').every(row => row.forced && row.session && row.response), true)
  assert.equal(h.log().filter(row => row.command === 'unlock').every(row => row.password && !row.response), true)
  assert.equal(h.log().filter(row => row.command === '--version').every(row => row.session === null && row.password === null), true)
  assert.equal(h.log().filter(row => row.command === 'get').every(row => row.correctItem), true)
  equalPrivate(await h.service.prepareQuit(), ok)
  assert.equal(h.commands().at(-1), 'lock')
  equalPrivate(await h.service.read(h.ref), locked)
})

test('network failure alone can serve the local field, even with no last sync', async t => {
  const h = fakeVault(t, { sync: staleMessage, server: 'vaultwarden' })
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.service.status(), { state: 'unlocked' })
  expectRead(await h.service.read(h.ref), h.value('old'), true)
  h.configure({ sync: null, rotate: 'new' })
  expectRead(await h.service.read(h.ref), h.value('new'))
  assert.equal(h.log().every(row => row.vaultwarden), true)
})

for (const [label, sync, code] of [
  ['auth with recent lastSync', 'Syncing failed: HTTP 401', 'auth'],
  ['5xx', 'Syncing failed: HTTP 503', 'refused'],
  ['TLS', 'Syncing failed: certificate has expired', 'refused'],
  ['unknown', 'Syncing failed: unknown', 'refused'],
  ['truncated', 'truncated', 'refused'],
  ['oversized', 'oversize', 'refused'],
  ['timeout', null, 'refused'],
]) test(`a failed sync locks and refuses (${label})`, async t => {
  const h = fakeVault(t, { lastSync: '2026-11-19T12:00:00Z', sync,
    ...(label === 'timeout' ? { pause: 'sync', shorten: { sync: 800 } } : {}) })
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.service.read(h.ref), refusal(code))
  equalPrivate(await h.service.read(h.ref), locked)
  assert.deepEqual(h.commands(), ['--version', 'unlock', '--version', 'status', 'sync', 'lock'])
  assert.equal(h.log().at(-1).session, null)
})

for (const version of ['2026.10.0', '2026.11.0', 'garbage']) test(`unsupported version ${version} receives no credential`, async t => {
  const h = fakeVault(t, { version })
  equalPrivate(await h.unlock(), refusal('version'))
  assert.deepEqual(h.commands(), ['--version'])
  h.configure({ version: '2026.10.1' })
  equalPrivate(await h.unlock(), ok)
  h.configure({ version })
  equalPrivate(await h.service.read(h.ref), refusal('version'))
  assert.deepEqual(h.commands().slice(-2), ['--version', 'lock'])
})

test('unsupported public status invalidates a live read and the picker gates independently', async t => {
  const h = fakeVault(t, { pause: 'get' })
  equalPrivate(await h.unlock(), ok)
  const read = h.service.read(h.ref)
  await h.waitFor('get')
  h.configure({ version: '2026.11.0' })
  await unavailable(h.service.status())
  equalPrivate(await read, locked)
  await h.waitFor('lock')
  h.configure({ version: '2026.10.1' })
  equalPrivate(await h.unlock(), ok)
  h.configure({ version: '2026.11.0' })
  equalPrivate(await h.service.listItems({ connection: h.connection }), refusal('version'))
  assert.deepEqual(h.commands().slice(-2), ['--version', 'lock'])
  assert.equal(h.commands().includes('list'), false)
})

test('public status shares one deadline between children and preserves unauthenticated', async t => {
  const timers = fakeClock()
  const h = fakeVault(t, { timers, hold: ['--version', 'status'] })
  const pending = h.service.status()
  let finished = false
  void pending.then(() => { finished = true }, () => { finished = true })
  await h.waitFor('--version')
  timers.tick(4000)
  h.release('--version')
  await h.waitFor('status')
  timers.tick(499)
  await Promise.resolve()
  assert.equal(finished, false)
  timers.tick(1)
  await unavailable(pending)
  assert.deepEqual(h.commands(), ['--version', 'status'])
  h.configure({ hold: [], status: 'unauthenticated' })
  equalPrivate(await h.service.status(), { state: 'unauthenticated' })
})

for (const auth of ['status', 'get', 'list']) test(`an auth failure from ${auth} invalidates the owned session`, async t => {
  const h = fakeVault(t, { auth })
  equalPrivate(await h.unlock(), ok)
  const operation = auth === 'list' ? h.service.listItems({ connection: h.connection }) : h.service.read(h.ref)
  equalPrivate(await operation, refusal('auth'))
  assert.equal(h.commands().at(-1), 'lock')
  equalPrivate(await h.service.read(h.ref), locked)
})

test('a CLI lock drops an owned key and never proceeds to sync', async t => {
  const h = fakeVault(t)
  equalPrivate(await h.unlock(), ok)
  h.configure({ status: 'locked' })
  equalPrivate(await h.service.read(h.ref), locked)
  assert.deepEqual(h.commands(), ['--version', 'unlock', '--version', 'status', 'lock'])
  h.configure({ status: 'unlocked' })
  equalPrivate(await h.service.status(), { state: 'locked' })
})

test('immutable ids, one connection, unambiguous selectors, deletion and rotation', async t => {
  const h = fakeVault(t)
  equalPrivate(await h.unlock(), ok)
  for (const ref of [{ ...h.ref, provider: 'other' }, { ...h.ref, connection: '' },
    { ...h.ref, connection: 'another' }, { ...h.ref, item: 'item name' }]) {
    equalPrivate(await h.service.read(ref), refusal('refused'))
  }
  equalPrivate(await h.service.listItems({ connection: 'another' }), refusal('refused'))
  equalPrivate(await h.service.read({ ...h.ref, field: 'login.totp' }), refusal('field'))
  assert.deepEqual(h.commands(), ['--version', 'unlock'])
  expectRead(await h.service.read({ ...h.ref, field: 'field:' + h.field }), h.value('custom'))
  expectRead(await h.service.read({ ...h.ref, field: 'field:password' }), h.value('other'))
  for (const [patch, field, code] of [
    [{}, 'field:duplicate', 'field'], [{}, 'field:missing', 'field'], [{ empty: true }, 'login.password', 'field'],
    [{ empty: false, deleted: true }, 'login.password', 'revoked'],
    [{ deleted: false, missing: true }, 'login.password', 'revoked'],
    [{ missing: false, badId: true }, 'login.password', 'unavailable'],
  ]) {
    h.configure(patch)
    equalPrivate(await h.service.read({ ...h.ref, field }), refusal(code))
  }
  h.configure({ badId: false, many: true })
  const listed = await h.service.listItems({ connection: h.connection, search: '--fixture search' })
  const row = { id: h.id, name: h.value('name'), fields: ['login.username', 'login.password', 'notes', 'field:' + h.field, 'field:password'] }
  assert.equal(JSON.stringify(listed) === JSON.stringify({ ok: true, items: Array(50).fill(row) }), true, 'picker returns only selected metadata')
  assert.equal(h.log().at(-1).search, true)
})

test('a new connection locks before unlocking, and failed unlocks clean up', async t => {
  const h = fakeVault(t)
  equalPrivate(await h.unlock(), ok)
  equalPrivate(await h.service.unlock({ password: h.password, connection: 'another' }), ok)
  assert.deepEqual(h.commands(), ['--version', 'unlock', '--version', 'lock', 'unlock'])
  equalPrivate(await h.service.read(h.ref), refusal('refused'))
  for (const outcome of ['empty', 'malformed', 'error']) {
    h.configure({ unlock: outcome })
    equalPrivate(await h.unlock(), refusal('unlock'))
    assert.deepEqual(h.commands().slice(-2), ['unlock', 'lock'])
    equalPrivate(await h.service.listItems({ connection: h.connection }), locked)
  }
  const unused = fakeVault(t)
  equalPrivate(await unused.service.dispose(), ok)
  assert.deepEqual(unused.commands(), [])
})
