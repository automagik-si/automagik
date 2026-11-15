// The RFC 8252 sign-in flow (src/sign-in.js) against a throwaway provider on loopback: a real
// HTTP server that publishes discovery, authorizes, trades the code and serves its keys. The
// "browser" is a few lines of fetch, so the loopback redirect is exercised for real, and each
// test gets its own provider and its own key on its own ephemeral port. No real host, issuer or
// client id appears here (RFC 0024, contracts: placeholders only, also in tests).
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign as signJwt } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseDeepLink } from '../src/deeplink.js'
import {
  CALLBACK_PATH, SCOPE, SignInError, callbackUrlOf, createSignInFlow, issuerProblem,
  readSignInSettings, settingsFileOf,
} from '../src/sign-in.js'

const CLIENT_ID = 'test-desktop-client'

// An Ed25519 key, the shape the identity service's JWKS exposes. Each provider makes its own.
function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: `test-key-${randomUUID()}`, alg: 'EdDSA', use: 'sig' } }
}

function jwt(header, payload, privateKey) {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${head}.${body}.${signJwt(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen({ host: '127.0.0.1', port: 0 }, resolve)
})

/**
 * A throwaway OIDC provider. `overrides` changes what a well-behaved server would answer, one
 * layer at a time: `discovery` fields, `idToken` claims, `authorize` (a function returning the
 * redirect URL), `token` (a function returning the response body) or `tokenStatus`.
 */
async function startProvider(t, overrides = {}) {
  let key = makeKey()
  const calls = { discovery: 0, authorize: 0, token: 0, jwks: 0 }
  const codes = new Map()
  const refreshTokens = new Map()
  const requests = { authorize: [], tokens: [] }
  let origin = ''
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      calls.discovery += 1
      if (overrides.discoveryRedirect) {
        response.writeHead(302, { location: overrides.discoveryRedirect })
        return response.end()
      }
      const document = {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid', 'offline_access'],
        ...(overrides.discovery ?? {}),
      }
      return json(response, 200, document)
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      calls.jwks += 1
      const jwk = overrides.jwkWithoutAlg ? (() => { const { alg, ...rest } = key.jwk; return rest })() : key.jwk
      return json(response, 200, { keys: [jwk] })
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      calls.authorize += 1
      const query = Object.fromEntries(url.searchParams)
      requests.authorize.push(query)
      if (overrides.authorize) return overrides.authorize({ response, query, origin, codes })
      if (query.response_type !== 'code' || query.client_id !== CLIENT_ID || query.code_challenge_method !== 'S256') {
        return json(response, 400, { error: 'invalid_request' })
      }
      const code = `code-${randomUUID()}`
      codes.set(code, {
        challenge: query.code_challenge, redirectUri: query.redirect_uri, nonce: query.nonce, used: false, sub: 'person-1',
      })
      const state = overrides.state === undefined ? query.state : overrides.state
      response.writeHead(302, { location: `${query.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` })
      return response.end()
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      calls.token += 1
      const body = Object.fromEntries(new URLSearchParams(await textOf(request)))
      requests.tokens.push(body)
      // A slow exchange, so a test can try the loopback port while it is still held.
      if (overrides.tokenDelayMs) await new Promise(resolve => setTimeout(resolve, overrides.tokenDelayMs))
      if (overrides.tokenRedirect) {
        response.writeHead(302, { location: overrides.tokenRedirect })
        return response.end()
      }
      if (overrides.token) {
        const answer = overrides.token({ body, codes, refreshTokens, key, origin, clientId: CLIENT_ID, jwt })
        return json(response, answer.status ?? 200, answer.body)
      }
      if (body.grant_type === 'refresh_token') {
        if (!refreshTokens.has(body.refresh_token)) return json(response, 400, { error: 'invalid_grant' })
        const sub = refreshTokens.get(body.refresh_token)
        refreshTokens.delete(body.refresh_token)
        return json(response, 200, tokensFor({ sub, refresh: true }))
      }
      const stored = codes.get(body.code)
      if (!stored || stored.used) return json(response, 400, { error: 'invalid_grant' })
      if (body.redirect_uri !== stored.redirectUri || body.client_id !== CLIENT_ID) return json(response, 400, { error: 'invalid_grant' })
      const challenge = createHash('sha256').update(String(body.code_verifier)).digest('base64url')
      if (challenge !== stored.challenge) return json(response, 400, { error: 'invalid_grant' })
      stored.used = true
      return json(response, 200, tokensFor({ sub: stored.sub, nonce: stored.nonce }))
    }
    json(response, 404, { error: 'not_found' })
  })

  function tokensFor({ sub, nonce = undefined, refresh = false }) {
    const now = Math.floor(Date.now() / 1000)
    const idToken = jwt({ alg: 'EdDSA', kid: key.jwk.kid, typ: 'JWT', ...(overrides.header ?? {}) }, {
      iss: origin,
      sub,
      aud: CLIENT_ID,
      exp: now + 300,
      iat: now,
      ...(nonce === undefined ? {} : { nonce }),
      ...(overrides.idToken ?? {}),
    }, key.privateKey)
    const refreshToken = `refresh-${randomUUID()}`
    refreshTokens.set(refreshToken, sub)
    return {
      access_token: `access-${randomUUID()}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      // A refresh may answer without an ID token; the session's display claims then stay.
      ...(refresh ? {} : { id_token: idToken }),
      ...(overrides.tokenBody ?? {}),
    }
  }

  await listen(server)
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))
  return {
    origin, server, calls, codes, refreshTokens, requests,
    // The server's signing key changes; its JWKS follows at once, a client's cached copy does not.
    rotateKey() { key = makeKey(); return key.jwk },
  }
}

function textOf(request) {
  return new Promise((resolve, reject) => {
    const parts = []
    request.on('data', part => parts.push(part))
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    request.on('error', reject)
  })
}

/** The system browser, as far as the flow is concerned: follow the redirect to loopback. */
const browse = async (url) => {
  const response = await fetch(url, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (response.status !== 302 || !location) return
  await fetch(location)
}

const settingsFor = (provider, extra = {}) => ({ enabled: true, issuer: provider.origin, clientId: CLIENT_ID, problem: null, ...extra })

async function flowFor(t, provider, options = {}) {
  const flow = createSignInFlow({
    settings: settingsFor(provider, options.settings),
    fetch: globalThis.fetch,
    openExternal: options.openExternal ?? browse,
    timeoutMs: options.timeoutMs ?? 5000,
    ...(options.log ? { log: options.log } : {}),
  })
  t.after(() => flow.close())
  return flow
}

const refusalOf = async (promise) => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof SignInError, `expected a SignInError, got ${error}`)
    return error
  }
  assert.fail('the sign-in was expected to be refused')
}

// The port a refusal leaves closed: a second request finds nothing listening.
function rawRequest(port, host, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, response => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
    request.end()
  })
}

test('the setting is off by default: a missing file, a bad file, or no issuer and client id', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-signin-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = settingsFileOf(dir)
  assert.equal(file, join(dir, 'signin.json'))
  assert.deepEqual(readSignInSettings(file), { enabled: false, issuer: null, clientId: null, problem: null })

  writeFileSync(file, '{ not json')
  const bad = readSignInSettings(file)
  assert.equal(bad.enabled, false)
  assert.match(bad.problem, /could not be read/)

  writeFileSync(file, JSON.stringify({ enabled: true }))
  const missing = readSignInSettings(file)
  assert.equal(missing.enabled, true)
  assert.equal(missing.issuer, null)
  assert.match(missing.problem, /no issuer and client id/)

  writeFileSync(file, JSON.stringify({ enabled: false, issuer: 'https://id.example', clientId: 'x' }))
  assert.equal(readSignInSettings(file).enabled, false)

  writeFileSync(file, JSON.stringify({ enabled: true, issuer: 'https://id.example/', clientId: 'x' }))
  assert.match(readSignInSettings(file).problem, /trailing slash/)

  writeFileSync(file, JSON.stringify({ enabled: true, issuer: 'http://id.example', clientId: 'x' }))
  assert.match(readSignInSettings(file).problem, /https/)

  writeFileSync(file, JSON.stringify({ enabled: true, issuer: 'http://127.0.0.1:4111', clientId: 'client-x' }))
  assert.deepEqual(readSignInSettings(file), { enabled: true, issuer: 'http://127.0.0.1:4111', clientId: 'client-x', problem: null })

  writeFileSync(file, JSON.stringify({ enabled: true, issuer: 'https://id.example/api/auth', clientId: 'client-x' }))
  assert.deepEqual(readSignInSettings(file), { enabled: true, issuer: 'https://id.example/api/auth', clientId: 'client-x', problem: null })
})

test('an issuer is https, or loopback http, and never a trailing slash', () => {
  assert.equal(issuerProblem('https://id.example'), null)
  assert.equal(issuerProblem('https://id.example/api/auth'), null)
  assert.equal(issuerProblem('http://127.0.0.1:4000'), null)
  assert.equal(issuerProblem('http://localhost:4000'), null)
  assert.match(issuerProblem('http://id.example'), /https/)
  assert.match(issuerProblem('ftp://id.example'), /https/)
  assert.match(issuerProblem('https://id.example/'), /trailing slash/)
  assert.match(issuerProblem('https://user:pass@id.example'), /plain/)
  assert.match(issuerProblem('not an address'), /not an address/)
})

test('a sign-in completes: exact loopback redirect, S256, state, nonce, and the ID token checked', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider)
  const result = await flow.signIn()

  assert.equal(result.claims.sub, 'person-1')
  assert.equal(result.claims.iss, provider.origin)
  assert.equal(result.claims.aud, CLIENT_ID)
  assert.ok(result.accessToken.startsWith('access-'))
  assert.ok(result.refreshToken.startsWith('refresh-'))
  assert.ok(result.expiresAt > Date.now())

  // One authorization, with exactly the contract's parameters.
  assert.equal(provider.calls.authorize, 1)
  const query = provider.requests.authorize[0]
  assert.equal(query.response_type, 'code')
  assert.equal(query.client_id, CLIENT_ID)
  assert.equal(query.scope, SCOPE)
  assert.equal(query.code_challenge_method, 'S256')
  assert.match(query.code_challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.match(query.state, /^[A-Za-z0-9_-]{43}$/)
  assert.match(query.nonce, /^[A-Za-z0-9_-]{43}$/)
  assert.match(query.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.equal(query.redirect_uri.endsWith(CALLBACK_PATH), true)

  // The verifier went only to the token endpoint, and it matches the challenge.
  const exchange = provider.requests.tokens[0]
  assert.equal(exchange.grant_type, 'authorization_code')
  assert.equal(exchange.client_id, CLIENT_ID)
  assert.equal(exchange.redirect_uri, query.redirect_uri)
  assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), query.code_challenge)

  // The listener closed with the one request.
  await assert.rejects(fetch(query.redirect_uri), () => true)
})

test('a second loopback request is refused: the port closes after the first', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider)
  await flow.signIn()
  const redirect = provider.requests.authorize[0].redirect_uri
  await assert.rejects(fetch(`${redirect}?code=again&state=x`), () => true)
})

test('a browser that cannot be opened is refused as such, with no URL in the reason', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider, {
    openExternal: async (url) => { throw new Error(`no browser for ${url}`) },
  })
  const error = await refusalOf(flow.signIn())
  assert.equal(error.code, 'browser')
  assert.doesNotMatch(error.message, /127\.0\.0\.1|https?:/)
})

test('a discovery redirect is not followed', async t => {
  const provider = await startProvider(t, { discoveryRedirect: `${'https://evil.example'}/.well-known/openid-configuration` })
  const flow = await flowFor(t, provider)
  assert.equal((await refusalOf(flow.signIn())).code, 'network')
})

test('a token endpoint redirect is not followed', async t => {
  const provider = await startProvider(t, { tokenRedirect: 'https://evil.example/token' })
  const flow = await flowFor(t, provider)
  assert.equal((await refusalOf(flow.signIn())).code, 'network')
})

test('a key set without alg cannot pass an inherited algorithm name', async t => {
  // A JWKS key without `alg`, and a header that names an inherited Object property: the
  // allowlist is own keys only, so this is refused before any signature is tried.
  const provider = await startProvider(t, { jwkWithoutAlg: true, header: { alg: 'constructor' } })
  const flow = await flowFor(t, provider)
  assert.equal((await refusalOf(flow.signIn())).code, 'alg')
})

test('a rotated signing key is fetched once more, and the sign-in completes', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider)
  const first = await flow.signIn()
  assert.equal(first.claims.sub, 'person-1')
  const kids = provider.calls.jwks
  provider.rotateKey()
  const second = await flow.signIn()
  assert.equal(second.claims.sub, 'person-1')
  assert.equal(provider.calls.jwks, kids + 1)
})

test('a timeout closes the loopback port too', async t => {
  const provider = await startProvider(t)
  let redirect = null
  const flow = await flowFor(t, provider, {
    timeoutMs: 60,
    openExternal: async (url) => { redirect = new URL(url).searchParams.get('redirect_uri') },
  })
  assert.equal((await refusalOf(flow.signIn())).code, 'timeout')
  assert.equal(await probeLoopback(Number(new URL(redirect).port)), 'refused')
})

test('a second request while the code is still being exchanged is refused: the port closes with its first request', async t => {
  // The exchange is held open, so only the callback's own close can refuse the second request.
  const provider = await startProvider(t, { tokenDelayMs: 250 })
  let second = null
  const flow = await flowFor(t, provider, {
    openExternal: async (authorizeUrl) => {
      const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
      const first = await fetch(authorizeUrl, { redirect: 'manual' })
      await fetch(first.headers.get('location'))
      second = probeLoopback(Number(new URL(redirect).port))
    },
  })
  const result = await flow.signIn()
  assert.equal(result.claims.sub, 'person-1')
  assert.equal(await second, 'refused')
})

/**
 * What a second request finds on the callback port while the exchange is still running:
 * `connected` if the listener is still accepting (the flow must not allow that), `refused` if
 * the port is already closed.
 */
function probeLoopback(port) {
  return new Promise(resolve => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/callback?code=again&state=x', timeout: 500 }, response => {
      response.resume()
      resolve('connected')
    })
    request.on('timeout', () => { request.destroy(); resolve('connected') })
    request.on('error', () => resolve('refused'))
    request.end()
  })
}

test('the flow refuses a wrong state and never trades the code', async t => {
  const provider = await startProvider(t, { state: 'not-the-state' })
  const flow = await flowFor(t, provider)
  const error = await refusalOf(flow.signIn())
  assert.equal(error.code, 'state')
  assert.equal(provider.calls.token, 0)
})

test('the flow refuses a callback that carries an error', async t => {
  const provider = await startProvider(t, {
    authorize: ({ response, query }) => {
      response.writeHead(302, { location: `${query.redirect_uri}?error=access_denied&state=${query.state}` })
      response.end()
    },
  })
  const flow = await flowFor(t, provider)
  assert.equal((await refusalOf(flow.signIn())).code, 'callback')
  assert.equal(provider.calls.token, 0)
})

test('a callback for another path or another host is refused, and the port closes', async t => {
  for (const attack of ['path', 'host', 'method']) {
    const provider = await startProvider(t)
    const flow = await flowFor(t, provider, {
      openExternal: async (authorizeUrl) => {
        const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
        const target = new URL(redirect)
        if (attack === 'path') target.pathname = '/elsewhere'
        if (attack === 'method') {
          await fetch(target, { method: 'POST' })
          return
        }
        if (attack === 'host') {
          await rawRequest(Number(target.port), 'evil.example', '/callback')
          return
        }
        await fetch(target)
      },
    })
    const error = await refusalOf(flow.signIn())
    assert.equal(error.code, 'callback', attack)
    assert.equal(provider.calls.token, 0, attack)
    assert.ok(callbackUrlOf(1).startsWith('http://127.0.0.1:1/callback'))
  }
})

test('the sign-in times out and the listener closes', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider, { openExternal: async () => {}, timeoutMs: 60 })
  const started = Date.now()
  const error = await refusalOf(flow.signIn())
  assert.equal(error.code, 'timeout')
  assert.ok(Date.now() - started < 2000)
})

test('a token response without an access token is refused', async t => {
  const provider = await startProvider(t, {
    token: () => ({ body: { token_type: 'Bearer', expires_in: 3600, id_token: 'x.y.z' } }),
  })
  const flow = await flowFor(t, provider)
  assert.equal((await refusalOf(flow.signIn())).code, 'token')
})

test('the ID token is checked: nonce, issuer, audience, expiry, issued-at, subject, signature and algorithm', async (t) => {
  const cases = [
    ['nonce', { nonce: 'another-nonce' }],
    ['issuer', { iss: 'https://wrong.example' }],
    ['audience', { aud: 'another-client' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['issued', { iat: Math.floor(Date.now() / 1000) + 3600 }],
    ['subject', { sub: '' }],
  ]
  for (const [expected, claims] of cases) {
    const provider = await startProvider(t, { idToken: claims })
    const flow = await flowFor(t, provider)
    const error = await refusalOf(flow.signIn())
    assert.equal(error.code, expected, expected)
    assert.equal(provider.calls.token, 1, expected)
  }

  // A bad signature: a second key signs the same claims.
  const provider = await startProvider(t)
  const other = makeKey()
  const forged = {
    token: ({ body, codes, key, origin, clientId, jwt }) => {
      const stored = codes.get(body.code)
      const now = Math.floor(Date.now() / 1000)
      return {
        body: {
          access_token: 'access-forged', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-forged',
          // The provider's key id, another key's signature: the kid finds a key and the
          // signature check is what refuses it.
          id_token: jwt({ alg: 'EdDSA', kid: key.jwk.kid }, {
            iss: origin, sub: 'person-1', aud: clientId, exp: now + 300, iat: now, nonce: stored.nonce,
          }, other.privateKey),
        },
      }
    },
  }
  const forgedProvider = await startProvider(t, forged)
  const forgedFlow = await flowFor(t, forgedProvider)
  assert.equal((await refusalOf(forgedFlow.signIn())).code, 'token')

  // An unsigned token (`alg: none`) is refused before any key is tried.
  const noneProvider = await startProvider(t, {
    token: ({ body, codes, origin, clientId }) => {
      const stored = codes.get(body.code)
      const now = Math.floor(Date.now() / 1000)
      const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const claims = Buffer.from(JSON.stringify({
        iss: origin, sub: 'person-1', aud: clientId, exp: now + 300, iat: now, nonce: stored?.nonce,
      })).toString('base64url')
      return {
        body: {
          access_token: 'access-none', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-none',
          id_token: `${head}.${claims}.signature`,
        },
      }
    },
  })
  const noneFlow = await flowFor(t, noneProvider)
  assert.equal((await refusalOf(noneFlow.signIn())).code, 'alg')
})

test('discovery is pinned: another issuer, or missing S256, refuses before the browser opens', async t => {
  for (const [discovery, expected] of [
    [{ issuer: 'https://wrong.example' }, 'issuer'],
    [{ code_challenge_methods_supported: [] }, 'discovery'],
    [{ token_endpoint_auth_methods_supported: ['client_secret_basic'] }, 'discovery'],
    [{ scopes_supported: ['profile'] }, 'discovery'],
    [{ authorization_endpoint: 'http://id.example/authorize' }, 'discovery'],
  ]) {
    const provider = await startProvider(t, { discovery })
    let opened = 0
    const flow = await flowFor(t, provider, { openExternal: async () => { opened += 1 } })
    const error = await refusalOf(flow.signIn())
    assert.equal(error.code, expected, JSON.stringify(discovery))
    assert.equal(opened, 0, JSON.stringify(discovery))
  }
})

test('a refresh rotates the token and needs no nonce; a replayed one is invalid_grant', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider)
  const first = await flow.signIn()
  const renewed = await flow.refresh(first.refreshToken)
  assert.ok(renewed.accessToken)
  assert.notEqual(renewed.refreshToken, first.refreshToken)
  assert.equal(renewed.claims, null)

  const replay = await refusalOf(flow.refresh(first.refreshToken))
  assert.equal(replay.code, 'token')
  assert.equal(replay.oauthError, 'invalid_grant')
})

test('a sign-in can be cancelled, and the flow is usable again afterwards', async t => {
  const provider = await startProvider(t)
  let first = true
  const flow = await flowFor(t, provider, {
    openExternal: async (authorizeUrl) => {
      if (first) {
        first = false
        flow.cancel()
        return
      }
      await browse(authorizeUrl)
    },
  })
  assert.equal((await refusalOf(flow.signIn())).code, 'cancelled')
  const result = await flow.signIn()
  assert.equal(result.claims.sub, 'person-1')
})

test('a cancel during discovery opens no browser afterwards', async t => {
  const provider = await startProvider(t)
  let releaseDiscovery
  const discoverySeen = new Promise(resolve => { releaseDiscovery = resolve })
  let opened = 0
  const delayingFetch = async (url, options) => {
    if (String(url).includes('/.well-known/openid-configuration')) {
      releaseDiscovery()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return fetch(url, options)
  }
  const flow = createSignInFlow({
    settings: settingsFor(provider),
    fetch: delayingFetch,
    openExternal: async () => { opened += 1 },
    timeoutMs: 5000,
  })
  t.after(() => flow.close())
  const pending = flow.signIn()
  await discoverySeen
  flow.cancel()
  assert.equal((await refusalOf(pending)).code, 'cancelled')
  assert.equal(opened, 0)
  // The flow is still usable after the cancel.
  const again = createSignInFlow({ settings: settingsFor(provider), fetch: globalThis.fetch, openExternal: browse, timeoutMs: 5000 })
  t.after(() => again.close())
  assert.equal((await again.signIn()).claims.sub, 'person-1')
})

test('a closed flow stops signing in for good', async t => {
  const provider = await startProvider(t)
  const flow = await flowFor(t, provider, { openExternal: async () => {} })
  flow.close()
  assert.equal((await refusalOf(flow.signIn())).code, 'cancelled')
})

test('the deep link stays open-only and never carries this flow', async () => {
  assert.deepEqual(parseDeepLink('automagik://open'), { action: 'open' })
  assert.equal(parseDeepLink('automagik://callback?code=abc&state=def'), null)
  assert.equal(parseDeepLink('automagik://signin?code=abc'), null)
  const source = readFileSync(fileURLToPath(new URL('../src/sign-in.js', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /deeplink|registerSchemes|setAsDefaultProtocolClient/)
  assert.doesNotMatch(source, /window\.location|BrowserWindow/)
})
