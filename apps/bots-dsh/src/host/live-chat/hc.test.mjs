// node --test chat/hc.test.mjs: the real seam's wire, against a stand-in `hc connect`
// (fixtures/hc-connect.mjs), never a live Herdr.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { addressParts, connectHc } from './hc.js'

const script = fileURLToPath(new URL('./fixtures/hc-connect.mjs', import.meta.url))
const fakeSpawn = (cmd, args, opts) => spawn(process.execPath, [script, ...args], opts)

test('a call goes out after hello and its result comes back; env is passed as given', async () => {
  const hc = connectHc({ spawn: fakeSpawn, env: { ...process.env, HC_SESSION: 'phone-a' } })
  try {
    assert.deepEqual(await hc.call('terminal.get', { terminal: 't9' }), { address: 't9', env: 'phone-a' })
    assert.deepEqual(await hc.call('terminal.get', { terminal: 't10' }), { address: 't10', env: 'phone-a' })
  } finally { hc.close() }
})

test('an error answer rejects with its kind', async () => {
  const hc = connectHc({ spawn: fakeSpawn })
  try {
    await assert.rejects(hc.call('boom'), (e) => e.message === 'not_found' && e.kind === 'not_found')
  } finally { hc.close() }
})

test('a call with no answer times out; a dying hc rejects what is pending, and the next call starts afresh', async () => {
  const hc = connectHc({ spawn: fakeSpawn, callMs: 200 })
  try {
    await assert.rejects(hc.call('silent'), /timed out/)
    const pending = hc.call('silent')
    await assert.rejects(hc.call('die'), /hc exited/)
    await assert.rejects(pending, /hc exited/)
    assert.deepEqual(await hc.call('terminal.get', { terminal: 't1' }), { address: 't1', env: process.env.HC_SESSION ?? null })
  } finally { hc.close() }
})

test('a subscription gets the snapshot, events, heartbeats, then closed once', async () => {
  const hc = connectHc({ spawn: fakeSpawn })
  const got = []
  await new Promise((resolve) => hc.subscribe({}, (m) => { got.push(m); if (m.type === 'closed') resolve() }))
  hc.close()
  assert.deepEqual(got, [
    { type: 'snapshot', seq: 5, terminals: [{ address: 't1' }] },
    { type: 'event', terminal: 't1', seq: 6, kind: 'status', data: { status: { app: 'claude-code', state: 'working' }, reported: true, records: {} } },
    { type: 'heartbeat', seq: 6 },
    { type: 'closed', reason: 'hc exited' }
  ])
})

test('a missing hc fails calls instead of throwing', async () => {
  const hc = connectHc({ hcPath: '/nonexistent/hc' })
  await assert.rejects(hc.call('terminal.get', { terminal: 't1' }), /hc not found|hc closed|hc exited/)
  hc.close()
})

test('addressParts splits a machine off the address', () => {
  assert.deepEqual(addressParts('t7'), { machine: null, id: 't7' })
  assert.deepEqual(addressParts('box/t7'), { machine: 'box', id: 't7' })
})

test('a line from hc longer than the cap ends the connection; pending calls reject', async () => {
  const hc = connectHc({ spawn: fakeSpawn, maxLine: 1000 })
  try {
    await assert.rejects(hc.call('long'), /line too long/)
  } finally { hc.close() }
})
