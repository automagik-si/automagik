import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { carrier, localHTTP, prefix, send, wire } from '../../multiuser-dsh/test/runtime.mjs'
import { allowlist, fixture, guest } from './caller-fixture.js'

const post = '/api/omni-ui'
const person = { ...wire.payload.principal, ...guest.person }
const body = (endpoint, viewer) => JSON.stringify({ endpoint, viewer })

function transport(t, f, expectedAuthority) {
  const routes = f.ctx.get('automagikCallerRoutes')
  let dispatched = 0
  const adapter = carrier(t, { ...(expectedAuthority ? { expectedAuthority } : {}), callerRoutes: () => ({
    version: routes.version,
    match(path, method) {
      const handler = routes.match(path, method)
      if (handler) return (...args) => { dispatched++; return handler(...args) }
    },
  }) })
  const signature = (method, path, session = 'family') => adapter.key.assertion({ method, path, principal: person, session: createHash('sha256').update(session).digest('base64url') })
  const call = (path, { method = 'POST', session, ...options } = {}) =>
    adapter.call(path, { method, assertion: signature(method, path, session), ...options })
  return { ...adapter, signature, call, dispatched: () => dispatched }
}

test('CC1 an admitted guest lists only the allowlisted Bot through the real carrier', async t => {
  const f = fixture(t)
  await f.start()
  await f.open()
  await f.open('a', allowlist)
  const adapter = transport(t, f)
  const reply = await adapter.call(post, { body: body('list-bots', f.rt.viewerOf(guest).id) })
  assert.equal(reply.status, 200)
  assert.deepEqual(JSON.parse(reply.bytes).value.map(bot => bot.id), ['a'])
  assert.equal(adapter.dispatched(), 1)
})

test('CC2 an oversized POST never dispatches and its slot is available again', async t => {
  const f = fixture(t)
  await f.start()
  const adapter = transport(t, f)
  for (let i = 0; i < 5; i++) {
    assert.equal((await adapter.call(post, { body: 'x'.repeat(16_385), headers: { 'content-length': '16385' } })).status, 413)
  }
  assert.equal(adapter.dispatched(), 0)
  assert.equal((await adapter.call(post, { body: body('whoami') })).status, 200)
})

test('CC3 a fifth in-flight upload of the same person is refused before reading and a sixth succeeds', async t => {
  const f = fixture(t)
  await f.start()
  const adapter = transport(t, f)
  function held(index) {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const reply = adapter.call(post, {
      session: 'family-' + index, body: body('whoami'),
      onTransport(req) {
        const iterate = req.iterator.bind(req)
        req.iterator = async function* (options) {
          entered.resolve()
          await release.promise
          yield* iterate(options)
        }
      },
    })
    return { entered: entered.promise, release: release.resolve, reply }
  }
  const uploads = Array.from({ length: 4 }, (_, index) => held(index))
  try {
    await Promise.all(uploads.map(upload => upload.entered))
    let read = false
    const fifth = await adapter.call(post, { body: body('whoami'), onTransport(req) {
      req.iterator = () => { read = true; assert.fail('fifth upload was read') }
    } })
    assert.equal(fifth.status, 429)
    assert.equal(read, false)
    assert.equal(adapter.dispatched(), 0)
    uploads[0].release()
    assert.equal((await uploads[0].reply).status, 200)
    assert.equal((await adapter.call(post, { body: body('whoami') })).status, 200)
  } finally {
    for (const upload of uploads) upload.release()
    await Promise.all(uploads.map(upload => upload.reply))
  }
})

test('CC4 disconnecting one carrier connection releases only its feed', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.start()
  const viewer = f.rt.viewerOf(guest)
  const feed = `${post}/feed?viewer=${viewer.id}.${viewer.role}`
  let authority
  const adapter = transport(t, f, () => authority)
  const ended = Promise.withResolvers()
  const upstream = await localHTTP(t, (req, res) => {
    if (req.headers['x-automagik-caller'] === firstSignature) res.once('close', ended.resolve)
    return adapter.handler(req, res)
  })
  authority = upstream.authority
  const firstSignature = adapter.signature('GET', feed, 'family-one')
  function open(session, signature = adapter.signature('GET', feed, session)) {
    const network = http.request({ hostname: '127.0.0.1', port: upstream.port, path: prefix + feed, agent: false,
      headers: { host: authority, 'x-automagik-caller': signature } })
    const hello = Promise.withResolvers()
    const revision = Promise.withResolvers()
    network.on('response', response => {
      assert.equal(response.statusCode, 200)
      response.setEncoding('utf8')
      response.on('data', chunk => {
        if (chunk.includes('event: hello')) hello.resolve()
        if (chunk.includes('event: revision')) revision.resolve()
      })
    })
    network.on('error', hello.reject)
    network.end()
    t.after(() => network.destroy())
    return { network, hello: hello.promise, revision: revision.promise }
  }
  const first = open('family-one', firstSignature)
  const second = open('family-two')
  await Promise.all([first.hello, second.hello])
  first.network.destroy()
  await ended.promise
  f.rt.accessChanged()
  await second.revision
  await Promise.all([open('family-three').hello, open('family-four').hello, open('family-five').hello])
})

test('CC5 fifty whoami round trips through the carrier on loopback', async t => {
  const f = fixture(t)
  await f.start()
  let authority
  const adapter = transport(t, f, () => authority)
  const upstream = await localHTTP(t, adapter.handler)
  authority = upstream.authority
  const timings = []
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    const reply = await send(upstream.port, prefix + post, {
      method: 'POST', body: body('whoami'),
      headers: { host: authority, 'x-automagik-caller': adapter.signature('POST', post), 'content-type': 'application/json' },
    })
    timings.push(performance.now() - start)
    assert.equal(reply.status, 200)
    assert.equal(JSON.parse(reply.bytes).value.role, 'guest')
  }
  timings.sort((a, b) => a - b)
  t.diagnostic(`CC5 50 loopback whoami round trips: median ${((timings[24] + timings[25]) / 2).toFixed(2)} ms, p95 ${timings[47].toFixed(2)} ms`)
})
