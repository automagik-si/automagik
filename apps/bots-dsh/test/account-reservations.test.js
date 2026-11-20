import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAccountReservations, RESERVATION_FILE } from '../src/host/account-reservations.js'
import { homeLock } from '../src/host/home-lock.js'
import { CODEX_PLAN_CLASSES } from '../src/shared/codex-plan-classes.js'
import { CODEX_PLAN_CLASSES as ACP_PLAN_CLASSES } from '../../acp-dsh/src/host/reservation-evidence.js'
import { CLAUDE, CLAUDE_ACCOUNT, CODEX, reservationAcp } from './fixtures/account-reservations.js'

const random = (size, encoding = 'base64url') => randomBytes(size).toString(encoding)
const decodeKey = key => Buffer.from(key, 'base64url')
const otherToken = () => random(16)
const code = state => ({ code: `bot/reservation-${state}` })

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'automagik-reservations-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const path = join(home, RESERVATION_FILE)
  const newHost = (options = {}) => {
    const { service, accounts, calls } = reservationAcp()
    let instance = 'first-instance'
    const rt = { holdsLock: () => true, readOnly: () => undefined }
    const api = createAccountReservations(rt, {
      path, fs, random, decodeKey, instanceId: () => instance, pid: process.pid, ...options,
    })
    return {
      api, service, accounts, calls, rt, setInstance: value => { instance = value },
      list: async (provider = CLAUDE) => api.list(service, provider, await service.account(provider, { fresh: true })),
      reserve: (offer, label = 'Project', rename = {}) => api.reserve(service, { ...offer, label, ...rename }),
      release: ({ claimId, rev }) => api.release({ claimId, rev }),
    }
  }
  return {
    ...newHost(), newHost, path, home,
    bytes: () => fs.readFileSync(path, 'utf8'),
    record: () => JSON.parse(fs.readFileSync(path, 'utf8')),
    put: source => fs.writeFileSync(path, source, { mode: 0o600 }),
  }
}

test('the Codex plan classes match the ACP evidence contract', () => {
  assert.deepEqual(CODEX_PLAN_CLASSES, ACP_PLAN_CLASSES)
})

test('an empty read only offers a key, then reserve promotes it in a private file a restart can read', async t => {
  const h = fixture(t)
  const evidence = h.service.accountEvidence
  const keys = []
  h.service.accountEvidence = async (id, { key }) => {
    keys.push(Buffer.from(key).toString('base64url'))
    return evidence(id, { key })
  }
  const first = await h.list()
  const second = await h.list(CODEX)
  assert.equal(first.state, 'complete')
  assert.deepEqual(first.claims, [])
  assert.equal(second.scope, 'personal')
  assert.equal(fs.existsSync(h.path), false)
  const reserved = await h.reserve(first.offer)
  assert.deepEqual(keys, Array(3).fill(keys[0]))
  const saved = h.record()
  assert.equal(saved.version, 1)
  assert.equal(saved.key, keys[0])
  assert.equal(decodeKey(saved.key).length, 32)
  assert.equal(fs.statSync(h.path).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(h.home), [RESERVATION_FILE])
  assert.deepEqual(reserved.claims.map(({ label, current, mine }) => ({ label, current, mine })),
    [{ label: 'Project', current: true, mine: true }])

  const restart = h.newHost()
  const after = await restart.list()
  const { claimId, rev } = after.claims[0]
  assert.notEqual(claimId, reserved.claims[0].claimId)
  assert.equal(rev, reserved.claims[0].rev)
  assert.equal(after.claims[0].current, true)
  restart.accounts[CLAUDE] = null
  restart.service.accountEvidence = () => assert.fail('release reads no account')
  assert.deepEqual(await restart.release({ claimId, rev }), { state: 'unknown', claims: [] })
  assert.deepEqual(h.record(), { version: 1, key: saved.key, claims: {} })
})

