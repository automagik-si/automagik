// The SDK feature audit (scripts/acp-features.mjs): every method, session update and capability
// the pinned SDK defines has one decision in dev/acp-features.json, no decision names an item the
// SDK no longer has, every test a row names exists, and the client capabilities this plugin
// sends at `initialize` are exactly its implemented rows.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { CLIENT_CAPABILITIES } from '../src/host/features.js'
import { implementedClientCapabilities, inventory, readPolicy } from '../scripts/acp-features.mjs'

const STATUSES = {
  implemented: 'how-or-test', used: 'how-or-test', consumed: 'how-or-test', handled: 'how-or-test',
  'not-advertised': 'reason', 'not-used': 'reason', 'not-consumed': 'reason', ignored: 'reason',
}

test('every SDK item has a decision, and every decision an SDK item', async () => {
  const { sdk, items } = await inventory()
  const policy = readPolicy()
  assert.equal(policy.sdk, sdk, 'the audit is for the pinned SDK: re-audit after a bump')
  const ids = new Set(items.map(item => item.id))
  assert.deepEqual(items.filter(item => policy.features[item.id] === undefined).map(item => item.id), [], 'items with no decision')
  assert.deepEqual(Object.keys(policy.features).filter(id => !ids.has(id)), [], 'decisions for items the SDK does not have')
  for (const [id, row] of Object.entries(policy.features)) {
    const needs = STATUSES[row.status]
    assert.ok(needs, `${id}: unknown status ${row.status}`)
    if (needs === 'reason') assert.ok(typeof row.reason === 'string' && row.reason.length > 10, `${id}: a ${row.status} row says why`)
    else assert.ok(typeof row.how === 'string' || typeof row.test === 'string', `${id}: a ${row.status} row says how or where it is tested`)
    if (row.test !== undefined) assert.ok(existsSync(join(import.meta.dirname, '..', row.test)), `${id}: ${row.test} exists`)
  }
})

test('the client capabilities sent are exactly the implemented rows', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CLIENT_CAPABILITIES)), implementedClientCapabilities(readPolicy()))
})

test('an unstable item is never declared as handled without a test', async () => {
  const { items } = await inventory()
  const policy = readPolicy()
  for (const item of items.filter(entry => !entry.stable)) {
    const row = policy.features[item.id]
    if (['implemented', 'used', 'consumed', 'handled'].includes(row.status)) assert.ok(row.test, `${item.id} is unstable and ${row.status}: it names its test`)
  }
})
