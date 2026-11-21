import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { runAccounts } from '../src/host/accounts.js'
import { revokeWindowProof, windowProof } from '../src/host/desktop-window.js'
import { isWindowEndpoint } from '../src/host/extend.js'
import { accountsFixture, accountsHost, CANARY, LIST, SNAPSHOT, USE } from './fixtures/accounts-host.mjs'
import { DIGEST, WINDOW } from './fixtures/automations-host.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const readArgs = ['here', '--within', '15', '--json']
const runWithTimeout = shouldTimeOut => (cli, args, options) => {
  const isRead = args[0] === 'here'
  assert.equal(options.timeout, isRead ? 20_000 : 30_000)
  return runAccounts(cli, args, { ...options, timeout: shouldTimeOut() ? 1500 : options.timeout })
}
const value = async (host, endpoint = LIST, payload, options) => {
  const response = await host.request(endpoint, payload, options)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const reply = await response.json()
  assert.equal(reply.ok, true)
  return reply.value
}
const expectReason = async (host, reason, endpoint, payload) => assert.deepEqual(await value(host, endpoint, payload), { reason })
const expectRowsOnly = (view, why) => {
  assert.equal(view.why, why)
  assert.equal(view.rows.length, 3)
  assert.equal(view.rows.some(row => row.use), false)
  assert.equal(Object.hasOwn(view, 'token'), false)
}

test('the bridge and registered handlers require a live desktop owner proof before spawning', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  const principals = [
    { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' },
    { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } },
  ]
  const proof = windowProof(new Request('http://localhost', { headers: { 'x-automagik-window': WINDOW } }))
  const revoked = windowProof(new Request('http://localhost', { headers: { 'x-automagik-window': WINDOW } }))
  assert.notEqual(revoked, false)
  revokeWindowProof(revoked)
  for (const endpoint of [LIST, USE]) {
    for (const principal of principals) assert.equal((await host.request(endpoint, {}, { peer: { principal } })).status, 403)
    for (const marker of [null, DIGEST, 'cd'.repeat(32)]) {
      assert.deepEqual(await value(host, endpoint, {}, { marker }), { reason: 'desktop-only' })
    }
    const entry = host.rt.extended.endpointOf(endpoint)
    assert.equal(isWindowEndpoint(entry), true)
    assert.equal(entry.read, endpoint === LIST)
    for (const forged of [true, 'true', {}, revoked]) {
      assert.deepEqual(await entry.fn({}, undefined, forged), { reason: 'desktop-only' })
    }
  }
  assert.deepEqual(f.calls(), [])
  assert.match((await host.rt.extended.endpointOf(LIST).fn({}, undefined, proof)).token, /^[a-f0-9]{32}$/)
  revokeWindowProof(proof)
})

test('Windows and an explicitly chosen agent home refuse reads and writes before spawning', async t => {
  await t.test('Windows', async sub => {
    const f = accountsFixture(sub)
    const host = accountsHost(sub, f, { platform: 'win32' })
    for (const endpoint of [LIST, USE]) await expectReason(host, 'unavailable', endpoint)
    assert.deepEqual(f.calls(), [])
  })
  await t.test('chosen home, including an empty value', async sub => {
    const f = accountsFixture(sub)
    f.env.AUTOMAGIK_AGENT_HOME_LAUNCH = ''
    const host = accountsHost(sub, f)
    for (const endpoint of [LIST, USE]) await expectReason(host, 'chosen-home', endpoint)
    assert.deepEqual(f.calls(), [])
  })
})

test('discovery distinguishes a missing, old and unusable override CLI', async t => {
  const f = accountsFixture(t, { install: false })
  const host = accountsHost(t, f)
  await expectReason(host, 'not-installed')
  f.add(f.pack, { version: '3.160.3-rc.1' })
  await expectReason(host, 'old-cli')
  for (const version of ['03.160.4', '3.160.4-01']) {
    writeFileSync(join(f.pack, 'VERSION'), `${version}\n`)
    await expectReason(host, 'old-cli')
  }
  writeFileSync(join(f.pack, 'VERSION'), '3.160.3\n')
  for (const override of ['', 'relative', join(f.root, 'missing')]) {
    f.env.AUTOMAGIK_AM_DIR = override
    await expectReason(host, 'not-installed')
  }
  assert.deepEqual(f.calls(), [])
  f.env.AUTOMAGIK_AM_DIR = f.pack
  assert.ok((await value(host)).token)
})

