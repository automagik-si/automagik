import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, {
  accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { AGENT_TOOLS } from '../src/host/agent-access.js'
import { ROUTE } from '../src/host/constants.js'
import { install as installLocalAgents } from '../src/host/local-agents/index.js'
import {
  REASON_CODES, install, pluginHealth, readSelfUpdate, selfUpdateStatus, storeDirOf, supervisorOf, usableStore, writeJsonAtomic,
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
const requiresStore = { skip: constants.O_NOFOLLOW === undefined && 'O_NOFOLLOW is unavailable' }
const empty = { current: null, run: null, staleRun: null, problem: null }
const supervisor = { version: 1, bootId, runId: run.runId }
const available = { available: true, reason: null, supervisor: { version: 'v1.2.3' }, ...empty }
const refused = {
  ok: false,
  error: { code: 'bot/read-only', message: 'This window does not hold the team, so it cannot report updates.', details: {} },
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'bots-self-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profileDir = join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const storeDir = storeDirOf(profileDir)
  return {
    home, profileDir, storeDir, currentPath: join(storeDir, 'current.json'),
    statePath: join(storeDir, 'state.json'), supervisorPath: join(storeDir, 'supervisor.json'),
  }
}

test('the update store is beside the profiles tree', requiresStore, t => {
  const { home, profileDir, storeDir } = fixture(t)
  assert.equal(storeDirOf(profileDir), storeDir)
  assert.equal(usableStore(profileDir), join(home, 'update', 'web'))
  assert.equal(usableStore(join(home, 'profiles', 'missing')), undefined)
  assert.equal(usableStore(join(home, 'missing', 'profiles', 'web')), undefined)
  assert.equal(storeDirOf(join(home, 'other', 'web')), undefined)
  assert.equal(storeDirOf(join(home, 'profiles', 'web', 'nested')), undefined)
  for (const value of [undefined, null, 42, {}]) assert.equal(storeDirOf(value), undefined)
})

test('missing update files leave an empty status', requiresStore, t => {
  const { profileDir, currentPath } = fixture(t)
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), empty)
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), available)
  const initial = { version: 1, live: null, kept: null, lastSequence: null }
  writeJsonAtomic(currentPath, initial, { profileDir })
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, current: initial })
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), { ...available, current: initial })
})

test('an existing invalid or unreadable current record makes the store unavailable', requiresStore, t => {
  const { profileDir, storeDir, currentPath } = fixture(t)
  mkdirSync(storeDir, { recursive: true })
  const invalid = { ...available, available: false, reason: 'store-invalid', problem: 'Invalid current.json' }
  writeFileSync(currentPath, '{')
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), invalid)
  writeJsonAtomic(currentPath, null, { profileDir })
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), invalid)
  for (const lastSequence of [null, -1, current.live.sequence - 1, Number.MAX_SAFE_INTEGER + 1]) {
    writeJsonAtomic(currentPath, { ...current, lastSequence }, { profileDir })
    assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), invalid)
  }
  for (const sequence of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    writeJsonAtomic(currentPath, { ...current, live: { ...current.live, sequence } }, { profileDir })
    assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), invalid)
  }
  const atZero = { ...current, live: { ...current.live, sequence: 0 }, lastSequence: 0 }
  writeJsonAtomic(currentPath, atZero, { profileDir })
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), { ...available, current: atZero })
  rmSync(currentPath)
  mkdirSync(currentPath)
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), invalid)
})

test('corrupt, unreadable and wrong-shaped files report only their file names', requiresStore, t => {
  const { profileDir, storeDir, currentPath, statePath } = fixture(t)
  const privateText = 'private fixture content'
  writeJsonAtomic(currentPath, current, { profileDir })
  writeFileSync(statePath, `{ ${privateText}\n`, 'utf8')
  const corrupt = readSelfUpdate({ profileDir, bootId })
  assert.deepEqual(corrupt.current, current)
  assert.equal(corrupt.run, null)
  assert.match(corrupt.problem, /state\.json/)

  writeJsonAtomic(currentPath, { ...current, lastSequence: privateText }, { profileDir })
  writeJsonAtomic(statePath, { ...run, updatedAt: '2026-02-30T12:00:00.000Z' }, { profileDir })
  const invalid = readSelfUpdate({ profileDir, bootId })
  assert.equal(invalid.current, null)
  assert.equal(invalid.run, null)
  assert.match(invalid.problem, /current\.json/)
  assert.match(invalid.problem, /state\.json/)

  rmSync(statePath)
  mkdirSync(statePath)
  const unreadable = readSelfUpdate({ profileDir, bootId })
  assert.equal(unreadable.run, null)
  assert.equal(unreadable.problem, 'Invalid current.json. Invalid state.json')
  for (const { problem } of [corrupt, invalid, unreadable]) {
    assert.doesNotMatch(problem, /[\r\n]/)
    assert.equal(problem.includes(privateText), false)
    assert.equal(problem.includes(storeDir), false)
  }
})

test('only the run and boot named by the live supervisor are reported as the run', requiresStore, t => {
  const { profileDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  writeJsonAtomic(statePath, { ...run, bootId: formerBootId }, { profileDir })
  const staleRun = { runId: run.runId, phase: run.phase }
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, staleRun })
  assert.deepEqual(readSelfUpdate({ profileDir }), { ...empty, staleRun })

  writeJsonAtomic(statePath, run, { profileDir })
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, run })

  for (const mismatch of [{ runId: 'run-0002' }, { runId: null }, { bootId: formerBootId }]) {
    writeJsonAtomic(supervisorPath, { ...supervisor, ...mismatch }, { profileDir })
    assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, staleRun })
  }
  writeJsonAtomic(supervisorPath, { ...supervisor, runId: 'short' }, { profileDir })
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, staleRun, problem: 'Invalid supervisor.json' })
  rmSync(supervisorPath)
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, staleRun })

  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  for (const phase of ['healthy', 'rolledBack', 'notUpdated', 'manualRecovery']) {
    const terminal = { ...run, phase, reason: 'health-check-finished' }
    writeJsonAtomic(statePath, terminal, { profileDir })
    assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, run: terminal })
    writeJsonAtomic(statePath, { ...terminal, bootId: formerBootId }, { profileDir })
    assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, staleRun: { ...staleRun, phase } })
  }
})

