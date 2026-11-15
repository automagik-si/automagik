import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  accountKeyOf, CORRUPT_SUFFIX, createTokenStore, detectSecureStore, NO_SECURE_STORE_REASON,
  SECRET_STORE_LOCKED_REASON, SIGNED_OUT_REASON, STORAGE_FAILED_REASON, TOKEN_FILE, TRY_LATER_REASON,
} from '../src/secure-tokens.js'

const seal = text => Buffer.from(`sealed:${text}`)
const opened = buffer => buffer.toString().replace(/^sealed:/, '')

/** safeStorage's async surface, with counters and the sync calls refusing to run. */
function fakeSafeStorage({ backend = 'gnome_libsecret', decrypt, encrypt, isEncryptionAvailable, isTemporarilyUnavailable } = {}) {
  const calls = { availability: 0, backends: 0, decrypts: 0, encrypts: 0, plaintext: 0, sync: 0 }
  const storage = {
    calls,
    getSelectedStorageBackend() {
      calls.backends += 1
      return backend
    },
    isEncryptionAvailable() {
      calls.availability += 1
      return isEncryptionAvailable ? isEncryptionAvailable() : true
    },
    setUsePlainTextEncryption() {
      calls.plaintext += 1
      throw new Error('the app must never opt into plaintext encryption')
    },
    encryptString() {
      calls.sync += 1
      throw new Error('the synchronous API must not be used')
    },
    decryptString() {
      calls.sync += 1
      throw new Error('the synchronous API must not be used')
    },
    async encryptStringAsync(text) {
      calls.encrypts += 1
      return encrypt ? encrypt(text) : seal(text)
    },
    async decryptStringAsync(buffer) {
      calls.decrypts += 1
      return decrypt ? decrypt(buffer) : { result: opened(buffer), shouldReEncrypt: false }
    },
  }
  if (isTemporarilyUnavailable) storage.isTemporarilyUnavailable = isTemporarilyUnavailable
  return storage
}

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-secure-tokens-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const entries = file => JSON.parse(readFileSync(file, 'utf8')).tokens
const tokenFile = dir => join(dir, TOKEN_FILE)

test('Linux backend detection: kwallet and gnome-libsecret are secure; basic_text and unknown are not', () => {
  for (const backend of ['kwallet', 'kwallet5', 'kwallet6', 'gnome_libsecret', 'gnome-libsecret']) {
    const storage = fakeSafeStorage({ backend })
    const result = detectSecureStore(storage, 'linux')
    assert.equal(result.secure, true, backend)
    assert.equal(result.backend, backend)
    assert.equal(result.reason, null)
    assert.equal(storage.calls.backends, 1)
  }
  for (const backend of ['basic_text', 'unknown']) {
    const result = detectSecureStore(fakeSafeStorage({ backend }), 'linux')
    assert.equal(result.secure, false, backend)
    assert.equal(result.backend, backend)
    assert.equal(result.reason, NO_SECURE_STORE_REASON)
  }
  assert.equal(detectSecureStore(null, 'linux').secure, false)
  assert.equal(detectSecureStore(fakeSafeStorage({ backend: '' }), 'linux').secure, false)
})

test('Linux detection also requires the sync availability check', () => {
  const unavailable = [
    ['false', () => fakeSafeStorage({ backend: 'gnome_libsecret', isEncryptionAvailable: () => false })],
    ['a non-true value', () => fakeSafeStorage({ backend: 'gnome_libsecret', isEncryptionAvailable: () => 'yes' })],
    ['missing', () => {
      const storage = fakeSafeStorage({ backend: 'gnome_libsecret' })
      delete storage.isEncryptionAvailable
      return storage
    }],
    ['throwing', () => fakeSafeStorage({
      backend: 'gnome_libsecret',
      isEncryptionAvailable: () => {
        throw new Error('the availability check failed')
      },
    })],
  ]
  for (const [name, make] of unavailable) {
    assert.deepEqual(detectSecureStore(make(), 'linux'), {
      platform: 'linux', backend: 'gnome_libsecret', secure: false, reason: SECRET_STORE_LOCKED_REASON,
    }, name)
  }
  const available = fakeSafeStorage({ backend: 'gnome_libsecret' })
  assert.deepEqual(detectSecureStore(available, 'linux'), {
    platform: 'linux', backend: 'gnome_libsecret', secure: true, reason: null,
  })
  assert.equal(available.calls.availability, 1)
})

