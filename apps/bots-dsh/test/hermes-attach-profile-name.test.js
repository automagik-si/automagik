import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { attachedModelOf } from '../src/host/hermes-connection.js'
import { install } from '../src/host/hermes-remote.js'
import { fakeContext } from './fake-ctx.js'

const CODE = 'bot/hermes-attach-profile'
const PLAIN = 'This connection’s saved Hermes profile is not served there. Choose a profile again before connecting.'
const named = label => `This connection’s saved Hermes profile “${label}” is not served there. Choose a profile again before connecting.`
const savedRows = [{ id: 'alpha', name: 'Alpha Bot', model: 'sample-model', provider: 'sample' }]

// The endpoint/runtime pattern from hermes-connection.test.js, with only the SSH
// boundary replaced. A missing saved profile must fail before opening a wire.
function runtime(t, config = {}, overrides = {}) {
  const ctx = fakeContext(), endpoints = new Map(), notes = [], secretCalls = [], sshCalls = [], wires = []
  const credential = randomUUID()
  let closed = 0
  ctx.llm.registerAdapter = () => () => {}
  const rt = {
    ctx, state: { prefs: { hermesRemote: {
      enabled: true, setupVersion: 1, mode: 'ssh', authMode: 'token', address: '',
      ssh: { host: 'sample-box' }, profile: 'alpha', profiles: savedRows,
      models: [{ id: 'sample:old', model: 'old', provider: 'sample', name: 'Sample model' }],
      ...config,
    } } },
    hooks: { endpoint: (name, fn) => endpoints.set(name, fn) },
    load: async () => {}, loadSecrets: async () => {}, save: async () => {},
    secretValue: () => undefined,
    secretEndpoint: async (name, body) => { secretCalls.push({ endpoint: name, ...body }) },
    noteFailure: note => notes.push(note),
  }
  install(rt, {
    deadlines: { start: 1000, control: 100, cancel: 100 },
    fetch: async () => { assert.fail('an attached serve needs no REST discovery') },
    transport: options => { wires.push(options); assert.fail('a refused profile must not open a chat wire') },
    startSsh: async (ssh, options) => {
      sshCalls.push({ ssh, options })
      return {
        attached: true, address: 'http://127.0.0.1:23456', credential,
        authHeaders: { Authorization: `Bearer ${credential}` },
        profiles: [{ id: 'beta', name: 'Beta Bot', model: 'sample-model', provider: 'sample', running: true }],
        defaultProfile: 'beta', close: async () => { closed++ },
      }
    },
    ...overrides,
  })
  t.after(() => ctx.dispose())
  return { rt, endpoints, notes, secretCalls, sshCalls, wires, closed: () => closed }
}

async function refuses(h, label, profile) {
  await assert.rejects(h.endpoints.get('hermes-remote-connect')({ cached: true }), error => {
    assert.equal(error.code, CODE)
    assert.equal(error.message, label === undefined ? PLAIN : named(label))
    assert.deepEqual(error.hermesProfile, profile)
    return true
  })
  const { failure } = h.endpoints.get('hermes-remote-test-status')({ connect: true })
  assert.equal(failure.code, CODE)
  if (profile) {
    assert.equal(failure.profile, profile.id)
    assert.equal(failure.profileName, profile.name)
    if (!profile.name) assert.ok(!Object.hasOwn(failure, 'profileName'))
  } else {
    assert.ok(!Object.hasOwn(failure, 'profile'))
    assert.ok(!Object.hasOwn(failure, 'profileName'))
  }
  return failure
}

test('#1341 legacy SSH connect names the saved display name and id when only beta is served', async t => {
  const h = runtime(t)
  h.rt.state.bots = { alpha: { id: 'alpha', name: 'Alpha Bot', model: 'hermes-remote/sample:old', appliedModel: 'hermes-remote/sample:old' } }
  const before = structuredClone(h.rt.state)
  assert.ok(!Object.hasOwn(h.rt.state.prefs.hermesRemote, 'attached'))
  await refuses(h, 'Alpha Bot (alpha)', { id: 'alpha', name: 'Alpha Bot' })
  assert.deepEqual(h.rt.state, before, 'a refusal never changes the profile or the Bot’s model')
  assert.equal(h.sshCalls.length, 1, 'stale cached models do not bypass the live profile check')
  assert.equal(h.closed(), 1)
  assert.deepEqual(h.secretCalls, [])
  assert.deepEqual(h.wires, [])
})

test('#1341 a current attached cached view still names the missing profile in the chat turn error', async t => {
  const h = runtime(t, { attached: true, models: [attachedModelOf(savedRows[0])] })
  const view = await h.endpoints.get('hermes-remote-connect')({ cached: true })
  assert.equal(view.profile, 'alpha')
  assert.equal(view.profileName, 'Alpha Bot')
  assert.equal(h.sshCalls.length, 0, 'opening the current cached view does not connect')
  const agent = h.rt.ctx.scopeAgent('sample-chat')
  h.rt.ctx.provide('agents', { get: id => id === 'sample-chat' ? agent : undefined, list: () => [agent], roots: () => [agent] })
  const chunks = []
  for await (const chunk of h.rt.hermesRemote.adapter.stream(markAgentLoopRequest({
    provider: 'hermes-remote', model: 'attach', sessionId: 'sample-chat',
    signal: new AbortController().signal, messages: [{ role: 'user', content: 'Sample message' }],
  }))) chunks.push(chunk)
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'error', failure: { code: 'REMOTE_HERMES', message: named('Alpha Bot (alpha)') } } }])
  assert.equal(h.sshCalls.length, 1, 'the actual turn validates the live serve')
  assert.equal(h.closed(), 1)
  assert.deepEqual(h.wires, [])
})

