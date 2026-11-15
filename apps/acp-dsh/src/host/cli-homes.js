// Bot authentication belongs to this installation, never to the terminal (#869).
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  LOGIN_OWNER_ENV, LOGIN_RECORD_VERSION, unverifiedLogin, verifyLoginRecords,
} from './login-ownership.js'
import {
  assertGeneration, CliGenerations, GENERATION_ENV, ownershipAt, ownershipState,
  POINTER_ENV, removeDeadOwnership, sameOwnership,
} from './cli-generations.js'
import { processState, validBirth } from './process-identity.js'

export const HOME_ENV = 'AUTOMAGIK_BOT_CLI_HOME'
const VERSION_ENV = 'AUTOMAGIK_BOT_CLI_VERSION'
const vendors = new Set(['claude', 'codex'])
const runs = new Map()
// An allowlist, rather than a list of known tokens: future CLI auth overrides must not leak
// in either. Undefined entries mask process.env where older spawn helpers merge environments.
const inherited = new RegExp([
  '^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_.*|TZ|TERM',
  '|COLORTERM|USER|USERNAME|LOGNAME|SHELL|HTTPS?_PROXY|ALL_PROXY|NO_PROXY',
  '|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|DBUS_SESSION_BUS_ADDRESS',
  '|DISPLAY|WAYLAND_DISPLAY)$',
].join(''), 'i')
const failure = message => Object.assign(new Error(message), { code: 'acp-account/busy' })

export class CliHomes {
  constructor(root) {
    this.root = resolve(root)
    this.instance = `${process.pid}-${randomUUID()}`
    this.registered = new Map()
    this.changes = new Map()
    this.generations = new CliGenerations(this.root, this.instance)
  }

  home(vendor) {
    if (!vendors.has(vendor)) throw new Error('No isolated home for this agent.')
    return this.generations.folder(vendor)
  }

