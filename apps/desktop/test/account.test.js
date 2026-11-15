// The desktop's signed-in person (src/account.js): what the page may see, what the secure store
// keeps, and what a launch does with a saved refresh token. The flow and the store are fakes
// here; the real flow is exercised in sign-in.test.js and the real store in
// secure-tokens.test.js. The setting is off by default, and an off account must touch nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BROWSER_REASON, BUSY_REASON, CALLBACK_REASON, DISABLED_REASON, EXPIRED_REASON, FAILED_REASON,
  NO_REFRESH_REASON, REFUSED_REASON, TIMEOUT_REASON, UNREACHABLE_REASON, createAccount,
} from '../src/account.js'
import { NO_SECURE_STORE_REASON, SIGNED_OUT_REASON, STORAGE_FAILED_REASON, TRY_LATER_REASON } from '../src/secure-tokens.js'

const ISSUER = 'https://id.example'
const CLIENT_ID = 'desktop-client'
const ON = Object.freeze({ enabled: true, issuer: ISSUER, clientId: CLIENT_ID, problem: null })
const OFF = Object.freeze({ enabled: false, issuer: null, clientId: null, problem: null })

const tokensOf = ({ access = `access-${Math.random()}`, refresh = `refresh-${Math.random()}`, claims = { sub: 'person-1', name: 'Ada', email: 'ada@example.test' }, expiresAt = Date.now() + 3600 * 1000 } = {}) => ({
  accessToken: access, refreshToken: refresh, claims, expiresAt,
})

function fakeFlow({ enabled = true, result = tokensOf(), refreshResult = null, error = null, refreshError = null } = {}) {
  const calls = { signIn: 0, refresh: 0, cancel: 0, close: 0 }
  let lastRefresh = null
  return {
    enabled, calls,
    get lastRefresh() { return lastRefresh },
    async signIn() {
      calls.signIn += 1
      if (error) throw error
      return result
    },
    async refresh(token) {
      calls.refresh += 1
      lastRefresh = token
      if (refreshError) throw refreshError
      return refreshResult ?? result
    },
    cancel() { calls.cancel += 1 },
    close() { calls.close += 1 },
  }
}

function fakeStore({ secure = true, backend = 'gnome_libsecret', reason = null, saved = null, loadResult = null, clearFailure = null } = {}) {
  const memory = new Map()
  if (saved !== null) memory.set(ISSUER, saved)
  const calls = { load: 0, rotate: 0, clear: 0 }
  return {
    secure, backend, reason, calls, memory,
    async load(account) {
      calls.load += 1
      assert.equal(account, ISSUER)
      if (loadResult) return loadResult
      return memory.has(account) ? { status: 'ok', token: memory.get(account) } : { status: 'empty' }
    },
    async rotate(account, token) {
      calls.rotate += 1
      assert.equal(account, ISSUER)
      memory.set(account, token)
      return secure ? { status: 'saved' } : { status: 'memory', reason: NO_SECURE_STORE_REASON }
    },
    async clear(account) {
      calls.clear += 1
      if (clearFailure) return clearFailure
      memory.delete(account)
      return { status: 'cleared' }
    },
  }
}

const oauthError = (oauthError, code = 'token') => Object.assign(new Error('refused'), { code, oauthError })
const flowError = code => Object.assign(new Error(code), { code })

test('the setting off: no flow, no store, no listener, and the status says so', async () => {
  // A flow and a store are supplied on purpose: the off setting, not their absence, must keep
  // this module from using them.
  const flow = fakeFlow()
  const store = fakeStore()
  const account = createAccount({ settings: OFF, flow, store })
  assert.deepEqual(account.status(), {
    enabled: false, signedIn: false, name: null, email: null, reason: DISABLED_REASON, secureStore: null,
  })
  assert.deepEqual(await account.signIn(), { ok: false, reason: DISABLED_REASON, status: account.status() })
  await account.start()
  await account.signOut()
  assert.equal(account.status().reason, DISABLED_REASON)
  assert.deepEqual(store.calls, { load: 0, rotate: 0, clear: 0 })
  assert.deepEqual(flow.calls, { signIn: 0, refresh: 0, cancel: 0, close: 0 })
  assert.equal(await account.accessToken(), null)
})

test('a setting that is on but has no issuer or client id is refused, not defaulted', async () => {
  const settings = { enabled: true, issuer: null, clientId: null, problem: 'Sign-in is switched on, but the setting names no issuer and client id.' }
  const flow = fakeFlow()
  const account = createAccount({ settings, flow })
  assert.equal(account.enabled, false)
  assert.equal(account.status().reason, settings.problem)
  const refused = await account.signIn()
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, settings.problem)
  assert.equal(flow.calls.signIn, 0)
})