test('#1341 missing, empty and unrelated saved rows name only the saved id', async t => {
  for (const [name, profiles] of [
    ['no profiles array', undefined], ['empty rows', []],
    ['unrelated rows', [{ id: 'beta', name: 'Beta Bot' }]],
    ['row without a name', [{ id: 'alpha' }]], ['name equals id', [{ id: 'alpha', name: 'alpha' }]],
  ]) await t.test(name, async sub => {
    const h = runtime(sub, { profiles })
    if (profiles === undefined) delete h.rt.state.prefs.hermesRemote.profiles
    await refuses(h, 'alpha', { id: 'alpha' })
  })
})

test('#1341 Unicode, spaces, quotes, braces and profile length boundaries are preserved literally', async t => {
  for (const [name, id, display] of [
    ['space id', 'Team Alpha', 'Alpha Bot'], ['Unicode id', 'produção', 'Produção Alpha'],
    ['quotes and braces', 'alpha', 'Alpha "{host}" “{profile}”'],
    ['one character', 'a', 'A'], ['100 characters', 'a'.repeat(100), 'A'.repeat(100)],
  ]) await t.test(name, async sub => {
    await refuses(runtime(sub, { profile: id, profiles: [{ id, name: display }] }), `${display} (${id})`, { id, name: display })
  })
})

test('#1341 invalid saved ids keep the fixed refusal and omit profile facts', async t => {
  for (const [name, id] of [
    ['control character', 'alpha\x01'], ['DEL', 'alpha\x7f'], ['newline', 'alpha\nbeta'],
    ['slash', 'alpha/beta'], ['backslash', 'alpha\\beta'],
    ['leading space', ' alpha'], ['trailing space', 'alpha '],
    ['empty', ''], ['too long', 'a'.repeat(101)], ['non-string', 7],
  ]) await t.test(name, async sub => {
    await refuses(runtime(sub, { profile: id, profiles: [{ id, name: 'Alpha Bot' }] }), undefined, undefined)
  })
})

test('#1341 invalid display names are dropped without losing the valid saved id', async t => {
  for (const [name, display] of [
    ['control character', 'Alpha\x01Bot'], ['DEL', 'Alpha\x7fBot'], ['slash', 'Alpha/Bot'],
    ['backslash', 'Alpha\\Bot'], ['leading space', ' Alpha Bot'], ['trailing space', 'Alpha Bot '],
    ['empty', ''], ['too long', 'A'.repeat(101)], ['non-string', 7],
  ]) await t.test(name, async sub => {
    await refuses(runtime(sub, { profiles: [{ id: 'alpha', name: display }] }), 'alpha', { id: 'alpha' })
  })
})

test('#1341 connect status exposes profile facts while the SSH failure report names neither id nor display name', async t => {
  const h = runtime(t)
  const failure = await refuses(h, 'Alpha Bot (alpha)', { id: 'alpha', name: 'Alpha Bot' })
  assert.equal(failure.profile, 'alpha')
  assert.equal(failure.profileName, 'Alpha Bot')
  assert.ok(h.notes.length > 0, 'the refusal records an SSH failure')
  for (const note of h.notes) {
    assert.equal(note.code, CODE)
    assert.match(note.text, /^Remote Hermes SSH failed:/)
    assert.doesNotMatch(note.text, /alpha|Alpha Bot|profileName|profile=/)
  }
  assert.ok(!Object.hasOwn(h.endpoints.get('hermes-remote-test-status')({ requestId: 'other-request' }), 'failure'))
})

test('#1341 connect rebuilds attach refusals from validated structured facts instead of remote message text', async t => {
  for (const [name, profile, expected, kept] of [
    ['valid facts', { id: 'alpha', name: 'Alpha Bot' }, 'Alpha Bot (alpha)', { id: 'alpha', name: 'Alpha Bot' }],
    ['invalid name', { id: 'alpha', name: 'Alpha/Bot' }, 'alpha', { id: 'alpha' }],
    ['invalid id', { id: 'alpha/beta', name: 'Alpha Bot' }, undefined, undefined],
    ['no facts', undefined, undefined, undefined],
  ]) await t.test(name, async sub => {
    const h = runtime(sub, {}, { startSsh: async () => {
      throw Object.assign(Error('Sample remote diagnostic must not reach the screen'), { code: CODE, hermesProfile: profile })
    } })
    await refuses(h, expected, kept)
  })
})

test('#1341 unconfirmed cleanup still takes priority over a named attach refusal', async t => {
  const h = runtime(t, {}, { startSsh: async () => {
    throw Object.assign(Error(named('Alpha Bot (alpha)')), { code: CODE, hermesProfile: { id: 'alpha', name: 'Alpha Bot' }, cleanupUnknown: true })
  } })
  await assert.rejects(h.endpoints.get('hermes-remote-connect')({ cached: true }), error => {
    assert.equal(error.code, 'bot/hermes-ssh-cleanup')
    assert.equal(error.message, 'The SSH connection could not confirm remote cleanup. Check the remote Hermes before reconnecting.')
    assert.equal(error.hermesProfile, undefined)
    return true
  })
})