test('reader and writer prefer the newest compatible version and the pack wins ties', async t => {
  const f = accountsFixture(t)
  f.add(f.am, { version: '3.161.0' })
  const host = accountsHost(t, f)
  const choose = async (readFrom, writeFrom) => {
    const { token } = await value(host)
    assert.ok(token)
    assert.deepEqual(await value(host, USE, { id: '2', token }), { switched: true })
    assert.deepEqual(f.calls().slice(-2).map(call => call.dir), [readFrom, writeFrom])
  }
  await choose(f.am, f.am)
  const file = join(f.am, 'accountsWrite.js')
  for (const marker of ['// export const EXPECT_QUALIFIED = 1;\n', 'export const EXPECT_QUALIFIED = 1;\n' + 'x'.repeat(65_536)]) {
    writeFileSync(file, marker)
    await choose(f.am, f.pack)
  }
  writeFileSync(file, 'export const EXPECT_QUALIFIED = 1;\r\n')
  writeFileSync(join(f.am, 'VERSION'), '3.160.3+am\nmore\n')
  await choose(f.pack, f.pack)
  rmSync(f.pack, { recursive: true })
  await choose(f.am, f.am)
  rmSync(file)
  expectRowsOnly(await value(host), 'old-cli')
})

test('legacy, mismatched-home and unreadable reads have fixed reasons', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  const { writer, claude } = f.answer
  delete f.answer.writer
  delete f.answer.appHome
  f.respond()
  expectRowsOnly(await value(host), 'old-cli')
  // A delivery-1 answer has no route fields either: its rows still show, read-only.
  const { routes } = claude
  delete claude.routes
  f.respond()
  expectRowsOnly(await value(host), 'old-cli')
  claude.routes = routes
  f.answer.writer = writer
  for (const path of ['relative', join(f.root, 'other-home')]) {
    f.answer.appHome = path
    f.respond()
    expectRowsOnly(await value(host), 'home-mismatch')
  }
  f.answer.appHome = f.appHome
  f.answer.claude = null
  f.respond()
  assert.deepEqual(await value(host), { why: 'unreadable' })
  f.answer.claude = claude
  f.respond()
  assert.ok((await value(host)).token)
})

test('panel qualification uses the complete writer evidence', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  for (const [panel, flags, expected] of [
    ['absent', {}, undefined], ['off', {}, undefined], ['on', { panelWrites: true, confirmed: true }, undefined],
    ['on', {}, 'panel-old'], ['on', { panelWrites: true }, 'panel-old'], ['on', { panelWrites: true, confirmed: true, sidebarWrites: false }, 'panel-old'],
    ['off', { unexpected: true }, 'panel-unknown'], ['unknown', {}, 'panel-unknown'],
  ]) {
    f.answer.writer = { setLogin: true, panel, panelWrites: false, sidebarWrites: true, confirmed: false, ...flags }
    f.respond()
    const view = await value(host)
    if (!expected) assert.equal(view.rows.find(row => row.id === '2').use, true)
    else {
      expectRowsOnly(view, expected)
      await expectReason(host, 'changed', USE, { id: '2', token: '0'.repeat(32) })
    }
  }
  assert.equal(f.calls().some(call => call.argv[0] === 'set-login'), false)
})

test('read projection keeps only display fields and handles signed-out, launcher, fallback and bad records', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  const initial = structuredClone(f.answer.claude)
  f.respond({ here: { stderr: CANARY.repeat(4000) } })
  const view = await value(host)
  assert.deepEqual(view, { fallback: false, launcher: false, readOnly: false, token: view.token, rows: [
    { id: 'default', label: 'default', email: 'a@example.test', state: 'eligible', selected: true, effective: true, use: false },
    { id: '2', label: 'slot', email: 'b@example.test', state: 'eligible', selected: false, effective: false, use: true },
    { id: '3', label: 'slot', email: null, state: 'not-signed-in', selected: false, effective: false, use: false },
  ] })
  assert.doesNotMatch(JSON.stringify(view), new RegExp(CANARY))
  for (const [fields, route, flags] of [
    [{ email: null, state: 'not-signed-in' }, 'not-signed-in', { use: true, launcher: false, fallback: false }],
    [{ state: 'failed' }, 'failed', { use: false, launcher: false, fallback: false }],
    [{ state: 'timeout' }, 'timeout', { use: false, launcher: false, fallback: false }],
    [{ state: 'ambiguous' }, 'failed', { use: false, launcher: false, fallback: false }],
    [{ state: 'unresolved' }, 'eligible', { use: false, launcher: true, fallback: false }],
    [{}, 'unresolved', { use: false, launcher: true, fallback: false }],
    [{ selected: '3' }, 'eligible', { use: false, launcher: false, fallback: true }],
    [{ record: 'bad' }, 'eligible', { use: false, launcher: false, fallback: true }],
    [{ record: 'bad', snapshot: null }, 'eligible', { use: false, launcher: false, fallback: true }],
    [{ record: 'absent', snapshot: null }, 'eligible', { use: false, launcher: false, fallback: false }],
    [{ slotsComplete: false }, 'eligible', { use: false, launcher: false, fallback: false }],
  ]) {
    f.answer.claude = { ...structuredClone(initial), ...fields }
    f.answer.claude.routes.record.state = route
    if (fields.state === 'not-signed-in') Object.assign(f.answer.claude.slots[0], { state: fields.state, email: null })
    f.respond()
    const next = await value(host)
    assert.deepEqual({ use: next.rows[1].use, launcher: next.launcher, fallback: next.fallback }, flags)
    assert.equal(Object.hasOwn(next, 'token'), flags.use)
  }
})

