// Antigravity's paste-back (#2048): where agy listens (callbackOf), the pasted address against
// that attempt (checkCallback), and its one delivery to agy's own loopback listener
// (deliverCallback). Pure, plus an in-test HTTP server on 127.0.0.1:0; no agy runs.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { test } from 'node:test'
import { callbackOf, checkCallback, deliverCallback } from '../src/host/sign-in-callback.js'

const STATE = 'Ab-_.~xyz12345'
const google = (redirect, state = STATE) => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&state=${encodeURIComponent(state)}`
const EXPECTED = { host: 'localhost', port: 41234, path: '/auth/callback', state: STATE }
const pasted = (rest = '', { host = 'localhost', port = 41234, path = '/auth/callback', state = STATE } = {}) =>
  `http://${host}:${port}${path}?code=4%2F0Abc&state=${encodeURIComponent(state)}${rest}`

test('C1: callbackOf takes port, path and state from Google\'s link; anything else is not taken', () => {
  assert.deepEqual(callbackOf(google('http://localhost:41234/auth/callback')), EXPECTED)
  assert.deepEqual(callbackOf(google('http://127.0.0.1:41234/cb')), { host: '127.0.0.1', port: 41234, path: '/cb', state: STATE })
  assert.deepEqual(callbackOf(google('http://[::1]:41234/cb')), { host: '[::1]', port: 41234, path: '/cb', state: STATE })
  // Port 1024 is the lowest taken (G6-9).
  assert.equal(callbackOf(google('http://localhost:1024/cb')).port, 1024)
  for (const link of [
    google('http://localhost:41234/auth/callback').replace(/&state=[^&]*/, ''),
    google('http://localhost:41234/auth/callback', 'short'),
    `${google('http://localhost:41234/auth/callback')}&state=${STATE}`,
    google('http://localhost/auth/callback'),
    google('http://localhost:80/auth/callback'),
    google('http://localhost:1023/auth/callback'),
    google('https://localhost:41234/auth/callback'),
    google('http://evil.example:41234/auth/callback'),
    google('http://u@localhost:41234/auth/callback'),
    google('http://localhost:41234/auth/callback#x'),
    'not a url', undefined, 42,
  ]) assert.equal(callbackOf(link), undefined, String(link))
})

