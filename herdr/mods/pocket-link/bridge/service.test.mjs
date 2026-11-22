import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquire, stateLock, underLock } from './service.mjs'
import { cancelCode, challengeId } from './pairing.mjs'
import { resetKey } from './reset.mjs'
import { setTimeout as delay } from 'node:timers/promises'

test('the state lock serializes code replacement and cancel; old age never evicts a live holder', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = stateLock(dir)
  const lock = await acquire(path)
  const challenge = join(dir, 'pairing.json')
  const old = { code: 'old', expires: Date.now() + 10_000 }
  const replacement = { ...old, code: 'replacement' }
  writeFileSync(challenge, JSON.stringify(old))
  utimesSync(path, 0, 0)

  assert.equal(JSON.parse(readFileSync(challenge, 'utf8')).code, 'old')
  let replaced = false
  const replace = acquire(path).then(contender => {
    try {
      replaced = true
      writeFileSync(challenge, JSON.stringify(replacement))
    } finally { contender.release() }
  })
  await assert.rejects(acquire(path, { wait: 0 }), /busy/)
  assert.equal(replaced, false)
  assert.equal(cancelCode(challenge, Date.now(), challengeId(old.code)), true)
  lock.release()
  await replace
  assert.deepEqual(JSON.parse(readFileSync(challenge, 'utf8')), replacement)
  assert.equal(existsSync(path), false)
})

test('contenders can reclaim an owner that disappeared without releasing its lock', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-stale-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = stateLock(dir)
  writeFileSync(path, JSON.stringify({ pid: 2147483647, start: 'never', token: 'old' }))
  const first = await acquire(path)
  assert.notEqual(JSON.parse(first.token).token, 'old')
  await assert.rejects(acquire(path, { wait: 0 }), /busy/)
  first.release()
  assert.equal(existsSync(path), false)
})

test('a new manager waits for the service command surviving its crashed parent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-fence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = stateLock(dir)
  writeFileSync(path, JSON.stringify({ pid: 2147483647, start: 'never', token: 'old' }))
  const fence = await acquire(`${path}.command`)
  let wrote = false
  const newOwner = underLock(path, () => { wrote = true })
  try {
    await delay(100)
    assert.equal(wrote, false)
  } finally { fence.release() }
  await newOwner
  assert.equal(wrote, true)
})

test('an offline reset waits for the state authority before deleting a pairing code', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-reset-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = stateLock(dir), pairing = join(dir, 'pairing.json')
  writeFileSync(pairing, JSON.stringify({ code: 'pending' }))
  const lock = await acquire(path)
  const resetting = resetKey({ dir, generate: () => Buffer.alloc(32), write: fn => underLock(path, fn) })
  try {
    await delay(100)
    assert.equal(existsSync(pairing), true)
  } finally { lock.release() }
  assert.equal((await resetting).ok, true)
  assert.equal(existsSync(pairing), false)
})
