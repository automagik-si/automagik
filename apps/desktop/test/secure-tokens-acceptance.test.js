// Independent acceptance tests for RFC 0024, Delivery 1 / C1.1 (#905): the desktop's secure token
// store. These are written from the RFC and the issue, not from the module's own unit test: they
// have their own fake for Electron's injected safeStorage and their own temporary folders, and
// they import only the public API of src/secure-tokens.js. C1.2 (#906) wires the store behind
// <home>/signin.json: account.js holds the session, main.js hands it safeStorage, and acceptance
// 9 keeps every other desktop flow out.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  NO_SECURE_STORE_BACKENDS,
  NO_SECURE_STORE_REASON,
  SECRET_STORE_LOCKED_REASON,
  SIGNED_OUT_REASON,
  TOKEN_FILE,
  TRY_LATER_REASON,
  accountKeyOf,
  createTokenStore,
  detectSecureStore,
  tokenFileOf,
} from '../src/secure-tokens.js'

// A reversible stand-in for Electron's safeStorage. Generation 1 and 2 use different XOR bytes so
// that shouldReEncrypt can move a token to a "new key" and the stored ciphertext visibly changes.
const FAKE_KEYS = { 1: 0x5a, 2: 0xa5 }

function seal(text, generation = 1) {
  const body = Buffer.from(text, 'utf8')
  for (let i = 0; i < body.length; i += 1) body[i] ^= FAKE_KEYS[generation]
  return Buffer.concat([Buffer.from(`fake-v${generation}:`, 'ascii'), body])
}

function unseal(buffer) {
  const colon = buffer.indexOf(0x3a)
  const tag = colon === -1 ? '' : buffer.subarray(0, colon + 1).toString('ascii')
  const match = /^fake-v([12]):$/.exec(tag)
  if (!match) throw new Error('the ciphertext was not sealed by this fake')
  const body = Buffer.from(buffer.subarray(colon + 1))
  for (let i = 0; i < body.length; i += 1) body[i] ^= FAKE_KEYS[match[1]]
  return body.toString('utf8')
}

/**
 * Electron's safeStorage surface as main.js would pass it in, with counters and with the calls the
 * store must never make (the fixed-key opt-in, the synchronous API) failing the test if reached.
 * `probe` replaces getSelectedStorageBackend, `decrypt`/`encrypt` replace the async calls, and
 * `available` is what the synchronous isEncryptionAvailable answers (a value, or a function).
 */
function fakeSafeStorage({ backend = 'gnome_libsecret', probe, decrypt, encrypt, generation = 1, unavailable, available = true } = {}) {
  const calls = { availability: 0, backends: 0, decrypts: 0, encrypts: 0, plaintext: 0, sync: 0 }
  const storage = {
    calls,
    getSelectedStorageBackend() {
      calls.backends += 1
      return probe ? probe() : backend
    },
    isEncryptionAvailable() {
      calls.availability += 1
      return typeof available === 'function' ? available() : available
    },
    setUsePlainTextEncryption() {
      calls.plaintext += 1
      throw new Error('the store must never opt into the fixed-key fallback')
    },
    encryptString() {
      calls.sync += 1
      throw new Error('the store must never use the synchronous encrypt API')
    },
    decryptString() {
      calls.sync += 1
      throw new Error('the store must never use the synchronous decrypt API')
    },
    async encryptStringAsync(text) {
      calls.encrypts += 1
      return encrypt ? encrypt(text, calls.encrypts) : seal(text, generation)
    },
    async decryptStringAsync(buffer) {
      calls.decrypts += 1
      return decrypt ? decrypt(buffer) : { result: unseal(buffer), shouldReEncrypt: false }
    },
  }
  if (unavailable) storage.isTemporarilyUnavailable = unavailable
  return storage
}

// Each test gets its own userData folder under the OS temporary area; nothing is shared or left.
function temporaryFolder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-secure-token-acceptance-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const tokenPath = dir => join(dir, TOKEN_FILE)
const tokensOnDisk = file => JSON.parse(readFileSync(file, 'utf8')).tokens
const bytesOnDisk = file => readFileSync(file)