test('C2: checkCallback accepts only that attempt\'s address, and never throws', () => {
  assert.deepEqual(checkCallback(`  ${pasted()}\n`, EXPECTED), { path: `/auth/callback?code=4%2F0Abc&state=${encodeURIComponent(STATE)}` })
  const refused = [
    pasted('', { port: 41235 }),
    pasted('', { state: 'Zz-_.~xyz12345' }),
    pasted(`&state=${STATE}`),
    `http://localhost:41234/auth/callback?state=${STATE}`,
    `http://localhost:41234/auth/callback?code=&state=${STATE}`,
    `http://localhost:41234/auth/callback?code=a&code=b&state=${STATE}`,
    `http://localhost:41234/auth/callback?code=${'a'.repeat(4097)}&state=${STATE}`,
    pasted('', { host: 'evil.example' }),
    pasted('', { host: '127.0.0.2' }),
    pasted('', { host: '0.0.0.0' }),
    pasted('', { host: 'localhost.evil.example' }),
    pasted('', { host: '[::1]' }),
    pasted('', { path: '/auth/callback/' }),
    pasted('', { path: '/AUTH/callback' }),
    pasted().replace('http:', 'https:'),
    pasted().replace('http://', 'http://u@'),
    pasted().replace('http://localhost:41234', 'http://localhost:41234@evil.example'),
    `${pasted()}#fragment`,
    pasted().replace('code=', 'code= '),
    pasted().replace('code=', 'code=\u0007'),
    `${pasted()}&x=${'a'.repeat(8192)}`,
    '', '   ', undefined, 42,
    // G6-11 (b): refused on purpose.
    pasted('', { host: 'localhost.' }),
    pasted('', { host: '[::ffff:127.0.0.1]' }),
    pasted('', { host: '[0:0:0:0:0:0:0:1]' }),
    pasted('', { path: '/auth/%63allback' }),
    pasted('', { path: '/auth//callback' }),
    pasted('', { path: '/auth/callback/.' }),
    `http://localhost:41234/auth/callback?code=a;state=${STATE}`,
    `http://localhost:41234/auth/callback?code=a&state=${STATE}&state=`,
    pasted('', { port: 80 }),
  ]
  for (const value of refused) assert.equal(checkCallback(value, EXPECTED), undefined, String(value).slice(0, 120))
  // G6-11 (b): accepted on purpose. WHATWG URL names the same loopback address, port, path and
  // parameter, and the connect address never comes from the paste (deliverCallback).
  const accepted = [
    pasted('', { host: 'LOCALHOST' }),
    pasted('', { host: '2130706433' }),
    pasted('', { host: '0x7f.1' }),
    pasted('', { host: '127.1' }),
    pasted('', { host: '%6cocalhost' }),
    pasted().replace('http://localhost:41234/auth/callback', 'http:\\\\localhost:41234\\auth\\callback'),
    pasted('', { port: '041234' }),
    pasted('', { path: '/auth/../auth/callback' }),
    pasted('', { path: '/./auth/callback' }),
    pasted().replace('state=', 'sta%74e='),
  ]
  for (const value of accepted) assert.ok(checkCallback(value, EXPECTED), value)
  // `[::1]` is accepted only when agy's own return address is `[::1]` (r6 choice 7).
  assert.ok(checkCallback(pasted('', { host: '[0:0:0:0:0:0:0:1]' }), { ...EXPECTED, host: '[::1]' }))
  assert.ok(checkCallback(pasted('', { host: '[::1]' }), { ...EXPECTED, host: '[::1]' }))
})

test('C2b: an address URL cannot parse answers undefined and holds nothing of it', () => {
  const value = `http://localhost:99999/auth/callback?code=SECRET&state=${STATE}`
  let answer
  assert.doesNotThrow(() => { answer = checkCallback(value, EXPECTED) })
  assert.equal(answer, undefined)
})

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })

test('C3: one GET with the pasted path and agy\'s Host; no redirect followed; the body never read', async (t) => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, method: req.method })
    if (req.url.includes('redirect')) { res.writeHead(302, { location: 'http://evil.example/' }); res.end(); return }
    if (req.url.includes('big')) { res.writeHead(200); res.write(Buffer.alloc(1024 * 1024, 120)); return }
    res.writeHead(req.url.includes('bad') ? 400 : 200)
    res.end('ok')
  })
  const port = await listen(server)
  t.after(() => close(server))
  const at = { host: 'localhost', port }
  assert.deepEqual(await deliverCallback({ ...at, path: '/auth/callback?code=a&state=s' }, { timeoutMs: 2000 }), { status: 200 })
  assert.deepEqual(seen, [{ url: '/auth/callback?code=a&state=s', host: `localhost:${port}`, method: 'GET' }])
  assert.deepEqual(await deliverCallback({ ...at, path: '/redirect' }, { timeoutMs: 2000 }), { status: 302 })
  assert.equal(seen.length, 2)
  assert.deepEqual(await deliverCallback({ ...at, path: '/big' }, { timeoutMs: 2000 }), { status: 200 })
  assert.deepEqual(await deliverCallback({ ...at, path: '/bad' }, { timeoutMs: 2000 }), { status: 400 })
  assert.equal(seen.length, 4)
})