test('the reader refuses a symlinked state file', requiresStore, t => {
  const { profileDir, storeDir, statePath, home } = fixture(t)
  const target = join(home, 'private-state')
  writeFileSync(target, JSON.stringify(run))
  mkdirSync(storeDir, { recursive: true })
  try {
    symlinkSync(target, statePath, 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('File symlinks require permission')
    throw error
  }
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, problem: 'Invalid state.json' })
})

test('the reader refuses a FIFO without opening it for reading', requiresStore, t => {
  const { profileDir, storeDir, statePath } = fixture(t)
  mkdirSync(storeDir, { recursive: true })
  try {
    execFileSync('mkfifo', [statePath], { stdio: 'ignore' })
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('mkfifo is unavailable')
    throw error
  }
  const openSync = t.mock.fn(() => { throw new Error('FIFO reached openSync') })
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }, { ...fs, openSync }), {
    ...empty, problem: 'Invalid state.json',
  })
  assert.equal(openSync.mock.callCount(), 0)
})

test('the reader accepts 64 KiB and refuses larger records', requiresStore, t => {
  const { profileDir, currentPath, statePath, supervisorPath } = fixture(t)
  const limit = 64 * 1024
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  const stateJson = JSON.stringify(run)
  writeFileSync(statePath, stateJson.padEnd(limit))
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, run })
  writeFileSync(statePath, stateJson.padEnd(limit + 1))
  writeFileSync(currentPath, JSON.stringify(current).padEnd(limit + 1))
  writeFileSync(supervisorPath, JSON.stringify(supervisor).padEnd(limit + 1))
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }), {
    ...empty, problem: 'Invalid current.json. Invalid state.json. Invalid supervisor.json',
  })
})

test('the reader refuses more bytes than the limit even when fstat reports a smaller file', requiresStore, t => {
  const { profileDir, currentPath } = fixture(t)
  writeJsonAtomic(currentPath, current, { profileDir })
  const limit = 64 * 1024
  const json = JSON.stringify(current)
  writeFileSync(currentPath, json.padEnd(limit + 1024))
  const fstatSync = t.mock.fn((...args) => Object.assign(fs.fstatSync(...args), { size: BigInt(json.length) }))
  let bytesRead = 0
  const readSync = (...args) => {
    const count = fs.readSync(...args)
    bytesRead += count
    return count
  }
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }, { ...fs, fstatSync, readSync }), {
    ...empty, problem: 'Invalid current.json',
  })
  assert.equal(fstatSync.mock.callCount(), 1)
  assert.equal(bytesRead, limit + 1)
})

test('the reader retries a replacement between lstat and open', requiresStore, t => {
  const { profileDir, storeDir, currentPath } = fixture(t)
  const replacementPath = join(storeDir, 'replacement.json')
  const replacement = { ...current, lastSequence: current.lastSequence + 1 }
  writeJsonAtomic(currentPath, current, { profileDir })
  writeJsonAtomic(replacementPath, replacement, { profileDir })
  const operations = []
  const openSync = (...args) => {
    operations.push('open')
    if (existsSync(replacementPath)) fs.renameSync(replacementPath, currentPath)
    return fs.openSync(...args)
  }
  const closeSync = fd => {
    operations.push('close')
    fs.closeSync(fd)
  }
  assert.deepEqual(readSelfUpdate({ profileDir, bootId }, { ...fs, openSync, closeSync }), {
    ...empty, current: replacement,
  })
  assert.deepEqual(operations, ['open', 'close', 'open', 'close'])
})

test('the reader refuses a device or inode mismatch that persists after retrying', requiresStore, t => {
  const { profileDir, currentPath } = fixture(t)
  writeJsonAtomic(currentPath, current, { profileDir })
  for (const field of ['dev', 'ino']) {
    const fstatSync = (...args) => {
      const stat = fs.fstatSync(...args)
      stat[field] += 1n
      return stat
    }
    const readSync = t.mock.fn(fs.readSync)
    const closeSync = t.mock.fn(fs.closeSync)
    assert.deepEqual(readSelfUpdate({ profileDir, bootId }, { ...fs, fstatSync, readSync, closeSync }), {
      ...empty, problem: 'Invalid current.json',
    })
    assert.equal(readSync.mock.callCount(), 0)
    assert.equal(closeSync.mock.callCount(), 2)
  }
})

test('the reader checks containment again after opening a file', requiresStore, t => {
  const { profileDir, home, storeDir, currentPath } = fixture(t)
  writeJsonAtomic(currentPath, current, { profileDir })
  const updateDir = dirname(storeDir)
  const openSync = (...args) => {
    const fd = fs.openSync(...args)
    fs.renameSync(updateDir, join(home, 'former-update'))
    symlinkSync(profileDir, updateDir, 'junction')
    return fd
  }
  const readSync = t.mock.fn(fs.readSync)
  const status = readSelfUpdate({ profileDir, bootId }, { ...fs, openSync, readSync })
  assert.equal(status.current, null)
  assert.match(status.problem, /Invalid current\.json/)
  assert.equal(status.problem.includes(home), false)
  assert.equal(readSync.mock.callCount(), 0)
})