const storeIn = (dir, storage, platform = 'linux') =>
  createTokenStore({ safeStorage: storage, platform, userData: dir })

test('acceptance 1: with no secret store nothing is written and the next launch asks for sign-in', async t => {
  for (const backend of ['basic_text', 'unknown']) {
    const dir = temporaryFolder(t)
    const storage = fakeSafeStorage({ backend })
    const store = storeIn(dir, storage)
    assert.equal(store.secure, false, backend)
    assert.equal(store.memoryOnly, true, backend)
    assert.equal(store.backend, backend)
    assert.equal(store.reason, NO_SECURE_STORE_REASON)
    assert.equal(store.file, tokenFileOf(dir))

    // The token lives in this process only.
    assert.deepEqual(await store.save('team-account', 'refresh-token-1'), { status: 'memory', reason: NO_SECURE_STORE_REASON })
    assert.deepEqual(await store.rotate('team-account', 'refresh-token-2'), { status: 'memory', reason: NO_SECURE_STORE_REASON })
    assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-2', memory: true })

    // Nothing on disk: no token file, no fixed-key item, no temporary file.
    assert.equal(existsSync(tokenPath(dir)), false)
    assert.deepEqual(readdirSync(dir), [])
    // No encryption, no plaintext opt-in, no synchronous safeStorage call.
    assert.equal(storage.calls.encrypts, 0)
    assert.equal(storage.calls.decrypts, 0)
    assert.equal(storage.calls.plaintext, 0)
    assert.equal(storage.calls.sync, 0)

    // clear forgets the in-memory token and still writes nothing.
    assert.deepEqual(await store.clear('team-account'), { status: 'cleared', memory: true })
    assert.deepEqual(await store.load('team-account'), { status: 'empty', reason: NO_SECURE_STORE_REASON })
    assert.deepEqual(readdirSync(dir), [])

    // A new launch starts with no token, and the user-facing reason says to sign in again.
    const nextLaunch = storeIn(dir, fakeSafeStorage({ backend }))
    const asked = await nextLaunch.load('team-account')
    assert.deepEqual(asked, { status: 'empty', reason: NO_SECURE_STORE_REASON })
    assert.equal(typeof asked.reason, 'string')
    assert.match(asked.reason, /sign in again/i)
    assert.deepEqual(readdirSync(dir), [])
  }
})