test('the reason tells a desktop with no secret store from a store that does not answer', async (t) => {
  const absent = detectSecureStore(fakeSafeStorage({ backend: 'basic_text' }), 'linux')
  const locked = detectSecureStore(fakeSafeStorage({ backend: 'gnome_libsecret', isEncryptionAvailable: () => false }), 'linux')
  assert.equal(absent.secure, false)
  assert.equal(locked.secure, false)
  assert.equal(absent.reason, NO_SECURE_STORE_REASON)
  assert.equal(locked.reason, SECRET_STORE_LOCKED_REASON)
  assert.notEqual(locked.reason, absent.reason)
  // The locked reason says it is this launch only, and is not the per-operation try-later text.
  assert.match(locked.reason, /locked/i)
  assert.match(locked.reason, /this launch/i)
  assert.notEqual(locked.reason, TRY_LATER_REASON)

  // The store hands the same two reasons to its caller.
  const dir = scratch(t)
  const lockedStore = createTokenStore({
    safeStorage: fakeSafeStorage({ backend: 'kwallet6', isEncryptionAvailable: () => false }), platform: 'linux', userData: dir,
  })
  const absentStore = createTokenStore({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux', userData: dir })
  assert.deepEqual(await lockedStore.load('cloud:alpha'), { status: 'empty', reason: SECRET_STORE_LOCKED_REASON })
  assert.deepEqual(await absentStore.load('cloud:alpha'), { status: 'empty', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(await lockedStore.save('cloud:alpha', 'refresh-1'), { status: 'memory', reason: SECRET_STORE_LOCKED_REASON })
  assert.deepEqual(readdirSync(dir), [])
})

test('a store that did not answer at start is asked once more, at the first operation', async (t) => {
  // Unlocked between start and the first save: the launch becomes secure.
  const dir = scratch(t)
  let answers = [false, true]
  const unlocked = fakeSafeStorage({ backend: 'gnome_libsecret', isEncryptionAvailable: () => answers.shift() ?? true })
  const store = createTokenStore({ safeStorage: unlocked, platform: 'linux', userData: dir })
  assert.equal(store.secure, false)
  assert.equal(store.reason, SECRET_STORE_LOCKED_REASON)
  assert.equal(unlocked.calls.availability, 1)
  assert.deepEqual(await store.save('cloud:alpha', 'alpha-1'), { status: 'saved' })
  assert.equal(store.secure, true)
  assert.equal(store.memoryOnly, false)
  assert.equal(store.reason, null)
  assert.equal(unlocked.calls.availability, 2)
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' })
  assert.equal(unlocked.calls.availability, 2)

  // Still locked at the first operation: no store for this launch, and it is not asked again,
  // even when the keyring answers later.
  const lockedDir = scratch(t)
  answers = [false, false, true]
  const locked = fakeSafeStorage({ backend: 'gnome_libsecret', isEncryptionAvailable: () => answers.shift() ?? true })
  const lockedStore = createTokenStore({ safeStorage: locked, platform: 'linux', userData: lockedDir })
  assert.deepEqual(await lockedStore.load('cloud:alpha'), { status: 'empty', reason: SECRET_STORE_LOCKED_REASON })
  assert.deepEqual(await lockedStore.save('cloud:alpha', 'alpha-1'), { status: 'memory', reason: SECRET_STORE_LOCKED_REASON })
  assert.deepEqual(await lockedStore.load('cloud:alpha'), { status: 'ok', token: 'alpha-1', memory: true })
  assert.equal(locked.calls.availability, 2)
  assert.equal(lockedStore.secure, false)
  assert.equal(locked.calls.encrypts, 0)
  assert.deepEqual(readdirSync(lockedDir), [])

  // A desktop with no secret store is never asked for availability at all.
  const absent = fakeSafeStorage({ backend: 'basic_text' })
  const absentStore = createTokenStore({ safeStorage: absent, platform: 'linux', userData: lockedDir })
  await absentStore.save('cloud:alpha', 'alpha-1')
  await absentStore.load('cloud:alpha')
  assert.equal(absent.calls.availability, 0)
  assert.deepEqual(readdirSync(lockedDir), [])
})

test('macOS and Windows never ask for availability: false or a throw still means a secure store', async (t) => {
  const answers = [
    ['false', () => false],
    ['throwing', () => {
      throw new Error('the availability check failed')
    }],
  ]
  for (const [platform, backend] of [['darwin', 'keychain'], ['win32', 'dpapi']]) {
    for (const [name, isEncryptionAvailable] of answers) {
      const storage = fakeSafeStorage({ isEncryptionAvailable })
      assert.deepEqual(detectSecureStore(storage, platform), { platform, backend, secure: true, reason: null }, `${platform} ${name}`)
      assert.equal(storage.calls.availability, 0, `${platform} ${name}`)
      assert.equal(storage.calls.backends, 0, `${platform} ${name}`)

      const store = createTokenStore({ safeStorage: storage, platform, userData: scratch(t) })
      assert.equal(store.secure, true, `${platform} ${name}`)
      assert.deepEqual(await store.save('cloud:alpha', 'alpha-1'), { status: 'saved' }, `${platform} ${name}`)
      assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' }, `${platform} ${name}`)
      assert.equal(storage.calls.availability, 0, `${platform} ${name}`)
      assert.equal(storage.calls.backends, 0, `${platform} ${name}`)
    }
  }
})

test('macOS and Windows use the platform store without asking for a Linux backend', () => {
  for (const [platform, backend] of [['darwin', 'keychain'], ['win32', 'dpapi']]) {
    const storage = fakeSafeStorage()
    const result = detectSecureStore(storage, platform)
    assert.deepEqual(result, { platform, backend, secure: true, reason: null })
    assert.equal(storage.calls.backends, 0)
  }
})

test('with no secret store nothing is written; the token lives only in this process', async (t) => {
  const dir = scratch(t)
  const storage = fakeSafeStorage({ backend: 'basic_text' })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  assert.equal(store.secure, false)
  assert.equal(store.memoryOnly, true)
  assert.equal(store.backend, 'basic_text')
  assert.equal(store.reason, NO_SECURE_STORE_REASON)

  assert.deepEqual(await store.save('cloud:alpha', 'refresh-1'), { status: 'memory', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'refresh-1', memory: true })
  // Nothing on disk: no file, no basic_text item, no temporary file, no safeStorage call.
  assert.equal(existsSync(tokenFile(dir)), false)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(storage.calls.encrypts, 0)
  assert.equal(storage.calls.decrypts, 0)
  assert.equal(storage.calls.plaintext, 0)
  assert.equal(storage.calls.sync, 0)

  // The next launch has no memory, so it asks for a sign-in again.
  const nextLaunch = createTokenStore({ safeStorage: fakeSafeStorage({ backend: 'unknown' }), platform: 'linux', userData: dir })
  assert.deepEqual(await nextLaunch.load('cloud:alpha'), { status: 'empty', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(readdirSync(dir), [])
})

test('a Linux secret-store name without availability keeps every token in memory', async (t) => {
  const variants = [
    ['false', () => fakeSafeStorage({ backend: 'gnome_libsecret', isEncryptionAvailable: () => false })],
    ['missing', () => {
      const storage = fakeSafeStorage({ backend: 'gnome_libsecret' })
      delete storage.isEncryptionAvailable
      return storage
    }],
    ['throwing', () => fakeSafeStorage({
      backend: 'gnome_libsecret',
      isEncryptionAvailable: () => {
        throw new Error('the availability check failed')
      },
    })],
  ]
  for (const [name, make] of variants) {
    const dir = scratch(t)
    const storage = make()
    assert.deepEqual(detectSecureStore(storage, 'linux'), {
      platform: 'linux', backend: 'gnome_libsecret', secure: false, reason: SECRET_STORE_LOCKED_REASON,
    }, name)
    const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
    assert.equal(store.secure, false, name)
    assert.equal(store.memoryOnly, true, name)
    assert.equal(store.backend, 'gnome_libsecret', name)
    assert.equal(store.reason, SECRET_STORE_LOCKED_REASON, name)

    assert.deepEqual(await store.save('cloud:alpha', 'refresh-1'), { status: 'memory', reason: SECRET_STORE_LOCKED_REASON }, name)
    assert.deepEqual(await store.rotate('cloud:alpha', 'refresh-2'), { status: 'memory', reason: SECRET_STORE_LOCKED_REASON }, name)
    assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'refresh-2', memory: true }, name)
    assert.deepEqual(await store.clear('cloud:alpha'), { status: 'cleared', memory: true }, name)
    assert.deepEqual(await store.load('cloud:alpha'), { status: 'empty', reason: SECRET_STORE_LOCKED_REASON }, name)

    // No token file, no leftover temporary file, and no safeStorage encryption call.
    assert.equal(existsSync(tokenFile(dir)), false, name)
    assert.deepEqual(readdirSync(dir), [], name)
    assert.equal(storage.calls.encrypts, 0, name)
    assert.equal(storage.calls.decrypts, 0, name)
    assert.equal(storage.calls.plaintext, 0, name)
    assert.equal(storage.calls.sync, 0, name)
  }
})

test('a secure store keeps one token per account, rotates it on use, and clears it on sign-out', async (t) => {
  const dir = scratch(t)
  const storage = fakeSafeStorage()
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  assert.equal(store.secure, true)
  assert.equal(store.reason, null)
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'empty' })

  assert.deepEqual(await store.save('cloud:alpha', 'alpha-1'), { status: 'saved' })
  assert.deepEqual(await store.save('cloud:beta', 'beta-1'), { status: 'saved' })
  const file = tokenFile(dir)
  assert.equal(Object.keys(entries(file)).length, 2)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  // Only ciphertext and hashed account keys reach the disk.
  const written = readFileSync(file, 'utf8')
  assert.equal(written.includes('alpha-1'), false)
  assert.equal(written.includes('cloud:alpha'), false)
  assert.equal(written.includes('cloud:beta'), false)
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' })

  // A successful use rotates the token: the old one is replaced, not kept beside the new one.
  assert.deepEqual(await store.rotate('cloud:alpha', 'alpha-2'), { status: 'saved' })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-2' })
  assert.deepEqual(await store.load('cloud:beta'), { status: 'ok', token: 'beta-1' })
  assert.equal(Object.keys(entries(file)).length, 2)
  assert.equal(storage.calls.sync, 0)
  assert.equal(storage.calls.plaintext, 0)

  assert.deepEqual(await store.clear('cloud:alpha'), { status: 'cleared' })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'empty' })
  assert.deepEqual(await store.load('cloud:beta'), { status: 'ok', token: 'beta-1' })
  assert.deepEqual(await store.clear('cloud:beta'), { status: 'cleared' })
  assert.equal(existsSync(file), false)
})

