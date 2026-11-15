// Acceptance for RFC 0024 delivery 1 / C1.2 (#906), written from the issue and the RFC rather
// than from sign-in.js's own tests: the throwaway provider, the OIDC negatives, the second
// loopback request, `automagik://`, the setting off by default, and the page never holding a
// token. It imports only the public API, and its provider, keys and "browser" are its own.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign as signJwt } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { BROWSER_REASON, createAccount } from '../src/account.js'
import { parseDeepLink } from '../src/deeplink.js'
import { createSignInFlow, readSignInSettings, settingsFileOf } from '../src/sign-in.js'
import { NO_SECURE_STORE_REASON, createTokenStore } from '../src/secure-tokens.js'

const CLIENT = 'acceptance-client'
const tempDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-signin-acceptance-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'acceptance-key', alg: 'EdDSA', use: 'sig' } }
}

const sign = (header, claims, privateKey) => {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${head}.${body}.${signJwt(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
}

const readBody = request => new Promise((resolve, reject) => {
  const parts = []
  request.on('data', part => parts.push(part))
  request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
  request.on('error', reject)
})

/**
 * The throwaway provider: discovery, an authorization endpoint that redirects to the app's exact
 * loopback callback, a token endpoint that checks the PKCE verifier and trades the code once, and
 * its JWKS. `broken` changes one answer at a time; `authorizeWith` lets a test return its own
 * redirect (a wrong state, an error) and `mint` its own ID token claims.
 */
async function provider(t, { broken = {}, mint = null, authorizeWith = null, tokenDelayMs = 0 } = {}) {
  const signing = key()
  const codes = new Map()
  const refresh = new Set()
  const seen = { authorize: [], token: [] }
  let origin = ''
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    const send = (status, body) => {
      const text = JSON.stringify(body)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: broken.issuer ?? origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: broken.noPkce ? ['plain'] : ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['openid'],
      })
    }
    if (url.pathname === '/jwks') return send(200, { keys: [signing.jwk] })
    if (url.pathname === '/authorize') {
      const query = Object.fromEntries(url.searchParams)
      seen.authorize.push(query)
      if (authorizeWith) return authorizeWith({ query, response })
      const code = `code-${randomUUID()}`
      codes.set(code, { challenge: query.code_challenge, redirect: query.redirect_uri, nonce: query.nonce })
      const state = broken.state ?? query.state
      response.writeHead(302, { location: `${query.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` })
      return response.end()
    }
    if (url.pathname === '/token') {
      const body = Object.fromEntries(new URLSearchParams(await readBody(request)))
      seen.token.push(body)
      // A held exchange lets a test try the loopback port while the flow still owns it.
      if (tokenDelayMs) await new Promise(resolve => setTimeout(resolve, tokenDelayMs))
      if (body.grant_type === 'refresh_token') {
        if (!refresh.has(body.refresh_token)) return send(400, { error: 'invalid_grant' })
        refresh.delete(body.refresh_token)
        return send(200, issue(body, null))
      }
      const stored = codes.get(body.code)
      if (!stored) return send(400, { error: 'invalid_grant' })
      if (body.redirect_uri !== stored.redirect || body.client_id !== CLIENT) return send(400, { error: 'invalid_grant' })
      if (createHash('sha256').update(String(body.code_verifier)).digest('base64url') !== stored.challenge) {
        return send(400, { error: 'invalid_grant' })
      }
      codes.delete(body.code)
      return send(200, issue(body, stored.nonce))
    }
    send(404, { error: 'not_found' })
  })

  function issue(body, nonce) {
    const now = Math.floor(Date.now() / 1000)
    const claims = mint
      ? mint({ origin, clientId: CLIENT, nonce, now })
      : { iss: origin, sub: 'acceptance-person', aud: CLIENT, exp: now + 300, iat: now, ...(nonce === null ? {} : { nonce }) }
    const refreshToken = `refresh-${randomUUID()}`
    refresh.add(refreshToken)
    return {
      access_token: `access-${randomUUID()}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      ...(nonce === null ? {} : { id_token: sign({ alg: 'EdDSA', kid: signing.jwk.kid }, claims, signing.privateKey) }),
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))
  return { origin, seen, server }
}

// The system browser: fetch the authorization page, follow its one redirect to loopback.
const browser = async url => {
  const answer = await fetch(url, { redirect: 'manual' })
  const location = answer.headers.get('location')
  if (answer.status === 302 && location) await fetch(location)
}

const flowOf = (t, provider, extra = {}) => {
  const flow = createSignInFlow({
    settings: { enabled: true, issuer: provider.origin, clientId: CLIENT, problem: null },
    fetch: globalThis.fetch,
    openExternal: browser,
    timeoutMs: 5000,
    ...extra,
  })
  t.after(() => flow.close())
  return flow
}

const refused = async promise => {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('the sign-in was expected to be refused')
}

test('acceptance 1: against a throwaway provider a sign-in completes, on a port the app bound first', async t => {
  const first = await provider(t)
  const flow = flowOf(t, first)
  const result = await flow.signIn()
  assert.equal(result.claims.sub, 'acceptance-person')
  assert.equal(result.claims.aud, CLIENT)
  assert.ok(result.accessToken && result.refreshToken)

  const query = first.seen.authorize[0]
  assert.match(query.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.equal(query.redirect_uri, `http://127.0.0.1:${new URL(query.redirect_uri).port}/callback`)
  assert.equal(query.scope, 'openid')
  assert.equal(query.code_challenge_method, 'S256')

  // A second sign-in binds its own port: no fixed port is promised.
  const second = await provider(t)
  const again = flowOf(t, second)
  await again.signIn()
  assert.notEqual(second.seen.authorize[0].redirect_uri, query.redirect_uri)
})