  environment(vendor, source = process.env) {
    if (!vendors.has(vendor)) throw new Error('No isolated home for this agent.')
    const registered = this.generations.registered.has(vendor)
    this.generations.register(vendor)
    try { this.generations.check(vendor) } catch (error) {
      if (!registered) this.generations.unregister(vendor)
      throw error
    }
    // Registration fences Reset before selecting any path. Capture the physical home and
    // marker from one generation, rather than reading the selection again at return time.
    const generation = this.generations.current(vendor)
    const home = this.generations.folder(vendor, generation)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const instances = join(home, 'instances')
    mkdirSync(instances, { recursive: true, mode: 0o700 })
    // Register before checking the mutation lock: either a concurrent changer sees us and
    // refuses, or we see its lock and refuse. Other app processes can never change live auth.
    if (this.registered.get(vendor) !== home) {
      this.generations.publish(join(instances, this.instance), LOGIN_RECORD_VERSION)
      if (existsSync(join(home, 'changing'))) {
        this.generations.release(join(instances, this.instance))
        if (!registered) this.generations.unregister(vendor)
        throw failure('The Bot account is changing. Try again when it finishes.')
      }
      this.registered.set(vendor, home)
    }
    this.verify(home)
    const env = Object.fromEntries(Object.keys(source).map(key => [
      key, inherited.test(key) ? source[key] : undefined,
    ]))
    const config = join(home, `.${vendor}`)
    for (const dir of [config, 'config', 'data', 'cache', 'state', 'roaming', 'local']) {
      mkdirSync(dir === config ? dir : join(home, dir), { recursive: true, mode: 0o700 })
    }
    const selected = {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'roaming'),
      LOCALAPPDATA: join(home, 'local'),
      HOMEDRIVE: undefined,
      HOMEPATH: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      [HOME_ENV]: home,
      [LOGIN_OWNER_ENV]: this.instance,
      [POINTER_ENV]: this.generations.pointer(vendor),
      [GENERATION_ENV]: generation,
      [VERSION_ENV]: existsSync(join(home, 'version'))
        ? readFileSync(join(home, 'version'), 'utf8') : '',
    }
    this.generations.check(vendor)
    assertGeneration(selected)
    return selected
  }

  changing(vendor) { return existsSync(join(this.home(vendor), 'changing')) }
  matches(env) {
    assertGeneration(env)
    const file = join(env[HOME_ENV], 'version')
    return env[VERSION_ENV] === (existsSync(file) ? readFileSync(file, 'utf8') : '')
  }
  paused(vendor) { return existsSync(join(this.home(vendor), 'paused')) }
  resume(vendor) { rmSync(join(this.home(vendor), 'paused'), { force: true }) }

  recovery(vendor) {
    try {
      const home = this.home(vendor)
      this.generations.check(vendor)
      this.verify(home)
      const lock = join(home, 'changing')
      if (existsSync(lock)) {
        return this.lockState(lock) !== 'live'
      }
      return false
    } catch { return true }
  }

  // Reset changes only the pointer. Never move the old physical path or reuse it: a vendor
  // that survived the app still has that absolute path in its environment and may write late.
  reset(vendor) {
    const reset = this.reserveReset(vendor)
    try { return reset.complete() } finally { reset.release() }
  }

  reserveReset(vendor) {
    // Validate the vendor even when its current-generation pointer is damaged.
    if (!vendors.has(vendor)) throw new Error('No isolated home for this agent.')
    const release = this.generations.acquire(vendor)
    try {
      let previous
      try { previous = this.generations.current(vendor) } catch {}
      const old = previous === undefined ? this.registered.get(vendor)
        : this.generations.folder(vendor, previous)
      this.generations.otherApps(vendor, old ?? join(this.root, vendor))
      if (old && existsSync(old)) {
        writeFileSync(join(old, 'paused'), '', { mode: 0o600 })
        writeFileSync(join(old, 'version'), randomUUID(), { mode: 0o600 })
      }
      return { home: old, release, complete: () => this.resetLocked(vendor, previous) }
    } catch (error) { release(); throw error }
  }

  resetLocked(vendor, previous) {
    const generation = randomUUID()
    const home = this.generations.folder(vendor, generation)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'paused'), '', { mode: 0o600 })
    writeFileSync(join(home, 'version'), randomUUID(), { mode: 0o600 })
    if (previous !== undefined) {
      const retired = join(this.root, 'retired', vendor)
      mkdirSync(retired, { recursive: true, mode: 0o700 })
      writeFileSync(join(retired, previous), '', { mode: 0o600 })
    }
    this.end(vendor)
    const registered = this.registered.get(vendor)
    if (registered) {
      this.generations.release(join(registered, 'instances', this.instance))
      this.registered.delete(vendor)
    }
    this.generations.select(vendor, generation)
    this.environment(vendor)
    return home
  }

  // Unproved folders remain retained. Cleanup never discards pending, damaged or legacy
  // ownership evidence; it only removes an abandoned home once every recorded owner exited.
  collect(vendor) {
    return this.generations.exclusive(vendor, () => {
      const directory = join(this.root, 'retired', vendor)
      if (!existsSync(directory)) return
      const current = this.generations.current(vendor)
      for (const generation of readdirSync(directory)) {
        if (generation === current) continue
        if (generation !== 'legacy' && !/^[a-f0-9-]{36}$/.test(generation)) continue
        const old = this.generations.folder(vendor, generation)
        try {
          const physical = lstatSync(old)
          if (!physical.isDirectory() || physical.isSymbolicLink()) continue
          const retired = join(directory, generation)
          const marker = lstatSync(retired)
          if (!marker.isFile() || marker.size !== 0) continue
          verifyLoginRecords(old, '') // Even this instance's abandoned login needs exit proof.
          this.verify(old)
          this.generations.otherApps(vendor, old)
          const instances = join(old, 'instances')
          const names = existsSync(instances) ? readdirSync(instances).sort() : []
          const owners = names.map(name => ownershipAt(join(instances, name), { legacy: 'home' }))
          if (owners.some(owner => ownershipState(owner) !== 'dead')) continue
          const lock = join(old, 'changing')
          const changing = existsSync(lock) ? this.lockSnapshot(lock) : null
          if (changing && this.lockState(lock, changing) !== 'dead') continue
          verifyLoginRecords(old, '')
          this.verify(old)
          this.generations.otherApps(vendor, old)
          if (owners.some(owner => !sameOwnership(owner) || ownershipState(owner) !== 'dead' || !sameOwnership(owner))) continue
          if (JSON.stringify(existsSync(instances) ? readdirSync(instances).sort() : []) !== JSON.stringify(names)) continue
          if (changing ? this.lockState(lock, changing) !== 'dead'
            || JSON.stringify(this.lockSnapshot(lock)) !== JSON.stringify(changing) : existsSync(lock)) continue
          const finalHome = lstatSync(old), finalMarker = lstatSync(retired)
          if (finalHome.dev !== physical.dev || finalHome.ino !== physical.ino
            || finalMarker.dev !== marker.dev || finalMarker.ino !== marker.ino || finalMarker.size !== 0) continue
          rmSync(old, { recursive: true, force: true })
          rmSync(retired, { force: true })
        } catch { /* No exit proof: retain the original folder and try on a later app start. */ }
      }
    })
  }

  verify(home) {
    verifyLoginRecords(home, this.instance)
    const instances = join(home, 'instances')
    if (!existsSync(instances)) return
    for (const name of readdirSync(instances)) {
      const snapshot = ownershipAt(join(instances, name), { legacy: 'home' })
      if (!snapshot || (ownershipState(snapshot) === 'dead'
        && snapshot.record.marker !== LOGIN_RECORD_VERSION)) {
        throw unverifiedLogin()
      }
    }
  }

  // Deliberately fail closed after a crashed account operation: the app must not resume on
  // credentials whose logout could not be confirmed. A new attempt can explicitly recover
  // the lock only when its owning process AND every persisted login tree are gone.
  begin(vendor) {
    return this.generations.exclusive(vendor, () => this.beginLocked(vendor))
  }

  beginLocked(vendor) {
    const home = this.home(vendor)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.verify(home)
    const lock = join(home, 'changing')
    if (existsSync(lock)) this.recoverChanging(home)
    this.environment(vendor)
    try { mkdirSync(lock, { mode: 0o700 }) } catch {
      throw failure('The Bot account is already changing. Try again when it finishes.')
    }
    this.changes.set(vendor, home)
    try {
      writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
      writeFileSync(join(lock, 'owner'), this.instance, { mode: 0o600 })
      writeFileSync(join(lock, 'birth'), JSON.stringify(this.generations.birth), { mode: 0o600 })
      this.generations.otherApps(vendor, home)
      const instances = join(home, 'instances')
      for (const name of readdirSync(instances)) {
        if (name === this.instance) continue
        const snapshot = ownershipAt(join(instances, name), { legacy: 'home' })
        if (ownershipState(snapshot) !== 'dead' || !removeDeadOwnership(snapshot)) {
          throw failure('Close other Automagik sessions before changing the Bot account.')
        }
      }
      writeFileSync(join(home, 'paused'), '', { mode: 0o600 })
      writeFileSync(join(home, 'version'), randomUUID(), { mode: 0o600 })
    } catch (error) {
      this.end(vendor)
      throw error
    }
  }

  lockSnapshot(lock) {
    const stat = lstatSync(lock)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unverifiedLogin()
    const fields = {}
    for (const name of ['pid', 'owner', 'birth', 'recovering']) {
      try {
        const entry = lstatSync(join(lock, name))
        if (!entry.isFile() || entry.size > 4096) throw unverifiedLogin()
        fields[name] = { bytes: readFileSync(join(lock, name), 'utf8'), dev: entry.dev, ino: entry.ino }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { dev: stat.dev, ino: stat.ino, fields }
  }

  lockState(lock, snapshot = this.lockSnapshot(lock)) {
    const { fields } = snapshot
    const pid = Number(fields.pid?.bytes)
    const owner = fields.owner?.bytes
    if (!/^\d+-[a-f0-9-]+$/.test(owner ?? '') || Number(owner.split('-')[0]) !== pid) return 'unknown'
    let birth = null
    if (fields.birth) {
      try { birth = JSON.parse(fields.birth.bytes) } catch { return 'unknown' }
      if (birth !== null && !validBirth(birth)) return 'unknown'
    }
    const state = processState(pid, birth)
    if (state !== 'dead') return state
    if (fields.recovering) {
      const claim = fields.recovering.bytes
      if (!/^\d+-[a-f0-9-]+$/.test(claim)
        || processState(Number(claim.split('-')[0]), null) !== 'dead') return 'unknown'
    }
    return 'dead'
  }

  recoverChanging(home) {
    const lock = join(home, 'changing')
    if (!existsSync(lock)) return
    this.verify(home)
    const snapshot = this.lockSnapshot(lock)
    if (this.lockState(lock, snapshot) !== 'dead') throw unverifiedLogin()
    const exact = () => JSON.stringify(this.lockSnapshot(lock)) === JSON.stringify(snapshot)
    if (!exact() || this.lockState(lock, snapshot) !== 'dead') throw unverifiedLogin()
    // A crash may have preceded the original pause write. Persist it before clearing the
    // only remaining barrier, without changing either the selected home or its version.
    const fd = openSync(join(home, 'paused'), 'a', 0o600)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    // Linux/Unix directory fsync persists the new pause entry as well as its file bytes.
    if (process.platform !== 'win32') {
      const directory = openSync(home, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    this.verify(home)
    if (!exact() || this.lockState(lock, snapshot) !== 'dead' || !exact()) throw unverifiedLogin()
    rmSync(lock, { recursive: true, force: true })
  }

  startup(vendor) {
    this.generations.register(vendor)
    this.generations.exclusive(vendor, () => {
      const home = this.home(vendor)
      if (existsSync(home)) {
        this.verify(home)
        this.recoverChanging(home)
      }
      for (const [directory, legacy] of [[this.generations.instances(vendor), 'root'], [join(home, 'instances'), 'home']]) {
        if (!existsSync(directory)) continue
        for (const name of readdirSync(directory)) {
          if (name === this.instance) continue
          const snapshot = ownershipAt(join(directory, name), { legacy })
          if (legacy === 'home' && snapshot?.record.marker !== LOGIN_RECORD_VERSION) continue
          if (ownershipState(snapshot) === 'dead') removeDeadOwnership(snapshot)
        }
      }
    })
    this.collect(vendor)
  }

  end(vendor) {
    const home = this.changes.get(vendor)
    if (home === undefined) return
    this.changes.delete(vendor)
    rmSync(join(home, 'changing'), { recursive: true, force: true })
  }

  dispose() {
    for (const [vendor, home] of this.registered) {
      this.generations.release(join(home, 'instances', this.instance))
      this.generations.unregister(vendor)
    }
    this.registered.clear()
    this.generations.dispose()
  }
}

export function trackRun(run) {
  assertGeneration(run.spec.env ?? {})
  const home = run.spec.env?.[HOME_ENV]
  if (home === undefined) return
  if (existsSync(join(home, 'changing')) || existsSync(join(home, 'paused'))) {
    throw failure('The Bot account is changing. Sign in again when it finishes.')
  }
  const current = existsSync(join(home, 'version'))
    ? readFileSync(join(home, 'version'), 'utf8') : ''
  if (run.spec.env[VERSION_ENV] !== current) {
    throw failure('The Bot account changed. Start this work again after signing in.')
  }
  if (!runs.has(home)) runs.set(home, new Set())
  runs.get(home).add(run)
}

export function releaseRun(run) {
  const home = run.spec.env?.[HOME_ENV]
  if (!runs.get(home)?.has(run)) return Promise.resolve()
  if (run.accountStopping === undefined) {
    run.accountStopping = Promise.resolve().then(() => run.stop()).then(() => {
      runs.get(home)?.delete(run)
      if (runs.get(home)?.size === 0) runs.delete(home)
    })
    // The changer awaits this rejection. Background cleanup must not reject unobserved.
    run.accountStopping.catch(() => { run.accountStopping = undefined })
  }
  return run.accountStopping
}

export async function stopRuns(home) {
  await Promise.all([...(runs.get(home) ?? [])].map(releaseRun))
}
