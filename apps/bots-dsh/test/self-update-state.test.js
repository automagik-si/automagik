import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { AGENT_TOOLS } from '../src/host/agent-access.js'
import { ROUTE } from '../src/host/constants.js'
import {
  install, readSelfUpdate, selfUpdateStatus, storeDirOf, supervisorOf, usableStore, writeJsonAtomic,
} from '../src/host/self-update.js'
import { fakeContext } from './fake-ctx.js'

const bootId = 'boot_live-123'
const formerBootId = 'boot_former-456'
const env = { AUTOMAGIK_SUPERVISOR_BOOT: bootId, AUTOMAGIK_SUPERVISOR_VERSION: 'v1.2.3' }
const current = { version: 1, live: { version: '1.2.3', sequence: 4 }, kept: { version: '1.2.2' }, lastSequence: 4 }
const run = {
  version: 1, runId: 'run-0001', bootId, phase: 'switching', from: '1.2.3', to: '1.2.4', reason: null,
  startedAt: '2026-11-20T12:00:00.000Z', updatedAt: '2026-11-20T12:00:01.000Z',
}
const empty = { current: null, run: null, staleRun: null, problem: null }
const supervisor = { version: 1, bootId, runId: run.runId }

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'bots-self-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const storeDir = usableStore(profileDir)
  return {
    home, profileDir, storeDir, currentPath: join(storeDir, 'current.json'),
    statePath: join(storeDir, 'state.json'), supervisorPath: join(storeDir, 'supervisor.json'),
  }
}

test('the update store is beside the profiles tree', t => {
  const { home, profileDir, storeDir } = fixture(t)
  assert.equal(storeDirOf(profileDir), storeDir)
  assert.equal(usableStore(profileDir), join(home, 'update', 'web'))
  assert.equal(usableStore(join(home, 'profiles', 'missing')), undefined)
  assert.equal(usableStore(join(home, 'missing', 'profiles', 'web')), undefined)
  assert.equal(storeDirOf(join(home, 'other', 'web')), undefined)
  assert.equal(storeDirOf(join(home, 'profiles', 'web', 'nested')), undefined)
  for (const value of [undefined, null, 42, {}]) assert.equal(storeDirOf(value), undefined)
})

test('missing update files leave an empty status', t => {
  const { storeDir, currentPath } = fixture(t)
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), empty)
  const initial = { version: 1, live: null, kept: null, lastSequence: null }
  writeJsonAtomic(currentPath, initial)
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, current: initial })
})

test('corrupt, unreadable and wrong-shaped files report only their file names', t => {
  const { storeDir, currentPath, statePath } = fixture(t)
  const privateText = 'private fixture content'
  writeJsonAtomic(currentPath, current)
  writeFileSync(statePath, `{ ${privateText}\n`, 'utf8')
  const corrupt = readSelfUpdate({ storeDir, bootId })
  assert.deepEqual(corrupt.current, current)
  assert.equal(corrupt.run, null)
  assert.match(corrupt.problem, /state\.json/)

  writeJsonAtomic(currentPath, { ...current, lastSequence: privateText })
  writeJsonAtomic(statePath, { ...run, updatedAt: '2026-02-30T12:00:00.000Z' })
  const invalid = readSelfUpdate({ storeDir, bootId })
  assert.equal(invalid.current, null)
  assert.equal(invalid.run, null)
  assert.match(invalid.problem, /current\.json/)
  assert.match(invalid.problem, /state\.json/)

  rmSync(statePath)
  mkdirSync(statePath)
  const unreadable = readSelfUpdate({ storeDir, bootId })
  assert.equal(unreadable.run, null)
  assert.equal(unreadable.problem, 'Invalid current.json. Invalid state.json')
  for (const { problem } of [corrupt, invalid, unreadable]) {
    assert.doesNotMatch(problem, /[\r\n]/)
    assert.equal(problem.includes(privateText), false)
    assert.equal(problem.includes(storeDir), false)
  }
})

