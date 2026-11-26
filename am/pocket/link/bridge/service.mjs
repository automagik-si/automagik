import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { bridgeState, commandOf, startedAt } from './devices.mjs'
import { stateDir } from './state.mjs'
import { configuredArg, servicePaths } from './service-paths.js'

export const LABEL = 'dev.herdr.pocket-link'
export const UNIT = 'herdr-pocket-link.service'
export const home = homedir()
export const serviceFile = (homeDir = home, platform = process.platform) => platform === 'darwin'
  ? join(homeDir, 'Library/LaunchAgents', LABEL + '.plist')
  : join(homeDir, '.config/systemd/user', UNIT)
export const managerLock = () => join(dirname(serviceFile()), '.herdr-pocket-link.lock')
export const stateLock = dir => join(dir, 'service.lock')
export const stateOwnerFile = dir => join(dir, 'am-owner.json')

export function readStateOwner(dir) {
  const path = stateOwnerFile(dir)
  try {
    if (!lstatSync(path).isFile()) throw new Error('Invalid Pocket Link state owner.')
    const { store } = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof store !== 'string' || !isAbsolute(store)) throw new Error('Invalid Pocket Link state owner.')
    return store
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

export function assertStateOwner(dir, store) {
  const owner = readStateOwner(dir)
  if (owner === (store ?? null)) return
  if (owner) throw new Error('Another am store owns this Pocket Link state directory.')
  throw new Error('This am store does not own the Pocket Link state directory.')
}

export function storeForEntry(entry) {
  const suffix = '/current/link/bridge/bridge.mjs'
  return entry?.endsWith(suffix) ? realpathSync(entry.slice(0, -suffix.length)) : null
}

export function assertNoPurge(dir, delegation) {
  const path = join(dir, 'purge.pending')
  let owner
  try {
    if (!lstatSync(path).isFile()) throw new Error('Invalid Pocket Link purge marker.')
    owner = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) { if (e.code === 'ENOENT') return; throw e }
  if (!delegation || owner?.token !== delegation) throw new Error('A Pocket Link purge is pending in this state directory.')
}

export function assertStandalone() {
  const store = join(resolve(process.env.AM_HOME || join(home, '.automagik')), 'parts/pocket.link')
  for (const name of ['record.json', 'pending.json']) {
    try { lstatSync(join(store, name)) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    throw new Error('Pocket Link is managed by am. Use am pocket link.')
  }
}

export function ownsJob(job, definition, entry) {
  if (!job.loaded) return true
  if (!definition.present || definition.entry !== entry || !job.path) return false
  try { return job.path === serviceFile() || job.path === realpathSync(serviceFile()) } catch { return false }
}

export function matchesJob(job, definition, entry) {
  if (!ownsJob(job, definition, entry)) return false
  if (!job.loaded) return true
  const { node, state } = definition
  if (!node || !state) return false
  if (process.platform === 'darwin') {
    return job.program === node && job.state === state
      && JSON.stringify(job.args) === JSON.stringify([node, entry, 'serve'])
  }
  const exec = `{ path=${configuredArg(node)} ; argv[]=${configuredArg(node)} ${configuredArg(entry)} serve ;`
  return job.load === 'loaded' && job.reload === 'no' && job.dropIns === ''
    && job.exec?.startsWith(exec) && job.exec.indexOf('} {') === -1
}

export const definitionDigest = bytes => createHash('sha256').update(bytes).digest('hex')

export function readService(path = serviceFile()) {
  try {
    if (!lstatSync(path).isFile()) return { present: true }
    const bytes = readFileSync(path)
    const body = bytes.toString('utf8')
    return { present: true, ...servicePaths(body), body, digest: definitionDigest(bytes) }
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false }
    throw e
  }
}

// A busy machine's whole process list (ps -axo … command=) passes Node's 1 MB default.
export const runManager = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const managerError = result => String(result.error?.message || result.stderr?.trim() || `exit ${result.status}`)
function requireManager(result) {
  if (result.status !== 0) throw new Error(managerError(result))
}

export function serviceManager() {
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`
    const job = `${domain}/${LABEL}`
    return {
      inspect() {
        const r = runManager('launchctl', ['print', job])
        if (r.status === 0) {
          const field = name => new RegExp(`^[\\t ]*${name} = (.*)$`, 'm').exec(r.stdout)?.[1]
          const args = /^[\t ]*arguments = \{\n([\s\S]*?)^[\t ]*\}/m.exec(r.stdout)?.[1]
          const pid = Number(field('pid')) || null
          const inactive = !pid && ['not running', 'waiting', 'spawn scheduled', 'throttled', 'exited'].includes(field('state'))
          return { loaded: true, pid, inactive, enabled: 'loaded', path: field('path'), program: field('program'),
            args: args?.trimEnd().split('\n').map(arg => arg.trimStart()),
            state: /^[\t ]*POCKET_LINK_STATE_DIR => (.*)$/m.exec(r.stdout)?.[1] }
        }
        if (r.status !== 113 && !/could not find service/i.test(r.stderr ?? '')) requireManager(r)
        requireManager(runManager('launchctl', ['print', domain]))
        return { loaded: false, pid: null, inactive: true, enabled: "disabled" }
      },
      on: () => requireManager(runManager('launchctl', ['bootstrap', domain, serviceFile()])),
      off: () => requireManager(runManager('launchctl', ['bootout', job])),
      reload: () => {},
    }
  }
  const control = (...args) => runManager('systemctl', ['--user', ...args])
  const reload = () => requireManager(control('daemon-reload'))
  return {
    inspect() {
      const r = control('show', '--all', '-p', 'LoadState', '-p', 'FragmentPath', '-p', 'ActiveState',
        '-p', 'UnitFileState', '-p', 'MainPID', '-p', 'ExecStart', '-p', 'DropInPaths', '-p', 'NeedDaemonReload', UNIT)
      const field = name => new RegExp(`^${name}=(.*)$`, 'm').exec(r.stdout ?? '')?.[1]
      const load = field('LoadState')
      if (load === 'not-found' && !r.error) return { loaded: false, pid: null }
      requireManager(r)
      if (!load) throw new Error('systemd did not report Pocket Link’s load state')
      const enabled = field('UnitFileState')
      const pid = Number(field('MainPID')) || null
      return { loaded: true, pid, path: field('FragmentPath'), enabled, load, exec: field('ExecStart'),
        reload: field('NeedDaemonReload'), dropIns: field('DropInPaths'),
        inactive: !pid && ['inactive', 'failed'].includes(field('ActiveState')) && ['enabled', 'disabled'].includes(enabled) }
    },
    on: () => requireManager(control('enable', '--now', UNIT)),
    enable: () => requireManager(control('enable', UNIT)),
    off: () => requireManager(control('disable', '--now', UNIT)),
    reload,
  }
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}

function linuxStart(pid) {
  if (process.platform !== 'linux') return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    return /^\d+$/.test(start) ? `linux:${start}` : null
  } catch { return null }
}

const lockStart = pid => linuxStart(pid) ?? startedAt(pid)

function startTag(pid) {
  const start = lockStart(pid)
  return start && createHash('sha256').update(start).digest('hex').slice(0, 16)
}

function deadStaging(dir) {
  return readdirSync(dir).filter(name => {
    const m = /^\.staging-(\d+)-([a-f0-9]{16})-/.exec(name)
    if (!m) return false
    if (!processAlive(Number(m[1]))) return true
    const tag = startTag(Number(m[1]))
    return Boolean(tag && tag !== m[2])
  })
}

export function sameProcess({ pid, start }) {
  if (!processAlive(pid)) return false
  const actual = start?.startsWith('linux:') ? linuxStart(pid) : startedAt(pid)
  return !start || !actual || start === actual
}

const lockText = path => {
  try { return readFileSync(path, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

/** Publish the owner atomically. A separate lock serializes contenders reclaiming a dead owner. */
export async function acquire(path, { pid = process.pid, wait = 10_000 } = {}) {
  const start = lockStart(pid)
  if (!start) throw new Error(`Cannot identify Pocket Link lock owner ${pid}`)
  const token = JSON.stringify({ pid, start, token: randomUUID() })
  const temp = `${path}.${pid}-${randomUUID()}`
  const deadline = Date.now() + wait
  const busy = () => new Error('Pocket Link is busy. Try again in a moment.')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(temp, token, { flag: 'wx', mode: 0o600 })
  try {
    do {
      try {
        linkSync(temp, path)
        return {
          token,
          release() { if (lockText(path) === token) rmSync(path) },
        }
      } catch (e) { if (e.code !== 'EEXIST') throw e }
      const before = lockText(path)
      if (before === null) continue
      let owner
      try { owner = JSON.parse(before) } catch { throw busy() }
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || !owner.start) throw busy()
      if (!sameProcess(owner)) {
        const reclaim = await acquire(`${path}.reclaim`, { wait: Math.max(0, deadline - Date.now()) })
        try { if (lockText(path) === before) rmSync(path) } finally { reclaim.release() }
        continue
      }
      if (Date.now() >= deadline) break
      await delay(50)
    } while (true)
    throw busy()
  } finally { rmSync(temp, { force: true }) }
}

// A service command can outlive the am parent blocked waiting for it. Give that child its own
// fence, and wait for the fence when acquiring an authority left by a dead parent.
async function acquireAuthority(path, { pid, wait } = {}) {
  const lock = await acquire(path, { pid, wait })
  try {
    const fence = await acquire(`${path}.command`, { wait })
    fence.release()
    return lock
  } catch (e) {
    lock.release()
    throw e
  }
}

export async function underLock(path, fn, { wait, delegation } = {}) {
  if (delegation) {
    const fence = await acquire(`${path}.command`, { wait })
    try {
      const text = lockText(path)
      const owner = text && JSON.parse(text)
      if (owner?.token !== delegation || owner?.pid !== process.ppid || !sameProcess(owner)) {
        throw new Error('Pocket Link lost its service lock.')
      }
      return await fn()
    } finally { fence.release() }
  }
  const lock = await acquireAuthority(path, { wait })
  try { return await fn() } finally { lock.release() }
}

export function servesEntry(pid, entry) {
  if (!pid || !entry) return false
  try {
    const [, script, verb] = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    return script === entry && verb === 'serve'
  } catch {
    return commandOf(pid)?.endsWith(` ${entry} serve`) ?? false
  }
}

function otherBridge(entry) {
  const pocket = /(?:^|\/)(?:pocket-link|pocket\.link)\//
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const path = `/proc/${name}`
        if (lstatSync(path).uid !== process.getuid()) continue
        const [, script, verb] = readFileSync(join(path, 'cmdline'), 'utf8').split('\0')
        if (verb !== 'serve' || !script?.endsWith('/bridge.mjs') || script === entry || !pocket.test(script)) continue
        const env = readFileSync(join(path, 'environ'), 'utf8').split('\0')
        if (env.includes(`HOME=${home}`)) return Number(name)
      } catch { /* The process may have exited. */ }
    }
    return null
  }
  const result = runManager('ps', ['-axo', 'uid=,pid=,command='])
  requireManager(result)
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match && Number(match[1]) === process.getuid() && match[3].endsWith('/bridge.mjs serve')
        && !match[3].endsWith(` ${entry} serve`) && pocket.test(match[3]) && match[3].includes(` ${home}/`)) return Number(match[2])
  }
  return null
}

async function inspect(dir, entry, alternatives, scan) {
  const definition = readService()
  const job = serviceManager().inspect()
  const running = []
  for (const state of new Set([dir, ...alternatives].filter(Boolean))) {
    const bridge = await bridgeState({ dir: state })
    if (bridge.running) running.push({ ...bridge, state, ours: servesEntry(bridge.pid, entry) })
  }
  let status = {}
  if (dir) {
    try { status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) ?? {} } catch {}
  }
  job.ours = servesEntry(job.pid, entry)
  job.owned = matchesJob(job, definition, entry)
  const ready = Boolean(job.owned && definition.entry === entry && job.ours && status.ticket && job.pid && job.pid === status.pid
    && running.some(p => p.pid === job.pid && p.state === dir && p.ours))
  return { definition, job, running, ready, detached: scan ? otherBridge(entry) : null }
}

const invoked = (() => {
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url) } catch { return false }
})()
if (invoked) {
  const [verb, arg, entry, ...alternatives] = process.argv.slice(2)
  try {
    let value
    if (verb === 'acquire' && isAbsolute(arg)) {
      const lock = await acquireAuthority(arg, { pid: process.ppid })
      value = JSON.parse(lock.token)
    } else if (verb === 'start-tag') value = startTag(process.ppid)
    else if (verb === 'dead-staging' && isAbsolute(arg)) value = deadStaging(arg)
    else if (verb === 'definition') {
      value = { ...readService(), lock: managerLock(), stateDefault: stateDir({ env: process.env, home }) }
    } else if (verb === 'inspect') {
      const scan = alternatives[0] === '--scan'
      value = await inspect(arg, entry, scan ? alternatives.slice(1) : alternatives, scan)
    }
    else throw new Error('Unknown Pocket Link service operation')
    process.stdout.write(JSON.stringify(value))
  } catch (e) {
    process.stderr.write(e.message + '\n')
    process.exitCode = 1
  }
}
