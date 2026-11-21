// The window-only endpoints (the seat chat's reads, the Code tree, automations) answer only the
// shared route's proof of the desktop window. Another plugin reaches the team runtime as the
// `omniTeam` service and its endpoint table through `rt.extended.endpointOf`, which hands out each
// endpoint's function: calling it with `true`, or any value it makes itself, is refused.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fromWindow, revokeWindowProof, windowProof } from '../src/host/desktop-window.js'
import { install as installHooks, isWindowEndpoint } from '../src/host/extend.js'
import { install as installSeats } from '../src/host/seat-chat.js'
import { CODE_TREE_ENDPOINT, install as installCodeSide } from '../src/host/code-side.js'
import { install as installAutomations } from '../src/host/automations.js'
import { Engine } from '../src/host/live-chat/engine.js'
import { createFakeHc } from '../src/host/live-chat/fake-hc.mjs'
import { aWindowProof } from './fixtures/window-proof.mjs'

const FORGED = [true, 1, 'true', {}, Object.freeze({}), { desktopWindow: true }, new Boolean(true)]

function team(t) {
  const root = mkdtempSync(join(tmpdir(), 'omni-window-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const disposers = []
  t.after(() => { for (const off of disposers.reverse()) { try { off() } catch { /* gone */ } } })
  const rt = {
    registryPath: join(root, 'bots.json'),
    home: root,
    warn: () => {},
    ctx: {
      effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); return () => {} },
      connection: { fetch: { register: () => () => {} } },
    },
  }
  installHooks(rt)
  return { rt, root, disposers }
}

test('only a verified request makes a proof, and only a made proof passes', (t) => {
  const secret = 'ab'.repeat(32)
  const digest = createHash('sha256').update(secret, 'ascii').digest('hex')
  const request = headers => new Request('http://localhost/api/omni-ui', { headers })
  const was = process.env.AUTOMAGIK_WINDOW_DIGEST
  t.after(() => { if (was === undefined) delete process.env.AUTOMAGIK_WINDOW_DIGEST; else process.env.AUTOMAGIK_WINDOW_DIGEST = was })
  // A caller's own environment is ignored: with none in the process, its digest makes no proof.
  delete process.env.AUTOMAGIK_WINDOW_DIGEST
  assert.equal(windowProof(request({ 'x-automagik-window': secret }), { AUTOMAGIK_WINDOW_DIGEST: digest }), false, 'no digest of its own, no window')
  process.env.AUTOMAGIK_WINDOW_DIGEST = digest
  assert.equal(windowProof(request({})), false)
  assert.equal(windowProof(request({ 'x-automagik-window': 'cd'.repeat(32) })), false)
  assert.equal(windowProof(request({ 'x-automagik-window': digest })), false, 'the digest alone is not the secret')
  assert.equal(windowProof(request({ 'x-automagik-window': 'cd'.repeat(32) }), { AUTOMAGIK_WINDOW_DIGEST: createHash('sha256').update('cd'.repeat(32), 'ascii').digest('hex') }), false, "a caller's digest is not the process's")
  const proof = windowProof(request({ 'x-automagik-window': secret }))
  assert.equal(fromWindow(proof), true)
  assert.notEqual(windowProof(request({ 'x-automagik-window': secret })), proof, 'one proof per request')
  for (const value of [...FORGED, false, null, undefined]) assert.equal(fromWindow(value), false, String(value))
  revokeWindowProof(proof)
  assert.equal(fromWindow(proof), false, 'a revoked proof, kept after its request, opens nothing')
})

test('only the team\'s window-only endpoints are marked, and no entry can be given a new function', (t) => {
  const { rt, disposers } = team(t)
  disposers.push(installSeats(rt, { engine: { ready: async () => {}, hub: { all: () => [] }, watch: () => { throw new Error('fixture') }, close() {} } }))
  disposers.push(rt.hooks.endpoint('another-plugin', async () => 'ok'))
  // A caller of the public hook cannot ask for the mark.
  disposers.push(rt.hooks.endpoint('asks-for-window', async () => 'ok', { read: true, window: true }))
  for (const name of ['seat-chat-list', 'seat-chat-open', 'seat-chat-read', 'seat-chat-close']) assert.equal(isWindowEndpoint(rt.extended.endpointOf(name)), true, name)
  for (const name of ['another-plugin', 'asks-for-window']) assert.equal(isWindowEndpoint(rt.extended.endpointOf(name)), false, name)
  const entry = rt.extended.endpointOf('seat-chat-read')
  assert.throws(() => { entry.fn = async () => 'swapped' }, TypeError)
  assert.equal(Object.isFrozen(rt.extended.endpointOf('another-plugin')), true)
})