test('only the run and boot named by the live supervisor are reported as the run', t => {
  const { storeDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, supervisor)
  writeJsonAtomic(statePath, { ...run, bootId: formerBootId })
  const staleRun = { runId: run.runId, phase: run.phase }
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, staleRun })
  assert.deepEqual(readSelfUpdate({ storeDir }), { ...empty, staleRun })

  writeJsonAtomic(statePath, run)
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, run })

  for (const mismatch of [{ runId: 'run-0002' }, { runId: null }, { bootId: formerBootId }]) {
    writeJsonAtomic(supervisorPath, { ...supervisor, ...mismatch })
    assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, staleRun })
  }
  writeJsonAtomic(supervisorPath, { ...supervisor, runId: 'short' })
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, staleRun, problem: 'Invalid supervisor.json' })
  rmSync(supervisorPath)
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, staleRun })

  writeJsonAtomic(supervisorPath, supervisor)
  for (const phase of ['healthy', 'rolledBack', 'notUpdated', 'manualRecovery']) {
    const terminal = { ...run, phase, reason: 'health-check-finished' }
    writeJsonAtomic(statePath, terminal)
    assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, run: terminal })
    writeJsonAtomic(statePath, { ...terminal, bootId: formerBootId })
    assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, staleRun: { ...staleRun, phase } })
  }
})

test('the reader refuses a symlinked state file', t => {
  const { storeDir, statePath, home } = fixture(t)
  const target = join(home, 'private-state')
  writeFileSync(target, JSON.stringify(run))
  mkdirSync(storeDir, { recursive: true })
  try {
    symlinkSync(target, statePath, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('File symlinks require permission')
    throw error
  }
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, problem: 'Invalid state.json' })
})

test('the reader refuses a FIFO without opening it for reading', t => {
  const { storeDir, statePath } = fixture(t)
  mkdirSync(storeDir, { recursive: true })
  try {
    execFileSync('mkfifo', [statePath])
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('mkfifo is unavailable')
    throw error
  }
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, problem: 'Invalid state.json' })
})

test('the reader accepts 64 KiB and refuses larger records', t => {
  const { storeDir, currentPath, statePath, supervisorPath } = fixture(t)
  const limit = 64 * 1024
  writeJsonAtomic(supervisorPath, supervisor)
  const stateJson = JSON.stringify(run)
  writeFileSync(statePath, stateJson.padEnd(limit))
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, run })
  writeFileSync(statePath, stateJson.padEnd(limit + 1))
  writeFileSync(currentPath, JSON.stringify(current).padEnd(limit + 1))
  writeFileSync(supervisorPath, JSON.stringify(supervisor).padEnd(limit + 1))
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), {
    ...empty, problem: 'Invalid current.json. Invalid state.json. Invalid supervisor.json',
  })
})

test('a non-directory update or profile store makes status unavailable', t => {
  const { profileDir, storeDir } = fixture(t)
  const updateDir = dirname(storeDir)
  const unavailable = { available: false, reason: 'no-store', supervisor: { version: 'v1.2.3' }, ...empty }
  writeFileSync(updateDir, '')
  assert.equal(usableStore(profileDir), undefined)
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), unavailable)
  rmSync(updateDir)
  mkdirSync(updateDir)
  writeFileSync(storeDir, '')
  assert.equal(usableStore(profileDir), undefined)
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), unavailable)
})

test('symlinked store directories and stores inside a resolved profile are refused', t => {
  const { home, profileDir, storeDir, statePath } = fixture(t)
  const updateDir = dirname(storeDir)
  const linkedHome = join(home, 'alias')
  symlinkSync(home, linkedHome, 'junction')
  assert.equal(usableStore(join(linkedHome, 'profiles', 'web')), undefined)
  unlinkSync(linkedHome)
  symlinkSync(profileDir, updateDir, 'junction')
  assert.equal(usableStore(profileDir), undefined)
  unlinkSync(updateDir)
  mkdirSync(updateDir)
  symlinkSync(profileDir, storeDir, 'junction')
  assert.equal(usableStore(profileDir), undefined)
  assert.throws(() => writeJsonAtomic(statePath, run))
  assert.equal(existsSync(join(profileDir, 'state.json')), false)
  unlinkSync(storeDir)
  mkdirSync(storeDir)
  rmSync(profileDir, { recursive: true })
  symlinkSync(storeDir, profileDir, 'junction')
  assert.equal(usableStore(profileDir), undefined)
})

test('the nearest existing store directory must be writable', { skip: process.platform === 'win32' }, t => {
  const { profileDir, storeDir } = fixture(t)
  const updateDir = dirname(storeDir)
  mkdirSync(updateDir)
  chmodSync(updateDir, 0o500)
  try {
    try { accessSync(updateDir, constants.W_OK) } catch (error) {
      assert.equal(error.code, 'EACCES')
      assert.equal(usableStore(profileDir), undefined)
      return
    }
    t.skip('The test process can write despite directory permissions')
  } finally {
    chmodSync(updateDir, 0o700)
  }
})