test('a sign-in shows only the display claims and the store keeps only the refresh token', async () => {
  const result = tokensOf()
  const flow = fakeFlow({ result })
  const store = fakeStore()
  const account = createAccount({ settings: ON, flow, store })
  const answered = await account.signIn()
  assert.equal(answered.ok, true)
  const status = answered.status
  assert.deepEqual(status, {
    enabled: true, signedIn: true, name: 'Ada', email: 'ada@example.test', reason: null,
    secureStore: { secure: true, backend: 'gnome_libsecret', reason: null },
  })
  // No token, code or verifier is anywhere in what the page may see.
  const shown = JSON.stringify(status)
  for (const secret of [result.accessToken, result.refreshToken]) assert.equal(shown.includes(secret), false)
  assert.deepEqual([...store.memory.values()], [result.refreshToken])
  assert.deepEqual(store.calls, { load: 0, rotate: 1, clear: 0 })
  assert.equal(flow.calls.signIn, 1)
})

test('a sign-in without a refresh token is remembered for this launch only, and says why', async () => {
  const result = { ...tokensOf(), refreshToken: null }
  const flow = fakeFlow({ result })
  const store = fakeStore()
  const account = createAccount({ settings: ON, flow, store })
  const answered = await account.signIn()
  assert.equal(answered.ok, true)
  assert.equal(answered.status.signedIn, true)
  assert.equal(answered.status.reason, NO_REFRESH_REASON)
  assert.equal(store.memory.size, 0)
  assert.equal(store.calls.rotate, 0)
})

test('an expired access token with no refresh token is not a session', async () => {
  const flow = fakeFlow({ result: tokensOf({ expiresAt: Date.now() - 1000, refresh: null }) })
  const account = createAccount({ settings: ON, flow, store: fakeStore() })
  assert.equal((await account.signIn()).ok, true)
  assert.equal(account.status().signedIn, false)
})

test('a desktop with no secure store keeps the sign-in in memory and carries the store reason', async () => {
  const flow = fakeFlow()
  const store = fakeStore({ secure: false, backend: 'basic_text', reason: NO_SECURE_STORE_REASON })
  const account = createAccount({ settings: ON, flow, store })
  const answered = await account.signIn()
  assert.equal(answered.status.signedIn, true)
  assert.deepEqual(answered.status.secureStore, { secure: false, backend: 'basic_text', reason: NO_SECURE_STORE_REASON })
  assert.equal(store.memory.size, 1)
})

test('signing out clears the stored token and the memory', async () => {
  const flow = fakeFlow()
  const store = fakeStore()
  const account = createAccount({ settings: ON, flow, store })
  await account.signIn()
  const signedOut = await account.signOut()
  assert.equal(signedOut.ok, true)
  assert.equal(signedOut.status.signedIn, false)
  assert.equal(store.memory.size, 0)
  assert.equal(store.calls.clear, 1)
  assert.equal(await account.accessToken(), null)
})

test('a sign-out the store cannot complete is not hidden', async () => {
  const flow = fakeFlow()
  const store = fakeStore({ clearFailure: { status: 'failed', reason: STORAGE_FAILED_REASON } })
  const account = createAccount({ settings: ON, flow, store })
  await account.signIn()
  const signedOut = await account.signOut()
  assert.equal(signedOut.status.signedIn, false)
  assert.equal(signedOut.status.reason, STORAGE_FAILED_REASON)
})

test('a launch refresh without an ID token still shows the person signed in', async () => {
  const store = fakeStore({ saved: 'refresh-old' })
  const flow = fakeFlow({ refreshResult: { accessToken: 'access-kept', expiresAt: Date.now() + 3600 * 1000, refreshToken: 'refresh-2', claims: null } })
  const account = createAccount({ settings: ON, flow, store })
  await account.start()
  const status = account.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.name, null)
  assert.equal(status.email, null)
  assert.deepEqual([...store.memory.values()], ['refresh-2'])
})

test('a sign-out during the launch refresh wins: the refreshed session is dropped', async () => {
  let settle
  const store = fakeStore({ saved: 'refresh-old' })
  const flow = fakeFlow()
  flow.refresh = async () => {
    flow.calls.refresh += 1
    await new Promise(resolve => { settle = resolve })
    return tokensOf({ refresh: 'refresh-new' })
  }
  const account = createAccount({ settings: ON, flow, store })
  const starting = account.start()
  await new Promise(resolve => setImmediate(resolve))
  const signedOut = await account.signOut()
  settle()
  await starting
  assert.equal(signedOut.ok, true)
  assert.equal(account.status().signedIn, false)
  assert.equal(store.calls.rotate, 0)
  assert.deepEqual([...store.memory.values()], [])
})

