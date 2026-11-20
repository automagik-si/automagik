import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { compareVersions, satisfies, verifyLane } from '../src/host/lane-verify.js'

test('the plugin carries the canonical lane verifier byte for byte', async () => {
  const canonical = await readFile(new URL('../../../plugin-lane/verify.mjs', import.meta.url))
  const copy = await readFile(new URL('../src/host/lane-verify.js', import.meta.url))
  assert.ok(copy.equals(canonical))
})

test('the verifier authenticates the original bytes before checking the schema', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keys = [{ keyId: 'fixture', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }]
  const bytes = Buffer.from('{"keyId": "fixture", "schemaVersion": 1}\n')
  const signature = sign(null, bytes, privateKey).toString('base64')
  assert.deepEqual(verifyLane(bytes, ` ${signature}\n`, keys), { keyId: 'fixture', schemaVersion: 1 })

  const otherSchema = Buffer.from('{"keyId":"fixture","schemaVersion":2}')
  assert.throws(() => verifyLane(otherSchema, signature, keys), /^Error: lane: the signature does not match$/)
  const otherSignature = sign(null, otherSchema, privateKey).toString('base64')
  assert.throws(() => verifyLane(otherSchema, otherSignature, keys), /^Error: lane: schema 2$/)
  assert.throws(() => verifyLane(bytes.subarray(0, -1), signature, keys), /signature does not match/)
})

test('a listed Ed448 key cannot sign the plugin lane', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed448')
  const keys = [{ keyId: 'fixture', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }]
  const bytes = Buffer.from('{"keyId":"fixture","schemaVersion":1}')
  const signature = sign(null, bytes, privateKey).toString('base64')
  assert.throws(() => verifyLane(bytes, signature, keys), /lane: signing key must be Ed25519/)
})

test('DSH ranges use the desktop comparator and prerelease order', () => {
  assert.equal(compareVersions('0.2.1-rc.9', '0.2.1-rc.10'), -1)
  assert.equal(compareVersions('0.2.1+build.1', '0.2.1+build.2'), 0)
  assert.equal(satisfies('0.2.1-rc.10', '>=v0.2.1-rc.3 <0.2.1'), true)
  assert.equal(satisfies('0.2.1', '>0.2.1-rc.10 <=0.2.1 =0.2.1'), true)
  assert.equal(satisfies('0.2.1', '>=0.2.1 <0.2.1'), false)
  assert.equal(satisfies('0.2.1', '^0.2.1'), false)
  assert.equal(satisfies('0.2.1', ''), false)
})