test('atomic writes create private files and directories and clean up the temp file', t => {
  const { storeDir, currentPath, statePath } = fixture(t)
  writeJsonAtomic(currentPath, { version: 1, live: null, kept: null, lastSequence: null })
  writeJsonAtomic(currentPath, current)
  assert.deepEqual(JSON.parse(readFileSync(currentPath, 'utf8')), current)
  if (process.platform !== 'win32') {
    assert.equal(statSync(storeDir).mode & 0o777, 0o700)
    assert.equal(statSync(currentPath).mode & 0o777, 0o600)
  }
  assert.deepEqual(readdirSync(storeDir), ['current.json'])
  mkdirSync(statePath)
  assert.throws(() => writeJsonAtomic(statePath, run))
  assert.deepEqual(readdirSync(storeDir).sort(), ['current.json', 'state.json'])
})

test('the environment must announce a valid supervisor boot and version', () => {
  assert.deepEqual(supervisorOf(env), { bootId, version: 'v1.2.3' })
  assert.equal(supervisorOf({}), null)
  for (const boot of [undefined, 12345678, 'short', 'a'.repeat(65), 'boot with spaces', 'boot/live-123']) {
    assert.equal(supervisorOf({ ...env, AUTOMAGIK_SUPERVISOR_BOOT: boot }), null)
  }
  for (const version of [undefined, 123, ' ', 'latest', ' v1.2.3', '/opt/automagik']) {
    assert.equal(supervisorOf({ ...env, AUTOMAGIK_SUPERVISOR_VERSION: version }), null)
  }
})

test('status explains availability and returns only the public state fields', t => {
  const { profileDir, storeDir, currentPath, statePath, supervisorPath } = fixture(t)
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: true }), {
    available: false, reason: 'desktop-app', supervisor: { version: 'v1.2.3' }, ...empty,
  })
  assert.deepEqual(selfUpdateStatus({ profileDir, env: {}, inDesktop: false }), {
    available: false, reason: 'no-supervisor', supervisor: null, ...empty,
  })
  assert.deepEqual(selfUpdateStatus({ profileDir: storeDir, env, inDesktop: false }), {
    available: false, reason: 'no-store', supervisor: { version: 'v1.2.3' }, ...empty,
  })

  writeJsonAtomic(currentPath, { ...current, live: { ...current.live, path: profileDir }, storeDir })
  writeJsonAtomic(supervisorPath, supervisor)
  writeJsonAtomic(statePath, { ...run, path: profileDir })
  const privateValue = 'private-boot-id'
  const read = () => selfUpdateStatus({ profileDir, env: { ...env, PRIVATE_ENV: privateValue }, inDesktop: false })
  const value = read()
  const { bootId: _bootId, ...visibleRun } = run
  assert.deepEqual(value, {
    available: true, reason: null, supervisor: { version: 'v1.2.3' }, ...empty, current, run: visibleRun,
  })
  for (const hidden of [profileDir, storeDir, bootId, 'bootId', privateValue]) {
    assert.equal(JSON.stringify(value).includes(hidden), false)
  }

  // A boot ID could otherwise pass both the run ID pattern and the reason code pattern.
  const privateEnv = { ...env, AUTOMAGIK_SUPERVISOR_BOOT: privateValue, PRIVATE_ENV: privateValue }
  writeJsonAtomic(supervisorPath, { ...supervisor, bootId: privateValue })
  for (const fields of [{ runId: privateValue }, { reason: privateValue }, { runId: privateValue, reason: privateValue }]) {
    writeJsonAtomic(statePath, { ...run, bootId: privateValue, ...fields })
    const invalid = selfUpdateStatus({ profileDir, env: privateEnv, inDesktop: false })
    assert.deepEqual(invalid, { ...value, run: null, problem: 'Invalid state.json' })
    assert.equal(JSON.stringify(invalid).includes(privateValue), false)
  }

  rmSync(supervisorPath)
  writeJsonAtomic(statePath, { ...run, runId: privateValue })
  const noVersion = selfUpdateStatus({
    profileDir, env: { ...privateEnv, AUTOMAGIK_SUPERVISOR_VERSION: undefined }, inDesktop: false,
  })
  assert.deepEqual(noVersion, {
    available: false, reason: 'no-supervisor', supervisor: null, ...empty, current, problem: 'Invalid state.json',
  })
  assert.equal(JSON.stringify(noVersion).includes(privateValue), false)

  writeJsonAtomic(supervisorPath, supervisor)
  writeJsonAtomic(statePath, { ...run, bootId: formerBootId, phase: 'healthy', reason: 'health-check-finished' })
  const stale = read()
  assert.equal(stale.run, null)
  assert.deepEqual(stale.staleRun, { runId: run.runId, phase: 'healthy' })
  assert.equal(JSON.stringify(stale).includes(formerBootId), false)
})