test('a sign-out during a sign-in wins: the exchange landing afterwards is dropped', async () => {
  let settle
  const flow = fakeFlow()
  flow.signIn = async () => {
    flow.calls.signIn += 1
    await new Promise(resolve => { settle = resolve })
    return tokensOf()
  }
  // The real flow's cancel() cannot stop a code exchange that already came back; this fake
  // models that: cancel() is a no-op and the exchange still resolves.
  const store = fakeStore()
  const account = createAccount({ settings: ON, flow, store })
  const pending = account.signIn()
  await new Promise(resolve => setImmediate(resolve))
  const signedOut = await account.signOut()
  settle()
  const answered = await pending
  assert.equal(signedOut.ok, true)
  assert.equal(answered.ok, false)
  assert.equal(answered.cancelled, true)
  assert.equal(account.status().signedIn, false)
  assert.equal(store.calls.rotate, 0)
  assert.deepEqual([...store.memory.values()], [])
})

test('a launch uses a saved refresh token, rotates it, and shows the sign-in', async () => {
  const store = fakeStore({ saved: 'refresh-old' })
  const flow = fakeFlow({ refreshResult: tokensOf({ refresh: 'refresh-new' }) })
  const account = createAccount({ settings: ON, flow, store })
  await account.start()
  const status = account.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.name, 'Ada')
  assert.equal(store.calls.load, 1)
  assert.equal(flow.calls.refresh, 1)
  assert.equal(flow.lastRefresh, 'refresh-old')
  assert.deepEqual([...store.memory.values()], ['refresh-new'])
  assert.equal(store.calls.rotate, 1)
})

test('a saved token the server calls invalid_grant is cleared; a server that is down is not a sign-out', async () => {
  const expired = fakeStore({ saved: 'refresh-old' })
  const refusedFlow = fakeFlow({ refreshError: oauthError('invalid_grant') })
  const refused = createAccount({ settings: ON, flow: refusedFlow, store: expired })
  await refused.start()
  assert.equal(refused.status().signedIn, false)
  assert.equal(refused.status().reason, EXPIRED_REASON)
  assert.equal(expired.memory.size, 0)
  assert.equal(expired.calls.clear, 1)

  const offline = fakeStore({ saved: 'refresh-old' })
  const offlineFlow = fakeFlow({ refreshError: flowError('network') })
  const account = createAccount({ settings: ON, flow: offlineFlow, store: offline })
  await account.start()
  assert.equal(account.status().signedIn, false)
  assert.equal(account.status().reason, UNREACHABLE_REASON)
  // The token stays for the next launch, and for a later sign-in to use.
  assert.deepEqual([...offline.memory.values()], ['refresh-old'])
  assert.equal(offline.calls.clear, 0)
})

test('a store that cannot be read says so, and an empty store is simply signed out', async () => {
  const signedOut = createAccount({ settings: ON, flow: fakeFlow(), store: fakeStore({ loadResult: { status: 'signed-out', reason: SIGNED_OUT_REASON } }) })
  await signedOut.start()
  assert.equal(signedOut.status().signedIn, false)
  assert.equal(signedOut.status().reason, SIGNED_OUT_REASON)

  const retry = createAccount({ settings: ON, flow: fakeFlow(), store: fakeStore({ loadResult: { status: 'retry', reason: TRY_LATER_REASON } }) })
  await retry.start()
  assert.equal(retry.status().reason, TRY_LATER_REASON)

  const empty = createAccount({ settings: ON, flow: fakeFlow(), store: fakeStore() })
  await empty.start()
  assert.equal(empty.status().signedIn, false)
  assert.equal(empty.status().reason, null)
})

