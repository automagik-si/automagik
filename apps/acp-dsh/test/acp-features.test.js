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

test('the client capabilities sent are exactly the implemented rows', async () => {
  const { items } = await inventory()
  const types = new Map(items.map(item => [item.id, item.type]))
  assert.deepEqual(JSON.parse(JSON.stringify(CLIENT_CAPABILITIES)), implementedClientCapabilities(readPolicy(), types))
  // A boolean capability is sent as true, an object one as {} (fs.readTextFile vs plan).
  assert.deepEqual(implementedClientCapabilities({ features: { 'client-capability:fs.readTextFile': { status: 'implemented' }, 'client-capability:plan': { status: 'implemented' } } }, types), { fs: { readTextFile: true }, plan: {} })
})

test('capabilities are read at every depth, so a nested one has its own decision', async () => {
  const { items } = await inventory()
  const ids = new Set(items.map(item => item.id))
  for (const id of ['client-capability:fs.readTextFile', 'client-capability:fs.writeTextFile', 'client-capability:auth.terminal', 'client-capability:elicitation.form', 'client-capability:elicitation.url', 'client-capability:session.promptSuggestions.image', 'agent-capability:sessionCapabilities.systemPrompt.mode.override']) {
    assert.ok(ids.has(id), id)
  }
  assert.equal(items.find(item => item.id === 'client-capability:fs.readTextFile').type, 'boolean')
  // A nested capability is never sent while its parent is not.
  const policy = readPolicy()
  for (const [id, row] of Object.entries(policy.features)) {
    if (!id.startsWith('client-capability:') || row.status !== 'implemented' || !id.includes('.')) continue
    const parent = id.slice(0, id.lastIndexOf('.'))
    assert.equal(policy.features[parent]?.status, 'implemented', `${id} is sent, so ${parent} is too`)
  }
})

test('an unstable item is never declared as handled without a test', async () => {
  const { items } = await inventory()
  const policy = readPolicy()
  for (const item of items.filter(entry => !entry.stable)) {
    const row = policy.features[item.id]
    if (['implemented', 'used', 'consumed', 'handled'].includes(row.status)) assert.ok(row.test, `${item.id} is unstable and ${row.status}: it names its test`)
  }
})
