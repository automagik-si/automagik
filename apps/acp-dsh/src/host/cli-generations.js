// Installation-level ownership must outlive a replaceable vendor home. Each mutex contender
// announces a unique PID/UUID directory before checking peers; dead claims never need a
// second recovery claim, and no contender deletes a pathname another contender will reuse.
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LOGIN_RECORD_VERSION, unverifiedLogin } from './login-ownership.js'
import { processBirth, processState, validBirth } from './process-identity.js'

export const POINTER_ENV = 'AUTOMAGIK_BOT_CLI_POINTER'
export const GENERATION_ENV = 'AUTOMAGIK_BOT_CLI_GENERATION'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const busy = () => Object.assign(new Error(
  'Close other Automagik sessions before changing the Bot account.',
), { code: 'acp-account/busy' })

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return true
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

// Snapshot the pathname as well as its exact bytes. Never remove a replacement entry, and
// never turn an unreadable or unrecognized record into evidence that its owner is dead.
export function ownershipAt(path, { legacy = '' } = {}) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return null
    const name = basename(path)
    const pid = Number(name.split('-')[0])
    if (!Number.isSafeInteger(pid) || pid <= 1) return null
    const directory = stat.isDirectory()
    if (directory && (legacy !== 'claim' || readdirSync(path).length !== 0)) return null
    if (!directory && (!stat.isFile() || stat.size > 4096)) return null
    const bytes = directory ? '' : readFileSync(path, 'utf8')
    let record
    if ((legacy === 'claim' && directory) || (legacy === 'root' && bytes === '')
      || (legacy === 'home' && (bytes === '' || bytes === LOGIN_RECORD_VERSION))) {
      record = { pid, legacy: true, marker: bytes }
    } else {
      record = JSON.parse(bytes)
      if (record?.format !== 'app-birth-v1' || record.pid !== pid || record.nonce !== name
        || record.marker !== (legacy === 'home' ? LOGIN_RECORD_VERSION : legacy)
        || (record.birth !== null && !validBirth(record.birth))) return null
    }
    return { path, dev: stat.dev, ino: stat.ino, directory, bytes, record, legacy }
  } catch { return null }
}

export function sameOwnership(snapshot) {
  if (!snapshot) return false
  const current = ownershipAt(snapshot.path, { legacy: snapshot.legacy })
  return current !== null && current.dev === snapshot.dev && current.ino === snapshot.ino
    && current.directory === snapshot.directory && current.bytes === snapshot.bytes
}

export const ownershipState = snapshot => snapshot
  ? processState(snapshot.record.pid, snapshot.record.birth) : 'unknown'

export function removeDeadOwnership(snapshot) {
  if (!sameOwnership(snapshot) || ownershipState(snapshot) !== 'dead' || !sameOwnership(snapshot)) return false
  rmSync(snapshot.path, { recursive: snapshot.directory, force: true })
  return true
}

export function generationAt(pointer) {
  let generation
  try { generation = readFileSync(pointer, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') {
      const root = dirname(dirname(pointer))
      const vendor = basename(pointer)
      if (existsSync(`${pointer}.activated`) || existsSync(join(root, 'homes', vendor))
        || existsSync(join(root, 'retired', vendor))) throw unverifiedLogin()
      return 'legacy'
    }
    throw unverifiedLogin()
  }
  if (!UUID.test(generation)) throw unverifiedLogin()
  return generation
}

export function assertGeneration(env) {
  if (env[POINTER_ENV] === undefined) return
  const pointer = env[POINTER_ENV]
  const generation = generationAt(pointer)
  const root = dirname(dirname(pointer))
  const vendor = basename(pointer)
  const home = generation === 'legacy' ? join(root, vendor)
    : join(root, 'homes', vendor, generation)
  if (generation !== env[GENERATION_ENV] || env.AUTOMAGIK_BOT_CLI_HOME !== home
    || env.HOME !== home || env.CODEX_HOME !== join(home, '.codex')
    || env.CLAUDE_CONFIG_DIR !== join(home, '.claude')) {
    throw Object.assign(new Error(
      'The Bot account changed. Start this work again after signing in.',
    ), { code: 'acp-account/busy' })
  }
}

