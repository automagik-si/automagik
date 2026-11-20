import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createKeychain } from '../src/keychain/index.js'

const digest = value => typeof value === 'string' && createHash('sha256').update(value).digest('hex')

test('Windows Credential Manager stores, reads, replaces and deletes a generic credential with an ASCII-encoded UTF-8 payload', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async () => {
  const id = 'automagik-vault:v1:' + randomBytes(16).toString('hex')
  const blob = () => Buffer.from(JSON.stringify({ v: 1, fixture: randomBytes(24).toString('hex'), encoding: 'ação' })).toString('base64')
  const keychain = createKeychain()
  try {
    for (const value of [blob(), blob()]) {
      assert.equal((await keychain.store(id, value)).ok, true)
      const read = await createKeychain().lookup(id)
      assert.equal(read.ok, true)
      assert.equal(digest(read.blob) === digest(value), true)
    }
    assert.equal((await keychain.clear(id)).ok, true)
    const read = await keychain.lookup(id)
    assert.equal(read.ok && read.blob === undefined, true)
  } finally { await keychain.clear(id) }
})
