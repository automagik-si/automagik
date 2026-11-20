import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AGENT_TOOLS } from '../src/host/agent-access.js'
import { CALLER_READS, callerEndpoint } from '../src/host/caller-policy.js'
import { fixture } from './caller-fixture.js'

const inventory = JSON.parse(readFileSync(new URL('./fixtures/caller-endpoints.json', import.meta.url), 'utf8'))
const hostSource = file => readFileSync(new URL(`../src/host/${file}`, import.meta.url), 'utf8')

function endpointLiteral(expression) {
  const match = /^(['"`])([\w-]+)\1$/.exec(expression.trim())
  assert.ok(match, `Expected a literal endpoint name, got ${expression}`)
  return match[2]
}

// Each of these files currently has one switch. Require that shape so a dispatch
// change has to update the inventory reader before the classification can pass.
function endpointCases(source) {
  const switches = [...source.matchAll(/\bswitch\s*\(([^)]*)\)\s*\{/g)]
  assert.deepEqual(switches.map(([, expression]) => expression.trim()), ['endpoint'])
  return [...source.matchAll(/\bcase\s+([^:\n]+?)\s*:/g)].map(([, expression]) => endpointLiteral(expression))
}

function endpointSets(source) {
  const sets = new Map([...source.matchAll(/\bconst\s+(\w+)\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]\s*\)/g)]
    .map(([, name, entries]) => [name, entries]))
  const namesOf = name => {
    assert.ok(sets.has(name), `Missing endpoint Set initializer for ${name}`)
    const names = sets.get(name).split(',').map(entry => entry.trim()).filter(Boolean).flatMap(entry => {
      if (entry === '...AGENT_TOOLS.map(tool => tool.endpoint)') return AGENT_TOOLS.map(tool => tool.endpoint)
      if (entry.startsWith('...')) return namesOf(entry.slice(3))
      return endpointLiteral(entry)
    })
    const additions = source.matchAll(new RegExp(`\\b${name}\\.add\\s*\\(([^)]*)\\)`, 'g'))
    return [...names, ...Array.from(additions, ([, expression]) => endpointLiteral(expression))]
  }
  const used = new Set(Array.from(source.matchAll(/\b(\w+)\.has\s*\(\s*endpoint\s*\)/g), ([, name]) => name))
  return [...used].flatMap(namesOf)
}

function ownerEndpoints() {
  const source = hostSource('channel.js')
  const names = endpointCases(source).concat(endpointSets(source))
  // Diagnostics, self-update and other direct conditions outside the switch.
  const comparisons = source.matchAll(/(?<![.\w])endpoint\s*(?:===|!==)\s*([^\s)]+)/g)
  for (const [, expression] of comparisons) names.push(endpointLiteral(expression))
  const prefixes = Array.from(source.matchAll(/\bendpoint\.startsWith\s*\(([^)]*)\)/g),
    ([, expression]) => endpointLiteral(expression))
  assert.deepEqual([...new Set(prefixes)].sort(), ['computer-', 'space-'])
  const space = endpointCases(hostSource('agent-space.js'))
  for (const name of space) assert.ok(name.startsWith('space-'), name)
  const computer = endpointCases(hostSource('computer/index.js')).map(name => `computer-${name}`)
  return [...names, ...space, ...computer]
}

test('R1 every current owner endpoint has a recorded caller decision and unknown names refuse', t => {
  const recorded = [...inventory.reads, ...Object.values(inventory.classes).flat()]
  assert.equal(recorded.length, new Set(recorded).size)
  assert.deepEqual(CALLER_READS, inventory.reads)
  const f = fixture(t)
  const names = ownerEndpoints()
  // whoami belongs to the caller read contract and has no owner switch case.
  const checkInventory = () => assert.deepEqual(
    [...new Set([...names, ...f.rt.extended.endpointNames(), 'whoami'])].sort(), recorded.sort(),
  )
  checkInventory()
  const dispose = f.rt.hooks.endpoint('fixture-extension', () => assert.fail('an extension was dispatched'))
  assert.ok(f.rt.extended.endpointOf('fixture-extension'))
  assert.throws(checkInventory, /fixture-extension/)
  for (const role of ['member', 'guest']) {
    for (const name of inventory.reads) assert.deepEqual(callerEndpoint(role, name), { allow: true })
    for (const name of ['space-', 'computer-', 'space-bots', 'computer-shot', 'fixture-extension', 'no-such-endpoint']) {
      assert.equal(callerEndpoint(role, name).reason, 'owner-only', name)
    }
  }
  dispose()
  checkInventory()
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

test('R4 RFC 0038 records 5b as merged and leaves native reads conditional after 5e', () => {
  const rfc = readFileSync(new URL('../../../docs/rfcs/0038-cloud-multiuser-caller-principal.md', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../../../docs/rfcs/README.md', import.meta.url), 'utf8')
  assert.match(rfc, /[Mm]erged: delivery 5b \(`b86e0234e`\)/)
  assert.match(index, /\| \[0038\].*delivery 5b \(`b86e0234e`\)/)
  for (const grant of ['am:global', 'am:bot-session-read', 'am:bot-workspace']) {
    const line = rfc.split('\n').find(line => line.startsWith('- `' + grant + '`'))
    assert.match(line, /conditional future work/)
  }
  assert.match(rfc, /working folder path[^.]*would require[^.]*approval/s)
})
