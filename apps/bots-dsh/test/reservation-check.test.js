import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { reservationDigests } from '../../acp-dsh/src/host/reservation-evidence.js'
import * as diagnostics from '../src/host/diagnostics.js'
import { createImageGen, install as installImageGen } from '../src/host/imagegen.js'
import { createMachineRecord } from '../src/host/machine-reservations.js'
import { install } from '../src/host/model-access-hooks.js'
import { MODEL_ACCESS_REQUIRED } from '../src/host/model-state.js'
import { turnFailure } from '../src/host/turns.js'
import { fill, MACHINE_MESSAGES as messages } from '../src/shared/machine-reservations.js'
import {
  CLAUDE, CLAUDE_ACCOUNT, CODEX, CODEX_ACCOUNT, reservationAcp,
} from './fixtures/account-reservations.js'

const label = 'Reserved project'
const refusal = fill(messages.refused, { label })
const tick = () => new Promise(resolve => setImmediate(resolve))
const fault = code => Object.assign(new Error(code), { code })
const stream = async function* () { yield { type: 'answer' } }
const answered = [{ type: 'answer' }]
const finish = message => [{
  type: 'finish', reason: { kind: 'error', failure: { code: MODEL_ACCESS_REQUIRED, message } },
}]
const signOuts = h => h.calls.filter(([method]) => method === 'signout')
const reads = (h, id = CLAUDE) => h.calls.filter(([method, provider]) =>
  method === 'evidence' && provider === id).length

function fixture(t, {
  authScope = 'consent', evidenceVersion = 2, outcome, platform = process.platform,
  agents, inject = false, ring = {}, absent = false, instance = 'ours', evidenceTimeoutMs,
} = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'automagik-reservation-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'records')
  const keyPath = join(dir, 'key')
  const key = Buffer.alloc(32, 99)
  function setup() {
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o3770)
    fs.writeFileSync(keyPath, key)
    fs.chmodSync(keyPath, 0o640)
  }
  if (!absent) setup()
  let defer
  const fake = reservationAcp({
    authScope, evidenceVersion, outcome, deferred: id => defer?.(id),
  })
  if (evidenceVersion !== 2 && authScope === 'isolated') {
    const read = fake.service.accountEvidence
    fake.service.accountEvidence = async (id, options) => ({
      ...await read(id, options), authScope,
    })
  }
  const machine = createMachineRecord({
    fs: { ...fs, ...ring }, dir: () => dir, platform, uid: () => process.getuid(), pid: process.pid,
    random: (size, format) => randomBytes(size).toString(format),
    now: Date.now, wait() {}, userName: () => 'fixture-user',
  })
  const handlers = new Map()
  const registered = []
  const warns = []
  const bots = new Set(['S1', 'S2', 'S3'])
  let start, dispose, effect
  const services = { acpAgents: fake.service, agents }
  const rt = {
    ctx: {
      get: name => services[name],
      on(name, handler) { registered.push(name); handlers.set(name, handler) },
      ...(inject ? { inject(names, attach) {
        registered.push(names)
        start = () => attach({ effect(setup, label) { effect = label; dispose = setup() } })
      } } : {}),
    },
    isBotSession: id => bots.has(id),
    modelAccess: async () => ({ ready: true }),
    warn: (...args) => warns.push(args),
  }
  install(rt, { machine, instanceId: () => instance, evidenceTimeoutMs })
  const check = rt.machineReservations
  const event = (name, ...args) => handlers.get(name)(...args)
  const options = (provider, sessionId, messages) => ({
    provider, model: 'default', sessionId, messages: messages ?? [{ role: 'user' }],
  })
  const run = async (provider, id, next = stream, messages) => {
    const collected = []
    for await (const value of event('llm/stream', options(provider, id, messages), next)) {
      collected.push(value)
    }
    return collected
  }
  const reserve = (provider = CLAUDE, changes = {}) => {
    const vendor = provider === CODEX ? 'codex' : 'claude'
    const identity = vendor === 'codex'
      ? { person: true, vendor, class: 'personal', email: CODEX_ACCOUNT.email }
      : { person: true, vendor, org: CLAUDE_ACCOUNT.org, email: CLAUDE_ACCOUNT.email }
    Object.assign(identity, changes.identity)
    const digests = reservationDigests(identity, key)
    const input = { vendor, ...digests, instance: 'theirs', label, ...changes.record }
    if (vendor === 'codex') input.class = identity.class
    const path = join(dir, `${vendor}-${digests.exact}.json`)
    return { result: machine.reserve(machine.open(), input), path, digests }
  }
  return {
    ...fake, rt, root, dir, key, keyPath, machine, check, reserve, setup, registered, warns, bots,
    event, options, run, services, idle: check.idle, setDeferred: fn => { defer = fn },
    start: () => start?.(), dispose: () => dispose?.(), effect: () => effect,
    end: id => event('session/event', { id }, { type: 'turn/end' }),
  }
}