test('acceptance 2: a downgrade leaves the stored ciphertext unused and byte-identical', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  const secure = storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' }))
  assert.deepEqual(await secure.save('team-account', 'refresh-token-1'), { status: 'saved' })
  const before = bytesOnDisk(file)
  const entriesBefore = tokensOnDisk(file)
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])

  // The same desktop now reports the fixed-key fallback: the store is no store.
  const downgradedStorage = fakeSafeStorage({ backend: 'basic_text' })
  const downgraded = storeIn(dir, downgradedStorage)
  assert.equal(downgraded.secure, false)
  assert.equal(downgraded.reason, NO_SECURE_STORE_REASON)
  assert.deepEqual(await downgraded.load('team-account'), { status: 'empty', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(await downgraded.save('team-account', 'refresh-token-2'), { status: 'memory', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(await downgraded.rotate('team-account', 'refresh-token-3'), { status: 'memory', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(await downgraded.clear('team-account'), { status: 'cleared', memory: true })

  // It never decrypts, encrypts, opts into plaintext, or calls the synchronous API.
  assert.equal(downgradedStorage.calls.decrypts, 0)
  assert.equal(downgradedStorage.calls.encrypts, 0)
  assert.equal(downgradedStorage.calls.plaintext, 0)
  assert.equal(downgradedStorage.calls.sync, 0)

  // The secure file is not read, rewritten, or cleared.
  assert.deepEqual(bytesOnDisk(file), before)
  assert.deepEqual(tokensOnDisk(file), entriesBefore)
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])

  // Its bytes are intact: a secure launch can still unlock the original token.
  const restored = storeIn(dir, fakeSafeStorage({ backend: 'kwallet5' }))
  assert.deepEqual(await restored.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
})

test('acceptance 3: the Linux fallback, unknown, an empty answer, and no probe are no store', () => {
  assert.deepEqual([...NO_SECURE_STORE_BACKENDS], ['basic_text', 'unknown'])
  assert.equal(Object.isFrozen(NO_SECURE_STORE_BACKENDS), true)

  for (const backend of ['basic_text', 'unknown']) {
    const storage = fakeSafeStorage({ backend })
    assert.deepEqual(detectSecureStore(storage, 'linux'), {
      platform: 'linux', backend, secure: false, reason: NO_SECURE_STORE_REASON,
    })
    assert.equal(storage.calls.backends, 1)
  }

  // An empty (or blank) answer means no backend was selected.
  for (const backend of ['', '   ']) {
    assert.deepEqual(detectSecureStore(fakeSafeStorage({ backend }), 'linux'), {
      platform: 'linux', backend: 'unknown', secure: false, reason: NO_SECURE_STORE_REASON,
    })
  }

  // safeStorage absent, no probe method, or a probe that throws.
  assert.deepEqual(detectSecureStore(null, 'linux'), {
    platform: 'linux', backend: 'unknown', secure: false, reason: NO_SECURE_STORE_REASON,
  })
  const probeMissing = fakeSafeStorage()
  delete probeMissing.getSelectedStorageBackend
  assert.deepEqual(detectSecureStore(probeMissing, 'linux'), {
    platform: 'linux', backend: 'unknown', secure: false, reason: NO_SECURE_STORE_REASON,
  })
  const throwing = fakeSafeStorage({
    probe: () => {
      throw new Error('the storage backend probe failed')
    },
  })
  assert.deepEqual(detectSecureStore(throwing, 'linux'), {
    platform: 'linux', backend: 'unknown', secure: false, reason: NO_SECURE_STORE_REASON,
  })
  assert.equal(throwing.calls.backends, 1)

  // A platform with no desktop secret store is no store either.
  assert.deepEqual(detectSecureStore(fakeSafeStorage(), 'freebsd'), {
    platform: 'freebsd', backend: 'unknown', secure: false, reason: NO_SECURE_STORE_REASON,
  })
})

test('acceptance 3: KWallet and GNOME libsecret backends are a secure store', () => {
  for (const backend of ['kwallet', 'kwallet5', 'kwallet6', 'gnome_libsecret', 'gnome-libsecret']) {
    const storage = fakeSafeStorage({ backend })
    assert.deepEqual(detectSecureStore(storage, 'linux'), {
      platform: 'linux', backend, secure: true, reason: null,
    })
    assert.equal(storage.calls.backends, 1)
    assert.equal(storage.calls.plaintext, 0)
    assert.equal(storage.calls.sync, 0)
  }
})

test('acceptance 3: a Linux secret-store name whose store does not answer is no store, and the saved file is untouched', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  assert.deepEqual(await storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' })).save('team-account', 'refresh-token-1'), { status: 'saved' })
  const before = bytesOnDisk(file)
  const modeBefore = statSync(file).mode
  const mtimeBefore = statSync(file).mtimeMs

  const answers = [
    ['false', false],
    ['a truthy value that is not true', 'yes'],
    ['a throw', () => {
      throw new Error('the availability check failed')
    }],
  ]
  for (const backend of ['gnome_libsecret', 'kwallet6']) {
    for (const [name, available] of answers) {
      const label = `${backend}, ${name}`
      const storage = fakeSafeStorage({ backend, available })
      assert.deepEqual(detectSecureStore(fakeSafeStorage({ backend, available }), 'linux'), {
        platform: 'linux', backend, secure: false, reason: SECRET_STORE_LOCKED_REASON,
      }, label)
      const store = storeIn(dir, storage)
      assert.equal(store.secure, false, label)
      assert.equal(store.memoryOnly, true, label)
      assert.equal(store.backend, backend, label)
      assert.equal(store.reason, SECRET_STORE_LOCKED_REASON, label)

      // The saved ciphertext is not read for tokens: the launch starts signed out.
      assert.deepEqual(await store.load('team-account'), { status: 'empty', reason: SECRET_STORE_LOCKED_REASON }, label)
      assert.deepEqual(await store.save('team-account', 'refresh-token-2'), { status: 'memory', reason: SECRET_STORE_LOCKED_REASON }, label)
      assert.deepEqual(await store.rotate('team-account', 'refresh-token-3'), { status: 'memory', reason: SECRET_STORE_LOCKED_REASON }, label)
      assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-3', memory: true }, label)
      assert.deepEqual(await store.clear('team-account'), { status: 'cleared', memory: true }, label)
      assert.deepEqual(await store.load('team-account'), { status: 'empty', reason: SECRET_STORE_LOCKED_REASON }, label)
      assert.equal(storage.calls.decrypts, 0, label)
      assert.equal(storage.calls.encrypts, 0, label)
      assert.equal(storage.calls.plaintext, 0, label)
      assert.equal(storage.calls.sync, 0, label)

      // Not rewritten, not removed, nothing beside it.
      assert.deepEqual(bytesOnDisk(file), before, label)
      assert.equal(statSync(file).mode, modeBefore, label)
      assert.equal(statSync(file).mtimeMs, mtimeBefore, label)
      assert.deepEqual(readdirSync(dir), [TOKEN_FILE], label)
    }
  }

  // Its bytes are intact: a launch whose store answers unlocks the original token.
  const restored = storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret', available: true }))
  assert.deepEqual(await restored.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
})

test('acceptance 3: the reason tells no secret store from a store that does not answer', async t => {
  const absent = detectSecureStore(fakeSafeStorage({ backend: 'basic_text' }), 'linux')
  const locked = detectSecureStore(fakeSafeStorage({ backend: 'gnome_libsecret', available: false }), 'linux')
  assert.equal(absent.reason, NO_SECURE_STORE_REASON)
  assert.equal(locked.reason, SECRET_STORE_LOCKED_REASON)
  assert.notEqual(locked.reason, absent.reason)
  assert.notEqual(locked.reason, TRY_LATER_REASON)
  // A locked keyring is no store for this launch, and the text says so.
  assert.match(locked.reason, /locked/i)
  assert.match(locked.reason, /this launch/i)
  assert.match(locked.reason, /sign in again/i)

  const dir = temporaryFolder(t)
  const lockedLoad = await storeIn(dir, fakeSafeStorage({ backend: 'kwallet5', available: false })).load('team-account')
  const absentLoad = await storeIn(dir, fakeSafeStorage({ backend: 'basic_text' })).load('team-account')
  assert.notEqual(lockedLoad.reason, absentLoad.reason)
  assert.deepEqual(readdirSync(dir), [])
})

test('acceptance 3: a Linux secret-store name whose store answers true is a secure store', async t => {
  for (const backend of ['gnome_libsecret', 'kwallet6']) {
    const dir = temporaryFolder(t)
    const storage = fakeSafeStorage({ backend, available: true })
    assert.deepEqual(detectSecureStore(fakeSafeStorage({ backend, available: true }), 'linux'), {
      platform: 'linux', backend, secure: true, reason: null,
    })
    const store = storeIn(dir, storage)
    assert.equal(store.secure, true, backend)
    assert.equal(store.memoryOnly, false, backend)
    assert.equal(store.reason, null, backend)
    // Availability was asked, once, with the backend name.
    assert.equal(storage.calls.availability, 1, backend)
    assert.equal(storage.calls.backends, 1, backend)
    assert.deepEqual(await store.save('team-account', 'refresh-token-1'), { status: 'saved' }, backend)
    assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-1' }, backend)
    assert.equal(storage.calls.availability, 1, backend)
    assert.deepEqual(readdirSync(dir), [TOKEN_FILE], backend)
  }
})

test('acceptance 3: macOS Keychain and Windows DPAPI are a secure store without a Linux probe', () => {
  for (const [platform, backend] of [['darwin', 'keychain'], ['win32', 'dpapi']]) {
    const storage = fakeSafeStorage({
      probe: () => {
        throw new Error('the Linux backend probe must not be asked on this platform')
      },
    })
    assert.deepEqual(detectSecureStore(storage, platform), {
      platform, backend, secure: true, reason: null,
    })
    assert.equal(storage.calls.backends, 0)
  }
})

test('acceptance 4: a secure backend stores a token that a new store instance loads', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  const key = accountKeyOf('team-account')
  const storage = fakeSafeStorage({ backend: 'gnome_libsecret' })
  const store = storeIn(dir, storage)
  assert.equal(store.secure, true)
  assert.equal(store.memoryOnly, false)
  assert.equal(store.backend, 'gnome_libsecret')
  assert.equal(store.reason, null)
  assert.deepEqual(await store.load('team-account'), { status: 'empty' })

  assert.deepEqual(await store.save('team-account', 'refresh-token-1'), { status: 'saved' })
  const tokens = tokensOnDisk(file)
  assert.deepEqual(Object.keys(tokens), [key])
  // The stored value is ciphertext, not the token or the account.
  assert.equal(unseal(Buffer.from(tokens[key], 'base64')), 'refresh-token-1')
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(storage.calls.sync, 0)
  assert.equal(storage.calls.plaintext, 0)

  // A new launch, with a new safeStorage object and the same folder, loads the token.
  const nextLaunch = storeIn(dir, fakeSafeStorage({ backend: 'kwallet' }))
  assert.deepEqual(await nextLaunch.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
})

test('acceptance 5: shouldReEncrypt rewrites the ciphertext under the new key', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  const key = accountKeyOf('team-account')
  await storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' })).save('team-account', 'refresh-token-1')
  const before = tokensOnDisk(file)[key]
  assert.equal(unseal(Buffer.from(before, 'base64')), 'refresh-token-1')

  let decryptions = 0
  const rotating = fakeSafeStorage({
    backend: 'gnome_libsecret',
    generation: 2,
    decrypt: async () => {
      decryptions += 1
      return { result: 'refresh-token-1', shouldReEncrypt: true }
    },
  })
  const store = storeIn(dir, rotating)
  assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
  assert.equal(decryptions, 1)
  assert.equal(rotating.calls.encrypts, 1)

  // Same token, new ciphertext, one entry, and no temporary file left behind.
  const after = tokensOnDisk(file)[key]
  assert.notEqual(after, before)
  assert.equal(unseal(Buffer.from(after, 'base64')), 'refresh-token-1')
  assert.deepEqual(Object.keys(tokensOnDisk(file)), [key])
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])

  // The rewritten ciphertext is what the next launch reads.
  const nextLaunch = storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' }))
  assert.deepEqual(await nextLaunch.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
})

test('acceptance 6: a temporary decrypt failure is try-later, keeps the token, and a later load returns it', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  await storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' })).save('team-account', 'refresh-token-1')
  const before = bytesOnDisk(file)

  let failing = true
  const storage = fakeSafeStorage({
    decrypt: async () => {
      if (failing) throw new Error('safeStorage.decryptStringAsync is temporarily unavailable')
      return { result: 'refresh-token-1', shouldReEncrypt: false }
    },
  })
  const store = storeIn(dir, storage)
  const first = await store.load('team-account')
  assert.deepEqual(first, { status: 'retry', reason: TRY_LATER_REASON })
  assert.equal('token' in first, false)
  assert.deepEqual(bytesOnDisk(file), before)

  // The store recovers: the same ciphertext still yields the token and is not rewritten.
  failing = false
  assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
  assert.deepEqual(bytesOnDisk(file), before)

  // The availability probe counts as try-later even when the error text does not say so.
  const probed = storeIn(dir, fakeSafeStorage({
    decrypt: async () => {
      throw new Error('decrypt failed')
    },
    unavailable: () => true,
  }))
  const probedResult = await probed.load('team-account')
  assert.deepEqual(probedResult, { status: 'retry', reason: TRY_LATER_REASON })
  assert.equal('token' in probedResult, false)
  assert.deepEqual(bytesOnDisk(file), before)
})

test('acceptance 6: a temporary save failure is try-later and keeps the stored token loadable', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  await storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' })).save('team-account', 'refresh-token-1')
  const before = bytesOnDisk(file)

  let failing = true
  const storage = fakeSafeStorage({
    encrypt: async text => {
      if (failing) throw Object.assign(new Error('the system store is busy'), { isTemporarilyUnavailable: true })
      return seal(text)
    },
  })
  const store = storeIn(dir, storage)
  const result = await store.rotate('team-account', 'refresh-token-2')
  assert.deepEqual(result, { status: 'retry', reason: TRY_LATER_REASON })
  assert.deepEqual(bytesOnDisk(file), before)

  // The old token is still there and still usable; nothing was half-written.
  assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
  assert.deepEqual(bytesOnDisk(file), before)
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])

  // Later, when the store is available again, the rotation succeeds.
  failing = false
  assert.deepEqual(await store.rotate('team-account', 'refresh-token-2'), { status: 'saved' })
  assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-2' })
})