test('a decrypt failure is signed out, never an exception, and the ciphertext stays', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')
  const file = tokenFile(dir)
  const before = readFileSync(file)
  const broken = fakeSafeStorage({
    decrypt: async () => {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.')
    },
  })
  const store = createTokenStore({ safeStorage: broken, platform: 'linux', userData: dir })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'signed-out', reason: SIGNED_OUT_REASON })
  assert.deepEqual(readFileSync(file), before)
  // The caller re-authenticates; the fresh token replaces the one that could not be unlocked.
  const reauthenticated = createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir })
  assert.deepEqual(await reauthenticated.save('cloud:alpha', 'alpha-2'), { status: 'saved' })
  assert.deepEqual(await reauthenticated.load('cloud:alpha'), { status: 'ok', token: 'alpha-2' })
})

test('shouldReEncrypt re-encrypts the token under the new key and rewrites the file', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')
  const file = tokenFile(dir)
  const before = entries(file)[accountKeyOf('cloud:alpha')]
  const rotating = fakeSafeStorage({
    decrypt: async () => ({ result: 'alpha-1', shouldReEncrypt: true }),
    encrypt: async text => Buffer.from(`rotated:${text}`),
  })
  const store = createTokenStore({ safeStorage: rotating, platform: 'linux', userData: dir })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' })
  assert.equal(rotating.calls.encrypts, 1)
  const after = entries(file)[accountKeyOf('cloud:alpha')]
  assert.notEqual(after, before)
  assert.equal(Buffer.from(after, 'base64').toString(), 'rotated:alpha-1')

  const rewritten = fakeSafeStorage({
    decrypt: async buffer => ({ result: buffer.toString().replace(/^rotated:/, ''), shouldReEncrypt: false }),
  })
  assert.deepEqual(await createTokenStore({ safeStorage: rewritten, platform: 'linux', userData: dir }).load('cloud:alpha'), { status: 'ok', token: 'alpha-1' })
})

