import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CALLER_READS, callerEndpoint } from '../src/host/caller-policy.js'
import { fixture } from './caller-fixture.js'

const source = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
const inventory = JSON.parse(readFileSync(new URL('./fixtures/caller-endpoints.json', import.meta.url), 'utf8'))

test('R1 every current owner endpoint has a recorded caller decision and unknown names refuse', t => {
  const names = [...source.matchAll(/case '([^']+)':|endpoint === '([^']+)'/g)].map(match => match[1] ?? match[2])
  for (const set of ['CLI_LOGIN', 'VAULT_LOCAL', 'VAULT']) {
    const contents = new RegExp('const ' + set + ' = new Set\\(\\[([^\\]]+)\\]').exec(source)[1]
    names.push(...[...contents.matchAll(/'([^']+)'/g)].map(match => match[1]))
  }
  const prefixes = [...source.matchAll(/endpoint\.startsWith\('(space-|computer-)'\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(prefixes)].sort(), ['computer-', 'space-'])
  const recorded = [...inventory.reads, ...Object.values(inventory.classes).flat()]
  assert.equal(recorded.length, new Set(recorded).size)
  assert.deepEqual([...new Set([...names, ...prefixes, 'whoami'])].sort(), recorded.sort())
  assert.deepEqual(CALLER_READS, inventory.reads)
  const f = fixture(t)
  f.rt.hooks.endpoint('fixture-extension', () => assert.fail('an extension was dispatched'))
  assert.ok(f.rt.extended.endpointOf('fixture-extension'))
  for (const role of ['member', 'guest']) {
    for (const name of inventory.reads) assert.deepEqual(callerEndpoint(role, name), { allow: true })
    for (const name of ['space-bots', 'computer-shot', 'fixture-extension', 'no-such-endpoint']) {
      assert.equal(callerEndpoint(role, name).reason, 'owner-only', name)
    }
  }
})

test('R2 every administrative endpoint refuses and only the named writes are read-only', () => {
  for (const [group, names] of Object.entries(inventory.classes)) {
    assert.ok(names.length > 0, group)
    for (const role of ['member', 'guest']) {
      for (const name of names) {
        const decision = callerEndpoint(role, name)
        assert.equal(decision.allow, false, name)
        assert.equal(decision.code, 'bot/refused', name)
        assert.equal(decision.reason, group === 'prompting' ? 'read-only' : 'owner-only', name)
      }
    }
  }
})

test('R3 owner and unknown roles cannot use the caller endpoint list', () => {
  for (const role of [undefined, 'owner']) {
    for (const name of CALLER_READS) assert.equal(callerEndpoint(role, name).reason, 'owner-only')
  }
})
