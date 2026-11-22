import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { REFRESH } from '../src/host/accounts.js'
import { readCodex, CODEX_MAX_BYTES } from '../../../herdr/mods/am-sidebar/accountsHere.js'
import { accountFingerprint, REFRESH as PACK_REFRESH } from '../../../herdr/mods/am-sidebar/accountsRows.js'
import { automationFixture, automationHost, DIGEST } from './fixtures/automations-host.mjs'

const ENDPOINT = 'accounts-codex'
const OVERRIDE = 'AUTOMAGIK_ACCOUNTS_CODEX_HOME'
const REFRESHED = '2099-06-01T09:00:00.234567891Z'
const ID = '  synthetic-account-😺  '
const TOKEN = 'synthetic-token-value'
const auth = JSON.stringify({
  tokens: { account_id: ID, access_token: TOKEN, refresh_token: TOKEN, id_token: TOKEN },
  OPENAI_API_KEY: TOKEN, last_refresh: REFRESHED, claude: TOKEN,
})
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function packBytes(path, max) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > max) throw new Error('unreadable')
    const buffer = Buffer.alloc(max + 1)
    let size = 0
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null)
      if (!n) break
      size += n
    }
    return buffer.subarray(0, size)
  } finally { closeSync(fd) }
}
function setup(t, options) {
  const fixture = automationFixture(t)
  delete fixture.env[OVERRIDE]
  const host = automationHost(t, fixture, options)
  const dir = join(fixture.root, '.codex')
  mkdirSync(dir)
  const file = join(dir, 'auth.json')
  const call = async () => {
    const response = await host.request(ENDPOINT)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const reply = await response.json()
    assert.equal(reply.ok, true)
    assert.equal(reply.value.proxy, 'unknown')
    return reply.value.codex
  }
  return { ...fixture, host, dir, file, call }
}
function assertFile(codex, content, file = 'present', lastRefresh = null, folder = '~/.codex') {
  assert.equal(codex.file, file)
  assert.equal(codex.folder, folder)
  assert.equal(codex.account === accountFingerprint(content), true)
  assert.equal(codex.lastRefresh, lastRefresh)
  assert.deepEqual(Object.keys(codex).sort(), ['account', 'file', 'folder', 'lastRefresh'])
}

test('the accounts read is gated by the actual dispatcher and allowed on a read-only owner window', async t => {
  const f = setup(t, { readOnly: 'read only' })
  writeFileSync(f.file, auth)
  for (const principal of [
    { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } },
    { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' },
  ]) assert.equal((await f.host.request(ENDPOINT, {}, { peer: { principal } })).status, 403)
  for (const marker of [null, DIGEST, 'bad-marker']) {
    const response = await f.host.call(ENDPOINT, {}, { marker })
    assert.deepEqual(response.value, { reason: 'desktop-only' })
  }
  assertFile(await f.call(), auth, 'present', REFRESHED)
  assert.deepEqual(f.calls(), [])
})

test('Codex JSON semantics match the pack and only the permitted fields reach the browser', async t => {
  const f = setup(t)
  assert.equal(REFRESH.source, PACK_REFRESH.source)
  for (const [content, lastRefresh] of [
    [auth, REFRESHED], ['malformed', null], ['{}', null], ['null', null],
    [JSON.stringify({ OPENAI_API_KEY: TOKEN }), null],
    [JSON.stringify({ tokens: { account_id: ' \t ' }, last_refresh: ['2099-06-01T09:00Z'] }), null],
    [JSON.stringify({ tokens: { account_id: 12 }, last_refresh: 'yesterday' }), null],
    [JSON.stringify({ last_refresh: '2099-06-01T09:00+0300' }), '2099-06-01T09:00+0300'],
  ]) {
    writeFileSync(f.file, content)
    const result = await f.call()
    assertFile(result, content, 'present', lastRefresh)
    const pack = readCodex({ env: {}, home: f.root, readBytes: packBytes, sha256 })
    assert.equal(result.file, pack.file)
    assert.equal(result.account === pack.account, true)
    assert.equal(result.lastRefresh, pack.lastRefresh)
    const output = JSON.stringify(result)
    for (const forbidden of [ID.trim(), TOKEN, 'access_token', 'refresh_token', 'id_token', 'OPENAI_API_KEY', sha256(content), f.root]) {
      assert.equal(output.includes(forbidden), false)
    }
  }
})