test('damaged envelopes refuse both actions and keep every byte', async t => {
  const h = fixture(t)
  const { offer } = await h.list()
  const token = otherToken()
  const key = random(32)
  const exact = random(32)
  const claim = { vendor: 'claude', exact, loose: random(32), instance: 'first-instance',
    label: 'Project', at: new Date().toISOString(), rev: token }
  for (const source of [
    '{broken',
    Buffer.from([0x7b, 0xff, 0x7d]),
    JSON.stringify({ version: 2, key, claims: {} }),
    JSON.stringify({ version: 1, key, claims: [] }),
    JSON.stringify({ version: 1, key: random(31), claims: {} }),
    JSON.stringify({ version: 1, key: random(33), claims: {} }),
    JSON.stringify({ version: 1, key, claims: { [`claude:${exact}`]: { ...claim, rev: 1 } } }),
    JSON.stringify({ version: 1, key, claims: { [`claude:${exact}`]: { ...claim, class: 'personal' } } }),
    JSON.stringify({ version: 1, key, claims: { [`claude:${exact}`]: { ...claim, label: 'not\nclean' } } }),
    JSON.stringify({ version: 1, key, claims: { wrong: claim } }),
  ]) {
    h.put(source)
    assert.deepEqual(await h.list(), { state: 'damaged', claims: [] })
    await assert.rejects(h.reserve(offer), code('damaged'))
    await assert.rejects(h.release({ claimId: token, rev: token }), code('damaged'))
    assert.deepEqual(fs.readFileSync(h.path), Buffer.from(source))
  }
  assert.deepEqual(fs.readdirSync(h.home), [RESERVATION_FILE])
})

test('unsafe permissions, non-regular records, and symlinks are refused without reading through', async t => {
  const h = fixture(t)
  const { offer } = await h.list()
  const token = otherToken()
  const refuse = async () => {
    assert.deepEqual(await h.list(), { state: 'unsafe', claims: [] })
    await assert.rejects(h.reserve(offer), code('unsafe'))
    await assert.rejects(h.release({ claimId: token, rev: token }), code('unsafe'))
  }
  h.put('private bytes')
  fs.chmodSync(h.path, 0o640)
  await refuse()
  assert.equal(h.bytes(), 'private bytes')
  assert.equal(fs.statSync(h.path).mode & 0o777, 0o640)
  fs.unlinkSync(h.path)
  fs.mkdirSync(h.path)
  await refuse()
  assert.equal(fs.lstatSync(h.path).isDirectory(), true)
  fs.rmdirSync(h.path)
  const target = join(h.home, 'target')
  fs.symlinkSync(target, h.path)
  await refuse()
  assert.equal(fs.readlinkSync(h.path), target)
  assert.equal(fs.existsSync(target), false)
  fs.writeFileSync(target, 'target bytes', { mode: 0o600 })
  await refuse()
  assert.equal(fs.readlinkSync(h.path), target)
  assert.equal(fs.readFileSync(target, 'utf8'), 'target bytes')
})

test('an unreadable regular file leaves its bytes untouched', async t => {
  const h = fixture(t)
  let blocked = false
  const host = h.newHost({ fs: { ...fs, openSync: (path, ...args) => {
    if (blocked && path === h.path) throw Object.assign(new Error('private path'), { code: 'EACCES' })
    return fs.openSync(path, ...args)
  } } })
  const reserved = await host.reserve((await host.list()).offer)
  const before = h.bytes()
  blocked = true
  assert.deepEqual(await host.list(), { state: 'unreadable', claims: [] })
  await assert.rejects(host.reserve(reserved.offer), code('unreadable'))
  await assert.rejects(host.release(reserved.claims[0]), code('unreadable'))
  assert.equal(h.bytes(), before)
})

test('a different first writer wins and a persisted-key offer cannot recreate a removed record', async t => {
  const h = fixture(t)
  const loser = h.newHost()
  const { offer } = await loser.list()
  await h.reserve((await h.list()).offer)
  const before = h.bytes()
  await assert.rejects(loser.reserve(offer), code('changed'))
  assert.equal(h.bytes(), before)
  const persisted = (await h.list()).offer
  fs.unlinkSync(h.path)
  await assert.rejects(h.reserve(persisted), code('changed'))
  assert.equal(fs.existsSync(h.path), false)
})

test('offers expire after ten minutes and only twenty live offers are kept', async t => {
  const h = fixture(t)
  let time = Date.now()
  const host = h.newHost({ now: () => time })
  const offer = (await host.list()).offer
  for (let i = 0; i < 20; i++) await host.list()
  await assert.rejects(host.reserve(offer), code('changed'))
  const recent = (await host.list()).offer
  time += 10 * 60_000
  await assert.rejects(host.reserve(recent), code('changed'))
  assert.equal(fs.existsSync(h.path), false)
})