test('B1 both vendors and account scopes allow shared accounts at every trigger', async t => {
  for (const authScope of ['consent', 'isolated']) {
    const h = fixture(t, { authScope })
    await h.idle()
    for (const provider of [CLAUDE, CODEX]) {
      assert.equal(h.check.status(provider).state, 'shared')
      h.event('acp-dsh/login-ready', { id: provider })
      h.event('session/created', { id: 'S1', requestHeader: () => ({ config: { provider } }) })
      await h.check.fresh(provider, 'card')
      assert.deepEqual(await h.run(provider, 'S1'), answered)
      h.end('S1')
    }
    await h.idle()
    assert.deepEqual(signOuts(h), [])
  }
})

test('B2 isolated refusal confirms then signs out with guarded evidence and keeps N7', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  h.calls.length = 0
  const { digests } = h.reserve()
  h.event('acp-dsh/login-ready', { id: CLAUDE })
  await h.idle()
  assert.equal(reads(h), 3)
  const [[, id, { expect }]] = signOuts(h)
  assert.equal(id, CLAUDE)
  assert.deepEqual(Buffer.from(expect.key), h.key)
  assert.equal(typeof expect.recheck, 'function')
  assert.deepEqual({ exact: expect.exact, loose: expect.loose }, digests)
  assert.deepEqual(await h.run(CLAUDE, 'S1', () => assert.fail('dispatch')), finish(refusal))
  await h.check.fresh(CLAUDE, 'card')
  assert.deepEqual(h.check.status(CLAUDE), {
    state: 'refused', label, signedOut: true, owner: 'fixture-user',
  })
  assert.equal(signOuts(h).length, 1)
})

test('B3/B7 consent confirms while older ACP only refuses', async t => {
  for (const opts of [{}, { authScope: 'isolated', evidenceVersion: 1 }]) {
    const h = fixture(t, opts)
    await h.idle()
    h.calls.length = 0
    for (const method of ['accountSwitch', 'accountReset', 'accountConfirm', 'terminalAccount']) {
      h.service[method] = () => assert.fail(method)
    }
    h.reserve()
    assert.deepEqual(await h.run(CLAUDE, 'S1', () => assert.fail('dispatch')), finish(refusal))
    await h.idle()
    assert.equal(reads(h), 2)
    assert.deepEqual(signOuts(h), [])
  }
})

test('B4 continuations and steering pass until another turn finds the file', async t => {
  const h = fixture(t)
  await h.idle()
  assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
  h.reserve()
  assert.deepEqual(await h.run(CLAUDE, 'S1', stream, [{ role: 'tool' }]), answered)
  assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
  h.end('S1')
  assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
  h.end('S1')
  assert.deepEqual(await h.run(CLAUDE, 'S2'), finish(refusal))
  assert.deepEqual(await h.run(CLAUDE, 'S1'), finish(refusal))
  h.check.started()
  await h.idle()
  assert.equal(h.check.held(CLAUDE), refusal)
})

test('B5 an admitted turn and image work both delay an isolated sign-out', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
  const done = h.check.workStarted(CLAUDE)
  h.reserve()
  assert.deepEqual(await h.run(CLAUDE, 'S2'), finish(refusal))
  await h.idle()
  assert.equal(signOuts(h).length, 0)
  assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
  h.end('S1')
  await h.idle()
  assert.equal(signOuts(h).length, 0)
  done()
  done()
  await h.idle()
  assert.equal(signOuts(h).length, 1)
})

