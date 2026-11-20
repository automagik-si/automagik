import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ROLE_KEYS } from '../src/host/role-catalog.js'

test('the consumer pins exactly the public keys in the plugin lane', async () => {
  const canonical = await readFile(new URL('../../../plugin-lane/keys.json', import.meta.url))
  const copy = await readFile(new URL('../src/host/role-keys.json', import.meta.url))
  assert.ok(copy.equals(canonical))
  assert.ok(JSON.stringify(ROLE_KEYS) === JSON.stringify(JSON.parse(canonical).keys))
})
