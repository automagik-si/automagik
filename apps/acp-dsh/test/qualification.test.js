// The qualification record (src/host/qualification.js) and its script (scripts/acp-qualify.mjs):
// a tuple is recorded only from a run whose required phases all passed, the same tuple again
// replaces its entry, revoke removes it, and the app takes a native session back only for the
// exact tuple while its setting is `qualified`. The real run is test/real-backend.test.js.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeReceipt } from '../scripts/acp-receipts.mjs'
import { qualify } from '../scripts/acp-qualify.mjs'
import { cliVersionOf, continuityFor, qualificationOf, qualificationPath, readQualification, recordQualification, REQUIRED_PHASES, revokeQualification } from '../src/host/qualification.js'

const tuple = { route: 'acp-claude', scenario: 'synthetic-backend', backend: 'loopback-stub', sdk: '2.12.0', adapter: { name: '@agentclientprotocol/claude-agent-acp', version: '0.113.0' }, cli: { version: '2.1.332 (Claude Code)' }, platform: 'darwin-arm64', node: 'v24.13.1' }
const passed = Object.fromEntries(REQUIRED_PHASES.map(phase => [phase, 'passed']))
const home = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-qualification-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a run qualifies its tuple only when every required phase passed', () => {
  assert.equal(cliVersionOf('2.1.332 (Claude Code)'), '2.1.332')
  assert.equal(cliVersionOf('codex-cli 0.170.0'), '0.170.0')
  const { entry } = qualificationOf([{ ...tuple, phases: passed }], { route: 'acp-claude', backend: 'loopback-stub', now: () => 'T' })
  assert.deepEqual(entry, { route: 'acp-claude', adapter: tuple.adapter, cli: { version: '2.1.332' }, platform: 'darwin-arm64', policy: 'bridged', backend: 'loopback-stub', method: 'resume', qualifiedAt: 'T', phases: passed })
  for (const phase of REQUIRED_PHASES) {
    const refused = qualificationOf([{ ...tuple, phases: { ...passed, [phase]: 'failed' } }], { route: 'acp-claude' })
    assert.deepEqual(refused, { refused: [phase] }, phase)
  }
  assert.deepEqual(qualificationOf([{ ...tuple, scenario: 'real-unprompted', phases: passed }], { route: 'acp-claude' }), { refused: ['no receipt'] }, 'only the end-to-end scenario qualifies')
  assert.deepEqual(qualificationOf([{ ...tuple, adapter: { ...tuple.adapter, version: 'unknown' }, phases: passed }], { route: 'acp-claude' }), { refused: ['adapter version'] })
})

test('the record: the same tuple replaces its entry, revoke removes it, an unreadable file holds nothing', (t) => {
  const file = qualificationPath(home(t))
  const { entry } = qualificationOf([{ ...tuple, phases: passed }], { route: 'acp-claude', now: () => 'first' })
  recordQualification(file, entry)
  recordQualification(file, { ...entry, qualifiedAt: 'second' })
  assert.deepEqual(readQualification(file).map(held => held.qualifiedAt), ['second'], 'idempotent: one entry per tuple')
  recordQualification(file, { ...entry, adapter: { ...entry.adapter, version: '0.114.0' } })
  assert.equal(readQualification(file).length, 2)
  assert.equal(revokeQualification(file, { route: 'acp-claude', adapterVersion: '0.114.0' }), 1)
  assert.equal(revokeQualification(file, { route: 'acp-claude' }), 1)
  assert.deepEqual(readQualification(file), [])
  assert.equal(revokeQualification(file, { route: 'acp-claude' }), 0)
  writeFileSync(file, '{ not json')
  assert.deepEqual(readQualification(file), [])
})

test('the app takes a session back only for the exact tuple, and only while the setting is qualified', () => {
  const entries = [{ route: 'acp-claude', adapter: tuple.adapter, cli: { version: '2.1.332' }, platform: 'darwin-arm64', policy: 'bridged', method: 'resume' }]
  const launch = { setting: 'qualified', route: 'acp-claude', adapterVersion: '0.113.0', cliVersion: '2.1.332', platform: 'darwin-arm64' }
  assert.deepEqual(continuityFor(entries, launch), { methods: ['resume'] })
  for (const [name, change] of [['off', { setting: 'off' }], ['no setting', { setting: undefined }], ['adapter', { adapterVersion: '0.113.1' }], ['cli', { cliVersion: '2.1.333' }],
    ['cli unknown', { cliVersion: undefined }], ['platform', { platform: 'linux-x64' }], ['route', { route: 'acp-codex' }]]) {
    assert.equal(continuityFor(entries, { ...launch, ...change }), undefined, name)
  }
})

test('acp-qualify: a passing scenario records the tuple, a failing one records nothing', (t) => {
  const dir = home(t)
  const lines = []
  const run = status => (command, args, { env }) => {
    writeReceipt(env.ACP_RECEIPT_DIR, { ...tuple, phases: status === 0 ? passed : { ...passed, continuity: 'failed' } })
    return { status, stdout: '' }
  }
  assert.equal(qualify({ route: 'acp-claude', adapter: '/a', cli: '/c', home: dir, run: run(1), log: line => lines.push(line) }).qualified, false)
  assert.deepEqual(readQualification(qualificationPath(dir)), [])
  assert.equal(qualify({ route: 'acp-claude', adapter: '/a', cli: '/c', home: dir, run: run(0), log: line => lines.push(line) }).qualified, true)
  assert.equal(qualify({ route: 'acp-claude', adapter: '/a', cli: '/c', home: dir, run: run(0), log: line => lines.push(line) }).qualified, true)
  const entries = JSON.parse(readFileSync(qualificationPath(dir), 'utf8')).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].backend, 'loopback-stub')
  assert.match(lines.at(-1), /qualified @agentclientprotocol\/claude-agent-acp 0\.113\.0 with CLI 2\.1\.332/)
})