test('a signed-out effective login can switch to an eligible slot without a launcher hint', async t => {
  const f = accountsFixture(t)
  f.answer.claude.email = null
  f.answer.claude.state = 'not-signed-in'
  f.answer.claude.routes.record.state = 'not-signed-in'
  f.answer.claude.slots[0].email = null
  f.answer.claude.slots[0].state = 'not-signed-in'
  f.respond()
  const host = accountsHost(t, f)
  const view = await value(host)
  assert.equal(view.launcher, false)
  assert.equal(view.rows.find(row => row.id === '2').use, true)
  assert.deepEqual(await value(host, USE, { id: '2', token: view.token }), { switched: true })
  const write = f.calls().find(call => call.argv[0] === 'set-login')
  assert.equal(write.argv[write.argv.indexOf('--expect-eff') + 1], hash('default\n'))
})

test('bad JSON, an oversized wire reply, wrong kind and invalid Claude fields fail closed', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  const json = JSON.stringify(f.answer)
  f.respond({ here: { text: json.padEnd(65_536) } })
  assert.ok((await value(host)).token)
  for (const text of ['{', json.replace('accounts.here', 'different.kind'), json.padEnd(65_537), ' '.repeat(65_530) + '"中文"']) {
    f.respond({ here: { text } })
    await expectReason(host, 'cli-protocol')
  }
  const initial = structuredClone(f.answer.claude)
  for (const invalid of [
    data => { data.snapshot = null }, data => { data.record = 'absent' }, data => { data.snapshot = 'wrong' },
    data => { data.record = 'wrong' }, data => { data.selected = '_2' }, data => { data.effective = false },
    data => { data.email = 'missing-at-sign' }, data => { data.state = 'wrong' }, data => { data.slotsComplete = 1 },
    data => { data.slots[0].email = 'a\u0085@example.test' }, data => { data.slots[0].email = 'İ'.repeat(64) + '@example.test' },
    data => { data.slots[0].id = '2' }, data => { data.slots[0].state = 'unresolved' },
    data => { data.routes.record.state = 'wrong' },
  ]) {
    f.answer.claude = structuredClone(initial)
    invalid(f.answer.claude)
    f.respond()
    await expectReason(host, 'cli-protocol')
  }
})

test('a read timeout is fixed and a switch uses the exact argv, bound home and one-use offer', async t => {
  const f = accountsFixture(t)
  let shouldTimeOut = true
  const host = accountsHost(t, f, { run: runWithTimeout(() => shouldTimeOut) })
  f.respond({ here: { delay: 10_000 } })
  await expectReason(host, 'cli-timeout')
  shouldTimeOut = false
  f.respond()
  const otherHome = join(f.root, 'other-app-home')
  const otherRecord = join(otherHome, 'claude-logins.json')
  mkdirSync(otherHome)
  writeFileSync(otherRecord, '{"use":"default"}\n')
  const before = readFileSync(otherRecord)
  const { token } = await value(host)
  assert.match(token, /^[a-f0-9]{32}$/)
  const payload = { id: '2', token }
  assert.deepEqual(await value(host, USE, payload), { switched: true })
  await expectReason(host, 'changed', USE, payload)
  assert.deepEqual(f.calls().slice(-2), [
    { argv: readArgs, dir: f.pack, cwd: f.root, stdin: '', appHome: f.env.HERDR_APP_HOME },
    { argv: ['set-login', '--use', '2', '--snapshot', SNAPSHOT, '--expect-home', f.appHome,
      '--expect-slot', hash('2\nb@example.test'), '--expect-eff', hash('default\na@example.test'), '--expect-qualified', '--json'],
    dir: f.pack, cwd: f.root, stdin: '', appHome: f.env.HERDR_APP_HOME },
  ])
  assert.deepEqual(readFileSync(otherRecord), before)
})

