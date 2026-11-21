import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWindowsCredential } from '../../src/windows-credential/adapter.js'
import { connection, provider } from '../../src/windows-credential/parse.js'

const { target, user, value } = globalThis.__wincredTestCanaries

test('the fake provider reads its canary through the private frame', async t => {
  const runner = {
    availability: () => undefined,
    prepareQuit: async () => ({ ok: true }),
    async run(op, supplied) {
      const make = (code, bytes = '') => ({ code, stdout: Buffer.from(bytes), stderr: Buffer.alloc(0) })
      if (op === 'probe') return make(0)
      if (supplied !== target) return make(10)
      const bytes = op === 'meta' ? Buffer.from(user) : Buffer.from(value, 'utf16le')
      return make(0, (op === 'meta' ? 'M ' : 'V ') + bytes.toString('base64') + '\n')
    },
  }
  const adapter = createWindowsCredential({}, { runner })
  t.after(() => adapter.prepareQuit())
  assert.equal((await adapter.preflight({}, () => true)).ok, true)
  assert.equal(adapter.unlock().ok, true)
  const result = await adapter.listItems({ connection, target })
  assert.equal(result.items?.[0]?.userName === user, true)
  const read = await adapter.read({ provider, connection, item: target, field: 'password' })
  assert.equal(read.value === value, true)
})