test("another plugin's call to the seat chat's reads with a forged window is refused", async (t) => {
  const { rt, disposers } = team(t)
  writeFileSync(rt.registryPath, JSON.stringify({ version: 2, bots: [{ id: 'b-aaaaaaaaaa', name: 'Atlas' }] }))
  const openFile = fs.openSync
  const reads = t.mock.method(fs, 'openSync', (path, ...args) => openFile(path, ...args))
  syncBuiltinESMExports()
  t.after(() => { reads.mock.restore(); syncBuiltinESMExports() })
  const connects = t.mock.method(Socket.prototype, 'connect', () => assert.fail('a refused read connects to no core'))
  const hc = createFakeHc({ terminals: [] })
  const engine = new Engine({ hc, home: rt.home })
  t.after(() => engine.close())
  disposers.push(installSeats(rt, { engine }))
  for (const name of ['seat-chat-list', 'seat-chat-open', 'seat-chat-read', 'seat-chat-close']) {
    const entry = rt.extended.endpointOf(name)
    assert.equal(typeof entry?.fn, 'function', name)
    for (const forged of FORGED) {
      await assert.rejects(() => entry.fn({ client: 'win-1', terminal: 't1' }, undefined, forged), /desktop-only/, `${name} ${String(forged)}`)
    }
  }
  // The engine subscribes to events when it starts; a refused read adds no call of its own.
  assert.deepEqual(hc.calls.filter(call => call.method !== 'events.subscribe'), [], 'a refused read reaches no hc call')
  assert.equal(reads.mock.calls.filter(({ arguments: [path] }) => path === rt.registryPath).length, 0, 'a refused read reads no registry')
  assert.equal(connects.mock.callCount(), 0, 'a refused read connects to no core')
  // The same call with the route's proof gets past the gate (to the seat's own refusal).
  await assert.rejects(() => rt.extended.endpointOf('seat-chat-read').fn({ client: 'win-1', terminal: 't1' }, undefined, aWindowProof()), /not open/)
})

test("another plugin's call to the Code tree with a forged window reads no tree", async (t) => {
  const { rt, root, disposers } = team(t)
  let connects = 0
  let reads = 0
  const readFile = () => { reads += 1; throw Object.assign(new Error('fixture: no file'), { code: 'ENOENT' }) }
  disposers.push(installCodeSide(rt, { env: { HOME: root }, desktop: true, readFile, connect: () => { connects += 1; throw new Error('fixture: no core') } }))
  const entry = rt.extended.endpointOf(CODE_TREE_ENDPOINT)
  for (const forged of FORGED) {
    assert.equal((await entry.fn(undefined, undefined, forged)).reason, 'desktop-only', String(forged))
  }
  assert.equal(connects, 0)
  assert.equal(reads, 0, 'a refused call reads no registry or ledger')
  assert.notEqual((await entry.fn(undefined, undefined, aWindowProof())).reason, 'desktop-only')
})

test("another plugin's call to automations with a forged window is refused", async (t) => {
  const { rt, root, disposers } = team(t)
  disposers.push(installAutomations(rt, { env: { HOME: root, PATH: '/nonexistent', HERDR_AUTOMATIONS: join(root, 'no-scheduler') } }))
  for (const name of ['automations-list', 'automations-put', 'automations-remove']) {
    const entry = rt.extended.endpointOf(name)
    for (const forged of FORGED) {
      assert.deepEqual(await entry.fn({}, undefined, forged), { reason: 'desktop-only' }, `${name} ${String(forged)}`)
    }
  }
  assert.notDeepEqual(await rt.extended.endpointOf('automations-list').fn({}, undefined, aWindowProof()), { reason: 'desktop-only' })
})
