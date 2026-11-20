// The wiring seam between main.js and the sign-in account (src/account-wiring.js). Its one job
// that matters here: with <home>/signin.json off (the default) or incomplete, no secure-token
// store is constructed, so safeStorage is not read, no file is written, and no flow exists.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { startAccount } from '../src/account-wiring.js'
import { DISABLED_REASON } from '../src/account.js'

const ISSUER = 'https://id.example'
const ON = Object.freeze({ enabled: true, issuer: ISSUER, clientId: 'desktop-client', problem: null })
const OFF = Object.freeze({ enabled: false, issuer: null, clientId: null, problem: null })

function temporaryFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-account-wiring-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeSafeStorage({ backend = 'gnome_libsecret', available = true, throws = false } = {}) {
  const calls = { backends: 0, availability: 0, encrypts: 0 }
  return {
    calls,
    getSelectedStorageBackend() {
      calls.backends += 1
      if (throws) throw new Error('the secret store is not answering')
      return backend
    },
    isEncryptionAvailable() {
      calls.availability += 1
      return available
    },
    async encryptStringAsync() {
      calls.encrypts += 1
      throw new Error('nothing may be encrypted in this test')
    },
  }
}

const openExternal = async () => {}

test('the setting off builds no store and no flow, and never reads safeStorage', async (t) => {
  const dir = temporaryFolder(t)
  const safeStorage = fakeSafeStorage()
  let opened = 0
  const { account, store, flow } = startAccount({
    settings: OFF, safeStorage, userData: dir, platform: 'linux', openExternal: async () => { opened += 1 },
  })
  assert.equal(store, null)
  assert.equal(flow, null)
  assert.equal(account.enabled, false)
  assert.equal(account.status().reason, DISABLED_REASON)
  await account.start()
  await account.signIn()
  assert.deepEqual(safeStorage.calls, { backends: 0, availability: 0, encrypts: 0 })
  assert.equal(opened, 0)
  assert.deepEqual(readdirSync(dir), [])
})

test('an on-but-incomplete setting builds nothing either', async (t) => {
  const dir = temporaryFolder(t)
  const safeStorage = fakeSafeStorage()
  const settings = { enabled: true, issuer: null, clientId: null, problem: 'Sign-in is switched on, but the setting names no issuer and client id.' }
  const { account, store, flow } = startAccount({ settings, safeStorage, userData: dir, platform: 'linux', openExternal })
  assert.equal(store, null)
  assert.equal(flow, null)
  assert.equal(account.enabled, false)
  assert.equal(account.status().reason, settings.problem)
  assert.deepEqual(safeStorage.calls, { backends: 0, availability: 0, encrypts: 0 })
  assert.deepEqual(readdirSync(dir), [])
})

test('the setting on and complete builds the store and the flow', async (t) => {
  const dir = temporaryFolder(t)
  const safeStorage = fakeSafeStorage()
  const { account, store, flow } = startAccount({ settings: ON, safeStorage, userData: dir, platform: 'linux', openExternal })
  assert.ok(store)
  assert.equal(store.secure, true)
  assert.ok(flow)
  assert.equal(flow.enabled, true)
  assert.equal(flow.issuer, ISSUER)
  assert.equal(account.enabled, true)
  assert.equal(account.status().secureStore.secure, true)
  // Detection is a read: nothing is written until the person signs in.
  assert.equal(safeStorage.calls.backends, 1)
  assert.equal(safeStorage.calls.encrypts, 0)
  assert.deepEqual(readdirSync(dir), [])
})

test('a desktop whose safeStorage probe throws keeps the store in memory only', async (t) => {
  const dir = temporaryFolder(t)
  const safeStorage = fakeSafeStorage({ throws: true })
  const logged = []
  const { account, store, flow } = startAccount({
    settings: ON, safeStorage, userData: dir, platform: 'linux', openExternal, log: line => logged.push(line),
  })
  // A throwing backend probe is Electron's "unknown": C1.1 keeps nothing, and the store is real
  // but memory-only, so the person is told why. The flow still exists; nothing was written.
  assert.ok(store)
  assert.equal(store.secure, false)
  assert.ok(flow)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(logged.length, 0)
  assert.equal(account.status().secureStore.reason, store.reason)
})

test('macOS Keychain and Windows DPAPI are the store there, without a Linux backend probe', (t) => {
  for (const platform of ['darwin', 'win32']) {
    const dir = temporaryFolder(t)
    const safeStorage = fakeSafeStorage({ backend: 'unknown' })
    const { store, flow } = startAccount({ settings: ON, safeStorage, userData: dir, platform, openExternal })
    assert.equal(store.secure, true, platform)
    assert.ok(flow)
    assert.deepEqual(safeStorage.calls, { backends: 0, availability: 0, encrypts: 0 }, platform)
    assert.deepEqual(readdirSync(dir), [], platform)
  }
})


test('a sign-in that cannot be built fails closed: no store, no flow, one log line', async (t) => {
  const dir = temporaryFolder(t)
  const safeStorage = fakeSafeStorage()
  const logged = []
  const { account, store, flow } = startAccount({
    settings: ON, safeStorage, userData: dir, platform: 'linux', openExternal: undefined, log: line => logged.push(line),
  })
  assert.equal(store, null)
  assert.equal(flow, null)
  assert.equal(account.enabled, false)
  assert.equal(logged.length, 1)
  assert.match(logged[0], /not started/)
  assert.doesNotMatch(logged[0], /https?:|token/)
})