test('a non-directory update or profile store makes status unavailable', requiresStore, t => {
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

test('Linux stores require matching mount IDs even on the same device', {
  skip: process.platform !== 'linux' || requiresStore.skip,
}, t => {
  const { profileDir: neighboringProfile } = fixture(t)
  const profileDir = neighboringProfile + ' space'
  mkdirSync(profileDir)
  const storeDir = storeDirOf(profileDir)
  const updateDir = dirname(storeDir)
  const currentPath = join(storeDir, 'current.json')
  const mountPath = path => fs.realpathSync(path).replaceAll('\\', '\\134').replaceAll(' ', '\\040')
  const root = '1 0 8:1 / / rw - ext4 /dev/test rw\n'
  const mount = (id, folder, source = '/') => root + id + ' 1 8:1 ' + source
    + ' ' + mountPath(folder) + ' rw shared:1 - ext4 /dev/test rw\n'
  const read = readMountInfo => selfUpdateStatus({ profileDir, env, inDesktop: false, readMountInfo })
  const unavailable = { ...available, available: false, reason: 'no-store' }

  // The neighboring mount name is a string prefix of the profile, but ends within a component.
  assert.deepEqual(read(() => mount(2, neighboringProfile)), available)
  const unrelatedProfile = neighboringProfile + ' other'
  mkdirSync(unrelatedProfile)
  assert.deepEqual(read(() => mount(2, unrelatedProfile)), available)
  assert.deepEqual(read(() => root + '2 1 8:1 / / rw - ext4 /dev/test rw\n'), available)
  // A namespace file's root is not a path (snapd's nsfs entries); it must not void the table.
  assert.deepEqual(read(() => root + '3 1 0:5 mnt:[4026532922] /run/snapd/ns/cups.mnt rw - nsfs nsfs rw\n'), available)
  assert.deepEqual(read(() => { throw new Error('mountinfo unavailable') }), unavailable)
  assert.deepEqual(read(() => root + 'invalid mountinfo\n'), unavailable)

  mkdirSync(updateDir)
  assert.deepEqual(read(() => mount(3, updateDir)), unavailable)
  const bindMount = () => mount(4, storeDir, mountPath(profileDir))
  const readMountInfo = () => existsSync(storeDir) ? bindMount() : root
  assert.throws(() => writeJsonAtomic(currentPath, current, { profileDir, readMountInfo }), /Invalid update store directory/)
  assert.equal(existsSync(currentPath), false)
  assert.deepEqual(read(bindMount), unavailable)
  assert.throws(() => writeJsonAtomic(currentPath, current, { profileDir, readMountInfo: bindMount }), /Invalid update store directory/)
})

test('symlinked store directories and stores inside a resolved profile are refused', requiresStore, t => {
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
  assert.throws(() => writeJsonAtomic(statePath, run, { profileDir }))
  assert.equal(existsSync(join(profileDir, 'state.json')), false)
  unlinkSync(storeDir)
  mkdirSync(storeDir)
  rmSync(profileDir, { recursive: true })
  symlinkSync(storeDir, profileDir, 'junction')
  assert.equal(usableStore(profileDir), undefined)
})

test('the nearest existing store directory needs write and search permission', requiresStore, t => {
  const { profileDir, storeDir } = fixture(t)
  const updateDir = dirname(storeDir)
  mkdirSync(updateDir)
  for (const [folder, mode] of [[updateDir, 0o500], [storeDir, 0o600]]) {
    if (folder === storeDir) mkdirSync(storeDir)
    chmodSync(folder, mode)
    try {
      try { accessSync(folder, constants.W_OK | constants.X_OK) } catch (error) {
        assert.equal(error.code, 'EACCES')
        assert.equal(usableStore(profileDir), undefined)
        continue
      }
      return t.skip('The test process can access the directory despite its permissions')
    } finally {
      chmodSync(folder, 0o700)
    }
  }
})

test('a platform without O_NOFOLLOW has no update store', { skip: constants.O_NOFOLLOW !== undefined }, t => {
  const { profileDir, currentPath } = fixture(t)
  assert.equal(usableStore(profileDir), undefined)
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }), {
    ...available, available: false, reason: 'no-store',
  })
  assert.throws(() => writeJsonAtomic(currentPath, current, { profileDir }), /Invalid update store directory/)
})

test('atomic writes create private files and directories and clean up the temp file', requiresStore, t => {
  const { profileDir, storeDir, currentPath, statePath } = fixture(t)
  writeJsonAtomic(currentPath, { version: 1, live: null, kept: null, lastSequence: null }, { profileDir })
  writeJsonAtomic(currentPath, current, { profileDir })
  assert.deepEqual(JSON.parse(readFileSync(currentPath, 'utf8')), current)
  if (process.platform !== 'win32') {
    assert.equal(statSync(storeDir).mode & 0o777, 0o700)
    assert.equal(statSync(currentPath).mode & 0o777, 0o600)
  }
  assert.deepEqual(readdirSync(storeDir), ['current.json'])
  mkdirSync(statePath)
  assert.throws(() => writeJsonAtomic(statePath, run, { profileDir }))
  assert.deepEqual(readdirSync(storeDir).sort(), ['current.json', 'state.json'])
})

test('atomic writes require a profile and a destination in its resolved store', requiresStore, t => {
  const { home, profileDir, storeDir, currentPath } = fixture(t)
  const outside = join(profileDir, 'current.json')
  assert.throws(() => writeJsonAtomic(outside, current, { profileDir }), /Invalid update store directory/)
  assert.throws(() => writeJsonAtomic(currentPath, current), /Invalid update store directory/)
  assert.equal(existsSync(outside), false)
  assert.equal(existsSync(storeDir), false)

  const alias = join(home, 'update-alias')
  symlinkSync(home, alias, 'junction')
  writeJsonAtomic(join(alias, 'update', 'web', 'current.json'), current, { profileDir })
  assert.deepEqual(JSON.parse(readFileSync(currentPath, 'utf8')), current)
})

