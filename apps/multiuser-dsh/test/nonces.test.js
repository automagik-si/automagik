import assert from 'node:assert/strict'
import test from 'node:test'
import { createNonces } from '../src/nonces.js'
import { carrier, rpc, seconds, target } from './runtime.mjs'

test('a full nonce store keeps unexpired entries and prunes expired entries', () => {
  const store = createNonces({ capacity: 2 })
  const consume = (nonce, exp, second) => {
    store.verificationSecond(second)
    return store.consume(nonce, exp)
  }
  assert.equal(consume('a', 10, 0), 'ok')
  assert.equal(consume('b', 20, 0), 'ok')
  assert.equal(consume('c', 30, 1), 'full')
  assert.equal(consume('a', 10, 2), 'replay')
  assert.equal(consume('b', 20, 2), 'replay')
  assert.equal(consume('c', 30, 10), 'ok')
  assert.equal(consume('b', 20, 10), 'replay')
})

test('concurrent copies admit one request and a full store answers 503', async t => {
  const f = carrier(t, { nonces: createNonces({ capacity: 1 }) })
  let calls = 0
  f.observe(() => { calls++; return { ok: true, value: null } })
  const assertion = f.key.assertion()
  const both = await Promise.all(Array.from({ length: 2 }, () => f.call(target, { assertion, body: rpc() })))
  assert.deepEqual(both.map(result => result.status).sort(), [200, 401])
  assert.equal((await f.call(target, { body: rpc() })).status, 503)
  assert.equal(calls, 1)
})

test('clock rollback and handler replacement cannot reopen a consumed assertion after expiry-ordered pruning', async t => {
  let nowSec = seconds
  const f = carrier(t, { nonces: createNonces({ capacity: 3, startedAtSec: seconds - 6 }), now: () => nowSec * 1000 })
  let calls = 0
  f.observe(() => { calls++; return { ok: true, value: null } })
  const late = f.key.assertion({ exp: seconds + 60 })
  const early = f.key.assertion({ exp: seconds + 5 })
  const send = assertion => f.call(target, { assertion, body: rpc() })
  assert.equal((await send(late)).status, 200)
  assert.equal((await send(early)).status, 200)
  assert.equal((await send(f.key.assertion({ exp: seconds + 5 }))).status, 200)
  const refused = f.key.assertion()
  for (let i = 0; i < 32; i++) assert.equal((await send(refused)).status, 503)
  nowSec += 5
  assert.equal((await send(refused)).status, 200)
  nowSec = seconds
  assert.equal((await send(early)).status, 401)
  assert.equal((await send(late)).status, 401)
  f.replaceHandler()
  assert.equal((await send(early)).status, 401)
  assert.equal((await send(late)).status, 401)
  assert.equal(calls, 4)
})