test('Codex file states cover size limits, directories, symlinks and a FIFO without a writer', { timeout: 5000 }, async t => {
  const f = setup(t)
  const check = async (content, file, refresh) => {
    const result = await f.call()
    assertFile(result, content, file, refresh)
    const pack = readCodex({ env: {}, home: f.root, readBytes: packBytes, sha256 })
    assert.equal(result.file, pack.file)
    assert.equal(result.account === pack.account, true)
    assert.equal(result.lastRefresh, pack.lastRefresh)
    const stat = lstatSync(f.file, { throwIfNoEntry: false })
    if (stat?.isDirectory()) rmdirSync(f.file)
    else if (stat) unlinkSync(f.file)
  }
  await check('', 'absent')
  mkdirSync(f.file)
  await check('', 'unreadable')
  const exact = auth + ' '.repeat(CODEX_MAX_BYTES - Buffer.byteLength(auth))
  writeFileSync(f.file, exact)
  await check(exact, 'present', REFRESHED)
  writeFileSync(f.file, exact + ' ')
  await check('', 'unreadable')
  const target = join(f.root, 'target.json')
  symlinkSync(target, f.file)
  await check('', 'absent')
  writeFileSync(target, auth)
  symlinkSync(target, f.file)
  await check(auth, 'present', REFRESHED)
  if (process.platform !== 'win32') {
    await promisify(execFile)('mkfifo', [f.file])
    await check('', 'unreadable')
  }
})

test('ignores CODEX_HOME and uses the configured override exclusively with its actual folder', async t => {
  const f = setup(t)
  const decoy = join(f.root, 'decoy')
  mkdirSync(decoy)
  const other = JSON.stringify({ tokens: { account_id: 'test-alt' } })
  writeFileSync(join(decoy, 'auth.json'), other)
  writeFileSync(f.file, auth)
  f.env.CODEX_HOME = decoy
  assertFile(await f.call(), auth, 'present', REFRESHED)
  f.env[OVERRIDE] = decoy
  assertFile(await f.call(), other, 'present', null, '~/decoy')
  f.env[OVERRIDE] = f.root
  assertFile(await f.call(), '', 'absent', null, '~')
  const outside = mkdtempSync(join(tmpdir(), 'omni-codex-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'auth.json'), other)
  f.env[OVERRIDE] = outside
  assertFile(await f.call(), other, 'present', null, outside)
  f.env[OVERRIDE] = join(decoy, 'auth.json')
  assertFile(await f.call(), '', 'absent', null, '~/decoy/auth.json')
  for (const invalid of ['', '.', null, join(decoy, 'bad\x1b'), '/' + '界'.repeat(171)]) {
    f.env[OVERRIDE] = invalid
    assertFile(await f.call(), '', 'unreadable', null, '')
  }
})

test('a relative OS home does not read a cwd-relative Codex file', async t => {
  const f = setup(t, { homedir: () => relative(process.cwd(), f.root) })
  f.env.HOME = 'relative'
  writeFileSync(f.file, auth)
  assert.deepEqual(await f.call(), { folder: '', file: 'unreadable', account: null, lastRefresh: null })

  f.env[OVERRIDE] = f.dir
  assertFile(await f.call(), auth, 'present', REFRESHED, f.dir)
})

test('a relative HOME falls back to an absolute OS home and ignores CODEX_HOME', async t => {
  const f = setup(t, { homedir: () => f.root })
  writeFileSync(f.file, auth)
  f.env.HOME = 'relative'
  f.env.CODEX_HOME = join(f.root, 'decoy')
  assertFile(await f.call(), auth, 'present', REFRESHED)
  assert.deepEqual(f.calls(), [])
})

test('the observed account folder is capped without reading outside the override', async t => {
  const f = setup(t)
  const folder = join(f.root, 'x'.repeat(160), 'y'.repeat(150))
  f.env[OVERRIDE] = folder
  const result = await f.call()
  assert.equal(result.file, 'absent')
  assert.equal(result.folder.length, 300)
  assert.equal(result.folder, ('~/' + 'x'.repeat(160) + '/' + 'y'.repeat(150)).slice(0, 300))
  assert.equal(result.account, null)
  assert.deepEqual(f.calls(), [])
})
