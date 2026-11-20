import assert from 'node:assert/strict'
import { getDiffieHellman } from 'node:crypto'
import { test } from 'node:test'
import { decrypt, exchange, sessionKey } from '../src/secret-service/crypto.js'

test('explicit Oakley group interoperates with the named group when available', () => {
  const local = exchange()
  let peer
  try { peer = getDiffieHellman('modp2') } catch { peer = undefined }
  if (peer === undefined) {
    const other = exchange()
    assert.deepEqual(local.key(other.publicKey), other.key(local.publicKey))
  } else {
    const publicKey = peer.generateKeys()
    assert.deepEqual(local.key(publicKey), sessionKey(peer.computeSecret(local.publicKey)))
  }
  assert.throws(() => local.key(Buffer.from([1])))
  assert.throws(() => local.key(Buffer.alloc(129)))
})

test('HKDF-SHA256 vector with a leading-zero DH shared secret', () => {
  // With exponents 2 and 2 the shared integer is 16. Independent HMAC-SHA256
  // extract-expand of its 128-byte representation gives this 16-byte key.
  const expected = 'b51373722962ab412116d61ad75a8221'
  assert.equal(sessionKey(Buffer.from([16])).toString('hex'), expected)
  const padded = Buffer.alloc(128)
  padded[127] = 16
  assert.equal(sessionKey(padded).toString('hex'), expected)
})

test('AES-128-CBC/PKCS7 OpenSSL vector and fail-closed padding', () => {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  const iv = Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex')
  const encrypted = Buffer.from('ef8e11475136e03c36baa6e25a39f9bf0bf880bd60d3d3e00057a58af57d46bd', 'hex')
  assert.equal(decrypt(key, iv, encrypted).toString(), 'known text vector')
  encrypted[15] ^= 1 // Changes only the last padding byte of the final plaintext block.
  assert.throws(() => decrypt(key, iv, encrypted))
  assert.throws(() => decrypt(key, iv.subarray(1), encrypted))
  assert.throws(() => decrypt(key, iv, encrypted.subarray(1)))
})