test('claims bind rename and release to the revision and instance, including after re-creation', async t => {
  const h = fixture(t)
  const staleOffer = (await h.list()).offer
  const first = await h.reserve((await h.list()).offer, 'First project')
  const { claimId, rev } = first.claims[0]
  const origin = h.bytes()
  await assert.rejects(h.reserve(staleOffer), code('changed'))
  await assert.rejects(h.reserve(first.offer), code('changed'))
  await assert.rejects(h.reserve(first.offer, 'Wrong revision', { claimId, rev: otherToken() }), code('changed'))
  h.setInstance('different-instance')
  await assert.rejects(h.release({ claimId, rev }), code('changed'))
  await assert.rejects(h.reserve((await h.list()).offer), {
    code: 'bot/refused', message: 'This account is reserved for First project by another installation that shares this team.',
  })
  assert.equal(h.bytes(), origin)
  h.setInstance('first-instance')
  const renamed = await h.reserve(first.offer, 'New project', { claimId, rev })
  assert.equal(renamed.claims[0].claimId, claimId)
  assert.notEqual(renamed.claims[0].rev, rev)
  await assert.rejects(h.release({ claimId, rev }), code('changed'))
  await h.release(renamed.claims[0])
  const recreated = await h.reserve((await h.list()).offer, 'Recreated')
  assert.notEqual(recreated.claims[0].rev, renamed.claims[0].rev)
  await assert.rejects(h.release(renamed.claims[0]), code('changed'))
  assert.equal(Object.values(h.record().claims)[0].label, 'Recreated')
})

test('the project name is one clean line of up to 60 characters', async t => {
  const h = fixture(t)
  const { offer } = await h.list()
  for (const label of ['', '\x00 \x7f', 'x'.repeat(61), '🌱'.repeat(61), '\ud800', 12]) {
    await assert.rejects(h.reserve(offer, label), { code: 'bot/invalid', message: 'Give the project a name, up to 60 characters.' })
  }
  assert.equal(fs.existsSync(h.path), false)
  assert.equal((await h.reserve(offer, '  Pond\x00   \tGarden  ')).claims[0].label, 'Pond Garden')
  const { offer: rename, claims: [{ claimId, rev }] } = await h.list()
  assert.equal((await h.reserve(rename, '🌱'.repeat(60), { claimId, rev })).claims[0].label, '🌱'.repeat(60))
})

test('overlapping writes queue the fresh reads and keep two accounts of one vendor', async t => {
  const h = fixture(t)
  const first = (await h.list()).offer
  const another = { ...CLAUDE_ACCOUNT, email: 'another@example.test', ref: 'another-ref' }
  h.accounts[CLAUDE] = another
  const second = (await h.list()).offer
  h.accounts[CLAUDE] = CLAUDE_ACCOUNT
  const evidence = h.service.accountEvidence
  const entered = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  let reads = 0
  h.service.accountEvidence = async (...args) => {
    const result = await evidence(...args)
    if (++reads === 1) {
      entered.resolve()
      await proceed.promise
    }
    return result
  }
  const one = h.reserve(first, 'One')
  await entered.promise
  const two = h.reserve(second, 'Two')
  await Promise.resolve()
  assert.equal(reads, 1)
  h.accounts[CLAUDE] = another
  proceed.resolve()
  await one
  const result = await two
  assert.deepEqual(result.claims.map(({ label, current, mine }) => ({ label, current, mine })), [
    { label: 'One', current: false, mine: true }, { label: 'Two', current: true, mine: true },
  ])
  assert.equal(Object.keys(h.record().claims).length, 2)
  await h.release(result.claims[0])
  assert.deepEqual(Object.values(h.record().claims).map(claim => claim.label), ['Two'])
})