test('B6 queued sign-out reacts to removal, changed account, busy and disposal', async t => {
  for (const mode of ['removed', 'account', 'guard changed', 'busy', 'disposed']) {
    const h = fixture(t, { authScope: 'isolated', inject: true })
    h.start()
    await h.idle()
    const done = h.check.workStarted(CLAUDE)
    const { path } = h.reserve()
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.held(CLAUDE), refusal)
    if (mode === 'removed') fs.unlinkSync(path)
    if (mode === 'account') h.accounts[CLAUDE].org = 'other organisation'
    if (mode === 'disposed') h.dispose()
    const logout = h.service.accountSignOut
    if (mode === 'busy' || mode === 'guard changed') {
      h.service.accountSignOut = async (...args) => {
        h.service.accountSignOut = logout
        if (mode === 'guard changed') fs.unlinkSync(path)
        assert.equal(args[1].expect.recheck(), mode === 'busy')
        throw fault(`acp-account/${mode === 'busy' ? 'busy' : 'changed'}`)
      }
    }
    done()
    await h.idle()
    assert.equal(signOuts(h).length, 0, mode)
    if (mode === 'busy') {
      h.end('S3')
      await h.idle()
      assert.equal(signOuts(h).length, 1)
    } else if (mode !== 'disposed') {
      assert.equal(h.check.held(CLAUDE), undefined)
      assert.equal(h.check.status(CLAUDE).state, 'shared')
    }
  }
})

test('B8 own records allow and a missing instance id treats every match as foreign', async t => {
  for (const [instance, outcome] of [['ours', 'complete'], ['', 'complete'], ['', 'ambiguous']]) {
    const h = fixture(t, { instance, outcome: () => outcome })
    h.reserve(CLAUDE, { record: { instance: 'ours' } })
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.status(CLAUDE).state, instance ? 'mine'
      : outcome === 'complete' ? 'refused' : 'ambiguous')
    assert.equal(Boolean(h.check.held(CLAUDE)), !instance)
    await h.idle()
  }
})

test('B9 ambiguous scans pick foreign matches in either order', async t => {
  for (const reverse of [false, true]) {
    let outcome = 'ambiguous'
    const h = fixture(t, { outcome: () => outcome, ring: {
      readdirSync(path) {
        const names = fs.readdirSync(path)
        return reverse ? names.reverse() : names
      },
    } })
    const own = h.reserve(CLAUDE, { record: { instance: 'ours' } })
    const foreign = h.reserve(CLAUDE, { identity: { org: 'foreign' } })
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.held(CLAUDE), fill(messages['no-organisation'], { label }))
    fs.unlinkSync(foreign.path)
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.status(CLAUDE).state, 'mine')
    fs.unlinkSync(own.path)
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.status(CLAUDE).state, 'shared')
    h.reserve(CLAUDE, { identity: { org: 'different' } })
    outcome = 'complete'
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.status(CLAUDE).state, 'shared')
    outcome = 'ambiguous'
    for (const plan of ['personal', 'workspace']) {
      const { path } = h.reserve(CODEX, { identity: { class: plan } })
      await h.check.fresh(CODEX)
      assert.equal(h.check.held(CODEX), fill(messages['unknown-plan'], { label }))
      fs.unlinkSync(path)
    }
  }
})

test('B10 setup notices allow without evidence and warn once per transition', async t => {
  let inaccessible = false
  const h = fixture(t, { absent: true, ring: {
    accessSync(...args) {
      if (inaccessible) throw fault('EACCES')
      fs.accessSync(...args)
    },
  } })
  const check = async notice => {
    await h.check.fresh(CLAUDE)
    assert.deepEqual(h.check.status(CLAUDE), { state: 'notice', notice })
    assert.equal(h.check.held(CLAUDE), undefined)
    assert.equal(reads(h), 0)
  }
  await check('absent')
  const n = h.warns.length
  await check('absent')
  assert.equal(h.warns.length, n)
  h.setup()
  inaccessible = true
  await check('unreadable')
  inaccessible = false
  fs.unlinkSync(h.keyPath)
  await check('no-key')
  fs.writeFileSync(h.keyPath, 'short', { mode: 0o640 })
  await check('bad-key')
  fs.chmodSync(h.dir, 0o700)
  await check('not-set-up')
  assert.doesNotMatch(JSON.stringify(h.warns), /Reserved project|cccccc/)
  const win = fixture(t, { platform: 'win32' })
  await win.idle()
  assert.deepEqual(win.check.status(CLAUDE), { state: 'notice', notice: 'unsupported' })
  assert.equal(reads(win), 0)
})

