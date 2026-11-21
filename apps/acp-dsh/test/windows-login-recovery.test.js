import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { CliHomes } from '../src/host/cli-homes.js'
import { windowsLoginEnded } from '../src/host/windows-job-probe.js'
import { windowsJobName } from '../src/host/windows-login.js'
import { exitedPid, plantWindowsRecord, proved, windowsBirth } from './support/windows-record.js'

const vendor = 'claude'
const write = (file, data) => writeFileSync(file, JSON.stringify(data))
const read = file => readFileSync(file, 'utf8')
const pass = (home, root) => ({ home, pointer: read(join(root, 'current', vendor)) })

function fixture(t, probe = proved) {
  const root = mkdtempSync(join(tmpdir(), 'win-recover-'))
  const generation = randomUUID()
  const pointer = join(root, 'current', vendor)
  mkdirSync(dirname(pointer))
  writeFileSync(pointer, generation)
  const calls = []
  const homes = new CliHomes(root, { probe: (input, options) => {
    calls.push(input)
    return probe(input, options)
  } })
  const home = homes.home(vendor)
  t.after(() => {
    homes.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, homes, home, pointer, calls, plant: options => plantWindowsRecord(root, home, options) }
}

test('a dead app, a dead supervisor, dead members and an absent named Job reclaim the record without Reset', async t => {
  const h = fixture(t)
  const p = h.plant({ changing: true })
  const before = pass(h.home, h.root)
  assert.equal(await h.homes.recoverLogins(vendor), true)
  assert.equal(existsSync(p.file), false)
  assert.equal(existsSync(p.control), false)
  assert.equal(existsSync(join(h.home, 'changing')), false)
  assert.equal(h.homes.paused(vendor), true)
  assert.deepEqual(pass(h.homes.home(vendor), h.root), before)
  assert.deepEqual(h.calls, [{ job: p.job, processes: [{ pid: p.app, start: windowsBirth.start },
    { pid: p.identity.pid, start: p.identity.start }, ...p.members.processes] }])
  h.homes.begin(vendor)
  h.homes.end(vendor)
})

const blockers = ['job-present', 'job-unknown-5', 'job-unknown-6', 'job-unknown-3',
  'app-live', 'app-unknown', 'supervisor-live', 'supervisor-unknown',
  'member-live', 'member-unknown', 'probe-throws', 'probe-unknown-all']

for (const blocker of blockers) {
  test(`${blocker} keeps the record blocked and Reset available`, async t => {
    const h = fixture(t, request => {
      const result = proved(request)
      const [name, state, code] = blocker.split('-')
      if (name === 'job') return { ...result, job: state, code: Number(code ?? 0) }
      if (state === 'throws') throw new Error('probe failed')
      if (name === 'probe') return { job: 'unknown', code: null, processes: result.processes.map(() => 'unknown') }
      result.processes[['app', 'supervisor', 'member'].indexOf(name)] = state
      return result
    })
    const p = h.plant()
    const before = read(p.file)
    assert.equal(await h.homes.recoverLogins(vendor), false)
    assert.equal(h.calls.length, 1)
    assert.equal(read(p.file), before)
    assert.throws(() => h.homes.begin(vendor), { code: 'acp-account/unverified-login' })
    assert.equal(h.homes.recovery(vendor), true)
    assert.notEqual(h.homes.reset(vendor), h.home)
    assert.equal(read(p.file), before)
  })
}

const defects = ['starting-only', 'legacy-v1-nonce', 'missing-job', 'local-prefix-job',
  'job-of-another-id', 'padded-job', 'damaged-json', 'non-object', 'owner-pid-mismatch',
  'same-pid-no-birth', 'next-without-base', 'next-over-windows-base', 'next-other-owner',
  'next-other-app', 'next-other-appBirth', 'next-other-job', 'next-extra-key',
  'missing-control', 'control-symlink', 'damaged-supervisor-identity',
  'supervisor-identity-of-another-launch', 'damaged-members', 'members-overflow',
  'members-of-another-launch', 'base-name-not-uuid']

for (const defect of defects) {
  test(`${defect} stays blocked and is never probed`, async t => {
    const h = fixture(t)
    const p = h.plant(defect === 'same-pid-no-birth' ? { ownPid: true, appBirth: null } : {})
    const { supervisor, job, ...base } = p.record
    const starting = { ...base, job, kind: 'starting' }
    const next = `${p.file}.next`
    const identity = join(p.control, 'supervisor')
    const members = join(p.control, 'members')
    switch (defect) {
    case 'starting-only': write(p.file, starting); break
    case 'legacy-v1-nonce': write(p.file, { ...base, supervisor, directory: 'old', nonce: randomUUID() }); break
    case 'missing-job': write(p.file, { ...base, supervisor }); break
    case 'local-prefix-job': write(p.file, { ...p.record, job: job.replace('Global', 'Local') }); break
    case 'job-of-another-id': write(p.file, { ...p.record, job: windowsJobName(randomUUID()) }); break
    case 'padded-job': write(p.file, { ...p.record, job: `${job} ` }); break
    case 'damaged-json': writeFileSync(p.file, '{'); break
    case 'non-object': write(p.file, null); break
    case 'owner-pid-mismatch': write(p.file, { ...p.record, owner: `1-${p.id}` }); break
    case 'next-without-base': renameSync(p.file, next); break
    case 'next-over-windows-base': write(next, p.record); break
    case 'next-other-owner': write(p.file, starting); write(next, { ...p.record, owner: `${p.app}-${randomUUID()}` }); break
    case 'next-other-app': write(p.file, starting); write(next, { ...p.record, app: p.app + 1 }); break
    case 'next-other-appBirth': write(p.file, starting); write(next, { ...p.record, appBirth: null }); break
    case 'next-other-job': write(p.file, starting); write(next, { ...p.record, job: windowsJobName(randomUUID()) }); break
    case 'next-extra-key': write(p.file, starting); write(next, { ...p.record, nonce: randomUUID() }); break
    case 'missing-control': rmSync(p.control, { recursive: true }); break
    case 'control-symlink': {
      const link = join(h.root, 'redirected')
      renameSync(p.control, link)
      symlinkSync(link, p.control, 'junction')
      break
    }
    case 'damaged-supervisor-identity': writeFileSync(identity, '{'); break
    case 'supervisor-identity-of-another-launch': write(identity, { ...p.identity, launch: randomUUID() }); break
    case 'damaged-members': write(members, { ...p.members, processes: [{ pid: 42, start: 'bad' }] }); break
    case 'members-overflow': write(members, { launch: p.id, overflow: true }); break
    case 'members-of-another-launch': write(members, { ...p.members, launch: randomUUID() }); break
    case 'base-name-not-uuid': renameSync(p.file, join(dirname(p.file), 'invalid')); break
    }
    const dir = dirname(p.file)
    const bytes = () => readdirSync(dir).map(name => [name, read(join(dir, name))])
    const before = bytes()
    assert.equal(await h.homes.recoverLogins(vendor), false)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(bytes(), before)
    assert.equal(h.homes.recovery(vendor), true)
  })
}

test('a record whose app pid is this process’s pid is judged by birth', async t => {
  const original = process.kill
  const spy = t.mock.method(process, 'kill', (pid, ...args) => original.call(process, pid, ...args))
  for (const state of ['dead', 'live']) {
    const h = fixture(t, request => {
      const result = proved(request)
      result.processes[0] = state
      return result
    })
    const p = h.plant({ ownPid: true })
    const reclaimed = state === 'dead'
    assert.equal(await h.homes.recoverLogins(vendor), reclaimed)
    assert.deepEqual(h.calls[0].processes[0], { pid: process.pid, start: windowsBirth.start })
    assert.equal(existsSync(p.file), !reclaimed)
  }
  assert.equal(spy.mock.calls.some(call => call.arguments[0] === process.pid), false)
})

test('interrupted publication uses complete evidence and blocks on a damaged .next', async t => {
  for (const marker of ['supervisor', 'members']) {
    const h = fixture(t)
    const p = h.plant()
    const path = join(p.control, marker)
    renameSync(path, `${path}.tmp`)
    assert.equal(await h.homes.recoverLogins(vendor), true)
    assert.equal(existsSync(p.file), false)
    assert.equal(existsSync(p.control), false)
    if (marker === 'supervisor') assert.equal(h.calls[0].processes[1].start, null)
    else assert.equal(h.calls[0].processes.length, 2)
  }
  for (const damaged of [false, true]) {
    const h = fixture(t)
    const p = h.plant()
    const { supervisor, ...base } = p.record
    const next = `${p.file}.next`
    write(p.file, { ...base, kind: 'starting' })
    writeFileSync(next, damaged ? '{' : JSON.stringify({ ...p.record, supervisor }))
    assert.equal(await h.homes.recoverLogins(vendor), !damaged)
    assert.equal(existsSync(p.file), damaged)
    assert.equal(existsSync(next), damaged)
    assert.equal(h.calls.length, damaged ? 0 : 1)
  }
})

test('two swapped records keep both records and both control folders', async t => {
  const h = fixture(t)
  const a = h.plant(), b = h.plant()
  write(a.file, { ...a.record, job: b.job })
  write(b.file, { ...b.record, job: a.job })
  assert.equal(await h.homes.recoverLogins(vendor), false)
  assert.equal(h.calls.length, 0)
  for (const record of [a, b]) {
    assert.equal(existsSync(record.file), true)
    assert.equal(existsSync(record.control), true)
  }
})

for (const change of ['record', 'evidence', 'reset', 'dispose', 'closeRecovery']) {
  test(`${change} during the probe discards the proof`, async t => {
    const reply = Promise.withResolvers()
    const h = fixture(t, () => reply.promise)
    const p = h.plant({ changing: true })
    if (change === 'closeRecovery' || change === 'dispose') {
      assert.throws(() => h.homes.startup(vendor), { code: 'acp-account/unverified-login' })
    }
    const pending = h.homes.recoverLogins(vendor)
    if (change === 'record') write(p.file, { ...p.record, added: 'changed' })
    if (change === 'evidence') write(join(p.control, 'members'), { ...p.members, processes: [] })
    if (change === 'reset') assert.notEqual(h.homes.reset(vendor), h.home)
    if (change === 'dispose') h.homes.dispose()
    if (change === 'closeRecovery') h.homes.closeRecovery()
    const bytes = read(p.file)
    reply.resolve(proved(h.calls[0]))
    assert.equal(await pending, false)
    assert.equal(read(p.file), bytes)
    assert.equal(existsSync(join(h.home, 'changing')), true)
    assert.equal(existsSync(join(h.root, 'instances', vendor, h.homes.instance)), change === 'closeRecovery' || change === 'reset')
  })
}

test('a live pid with an equal birth is live, a different birth is dead, no birth is unknown', () => {
  const proof = { job: 'absent', code: 2, processes: ['dead', 'dead'] }
  assert.equal(windowsLoginEnded(proof), true)
  for (const state of ['live', 'unknown']) {
    assert.equal(windowsLoginEnded({ ...proof, processes: [state, 'dead'] }), false)
  }
  assert.equal(windowsLoginEnded({ ...proof, processes: ['dead'] }), false)
})

test('recovery probes once per vendor at a time and never without a foreign Windows record', async t => {
  const reply = Promise.withResolvers()
  const h = fixture(t, () => reply.promise)
  assert.equal(await h.homes.recoverLogins(vendor), false)
  h.plant()
  const pending = h.homes.recoverLogins(vendor)
  assert.equal(h.homes.recoverLogins(vendor), pending)
  assert.equal(await h.homes.recoverLogins('codex'), false)
  assert.equal(h.calls.length, 1)
  reply.resolve(proved(h.calls[0]))
  assert.equal(await pending, true)
  assert.equal(await h.homes.recoverLogins(vendor), false)
  assert.equal(h.calls.length, 1)
})

test('a vendor with multiple Windows records shares one probe time budget', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const h = fixture(t, (request, { timeoutMs }) => {
    assert.equal(timeoutMs, 60_000)
    now += timeoutMs
    return proved(request)
  })
  h.plant()
  h.plant()
  assert.equal(await h.homes.recoverLogins(vendor), true)
  assert.equal(h.calls.length, 1)
  assert.equal(readdirSync(join(h.home, 'login-trees')).length, 1)
})

test('Unix records keep the synchronous ESRCH proof and never reach the Windows probe', {
  skip: process.platform === 'win32',
}, async t => {
  const h = fixture(t)
  const dir = join(h.home, 'login-trees')
  mkdirSync(dir, { recursive: true })
  const group = exitedPid()
  const file = join(dir, randomUUID())
  write(file, { owner: `${group}-${basename(file)}`, app: group, kind: 'unix', group })
  assert.equal(await h.homes.recoverLogins(vendor), false)
  assert.equal(h.calls.length, 0)
  assert.equal(existsSync(file), true)
  assert.equal(h.homes.recovery(vendor), false)
  assert.equal(existsSync(file), false)
})

test('cleanup removes only known control files and never recurses', async t => {
  const h = fixture(t)
  const p = h.plant()
  writeFileSync(join(p.control, 'extra'), 'keep')
  assert.equal(await h.homes.recoverLogins(vendor), true)
  assert.deepEqual(readdirSync(p.control), ['extra'])
})