test('acceptance 7: a decrypt failure is signed out, returns no token, and leaves the ciphertext', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  await storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' })).save('team-account', 'refresh-token-1')
  const before = bytesOnDisk(file)

  const broken = storeIn(dir, fakeSafeStorage({
    decrypt: async () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.')
    },
  }))
  const result = await broken.load('team-account')
  assert.deepEqual(result, { status: 'signed-out', reason: SIGNED_OUT_REASON })
  assert.equal('token' in result, false)
  assert.equal(result.token, undefined)

  // The unusable ciphertext is left in place, byte-identical, for a later keyring recovery.
  assert.deepEqual(bytesOnDisk(file), before)
  assert.deepEqual(tokensOnDisk(file), JSON.parse(before.toString('utf8')).tokens)
  const recovered = storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' }))
  assert.deepEqual(await recovered.load('team-account'), { status: 'ok', token: 'refresh-token-1' })
})

test('acceptance 8: rotation replaces the token in one write, clear removes it, and no plaintext reaches the file', async t => {
  const dir = temporaryFolder(t)
  const file = tokenPath(dir)
  const key = accountKeyOf('team-account')
  const other = 'self-hosted-instance'
  const otherKey = accountKeyOf(other)
  const store = storeIn(dir, fakeSafeStorage({ backend: 'gnome_libsecret' }))

  assert.deepEqual(await store.save('team-account', 'refresh-token-1'), { status: 'saved' })
  assert.deepEqual(await store.save(other, 'refresh-other-1'), { status: 'saved' })
  const firstCiphertext = tokensOnDisk(file)[key]
  const neverPlaintext = ['refresh-token-1', 'refresh-other-1', 'team-account', other]
  for (const plaintext of neverPlaintext) assert.equal(readFileSync(file, 'utf8').includes(plaintext), false, plaintext)

  // Rotation: one atomic replace, one entry for the account, the old ciphertext gone.
  assert.deepEqual(await store.rotate('team-account', 'refresh-token-2'), { status: 'saved' })
  const rotated = tokensOnDisk(file)
  assert.deepEqual(Object.keys(rotated).sort(), [key, otherKey].sort())
  assert.equal(unseal(Buffer.from(rotated[key], 'base64')), 'refresh-token-2')
  assert.notEqual(rotated[key], firstCiphertext)
  const rawAfterRotate = readFileSync(file, 'utf8')
  assert.equal(rawAfterRotate.includes(firstCiphertext), false)
  assert.equal(rawAfterRotate.includes('refresh-token-2'), false)
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])
  assert.deepEqual(await store.load('team-account'), { status: 'ok', token: 'refresh-token-2' })
  assert.deepEqual(await store.load(other), { status: 'ok', token: 'refresh-other-1' })

  // Clearing one account removes its entry and plaintext never appears.
  assert.deepEqual(await store.clear('team-account'), { status: 'cleared' })
  assert.deepEqual(await store.load('team-account'), { status: 'empty' })
  assert.deepEqual(await store.load(other), { status: 'ok', token: 'refresh-other-1' })
  const rawAfterClear = readFileSync(file, 'utf8')
  assert.equal(rawAfterClear.includes(key), false)
  assert.equal(rawAfterClear.includes('refresh-token-2'), false)
  assert.deepEqual(Object.keys(tokensOnDisk(file)), [otherKey])

  // Clearing the last account removes the file.
  assert.deepEqual(await store.clear(other), { status: 'cleared' })
  assert.equal(existsSync(file), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('acceptance 9: the store is reached only by its wiring and never opts into plaintext or the sync API', () => {
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
  const sources = walk(sourceRoot).filter(path => /\.(?:js|cjs|mjs)$/.test(path))
  const modulePath = join(sourceRoot, 'secure-tokens.js')
  assert.ok(sources.includes(modulePath), 'the scan must include the store module')

  // C1.2 (#906) wires the store behind <home>/signin.json: account.js holds the session and
  // main.js hands it Electron's safeStorage and the app's data folder. No other desktop flow
  // imports or calls it, reaches safeStorage, or names its file.
  const wiring = new Set(['account.js', 'account-wiring.js', 'main.js'])
  for (const path of sources) {
    if (path === modulePath) continue
    const name = path.slice(sourceRoot.length).replace(/^\//, '')
    if (wiring.has(name)) continue
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /secure-tokens/, `${name} imports or names the store`)
    assert.doesNotMatch(source, /createTokenStore|detectSecureStore/, `${name} calls the store`)
    assert.doesNotMatch(source, /TOKEN_FILE|cloud-refresh-tokens/, `${name} touches the token file`)
    assert.doesNotMatch(source, /safeStorage/, `${name} reaches safeStorage outside the store or its wiring`)
  }

  // The wiring takes safeStorage as an argument and keeps the refresh token in one place: main.js
  // creates the store, account.js loads/saves/rotates/clears it, and the flow never sees it.
  const wiringSource = readFileSync(join(sourceRoot, 'account-wiring.js'), 'utf8')
  assert.match(wiringSource, /createTokenStore\(\{ safeStorage, platform, userData \}\)/)
  const main = readFileSync(join(sourceRoot, 'main.js'), 'utf8')
  assert.match(main, /beginAccount\(\{[\s\S]*?safeStorage,[\s\S]*?userData: app\.getPath\('userData'\)/)
  const account = readFileSync(join(sourceRoot, 'account.js'), 'utf8')
  assert.doesNotMatch(account, /from\s+['"]electron['"]|require\s*\(\s*['"]electron['"]/)
  assert.match(account, /store\.(load|rotate|clear)\(/)
  assert.doesNotMatch(readFileSync(join(sourceRoot, 'sign-in.js'), 'utf8'), /secure-tokens|safeStorage|createTokenStore/)

  // The module takes safeStorage as an argument (no Electron import of its own) and uses only the
  // async API; it never opts into the fixed-key fallback.
  const module = readFileSync(modulePath, 'utf8')
  assert.doesNotMatch(module, /from\s+['"]electron['"]|require\s*\(\s*['"]electron['"]/)
  assert.doesNotMatch(module, /setUsePlainTextEncryption\s*\(/)
  assert.doesNotMatch(module, /\.encryptString\s*\(/)
  assert.doesNotMatch(module, /\.decryptString\s*\(/)
  assert.match(module, /\.encryptStringAsync\s*\(/)
  assert.match(module, /\.decryptStringAsync\s*\(/)
})