test('a temporarily unavailable decrypt is try-later and keeps the token for the next try', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')
  const file = tokenFile(dir)
  const before = readFileSync(file)
  let unavailable = true
  const storage = fakeSafeStorage({
    decrypt: async () => {
      if (unavailable) throw new Error('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.')
      return { result: 'alpha-1', shouldReEncrypt: false }
    },
  })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'retry', reason: TRY_LATER_REASON })
  assert.deepEqual(readFileSync(file), before)
  unavailable = false
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' })
})

test('the availability probe counts as try-later even without the error text', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')
  const storage = fakeSafeStorage({
    decrypt: async () => {
      throw new Error('decrypt failed')
    },
    isTemporarilyUnavailable: () => true,
  })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'retry', reason: TRY_LATER_REASON })
})

test('a resolved result that says it is temporarily unavailable is try-later too', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')
  const storage = fakeSafeStorage({ decrypt: async () => ({ isTemporarilyUnavailable: true }) })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'retry', reason: TRY_LATER_REASON })
})

test('a temporarily unavailable save leaves the old token in place', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')
  const file = tokenFile(dir)
  const before = readFileSync(file)
  let unavailable = true
  const storage = fakeSafeStorage({
    encrypt: async text => {
      if (unavailable) throw new Error('safeStorage.encryptStringAsync is temporarily unavailable. Please try again.')
      return seal(text)
    },
  })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  assert.deepEqual(await store.rotate('cloud:alpha', 'alpha-2'), { status: 'retry', reason: TRY_LATER_REASON })
  assert.deepEqual(readFileSync(file), before)
  unavailable = false
  assert.deepEqual(await store.rotate('cloud:alpha', 'alpha-2'), { status: 'saved' })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-2' })
})