test('atomic writes refuse a store swapped to a symlink before rename', requiresStore, t => {
  const { home, profileDir, storeDir, currentPath } = fixture(t)
  writeJsonAtomic(currentPath, current, { profileDir })
  const updateDir = dirname(storeDir)
  const outside = join(profileDir, 'web')
  mkdirSync(outside)
  const previous = join(home, 'former-update')
  const rename = fs.renameSync
  const close = fs.closeSync
  const opened = t.mock.method(fs, 'openSync')
  const closed = t.mock.method(fs, 'closeSync', fd => {
    close(fd)
    rename(updateDir, previous)
    symlinkSync(profileDir, updateDir, 'junction')
  })
  const renamed = t.mock.method(fs, 'renameSync')
  try {
    assert.throws(() => writeJsonAtomic(currentPath, current, { profileDir }), /Invalid update store directory/)
    assert.equal(renamed.mock.callCount(), 0)
    assert.equal(opened.mock.callCount(), 1)
    const flags = opened.mock.calls[0].arguments[1]
    const required = constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    assert.equal(flags & required, required)
  } finally {
    renamed.mock.restore()
    closed.mock.restore()
    opened.mock.restore()
  }
  assert.deepEqual(readdirSync(outside), [])
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

test('status explains availability and returns only the public state fields', requiresStore, t => {
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

  writeJsonAtomic(currentPath, { ...current, live: { ...current.live, path: profileDir }, storeDir }, { profileDir })
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  writeJsonAtomic(statePath, { ...run, path: profileDir }, { profileDir })
  const privateBoot = 'private_boot_id'
  const privateToken = 'private-token'
  const privateEnv = { ...env, AUTOMAGIK_SUPERVISOR_BOOT: privateBoot, PRIVATE_ENV: privateToken }
  const read = (announcedEnv = { ...env, PRIVATE_ENV: privateToken }) =>
    selfUpdateStatus({ profileDir, env: announcedEnv, inDesktop: false })
  const value = read()
  const { bootId: _bootId, ...visibleRun } = run
  assert.deepEqual(value, { ...available, current, run: visibleRun })
  for (const hidden of [profileDir, storeDir, bootId, 'bootId', privateBoot, privateToken]) {
    assert.equal(JSON.stringify(value).includes(hidden), false)
  }

  writeJsonAtomic(supervisorPath, { ...supervisor, bootId: privateBoot }, { profileDir })
  const privateVersion = '1.2.3-release.' + privateBoot + '.build'
  for (const fields of [
    { runId: privateBoot }, { runId: 'run-' + privateBoot + '-next' }, { reason: privateBoot }, { reason: privateToken },
    { from: privateVersion }, { to: privateVersion },
  ]) {
    writeJsonAtomic(statePath, { ...run, bootId: privateBoot, ...fields }, { profileDir })
    const invalid = read(privateEnv)
    assert.deepEqual(invalid, { ...available, current, problem: 'Invalid state.json' })
    for (const hidden of [privateBoot, privateToken]) assert.equal(JSON.stringify(invalid).includes(hidden), false)
  }

  writeJsonAtomic(statePath, { ...run, bootId: privateBoot }, { profileDir })
  const noVersion = read({ ...privateEnv, AUTOMAGIK_SUPERVISOR_VERSION: undefined })
  assert.deepEqual(noVersion, {
    available: false, reason: 'no-supervisor', supervisor: null, ...empty, current,
    staleRun: { runId: run.runId, phase: run.phase },
  })
  assert.equal(JSON.stringify(noVersion).includes(privateBoot), false)

  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  writeJsonAtomic(statePath, { ...run, runId: 'run-' + privateBoot }, { profileDir })
  const invalidWithoutVersion = read({ ...privateEnv, AUTOMAGIK_SUPERVISOR_VERSION: undefined })
  assert.equal(invalidWithoutVersion.problem, 'Invalid state.json')
  assert.equal(JSON.stringify(invalidWithoutVersion).includes(privateBoot), false)

  writeJsonAtomic(statePath, { ...run, bootId: privateBoot }, { profileDir })
  for (const key of ['live', 'kept']) {
    for (const version of ['private version', privateVersion]) {
      writeJsonAtomic(currentPath, { ...current, [key]: { ...current[key], version } }, { profileDir })
      const invalid = read(privateEnv)
      assert.equal(invalid.available, false)
      assert.equal(invalid.reason, 'store-invalid')
      assert.equal(invalid.current, null)
      assert.equal(JSON.stringify(invalid).includes(version), false)
    }
  }
  writeJsonAtomic(currentPath, current, { profileDir })

  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  writeJsonAtomic(statePath, { ...run, bootId: formerBootId, phase: 'healthy', reason: 'health-check-finished' }, { profileDir })
  const stale = read()
  assert.equal(stale.run, null)
  assert.deepEqual(stale.staleRun, { runId: run.runId, phase: 'healthy' })
  assert.equal(JSON.stringify(stale).includes(formerBootId), false)
})

test('invalid public fields invalidate the entire state record', requiresStore, t => {
  const { profileDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, { ...supervisor, bootId: formerBootId }, { profileDir })
  for (const fields of [
    { runId: 'short' }, { runId: 'a'.repeat(65) }, { runId: 'run/0001' },
    { runId: 'run-' + formerBootId }, { runId: 'run-' + bootId, bootId: 'boot_state-999' },
    { from: 'private-value' }, { to: ['1.2.4'] }, { to: '1.2.4\n' },
    { reason: 'private environment value' }, { reason: '1-code' }, { reason: 'a'.repeat(65) },
  ]) {
    writeJsonAtomic(statePath, { ...run, ...fields }, { profileDir })
    assert.deepEqual(readSelfUpdate({ profileDir, bootId }), { ...empty, problem: 'Invalid state.json' }, JSON.stringify(fields))
  }
})

test('public timestamps cannot contain a known boot ID', requiresStore, t => {
  const { profileDir, statePath, supervisorPath } = fixture(t)
  const numericBoot = '12345678'
  const announced = { ...env, AUTOMAGIK_SUPERVISOR_BOOT: numericBoot }
  writeJsonAtomic(supervisorPath, { ...supervisor, bootId: numericBoot }, { profileDir })
  for (const field of ['startedAt', 'updatedAt']) {
    const timestamp = '2026-11-20T12:00:00.' + numericBoot + 'Z'
    writeJsonAtomic(statePath, { ...run, bootId: numericBoot, [field]: timestamp }, { profileDir })
    assert.deepEqual(selfUpdateStatus({ profileDir, env: announced, inDesktop: false }), {
      ...available, problem: 'Invalid state.json',
    })
  }
})

test('a run that does not know its versions yet is valid', requiresStore, t => {
  const { profileDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  writeJsonAtomic(statePath, { ...run, phase: 'checking', from: null, to: null }, { profileDir })
  const read = readSelfUpdate({ profileDir, bootId })
  assert.equal(read.problem, null)
  assert.equal(read.run?.phase, 'checking')
  assert.equal(read.run?.to, null)
  for (const reason of REASON_CODES) {
    writeJsonAtomic(statePath, { ...run, reason }, { profileDir })
    assert.equal(readSelfUpdate({ profileDir, bootId }).run?.reason, reason)
  }
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

test('runtime installation captures the supervisor and polls the configured profile store', requiresStore, t => {
  const { profileDir, currentPath, statePath, supervisorPath } = fixture(t)
  announceSupervisor(t)
  const rt = { ctx: { get: name => name === 'profileContext' ? { dir: profileDir } : undefined } }
  install(rt)
  Object.assign(process.env, { AUTOMAGIK_SUPERVISOR_BOOT: formerBootId, AUTOMAGIK_SUPERVISOR_VERSION: '2.0.0', DS_BOT_APP: '1' })
  assert.equal(rt.selfUpdateStatus().available, true)
  assert.equal(rt.selfUpdateStatus().current, null)
  writeJsonAtomic(currentPath, current, { profileDir })
  writeJsonAtomic(statePath, run, { profileDir })
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  const status = rt.selfUpdateStatus()
  assert.deepEqual(status.supervisor, { version: 'v1.2.3' })
  assert.deepEqual(status.current, current)
  assert.equal(status.run.phase, 'switching')
  assert.equal(status.staleRun, null)
})

const endpoint = 'self-update-status'

function statusChannel(profileDir, teamHome, routeEndpoint = endpoint, services = {}) {
  const ctx = fakeContext({ services: { profileContext: { dir: profileDir }, ...services } })
  const register = ctx.connection.fetch.register
  let route
  ctx.connection.fetch.register = options => {
    if (options.path === ROUTE) route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home: teamHome, browser: false, memory: false, updateCheck: false })
  const post = async (payload, name = routeEndpoint) => (await route.fetch(new Request('http://fixture.invalid' + ROUTE, {
    method: 'POST', body: JSON.stringify({ endpoint: name, payload }),
  }))).json()
  const dispose = async () => {
    try { await ctx.dispose() } finally { rt.dispose() }
  }
  return { rt, post, dispose }
}

test('the channel answers self-update-status only while the host holds the team lock', requiresStore, async t => {
  const { home, profileDir, currentPath } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  writeJsonAtomic(currentPath, current, { profileDir })
  const teamHome = join(home, 'team')
  const { rt, post, dispose } = statusChannel(profileDir, teamHome)
  const extension = t.mock.fn(() => ({ extension: true }))
  rt.hooks.endpoint(endpoint, extension, { read: true })
  try {
    assert.deepEqual(await post(), { ok: true, value: { ...available, current } })
    assert.equal(rt.holdsLock(), true)

    // A live peer now owns the team. The next poll must refresh ownership first.
    const lockPath = join(teamHome, 'state.lock')
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
    const reply = await post()
    assert.deepEqual(reply, refused)
    assert.equal(reply.error.message.includes(teamHome), false)
    assert.equal(rt.holdsLock(), false)
    assert.equal(extension.mock.callCount(), 0)

    assert.equal(AGENT_TOOLS.some(tool => tool.endpoint === endpoint || /^self[-_]update[-_]status$/.test(tool.name)), false)
  } finally {
    await dispose()
  }
})

test('the default channel status advertises rollback only for an explicit supervisor capability', requiresStore, async t => {
  const { home, profileDir } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  const previous = process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK
    else process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK = previous
  })
  for (const value of [undefined, '', '1', 'sup_inherited', bootId]) {
    if (value === undefined) delete process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK
    else process.env.AUTOMAGIK_SUPERVISOR_ROLLBACK = value
    const { post, dispose } = statusChannel(profileDir, join(home, 'team'))
    try {
      const answer = await post()
      assert.deepEqual(answer, { ok: true, value: { ...available, ...(value === bootId ? { rollback: true } : {}) } })
    } finally {
      await dispose()
    }
  }
})

test('the channel refuses self-update-status after lock acquisition throws', requiresStore, async t => {
  const { home, profileDir } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  const teamHome = join(home, 'team')
  const lockPath = join(teamHome, 'state.lock')
  const original = fs.writeFileSync
  let attempts = 0
  const write = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file !== lockPath) return original(file, ...args)
    attempts++
    throw Object.assign(new Error('fixture lock cannot be created'), { code: 'EACCES' })
  })
  syncBuiltinESMExports()
  try {
    const { rt, post, dispose } = statusChannel(profileDir, teamHome)
    try {
      assert.deepEqual(await post(), refused)
      assert.equal(attempts, 1)
      assert.equal(rt.readOnly(), undefined)
      assert.equal(rt.holdsLock(), false)
    } finally {
      await dispose()
    }
  } finally {
    write.mock.restore()
    syncBuiltinESMExports()
  }
})

