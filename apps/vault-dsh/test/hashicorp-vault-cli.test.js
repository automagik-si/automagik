import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createHashicorpVault } from '../src/hashicorp-vault/adapter.js'
import { canonicalNamespace, endpointOf, provider } from '../src/hashicorp-vault/parse.js'
import { runVault } from '../src/hashicorp-vault/run.js'
import { privateInputs } from './fixtures/fake-vault.mjs'

const same = (actual, expected) => assert.equal(JSON.stringify(actual) === JSON.stringify(expected), true, 'only expected Vault output is returned')
const http = async (t, handle) => {
  const server = createServer(handle)
  t.after(() => {
    server.closeAllConnections()
    if (server.listening) return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + server.address().port
}

test('real Vault CLI uses the exact KV v1/v2 API, classifier and redirect boundary', async t => {
  const bin = process.env.VAULT_REAL_BIN
  if (!bin) return t.skip('VAULT_REAL_BIN is unset')
  const root = mkdtempSync(join(tmpdir(), 'vault-cli-test-'))
  const input = privateInputs(randomBytes(32).toString('hex'))
  let address
  const calls = []
  let leaked = false
  let unexpected = false
  let engine = '1'
  let result = 'ok'
  const started = Promise.withResolvers()
  const vault = createHashicorpVault({}, {
    run: (args, settings) => runVault(args, settings, { parent: { PATH: root }, scratch: root }),
  })
  t.after(async () => {
    try {
      await vault.prepareQuit()
      assert.equal(leaked || unexpected, false)
      assert.deepEqual(readdirSync(root), [process.platform === 'win32' ? 'vault.exe' : 'vault'])
      for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue
        const contents = readFileSync(join(entry.parentPath, entry.name))
        assert.equal([...Object.values(input), address].filter(Boolean).some(canary => contents.includes(canary)), false)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  symlinkSync(resolve(bin), join(root, process.platform === 'win32' ? 'vault.exe' : 'vault'), 'file')
  const redirect = await http(t, (_req, res) => {
    leaked = true
    res.writeHead(500).end()
  })
  const prefix = '/edge/v1/'
  const answer = (res, code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data))
  address = await http(t, (req, res) => {
    if (req.method !== 'GET' || req.headers['x-vault-token'] !== input.token
      || req.headers['x-vault-namespace'] !== canonicalNamespace(input.namespace) || !req.url?.startsWith(prefix)) {
      unexpected = true
      return res.writeHead(400).end()
    }
    const path = req.url.slice(prefix.length)
    const send = data => answer(res, 200, { request_id: 'envelope', data })
    const fail = (code, ...errors) => answer(res, code, { errors })
    if (path === 'sys/internal/ui/mounts') {
      calls.push('connect')
      return fail(403, 'permission denied')
    }
    if (path === 'sys/internal/ui/mounts/' + input.mount) {
      calls.push('preflight')
      if (result === 'mount-denied') return fail(403, 'permission denied')
      if (result === 'invalid') return fail(403, 'permission denied', 'invalid token')
      return send({ type: 'kv', path: input.mount + '/', options: { version: engine } })
    }
    if (path === input.mount + (engine === '2' ? '/metadata' : '') + '?list=true') {
      calls.push('list')
      if (result === 'missing') return fail(404)
      return send({ keys: [input.path] })
    }
    if (path === input.mount + (engine === '2' ? '/data/' : '/') + input.path) {
      calls.push('read')
      if (result === 'redirect') return res.writeHead(307, { location: redirect + '/sink' }).end()
      if (result === 'missing') return fail(404)
      if (result === 'denied') return fail(403, 'permission denied')
      if (result === 'stall') { started.resolve(); return }
      if (result === 'deleted') return answer(res, 404, { data: { data: null, metadata: { destroyed: true } } })
      const data = { [input.field]: input.value, [' ' + input.field + ' ']: input.value + ' padded', request_id: input.value }
      return send(engine === '2' ? { data, metadata: {} } : data)
    }
    unexpected = true
    return res.writeHead(400).end()
  }) + '/edge'
  const credential = { address, token: input.token, namespace: input.namespace }
  const connection = endpointOf(address, input.namespace).connection
  const picker = { connection, mount: input.mount }
  const ref = { provider, connection, item: JSON.stringify([input.mount, input.path]), field: input.field }
  same(await vault.unlock(credential), { ok: true })
  assert.deepEqual(calls, ['connect'])
  for (engine of ['1', '2']) {
    same(await vault.read(ref), { ok: true, value: input.value })
    same(await vault.read({ ...ref, field: ' ' + input.field + ' ' }), { ok: true, value: input.value + ' padded' })
    const fields = await vault.listFields({ ...picker, path: input.path })
    same({ ...fields, fields: fields.fields?.sort() }, { ok: true, fields: [input.field, ' ' + input.field + ' ', 'request_id'].sort() })
    same(await vault.listItems(picker), { ok: true, items: [{ id: input.path, name: input.path, folder: false }] })
    assert.deepEqual(calls.slice(-8), ['preflight', 'read', 'preflight', 'read', 'preflight', 'read', 'preflight', 'list'])
  }
  engine = '2'
  for (const [mode, expected] of [['mount-denied', { ok: false, code: 'denied' }],
    ['denied', { ok: false, code: 'revoked', audit: 'refused' }], ['missing', { ok: false, code: 'revoked' }],
    ['deleted', { ok: false, code: 'revoked' }]]) {
    result = mode
    same(await vault.read(ref), expected)
  }
  result = 'missing'
  // Vault 2.2's JSON list prints {} on a 404 and exits 2. That shape can
  // also mean malformed keys, so the picker refuses it.
  same(await vault.listItems(picker), { ok: false, code: 'refused' })
  result = 'redirect'
  assert.equal((await vault.read(ref)).ok, false)
  assert.equal(leaked, false)
  result = 'invalid'
  same(await vault.read(ref), { ok: false, code: 'auth' })
  same(vault.status(), { state: 'locked' })
  result = 'ok'
  same(await vault.unlock({ ...credential, mount: input.mount }), { ok: true })
  result = 'stall'
  const controller = new AbortController()
  const pending = vault.read(ref, { signal: controller.signal })
  await Promise.race([started.promise, pending.then(() => assert.fail('expected a data request'))])
  controller.abort()
  same(await pending, { ok: false, code: 'locked' })
})