test('the access token stays in main: returned to main only, refreshed before it expires', async () => {
  const first = tokensOf({ expiresAt: Date.now() + 60 * 60 * 1000 })
  const flow = fakeFlow({ result: first, refreshResult: tokensOf({ access: 'access-2', expiresAt: Date.now() + 60 * 60 * 1000 }) })
  const store = fakeStore()
  const account = createAccount({ settings: ON, flow, store })
  await account.signIn()
  assert.equal(await account.accessToken(), first.accessToken)
  assert.equal(flow.calls.refresh, 0)

  // An expired access token is refreshed, and the rotated refresh token is written.
  const short = tokensOf({ access: 'access-short', expiresAt: Date.now() + 1000, refresh: 'refresh-short' })
  const expiringFlow = fakeFlow({ result: short, refreshResult: tokensOf({ access: 'access-3', refresh: 'refresh-3', expiresAt: Date.now() + 60 * 60 * 1000 }) })
  const expiringStore = fakeStore()
  const expiring = createAccount({ settings: ON, flow: expiringFlow, store: expiringStore })
  await expiring.signIn()
  assert.equal(await expiring.accessToken(), 'access-3')
  assert.equal(expiringFlow.calls.refresh, 1)
  assert.deepEqual([...expiringStore.memory.values()], ['refresh-3'])
})

test('a refused refresh at access time signs the person out, and concurrent reads share one refresh', async () => {
  const refusedFlow = fakeFlow({ result: tokensOf({ expiresAt: Date.now() + 1000 }), refreshError: oauthError('invalid_grant') })
  const store = fakeStore()
  const account = createAccount({ settings: ON, flow: refusedFlow, store })
  await account.signIn()
  assert.equal(await account.accessToken(), null)
  assert.equal(store.calls.clear, 1)
  assert.equal(account.status().reason, EXPIRED_REASON)

  let release
  const gate = new Promise(resolve => { release = resolve })
  const slow = fakeFlow({ result: tokensOf({ expiresAt: Date.now() + 1000 }) })
  const original = slow.refresh
  slow.refresh = async (token) => { await gate; return original(token) }
  const slowStore = fakeStore()
  const slowAccount = createAccount({ settings: ON, flow: slow, store: slowStore })
  await slowAccount.signIn()
  const one = slowAccount.accessToken()
  const two = slowAccount.accessToken()
  release()
  assert.equal(await one, await two)
  assert.equal(slow.calls.refresh, 1)
})

test('one sign-in at a time, and a sign-out cancels the browser sign-in', async () => {
  const flow = fakeFlow()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const original = flow.signIn
  flow.signIn = async () => { await gate; return original() }
  const account = createAccount({ settings: ON, flow, store: fakeStore() })
  const first = account.signIn()
  assert.equal((await account.signIn()).reason, BUSY_REASON)
  release()
  assert.equal((await first).ok, true)

  const cancelledFlow = fakeFlow()
  let cancelRelease
  const cancelGate = new Promise(resolve => { cancelRelease = resolve })
  cancelledFlow.signIn = async () => {
    await cancelGate
    throw flowError('cancelled')
  }
  const cancelled = createAccount({ settings: ON, flow: cancelledFlow, store: fakeStore() })
  const pending = cancelled.signIn()
  await cancelled.signOut()
  cancelRelease()
  const answered = await pending
  assert.equal(answered.ok, false)
  assert.equal(answered.cancelled, true)
  assert.equal(answered.reason, null)
  assert.equal(cancelledFlow.calls.cancel, 1)
})

test('every refusal becomes a plain reason, never the flow\'s own text', async () => {
  const cases = [
    ['state', REFUSED_REASON], ['nonce', REFUSED_REASON], ['issuer', REFUSED_REASON],
    ['audience', REFUSED_REASON], ['expired', REFUSED_REASON], ['issued', REFUSED_REASON],
    ['subject', REFUSED_REASON], ['alg', REFUSED_REASON], ['token', REFUSED_REASON], ['discovery', REFUSED_REASON],
    ['network', UNREACHABLE_REASON], ['timeout', TIMEOUT_REASON], ['browser', BROWSER_REASON],
    ['callback', CALLBACK_REASON], ['something-else', FAILED_REASON],
  ]
  for (const [code, reason] of cases) {
    const flow = fakeFlow({ error: Object.assign(new Error(`server said ${code} and a token`), { code }) })
    const account = createAccount({ settings: ON, flow, store: fakeStore() })
    const answered = await account.signIn()
    assert.equal(answered.ok, false, code)
    assert.equal(answered.reason, reason, code)
    assert.doesNotMatch(answered.reason, /token|code|verifier/i, code)
  }
})

test('a closing app closes the flow, and start runs once', async () => {
  const flow = fakeFlow()
  const store = fakeStore({ saved: 'refresh-old' })
  const account = createAccount({ settings: ON, flow, store })
  await account.start()
  await account.start()
  assert.equal(store.calls.load, 1)
  assert.equal(flow.calls.refresh, 1)
  account.close()
  assert.equal(flow.calls.close, 1)
})