test('Delivery 1: with no secret store nothing is written, whatever is saved or cleared', async (t) => {
  const dir = scratch(t)
  const store = createTokenStore({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux', userData: dir })
  await store.save('https://cloud.example', 'refresh-1')
  await store.save('https://instance.example', 'refresh-2')
  await store.rotate('https://cloud.example', 'refresh-3')
  await store.clear('https://instance.example')
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(existsSync(tokenFile(dir)), false)
})

test('Delivery 1: a downgrade leaves stored items unused and the file untouched', async (t) => {
  const dir = scratch(t)
  const secure = createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir })
  await secure.save('cloud:alpha', 'alpha-1')
  const file = tokenFile(dir)
  const before = readFileSync(file)

  const downgraded = createTokenStore({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux', userData: dir })
  assert.equal(downgraded.secure, false)
  assert.deepEqual(await downgraded.load('cloud:alpha'), { status: 'empty', reason: NO_SECURE_STORE_REASON })
  assert.deepEqual(readFileSync(file), before)
  await downgraded.save('cloud:alpha', 'alpha-2')
  await downgraded.clear('cloud:alpha')
  assert.deepEqual(readFileSync(file), before)
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])
})

/** A promise the test settles by hand, for an encrypt or decrypt that must stay in flight. */
function deferred() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}
/** Lets every already-queued microtask and timer callback run, so "still pending" is a real observation. */
const drain = () => new Promise(resolve => setTimeout(resolve, 20))
const settledFlag = (promise) => {
  const flag = { done: false }
  promise.then(() => {
    flag.done = true
  }, () => {
    flag.done = true
  })
  return flag
}