test('the self-update check requires the team lock ahead of read extensions and takes no input', requiresStore, async t => {
  const { home, profileDir } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  const checkEndpoint = 'self-update-check'
  const teamHome = join(home, 'team')
  const { rt, post, dispose } = statusChannel(profileDir, teamHome, checkEndpoint)
  const extension = t.mock.fn(() => ({ extension: true }))
  rt.hooks.endpoint(checkEndpoint, extension, { read: true })
  const value = { state: 'current', reason: 'not-newer' }
  assert.equal(typeof rt.selfUpdateCheck, 'function')
  rt.selfUpdateCheck = t.mock.fn(async () => value)
  try {
    assert.deepEqual(await post({ url: 'https://fixture.invalid/update' }), { ok: true, value })
    assert.equal(rt.holdsLock(), true)
    assert.deepEqual(rt.selfUpdateCheck.mock.calls[0].arguments, [])

    const lockPath = join(teamHome, 'state.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
    const reply = await post()
    assert.deepEqual(reply, refused)
    assert.equal(reply.error.message.includes(teamHome), false)
    assert.equal(rt.holdsLock(), false)
    assert.equal(rt.selfUpdateCheck.mock.callCount(), 1)
    assert.equal(extension.mock.callCount(), 0)
    assert.equal(AGENT_TOOLS.some(tool => tool.endpoint === checkEndpoint || /^self[-_]update[-_]check$/.test(tool.name)), false)
  } finally {
    await dispose()
  }
})


const checkEndpoint = 'self-update-check'
const resultEndpoint = 'self-update-check-result'
const laneUrl = 'https://github.com/automagik-si/automagik/releases/download/plugin-lane/lane.json'

function pausedLane(t) {
  const urls = []
  let pending
  const pause = () => {
    const started = Promise.withResolvers()
    const resume = Promise.withResolvers()
    pending = { started, resume }
    return { started: started.promise, resume: resume.resolve }
  }
  const first = pause()
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url)
    if (url === laneUrl) {
      const { started, resume } = pending
      started.resolve()
      await resume.promise
      return new Response('{"keyId":"unknown","schemaVersion":1}')
    }
    if (url === laneUrl + '.sig') return new Response('fixture signature')
    assert.fail(`Unexpected URL: ${url}`)
  })
  return { ...first, pause, urls }
}