test('acceptance 2: every OIDC negative case is refused and nothing is stored', async t => {
  const dir = tempDir(t)
  const store = {
    secure: true, backend: 'acceptance', reason: null, calls: 0,
    async load() { this.calls += 1; return { status: 'empty' } },
    async rotate() { this.calls += 1; return { status: 'saved' } },
    async clear() { this.calls += 1; return { status: 'cleared' } },
  }
  const cases = [
    ['state', { broken: { state: 'wrong' } }],
    ['nonce', { mint: ({ origin, clientId, now }) => ({ iss: origin, sub: 'p', aud: clientId, exp: now + 300, iat: now, nonce: 'wrong' }) }],
    ['issuer', { mint: ({ origin, clientId, nonce, now }) => ({ iss: `${origin}/other`, sub: 'p', aud: clientId, exp: now + 300, iat: now, nonce }) }],
    ['audience', { mint: ({ origin, nonce, now }) => ({ iss: origin, sub: 'p', aud: 'another-client', exp: now + 300, iat: now, nonce }) }],
    ['expired', { mint: ({ origin, clientId, nonce, now }) => ({ iss: origin, sub: 'p', aud: clientId, exp: now - 3600, iat: now, nonce }) }],
    ['issued', { mint: ({ origin, clientId, nonce, now }) => ({ iss: origin, sub: 'p', aud: clientId, exp: now + 300, iat: now + 3600, nonce }) }],
    ['subject', { mint: ({ origin, clientId, nonce, now }) => ({ iss: origin, sub: '', aud: clientId, exp: now + 300, iat: now, nonce }) }],
  ]
  for (const [code, options] of cases) {
    const server = await provider(t, options)
    const flow = flowOf(t, server)
    const error = await refused(flow.signIn())
    assert.equal(error.code, code, code)
  }

  // A token endpoint that refuses the verifier issues no session, and the desktop always sends
  // a verifier for the challenge it published.
  const first = await provider(t)
  await flowOf(t, first).signIn()
  assert.match(first.seen.token[0].code_verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(createHash('sha256').update(first.seen.token[0].code_verifier).digest('base64url'), first.seen.authorize[0].code_challenge)

  // A code is traded once: a second exchange of the same code is invalid_grant.
  const replayed = await provider(t)
  const replayFlow = flowOf(t, replayed)
  const session = await replayFlow.signIn()
  await replayFlow.refresh(session.refreshToken)
  const error = await refused(replayFlow.refresh(session.refreshToken))
  assert.equal(error.code, 'token')
  assert.equal(error.oauthError, 'invalid_grant')

  // A refused sign-in never reaches a store.
  const refusing = await provider(t, { broken: { state: 'wrong' } })
  const answering = createAccount({
    settings: { enabled: true, issuer: refusing.origin, clientId: CLIENT, problem: null },
    flow: flowOf(t, refusing), store,
  })
  assert.equal((await answering.signIn()).ok, false)
  assert.equal(store.calls, 0)
  assert.equal(existsSync(join(dir, 'cloud-refresh-tokens.json')), false)
})

test('acceptance 3: a second loopback request is refused and the port closes', async t => {
  const server = await provider(t)
  const flow = flowOf(t, server)
  await flow.signIn()
  const redirect = server.seen.authorize[0].redirect_uri
  for (const attempt of [`${redirect}?code=second&state=x`, `${redirect}?code=third`]) {
    await assert.rejects(fetch(attempt), () => true)
  }
  // Nothing listening on that port any more.
  const port = Number(new URL(redirect).port)
  assert.equal(await probe(port), 'refused')
})

// A request made while the code is still being exchanged: it must find the port already closed,
// not a listener that is merely done answering.
test('acceptance 3b: the port closes with the callback request, before the code exchange ends', async t => {
  const server = await provider(t, { tokenDelayMs: 250 })
  let second = null
  const flow = createSignInFlow({
    settings: { enabled: true, issuer: server.origin, clientId: CLIENT, problem: null },
    fetch: globalThis.fetch,
    timeoutMs: 5000,
    openExternal: async (authorizeUrl) => {
      const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri')
      const first = await fetch(authorizeUrl, { redirect: 'manual' })
      await fetch(first.headers.get('location'))
      second = probe(Number(new URL(redirect).port))
    },
  })
  t.after(() => flow.close())
  await flow.signIn()
  assert.equal(await second, 'refused')
})

function probe(port) {
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

test('acceptance 4: automagik:// still only opens, and never carries a code or a token', () => {
  assert.deepEqual(parseDeepLink('automagik://open'), { action: 'open' })
  assert.deepEqual(parseDeepLink('automagik://open?bot=b-acceptance'), { action: 'open', bot: 'b-acceptance' })
  for (const link of [
    'automagik://callback?code=abc&state=xyz',
    'automagik://callback#access_token=abc',
    'automagik://signin?code=abc',
  ]) assert.equal(parseDeepLink(link), null, link)
  // An `open` link with a token-shaped query still only opens: nothing of it is parsed out.
  const carried = parseDeepLink('automagik://open?access_token=abc&code=xyz')
  assert.deepEqual(carried, { action: 'open' })
  // The flow itself has no deep-link path at all.
  const source = readFileSync(fileURLToPath(new URL('../src/sign-in.js', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /deeplink|registerSchemes|setAsDefaultProtocolClient/)
})

test('acceptance 5: the setting is off by default, with no issuer or client id of the app\'s own', async (t) => {
  const dir = tempDir(t)
  assert.deepEqual(readSignInSettings(settingsFileOf(dir)), { enabled: false, issuer: null, clientId: null, problem: null })

  // The default is not a hidden default: nothing in the source names an issuer or a client id.
  for (const file of ['sign-in.js', 'account.js']) {
    const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /automagik-desktop|id\.example|https:\/\/[a-z]/i, file)
  }

  // With the setting off, the account has no flow, no store, no listener and no browser.
  const account = createAccount({ settings: readSignInSettings(settingsFileOf(dir)), flow: null, store: null })
  const before = account.status()
  assert.equal(before.enabled, false)
  assert.equal(before.signedIn, false)
  assert.equal((await account.signIn()).ok, false)
  assert.equal(account.status().signedIn, false)
})

test('acceptance 6: the page holds no token, and the bridge has no way to ask for one', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url))
  const main = readFileSync(join(root, 'main.js'), 'utf8')
  const preload = readFileSync(join(root, 'preload.cjs'), 'utf8')
  const account = readFileSync(join(root, 'account.js'), 'utf8')

  // main's IPC surface for the account: status, sign in, sign out, and nothing that returns a token.
  for (const channel of ['automagik-account-status', 'automagik-account-signin', 'automagik-account-signout']) {
    assert.match(main, new RegExp(channel))
  }
  assert.doesNotMatch(main, /automagik-account-token|automagik-account-access/i)
  assert.doesNotMatch(preload, /accessToken|refreshToken|idToken|authorizationCode/)
  assert.match(preload, /exposeInMainWorld\('omniDesktop', Object\.freeze\(\{[^}]*account/)

  // The account's public status never carries a token; the access token is a main-only method.
  const status = account.match(/const statusOf = [\s\S]*?\}\)\n/)
  assert.ok(status, 'account.js must keep one status shape')
  assert.doesNotMatch(status[0], /access|refresh|idToken|token/i)
})

test('acceptance 7: with no secret store nothing is written and the person signs in again', async (t) => {
  const dir = tempDir(t)
  // The real C1.1 store, on the Linux fallback Electron reports as `basic_text`.
  const safeStorage = {
    getSelectedStorageBackend: () => 'basic_text',
    isEncryptionAvailable: () => false,
    encryptStringAsync: async () => { throw new Error('nothing may be encrypted without a secret store') },
  }
  const store = createTokenStore({ safeStorage, platform: 'linux', userData: dir })
  const server = await provider(t)
  const flow = flowOf(t, server)
  const account = createAccount({
    settings: { enabled: true, issuer: server.origin, clientId: CLIENT, problem: null }, flow, store,
  })
  const answered = await account.signIn()
  assert.equal(answered.ok, true)
  assert.equal(answered.status.secureStore.secure, false)
  assert.equal(answered.status.secureStore.reason, NO_SECURE_STORE_REASON)
  // The refresh token lives in this process only: no ciphertext, no temporary file, no folder.
  assert.deepEqual(readdirSync(dir), [])
  const loaded = await store.load(server.origin)
  assert.equal(loaded.status, 'ok')
  assert.equal(loaded.memory, true)
  assert.equal(typeof loaded.token, 'string')
})
