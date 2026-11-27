// The ACP drift check (scripts/acp-drift.mjs, #958): when the SDK pin counts as behind npm, and
// what the record of the last passing versions must say. No network: npm's answers are given.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SDK, adapterPackages, isNewer, latestOf, offline, parse, pinDrift, readPin, readRecord, report, recordFromReceipts } from '../scripts/acp-drift.mjs'
import { PHASES, receiptProblems } from '../scripts/acp-receipts.mjs'

test('a pin is behind past one minor, and on any older major', () => {
  assert.equal(pinDrift('2.5.0', '2.5.0').state, 'ok')
  assert.equal(pinDrift('2.5.0', '2.5.9').state, 'ok')
  assert.equal(pinDrift('2.5.0', '2.6.3').state, 'ok', 'one minor behind is allowed')
  assert.equal(pinDrift('2.5.0', '2.7.0').state, 'behind')
  assert.match(pinDrift('2.5.0', '2.7.0').reason, /2 minors behind/)
  assert.equal(pinDrift('1.4.0', '2.0.0').state, 'behind', 'the state #958 found')
  assert.match(pinDrift('1.4.0', '2.5.0').reason, /a major behind/)
  // A pin ahead of npm's latest tag (a prerelease line, a yanked release) is not drift.
  assert.equal(pinDrift('2.6.0', '2.5.0').state, 'ok')
  assert.equal(pinDrift('^2.5.0', '2.5.0').state, 'invalid', 'a range is not a pin')
  assert.equal(pinDrift('2.5.0', 'latest').state, 'invalid')
  assert.equal(parse('2.5.0-rc.1'), undefined)
})

test('an adapter counts as moved only past the recorded version', () => {
  assert.equal(isNewer('0.104.1', '0.104.1'), false)
  assert.equal(isNewer('0.104.2', '0.104.1'), true)
  assert.equal(isNewer('0.105.0', '0.104.9'), true)
  assert.equal(isNewer('1.0.0', '0.104.9'), true)
  assert.equal(isNewer('0.103.9', '0.104.1'), false)
  assert.equal(isNewer('0.104.1', undefined), true, 'nothing recorded yet')
})

test('the report fails on a stale pin or a record for another pin, and only notes a moved adapter', () => {
  const latest = { sdk: '2.5.0', adapters: { 'a/one': '1.2.0', 'a/two': '3.0.0' } }
  const record = { sdk: '2.5.0', adapters: { 'a/one': '1.2.0', 'a/two': '2.9.0' } }
  const fine = report({ pin: '2.5.0', record, latest })
  assert.equal(fine.ok, true)
  assert.equal(fine.adapters['a/one'].moved, false)
  assert.equal(fine.adapters['a/two'].moved, true)
  assert.ok(fine.notes.some(line => /a\/two 3\.0\.0 is newer than the 2\.9\.0/.test(line)))

  const stale = report({ pin: '2.5.0', record, latest: { ...latest, sdk: '2.7.1' } })
  assert.equal(stale.ok, false)
  assert.match(stale.failures[0], /2 minors behind/)

  const other = report({ pin: '2.6.0', record, latest: { ...latest, sdk: '2.6.0' } })
  assert.equal(other.ok, false)
  assert.match(other.failures[0], /records the suite passing on SDK 2\.5\.0, not the pin 2\.6\.0/)
  assert.equal(report({ pin: '2.5.0', record: undefined, latest }).ok, false)
})

test('the offline check wants the record to name the pin and every adapter', () => {
  const packages = ['a/one', 'a/two']
  assert.equal(offline({ pin: '2.5.0', record: { sdk: '2.5.0', adapters: { 'a/one': '1.0.0', 'a/two': '2.0.0' } }, packages }).ok, true)
  assert.match(offline({ pin: '2.5.0', record: { sdk: '2.5.0', adapters: { 'a/one': '1.0.0' } }, packages }).failures[0], /no version for a\/two/)
  assert.match(offline({ pin: '2.6.0', record: { sdk: '2.5.0', adapters: {} }, packages: [] }).failures[0], /not the pin 2\.6\.0/)
  assert.equal(offline({ pin: '^2.5.0', record: { sdk: '^2.5.0', adapters: {} }, packages: [] }).ok, false)
})

