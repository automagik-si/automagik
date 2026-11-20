import assert from 'node:assert/strict'
import test from 'node:test'
import { carrier, rpc, seconds, target, wire, wireEncode } from './runtime.mjs'

test('the shared wire fixture is accepted by the real HTTP carrier', async t => {
  const f = carrier(t)
  let calls = 0
  f.observe((_endpoint, _body, _signal, peer) => {
    calls++
    assert.deepEqual(peer.principal.person, wire.payload.principal)
    return { ok: true, value: null }
  })
  const h = Buffer.from(wire.protectedHeaderTemplate.replace('<kid>', f.key.kid)).toString('base64url')
  assert.equal(wireEncode(wire.payload), wire.payloadSegment)
  const assertion = f.key.signed(h, wire.payloadSegment)
  assert.equal((await f.call(target, { assertion, body: rpc() })).status, 200)
  assert.equal((await f.call(target, { assertion, body: rpc() })).status, 401)
  assert.equal(calls, 1)
  for (const [raw, expected] of wire.canonicalTargets) {
    const url = new URL(raw, 'http://x')
    assert.equal(url.pathname + url.search, expected)
  }
})

test('invalid wire cases all fail before reaching the shared RPC interceptor', async t => {
  const f = carrier(t)
  let calls = 0
  f.observe(() => { calls++; return { ok: true } })
  const { key } = f
  const assertion = key.assertion()
  const [h, p, s] = assertion.split('.')
  const attempts = [
    ['missing', null], ['oversized', 'x'.repeat(wire.limits.headerBytes + 1)],
    ['alg', key.assertion({}, { alg: 'none' })], ['typ', key.assertion({}, { typ: 'JWT' })],
    ['kid', key.assertion({}, { kid: 'AAAAAAAAAAAAAAAAAAAAAA' })],
    ['extra header field', key.assertion({}, { extra: true })],
    ['reordered header', key.signed(wireEncode({ typ: key.header.typ, ...key.header }), p)],
    ['extra payload field', key.assertion({ instance: wire.payload.aud })],
    ['missing field', key.assertion({ exp: undefined })],
    ['reordered field', key.signed(h, wireEncode({ aud: wire.payload.aud, ...wire.payload }))],
    ['non-canonical base64', key.signed(h + '=', p)],
    ['bad signature', `${h}.${p}.${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`],
    ['expired', key.assertion({ iat: seconds - 1, exp: seconds })],
    ['future', key.assertion({ iat: seconds + 6 })],
    ['long lifetime', key.assertion({ exp: seconds + 61 })],
    ['zero lifetime', key.assertion({ iat: seconds + 1, exp: seconds + 1 })],
    ['before restart', key.assertion({ iat: seconds - 6 })],
    ['within restart window', key.assertion({ iat: seconds - 1, exp: seconds + 1 })],
    ['wrong audience', key.assertion({ aud: 'other', principal: { ...wire.payload.principal, workspace: 'other' } })],
    ['wrong workspace', key.assertion({ principal: { ...wire.payload.principal, workspace: 'other' } })],
    ...[['owner'], ['admin'], ['member', 'member'], [], ['invalid']].map(roles =>
      [`roles ${roles}`, key.assertion({ principal: { ...wire.payload.principal, roles } })]),
    ['bad method', key.assertion({ method: 'post' })],
    ['bad path', key.assertion({ path: 'api/fixture' })],
    ['bad nonce', key.assertion({ nonce: 'invalid' })],
    ['bad session', key.assertion({ session: 'invalid' })],
  ]
  for (const [description, value] of attempts) {
    assert.equal((await f.call(target, { headers: { 'x-automagik-caller': value ?? undefined }, body: rpc() })).status, 401, description)
  }
  assert.equal(calls, 0)
})