test('C3: a listener that never answers, or trickles bytes, is cut at the deadline; a closed port is unreachable', async (t) => {
  const silent = createTcpServer(() => {})
  const sockets = []
  const trickle = createTcpServer((socket) => {
    sockets.push(socket)
    const timer = setInterval(() => { try { socket.write('H') } catch {} }, 100)
    socket.on('close', () => { clearInterval(timer); socket.closedAt = Date.now() })
    socket.on('error', () => {})
  })
  const silentPort = await listen(silent)
  const tricklePort = await listen(trickle)
  t.after(() => { silent.close(); trickle.close(); for (const socket of sockets) socket.destroy() })
  for (const port of [silentPort, tricklePort]) {
    const started = Date.now()
    await assert.rejects(deliverCallback({ host: '127.0.0.1', port, path: '/auth/callback?code=SECRET' }, { timeoutMs: 200 }), (error) => {
      assert.equal(error.message, 'unreachable')
      assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyNames(error).map(key => error[key])), /SECRET|auth\/callback/)
      return true
    })
    assert.ok(Date.now() - started < 300 + 100, `${Date.now() - started} ms`)
  }
  // The trickling listener sees its socket closed.
  const from = Date.now()
  while (sockets.some(socket => socket.closedAt === undefined) && Date.now() - from < 1000) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(sockets.length > 0 && sockets.every(socket => socket.closedAt !== undefined))
  // A closed port: unreachable, with no URL in the error.
  const gone = createTcpServer()
  const gonePort = await listen(gone)
  await new Promise(resolve => gone.close(resolve))
  await assert.rejects(deliverCallback({ host: '127.0.0.1', port: gonePort, path: '/auth/callback?code=SECRET' }, { timeoutMs: 1000 }), (error) => {
    assert.equal(error.message, 'unreachable')
    assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyNames(error).map(key => error[key])), /SECRET/)
    return true
  })
})

// A stand-in for http.request: records each call and acts per address.
function fakeRequest(act) {
  const calls = []
  const request = (options) => {
    calls.push(options)
    const req = new EventEmitter()
    req.end = () => { queueMicrotask(() => act(options.host, req, options)) }
    req.destroy = () => { req.destroyed = true }
    return req
  }
  return { calls, request }
}

test('C3: only 127.0.0.1 and ::1 are ever connected; the localhost fallback shares the one deadline', async () => {
  const refused = (req) => req.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  const answer = (req) => {
    const res = new EventEmitter()
    res.statusCode = 200
    res.destroy = () => {}
    req.emit('response', res)
  }
  // localhost: 127.0.0.1 refused, then ::1 answers.
  const fallback = fakeRequest((host, req) => (host === '127.0.0.1' ? refused(req) : answer(req)))
  assert.deepEqual(await deliverCallback({ host: 'localhost', port: 41234, path: '/cb?code=a' }, { request: fallback.request }), { status: 200 })
  assert.deepEqual(fallback.calls.map(call => call.host), ['127.0.0.1', '::1'])
  assert.equal(fallback.calls[1].headers.host, 'localhost:41234')
  assert.equal(fallback.calls[1].agent, false)
  // 127.0.0.1 refused and ::1 stalls: rejected within the one deadline.
  const stall = fakeRequest((host, req) => { if (host === '127.0.0.1') refused(req) })
  const started = Date.now()
  await assert.rejects(deliverCallback({ host: 'localhost', port: 41234, path: '/cb' }, { timeoutMs: 200, request: stall.request }), { message: 'unreachable' })
  assert.ok(Date.now() - started < 300, `${Date.now() - started} ms`)
  // 127.0.0.1 and [::1] returns: one address each, no fallback; another error does not fall back.
  for (const [host, address] of [['127.0.0.1', '127.0.0.1'], ['[::1]', '::1']]) {
    const one = fakeRequest((_, req) => refused(req))
    await assert.rejects(deliverCallback({ host, port: 41234, path: '/cb' }, { request: one.request }), { message: 'unreachable' })
    assert.deepEqual(one.calls.map(call => call.host), [address])
  }
  const reset = fakeRequest((_, req) => req.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
  await assert.rejects(deliverCallback({ host: 'localhost', port: 41234, path: '/cb' }, { request: reset.request }), { message: 'unreachable' })
  assert.deepEqual(reset.calls.map(call => call.host), ['127.0.0.1'])
})
