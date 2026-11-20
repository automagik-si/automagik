import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, readSelfUpdate, selfUpdateStatus, storeDirOf, supervisorOf, writeJsonAtomic } from '../src/host/self-update.js'

const bootId = 'boot_live-123'
const formerBootId = 'boot_former-456'
const env = { AUTOMAGIK_SUPERVISOR_BOOT: bootId, AUTOMAGIK_SUPERVISOR_VERSION: 'v1.2.3' }
const current = { version: 1, live: { version: '1.2.3', sequence: 4 }, kept: { version: '1.2.2' }, lastSequence: 4 }
const run = {
  version: 1, runId: 'run-1', bootId, phase: 'switching', from: '1.2.3', to: '1.2.4', reason: null,
  startedAt: '2026-11-20T12:00:00.000Z', updatedAt: '2026-11-20T12:00:01.000Z',
}
const empty = { current: null, run: null, staleRun: null, problem: null }

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'bots-self-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'web')
  const storeDir = join(home, 'update', 'web')
  return { home, profileDir, storeDir, currentPath: join(storeDir, 'current.json'), statePath: join(storeDir, 'state.json') }
}

test('the update store is beside the profiles tree', t => {
  const { home, profileDir, storeDir } = fixture(t)
  assert.equal(storeDirOf(profileDir), storeDir)
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
  assert.match(unreadable.problem, /state\.json/)
  for (const { problem } of [corrupt, invalid, unreadable]) {
    assert.doesNotMatch(problem, /[\r\n]/)
    assert.equal(problem.includes(privateText), false)
    assert.equal(problem.includes(storeDir), false)
  }
})

test('only running updates from the active boot are reported as runs', t => {
  const { storeDir, statePath } = fixture(t)
  writeJsonAtomic(statePath, { ...run, bootId: formerBootId })
  const staleRun = { runId: run.runId, phase: run.phase }
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, staleRun })
  assert.deepEqual(readSelfUpdate({ storeDir }), { ...empty, staleRun })

  writeJsonAtomic(statePath, run)
  assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, run })

  for (const phase of ['healthy', 'rolledBack', 'notUpdated', 'manualRecovery']) {
    const terminal = { ...run, phase, bootId: formerBootId, reason: 'Health check finished' }
    writeJsonAtomic(statePath, terminal)
    assert.deepEqual(readSelfUpdate({ storeDir, bootId }), { ...empty, run: terminal })
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
  const { profileDir, storeDir, currentPath, statePath } = fixture(t)
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
  writeJsonAtomic(statePath, { ...run, path: profileDir, reason: `Could not open ${profileDir}` })
  const read = () => selfUpdateStatus({ profileDir, env: { ...env, PRIVATE_ENV: 'private-env' }, inDesktop: false })
  const value = read()
  const { bootId: _bootId, ...visibleRun } = run
  assert.deepEqual(value, {
    available: true, reason: null, supervisor: { version: 'v1.2.3' }, ...empty, current, run: visibleRun,
  })
  for (const privateValue of [profileDir, storeDir, bootId, 'bootId', 'private-env']) {
    assert.equal(JSON.stringify(value).includes(privateValue), false)
  }

  writeJsonAtomic(statePath, { ...run, bootId: formerBootId, phase: 'healthy', reason: `Started as ${formerBootId}` })
  assert.deepEqual(read().run, { ...visibleRun, phase: 'healthy' })
})

test('runtime installation captures the supervisor and polls the configured profile store', t => {
  const { profileDir, currentPath, statePath } = fixture(t)
  const keys = [...Object.keys(env), 'OMNI_CLIENT_ID', 'DS_BOT_APP']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  Object.assign(process.env, env)
  delete process.env.OMNI_CLIENT_ID
  delete process.env.DS_BOT_APP
  const rt = { ctx: { get: name => name === 'profileContext' ? { dir: profileDir } : undefined } }
  install(rt)
  Object.assign(process.env, { AUTOMAGIK_SUPERVISOR_BOOT: formerBootId, AUTOMAGIK_SUPERVISOR_VERSION: '2.0.0', DS_BOT_APP: '1' })
  assert.equal(rt.selfUpdateStatus().available, true)
  assert.equal(rt.selfUpdateStatus().current, null)
  writeJsonAtomic(currentPath, current)
  writeJsonAtomic(statePath, run)
  const status = rt.selfUpdateStatus()
  assert.deepEqual(status.supervisor, { version: 'v1.2.3' })
  assert.deepEqual(status.current, current)
  assert.equal(status.run.phase, 'switching')
  assert.equal(status.staleRun, null)
})

test('self-update-status is a channel read and is absent from the agent tools', () => {
  const channel = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  const access = readFileSync(new URL('../src/host/agent-access.js', import.meta.url), 'utf8')
  const reads = channel.match(/const READS = new Set\(\[([^\]]+)\]\)/)?.[1]
  const tools = access.match(/export const AGENT_TOOLS = \[([\s\S]*?)\n\]/)?.[1]
  assert.match(reads, /'self-update-status'/)
  assert.doesNotMatch(tools, /self[-_]update[-_]status/)
})
