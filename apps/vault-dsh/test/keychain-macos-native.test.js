import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runSensitive } from '../src/bw/run.js'
import { createBitwardenSecrets } from '../src/bws/adapter.js'
import { createKeychain, keychainIdentity } from '../src/keychain/index.js'
import { completed, digest, fakeToken } from './fixtures/bws.mjs'

test('macOS disposable keychain supports first Set, restart Unlock, replacement and Clear for Équipe', {
  skip: process.platform !== 'darwin', timeout: 45000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'vault-keychain-'))
  const path = join(home, 'fixture.keychain-db')
  const security = stdin => runSensitive(['-i'], { stdin: stdin + '\n', timeout: 4500 },
    () => ({ file: '/usr/bin/security', prefix: [] }))
  const identity = keychainIdentity({ get: () => ({ dir: home }) })
  const connection = 'Équipe'
  const id = identity.item(connection)
  let expectedToken = fakeToken()
  let expectedServer = 'us'
  const adapters = []
  function start() {
    const keychain = createKeychain({ testKeychainFile: path })
    const adapter = createBitwardenSecrets({}, { keychain, identity, async run(args, { token, server }) {
      if (args[0] === '--version') return completed(0, 'bws 2.1.0\n')
      return typeof token === 'string' && digest(token) === digest(expectedToken) && server === expectedServer
        ? completed(0, '[]') : completed(1)
    } })
    adapters.push(adapter)
    return { adapter, keychain }
  }
  try {
    const created = await security('create-keychain -p ' + randomBytes(32).toString('hex') + ' "' + path + '"')
    assert.equal(created.code === 0 && !created.stderr.replace(/security> /g, '').trim(), true)
    const first = start()
    const initial = await first.keychain.lookup(id)
    assert.equal(initial.ok && initial.blob === undefined, true)
    assert.equal((await first.adapter.setToken({ token: expectedToken, server: expectedServer, connection })).ok, true)
    await first.adapter.prepareQuit()

    const restarted = start()
    assert.equal((await restarted.adapter.unlock({ connection })).ok, true)
    expectedToken = fakeToken()
    expectedServer = 'eu'
    assert.equal((await restarted.adapter.setToken({ token: expectedToken, server: expectedServer, connection })).ok, true)
    await restarted.adapter.prepareQuit()

    const replaced = start()
    assert.equal((await replaced.adapter.unlock({ connection })).ok, true)
    assert.equal((await replaced.adapter.clearToken({ connection })).ok, true)
    const cleared = await replaced.keychain.lookup(id)
    assert.equal(cleared.ok && cleared.blob === undefined, true)
    assert.deepEqual(await replaced.adapter.unlock({ connection }), { ok: false, code: 'locked' })
  } finally {
    await Promise.all(adapters.map(adapter => adapter.prepareQuit()))
    await security('delete-keychain "' + path + '"')
    rmSync(home, { recursive: true, force: true })
  }
})