test('B11 exact EACCES refuses while a failure to reach or scan the folder allows', async t => {
  let noFile = false, noFolder = false, noScan = false, outcome = 'complete'
  const h = fixture(t, { authScope: 'isolated', outcome: () => outcome, ring: {
    openSync(path, ...args) {
      if (noFile && path.endsWith('.json')) throw fault('EACCES')
      return fs.openSync(path, ...args)
    },
    accessSync(...args) {
      if (noFolder) throw fault('EACCES')
      fs.accessSync(...args)
    },
    readdirSync(...args) {
      if (noScan) throw fault('EACCES')
      return fs.readdirSync(...args)
    },
  } })
  await h.idle()
  h.reserve()
  noFile = true
  await h.check.fresh(CLAUDE)
  assert.equal(h.check.held(CLAUDE), messages['unreadable-file'])
  await h.idle()
  assert.equal(signOuts(h).length, 1)
  h.accounts[CLAUDE] = { ...CLAUDE_ACCOUNT }
  noFolder = true
  await h.check.fresh(CLAUDE)
  assert.deepEqual(h.check.status(CLAUDE), { state: 'notice', notice: 'unreadable' })
  assert.equal(h.check.held(CLAUDE), undefined)
  noFolder = noFile = false
  noScan = true
  outcome = 'ambiguous'
  await h.check.fresh(CLAUDE)
  assert.deepEqual(h.check.status(CLAUDE), { state: 'notice', notice: 'unreadable' })
})

test('B12 malformed, oversized, future-version and symlink exact records refuse', async t => {
  let outcome = 'complete'
  const h = fixture(t, { outcome: () => outcome })
  const { path } = h.reserve()
  for (const data of ['{', Buffer.alloc(70 * 1024), '{"version":2}']) {
    fs.writeFileSync(path, data)
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.held(CLAUDE), messages['unreadable-file'])
  }
  outcome = 'ambiguous'
  await h.check.fresh(CLAUDE)
  assert.equal(h.check.status(CLAUDE).state, 'shared')
  outcome = 'complete'
  fs.unlinkSync(path)
  fs.symlinkSync(h.keyPath, path)
  await h.check.fresh(CLAUDE)
  assert.equal(h.check.held(CLAUDE), messages['unreadable-file'])
})

test('B12 a nonblocking exact read refuses a FIFO', async t => {
  const h = fixture(t)
  const { path } = h.reserve()
  fs.unlinkSync(path)
  execFileSync('mkfifo', [path], { stdio: 'inherit' })
  await h.check.fresh(CLAUDE)
  assert.equal(h.check.held(CLAUDE), messages['unreadable-file'])
})

test('B13 unreadable or non-subscription evidence passes, including a timeout', async t => {
  const h = fixture(t, { evidenceTimeoutMs: 20 })
  await h.idle()
  const cases = [
    () => ({ id: CLAUDE, signedIn: true, outcome: 'none' }),
    () => ({ id: CLAUDE, signedIn: true, outcome: 'unread' }),
    () => ({ id: CLAUDE, signedIn: false }),
    () => ({ id: CLAUDE, supported: false }),
    () => { throw fault('unreadable') },
    () => delay(60),
  ]
  h.reserve()
  for (const read of cases) {
    h.service.accountEvidence = read
    await h.check.fresh(CLAUDE)
    assert.equal(h.check.status(CLAUDE).state, 'open')
    assert.equal(h.check.held(CLAUDE), undefined)
  }
})

test('B14 three changed reads are stale and cannot erase a standing refusal', async t => {
  let outcome = 'changed'
  const h = fixture(t, { outcome: () => outcome })
  await h.idle()
  assert.equal(h.check.status(CLAUDE).state, 'unread')
  assert.equal(reads(h), 3)
  h.reserve()
  outcome = 'complete'
  assert.deepEqual(await h.run(CLAUDE, 'S1'), finish(refusal))
  outcome = 'changed'
  await h.check.fresh(CLAUDE)
  assert.equal(h.check.held(CLAUDE), refusal)
  assert.deepEqual(await h.run(CLAUDE, 'S1'), finish(refusal))
  assert.equal(reads(h), 11)
})

test('B14 a confirming account switch recomputes and never refuses a shared account', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  h.reserve()
  h.setDeferred(id => { if (id === CLAUDE) h.accounts[CLAUDE].org = 'other organisation' })
  await h.check.fresh(CLAUDE)
  assert.equal(h.check.status(CLAUDE).state, 'shared')
  assert.deepEqual(signOuts(h), [])
})