test('deferred checks join in flight and the result route stays bound to the requested run', requiresStore, async t => {
  const { home, profileDir, storeDir } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  const prior = {
    version: 1, runId: 'completed-before-restart', checkedAt: run.startedAt, state: 'current', reason: 'not-newer',
    laneVersion: '1.2.3', sequence: 4, plugins: [], supervisor: true,
  }
  writeJsonAtomic(join(storeDir, 'check.json'), prior, { profileDir })
  const { rt, post, dispose } = statusChannel(profileDir, join(home, 'team'), checkEndpoint)
  const lane = pausedLane(t)
  let nextLane
  const replies = []
  const wait = Promise.withResolvers()
  const set = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 5000) {
      replies.push(() => callback(...args))
      if (replies.length === 2) wait.resolve()
    }
    return set(callback, ms, ...args)
  })
  try {
    const initial = post()
    await lane.started
    const joined = post()
    await wait.promise
    for (const reply of replies) reply()

    const first = await initial
    const { runId } = first.value
    const marker = JSON.parse(readFileSync(join(storeDir, `check-${runId}`, 'check.running.json'), 'utf8'))
    assert.match(marker.runId, /^[a-f0-9-]{36}$/)
    assert.equal(marker.runId, runId)
    const checking = { ok: true, value: { state: 'checking', runId } }
    const interrupted = { ok: true, value: { state: 'interrupted', runId } }
    assert.deepEqual(first, checking)
    assert.deepEqual(await joined, checking)
    assert.deepEqual(await post({ runId }, resultEndpoint), checking)
    assert.equal((await post({}, resultEndpoint)).error.code, 'bot/invalid')

    // A fresh module has the same disk records and none of the interrupted process's memory.
    const checkBeforeRestart = rt.selfUpdateCheck
    const resultBeforeRestart = rt.selfUpdateCheckResult
    const restarted = await import('../src/host/self-update-check.js?restart-fixture')
    restarted.install(rt)
    assert.deepEqual(await post({ runId }, resultEndpoint), interrupted)
    assert.deepEqual(await post({ runId: prior.runId }, resultEndpoint), { ok: true, value: prior })
    rt.selfUpdateCheck = checkBeforeRestart
    rt.selfUpdateCheckResult = resultBeforeRestart
    assert.deepEqual(lane.urls, [laneUrl])

    // A caller arriving just before completion gets the result in its check response.
    const admitted = Promise.withResolvers()
    const check = rt.selfUpdateCheck
    t.mock.method(rt, 'selfUpdateCheck', () => {
      const answer = check()
      admitted.resolve()
      return answer
    })
    const finishing = post()
    await admitted.promise
    lane.resume()
    const answer = await finishing
    assert.equal(answer.ok, true)
    assert.equal(answer.value.state, 'refused')
    assert.equal(answer.value.reason, 'signature-invalid')
    assert.deepEqual(answer.value, JSON.parse(readFileSync(join(storeDir, 'check.json'), 'utf8')))
    assert.equal(answer.value.runId, runId)
    assert.deepEqual(await post({ runId }, resultEndpoint), answer)
    assert.deepEqual(lane.urls, [laneUrl, laneUrl + '.sig'])

    // A second window starts a new check before the first window polls again.
    nextLane = lane.pause()
    const next = post()
    await nextLane.started
    assert.deepEqual(await post({ runId }, resultEndpoint), interrupted)
    nextLane.resume()
    const newer = await next
    assert.equal(newer.ok, true)
    assert.notEqual(newer.value.runId, runId)
    assert.deepEqual(await post({ runId }, resultEndpoint), interrupted)
    assert.deepEqual(await post({ runId: newer.value.runId }, resultEndpoint), newer)
    assert.deepEqual(lane.urls, [laneUrl, laneUrl + '.sig', laneUrl, laneUrl + '.sig'])
  } finally {
    nextLane?.resume()
    lane.resume()
    await dispose()
  }
})