test('invalid public fields invalidate the entire state record', t => {
  const { storeDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, { ...supervisor, bootId: formerBootId })
  for (const fields of [
    { runId: 'short' }, { runId: 'a'.repeat(65) }, { runId: 'run/0001' },
    { runId: formerBootId }, { runId: bootId, bootId: 'boot_state-999' },
    { from: 'private-value' }, { to: ['1.2.4'] }, { to: '1.2.4\n' },
    { reason: 'private environment value' }, { reason: '1-code' }, { reason: 'a'.repeat(65) },
  ]) {
    writeJsonAtomic(statePath, { ...run, ...fields })
    assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, problem: 'Invalid state.json' }, JSON.stringify(fields))
  }
})

test('a run that does not know its versions yet is valid', t => {
  const { storeDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, supervisor)
  writeJsonAtomic(statePath, { ...run, phase: 'checking', from: null, to: null })
  const read = readSelfUpdate({ storeDir, bootId })
  assert.equal(read.problem, null)
  assert.equal(read.run?.phase, 'checking')
  assert.equal(read.run?.to, null)
})

function announceSupervisor(t, extraEnv = {}) {
  const keys = [...Object.keys(env), ...Object.keys(extraEnv), 'OMNI_CLIENT_ID', 'DS_BOT_APP']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  Object.assign(process.env, env, extraEnv)
  delete process.env.OMNI_CLIENT_ID
  delete process.env.DS_BOT_APP
}

test('runtime installation captures the supervisor and polls the configured profile store', t => {
  const { profileDir, currentPath, statePath, supervisorPath } = fixture(t)
  announceSupervisor(t)
  const rt = { ctx: { get: name => name === 'profileContext' ? { dir: profileDir } : undefined } }
  install(rt)
  Object.assign(process.env, { AUTOMAGIK_SUPERVISOR_BOOT: formerBootId, AUTOMAGIK_SUPERVISOR_VERSION: '2.0.0', DS_BOT_APP: '1' })
  assert.equal(rt.selfUpdateStatus().available, true)
  assert.equal(rt.selfUpdateStatus().current, null)
  writeJsonAtomic(currentPath, current)
  writeJsonAtomic(statePath, run)
  writeJsonAtomic(supervisorPath, supervisor)
  const status = rt.selfUpdateStatus()
  assert.deepEqual(status.supervisor, { version: 'v1.2.3' })
  assert.deepEqual(status.current, current)
  assert.equal(status.run.phase, 'switching')
  assert.equal(status.staleRun, null)
})

test('the channel answers self-update-status only while the host holds the team lock', async t => {
  const { home, profileDir, currentPath } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  writeJsonAtomic(currentPath, current)
  const teamHome = join(home, 'team')
  const ctx = fakeContext({ services: { profileContext: { dir: profileDir } } })
  const register = ctx.connection.fetch.register
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home: teamHome, browser: false, memory: false, updateCheck: false })
  const endpoint = 'self-update-status'
  const post = async () => (await route.fetch(new Request('http://fixture.invalid' + ROUTE, {
    method: 'POST', body: JSON.stringify({ endpoint }),
  }))).json()
  try {
    assert.deepEqual(await post(), {
      ok: true,
      value: { available: true, reason: null, supervisor: { version: 'v1.2.3' }, ...empty, current },
    })

    // A live peer now owns the team. The next poll must refresh ownership first.
    const lockPath = join(teamHome, 'state.lock')
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
    const refused = await post()
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'bot/read-only')

    assert.equal(AGENT_TOOLS.some(tool => tool.endpoint === endpoint || /^self[-_]update[-_]status$/.test(tool.name)), false)
  } finally {
    await ctx.dispose()
    rt.dispose()
  }
})