test('B15 an older generation is discarded and gate and images await sign-in evidence', async t => {
  const h = fixture(t, { inject: true })
  const readEntered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  let hold = true
  h.setDeferred(id => {
    if (id !== CLAUDE || !hold) return
    hold = false
    readEntered.resolve()
    return resume.promise
  })
  h.start()
  await readEntered.promise
  h.accounts[CLAUDE] = { ...CLAUDE_ACCOUNT, org: 'new organisation' }
  h.reserve(CLAUDE, { identity: { org: 'new organisation' } })
  h.event('acp-dsh/login-ready', { id: CLAUDE })
  const image = h.check.imageGate(CLAUDE)
  const gate = h.run(CLAUDE, 'S1')
  assert.equal(h.check.status(CLAUDE).state, 'unknown')
  resume.resolve()
  assert.equal(await image, refusal)
  assert.deepEqual(await gate, finish(refusal))
})

test('B16/B17 registration order and direct next on ordinary calls or continuations', async t => {
  const h = fixture(t, { inject: true, authScope: 'isolated' })
  assert.deepEqual(h.registered, [
    'llm/stream', 'acp-dsh/login-ready', 'session/event', 'session/disposed', 'session/created',
    ['acpAgents'],
  ])
  const marker = Symbol('next')
  const next = () => marker
  for (const options of [h.options(CLAUDE, 'ordinary'),
    h.options(CLAUDE, 'S1', [{ role: 'assistant' }])]) {
    assert.equal(h.event('llm/stream', options, next), marker)
    h.event('session/disposed', { id: options.sessionId })
  }
  const registered = []
  install({ ctx: { on: name => registered.push(name) } })
  assert.deepEqual(registered, ['llm/stream'])
  const done = h.check.workStarted(CLAUDE)
  h.reserve()
  h.start()
  await h.idle()
  assert.equal(h.effect(), 'ds-bot: reservation check')
  assert.equal(reads(h), 2)
  assert.equal(reads(h, CODEX), 1)
  h.dispose()
  done()
  await h.idle()
  assert.deepEqual(signOuts(h), [])
})

test('B18 a Codex reservation skips both subscription image sources and preserves N7', async t => {
  const h = fixture(t)
  h.reserve(CODEX)
  const images = createImageGen({
    credentials: () => ({}), reservation: () => h.check,
    codex: () => assert.fail('reserved Codex was queried'),
  })
  assert.equal(await images.source(), undefined)
  await assert.rejects(images.generate({ prompt: 'draw' }), {
    message: `Codex cannot draw here: ${refusal}`,
  })
  await assert.rejects(images.generate({ prompt: 'edit', input: {} }), {
    message: `Codex cannot edit the picture here: ${refusal}`,
  })
})

test('B19 production reservation helpers do not spawn or invoke the administrator script', () => {
  const src = new URL('../src/', import.meta.url)
  const helpers = [
    ['host/machine-reservations.js', ['../shared/account-reservations.js']],
    ['host/reservation-check.js', [
      'node:crypto', '../shared/account-reservations.js', '../shared/machine-reservations.js',
    ]],
    ['shared/machine-reservations.js', []],
  ]
  for (const [file, imports] of helpers) {
    const text = fs.readFileSync(new URL(file, src), 'utf8')
    assert.deepEqual([...text.matchAll(/ from '([^']+)'/g)].map(match => match[1]), imports)
  }
  for (const file of ['../index.js', ...fs.readdirSync(src, { recursive: true })]) {
    if (!/\.[cm]?js$/.test(file)) continue
    assert.doesNotMatch(fs.readFileSync(new URL(file, src), 'utf8'), /reservations-setup/)
  }
})

test('B20 turn diagnostics keep the refusal sentence and omit account evidence', async t => {
  const h = fixture(t)
  const { digests } = h.reserve()
  const [event] = await h.run(CLAUDE, 'S1')
  const failure = turnFailure(event.reason.failure)
  const rt = { ctx: { effect() {} }, home: h.root, config: { diagnosticsFile: false } }
  diagnostics.install(rt)
  const entry = rt.noteFailure({ source: 'turn', code: failure.code, text: failure.message })
  assert.equal(entry.text, refusal)
  const shown = JSON.stringify({ entry, warns: h.warns, status: h.check.status(CLAUDE) })
  for (const value of [
    ...Object.values(digests), h.key.toString('hex'), h.key.toString('base64'),
    CLAUDE_ACCOUNT.email, CLAUDE_ACCOUNT.org, CLAUDE_ACCOUNT.token,
  ]) assert.equal(shown.includes(value), false)
})

test('B21 a refusal during model access stops dispatch before sign-out', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  const entered = Promise.withResolvers()
  const model = Promise.withResolvers()
  h.rt.modelAccess = () => { entered.resolve(); return model.promise }
  const turn = h.run(CLAUDE, 'S1', () => assert.fail('dispatch'))
  await entered.promise
  h.reserve()
  await h.check.fresh(CLAUDE)
  await h.idle()
  assert.deepEqual(signOuts(h), [])
  model.resolve({ ready: true })
  assert.deepEqual(await turn, finish(refusal))
  await h.idle()
  assert.equal(signOuts(h).length, 1)
})