test('H1: a clear called while a save is still encrypting wins; no file holds the token', async (t) => {
  const dir = scratch(t)
  const gate = deferred()
  const storage = fakeSafeStorage({
    encrypt: async (text) => {
      await gate.promise
      return seal(text)
    },
  })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  const saving = store.save('cloud:alpha', 'alpha-1')
  const clearing = store.clear('cloud:alpha')
  const loading = store.load('cloud:alpha')
  await drain()
  gate.release()
  assert.deepEqual(await saving, { status: 'saved' })
  assert.deepEqual(await clearing, { status: 'cleared' })
  assert.deepEqual(await loading, { status: 'empty' })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'empty' })
  // Nothing on disk: no token file, no temporary file, no ciphertext of the cleared token.
  assert.equal(existsSync(tokenFile(dir)), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('H1: of two rotations for one account, the one called last is stored, however slow the first', async (t) => {
  const dir = scratch(t)
  const store0 = createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir })
  await store0.save('cloud:alpha', 'alpha-1')
  const slow = deferred()
  const storage = fakeSafeStorage({
    encrypt: async (text) => {
      if (text === 'alpha-2') await slow.promise
      return seal(text)
    },
  })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  const second = store.rotate('cloud:alpha', 'alpha-2')
  const third = store.rotate('cloud:alpha', 'alpha-3')
  await drain()
  slow.release()
  assert.deepEqual(await second, { status: 'saved' })
  assert.deepEqual(await third, { status: 'saved' })
  assert.equal(opened(Buffer.from(entries(tokenFile(dir))[accountKeyOf('cloud:alpha')], 'base64')), 'alpha-3')
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-3' })
  assert.deepEqual(readdirSync(dir), [TOKEN_FILE])
})

test('H1: a load that overlaps a rotation sees the token of its own turn, never a mix', async (t) => {
  const dir = scratch(t)
  await createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir }).save('cloud:alpha', 'alpha-1')

  // A load called after a rotation started waits for it and returns the new token.
  const slowEncrypt = deferred()
  const rotatingFirst = createTokenStore({
    safeStorage: fakeSafeStorage({
      encrypt: async (text) => {
        await slowEncrypt.promise
        return seal(text)
      },
    }),
    platform: 'linux',
    userData: dir,
  })
  const rotating = rotatingFirst.rotate('cloud:alpha', 'alpha-2')
  const loadAfter = rotatingFirst.load('cloud:alpha')
  const loadAfterDone = settledFlag(loadAfter)
  await drain()
  assert.equal(loadAfterDone.done, false, 'the load must wait for the rotation called before it')
  slowEncrypt.release()
  assert.deepEqual(await rotating, { status: 'saved' })
  assert.deepEqual(await loadAfter, { status: 'ok', token: 'alpha-2' })

  // A load called before a rotation returns the old token; the rotation waits, then lands.
  const slowDecrypt = deferred()
  const loadingFirstStorage = fakeSafeStorage({
    decrypt: async (buffer) => {
      await slowDecrypt.promise
      return { result: opened(buffer), shouldReEncrypt: false }
    },
  })
  const loadingFirst = createTokenStore({ safeStorage: loadingFirstStorage, platform: 'linux', userData: dir })
  const loadBefore = loadingFirst.load('cloud:alpha')
  const rotatingAfter = loadingFirst.rotate('cloud:alpha', 'alpha-3')
  await drain()
  assert.equal(loadingFirstStorage.calls.encrypts, 0, 'the rotation must wait for the load called before it')
  assert.equal(opened(Buffer.from(entries(tokenFile(dir))[accountKeyOf('cloud:alpha')], 'base64')), 'alpha-2')
  slowDecrypt.release()
  assert.deepEqual(await loadBefore, { status: 'ok', token: 'alpha-2' })
  assert.deepEqual(await rotatingAfter, { status: 'saved' })
  assert.equal(opened(Buffer.from(entries(tokenFile(dir))[accountKeyOf('cloud:alpha')], 'base64')), 'alpha-3')
})

