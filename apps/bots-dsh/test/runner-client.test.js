import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspect, run } from '../src/host/runner-client.js'
import { botRunnerReady } from '../src/host/bot-runner.js'
import { BOT, OTHER, RUNNER_UID, exit, fakeRunner, frames, linuxRunner, output, start } from './runner-fixture.mjs'

const DSH_UID = 40004

const request = (runner, options) => run({
  botId: BOT, cwd: join(runner.workRoot, '.bots', BOT), argv: ['/bin/sh', '-c', 'fixture'], timeoutMs: 1000,
  ...options,
})

test('inspection is passive and requires the protected endpoint and socket group', linuxRunner, async t => {
  const runner = await fakeRunner(t)
  assert.equal(inspect().ok, true)
  assert.equal(botRunnerReady(), true)
  assert.equal(runner.connections, 0)
  fs.chmodSync(runner.folder, 0o770)
  assert.equal(inspect().ok, false)
  fs.chmodSync(runner.folder, 0o750)
  fs.chmodSync(runner.proofs, 0o730)
  assert.equal(inspect().ok, false)
  fs.chmodSync(runner.proofs, 0o1730)
  fs.chmodSync(runner.socket, 0o666)
  assert.equal(inspect().ok, false)
  fs.chmodSync(runner.socket, 0o660)
  fs.symlinkSync(runner.folder, join(runner.root, 'link'))
  process.env.AUTOMAGIK_BOT_RUNNER_SOCKET = join(runner.root, 'link', 'runner.sock')
  assert.equal(inspect().ok, false)
  process.env.AUTOMAGIK_BOT_RUNNER_SOCKET = runner.socket
  fs.chmodSync(runner.root, 0o755)
  const lstat = fs.lstatSync
  const foreignParent = t.mock.method(fs, 'lstatSync', (path, options) => {
    const info = lstat(path, options)
    if (path === runner.root) info.uid = 40003
    return info
  })
  assert.equal(inspect().ok, false)
  foreignParent.mock.restore()
  assert.equal(inspect().ok, true)
  t.mock.method(process, 'getgroups', () => [])
  assert.equal(inspect().ok, false)
  assert.equal((await request(runner)).code, 125)
  assert.equal(runner.connections, 0)
})

test('the v2 client allowlists env and decodes fragmented and coalesced frames', linuxRunner, async t => {
  const chars = Buffer.from('é')
  const large = 'x'.repeat(64 * 1024)
  const runner = await fakeRunner(t, {
    reply(conn) {
      const text = frames(start(BOT), output('out', chars.subarray(0, 1)), output('out', chars.subarray(1)),
        output('err', 'warning'), output('out', large), exit())
      conn.write(text.slice(0, 13))
      setImmediate(() => conn.end(text.slice(13)))
    },
  })
  const response = await request(runner, { env: { LANG: 'C.UTF-8', TZ: 'UTC', PATH: '/bin', LD_PRELOAD: 'x', HOME: 'x', DSH_TOKEN: 'x' } })
  assert.deepEqual(response, { code: 0, stdout: 'é' + large, stderr: 'warning', timedOut: false, truncated: false })
  assert.deepEqual(runner.requests[0].wire, {
    v: 2, identity: { kind: 'bot', id: BOT }, argv: ['/bin/sh', '-c', 'fixture'], cwd: join(runner.workRoot, '.bots', BOT),
    timeoutMs: 1000, env: { LANG: 'C.UTF-8', TZ: 'UTC', PATH: '/bin' },
  })
  assert.equal(runner.acknowledgements, 1)
  assert.deepEqual(fs.readdirSync(runner.proofs), [])
})

test('slow provisioning leaves time for a short command after start', linuxRunner, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runner = await fakeRunner(t, {
    reply(conn) {
      t.mock.timers.tick(12_000)
      conn.end(frames(start(BOT), exit()))
    },
  })
  const result = await request(runner, { timeoutMs: 500 })
  assert.equal(result.code, 0)
  assert.equal(result.refusal, undefined)
  assert.equal(runner.requests.length, 1)
})

test('slow provisioning and a late switch marker stay within the command budget', linuxRunner, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runner = await fakeRunner(t, {
    reply(conn) {
      t.mock.timers.tick(18_000) // Provisioning.
      t.mock.timers.tick(8_000) // Waiting for the switch marker after spawn.
      conn.end(frames(start(BOT), exit(3)))
    },
  })
  const result = await request(runner, { timeoutMs: 120_000 })
  assert.equal(result.code, 3)
  assert.equal(result.refusal, undefined)
  assert.equal(runner.requests.length, 1)
})