test('B22 guarded recheck refuses logout if work was admitted during the ACP read', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  h.reserve()
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const logout = h.service.accountSignOut
  h.service.accountSignOut = async (...args) => {
    h.service.accountSignOut = logout
    entered.resolve()
    await resume.promise
    assert.equal(args[1].expect.recheck(), false)
    throw fault('acp-account/changed')
  }
  await h.check.fresh(CLAUDE)
  await entered.promise
  h.check.admitted('S1', CLAUDE)
  resume.resolve()
  await h.idle()
  assert.deepEqual(signOuts(h), [])
  h.end('S1')
  await h.idle()
  assert.equal(signOuts(h).length, 1)
})

test('B23 a running turn adopted at start holds either provider until turn/end', async t => {
  const h = fixture(t, { authScope: 'isolated', inject: true, agents: {
    list: () => [{ status: 'running', session: { id: 'adopted' } }],
  } })
  h.reserve()
  h.start()
  await h.idle()
  assert.equal(h.check.held(CLAUDE), refusal)
  assert.deepEqual(signOuts(h), [])
  h.end('adopted')
  await h.idle()
  assert.equal(signOuts(h).length, 1)
})

test('B24 image work is held from entry and checks late refusals', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  const credentials = Promise.withResolvers()
  const access = Promise.withResolvers()
  const entered = Promise.withResolvers()
  Object.assign(h.service, {
    imageAccess: () => { entered.resolve(); return access.promise },
    generateImage: () => assert.fail('reserved draw'),
  })
  const images = createImageGen({
    credentials: () => ({ readRecord: () => credentials.promise }),
    codex: () => h.service, reservation: () => h.check,
  })
  const drawing = images.generate({ prompt: 'draw' })
  await tick()
  credentials.resolve(undefined)
  await entered.promise
  h.reserve(CODEX)
  await h.check.fresh(CODEX)
  await h.idle()
  assert.deepEqual(signOuts(h), [])
  access.resolve({ ready: true })
  await assert.rejects(drawing, { message: `Codex cannot draw here: ${refusal}` })
  await h.idle()
  assert.equal(signOuts(h).length, 1)
})

test('B24 a draw holds work while its first credentials read is pending', async t => {
  const h = fixture(t, { authScope: 'isolated' })
  await h.idle()
  const credentials = Promise.withResolvers()
  const images = createImageGen({
    credentials: () => ({ readRecord: () => credentials.promise }),
    codex: () => assert.fail('Codex was queried despite its reservation'),
    reservation: () => h.check,
  })
  const drawing = images.generate({ prompt: 'draw' })
  h.reserve(CODEX)
  await h.check.fresh(CODEX)
  await h.idle()
  assert.deepEqual(signOuts(h), [])
  credentials.resolve(undefined)
  await assert.rejects(drawing, { message: `Codex cannot draw here: ${refusal}` })
  await h.idle()
  assert.equal(signOuts(h).length, 1)
})