test('losing the team during a check leaves the previous record intact and refuses both routes', requiresStore, async t => {
  const { home, profileDir, storeDir } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  const teamHome = join(home, 'team')
  const checkPath = join(storeDir, 'check.json')
  const prior = {
    version: 1, runId: 'prior-run', checkedAt: run.startedAt, state: 'current', reason: 'not-newer',
    laneVersion: '1.2.3', sequence: 4, plugins: [], supervisor: true,
  }
  writeJsonAtomic(checkPath, prior, { profileDir })
  const previousBytes = readFileSync(checkPath)
  const { rt, post, dispose } = statusChannel(profileDir, teamHome, checkEndpoint)
  const lane = pausedLane(t)
  const extension = t.mock.fn(() => ({ extension: true }))
  rt.hooks.endpoint(resultEndpoint, extension, { read: true })
  try {
    assert.deepEqual(await post({ runId: prior.runId, url: 'https://fixture.invalid/update' }, resultEndpoint), { ok: true, value: prior })
    assert.deepEqual(lane.urls, [])
    const request = post()
    await lane.started
    const generation = rt.teamGeneration()
    assert.equal(rt.sameTeam(generation), true)
    writeFileSync(join(teamHome, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
    assert.equal(rt.sameTeam(generation), false)
    lane.resume()
    assert.deepEqual(await request, refused)
    assert.deepEqual(await post({ runId: prior.runId }, resultEndpoint), refused)
    assert.deepEqual(readFileSync(checkPath), previousBytes)
    assert.equal(extension.mock.callCount(), 0)
  } finally {
    lane.resume()
    await dispose()
  }
})

test('the two check routes are absent from the MCP, Bot and local-agent tool lists', requiresStore, async t => {
  const { home, profileDir } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home })
  const { rt, dispose } = statusChannel(profileDir, join(home, 'team'))
  try {
    assert.ok(AGENT_TOOLS.length > 0)
    assert.ok(rt.teamTools.length > 0)
    installLocalAgents(rt)
    assert.ok(rt.localAgentTools.some(tool => tool.name === 'approve_agent_action'))
    for (const tools of [AGENT_TOOLS, rt.teamTools, rt.localAgentTools]) {
      for (const endpoint of [checkEndpoint, resultEndpoint]) {
        assert.equal(tools.some(tool => tool.endpoint === endpoint || tool.name?.replaceAll('_', '-') === endpoint), false)
      }
    }
  } finally {
    await dispose()
  }
})

test('the status health form reports active loader entries and the matching closed hold', requiresStore, async t => {
  const { home, profileDir, statePath, supervisorPath } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home, AUTOMAGIK_SUPERVISOR_RUN: run.runId })
  writeJsonAtomic(statePath, { ...run, phase: 'rollingBack' }, { profileDir })
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  const name = '@automagik/bots-dsh'
  const installAt = join(home, 'tree')
  const manifest = join(installAt, 'node_modules', name, 'package.json')
  mkdirSync(dirname(manifest), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ version: '1.2.3' }))
  const parent = { tree: { ctx: { baseUrl: pathToFileURL(installAt + '/').href } } }
  const active = { options: { name }, fiber: { state: 2 }, parent }
  const entries = [active, { options: { name }, fiber: { state: 3 } }]
  const loader = { entries: () => entries.values() }
  const { post, dispose } = statusChannel(profileDir, join(home, 'team'), endpoint, { loader })
  t.after(dispose)
  const first = await post({ health: true })
  assert.equal(first.ok, true)
  assert.deepEqual(first.value.hold, { state: 'closed', run: run.runId })
  assert.deepEqual(first.value.plugins.find(row => row.name === name), { name, version: '1.2.3', loaded: true })
  assert.ok(first.value.plugins.filter(row => row.name !== name).every(row => row.loaded === false))
  writeFileSync(manifest, JSON.stringify({ version: '9.9.9' }))
  const second = await post({ health: true })
  assert.deepEqual(second.value.plugins, first.value.plugins)
  entries.push({ ...active })
  assert.deepEqual(pluginHealth({ get: () => loader }).find(row => row.name === name), { name, version: null, loaded: false })
  entries.shift()
  const replaced = await post({ health: true })
  assert.deepEqual(replaced.value.plugins.find(row => row.name === name), { name, version: '9.9.9', loaded: true })
  for (const payload of [undefined, { health: false }, { health: true, extra: true }]) {
    const ordinary = await post(payload)
    assert.equal(Object.hasOwn(ordinary.value, 'plugins'), false)
    assert.equal(Object.hasOwn(ordinary.value, 'hold'), false)
  }
})