test('a lost lock during the ACP read or before rename leaves no file or temp', async t => {
  const h = fixture(t)
  const { offer } = await h.list()
  const evidence = h.service.accountEvidence
  h.service.accountEvidence = async (...args) => {
    h.rt.holdsLock = () => false
    return evidence(...args)
  }
  await assert.rejects(h.reserve(offer), { code: 'bot/read-only' })
  assert.deepEqual(fs.readdirSync(h.home), [])

  const host = h.newHost({ fs: { ...fs, fsyncSync: fd => {
    fs.fsyncSync(fd)
    host.rt.holdsLock = () => false
  } } })
  await assert.rejects(host.reserve((await host.list()).offer), { code: 'bot/read-only' })
  assert.deepEqual(fs.readdirSync(h.home), [])
})

test('a write failure cleans up the exclusive temp and the queue can still save', async t => {
  const h = fixture(t)
  let failing = true
  const host = h.newHost({ fs: { ...fs, renameSync: (temp, path) => {
    assert.match(temp.slice(h.path.length), /^\.\d+\.[a-f0-9]{16}\.tmp$/)
    assert.equal(fs.statSync(temp).mode & 0o777, 0o600)
    if (failing) throw Object.assign(new Error('private-path'), { code: 'EACCES' })
    fs.renameSync(temp, path)
  } } })
  const { offer } = await host.list()
  await assert.rejects(host.reserve(offer), { code: 'bot/refused', message: 'The reservation could not be saved. Try again.' })
  assert.deepEqual(fs.readdirSync(h.home), [])
  failing = false
  await host.reserve(offer)
  assert.deepEqual(fs.readdirSync(h.home), [RESERVATION_FILE])
})

test('the committing host rechecks the instance id after the fresh observation', async t => {
  const h = fixture(t)
  const { offer } = await h.list()
  const evidence = h.service.accountEvidence
  h.service.accountEvidence = async (...args) => {
    h.setInstance('another-instance')
    return evidence(...args)
  }
  await assert.rejects(h.reserve(offer), code('changed'))
  assert.deepEqual(fs.readdirSync(h.home), [])
})

test('a second process takes the team lock while the first is observing the account', { timeout: 10_000 }, async t => {
  const h = fixture(t)
  const lockPath = join(h.home, 'state.lock')
  const lock = homeLock(lockPath)
  t.after(lock.release)
  assert.equal(lock.claim(), undefined)
  h.rt.holdsLock = lock.owns
  const { offer } = await h.list()
  const entered = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  const evidence = h.service.accountEvidence
  h.service.accountEvidence = async (...args) => {
    const result = await evidence(...args)
    entered.resolve()
    await proceed.promise
    return result
  }
  const pending = assert.rejects(h.reserve(offer), { code: 'bot/read-only' })
  t.after(() => proceed.resolve())
  await entered.promise
  lock.release()
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { randomBytes } from 'node:crypto'
    import { createAccountReservations } from ${JSON.stringify(new URL('../src/host/account-reservations.js', import.meta.url))}
    import { homeLock } from ${JSON.stringify(new URL('../src/host/home-lock.js', import.meta.url))}
    import { CLAUDE, reservationAcp } from ${JSON.stringify(new URL('./fixtures/account-reservations.js', import.meta.url))}
    const [, path, lockPath] = process.argv
    const lock = homeLock(lockPath)
    assert.equal(lock.claim(), undefined)
    const { service } = reservationAcp()
    const api = createAccountReservations({ holdsLock: lock.owns, readOnly: () => undefined }, {
      path, fs, pid: process.pid, instanceId: () => 'winner',
      random: (size, encoding) => randomBytes(size).toString(encoding),
      decodeKey: key => Buffer.from(key, 'base64url'),
    })
    const { offer } = await api.list(service, CLAUDE, await service.account(CLAUDE, { fresh: true }))
    await api.reserve(service, { ...offer, label: 'Winner' })
    process.once('message', () => { lock.release(); process.disconnect() })
    process.send('saved')
  `, h.path, lockPath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(() => { if (child.exitCode === null) child.kill() })
  assert.equal(await Promise.race([once(child, 'message').then(([message]) => message), exited]), 'saved')
  assert.equal(lock.read().pid, child.pid)
  const winner = h.bytes()
  proceed.resolve()
  await pending
  assert.equal(h.bytes(), winner)
  assert.equal(Object.values(h.record().claims)[0].instance, 'winner')
  child.send('done')
  assert.deepEqual(await exited, [0, null])
})