export class CliGenerations {
  constructor(root, instance) {
    this.root = root
    this.instance = instance
    this.held = new Map()
    this.registered = new Set()
    this.birth = processBirth(process.pid)
    this.owned = new Map()
  }

  pointer(vendor) { return join(this.root, 'current', vendor) }
  current(vendor) { return generationAt(this.pointer(vendor)) }
  folder(vendor, generation = this.current(vendor)) {
    return generation === 'legacy' ? join(this.root, vendor)
      : join(this.root, 'homes', vendor, generation)
  }
  claims(vendor) { return join(this.root, 'mutations', vendor) }
  instances(vendor) { return join(this.root, 'instances', vendor) }

  publish(path, marker) {
    if (this.owned.has(path)) {
      if (!sameOwnership(this.owned.get(path))) throw busy()
      return
    }
    // Staging is outside every instances/mutations directory, including old contenders'.
    const staging = join(this.root, '.ownership-staging')
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = join(staging, randomUUID())
    const bytes = JSON.stringify({ format: 'app-birth-v1', pid: process.pid,
      nonce: basename(path), birth: this.birth, marker })
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      // A hard link publishes the complete file atomically and refuses an existing target.
      // rename alone could overwrite a competing entry on Unix. Both paths share a volume.
      linkSync(temporary, path)
      const snapshot = ownershipAt(path, { legacy: marker === LOGIN_RECORD_VERSION ? 'home' : marker })
      if (!snapshot || snapshot.bytes !== bytes) throw busy()
      this.owned.set(path, snapshot)
    } finally { rmSync(temporary, { force: true }) }
  }

  release(path) {
    const snapshot = this.owned.get(path)
    this.owned.delete(path)
    if (sameOwnership(snapshot)) rmSync(path, { force: true })
  }

  peers(directory, legacy, own, { sweep = false } = {}) {
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory)) {
      if (name === own) continue
      const snapshot = ownershipAt(join(directory, name), { legacy })
      if (ownershipState(snapshot) !== 'dead') throw busy()
      // Empty legacy home markers are evidence of untracked detached logins: retain them.
      if (sweep && !(legacy === 'home' && snapshot.record.marker !== LOGIN_RECORD_VERSION)
        && !removeDeadOwnership(snapshot)) throw busy()
    }
  }

  register(vendor) {
    const directory = this.instances(vendor)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.publish(join(directory, this.instance), 'root')
    this.registered.add(vendor)
  }

  unregister(vendor) {
    this.release(join(this.instances(vendor), this.instance))
    this.registered.delete(vendor)
  }

  otherApps(vendor, home) {
    this.peers(this.instances(vendor), 'root', this.instance, { sweep: true })
    this.peers(join(home, 'instances'), 'home', this.instance)
  }

  check(vendor) {
    this.peers(this.claims(vendor), 'claim', this.held.get(vendor), { sweep: true })
  }

  acquire(vendor) {
    if (this.held.has(vendor)) throw busy()
    const directory = this.claims(vendor)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const claim = `${this.instance}-${randomUUID()}`
    this.publish(join(directory, claim), 'claim')
    this.held.set(vendor, claim)
    try {
      this.check(vendor)
    } catch (error) {
      this.held.delete(vendor)
      this.release(join(directory, claim))
      throw error
    }
    return () => {
      this.held.delete(vendor)
      this.release(join(directory, claim))
    }
  }

  exclusive(vendor, change) {
    const release = this.acquire(vendor)
    try {
      const result = change()
      if (result?.then) throw new Error('Account ownership callbacks must be synchronous')
      return result
    } finally { release() }
  }

  select(vendor, generation) {
    const pointer = this.pointer(vendor)
    mkdirSync(join(this.root, 'current'), { recursive: true, mode: 0o700 })
    // An absent selection after activation is damage, never permission to revive legacy.
    writeFileSync(`${pointer}.activated`, '', { mode: 0o600 })
    const next = `${pointer}.${randomUUID()}`
    writeFileSync(next, generation, { mode: 0o600 })
    renameSync(next, pointer)
  }

  dispose() {
    for (const vendor of this.registered) this.unregister(vendor)
  }
}