test('H1: different accounts stay concurrent, and a failed operation does not break the queue', async (t) => {
  const dir = scratch(t)
  const slow = deferred()
  let failNext = false
  const storage = fakeSafeStorage({
    encrypt: async (text) => {
      if (text === 'alpha-1') await slow.promise
      if (failNext) {
        failNext = false
        throw new Error('the secret store refused')
      }
      return seal(text)
    },
  })
  const store = createTokenStore({ safeStorage: storage, platform: 'linux', userData: dir })
  const alpha = store.save('cloud:alpha', 'alpha-1')
  // Another account does not wait behind the slow one.
  assert.deepEqual(await store.save('cloud:beta', 'beta-1'), { status: 'saved' })
  assert.deepEqual(await store.load('cloud:beta'), { status: 'ok', token: 'beta-1' })
  slow.release()
  assert.deepEqual(await alpha, { status: 'saved' })
  assert.deepEqual(await store.load('cloud:beta'), { status: 'ok', token: 'beta-1' })

  // A failed rotation and a rejected call leave the account's queue usable.
  failNext = true
  const failed = store.rotate('cloud:alpha', 'alpha-2')
  const next = store.rotate('cloud:alpha', 'alpha-3')
  assert.deepEqual(await failed, { status: 'failed', reason: STORAGE_FAILED_REASON })
  assert.deepEqual(await next, { status: 'saved' })
  await assert.rejects(store.save('cloud:alpha', ''), TypeError)
  const throwing = fakeSafeStorage()
  throwing.decryptStringAsync = () => {
    throw new Error('thrown before any promise')
  }
  const thrower = createTokenStore({ safeStorage: throwing, platform: 'linux', userData: dir })
  assert.deepEqual(await thrower.load('cloud:alpha'), { status: 'signed-out', reason: SIGNED_OUT_REASON })
  assert.deepEqual(await thrower.clear('cloud:alpha'), { status: 'cleared' })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'empty' })
  assert.deepEqual(await store.load('cloud:beta'), { status: 'ok', token: 'beta-1' })
})

const backupsIn = dir => readdirSync(dir).filter(name => name.startsWith(`${TOKEN_FILE}${CORRUPT_SUFFIX}`))

test('M1: a corrupt or other-version token file is moved aside, never deleted, and save works again', async (t) => {
  const key = accountKeyOf('cloud:other')
  const files = [
    ['corrupt JSON', '{"version":1,"tokens":{"abc":'],
    ['version 2', `${JSON.stringify({ version: 2, tokens: { [key]: 'bmV3ZXI=' }, extra: true })}\n`],
    ['an array of tokens', '{"version":1,"tokens":[]}'],
    ['an empty file', ''],
  ]
  for (const [name, content] of files) {
    for (const firstWrite of ['save', 'clear']) {
      const label = `${name}, ${firstWrite} first`
      const dir = scratch(t)
      const file = tokenFile(dir)
      writeFileSync(file, content, { mode: 0o644 })
      const before = readFileSync(file)
      const store = createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir })

      // A load does not touch the unreadable file: it only reports signed out.
      assert.deepEqual(await store.load('cloud:alpha'), { status: 'signed-out', reason: SIGNED_OUT_REASON }, label)
      assert.deepEqual(readFileSync(file), before, label)
      assert.deepEqual(readdirSync(dir), [TOKEN_FILE], label)

      // The first save or clear moves it aside and carries on with an empty map.
      if (firstWrite === 'clear') {
        assert.deepEqual(await store.clear('cloud:alpha'), { status: 'cleared' }, label)
        assert.equal(existsSync(file), false, label)
      }
      assert.deepEqual(await store.save('cloud:alpha', 'alpha-1'), { status: 'saved' }, label)
      assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' }, label)
      assert.deepEqual(Object.keys(entries(file)), [accountKeyOf('cloud:alpha')], label)

      // The backup is the old file, byte for byte, owner-only; nothing else is left or lost.
      const backups = backupsIn(dir)
      assert.equal(backups.length, 1, label)
      assert.match(backups[0], /\.corrupt-\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-\d+)?$/, label)
      assert.deepEqual(readFileSync(join(dir, backups[0])), before, label)
      if (process.platform !== 'win32') assert.equal(statSync(join(dir, backups[0])).mode & 0o777, 0o600, label)
      assert.deepEqual(readdirSync(dir).sort(), [TOKEN_FILE, backups[0]].sort(), label)

      // A second unreadable file gets its own backup: the first one is not overwritten.
      writeFileSync(file, 'again not JSON')
      assert.deepEqual(await store.rotate('cloud:alpha', 'alpha-2'), { status: 'saved' }, label)
      const both = backupsIn(dir)
      assert.equal(both.length, 2, label)
      assert.deepEqual(readFileSync(join(dir, backups[0])), before, label)
      const second = both.find(entry => entry !== backups[0])
      assert.equal(readFileSync(join(dir, second), 'utf8'), 'again not JSON', label)
      assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-2' }, label)
    }
  }
})