for (const [label, bytes, present] of [
  ['corrupt', '{broken', null],
  ['no Main Bot', '{"version":2,"bots":{}}', true],
  ['missing', undefined, false],
]) {
  test('the roster health read does not bootstrap a ' + label + ' team', requiresStore, async t => {
    const { home, profileDir } = fixture(t)
    const team = join(home, 'team')
    mkdirSync(team)
    if (bytes !== undefined) writeFileSync(join(team, 'state.json'), bytes)
    const { rt, post, dispose } = statusChannel(profileDir, team)
    t.after(dispose)
    await rt.load()
    await new Promise(resolve => setImmediate(resolve))
    const effects = ['bootstrap', 'catalog', 'loadSecrets', 'deliver'].map(name => t.mock.method(rt, name,
      () => assert.fail('health invoked ' + name)))
    const response = await post({ health: true }, 'state')
    if (present === null) {
      assert.equal(response.ok, false)
      assert.equal(response.error.code, 'bot/team-unread')
    } else {
      assert.equal(response.ok, true)
      assert.equal(response.value.present, present)
      assert.equal(response.value.bots, 0)
    }
    assert.ok(effects.every(effect => effect.mock.callCount() === 0))
  })
}

test('an owner page read and saves leave a missing trial team absent until the verdict', requiresStore, async t => {
  const { home, profileDir, statePath, supervisorPath } = fixture(t)
  announceSupervisor(t, { DSH_HOME: home, AUTOMAGIK_SUPERVISOR_RUN: run.runId })
  writeJsonAtomic(statePath, { ...run, phase: 'health' }, { profileDir })
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  const team = join(home, 'team')
  const path = join(team, 'state.json')
  const { rt, post, dispose } = statusChannel(profileDir, team)
  t.after(dispose)

  await rt.load()
  assert.equal(rt.updateHoldView(), true)
  assert.equal(existsSync(path), false)
  const bootstrap = t.mock.method(rt, 'bootstrap', () => assert.fail('owner page tried to bootstrap the held team'))
  const page = await post({}, 'state')
  assert.equal(page.ok, true)
  assert.equal(bootstrap.mock.callCount(), 0)
  await rt.save()
  assert.match(rt.readOnly(), /read-only while the update is being checked/)
  const message = 'This host cannot save the Bot team: ' + rt.readOnly()
  await assert.rejects(rt.save({ required: true }), { message })
  await assert.rejects(rt.saveCopy(() => assert.fail('held team copy was prepared')), { message })
  assert.equal(existsSync(path), false)

  writeJsonAtomic(statePath, { ...run, phase: 'healthy', reason: 'health-check-finished' }, { profileDir })
  rt.updateHold.tick()
  await rt.updateGate(AbortSignal.timeout(1000))
  assert.equal(rt.readOnly(), undefined)
  await rt.save({ required: true })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).revision, 1)

  await rt.updateHold.wait(AbortSignal.timeout(10_000))
  rt.updateHold.close('later-update')
  assert.equal(rt.updateHoldView(), true)
  await rt.save({ required: true })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).revision, 2)
})

test('a validated rollback is exposed in status, with an invalid one refused', requiresStore, t => {
  const { profileDir, statePath, supervisorPath } = fixture(t)
  const rollback = { failed: 'page', trialFrom: run.startedAt, trialTo: run.updatedAt, data: { restored: true } }
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  writeJsonAtomic(statePath, { ...run, phase: 'rolledBack', reason: 'health-failed', rollback }, { profileDir })
  assert.deepEqual(selfUpdateStatus({ profileDir, env, inDesktop: false }).run.rollback, rollback)
  writeJsonAtomic(statePath, { ...run, phase: 'rolledBack', reason: 'health-failed',
    rollback: { ...rollback, failed: 'unrecognized' } }, { profileDir })
  assert.equal(selfUpdateStatus({ profileDir, env, inDesktop: false }).problem, 'Invalid state.json')
})

test('listener eligibility is authoritative for this boot and falls back for stale or unreadable state', requiresStore, t => {
  const { profileDir, storeDir } = fixture(t)
  const path = join(storeDir, 'listener.json')
  const status = override => selfUpdateStatus({ profileDir, env: { ...env, ...override }, inDesktop: false })
  writeJsonAtomic(path, { version: 1, bootId, listener: 'unknown' }, { profileDir })
  assert.equal(status().reason, 'listener-unknown')
  writeJsonAtomic(path, { version: 1, bootId: formerBootId, listener: 'unknown' }, { profileDir })
  assert.equal(status().available, true)
  writeFileSync(path, '{')
  assert.equal(status().available, true)
  writeJsonAtomic(path, { version: 1, bootId, listener: 'verified-argv' }, { profileDir })
  assert.equal(status({ AUTOMAGIK_SUPERVISOR_LISTENER_UNKNOWN: '1' }).available, true)
})


test('status carries the rollback team-loss reason and whether the trial bytes were kept', requiresStore, t => {
  const { profileDir, statePath, supervisorPath } = fixture(t)
  writeJsonAtomic(supervisorPath, supervisor, { profileDir })
  const status = data => {
    const rollback = { failed: 'exited', trialFrom: run.startedAt, trialTo: run.updatedAt, data }
    writeJsonAtomic(statePath, { ...run, phase: 'rolledBack', reason: 'health-failed', rollback }, { profileDir })
    return selfUpdateStatus({ profileDir, env, inDesktop: false })
  }
  for (const trialKept of [true, false]) {
    const data = { restored: true, why: 'team-lost', trialKept }
    assert.deepEqual(status(data).run.rollback.data, data)
  }
  assert.equal(status({ restored: true, trialKept: 'yes' }).problem, 'Invalid state.json')
  assert.equal(status({ restored: false, why: 'same-format', trialKept: true }).problem, 'Invalid state.json')
})