const error = code => ({ t: 'error', code, message: 'fixture refusal' })
for (const [label, response, code, refusal, timedOut = false, truncated = false] of [
  ['subordinate range floor', frames({ ...start(BOT), uid: 1000, gid: 1000 }, exit()), 0],
  ['child exit 3', frames(start(BOT), exit(3)), 3],
  ['child exit 124', frames(start(BOT), exit(124)), 124],
  ['child exit 125', frames(start(BOT), exit(125)), 125],
  ['signal and truncation', frames(start(BOT), exit(null, { signal: 'SIGTERM', truncated: true })), 143, undefined, false, true],
  ['confirmed timeout', frames(start(BOT), exit(null, { signal: 'SIGKILL', timedOut: true })), 124, undefined, true],
  ['post-start error', frames(start(BOT), error('SPAWN_FAILED')), 125, 'SPAWN_FAILED'],
  ['BAD_VERSION', frames(error('BAD_VERSION')), 125, 'BAD_VERSION'],
  ['BAD_REQUEST', frames(error('BAD_REQUEST')), 125, 'BAD_REQUEST'],
  ['malformed JSON', frames(start(BOT)) + '{\n', 125, 'PROTOCOL'],
  ['malformed base64', frames(start(BOT), { t: 'out', d: '??' }, exit()), 125, 'PROTOCOL'],
  ['premature EOF', frames(start(BOT)), 125, 'PROTOCOL'],
  ['unterminated tail', frames(start(BOT), exit()) + 'x', 125, 'PROTOCOL'],
  ['second terminal', frames(start(BOT), exit(), exit()), 125, 'PROTOCOL'],
  ['oversized line', 'x'.repeat(100_000), 125, 'PROTOCOL'],
  ['other Bot start', frames(start(OTHER), exit()), 125, 'PROTOCOL'],
  ['member start', frames({ ...start(BOT), member: 'owner' }, exit()), 125, 'PROTOCOL'],
  ['member unit on a Bot start', frames({ ...start(BOT), unit: 'am-member-123456789abc' }, exit()), 125, 'PROTOCOL'],
  ['empty run ID on a Bot start', frames({ ...start(BOT), run: '', unit: 'am-bot-' }, exit()), 125, 'PROTOCOL'],
  ['Bot start UID below the subordinate range', frames({ ...start(BOT), uid: 999 }, exit()), 125, 'PROTOCOL'],
  ['Bot start GID below the subordinate range', frames({ ...start(BOT), gid: 999 }, exit()), 125, 'PROTOCOL'],
  ['Bot start with the runner UID', frames({ ...start(BOT), uid: RUNNER_UID }, exit()), 125, 'PROTOCOL'],
  ['Bot start with the DSH UID', frames({ ...start(BOT), uid: DSH_UID }, exit()), 125, 'PROTOCOL'],
  ['output before start', frames(output('out', 'unexpected'), start(BOT), exit()), 125, 'PROTOCOL'],
  ['exit without a confirmed switch', frames(exit(null, { signal: 'SIGKILL', timedOut: true })), 125, 'PROTOCOL'],
]) {
  test(label, linuxRunner, async t => {
    const runner = await fakeRunner(t, { dshUid: DSH_UID, reply: conn => conn.end(response) })
    const result = await request(runner)
    assert.equal(result.code, code)
    assert.equal(result.refusal?.code, refusal)
    assert.equal(result.timedOut, timedOut)
    assert.equal(result.truncated, truncated)
    assert.equal(runner.connections, 1)
    assert.equal(runner.requests.length, 1)
  })
}

for (const [label, challenge] of [['short path', '../escape'], ['48 characters with a non-hex character', '1'.repeat(47) + 'g']]) {
  test(`malformed challenge (${label}) never creates a proof or acknowledges it`, linuxRunner, async t => {
    const runner = await fakeRunner(t, { challenge })
    const open = t.mock.method(fs, 'openSync', () => assert.fail('proof open'))
    assert.equal((await request(runner)).refusal.code, 'PROTOCOL')
    assert.equal(open.mock.callCount(), 0)
    open.mock.restore()
    assert.deepEqual(fs.readdirSync(runner.proofs), [])
    assert.equal(runner.acknowledgements, 0)
  })
}

test('exclusive proof creation preserves a pre-existing file', linuxRunner, async t => {
  const name = '1'.repeat(48)
  const runner = await fakeRunner(t, { challenge: name, prepareProof: file => fs.writeFileSync(file, 'original') })
  assert.equal((await request(runner)).refusal.code, 'PROOF_FAILED')
  assert.equal(fs.readFileSync(join(runner.proofs, name), 'utf8'), 'original')
  assert.equal(runner.acknowledgements, 0)
  assert.equal(runner.requests.length, 0)
})

test('proof refusal ends the connection before any request', linuxRunner, async t => {
  const runner = await fakeRunner(t, { proofVerdict: 'refused: no proof' })
  const result = await request(runner)
  assert.deepEqual(result.refusal, { code: 'REFUSED', message: 'no proof' })
  assert.equal(result.code, 125)
  assert.equal(runner.requests.length, 0)
})

test('cancellation closes the live socket', linuxRunner, async t => {
  const cancelled = new AbortController()
  const closed = Promise.withResolvers()
  const runner = await fakeRunner(t, {
    reply(conn) {
      conn.once('close', closed.resolve)
      conn.write(frames(start(BOT)))
      cancelled.abort()
    },
  })
  assert.equal((await request(runner, { signal: cancelled.signal })).refusal.code, 'CANCELLED')
  await closed.promise
  assert.equal(runner.connections, 1)
})