test('M1: a token file that is a link to something unreadable is moved as a link; its target is untouched', { skip: process.platform === 'win32' }, async (t) => {
  const dir = scratch(t)
  const elsewhere = scratch(t)
  const linked = join(elsewhere, 'notes.txt')
  writeFileSync(linked, 'not a token file\n', { mode: 0o644 })
  const before = readFileSync(linked)
  const file = tokenFile(dir)
  symlinkSync(linked, file)

  const store = createTokenStore({ safeStorage: fakeSafeStorage(), platform: 'linux', userData: dir })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'signed-out', reason: SIGNED_OUT_REASON })
  assert.equal(lstatSync(file).isSymbolicLink(), true)
  assert.deepEqual(await store.save('cloud:alpha', 'alpha-1'), { status: 'saved' })
  assert.deepEqual(await store.load('cloud:alpha'), { status: 'ok', token: 'alpha-1' })

  // The new token file is a regular owner-only file, not a write through the link.
  assert.equal(lstatSync(file).isSymbolicLink(), false)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  // The backup is the link itself, still pointing at the same place.
  const backups = backupsIn(dir)
  assert.equal(backups.length, 1)
  assert.equal(lstatSync(join(dir, backups[0])).isSymbolicLink(), true)
  assert.equal(readlinkSync(join(dir, backups[0])), linked)
  // The target was not followed: same bytes, same mode, nothing deleted.
  assert.deepEqual(readFileSync(linked), before)
  assert.equal(statSync(linked).mode & 0o777, 0o644)
  assert.deepEqual(readdirSync(elsewhere), ['notes.txt'])
  assert.deepEqual(readdirSync(dir).sort(), [TOKEN_FILE, backups[0]].sort())
})

test('the store is reached only by its wiring: no other desktop flow imports or calls it', () => {
  const src = new URL('../src/', import.meta.url)
  const read = name => readFileSync(new URL(name, src), 'utf8')
  // C1.2 (#906) wires the store behind <home>/signin.json: account.js keeps the session and
  // main.js hands it Electron's safeStorage and the app's data folder. Nothing else may.
  const wiring = new Set(['account.js', 'account-wiring.js', 'main.js'])
  for (const name of readdirSync(src)) {
    if (!name.endsWith('.js') || name === 'secure-tokens.js' || wiring.has(name)) continue
    const source = read(name)
    assert.doesNotMatch(source, /secure-tokens/, `${name} imports or names the store`)
    assert.doesNotMatch(source, /createTokenStore|detectSecureStore/, `${name} calls the store`)
    assert.doesNotMatch(source, /safeStorage/, `${name} reaches safeStorage outside the store or its wiring`)
  }
  // The wiring is exactly the three files above: Electron's safeStorage is passed in there, never
  // imported by the flow or the store; only account.js touches the refresh token.
  const wiringSource = read('account-wiring.js')
  assert.match(wiringSource, /createTokenStore\(\{ safeStorage, platform, userData \}\)/)
  const main = read('main.js')
  assert.match(main, /beginAccount\(\{[\s\S]*?safeStorage,[\s\S]*?userData: app\.getPath\('userData'\)/)
  const account = read('account.js')
  assert.doesNotMatch(account, /safeStorage|from 'electron'/)
  assert.match(account, /store\.(load|rotate|clear)\(/)
  const flow = read('sign-in.js')
  assert.doesNotMatch(flow, /secure-tokens|safeStorage|createTokenStore/)
  const module = read('secure-tokens.js')
  // Electron supplies safeStorage from main.js; the module itself is plain Node and testable.
  assert.doesNotMatch(module, /from 'electron'/)
  // The fixed-key fallback is detected, never opted into, and only the async API is used.
  assert.doesNotMatch(module, /setUsePlainTextEncryption\s*\(/)
  assert.doesNotMatch(module, /[^A-Za-z]encryptString\(/)
  assert.doesNotMatch(module, /[^A-Za-z]decryptString\(/)
  assert.match(module, /encryptStringAsync/)
  assert.match(module, /decryptStringAsync/)
})