test('offers expire, evict the oldest of five and are consumed even for an unoffered id', async t => {
  let clock = 0
  const f = accountsFixture(t)
  const host = accountsHost(t, f, { now: () => clock })
  const tokens = []
  for (let i = 0; i < 5; i += 1) tokens.push((await value(host)).token)
  await expectReason(host, 'changed', USE, { id: '2', token: tokens[0] })
  await expectReason(host, 'changed', USE, { id: '3', token: tokens[1] })
  await expectReason(host, 'changed', USE, { id: '2', token: tokens[1] })
  clock = 120_001
  await expectReason(host, 'changed', USE, { id: '2', token: tokens[2] })
  assert.equal(f.calls().every(call => call.argv[0] === 'here'), true)
})

test('the writer is reselected when a VERSION changes or am current is retargeted', async t => {
  const f = accountsFixture(t, { install: false })
  const base = dirname(f.am)
  const old = join(base, 'previous')
  const next = join(base, 'next')
  f.add(old)
  f.add(next, { version: '3.160.4' })
  symlinkSync(old, f.am)
  const host = accountsHost(t, f)
  const read = await value(host)
  writeFileSync(join(old, 'VERSION'), '3.160.5\n')
  await expectReason(host, 'changed', USE, { id: '2', token: read.token })
  const again = await value(host)
  unlinkSync(f.am)
  symlinkSync(next, f.am)
  await expectReason(host, 'changed', USE, { id: '2', token: again.token })
  assert.deepEqual(f.calls().map(call => [call.argv, call.dir]), [[readArgs, old], [readArgs, old]])
})

test('a read-only dispatcher redacts the team reason for marked and unmarked callers', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f, { readOnly: `Read only at ${join(f.root, CANARY)}` })
  for (const marker of [WINDOW, null]) {
    const response = await host.request(USE, { id: '2' }, { marker })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.text()
    assert.doesNotMatch(body, new RegExp(CANARY))
    assert.deepEqual(JSON.parse(body), { ok: false, error: { code: 'bot/read-only', message: 'This host can only read accounts.', details: {} } })
  }
  assert.deepEqual(f.calls(), [])
  const view = await value(host)
  assert.equal(view.readOnly, true)
  expectRowsOnly(view)
})

test('a host without team write capability publishes no offer', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  host.rt.canWriteTeam = () => false
  const view = await value(host)
  assert.equal(view.readOnly, true)
  expectRowsOnly(view)
  assert.deepEqual(f.calls().map(call => call.argv), [readArgs])
})

test('dispatcher read-only admission leaves an existing offer available', async t => {
  const f = accountsFixture(t)
  const host = accountsHost(t, f)
  const { token } = await value(host)
  host.ownership.readOnly = `Read only at ${join(f.root, CANARY)}`
  const denied = await host.request(USE, { id: '2', token })
  assert.equal(denied.status, 200)
  assert.equal(denied.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await denied.json(), { ok: false, error: {
    code: 'bot/read-only', message: 'This host can only read accounts.', details: {},
  } })
  host.ownership.readOnly = undefined
  assert.deepEqual(await value(host, USE, { id: '2', token }), { switched: true })
  assert.equal(f.calls().filter(call => call.argv[0] === 'set-login').length, 1)
})

test('ownership must survive a read and be current when a queued write reaches spawn', async t => {
  const f = accountsFixture(t)
  const readStarted = Promise.withResolvers()
  const releaseRead = Promise.withResolvers()
  const writeStarted = Promise.withResolvers()
  const releaseWrite = Promise.withResolvers()
  let holdRead = true
  const host = accountsHost(t, f, { async run(cli, args, options) {
    if (args[0] === 'here' && holdRead) {
      readStarted.resolve()
      await releaseRead.promise
    }
    if (args[0] === 'set-login') {
      writeStarted.resolve()
      await releaseWrite.promise
    }
    return runAccounts(cli, args, options)
  } })
  const reading = value(host)
  await readStarted.promise
  host.ownership.generation += 1
  holdRead = false
  releaseRead.resolve()
  const lost = await reading
  assert.equal(lost.readOnly, true)
  expectRowsOnly(lost)

  const first = await value(host)
  const second = await value(host)
  const running = value(host, USE, { id: '2', token: first.token })
  await writeStarted.promise
  const proof = windowProof(new Request('http://localhost', { headers: { 'x-automagik-window': WINDOW } }))
  const queued = host.rt.extended.endpointOf(USE).fn({ id: '2', token: second.token }, undefined, proof)
  host.ownership.generation += 1
  releaseWrite.resolve()
  assert.deepEqual(await running, { switched: true })
  assert.deepEqual(await queued, { reason: 'read-only' })
  revokeWindowProof(proof)
  await expectReason(host, 'changed', USE, { id: '2', token: second.token })
  assert.equal(f.calls().filter(call => call.argv[0] === 'set-login').length, 1)
})