test('the committed record names this checkout\'s pin and the adapters the app installs', () => {
  const result = offline({ pin: readPin(), record: readRecord() })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(adapterPackages(), ['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp'])
  assert.notEqual(parse(readPin()), undefined, 'the SDK is pinned exactly, never a range')
})

test('npm is asked for the latest tag of the scoped name, and a bad answer is an error', async () => {
  const asked = []
  const fetcher = async (url) => {
    asked.push(url)
    return { ok: true, status: 200, json: async () => ({ version: '2.5.0' }) }
  }
  assert.equal(await latestOf(SDK, fetcher), '2.5.0')
  assert.deepEqual(asked, ['https://registry.npmjs.org/@agentclientprotocol%2Fsdk/latest'])
  await assert.rejects(latestOf(SDK, async () => ({ ok: false, status: 503 })), /npm answered 503/)
  await assert.rejects(latestOf(SDK, async () => ({ ok: true, json: async () => ({}) })), /no plain version/)
})

test('the record comes from launch receipts, never npm: a signed-out pass claims no prompt, and a bad receipt fails it', () => {
  const phases = Object.fromEntries(PHASES.map(phase => [phase, 'unverified']))
  const real = { v: 1, route: 'acp-x', scenario: 'real-unprompted', sdk: '2.5.0', run: 'r1', adapter: { name: 'a/one', version: '1.4.0' }, phases: { ...phases, initialize: 'passed', session: 'auth-required' } }
  const made = recordFromReceipts({ pin: '2.5.0', previous: { adapters: { 'a/one': '1.0.0', 'a/two': '2.0.0' } }, receipts: [{ name: 'x', receipt: real, problems: receiptProblems(real) }], packages: ['a/one', 'a/two'], today: 'T' })
  assert.equal(made.ok, true, made.failures.join('; '))
  assert.deepEqual(made.record.adapters, { 'a/one': '1.4.0', 'a/two': '2.0.0' })
  assert.equal(made.record.receipts[0].phases.session, 'auth-required')
  const claims = { ...real, phases: { ...real.phases, prompt: 'passed' } }
  assert.match(receiptProblems(claims).join(), /cannot pass prompt/)
  assert.equal(recordFromReceipts({ pin: '2.5.0', receipts: [{ name: 'y', receipt: claims, problems: receiptProblems(claims) }], packages: ['a/one'] }).ok, false)
  assert.equal(recordFromReceipts({ pin: '2.6.0', receipts: [{ name: 'x', receipt: real, problems: [] }], packages: ['a/one'] }).ok, false)
  assert.equal(recordFromReceipts({ pin: '2.5.0', receipts: [], packages: [] }).ok, false)
})

test('a phase that failed never moves the record, and receipts of another run or of no run are refused', () => {
  const phases = Object.fromEntries(PHASES.map(phase => [phase, 'unverified']))
  const base = { v: 1, route: 'acp-x', scenario: 'real-unprompted', sdk: '2.5.0', run: 'r1', adapter: { name: 'a/one', version: '1.4.0' }, phases: { ...phases, initialize: 'passed', session: 'passed' } }
  const item = (receipt, name = 'x') => ({ name, receipt, problems: receiptProblems(receipt) })
  const previous = { adapters: { 'a/one': '1.0.0' }, passed: 'old' }
  const record = receipts => recordFromReceipts({ pin: '2.5.0', previous, receipts, packages: ['a/one'], today: 'T' })
  assert.equal(record([item(base)]).ok, true)
  for (const phase of ['session', 'reattach']) {
    const made = record([item({ ...base, phases: { ...base.phases, [phase]: 'failed' } })])
    assert.equal(made.ok, false, phase)
    assert.match(made.failures.join(), new RegExp(`${phase} failed`))
  }
  // A synthetic replay's failed phase is a failed run too.
  assert.equal(record([item(base), item({ ...base, scenario: 'synthetic-replay', adapter: undefined, phases: { ...phases, plan: 'failed' } }, 'y')]).ok, false)
  // The outcomes a signed-out or refusing run may have still pass.
  assert.equal(record([item({ ...base, phases: { ...base.phases, session: 'auth-required', reattach: 'refused' } })]).ok, true)
  assert.match(record([item(base), item({ ...base, route: 'acp-y', run: 'r0' }, 'y')]).failures.join(), /not of one run/)
  assert.match(record([item({ ...base, run: undefined })]).failures.join(), /not of one run/)
})
