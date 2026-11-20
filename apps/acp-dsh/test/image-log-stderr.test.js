import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { AgentRun } from '../src/host/acp.js'
import { ensureChatProfiles } from '../src/host/codex-chat-profiles.js'

const FAKE = join(import.meta.dirname, '../dev/fake-image-agent.mjs')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
for (const [kind, expected] of [
  ['unavailable', 'the Codex image run is not isolated (profile unavailable); the image was refused'],
  ['not-started', 'the Codex image run was not started (unsupported): Codex does not know the feature shell_tool'],
  ['wider', 'the Codex image run is not isolated (profile wider than requested); the image was refused'],
  ['changed', 'the Codex image run is not isolated (profile config changed); the image was refused'],
  ['not-offered', 'the Codex image run is not isolated (profile mode not offered); the image was refused'],
  ['rejected', 'the Codex image run is not isolated (profile mode selection rejected); the image was refused'],
  ['config-refused', 'the Codex image run is not isolated (profile config refused); the image was refused'],
]) test(`image ${kind} warning reaches logger and stderr without private content through apply`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'image-stderr-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileModes = ensureChatProfiles(home, { platform: 'linux' })
  const launch = { command: process.execPath, args: [FAKE], ...(kind === 'unavailable' ? {} : { profileModes }), env: {
    CODEX_HOME: home, FAKE_IMAGE_TRACE: join(home, 'trace'),
    FAKE_IMAGE_PROFILE: kind === 'not-offered' ? '' : kind === 'rejected' ? 'reject' : 'offer',
    ...(kind === 'wider' ? { FAKE_PROFILE_RESOLVED: 'wider' } : {}),
    ...(kind === 'not-started' ? { FAKE_FEATURES: JSON.stringify({ drop: ['shell_tool'] }) } : {}),
    ...(kind === 'config-refused' ? { FAKE_INVALID_CONFIG: 'profile' } : {}),
  } }
  if (kind === 'changed') {
    const setMode = AgentRun.prototype.setMode
    t.mock.method(AgentRun.prototype, 'setMode', async function(mode, options) {
      const result = await setMode.call(this, mode, options)
      if (mode.startsWith('permission-profile:')) writeFileSync(join(home, 'config.toml'), readFileSync(join(home, 'config.toml'), 'utf8') + '# changed\n')
      return result
    })
  }
  const warns = [], stderr = [], services = {}, cleanups = []
  t.mock.method(console, 'error', line => stderr.push(line))
  let adapter
  const ctx = {
    logger: { warn: line => warns.push(line), info() {} },
    llm: { registerAdapter: (_routes, value) => { adapter = value; return Object.assign(() => {}, { replace() {} }) }, listProviders: () => [], listModels: () => [] },
    agents: { get: () => undefined }, get: () => undefined,
    provide: (name, value) => { services[name] = value }, on() {}, emit() {},
    effect: execute => { cleanups.push(execute()) },
  }
  const store = { binOf: pkg => pkg === '@agentclientprotocol/codex-acp' ? { path: FAKE, version: '1' } : undefined,
    busy: () => false, lastError: () => undefined, lastFailure: () => undefined, update: async () => {}, dispose() {} }
  apply(ctx, { claude: false, codex: true }, { store, cliStore: undefined,
    find: name => name === 'codex' ? '/fake/bin/codex' : undefined, signedIn: async () => true,
    imageSetup: async () => { adapter.agents.get('acp-codex').spawn = () => launch },
  })
  t.after(() => { for (const cleanup of cleanups.splice(0)) cleanup?.() })
  const prompt = 'PRIVATE_PROMPT_SENTINEL', filename = 'PRIVATE_PICTURE_SENTINEL.png'
  await assert.rejects(services.acpAgents.editImage({ prompt, image: { base64: PNG, mimeType: 'image/png', name: filename } }))
  assert.deepEqual(warns, [`acp-dsh: ${expected}`])
  assert.deepEqual(stderr, [`[acp-dsh] ${expected}`])
  const trace = readFileSync(join(home, 'trace'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(trace.some(row => row.event === 'prompt'), false, 'the refused edit sends neither prompt nor picture')
  const hex = profileModes['read-only'].slice(-32)
  for (const line of [...warns, ...stderr]) {
    for (const privateText of [prompt, filename, PNG, Buffer.from(PNG, 'base64').toString('hex'), home, 'input.png', 'automagik-image-', hex]) assert.equal(line.includes(privateText), false)
    assert.doesNotMatch(line, /[/\\]/)
  }
})

test('image readiness warnings also reach both outputs through apply', async t => {
  const warns = [], stderr = [], services = {}, cleanups = []
  t.mock.method(console, 'error', line => stderr.push(line))
  const ctx = { logger: { warn: line => warns.push(line), info() {} },
    llm: { registerAdapter: () => Object.assign(() => {}, { replace() {} }), listProviders: () => [], listModels: () => [] },
    agents: { get: () => undefined }, get: () => undefined, provide: (name, value) => { services[name] = value }, on() {}, emit() {}, effect: fn => cleanups.push(fn()) }
  const store = { binOf: () => ({ path: FAKE, version: '1' }), busy: () => false, lastError() {}, lastFailure() {}, dispose() {} }
  apply(ctx, { claude: false, codex: true }, { store, find: () => '/fake/codex', signedIn: async () => true,
    imageSetup: async () => { throw Object.assign(new Error('the check could not be read'), { kind: 'unreadable' }) } })
  t.after(() => { for (const cleanup of cleanups) cleanup?.() })
  await services.acpAgents.imageAccess()
  assert.deepEqual(warns, ['acp-dsh: Codex cannot draw images (unreadable): the check could not be read'])
  assert.deepEqual(stderr, ['[acp-dsh] Codex cannot draw images (unreadable): the check could not be read'])
})