test('write replies map fixed refusals, require exact success and never reuse a refused token', async t => {
  const f = accountsFixture(t)
  let shouldTimeOut = false
  const host = accountsHost(t, f, { run: runWithTimeout(() => shouldTimeOut) })
  for (const [control, reason] of [
    ...[['conflict', 'conflict'], ['slot-changed', 'conflict'], ['timeout', 'conflict'], ['update-first', 'panel-old'],
      ['busy', 'busy'], ['home', 'home-mismatch'], [CANARY, 'failed']].map(([error, reason]) => [{ exit: 1, reply: { error } }, reason]),
    [{ exit: 2 }, 'failed'], [{ reply: { ok: true, snapshot: SNAPSHOT, use: '3' } }, 'unknown'],
    [{ reply: { ok: true, snapshot: SNAPSHOT, use: '2', extra: true } }, 'unknown'],
    [{ text: '{' }, 'unknown'], [{ text: ' '.repeat(65_537) }, 'unknown'], [{ delay: 10_000 }, 'unknown'],
  ]) {
    f.respond({ write: control })
    shouldTimeOut = false
    const { token } = await value(host)
    shouldTimeOut = Boolean(control.delay)
    await expectReason(host, reason, USE, { id: '2', token })
    await expectReason(host, 'changed', USE, { id: '2', token })
  }
  assert.equal(f.calls().filter(call => call.argv[0] === 'set-login').length, 13)
})

test('an unknown write invalidates outstanding offers and reads already in flight', async t => {
  const f = accountsFixture(t)
  const readStarted = Promise.withResolvers()
  const releaseRead = Promise.withResolvers()
  let holdRead = false
  const host = accountsHost(t, f, { async run(cli, args, options) {
    if (args[0] === 'here' && holdRead) {
      readStarted.resolve()
      await releaseRead.promise
    }
    return runAccounts(cli, args, options)
  } })
  const first = await value(host)
  const second = await value(host)
  holdRead = true
  const pending = value(host)
  await readStarted.promise
  f.respond({ write: { text: '{' } })
  await expectReason(host, 'unknown', USE, { id: '2', token: first.token })
  await expectReason(host, 'changed', USE, { id: '2', token: second.token })
  releaseRead.resolve()
  expectRowsOnly(await pending)
  assert.ok((await value(host)).token)
})

test('child stderr, argv and thrown errors never reach replies, runtime diagnostics or the console', async t => {
  const f = accountsFixture(t, { install: false })
  const cliPath = join(f.root, CANARY)
  f.add(cliPath)
  f.env.AUTOMAGIK_AM_DIR = cliPath
  f.respond({ here: { exit: 1, stderr: CANARY }, write: { exit: 1, reply: { error: CANARY }, stderr: CANARY } })
  let throwChildError = false
  const host = accountsHost(t, f, { async run(cli, args, options) {
    if (throwChildError && args[0] === 'set-login') {
      throw Object.assign(new Error(CANARY), { stderr: CANARY, cmd: join(cli.dir, 'bin/accounts.mjs') })
    }
    return runAccounts(cli, args, options)
  } })
  const calls = ['error', 'warn', 'log', 'info', 'debug'].map(method => t.mock.method(console, method, () => {}))
  await expectReason(host, 'cli-error')
  f.respond({ write: { exit: 1, reply: { error: CANARY }, stderr: CANARY } })
  const first = await value(host)
  await expectReason(host, 'failed', USE, { id: '2', token: first.token })
  const second = await value(host)
  throwChildError = true
  await expectReason(host, 'unknown', USE, { id: '2', token: second.token })
  assert.ok(f.calls().every(call => call.dir.includes(CANARY)))
  assert.deepEqual(host.diagnostics, [])
  assert.ok(calls.every(call => call.mock.callCount() === 0))
})