test('B24 the registered edit tool returns the reservation refusal', async t => {
  const h = fixture(t)
  h.reserve(CODEX)
  Object.assign(h.service, {
    imageAccess: () => assert.fail('reserved edit'), generateImage: () => assert.fail('draw'),
  })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4'
    + '2mP8/x8AAwMB/6X+6FsAAAAASUVORK5CYII=', 'base64')
  const ref = {
    attachmentId: `sha256:${'a'.repeat(64)}`, name: 'picture.png',
    mediaType: 'image/png', bytes: png.length, width: 1, height: 1,
  }
  h.services.attachments = { readImage: async () => ({ ref, data: png }) }
  Object.assign(h.rt, {
    teamTools: [], teamFolder: () => h.root, botOfSession: () => ({ id: 'bot' }),
    roomOf: () => undefined, partsOf: () => [{ sessionId: 'chat' }],
    async *eventsBackwards() {
      yield { type: 'user/message', data: {
        source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }],
      } }
    },
  })
  installImageGen(h.rt)
  const tool = h.rt.teamTools.find(value => value.name === 'generate_image')
  const answer = await tool.execute({ prompt: 'edit', image: 'picture.png' }, {
    agent: { id: 'chat' }, callId: 'edit',
  })
  assert.equal(answer, `Codex cannot edit the picture here: ${refusal}`)
  assert.doesNotMatch(answer, /locked image run/)
})

test('B25 session creation reads only Bot headers on supported providers', async t => {
  const h = fixture(t)
  await h.idle()
  h.calls.length = 0
  const requestHeader = () => ({ config: { provider: CLAUDE } })
  h.event('session/created', { id: 'S1', requestHeader })
  await h.idle()
  assert.equal(reads(h), 1)
  assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
  assert.equal(reads(h), 1)
  h.event('session/created', { id: 'late', requestHeader })
  h.event('session/created', { id: 'S2', requestHeader: () => { throw fault('header') } })
  await h.idle()
  assert.equal(reads(h), 1)
  h.bots.add('late')
  assert.deepEqual(await h.run(CLAUDE, 'late'), answered)
  assert.equal(reads(h), 2)
})

test('B26 card requests queued behind a pending read share one later observation', async t => {
  const h = fixture(t)
  await h.idle()
  for (const n of [1, 3]) {
    h.calls.length = 0
    const resume = Promise.withResolvers()
    h.setDeferred(id => id === CLAUDE && reads(h) === 1 ? resume.promise : undefined)
    const first = h.check.fresh(CLAUDE)
    await tick()
    const card = Promise.all(Array.from({ length: n }, () => h.check.fresh(CLAUDE, 'card')))
    assert.equal(reads(h), 1)
    resume.resolve()
    await first
    await card
    assert.equal(reads(h), 2)
  }
})

test('B27 the card keeps N7 for logout and drops it for a notice or shared sign-in',
  async t => {
    for (const mode of ['shared', 'notice']) {
      const h = fixture(t, { authScope: 'isolated' })
      const { path } = h.reserve()
      await h.idle()
      await h.check.fresh(CLAUDE)
      assert.equal(h.check.status(CLAUDE).signedOut, true)
      assert.equal(h.check.held(CLAUDE), refusal)
      if (mode === 'shared') {
        fs.unlinkSync(path)
        h.accounts[CLAUDE] = { ...CLAUDE_ACCOUNT }
      } else fs.rmSync(h.dir, { recursive: true })
      await h.check.fresh(CLAUDE)
      assert.equal(h.check.status(CLAUDE).state, mode)
      assert.equal(h.check.status(CLAUDE).signedOut, undefined)
      assert.deepEqual(await h.run(CLAUDE, 'S1'), answered)
    }
  })

test('B28 decision reopens the folder and key after a deferred evidence read', async t => {
  for (const mode of ['folder', 'key']) {
    let inaccessible = false
    const h = fixture(t, { ring: {
      accessSync(path, flags) {
        if (inaccessible) throw fault('EACCES')
        return fs.accessSync(path, flags)
      },
    } })
    await h.idle()
    const { path } = h.reserve()
    const entered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    h.setDeferred(() => { entered.resolve(); return resume.promise })
    const reading = h.check.fresh(CLAUDE)
    await entered.promise
    assert.ok(fs.statSync(path).isFile())
    if (mode === 'folder') inaccessible = true
    else fs.writeFileSync(h.keyPath, Buffer.alloc(32, 3))
    resume.resolve()
    await reading
    assert.equal(h.check.held(CLAUDE), undefined)
    assert.deepEqual(h.check.status(CLAUDE), mode === 'folder'
      ? { state: 'notice', notice: 'unreadable' } : { state: 'unread' })
  }
})
